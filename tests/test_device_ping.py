"""Verify UI probes require a device reply and share concurrent requests."""

import asyncio
import importlib.util
import json
import logging
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, Mock, patch


spec = importlib.util.spec_from_file_location(
    "ping_test_devices", Path(__file__).parents[1] / "addon/app/devices.py",
)
devices = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {
    "aiomqtt": Mock(), "ha_mqtt": Mock(), "device_types": Mock(),
}), patch("logging.handlers.RotatingFileHandler", return_value=logging.NullHandler()):
    spec.loader.exec_module(devices)


class DevicePingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        devices._devices = {"feeder": ("model", "granary")}
        devices._online = {"feeder": True}
        devices._pending_pings.clear()
        devices._ping_tasks.clear()
        devices._client_ref = None
        devices._state.clear()
        self.patches = [
            patch.object(devices, "UI_PING_TIMEOUT_SECS", 0.03),
            patch.object(devices, "_check_and_fire_alerts", AsyncMock()),
            patch.object(devices, "_publish_ha_state", AsyncMock()),
            patch.object(devices, "_persist_state_cache", AsyncMock()),
            patch.object(devices, "_sync_camera", Mock()),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def respond(self, serial, payload, **overrides):
        devices._handle_message(serial, "dl/model/feeder/device/service/post", json.dumps({
            "cmd": "ATTR_GET_SERVICE", "msgId": payload["msgId"], **overrides,
        }))

    async def test_matching_reply_keeps_device_online(self):
        async def send(serial, payload):
            self.respond(serial, payload)
            return True
        with patch.object(devices, "send_command", side_effect=send):
            await devices.ping_devices()
        self.assertTrue(devices._online["feeder"])
        self.assertFalse(devices._pending_pings)

    async def test_publish_without_reply_marks_offline(self):
        with patch.object(devices, "send_command", AsyncMock(return_value=True)):
            await devices.ping_devices()
        self.assertFalse(devices._online["feeder"])
        self.assertFalse(devices._pending_pings)

    async def test_unrelated_reply_does_not_satisfy_ping(self):
        async def send(serial, payload):
            self.respond(serial, payload, msgId="older-query")
            return True
        with patch.object(devices, "send_command", side_effect=send):
            await devices.ping_devices()
        self.assertFalse(devices._online["feeder"])

    async def test_failed_publish_marks_offline(self):
        with patch.object(devices, "send_command", AsyncMock(return_value=False)):
            await devices.ping_devices()
        self.assertFalse(devices._online["feeder"])

    async def test_concurrent_tabs_share_probe(self):
        async def send(serial, payload):
            await asyncio.sleep(0)
            self.respond(serial, payload)
            return True
        with patch.object(devices, "send_command", side_effect=send) as send_mock:
            await asyncio.gather(devices.ping_devices(), devices.ping_devices())
        self.assertEqual(send_mock.call_count, 1)
        self.assertFalse(devices._ping_tasks)


if __name__ == "__main__":
    unittest.main()
