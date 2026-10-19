"""Exercise onboarding over an actual MQTT TCP stream before broker handoff."""
import asyncio
import importlib.util
import json
from pathlib import Path
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

spec = importlib.util.spec_from_file_location(
    "capture_binding_broker", Path(__file__).parents[1] / "addon/app/mqtt_broker.py")
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
provision_spec = importlib.util.spec_from_file_location(
    "capture_binding_provisioning", Path(__file__).parents[1] / "addon/app/provisioning.py")
provisioning = importlib.util.module_from_spec(provision_spec)
provision_spec.loader.exec_module(provisioning)
SERIAL = "AF030103030202814F5B"
BASE = f"dl/PLAF203/{SERIAL}/device/system/"


def connect(serial=SERIAL):
    payload = broker._field("MQTT") + b"\x04\xc2\x00\x5a"
    payload += broker._field(serial) + broker._field("user") + broker._field("secret")
    return broker._packet(0x10, payload)


def subscribe(topic=BASE + "sub", qos=1):
    return broker._packet(0x82, b"\x00\x02" + broker._field(topic) + bytes([qos]))


def binding(topic=BASE + "post", msg_id="setup", qos=0):
    payload = broker._field(topic) + (b"\x00\x07" if qos else b"")
    payload += json.dumps({"cmd": "BINDING", "msgId": msg_id}).encode()
    return broker._packet(0x30 | qos << 1, payload)


async def read_packet(reader):
    header = (await reader.readexactly(1))[0]
    length, multiplier = 0, 1
    while True:
        byte = (await reader.readexactly(1))[0]
        length += (byte & 127) * multiplier
        multiplier *= 128
        if not byte & 128:
            return header, await reader.readexactly(length)


class CaptureBindingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        reserve = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 0)
        self.port = reserve.sockets[0].getsockname()[1]
        reserve.close()
        await reserve.wait_closed()
        self.patch = patch.object(broker, "CAPTURE_PORT", self.port)
        self.patch.start()
        self.tasks = []
        self.writers = []

    async def asyncTearDown(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        for writer in self.writers:
            writer.close()
            await writer.wait_closed()
        self.patch.stop()
        # No session or listener may survive cancellation/timeout/completion.
        server = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", self.port)
        server.close()
        await server.wait_closed()

    async def start_capture(self, timeout=2, known=(), gated=False, configure=None):
        ready = asyncio.Event()
        gate = asyncio.Event() if gated else None
        async def provision():
            ready.set()
            if configure is not None:
                return await configure(gate)
            await asyncio.Event().wait()  # BLE MQTT reply never arrives
        progress = Mock()
        task = asyncio.create_task(broker.capture_credentials(
            timeout_seconds=timeout, known_serials=known, on_ready=provision,
            capture_ready=gate, on_binding=progress))
        self.tasks.append(task)
        await ready.wait()
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        self.writers.append(writer)
        return task, reader, writer, gate, progress

    async def check_reply(self, reader, expected="setup"):
        header, payload = await asyncio.wait_for(read_packet(reader), 1)
        self.assertEqual(header, 0x32)  # QoS 1, not retained
        topic, offset = broker._decode_utf8(payload, 0)
        self.assertEqual(topic, BASE + "sub")
        packet_id = payload[offset:offset + 2]
        reply = json.loads(payload[offset + 2:])
        self.assertEqual({k: reply[k] for k in ("cmd", "msgId", "code", "bindId")},
                         dict(cmd="BINDING", msgId=expected, code=0, bindId=15))
        self.assertIsInstance(reply["ts"], int)
        return packet_id

    async def test_fragmented_and_coalesced_packets_complete_only_after_puback(self):
        task, reader, writer, gate, progress = await self.start_capture()
        wire = connect() + subscribe() + binding(qos=1)
        for byte in wire:
            writer.write(bytes([byte]))
            await writer.drain()
            await asyncio.sleep(0)
        self.assertEqual(await read_packet(reader), (0x20, b"\x00\x00"))
        self.assertEqual(await read_packet(reader), (0x90, b"\x00\x02\x01"))
        self.assertEqual(await read_packet(reader), (0x40, b"\x00\x07"))
        packet_id = await self.check_reply(reader)
        self.assertFalse(task.done())
        writer.write(broker._packet(0x40, b"\x7f\x7f") + b"\xc0\x00")
        self.assertEqual(await read_packet(reader), (0xd0, b""))
        self.assertFalse(task.done())
        writer.write(broker._packet(0x40, packet_id))
        await writer.drain()
        await asyncio.sleep(0.01)
        result = await asyncio.wait_for(task, 1)
        self.assertEqual(result, dict(client_id=SERIAL, username="user", password="secret", binding_confirmed=True))
        progress.assert_called_once_with()
        self.assertEqual(await reader.read(), b"")

    async def test_binding_before_subscription_is_delivered_after_suback(self):
        task, reader, writer, _, _ = await self.start_capture()
        writer.write(connect() + binding() + subscribe("dl/PLAF203/+/device/system/#"))
        self.assertEqual((await read_packet(reader))[0], 0x20)
        self.assertEqual((await read_packet(reader))[0], 0x90)
        packet_id = await self.check_reply(reader)
        writer.write(broker._packet(0x40, packet_id))
        self.assertTrue((await asyncio.wait_for(task, 1))["binding_confirmed"])

    async def test_missing_binding_times_out_instead_of_reporting_connect_success(self):
        task, reader, writer, _, _ = await self.start_capture(timeout=0.08)
        writer.write(connect() + subscribe())
        await read_packet(reader)
        await read_packet(reader)
        self.assertEqual(await asyncio.wait_for(task, 1), {})
        self.assertEqual(await reader.read(), b"")

    async def test_wrong_serial_and_wrong_topic_cannot_complete_binding(self):
        task, reader, writer, _, _ = await self.start_capture(timeout=0.08)
        writer.write(connect() + subscribe() + binding(BASE.replace(SERIAL, "AF_OTHER") + "post")
                     + binding(BASE.replace("system/", "event/") + "post"))
        await read_packet(reader)
        await read_packet(reader)
        self.assertEqual(await asyncio.wait_for(task, 1), {})
        self.assertEqual(await reader.read(), b"")

    async def test_disconnect_and_reconnect_can_finish_binding(self):
        task, reader, writer, _, _ = await self.start_capture()
        writer.write(connect())
        await read_packet(reader)
        writer.close()
        await writer.wait_closed()
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        self.writers.append(writer)
        writer.write(connect() + subscribe() + binding())
        await read_packet(reader)
        await read_packet(reader)
        packet_id = await self.check_reply(reader)
        writer.write(broker._packet(0x40, packet_id))
        self.assertTrue((await asyncio.wait_for(task, 1))["binding_confirmed"])

    async def test_cancel_closes_live_camera_session(self):
        task, reader, writer, _, _ = await self.start_capture()
        writer.write(connect())
        await read_packet(reader)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(await reader.read(), b"")

    async def test_known_feeder_cannot_win_capture(self):
        task, reader, writer, _, progress = await self.start_capture(timeout=0.08, known=[SERIAL])
        writer.write(connect() + subscribe() + binding())
        await read_packet(reader)
        self.assertEqual(await reader.read(), b"")
        self.assertEqual(await task, {})
        progress.assert_not_called()

    async def test_auto_capture_of_already_bound_camera_still_uses_connect(self):
        result = asyncio.get_running_loop().create_future()
        protocol = broker._CaptureProtocol(result)
        transport = Mock()
        protocol.connection_made(transport)
        protocol.data_received(connect())
        self.assertEqual(result.result()["client_id"], SERIAL)
        self.assertNotIn("binding_confirmed", result.result())
        transport.close.assert_called_once()

    async def test_retried_request_requires_ack_for_latest_reply(self):
        task, reader, writer, _, _ = await self.start_capture()
        writer.write(connect() + subscribe() + binding())
        await read_packet(reader)
        await read_packet(reader)
        first = await self.check_reply(reader)
        writer.write(binding(msg_id="retry"))
        second = await self.check_reply(reader, "retry")
        self.assertNotEqual(first, second)
        writer.write(broker._packet(0x40, first) + b"\xc0\x00")
        await read_packet(reader)
        self.assertFalse(task.done())
        writer.write(broker._packet(0x40, second))
        self.assertTrue((await asyncio.wait_for(task, 1))["binding_confirmed"])

    async def test_old_binding_before_configuration_cannot_complete_new_setup(self):
        task, reader, writer, gate, _ = await self.start_capture(gated=True)
        writer.write(connect() + subscribe() + binding(msg_id="old") + b"\xc0\x00")
        await read_packet(reader)
        self.assertEqual(await reader.read(), b"")
        self.assertFalse(task.done())
        gate.set()
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        self.writers.append(writer)
        writer.write(connect() + subscribe() + binding(msg_id="new"))
        await read_packet(reader)
        await read_packet(reader)
        packet_id = await self.check_reply(reader, "new")
        self.assertFalse(task.done())
        writer.write(broker._packet(0x40, packet_id))
        self.assertTrue((await asyncio.wait_for(task, 1))["binding_confirmed"])

    async def test_slow_bluetooth_cancellation_cannot_block_broker_restoration(self):
        ready, release, cancelling = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def provision():
            ready.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelling.set()
                await release.wait()  # simulate a stuck BlueZ disconnect
        with patch.object(broker, "CAPTURE_CLEANUP_TIMEOUT", 0.02):
            task = asyncio.create_task(broker.capture_credentials(timeout_seconds=0.05, on_ready=provision))
            self.tasks.append(task)
            await ready.wait()
            reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
            self.writers.append(writer)
            writer.write(connect())
            await read_packet(reader)
            await asyncio.wait_for(cancelling.wait(), 1)
            self.assertEqual(await asyncio.wait_for(task, 1), {})
            self.assertEqual(await reader.read(), b"")
            # Restoration can bind while Bluetooth is still tearing down.
            restored = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", self.port)
            restored.close()
            await restored.wait_closed()
            release.set()

    async def test_qos_zero_subscription_waits_for_successful_device_start(self):
        task, reader, writer, _, _ = await self.start_capture()
        writer.write(connect() + subscribe(qos=0) + binding())
        await read_packet(reader)
        self.assertEqual(await read_packet(reader), (0x90, b"\x00\x02\x00"))
        header, payload = await read_packet(reader)
        self.assertEqual(header, 0x30)
        topic, offset = broker._decode_utf8(payload, 0)
        self.assertEqual(topic, BASE + "sub")
        self.assertEqual(json.loads(payload[offset:])["bindId"], 15)
        self.assertFalse(task.done())
        def started(success):
            return broker._packet(0x30, broker._field(BASE.replace("system/", "event/") + "post")
                                  + json.dumps(dict(cmd="DEVICE_START_EVENT", success=success)).encode())
        writer.write(started(False) + b"\xc0\x00")
        self.assertEqual(await read_packet(reader), (0xd0, b""))
        self.assertFalse(task.done())
        writer.write(started(True))
        self.assertTrue((await asyncio.wait_for(task, 1))["binding_confirmed"])

    async def _negative_ble_replies_with_mqtt(self, confirm_binding):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.is_connected = True
        client.services = Mock()
        client.services.get_service.return_value.get_characteristic.return_value = object()
        client.read_gatt_char.side_effect = [bytes.fromhex("444c01000001ffff"),
                                             bytes.fromhex("444c0200000100ff")]
        dispatched = asyncio.Event()
        async def configure(gate):
            def progress(stage, detail):
                if stage == "mqtt_sent":
                    gate.set()
                    dispatched.set()
            await provisioning.provision(SimpleNamespace(name="PLAF203"),
                                         dict(ssid="test", password="password", broker_ip="192.168.1.10"),
                                         progress)
        with patch.object(provisioning, "_bleak", return_value=(Mock(return_value=client), None)), \
                patch.object(provisioning, "POLL_INTERVAL", 0.001):
            task, reader, writer, _, _ = await self.start_capture(
                timeout=0.2, gated=True, configure=configure)
            await asyncio.wait_for(dispatched.wait(), 1)
            writer.write(connect() + subscribe())
            await read_packet(reader)
            await read_packet(reader)
            self.assertFalse(task.done())
            if confirm_binding:
                writer.write(binding())
                packet_id = await self.check_reply(reader)
                self.assertFalse(task.done())
                writer.write(broker._packet(0x40, packet_id))
                self.assertTrue((await asyncio.wait_for(task, 1))["binding_confirmed"])
            else:
                self.assertEqual(await asyncio.wait_for(task, 1), {})
            self.assertEqual([call.args[1][2] for call in client.write_gatt_char.await_args_list], [1, 2])
            client.start_notify.assert_not_awaited()

    async def test_negative_ble_replies_can_succeed_with_real_mqtt_binding(self):
        await self._negative_ble_replies_with_mqtt(True)

    async def test_negative_ble_replies_without_mqtt_binding_still_time_out(self):
        await self._negative_ble_replies_with_mqtt(False)


if __name__ == "__main__":
    unittest.main()
