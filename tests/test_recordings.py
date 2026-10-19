"""Exercise SD listing and viewer cleanup over real local HTTP connections."""

import asyncio
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

APP = Path(__file__).parents[1] / "addon/app"
spec = importlib.util.spec_from_file_location("recordings_under_test", APP / "recordings.py")
recordings = importlib.util.module_from_spec(spec)
camera = SimpleNamespace(_SERIAL_RE=__import__("re").compile(r"^[A-Za-z0-9_-]{1,64}$"),
                         _registered_uids={"feeder": "x" * 20},
                         _bridge_process=SimpleNamespace(returncode=None))
devices = SimpleNamespace(is_online=lambda serial: True, get_device_state=lambda serial: {})
storage = SimpleNamespace(get_devices=lambda: {"feeder": {"device_type": "camera_feeder"}})
with patch.dict(sys.modules, {"camera": camera, "devices": devices, "storage": storage}):
    spec.loader.exec_module(recordings)


class RecordingApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.bridge_result = {"complete": True, "recordings": [{"start": 1700000100, "duration": 60, "event": 48}]}
        self.bridge_status = 200

        async def list_recordings(request):
            self.requests.append(dict(request.query))
            return web.json_response(self.bridge_result, status=self.bridge_status)

        async def stream_recording(request):
            self.requests.append(dict(request.query))
            return web.Response(body=b"historical H264", content_type="video/h264")

        self.delete_result = {"deleted": 1700000100}

        async def delete_recording(request):
            self.requests.append({"delete": request.match_info["start"]})
            return web.json_response(self.delete_result)

        bridge = web.Application()
        bridge.router.add_get("/devices/feeder/recordings", list_recordings)
        bridge.router.add_get("/devices/feeder/recordings/stream", stream_recording)
        bridge.router.add_delete("/devices/feeder/recordings/{start}", delete_recording)
        self.bridge = TestServer(bridge)
        await self.bridge.start_server()
        camera._BRIDGE_API = str(self.bridge.make_url("")).rstrip("/")
        app = web.Application()
        app.router.add_get("/api/{serial}/recordings", recordings.handle_list, allow_head=False)
        app.router.add_get("/api/{serial}/video.mp4", recordings.handle_video, allow_head=False)
        app.router.add_delete("/api/{serial}/recordings/{start}", recordings.handle_delete)
        app.on_shutdown.append(recordings.on_shutdown)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await recordings.stop_all()
        await self.client.close()
        await self.bridge.close()

    async def test_complete_day_list_reaches_only_local_bridge(self):
        response = await self.client.get("/api/feeder/recordings?start=1700000000&end=1700086400")
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), self.bridge_result)
        self.assertEqual(self.requests, [{"start": "1700000000", "end": "1700086399"}])
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    async def test_invalid_ranges_and_unknown_devices_never_contact_bridge(self):
        for query in ("start=-1&end=2", "start=1&end=1", "start=1&end=100000", "start=abc&end=2", "start=2147483648&end=2147483649"):
            response = await self.client.get(f"/api/feeder/recordings?{query}")
            self.assertEqual(response.status, 400, query)
        response = await self.client.get("/api/unknown/recordings?start=1700000000&end=1700086400")
        self.assertEqual(response.status, 404)
        response = await self.client.head("/api/feeder/video.mp4?start=1700000000")
        self.assertEqual(response.status, 405)
        self.assertEqual(self.requests, [])

    async def test_no_reply_or_incomplete_reply_is_never_an_empty_card(self):
        self.bridge_result = {"complete": False, "recordings": []}
        response = await self.client.get("/api/feeder/recordings?start=1700000000&end=1700086400")
        self.assertEqual(response.status, 502)
        self.bridge_status = 504
        response = await self.client.get("/api/feeder/recordings?start=1700000000&end=1700086400")
        self.assertEqual(response.status, 504)

    async def test_offline_device_is_rejected_before_bridge(self):
        with patch.object(devices, "is_online", return_value=False):
            response = await self.client.get("/api/feeder/recordings?start=1700000000&end=1700086400")
        self.assertEqual(response.status, 409)
        self.assertEqual(self.requests, [])

    async def test_deletion_requires_device_confirmation_and_stays_device_scoped(self):
        response = await self.client.delete("/api/feeder/recordings/1700000100")
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {"deleted": 1700000100})
        self.assertEqual(self.requests, [{"delete": "1700000100"}])
        self.delete_result = {"deleted": 1700000101}
        response = await self.client.delete("/api/feeder/recordings/1700000100")
        self.assertEqual(response.status, 502)
        response = await self.client.delete("/api/unknown/recordings/1700000100")
        self.assertEqual(response.status, 404)

    async def test_closing_viewer_releases_decoder_and_exclusive_slot(self):
        process = FakeDecoder()
        with patch.object(recordings.asyncio, "create_subprocess_exec", return_value=process) as spawn:
            response = await self.client.get("/api/feeder/video.mp4?start=1700000100&offset=12")
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.content.read(8), b"fake mp4")
            self.assertEqual(self.requests[-1], {"start": "1700000100", "offset": "12", "format": "mpegts"})
            args = spawn.call_args.args
            self.assertNotIn("-an", args)
            self.assertIn("0:a:0?", args)  # Clips without audio must still play.
            self.assertEqual(args[args.index("-c:a") + 1], "aac")
            second = await self.client.get("/api/feeder/video.mp4?start=1700000100")
            self.assertEqual(second.status, 409)
            response.close()
            async with asyncio.timeout(3):
                while recordings._viewers:
                    await asyncio.sleep(0.02)
            self.assertTrue(process.killed)
            self.assertTrue(process.stdin.closed)


class FakeInput:
    closed = False

    def write(self, data):
        pass

    async def drain(self):
        pass

    def close(self):
        self.closed = True


class FakeDecoder:
    def __init__(self):
        self.stdin = FakeInput()
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(b"fake mp4")
        self.stderr = asyncio.StreamReader()
        self.returncode = None
        self.killed = False

    def kill(self):
        self.killed = True
        self.returncode = -9
        self.stdout.feed_eof()
        self.stderr.feed_eof()

    async def wait(self):
        return self.returncode


if __name__ == "__main__":
    unittest.main()
