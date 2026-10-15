"""Manual feeds remain pending until the device reports dispense completion."""

import asyncio
import importlib.util
import json
import logging
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, Mock, patch


spec = importlib.util.spec_from_file_location(
    "manual_feed_test_devices", Path(__file__).parents[1] / "addon/app/devices.py",
)
devices = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {
    "aiomqtt": Mock(), "ha_mqtt": Mock(), "device_types": Mock(),
}), patch("logging.handlers.RotatingFileHandler", return_value=logging.NullHandler()):
    spec.loader.exec_module(devices)


class ManualFeedTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        devices._devices = {"feeder": ("PLAF203", "camera_feeder")}
        devices._manual_feed_requests.clear()
        devices._pending_feed_acks.clear()
        devices._pending_manual_feed.clear()
        devices._client_ref = Mock(publish=AsyncMock())
        self.patches = [
            patch.object(devices, "_check_and_fire_alerts", AsyncMock()),
            patch.object(devices, "_mark_online", Mock()),
            patch.object(devices, "_ack_grain_output", AsyncMock()),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def reply(self, payload, code=0):
        devices._handle_message("feeder", "dl/PLAF203/feeder/device/service/post", json.dumps({
            "cmd": "MANUAL_FEEDING_SERVICE", "msgId": payload["msgId"], "code": code,
        }))

    def complete(self):
        devices._handle_message("feeder", "dl/PLAF203/feeder/device/event/post", json.dumps({
            "cmd": "GRAIN_OUTPUT_EVENT", "finished": True, "actualGrainNum": 1,
        }))

    async def test_ack_does_not_allow_second_feed_before_dispense(self):
        async def publish(topic, body):
            self.reply(json.loads(body))
        devices._client_ref.publish.side_effect = publish
        self.assertTrue(await devices.send_manual_feed("feeder", 1))
        self.assertTrue(devices.manual_feed_pending("feeder"))
        with self.assertRaises(devices.ManualFeedBusyError):
            await devices.send_manual_feed("feeder", 1)
        self.assertEqual(devices._client_ref.publish.await_count, 1)
        self.complete()
        self.assertFalse(devices.manual_feed_pending("feeder"))
        self.assertTrue(await devices.send_manual_feed("feeder", 1))

    async def test_late_ack_keeps_command_pending(self):
        with patch.object(devices, "MANUAL_FEED_ACK_TIMEOUT_SECS", 0.01):
            with self.assertRaises(devices.ManualFeedPendingError):
                await devices.send_manual_feed("feeder", 1)
        self.assertTrue(devices.manual_feed_pending("feeder"))
        with self.assertRaises(devices.ManualFeedBusyError):
            await devices.send_manual_feed("feeder", 1)
        self.complete()
        self.assertFalse(devices.manual_feed_pending("feeder"))

    async def test_rejection_and_publish_failure_release_pending(self):
        async def reject(topic, body):
            self.reply(json.loads(body), code=1)
        devices._client_ref.publish.side_effect = reject
        self.assertFalse(await devices.send_manual_feed("feeder", 1))
        self.assertFalse(devices.manual_feed_pending("feeder"))
        devices._client_ref.publish.side_effect = RuntimeError("broker unavailable")
        with self.assertRaises(RuntimeError):
            await devices.send_manual_feed("feeder", 1)
        self.assertFalse(devices.manual_feed_pending("feeder"))

        devices._client_ref.publish.side_effect = asyncio.TimeoutError()
        with self.assertRaises(asyncio.TimeoutError):
            await devices.send_manual_feed("feeder", 1)
        self.assertFalse(devices.manual_feed_pending("feeder"))

    async def test_completion_before_ack_timeout_counts_as_completed(self):
        async def complete_early(topic, body):
            self.complete()
        devices._client_ref.publish.side_effect = complete_early
        with patch.object(devices, "MANUAL_FEED_ACK_TIMEOUT_SECS", 0.01):
            self.assertTrue(await devices.send_manual_feed("feeder", 1))
        self.assertFalse(devices.manual_feed_pending("feeder"))


if __name__ == "__main__":
    unittest.main()
