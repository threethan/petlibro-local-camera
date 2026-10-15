"""The temporary video relay must release its feeder when a viewer leaves."""

import asyncio
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "camera_video_bridge", Path(__file__).parents[1] / "addon" / "app" / "camera.py",
)
camera = importlib.util.module_from_spec(spec)
spec.loader.exec_module(camera)


class FakeProcess:
    def __init__(self):
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.stdout.feed_data(b"\x00\x00\x00\x18ftypisom")
        self.returncode = None
        self.killed = False

    def kill(self):
        self.killed = True
        self.returncode = -9
        self.stdout.feed_eof()
        self.stderr.feed_eof()

    async def wait(self):
        return self.returncode


class VideoBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_video_stream_is_exclusive_and_stops_on_close(self):
        serial = "TEST123"
        process = FakeProcess()
        captured = []

        async def spawn(*args, **kwargs):
            captured.extend(args)
            return process

        camera._registered_uids[serial] = "x" * 20
        camera._bridge_process = type("Bridge", (), {"returncode": None})()
        with patch.object(camera.asyncio, "create_subprocess_exec", spawn):
            stream = camera.live_video_chunks(serial)
            self.assertIn(b"ftyp", await anext(stream))
            self.assertFalse(camera.live_stream_available(serial))
            self.assertIn("libx264", captured)
            self.assertIn("mp4", captured)
            await stream.aclose()

        self.assertTrue(process.killed)
        self.assertIsNone(camera._live_serial)
        self.assertIsNone(camera._live_process)
        camera._bridge_process = None
        camera._registered_uids.clear()


if __name__ == "__main__":
    unittest.main()
