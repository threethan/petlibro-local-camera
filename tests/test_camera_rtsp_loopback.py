"""Exercise the Home Assistant RTSP relay with real TCP sockets."""

import asyncio
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "camera", Path(__file__).parents[1] / "addon" / "app" / "camera.py",
)
camera = importlib.util.module_from_spec(spec)
# These tests only exercise asyncio networking; aiohttp is an add-on dependency.
with patch.dict(sys.modules, {"aiohttp": types.ModuleType("aiohttp")}):
    spec.loader.exec_module(camera)


class RtspLoopbackTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.connected = asyncio.Event()
        self.clients = []
        self.upstreams = []

        async def echo(reader, writer):
            self.upstreams.append(writer)
            self.connected.set()
            try:
                writer.write(b"RTSP/1.0 200 OK\r\n\r\n")
                await writer.drain()
                while data := await reader.read(65536):
                    writer.write(data)
                    await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        self.upstream = await asyncio.start_server(echo, "127.0.0.1", 0)
        self.target = patch.multiple(
            camera, _INTERNAL_RTSP_HOST="127.0.0.1",
            _INTERNAL_RTSP_PORT=self.upstream.sockets[0].getsockname()[1],
        )
        self.target.start()
        camera._ha_rtsp_server = await asyncio.start_server(
            camera._forward_ha_rtsp, "127.0.0.1", 0,
        )
        self.port = camera._ha_rtsp_server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        await asyncio.wait_for(camera._stop_ha_rtsp(), 3)
        for writer in self.clients + self.upstreams:
            writer.close()
            await writer.wait_closed()
        self.upstream.close()
        await self.upstream.wait_closed()
        self.target.stop()

    async def connect(self):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        self.clients.append(writer)
        await asyncio.wait_for(self.connected.wait(), 3)
        self.assertEqual(await reader.readuntil(b"\r\n\r\n"), b"RTSP/1.0 200 OK\r\n\r\n")
        return reader, writer

    async def test_bidirectional_binary_stream(self):
        reader, writer = await self.connect()
        payload = b"ANNOUNCE rtsp://127.0.0.1/stream RTSP/1.0\r\n\r\n" + bytes(range(256)) * 4096
        writer.write(payload)
        await writer.drain()
        self.assertEqual(await asyncio.wait_for(reader.readexactly(len(payload)), 3), payload)
        writer.close()
        await writer.wait_closed()
        self.assertEqual(await asyncio.wait_for(self.upstreams[0].wait_closed(), 3), None)

    async def test_upstream_disconnect_closes_client(self):
        reader, _ = await self.connect()
        self.upstreams[0].close()
        self.assertEqual(await asyncio.wait_for(reader.read(), 3), b"")

    async def test_shutdown_closes_active_connections(self):
        reader, _ = await self.connect()
        await asyncio.wait_for(camera._stop_ha_rtsp(), 3)
        self.assertEqual(await asyncio.wait_for(reader.read(), 3), b"")
        self.assertFalse(camera._ha_rtsp_tasks)
        self.assertIsNone(camera._ha_rtsp_server)


if __name__ == "__main__":
    unittest.main()
