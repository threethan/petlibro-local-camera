"""Recording commands must be validated, device-scoped, and acknowledged."""

import asyncio
import importlib.util
import json
import logging
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, Mock, patch

spec = importlib.util.spec_from_file_location(
    "recording_test_devices", Path(__file__).parents[1] / "addon/app/devices.py",
)
devices = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {
    "aiomqtt": Mock(), "ha_mqtt": Mock(), "device_types": Mock(),
}), patch("logging.handlers.RotatingFileHandler", return_value=logging.NullHandler()):
    spec.loader.exec_module(devices)


class RecordingSettingsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        devices._devices = {"feeder": ("PLAF203", "camera_feeder")}
        devices._online = {"feeder": True}
        devices._state.clear()
        devices._pending_recording_acks.clear()
        devices._client_ref = None
        for name in ("_persist_state_cache", "_publish_ha_state", "_check_and_fire_alerts"):
            item = patch.object(devices, name, AsyncMock())
            item.start()
            self.addCleanup(item.stop)
        item = patch.object(devices, "RECORDING_ACK_TIMEOUT_SECS", 0.02)
        item.start()
        self.addCleanup(item.stop)
        item = patch.object(devices, "_local_hhmm_to_utc", side_effect=lambda value: value)
        item.start()
        self.addCleanup(item.stop)

    def reply(self, serial, payload, code=0, **extra):
        devices._handle_message(serial, f"dl/PLAF203/{serial}/device/service/post",
                                json.dumps({"cmd": "ATTR_SET_SERVICE", "msgId": payload["msgId"],
                                            "code": code, **extra}))

    async def test_continuous_recording_waits_for_ack_and_saves(self):
        async def publish(serial, payload):
            self.assertNotIn("videoRecordSwitch", devices._state.get(serial, {}))
            self.reply(serial, payload)
            return True
        with patch.object(devices, "send_command", side_effect=publish) as send:
            await devices.handle_ha_command("feeder", {"videoRecordSwitch": True, "videoRecordMode": "CONTINUOUS"})
        self.assertEqual(send.call_args.args[1]["videoRecordMode"], "CONTINUOUS")
        self.assertTrue(devices._state["feeder"]["videoRecordSwitch"])
        self.assertFalse(devices._pending_recording_acks)

    async def test_recording_switch_repairs_invalid_schedule_before_ack(self):
        devices._state["feeder"] = {"videoRecordAgingType": 0}

        async def publish(serial, payload):
            self.assertEqual(payload["videoRecordAgingType"], 1)
            self.reply(serial, payload)
            return True

        with patch.object(devices, "send_command", side_effect=publish):
            await devices.handle_ha_command("feeder", {"videoRecordSwitch": True})
        self.assertEqual(devices._state["feeder"]["videoRecordAgingType"], 1)

    async def test_invalid_parameters_never_publish(self):
        invalid = [{"sdCardState": 1}, {"enableVideoRecord": True},
                   {"videoRecordSwitch": "true"}, {"videoRecordMode": "EVENT"},
                   {"automaticRecording": 0}, {"automaticRecording": True},
                   {"videoRecordStartTime": "24:00"}, {"videoRecordAgingType": 2},
                   {"videoRecordSwitch": True, "cameraSwitch": True}]
        with patch.object(devices, "send_command", AsyncMock()) as send:
            for values in invalid:
                with self.subTest(values=values), self.assertRaises(ValueError):
                    await devices.handle_ha_command("feeder", values)
            send.assert_not_called()

    async def test_overnight_schedule_and_utc_only_cached_hours(self):
        async def publish(serial, payload):
            self.reply(serial, payload)
            return True
        devices._state["feeder"] = {"videoRecordAgingType": 2,
            "videoRecordStartTimeUtc": "22:00", "videoRecordEndTimeUtc": "06:00"}
        with patch.object(devices, "send_command", side_effect=publish) as send:
            await devices.handle_ha_command("feeder", {"videoRecordMode": "MOTION_DETECTION"})
        payload = send.call_args.args[1]
        self.assertEqual(payload["videoRecordStartTime"], "22:00")
        self.assertEqual(payload["videoRecordEndTimeUtc"], "06:00")

    async def test_rejection_and_wrong_device_ack_do_not_save(self):
        for code in (1, True, None):
            async def publish(serial, payload):
                self.reply(serial, payload, code, videoRecordSwitch=True)
                return True
            with self.subTest(code=code), patch.object(devices, "send_command", side_effect=publish):
                with self.assertRaises(RuntimeError):
                    await devices.handle_ha_command("feeder", {"videoRecordSwitch": True})
                self.assertNotIn("videoRecordSwitch", devices._state.get("feeder", {}))
        async def wrong_reply(serial, payload):
            self.reply("another", payload)
            return True
        with patch.object(devices, "send_command", side_effect=wrong_reply):
            with self.assertRaises(asyncio.TimeoutError):
                await devices.handle_ha_command("feeder", {"videoRecordSwitch": True})
        self.assertFalse(devices._pending_recording_acks)

    async def test_publish_failure_and_offline_device_do_not_save(self):
        with patch.object(devices, "send_command", AsyncMock(return_value=False)):
            with self.assertRaises(RuntimeError):
                await devices.handle_ha_command("feeder", {"feedingVideoSwitch": True})
        devices._online["feeder"] = False
        with patch.object(devices, "send_command", AsyncMock()) as send:
            with self.assertRaises(RuntimeError):
                await devices.handle_ha_command("feeder", {"feedingVideoSwitch": True})
            send.assert_not_called()

    async def test_feeding_clips_and_disabling_do_not_require_recording_hours(self):
        devices._state["feeder"] = {"videoRecordAgingType": 2}
        async def publish(serial, payload):
            self.reply(serial, payload)
            return True
        with patch.object(devices, "send_command", side_effect=publish) as send:
            await devices.handle_ha_command("feeder", {"automaticRecording": 5})
            self.assertNotIn("videoRecordStartTime", send.call_args.args[1])
            await devices.handle_ha_command("feeder", {"videoRecordSwitch": False})
        self.assertFalse(devices._state["feeder"]["videoRecordSwitch"])

    async def test_indicator_schedule_sends_timezone_and_vendor_duration(self):
        async def publish(serial, payload):
            self.reply(serial, payload)
            return True
        with patch.object(devices, "send_command", side_effect=publish) as send:
            await devices.handle_ha_command("feeder", {
                "lightSwitch": True, "lightAgingType": 2,
                "lightingStartTime": "22:00", "lightingEndTime": "06:00",
            })
            payload = send.call_args.args[1]
            self.assertEqual(payload["lightingTimes"], -960)
            self.assertEqual(payload["lightingStartTimeUtc"], "22:00")
            self.assertEqual(payload["lightingEndTimeUtc"], "06:00")
            await devices.handle_ha_command("feeder", {"lightAgingType": 1})
            payload = send.call_args.args[1]
            self.assertEqual(payload["lightingStartTime"], "22:00")
            self.assertEqual(payload["lightingEndTime"], "06:00")
            self.assertEqual(payload["lightAgingType"], 1)

    async def test_indicator_schedule_validation_and_rejected_ack(self):
        with patch.object(devices, "send_command", AsyncMock()) as send:
            for invalid in ({"lightAgingType": 2}, {"lightAgingType": True},
                            {"lightSwitch": 1}, {"lightingStartTime": "25:00"}):
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    await devices.handle_ha_command("feeder", invalid)
            send.assert_not_called()
        async def publish(serial, payload):
            self.reply(serial, payload, 1, lightSwitch=True)
            return True
        with patch.object(devices, "send_command", side_effect=publish):
            with self.assertRaises(RuntimeError):
                await devices.handle_ha_command("feeder", {"lightSwitch": True})
        self.assertNotIn("lightSwitch", devices._state.get("feeder", {}))

    async def test_indicator_toggles_always_resend_schedule_context(self):
        devices._state["feeder"] = {"lightAgingType": 2,
            "lightingStartTimeUtc": "12:00", "lightingEndTimeUtc": "00:00"}

        async def publish(serial, payload):
            self.assertEqual(payload["lightAgingType"], 2)
            self.assertEqual(payload["lightingStartTimeUtc"], "12:00")
            self.assertEqual(payload["lightingEndTimeUtc"], "00:00")
            self.assertEqual(payload["lightingTimes"], 720)
            self.reply(serial, payload)
            return True

        def to_utc(value):
            h, m = map(int, value.split(":"))
            return f"{(h + 4) % 24:02d}:{m:02d}"

        with patch.object(devices, "send_command", side_effect=publish) as send, \
                patch.object(devices, "_local_hhmm_to_utc", side_effect=to_utc):
            for enabled in (False, True):
                await devices.handle_ha_command("feeder", {"lightSwitch": enabled})
                payload = send.call_args.args[1]
                self.assertIs(payload["lightSwitch"], enabled)
                self.assertEqual(payload["lightingStartTime"], "08:00")
                self.assertEqual(payload["lightingEndTime"], "20:00")

    async def test_indicator_all_day_without_cached_hours_gets_valid_context(self):
        async def publish(serial, payload):
            self.assertEqual(payload["lightAgingType"], 1)
            self.assertEqual(payload["lightingStartTimeUtc"], "00:00")
            self.assertEqual(payload["lightingEndTimeUtc"], "23:59")
            self.assertEqual(payload["lightingTimes"], 1439)
            self.reply(serial, payload)
            return True

        with patch.object(devices, "send_command", side_effect=publish):
            for enabled in (False, True):
                await devices.handle_ha_command("feeder", {"lightSwitch": enabled})

    async def test_indicator_custom_toggle_without_hours_never_publishes(self):
        devices._state["feeder"] = {"lightAgingType": 2}
        with patch.object(devices, "send_command", AsyncMock()) as send:
            for enabled in (False, True):
                with self.assertRaises(ValueError):
                    await devices.handle_ha_command("feeder", {"lightSwitch": enabled})
            send.assert_not_called()

    async def test_legacy_api_and_ha_indicator_paths_use_safe_camera_settings(self):
        command = {"_granary_field": "lightSwitch", "_granary_value": False}
        with patch.object(devices, "_send_camera_settings", AsyncMock()) as safe, \
                patch.object(devices, "send_command", AsyncMock()) as send, \
                patch.object(devices.ha_mqtt, "parse_command", return_value=command):
            await devices.handle_ha_command("feeder", command)
            await devices._handle_ha_command("feeder", "light/command", "OFF")
            self.assertEqual(safe.await_count, 2)
            safe.assert_awaited_with("feeder", {"lightSwitch": False})
            send.assert_not_called()

    async def test_fountain_light_commands_keep_existing_path(self):
        devices._devices["fountain"] = ("PLWF106", "dockstream2")
        with patch.object(devices, "send_command", AsyncMock(return_value=True)) as send:
            await devices.handle_ha_command("fountain", {"lightSwitch": True})
        send.assert_awaited_once_with("fountain", {"lightSwitch": True})
