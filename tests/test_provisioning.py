"""Provisioning wire format and capture lifecycle without radios or Supervisor."""
import ast
import asyncio
import importlib.util
import logging
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

APP = Path(__file__).parents[1] / "addon/app"


def load(name):
    spec = importlib.util.spec_from_file_location(name, APP / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


p = load("provisioning")
broker = load("mqtt_broker")


def reply(command, status):
    return b"DL" + bytes([command, 0, 0, 1, status, 0xff])


class ProvisioningTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for name, value in (("POLL_INTERVAL", 0.001), ("RECONNECT_DELAY", 0.001),
                            ("READ_TIMEOUT", 0.02), ("PLAF203_SETUP_TIMEOUT", 0.15)):
            timer = patch.object(p, name, value)
            timer.start()
            self.addCleanup(timer.stop)

    def scanner(self):
        return SimpleNamespace(find_device_by_address=AsyncMock(return_value=SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF")))

    async def test_bluez_prefers_le_before_connecting(self):
        path = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF'
        bus = Mock(connect=AsyncMock(), call=AsyncMock(return_value=SimpleNamespace(message_type='return')))
        factory = Mock(return_value=bus)
        modules = {
            'dbus_fast': SimpleNamespace(BusType=SimpleNamespace(SYSTEM='system'),
                                        Message=SimpleNamespace, MessageType=SimpleNamespace(ERROR='error'),
                                        Variant=lambda signature, value: (signature, value)),
            'dbus_fast.aio': SimpleNamespace(MessageBus=factory),
        }
        with patch.dict(sys.modules, modules):
            await p._prefer_le(SimpleNamespace(details={'path': path}))
        factory.assert_called_once_with(bus_type='system')
        message = bus.call.await_args.args[0]
        self.assertEqual(message.path, path)
        self.assertEqual(message.body, ['org.bluez.Device1', 'PreferredBearer', ('s', 'le')])
        bus.disconnect.assert_called_once()

    async def test_unsupported_bearer_preference_does_not_block_setup(self):
        bus = Mock(connect=AsyncMock(), call=AsyncMock(return_value=SimpleNamespace(message_type='error', error_name='org.freedesktop.DBus.Error.UnknownProperty')))
        modules = {
            'dbus_fast': SimpleNamespace(BusType=SimpleNamespace(SYSTEM='system'),
                                        Message=SimpleNamespace, MessageType=SimpleNamespace(ERROR='error'),
                                        Variant=lambda signature, value: (signature, value)),
            'dbus_fast.aio': SimpleNamespace(MessageBus=Mock(return_value=bus)),
        }
        with patch.dict(sys.modules, modules):
            await p._prefer_le(SimpleNamespace(details={'path': '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF'}))
        bus.disconnect.assert_called_once()

    def settings(self, **changes):
        return dict(address="AA:BB:CC:DD:EE:FF", ssid="test", password="password",
                    broker_ip="192.168.1.10", owner_id="", **changes)

    def test_packet_vectors_from_app_list_construction(self):
        self.assertEqual(p.packet(1, "test", "password"),
                         bytes.fromhex("444c0100000e04746573740870617373776f7264ff"))
        self.assertEqual(p.packet(2, "10.0.0.2:1883", "42"),
                         b"DL\x02\x00\x00\x11\x0d10.0.0.2:1883\x0242\xff")
        self.assertEqual(p.packet(1, "é", ""), b"DL\x01\x00\x00\x04\x02\xc3\xa9\x00\xff")

    def test_invalid_settings_and_byte_limits(self):
        for key, value in [("address", "fake"), ("ssid", "é" * 17),
                           ("password", "short"), ("broker_ip", "127.0.0.1"),
                           ("broker_ip", "localhost")]:
            values = self.settings()
            values[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                p.validate(values)
        for fields in [("x" * 256,), ("x" * 128, "y" * 128)]:
            with self.assertRaises(ValueError):
                p.packet(1, *fields)
        self.assertEqual(p.validate(self.settings())["owner_id"], "123456789")

    def test_account_id_is_always_fixed_regardless_of_request(self):
        for supplied in (None, "", "42", "abc", 123):
            values = self.settings()
            values["owner_id"] = supplied
            self.assertEqual(p.validate(values)["owner_id"], "123456789")

    async def test_scan_accepts_model_without_service_advertisement(self):
        def adv(name, uuids):
            return SimpleNamespace(local_name=name, service_uuids=uuids, rssi=-50)
        scanner = SimpleNamespace(discover=AsyncMock(return_value={
            "a": (SimpleNamespace(address="AA:BB:CC:DD:EE:FF", name="PLAF203"), adv("PLAF203", [])),
            "b": (SimpleNamespace(address="00:00:00:00:00:01", name="other"), adv("other", [])),
        }))
        with patch.object(p, "_bleak", return_value=(None, scanner)):
            found = await p.scan()
        self.assertEqual(list(found), ["AA:BB:CC:DD:EE:FF"])

    def client(self, wifi_status=0, bind_status=1):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.is_connected = True
        client.services = Mock()
        client.services.get_service.return_value.get_characteristic.return_value = object()

        async def subscribe(uuid, callback, *, bluez):
            self.assertEqual(bluez, {"use_start_notify": True})
            client.callback = callback
            callback(None, b"\x01")  # short noise must not count as an ACK

        async def write(uuid, data, response):
            command = data[2]
            client.callback(None, reply(command, wifi_status if command == 1 else bind_status))

        client.start_notify.side_effect = subscribe
        client.write_gatt_char.side_effect = write
        return client

    async def test_wifi_ack_precedes_mqtt_and_uses_response_writes(self):
        client = self.client()
        progress = Mock()
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())):
            await p.provision(object(), self.settings(), progress)
        writes = client.write_gatt_char.await_args_list
        self.assertEqual([call.args[1][2] for call in writes], [1, 2])
        self.assertTrue(all(call.kwargs["response"] for call in writes))
        self.assertEqual(writes[1].args[1], p.packet(2, "192.168.1.10:1883", "123456789"))
        self.assertEqual(progress.call_args.args[0], "waiting")
        client.__aexit__.assert_awaited_once()

    async def test_rejected_wifi_never_sends_broker(self):
        client = self.client(wifi_status=3)
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())):
            with self.assertRaisesRegex(p.ProvisioningError, "Wi-Fi connection"):
                await p.provision(object(), self.settings(), Mock())
        self.assertEqual(client.write_gatt_char.await_count, 1)
        client.__aexit__.assert_awaited_once()

    async def test_plaf203_polls_replies_without_subscribing(self):
        client = self.client()
        client.write_gatt_char.side_effect = None
        client.read_gatt_char.side_effect = [reply(1, 0), reply(2, 1)]
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())):
            await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), Mock())
        client.start_notify.assert_not_awaited()
        self.assertEqual(client.read_gatt_char.await_count, 2)
        self.assertEqual([call.args[1][2] for call in client.write_gatt_char.await_args_list], [1, 2])

    async def test_live_wifi_reply_advances_to_mqtt(self):
        client = self.client()
        client.write_gatt_char.side_effect = None
        # Actual FFE2 bytes from the HA D-Bus trace at 03:41:33 EDT.
        client.read_gatt_char.side_effect = [
            bytes.fromhex("444c0100000100ff"),
            bytes.fromhex("444c0200000101ff"),
        ]
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())):
            await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), Mock())
        self.assertEqual([call.args[1][2] for call in client.write_gatt_char.await_args_list], [1, 2])

    async def test_malformed_reply_frames_cannot_advance_setup(self):
        client = self.client()
        client.write_gatt_char.side_effect = None
        wifi = bytes.fromhex("444c0100000100ff")
        invalid = [
            b"\x00\x01\x00\x00",  # old, unframed mock
            wifi[:-1],
            b"XX" + wifi[2:],
            wifi[:5] + b"\x02" + wifi[6:],  # incorrect payload length
            wifi[:-1] + b"\x00",  # missing terminator
            b"DL\x03" + wifi[3:],  # unknown command
            b"DL\x01\x01" + wifi[4:],  # unsupported header
        ]
        reads = iter([*invalid, wifi, reply(2, 1)])
        async def read(*args):
            data = next(reads)
            if data in invalid:
                self.assertEqual(client.write_gatt_char.await_count, 1)
            return data
        client.read_gatt_char.side_effect = read
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())):
            await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), Mock())
        self.assertEqual(client.read_gatt_char.await_count, len(invalid) + 2)
        self.assertEqual([call.args[1][2] for call in client.write_gatt_char.await_args_list], [1, 2])

    async def test_live_wifi_255_continues_to_mqtt_binding_verification(self):
        client = self.client()
        client.write_gatt_char.side_effect = None
        client.read_gatt_char.side_effect = [bytes.fromhex("444c01000001ffff"), reply(2, 1)]
        progress = Mock()
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())), \
                patch.object(p._LOGGER, "warning") as warning:
            await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), progress)
        warning.assert_not_called()
        self.assertEqual([call.args[1][2] for call in client.write_gatt_char.await_args_list], [1, 2])
        self.assertNotIn("wifi_unconfirmed", [call.args[0] for call in progress.call_args_list])
        self.assertFalse(any("255" in call.args[1] for call in progress.call_args_list))
        self.assertIn("binding", progress.call_args.args[1])

    async def test_expected_255_for_both_commands_never_warns(self):
        client = self.client()
        client.write_gatt_char.side_effect = None
        client.read_gatt_char.side_effect = [reply(1, 255), reply(2, 255)]
        progress = Mock()
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())), \
                patch.object(p._LOGGER, "warning") as warning:
            await p.provision(SimpleNamespace(name="PLAF203"), self.settings(), progress)
        warning.assert_not_called()
        self.assertFalse(any("255" in call.args[1] for call in progress.call_args_list))
        self.assertEqual([call.args[1][2] for call in client.write_gatt_char.await_args_list], [1, 2])
        self.assertIn("binding", progress.call_args.args[1])

    async def test_plaf203_att_0e_only_continues_with_successful_device_replies(self):
        client = self.client()
        failure = RuntimeError("secret payload")
        failure.code = 0x0e
        client.write_gatt_char.side_effect = failure
        client.read_gatt_char.side_effect = [reply(1, 0), reply(2, 1)]
        progress = Mock()
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())):
            await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), progress)
        self.assertEqual(progress.call_args.args[0], "waiting")
        self.assertEqual(client.write_gatt_char.await_count, 2)
        client.start_notify.assert_not_awaited()
        client.__aexit__.assert_awaited_once()

    async def test_plaf203_att_0e_without_ack_is_failure_and_never_sends_mqtt(self):
        client = self.client()
        failure = RuntimeError("secret payload")
        failure.code = 0x0e
        client.write_gatt_char.side_effect = failure
        client.read_gatt_char.return_value = b""
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())), patch.object(p, "ACK_TIMEOUT", 0.01):
            with self.assertRaisesRegex(p.ProvisioningError, "timed out.*acknowledgements"):
                await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), Mock())
        self.assertEqual(client.write_gatt_char.await_count, 1)
        client.__aexit__.assert_awaited_once()

    async def test_plaf203_negative_replies_remain_unconfirmed_until_mqtt_binding(self):
        client = self.client()
        client.write_gatt_char.side_effect = None
        client.read_gatt_char.side_effect = [reply(1, 3), reply(2, 0)]
        progress = Mock()
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())):
            await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), progress)
        self.assertEqual(client.write_gatt_char.await_count, 2)
        stages = [call.args[0] for call in progress.call_args_list]
        self.assertIn("wifi_unconfirmed", stages)
        self.assertIn("mqtt_unconfirmed", stages)
        self.assertNotIn("success", stages)

    async def test_att_0e_is_not_tolerated_on_other_models(self):
        client = self.client()
        failure = RuntimeError("secret payload")
        failure.code = 0x0e
        client.write_gatt_char.side_effect = failure
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())):
            with self.assertRaisesRegex(p.ProvisioningError, "Wi-Fi settings write.*ATT 0x0e"):
                await p.provision(SimpleNamespace(name="PLWF105"), self.settings(), Mock())
        client.read_gatt_char.assert_not_awaited()

    async def test_mqtt_status_one_succeeds_and_zero_is_rejection(self):
        client = self.client(bind_status=0)
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())):
            with self.assertRaisesRegex(p.ProvisioningError, "MQTT configuration.*code 0"):
                await p.provision(object(), self.settings(), Mock())
        self.assertEqual(client.write_gatt_char.await_count, 2)

    async def test_plaf203_transient_read_error_recovers_without_rewriting(self):
        client = self.client()
        client.write_gatt_char.side_effect = None
        client.read_gatt_char.side_effect = [RuntimeError("secret"), b"", reply(1, 0), reply(2, 1)]
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())):
            await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), Mock())
        self.assertEqual(client.read_gatt_char.await_count, 4)
        self.assertEqual(client.write_gatt_char.await_count, 2)

    async def test_plaf203_disconnect_reconnects_and_replays_wifi_before_mqtt(self):
        first, second = self.client(), self.client()
        first.write_gatt_char.side_effect = second.write_gatt_char.side_effect = None
        first.is_connected = False
        first.read_gatt_char.side_effect = RuntimeError("secret disconnected")
        second.read_gatt_char.side_effect = [reply(1, 0), reply(2, 1)]
        factory = Mock(side_effect=[first, second])
        progress = Mock()
        with patch.object(p, "_bleak", return_value=(factory, self.scanner())):
            await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), progress)
        self.assertEqual(first.write_gatt_char.await_count, 1)
        self.assertEqual([c.args[1][2] for c in second.write_gatt_char.await_args_list], [1, 2])
        first.__aexit__.assert_awaited_once()
        second.__aexit__.assert_awaited_once()
        self.assertIn("reconnecting", [c.args[0] for c in progress.call_args_list])
        self.assertEqual(progress.call_args.args[0], "waiting")

    async def test_plaf203_reconnect_after_mqtt_write_starts_from_wifi(self):
        first, second = self.client(), self.client()
        first.write_gatt_char.side_effect = second.write_gatt_char.side_effect = None
        first.is_connected = False
        first.read_gatt_char.side_effect = [reply(1, 0), RuntimeError("disconnected")]
        second.read_gatt_char.side_effect = [reply(1, 0), reply(2, 1)]
        with patch.object(p, "_bleak", return_value=(Mock(side_effect=[first, second]), self.scanner())):
            await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), Mock())
        for client in (first, second):
            self.assertEqual([c.args[1][2] for c in client.write_gatt_char.await_args_list], [1, 2])

    async def test_plaf203_connection_failures_share_one_deadline(self):
        client = self.client()
        client.__aenter__.side_effect = RuntimeError("secret")
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())), patch.object(p, "PLAF203_SETUP_TIMEOUT", 0.02):
            with self.assertRaisesRegex(p.ProvisioningError, "timed out.*Bluetooth recovery") as error:
                await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), Mock())
        self.assertNotIn("secret", str(error.exception))
        self.assertGreater(client.__aenter__.await_count, 1)
        client.write_gatt_char.assert_not_awaited()

    async def test_reconnect_uses_rediscovered_device_not_stale_bluez_entry(self):
        first, second = self.client(), self.client()
        first.__aenter__.side_effect = RuntimeError("device not found")
        second.write_gatt_char.side_effect = None
        second.read_gatt_char.side_effect = [reply(1, 0), reply(2, 1)]
        scanner = self.scanner()
        fresh = scanner.find_device_by_address.return_value
        original = SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF")
        factory = Mock(side_effect=[first, second])
        with patch.object(p, "_bleak", return_value=(factory, scanner)):
            await p.provision(original, self.settings(), Mock())
        scanner.find_device_by_address.assert_awaited_once_with(original.address, timeout=8)
        self.assertIs(factory.call_args_list[0].args[0], original)
        self.assertIs(factory.call_args_list[1].args[0], fresh)

    async def test_missing_advertisement_never_reuses_stale_device(self):
        client = self.client()
        client.__aenter__.side_effect = RuntimeError("device removed")
        scanner = self.scanner()
        scanner.find_device_by_address.return_value = None
        factory = Mock(return_value=client)
        with patch.object(p, "_bleak", return_value=(factory, scanner)), patch.object(p, "PLAF203_SETUP_TIMEOUT", 0.02):
            with self.assertRaisesRegex(p.ProvisioningError, "no longer advertising"):
                await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), Mock())
        factory.assert_called_once()
        client.write_gatt_char.assert_not_awaited()

    async def test_plaf203_stalled_read_is_bounded_then_polling_recovers(self):
        client = self.client()
        client.write_gatt_char.side_effect = None
        calls = 0
        async def read(*args):
            nonlocal calls
            calls += 1
            if calls == 1:
                await asyncio.Event().wait()
            return reply(1 if calls == 2 else 2, 0 if calls == 2 else 1)
        client.read_gatt_char.side_effect = read
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())):
            await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), Mock())
        self.assertEqual(calls, 3)
        self.assertEqual(client.write_gatt_char.await_count, 2)

    async def test_plaf203_recovered_connection_can_verify_negative_ble_reply_via_mqtt(self):
        first, second = self.client(), self.client()
        first.__aenter__.side_effect = RuntimeError("disconnected")
        second.write_gatt_char.side_effect = None
        second.read_gatt_char.side_effect = [reply(1, 3), reply(2, 1)]
        factory = Mock(side_effect=[first, second])
        with patch.object(p, "_bleak", return_value=(factory, self.scanner())):
            await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), Mock())
        self.assertEqual(factory.call_count, 2)
        self.assertEqual(second.write_gatt_char.await_count, 2)
        second.__aexit__.assert_awaited_once()

    async def test_cancel_during_plaf203_recovery_exits_without_retry(self):
        client = self.client()
        client.write_gatt_char.side_effect = None
        entered = asyncio.Event()
        async def read(*args):
            entered.set()
            await asyncio.Event().wait()
        client.read_gatt_char.side_effect = read
        factory = Mock(return_value=client)
        with patch.object(p, "_bleak", return_value=(factory, self.scanner())):
            task = asyncio.create_task(p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), Mock()))
            await entered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        factory.assert_called_once()
        client.__aexit__.assert_awaited_once()

    async def test_plaf203_read_failure_reports_missing_ack_without_secrets(self):
        client = self.client()
        failure = RuntimeError("secret payload")
        failure.code = 0x0e
        client.write_gatt_char.side_effect = failure
        client.read_gatt_char.side_effect = RuntimeError("secret read details")
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())), self.assertLogs(p._LOGGER, "WARNING") as logs:
            with self.assertRaisesRegex(p.ProvisioningError, "timed out.*acknowledgements") as error:
                await p.provision(SimpleNamespace(name="PLAF203", address="AA:BB:CC:DD:EE:FF"), self.settings(), Mock())
        self.assertNotIn("secret", str(error.exception))
        self.assertNotIn("secret", " ".join(logs.output))
        self.assertIn("reply read failed", " ".join(logs.output))
        self.assertEqual(client.write_gatt_char.await_count, 1)

    async def test_connection_failure_reports_safe_dbus_reason_and_rescan_action(self):
        client = self.client()
        failure = RuntimeError("secret transport details")
        failure.dbus_error = "org.bluez.Error.Failed"
        client.__aenter__.side_effect = failure
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())), self.assertLogs(p._LOGGER, "WARNING") as logs:
            with self.assertRaisesRegex(p.ProvisioningError, "discover.*org.bluez.Error.Failed.*Scan again") as error:
                await p.provision(SimpleNamespace(name="PLWF105"), self.settings(), Mock())
        self.assertNotIn("secret", str(error.exception))
        self.assertNotIn("secret", " ".join(logs.output))
        client.write_gatt_char.assert_not_awaited()

    async def test_stalled_notifications_time_out_before_sending_secrets(self):
        client = self.client()
        async def stalled(*args, **kwargs):
            await asyncio.Event().wait()
        client.start_notify.side_effect = stalled
        progress = Mock()
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())), patch.object(p, "NOTIFY_TIMEOUT", 0.01):
            with self.assertRaisesRegex(p.ProvisioningError, "notifications timed out"):
                await p.provision(object(), self.settings(), progress)
        self.assertEqual(progress.call_args.args[0], "subscribing")
        client.write_gatt_char.assert_not_awaited()
        client.__aexit__.assert_awaited_once()

    async def test_transport_exception_does_not_expose_password(self):
        client = self.client()
        client.write_gatt_char.side_effect = RuntimeError("secret Wi-Fi payload")
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())):
            with self.assertRaises(p.ProvisioningError) as error:
                await p.provision(object(), self.settings(), Mock())
        self.assertNotIn("secret", str(error.exception))

    async def test_notification_failure_reports_safe_dbus_code_without_payload(self):
        client = self.client()
        failure = RuntimeError("secret Wi-Fi payload")
        failure.dbus_error = "org.bluez.Error.NotPermitted"
        client.start_notify.side_effect = failure
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())), self.assertLogs(p._LOGGER, "WARNING") as logs:
            with self.assertRaisesRegex(p.ProvisioningError, "notifications failed.*NotPermitted") as error:
                await p.provision(object(), self.settings(), Mock())
        self.assertNotIn("secret", str(error.exception))
        self.assertNotIn("secret", " ".join(logs.output))
        client.write_gatt_char.assert_not_awaited()
        client.__aexit__.assert_awaited_once()

    async def test_gatt_write_rejection_reports_operation_and_att_without_secrets(self):
        client = self.client()
        failure = RuntimeError("secret Wi-Fi payload")
        failure.code = 3
        client.write_gatt_char.side_effect = failure
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())), self.assertLogs(p._LOGGER, "WARNING") as logs:
            with self.assertRaisesRegex(p.ProvisioningError, r"Wi-Fi settings write \(ATT 0x03\)") as error:
                await p.provision(object(), self.settings(), Mock())
        self.assertNotIn("secret", str(error.exception))
        self.assertNotIn("secret", " ".join(logs.output))
        self.assertIn("ATT=0x03", " ".join(logs.output))
        self.assertEqual(client.write_gatt_char.await_count, 1)
        client.__aexit__.assert_awaited_once()

    async def test_notification_failure_does_not_expose_nonstandard_error_code(self):
        client = self.client()
        failure = RuntimeError("secret Wi-Fi payload")
        failure.dbus_error = "secret"
        client.start_notify.side_effect = failure
        with patch.object(p, "_bleak", return_value=(Mock(return_value=client), self.scanner())), self.assertLogs(p._LOGGER, "WARNING") as logs:
            with self.assertRaises(p.ProvisioningError) as error:
                await p.provision(object(), self.settings(), Mock())
        self.assertNotIn("secret", str(error.exception))
        self.assertNotIn("secret", " ".join(logs.output))


class CaptureLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_fragmented_connect_waits_for_full_password(self):
        future = asyncio.get_running_loop().create_future()
        protocol = broker._CaptureProtocol(future)
        transport = Mock()
        protocol.connection_made(transport)
        def field(value):
            return len(value).to_bytes(2, "big") + value
        payload = field(b"MQTT") + b"\x04\xc2\x00\x3c" + field(b"AF_TEST") + field(b"user") + field(b"secret")
        wire = bytes([0x10, len(payload)]) + payload
        for byte in wire[:-1]:
            protocol.data_received(bytes([byte]))
            self.assertFalse(future.done())
        protocol.data_received(wire[-1:])
        self.assertEqual(future.result()["password"], "secret")

    def namespace(self):
        source = ast.parse((APP / "main.py").read_text(encoding="utf-8"))
        names = {"_start_capture", "handle_api_capture_status", "handle_api_capture_reset", "handle_api_capture_cancel"}
        nodes = [node for node in source.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
        ns = dict(asyncio=asyncio, provisioning=p, _capture_state={"status": "idle"},
                  _capture_task=None, _provision_scanning=False,
                  _LOGGER=logging.getLogger(__name__),
                  web=SimpleNamespace(json_response=lambda data, status=200: SimpleNamespace(data=data, status=status)),
                  devices=SimpleNamespace(suppress_alerts=Mock()),
                  storage=SimpleNamespace(get_devices=lambda: {}),
                  mosquitto=SimpleNamespace(stop_mosquitto=AsyncMock(return_value=True),
                                           start_mosquitto=AsyncMock(return_value=True),
                                           add_mosquitto_login=AsyncMock(return_value="added")),
                  mqtt_broker=SimpleNamespace(capture_credentials=AsyncMock(return_value={})))
        ns["devices"].expect_binding = Mock()
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "main.py", "exec"), ns)
        return ns

    async def test_capture_callback_runs_only_after_listener_binds(self):
        # Use a real loopback TCP listener and ephemeral port, no radios.
        async def ready():
            reader, writer = await asyncio.open_connection("127.0.0.1", broker.CAPTURE_PORT)
            def field(value):
                return len(value).to_bytes(2, "big") + value
            payload = field(b"MQTT") + b"\x04\xc2\x00\x3c" + field(b"AF_TEST") + field(b"user") + field(b"pass")
            writer.write(bytes([0x10, len(payload)]) + payload)
            try:
                await writer.drain()
                await reader.read()
            finally:
                writer.close()
                await writer.wait_closed()
        # Reserve then release an ephemeral port for this bounded test.
        server = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        server.close()
        await server.wait_closed()
        with patch.object(broker, "CAPTURE_PORT", port):
            result = await broker.capture_credentials(timeout_seconds=3, on_ready=ready)
        self.assertEqual(result, dict(client_id="AF_TEST", username="user", password="pass"))
        # The capture listener must have released the port.
        server = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", port)
        server.close()
        await server.wait_closed()

    async def test_mqtt_capture_finishes_while_ble_ack_is_pending(self):
        await self._capture_with_pending_ble_ack()

    async def test_early_mqtt_capture_waits_until_configuration_is_sent(self):
        await self._capture_with_pending_ble_ack(gated=True)

    async def _capture_with_pending_ble_ack(self, gated=False):
        cleaned_up = asyncio.Event()
        capture_ready = asyncio.Event() if gated else None
        mqtt_connected = asyncio.Event()
        release_configuration = asyncio.Event()
        async def ready():
            try:
                reader, writer = await asyncio.open_connection('127.0.0.1', broker.CAPTURE_PORT)
                def field(value):
                    return len(value).to_bytes(2, 'big') + value
                payload = field(b'MQTT') + b'\x04\xc2\x00\x3c' + field(b'AF_TEST') + field(b'user') + field(b'pass')
                writer.write(bytes([0x10, len(payload)]) + payload)
                await writer.drain()
                try:
                    await reader.read()
                    mqtt_connected.set()
                    if capture_ready is not None:
                        await release_configuration.wait()
                        capture_ready.set()
                    await asyncio.Event().wait()  # BLE MQTT ACK never arrives
                finally:
                    writer.close()
                    await writer.wait_closed()
            finally:
                cleaned_up.set()
        server = await asyncio.start_server(lambda r, w: w.close(), '127.0.0.1', 0)
        port = server.sockets[0].getsockname()[1]
        server.close()
        await server.wait_closed()
        with patch.object(broker, 'CAPTURE_PORT', port):
            task = asyncio.create_task(broker.capture_credentials(timeout_seconds=3, on_ready=ready, capture_ready=capture_ready))
            if gated:
                await asyncio.wait_for(mqtt_connected.wait(), 1)
                await asyncio.sleep(0)
                self.assertFalse(task.done())
                self.assertFalse(cleaned_up.is_set())
                release_configuration.set()
            result = await asyncio.wait_for(task, 1)
        self.assertEqual(result, dict(client_id='AF_TEST', username='user', password='pass'))
        self.assertTrue(cleaned_up.is_set())
        server = await asyncio.start_server(lambda r, w: w.close(), '127.0.0.1', port)
        server.close()
        await server.wait_closed()

    async def test_cancellation_during_stop_still_restarts_broker(self):
        ns = self.namespace()
        stopped = asyncio.Event()
        async def stop():
            stopped.set()
            await asyncio.Event().wait()
        ns["mosquitto"].stop_mosquitto.side_effect = stop
        ns["_start_capture"]()
        await stopped.wait()
        response = await ns["handle_api_capture_reset"](None)
        self.assertEqual(response.status, 409)
        await ns["handle_api_capture_cancel"](None)
        ns["mosquitto"].start_mosquitto.assert_awaited_once()
        self.assertEqual(ns["devices"].suppress_alerts.call_args.args, (False,))

    async def test_failure_restores_broker_and_preserves_safe_error(self):
        ns = self.namespace()
        async def fail(**kwargs):
            raise p.ProvisioningError("Wi-Fi rejected")
        ns["mqtt_broker"].capture_credentials.side_effect = fail
        real_sleep = asyncio.sleep
        # Skip only the fixed Mosquitto preparation delay.
        async def no_delay(_):
            await real_sleep(0)
        with patch.object(asyncio, "sleep", no_delay):
            ns["_start_capture"](AsyncMock())
            await ns["_capture_task"]
        self.assertEqual(ns["_capture_state"]["detail"], "Wi-Fi rejected")
        ns["mosquitto"].start_mosquitto.assert_awaited_once()

    async def test_success_saves_credentials_and_hides_result_until_restored(self):
        ns = self.namespace()
        restarting = asyncio.Event()
        release = asyncio.Event()
        async def restart():
            restarting.set()
            await release.wait()
            return True
        ns["mosquitto"].start_mosquitto.side_effect = restart
        ns["mqtt_broker"].capture_credentials.return_value = dict(client_id="AF_NEW", username="u", password="p")
        real_sleep = asyncio.sleep
        async def no_delay(_):
            await real_sleep(0)
        with patch.object(asyncio, "sleep", no_delay):
            ns["_start_capture"](AsyncMock())
            await restarting.wait()
            state = await ns["handle_api_capture_status"](None)
            self.assertEqual(state.data["status"], "capturing")
            self.assertEqual(state.data["result"], {})
            response = ns["_start_capture"](AsyncMock())
            self.assertEqual(response.status, 409)
            cancel = asyncio.create_task(ns["handle_api_capture_cancel"](None))
            await real_sleep(0)
            self.assertFalse(cancel.done())
            self.assertFalse(ns["_capture_task"].cancelling())
            release.set()
            await ns["_capture_task"]
            await cancel
        ns["mosquitto"].add_mosquitto_login.assert_awaited_once_with("u", "p")
        self.assertEqual(ns["_capture_state"]["status"], "captured")

    async def test_failure_is_visible_during_restoration_and_survives_restart_failure(self):
        ns = self.namespace()
        restarting = asyncio.Event()
        release = asyncio.Event()
        async def restart():
            restarting.set()
            await release.wait()
            return False
        async def fail(**kwargs):
            raise p.ProvisioningError("Device rejected Wi-Fi settings write (ATT 0x0e).")
        ns["mosquitto"].start_mosquitto.side_effect = restart
        ns["mqtt_broker"].capture_credentials.side_effect = fail
        real_sleep = asyncio.sleep
        async def no_delay(_):
            await real_sleep(0)
        with patch.object(asyncio, "sleep", no_delay):
            ns["_start_capture"](AsyncMock())
            await restarting.wait()
            response = await ns["handle_api_capture_status"](None)
            self.assertEqual(response.data["status"], "capturing")
            self.assertEqual(response.data["result"], {})
            self.assertEqual(response.data["detail"], "Restoring Mosquitto…")
            self.assertIn("ATT 0x0e", response.data["error"])
            release.set()
            await ns["_capture_task"]
        self.assertIn("ATT 0x0e", ns["_capture_state"]["detail"])
        self.assertIn("Mosquitto could not restart", ns["_capture_state"]["detail"])


if __name__ == "__main__":
    unittest.main()
