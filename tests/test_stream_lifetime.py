"""Stream lifetime preferences and persistent camera consumers."""

import asyncio
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, Mock, mock_open, patch

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer


def load(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).parents[1] / "addon/app" / filename,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


storage = load("lifetime_storage", "storage.py")
camera = load("lifetime_camera", "camera.py")


class LifetimeSettingsTests(unittest.TestCase):
    def test_default_and_legacy_preload(self):
        for stored, expected in [({}, "viewing"),
                                 ({"camera_preload_live_feeds": True}, "web_interface"),
                                 ({"camera_preload_live_feeds": True, "camera_stream_lifetime": "viewing"}, "viewing")]:
            with self.subTest(stored=stored), patch.object(storage, "_load", return_value={"settings": stored}), patch.object(storage, "_save"):
                self.assertEqual(storage.get_settings()["camera_stream_lifetime"], expected)
                self.assertEqual(storage.save_settings({"language": "en"})["camera_stream_lifetime"], expected)

    def test_modes_save_and_invalid_values_do_not(self):
        for value in ("viewing", "web_interface", "home_assistant"):
            with patch.object(storage, "_load", return_value={}), patch.object(storage, "_save") as save:
                self.assertEqual(storage.save_settings({"camera_stream_lifetime": value})["camera_stream_lifetime"], value)
                save.assert_called_once()
        for value in (True, None, "always", 1):
            with patch.object(storage, "_load", return_value={}), patch.object(storage, "_save") as save:
                with self.assertRaises(ValueError):
                    storage.save_settings({"camera_stream_lifetime": value})
                save.assert_not_called()


class LifetimeConsumerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.settings = {"camera_stream_lifetime": "viewing"}
        self.storage = Mock()
        self.storage.get_settings.return_value = self.settings
        self.storage.get_devices.return_value = {}
        self.devices = Mock(publish_camera_availability=AsyncMock(return_value=True))
        self.modules = patch.dict(sys.modules, {"storage": self.storage, "devices": self.devices, "ha_mqtt": Mock(remove_live_camera_discovery=AsyncMock())})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        for name in ("set_live_exposure", "_ensure_live_stream"):
            item = patch.object(camera, name, AsyncMock())
            item.start()
            self.addCleanup(item.stop)
        camera._camera_available.clear()
        camera._snapshot_available.clear()
        camera._live_available.clear()
        camera._registered_uids = {"feeder": "x" * 20}

    async def asyncTearDown(self):
        self.settings["camera_stream_lifetime"] = "viewing"
        await camera.refresh_stream_lifetime()
        camera._registered_uids.clear()

    async def test_only_server_mode_starts_consumer_and_disabling_releases_it(self):
        for mode in ("viewing", "web_interface"):
            self.settings["camera_stream_lifetime"] = mode
            await camera.refresh_stream_lifetime()
            self.assertFalse(camera._keep_open_tasks)

        process = Mock(returncode=None, stdout=asyncio.StreamReader(), stderr=asyncio.StreamReader(), wait=AsyncMock())
        started = asyncio.Event()

        async def spawn(*args, **kwargs):
            self.assertIn("copy", args)
            self.assertIn("null", args)
            self.assertIn("rtsp://127.0.0.1:18556/plaf203_feeder?video=h264&audio=opus&audio=aac", args)
            self.assertIn("0:a?", args)
            started.set()
            return process

        with patch.object(camera.asyncio, "create_subprocess_exec", side_effect=spawn):
            self.settings["camera_stream_lifetime"] = "home_assistant"
            await camera.refresh_stream_lifetime()
            await asyncio.wait_for(started.wait(), 1)
            original = camera._keep_open_tasks["feeder"]
            camera._start_keep_open("feeder")
            self.assertIs(camera._keep_open_tasks["feeder"], original)
            self.settings["camera_stream_lifetime"] = "viewing"
            await camera.refresh_stream_lifetime()
            process.kill.assert_called_once()
            process.wait.assert_awaited_once()
            self.assertFalse(camera._keep_open_tasks)

    async def test_stopping_device_cancels_persistent_consumer(self):
        self.settings["camera_stream_lifetime"] = "home_assistant"
        camera._start_keep_open("feeder")
        task = camera._keep_open_tasks["feeder"]
        with patch.object(camera, "_set_available", AsyncMock()):
            await camera.stop_device("feeder")
        self.assertTrue(task.cancelled())
        self.assertFalse(camera._keep_open_tasks)

        self.assertNotIn("feeder", camera._registered_uids)

    async def test_dropped_stream_reconnects(self):
        first = Mock(returncode=0, stdout=asyncio.StreamReader(), stderr=asyncio.StreamReader())
        first.stdout.feed_eof()
        first.stderr.feed_eof()
        second = Mock(returncode=None, stdout=asyncio.StreamReader(), stderr=asyncio.StreamReader(), wait=AsyncMock())
        reconnected = asyncio.Event()
        calls = 0

        async def spawn(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                return first
            reconnected.set()
            return second

        with patch.object(camera.asyncio, "create_subprocess_exec", side_effect=spawn), patch.object(camera.asyncio, "sleep", AsyncMock()) as retry:
            self.settings["camera_stream_lifetime"] = "home_assistant"
            camera._start_keep_open("feeder")
            await asyncio.wait_for(reconnected.wait(), 1)
            retry.assert_awaited_once_with(5)
            self.settings["camera_stream_lifetime"] = "viewing"
            await camera.refresh_stream_lifetime()
            second.kill.assert_called_once()

    async def test_shutdown_cancels_consumers_without_snapshots(self):
        self.settings["camera_stream_lifetime"] = "home_assistant"
        camera._start_keep_open("feeder")
        task = camera._keep_open_tasks["feeder"]
        with patch.object(camera, "_set_available", AsyncMock()):
            await camera.stop_bridge()
        self.assertTrue(task.cancelled())
        self.assertFalse(camera._keep_open_tasks)


class SharedLiveStreamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.settings = {"camera_stream_lifetime": "home_assistant", "camera_vp8_transcoding": False}
        self.configs = {"feeder": {"device_type": "camera_feeder"}}
        self.storage = Mock()
        self.storage.get_settings.return_value = self.settings
        self.storage.get_devices.return_value = self.configs
        self.devices = Mock(publish_camera_availability=AsyncMock(return_value=True))
        self.discovery = Mock(publish_live_camera_discovery=AsyncMock(), remove_live_camera_discovery=AsyncMock())
        item = patch.dict(sys.modules, {"storage": self.storage, "devices": self.devices, "ha_mqtt": self.discovery})
        item.start()
        self.addCleanup(item.stop)
        camera._registered_uids = {"feeder": "x" * 20}
        for state in (camera._live_exposed, camera._stream_sources, camera._stream_locks,
                      camera._live_available, camera._snapshot_available, camera._camera_available):
            state.clear()
        self.streams = {}
        self.puts = 0

        async def streams(request):
            if request.method == "PUT":
                self.puts += 1
                self.streams[request.query["name"]] = request.query.getall("src")
                # Match go2rtc adding the stream but failing config persistence.
                return web.Response(status=400, text="read-only config")
            if request.method == "DELETE":
                self.streams.pop(request.query["src"], None)
                return web.Response()
            return web.json_response(self.streams)

        async def webrtc(request):
            return web.Response(body=b"answer", headers={"Location": "/api/session/1"})

        app = web.Application()
        app.router.add_route("*", "/api/streams", streams)
        app.router.add_post("/api/webrtc", webrtc)
        self.server = TestServer(app)
        await self.server.start_server()
        camera._http = aiohttp.ClientSession()
        item = patch.multiple(camera, _GO2RTC_API=str(self.server.make_url("/")).rstrip("/"),
                              _GO2RTC_WEBRTC=str(self.server.make_url("/api/webrtc")) + "?src={serial}",
                              _HA_RTSP_HOST="127.0.0.1", _HA_RTSP_PORT=0)
        item.start()
        self.addCleanup(item.stop)

    async def asyncTearDown(self):
        self.settings["camera_stream_lifetime"] = "viewing"
        await camera.refresh_stream_lifetime()
        await camera._stop_ha_rtsp()
        await camera._http.close()
        camera._http = None
        camera._registered_uids.clear()
        await self.server.close()

    async def test_new_viewers_reuse_the_registered_producer(self):
        await camera.set_live_exposure("feeder", True, self.configs["feeder"], {})
        for _ in range(2):
            answer, _ = await camera.exchange_webrtc("feeder", b"offer")
            self.assertEqual(answer, b"answer")
        self.assertEqual(self.puts, 1)
        # Recover if go2rtc loses its in-memory stream registry.
        self.streams.clear()
        await camera.exchange_webrtc("feeder", b"offer")
        self.assertEqual(self.puts, 2)

    async def test_server_mode_respects_exposure_preference(self):
        with patch.object(camera, "_start_keep_open"):
            await camera.refresh_stream_lifetime()
            self.discovery.publish_live_camera_discovery.assert_not_awaited()
            self.assertNotIn("feeder", camera._live_exposed)
            self.configs["feeder"]["live_camera_exposed"] = True
            await camera.refresh_stream_lifetime()
            self.discovery.publish_live_camera_discovery.assert_awaited_once()
            self.assertIn("feeder", camera._live_exposed)
            self.configs["feeder"]["live_camera_exposed"] = False
            await camera.refresh_stream_lifetime()
            self.assertNotIn("feeder", camera._live_exposed)
            self.settings["camera_stream_lifetime"] = "viewing"
            await camera.refresh_stream_lifetime()
            self.discovery.publish_live_camera_discovery.assert_awaited_once()
            self.assertNotIn("feeder", camera._live_exposed)

    async def test_snapshot_disabled_does_not_mark_live_feed_offline(self):
        camera._live_available["feeder"] = True
        await camera._set_available("feeder", False)
        self.devices.publish_camera_availability.assert_awaited_once_with("feeder", True)
        camera._live_available["feeder"] = False
        await camera._publish_available("feeder")
        self.devices.publish_camera_availability.assert_awaited_with("feeder", False)

    async def test_codec_change_refreshes_once(self):
        await camera.set_live_exposure("feeder", True, self.configs["feeder"], {})
        self.settings["camera_vp8_transcoding"] = True
        await camera.refresh_live_exposures()
        self.assertIn("#video=vp8", self.streams["plaf203_feeder"][0])
        await camera.exchange_webrtc("feeder", b"offer")
        self.assertEqual(self.puts, 2)

    async def test_background_feed_warms_all_tracks_and_reports_ready_without_snapshots(self):
        self.settings["camera_vp8_transcoding"] = True
        process = Mock(returncode=None, stdout=asyncio.StreamReader(), stderr=asyncio.StreamReader(), wait=AsyncMock())
        process.stdout.feed_data(b"frame=0\nprogress=continue\nframe=1\nprogress=continue\n")
        ready = asyncio.Event()

        async def publish(serial, available):
            if available:
                ready.set()
            return True

        self.devices.publish_camera_availability.side_effect = publish
        with patch.object(camera.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)) as spawn:
            camera._start_keep_open("feeder")
            await asyncio.wait_for(ready.wait(), 1)
            source = spawn.call_args.args[spawn.call_args.args.index("-i") + 1]
            self.assertIn("video=vp8&video=h264&audio=opus&audio=aac", source)
            self.assertNotIn("feeder", camera._live_exposed)
            self.discovery.publish_live_camera_discovery.assert_not_awaited()
            await camera._set_available("feeder", False)
            self.assertTrue(camera._camera_available["feeder"])
            await camera.close_webrtc("browser-session")
            process.kill.assert_not_called()
            self.settings["camera_stream_lifetime"] = "viewing"
            await camera.refresh_stream_lifetime()
            process.kill.assert_called_once()
            self.assertFalse(camera._camera_available["feeder"])

    async def test_unexposing_preserves_background_process_and_browser_stream(self):
        self.configs["feeder"]["live_camera_exposed"] = True
        process = Mock(returncode=None, stdout=asyncio.StreamReader(), stderr=asyncio.StreamReader(), wait=AsyncMock())
        process.stdout.feed_data(b"frame=1\n")
        ready = asyncio.Event()

        async def publish(serial, available):
            if available:
                ready.set()
            return True

        self.devices.publish_camera_availability.side_effect = publish
        with patch.object(camera.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)):
            camera._start_keep_open("feeder")
            await asyncio.wait_for(ready.wait(), 1)
            task = camera._keep_open_tasks["feeder"]
            self.configs["feeder"]["live_camera_exposed"] = False
            await camera.set_live_exposure("feeder", False, self.configs["feeder"], {})
            self.assertNotIn("feeder", camera._live_exposed)
            self.assertIs(camera._keep_open_tasks["feeder"], task)
            self.assertIsNone(camera._ha_rtsp_server)
            self.assertFalse(task.done())
            process.kill.assert_not_called()
            self.assertIn("plaf203_feeder", self.streams)
            self.assertTrue(camera._live_available["feeder"])
            answer, _ = await camera.exchange_webrtc("feeder", b"offer")
            self.assertEqual(answer, b"answer")
            self.assertEqual(self.puts, 1)
            # A subsequent device state sync must not re-expose the camera.
            with patch.object(camera, "_bridge_process", Mock(returncode=None)), patch.object(camera, "_SNAPSHOTS_ENABLED", False):
                await camera.update_device("feeder", "x" * 20, True)
            self.assertNotIn("feeder", camera._live_exposed)
            self.discovery.publish_live_camera_discovery.assert_awaited_once()

    async def test_discovery_failure_does_not_delete_running_relay(self):
        await camera._ensure_live_stream("feeder")
        self.discovery.publish_live_camera_discovery.side_effect = RuntimeError("MQTT unavailable")
        with self.assertRaises(RuntimeError):
            await camera.set_live_exposure("feeder", True, self.configs["feeder"], {})
        self.assertIn("plaf203_feeder", self.streams)
        self.assertNotIn("feeder", camera._live_exposed)
        self.assertIsNone(camera._ha_rtsp_server)

    async def test_startup_keeps_go2rtc_private_without_ha_relay(self):
        output = mock_open()
        with patch("builtins.open", output), patch.object(camera, "_go2rtc_process", None), \
                patch.object(camera.asyncio, "create_subprocess_exec", AsyncMock(return_value=Mock(returncode=None))):
            await camera._start_go2rtc()
        configuration = "".join(call.args[0] for call in output().write.call_args_list)
        self.assertIn('listen: "127.0.0.1:18556"', configuration)
        self.assertNotIn('listen: "172.30.32.1:18556"', configuration)
        self.assertIsNone(camera._ha_rtsp_server)

    async def test_mqtt_startup_failure_retries_exposure_without_restarting_background_video(self):
        self.configs["feeder"]["live_camera_exposed"] = True
        self.discovery.publish_live_camera_discovery.side_effect = [RuntimeError("MQTT connecting"), None]
        process = Mock(returncode=None, stdout=asyncio.StreamReader(), stderr=asyncio.StreamReader(), wait=AsyncMock())
        process.stdout.feed_data(b"frame=1\n")
        ready = asyncio.Event()

        async def publish(serial, available):
            if available:
                ready.set()
            return True

        self.devices.publish_camera_availability.side_effect = publish
        with patch.object(camera.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)) as spawn:
            camera._start_keep_open("feeder")
            await asyncio.wait_for(ready.wait(), 1)
            self.assertIn("feeder", camera._live_exposed)
            self.assertIsNotNone(camera._ha_rtsp_server)
            spawn.assert_awaited_once()
            process.kill.assert_not_called()

    async def test_last_unexposed_camera_closes_listener_and_clients_but_not_private_relay(self):
        upstream_writers = []

        async def upstream(reader, writer):
            upstream_writers.append(writer)
            try:
                writer.write(b"RTSP/1.0 200 OK\r\n\r\n")
                await writer.drain()
                await reader.read()
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(upstream, "127.0.0.1", 0)
        camera._registered_uids["other"] = "y" * 20
        try:
            with patch.object(camera, "_INTERNAL_RTSP_PORT", server.sockets[0].getsockname()[1]):
                self.assertIsNone(camera._ha_rtsp_server)
                await camera.set_live_exposure("feeder", True, self.configs["feeder"], {})
                port = camera._ha_rtsp_server.sockets[0].getsockname()[1]
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                self.assertEqual(await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 1), b"RTSP/1.0 200 OK\r\n\r\n")
                await camera.set_live_exposure("other", True, {}, {})
                await camera.set_live_exposure("feeder", False, self.configs["feeder"], {})
                self.assertIsNotNone(camera._ha_rtsp_server)
                self.assertFalse(reader.at_eof())
                await camera.set_live_exposure("other", False, {}, {})
                self.assertEqual(await asyncio.wait_for(reader.read(), 1), b"")
                self.assertIsNone(camera._ha_rtsp_server)
                self.assertFalse(camera._ha_rtsp_tasks)
                with self.assertRaises(OSError):
                    await asyncio.open_connection("127.0.0.1", port)
                writer.close()
                await writer.wait_closed()
                # The app's private relay remains reachable without HA exposure.
                private_reader, private_writer = await asyncio.open_connection("127.0.0.1", camera._INTERNAL_RTSP_PORT)
                await asyncio.wait_for(private_reader.readuntil(b"\r\n\r\n"), 1)
                private_writer.close()
                await private_writer.wait_closed()
                await camera.set_live_exposure("feeder", True, self.configs["feeder"], {})
                self.assertIsNotNone(camera._ha_rtsp_server)
        finally:
            await camera._stop_ha_rtsp()
            for writer in upstream_writers:
                writer.close()
                await writer.wait_closed()
            server.close()
            await server.wait_closed()
