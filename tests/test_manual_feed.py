"""Manual feeds remain pending until the device reports dispense completion."""

import asyncio
import importlib.util
import json
import logging
from pathlib import Path
import sys
import tempfile
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


spec = importlib.util.spec_from_file_location(
    "manual_feed_test_storage", Path(__file__).parents[1] / "addon/app/storage.py",
)
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class ManualFeedTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        devices._devices = {"feeder": ("PLAF203", "camera_feeder")}
        devices._manual_feed_requests.clear()
        devices._pending_feed_acks.clear()
        devices._pending_manual_feed.clear()
        devices._online = {"feeder": True}
        devices._client_ref = Mock(publish=AsyncMock())
        devices.ha_mqtt.publish_availability = AsyncMock()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.patches = [
            patch.dict(sys.modules, {"storage": storage}),
            patch.object(storage, "DATA_FILE", str(Path(self.temp_dir.name) / "state.json")),
            patch.object(devices, "_check_and_fire_alerts", AsyncMock()),
            patch.object(devices, "_mark_online", Mock()),
            patch.object(devices, "_ack_grain_output", AsyncMock()),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    async def test_half_cup_limit_defaults_on_and_blocks_larger_feeds(self):
        self.assertTrue(storage.get_settings()["manual_feed_half_cup_limit"])
        async def publish(topic, body):
            self.reply(json.loads(body))
        devices._client_ref.publish.side_effect = publish
        with self.assertRaisesRegex(ValueError, "1/2 cup"):
            await devices.send_manual_feed("feeder", 7)
        devices._client_ref.publish.assert_not_awaited()
        self.assertFalse(devices.manual_feed_pending("feeder"))
        self.assertTrue(await devices.send_manual_feed("feeder", 6))
        self.assertEqual(json.loads(devices._client_ref.publish.call_args.args[1])["grainNum"], 6)

    async def test_disabling_limit_persists_and_allows_full_manual_feed_range(self):
        storage.save_settings({"manual_feed_half_cup_limit": False})
        self.assertFalse(storage.get_settings()["manual_feed_half_cup_limit"])
        async def publish(topic, body):
            self.reply(json.loads(body))
        devices._client_ref.publish.side_effect = publish
        self.assertTrue(await devices.send_manual_feed("feeder", 48))
        self.complete()
        storage.save_settings({"manual_feed_half_cup_limit": True})
        with self.assertRaisesRegex(ValueError, "1/2 cup"):
            await devices.send_manual_feed("feeder", 7)
        with self.assertRaises(ValueError):
            storage.save_settings({"manual_feed_half_cup_limit": "false"})

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

    async def test_offline_clears_acknowledged_feed_until_reconnected(self):
        async def publish(topic, body):
            self.reply(json.loads(body))
        devices._client_ref.publish.side_effect = publish
        await devices.send_manual_feed("feeder", 1)
        devices._mark_offline("feeder")
        self.assertFalse(devices.manual_feed_pending("feeder"))
        self.assertNotIn("feeder", devices._pending_manual_feed)
        self.assertFalse(devices.get_all_states()["feeder"]["manual_feed_pending"])
        devices._online["feeder"] = True
        self.assertTrue(await devices.send_manual_feed("feeder", 1))

    async def test_offline_while_waiting_for_ack_fails_without_claiming_completion(self):
        feed = asyncio.create_task(devices.send_manual_feed("feeder", 1))
        while not devices._pending_manual_feed:
            await asyncio.sleep(0)
        devices._mark_offline("feeder")
        with self.assertRaisesRegex(RuntimeError, "went offline"):
            await feed
        self.assertFalse(devices.manual_feed_pending("feeder"))
        self.assertFalse(devices._pending_feed_acks)
        self.assertFalse(devices._pending_manual_feed)

    async def test_offline_during_publish_does_not_restore_pending_state(self):
        async def publish(topic, body):
            devices._mark_offline("feeder")
        devices._client_ref.publish.side_effect = publish
        with self.assertRaisesRegex(RuntimeError, "went offline"):
            await devices.send_manual_feed("feeder", 1)
        self.assertFalse(devices.manual_feed_pending("feeder"))
        self.assertFalse(devices._pending_manual_feed)


if __name__ == "__main__":
    unittest.main()
