"""Exercise talkback ownership and cleanup with real HTTP/WebSocket sockets."""

import asyncio
import importlib.util
from pathlib import Path
import re
import sys
import types
import unittest
from unittest.mock import patch

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer


spec = importlib.util.spec_from_file_location(
    "camera_talk_tested", Path(__file__).parents[1] / "addon/app/camera_talk.py",
)
talk = importlib.util.module_from_spec(spec)
camera = types.SimpleNamespace(
    _SERIAL_RE=re.compile(r"^[A-Za-z0-9_-]{1,64}$"),
    _registered_uids={"feeder": "private-uid"},
    _bridge_process=types.SimpleNamespace(returncode=None), _BRIDGE_API="",
)
devices = types.SimpleNamespace(is_online=lambda serial: True, get_device_state=lambda serial: {})
storage = types.SimpleNamespace(get_devices=lambda: {"feeder": {"device_type": "camera_feeder"}})
with patch.dict(sys.modules, {"camera": camera, "devices": devices, "storage": storage}):
    spec.loader.exec_module(talk)


class Encoder:
    def __init__(self):
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.stdin = self
        self.returncode = None
        self.ended = asyncio.Event()
        self.pcm = []

    def write(self, data):
        self.pcm.append(data)
        self.stdout.feed_data(b"adts-frame")

    async def drain(self):
        pass

    def kill(self):
        self.returncode = -9
        self.stdout.feed_eof()
        self.stderr.feed_eof()
        self.ended.set()

    async def wait(self):
        await self.ended.wait()
        return self.returncode


class TalkTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.encoder = Encoder()
        self.bridge_ready = asyncio.Event()
        self.bridge_started = asyncio.Event()
        self.bridge_closed = asyncio.Event()
        self.bridge_bytes = []
        self.bridge_status = 200
        self.block_setup = False
        self.process_patch = patch.object(talk.asyncio, "create_subprocess_exec", self.spawn)
        self.process_patch.start()
        talk._sessions.clear()

        async def bridge(request):
            self.bridge_started.set()
            if self.block_setup:
                await self.bridge_ready.wait()
            if self.bridge_status != 200:
                return web.Response(status=self.bridge_status, text="private-uid http://internal")
            response = web.StreamResponse()
            await response.prepare(request)
            self.bridge_ready.set()
            try:
                async for data in request.content.iter_any():
                    self.bridge_bytes.append(data)
            except ConnectionError:
                pass
            finally:
                self.bridge_closed.set()
            return response

        upstream = web.Application()
        upstream.router.add_post("/devices/{serial}/talkback", bridge)
        self.upstream = TestServer(upstream)
        await self.upstream.start_server()
        camera._BRIDGE_API = str(self.upstream.make_url("/")).rstrip("/")
        app = web.Application()
        app.router.add_get("/talk/{serial}", talk.handle_talk)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def spawn(self, *args, **kwargs):
        self.assertIn("aac_low", args)
        return self.encoder

    async def asyncTearDown(self):
        self.bridge_ready.set()
        await talk.stop_all()
        await self.client.close()
        await self.upstream.close()
        self.process_patch.stop()

    async def connect(self):
        ws = await self.client.ws_connect("/talk/feeder")
        self.assertEqual((await ws.receive_json(timeout=2))["type"], "ready")
        self.assertTrue(self.bridge_ready.is_set())
        return ws

    async def finish(self, ws):
        owner = talk._sessions["feeder"]
        await ws.send_json({"type": "stop"})
        await ws.close()
        await asyncio.wait_for(asyncio.shield(owner), 2)
        self.assertEqual(talk._sessions, {})
        self.assertIsNotNone(self.encoder.returncode)

    async def test_stream_and_stop_release_every_resource(self):
        ws = await self.connect()
        await ws.send_bytes(b"\x00\x01" * 1024)
        # Allow both socket layers to deliver data, then close the owning socket.
        async with asyncio.timeout(2):
            while not self.bridge_bytes:
                await asyncio.sleep(0.01)
        self.assertEqual(self.encoder.pcm, [b"\x00\x01" * 1024])
        self.assertEqual(b"".join(self.bridge_bytes), b"adts-frame")
        await self.finish(ws)
        await asyncio.wait_for(self.bridge_closed.wait(), 2)

    async def test_competing_socket_cannot_replace_or_stop_owner(self):
        ws = await self.connect()
        owner = talk._sessions["feeder"]
        with self.assertRaises(aiohttp.WSServerHandshakeError) as error:
            await self.client.ws_connect("/talk/feeder")
        self.assertEqual(error.exception.status, 409)
        self.assertIs(talk._sessions["feeder"], owner)
        self.assertFalse(owner.done())
        await self.finish(ws)

    async def test_invalid_pcm_is_rejected_and_encoder_killed(self):
        ws = await self.connect()
        owner = talk._sessions["feeder"]
        await ws.send_bytes(b"odd")
        message = await ws.receive_json(timeout=2)
        self.assertEqual(message, {"type": "error", "message": "Invalid microphone audio"})
        await ws.close()
        await asyncio.wait_for(asyncio.shield(owner), 2)
        self.assertIsNotNone(self.encoder.returncode)
        self.assertFalse(talk._sessions)

    async def test_device_shutdown_stops_owning_socket(self):
        ws = await self.connect()
        await asyncio.wait_for(talk.stop_device("feeder"), 2)
        self.assertEqual((await ws.receive(timeout=2)).type, aiohttp.WSMsgType.CLOSE)
        self.assertFalse(talk._sessions)
        self.assertIsNotNone(self.encoder.returncode)

    async def test_bridge_failure_never_advertises_ready_or_leaks_details(self):
        self.bridge_status = 503
        ws = await self.client.ws_connect("/talk/feeder")
        message = await ws.receive_json(timeout=2)
        self.assertEqual(message["type"], "error")
        self.assertNotIn("private-uid", str(message))
        self.assertNotIn("internal", str(message))
        await ws.close()

    async def test_stop_during_handshake_cancels_setup(self):
        self.block_setup = True
        ws = await self.client.ws_connect("/talk/feeder")
        await asyncio.wait_for(self.bridge_started.wait(), 2)
        owner = talk._sessions["feeder"]
        await self.finish(ws)
        self.assertTrue(owner.done())

    async def test_offline_device_rejected_before_encoder_start(self):
        with patch.object(devices, "is_online", return_value=False):
            response = await self.client.get("/talk/feeder")
        self.assertEqual(response.status, 409)
        self.assertFalse(talk._sessions)
        self.assertIsNone(self.encoder.returncode)

    async def test_auto_power_waits_for_delayed_registration(self):
        async def register():
            await asyncio.sleep(0.05)
            camera._registered_uids["feeder"] = "private-uid"
        cfg = {"feeder": {"device_type": "camera_feeder", "camera_power_with_live_view": True}}
        with patch.dict(camera._registered_uids, {}, clear=True), patch.object(
                storage, "get_devices", return_value=cfg):
            registering = asyncio.create_task(register())
            ws = await self.connect()
            await registering
            await self.finish(ws)

    async def test_enabled_camera_waits_for_delayed_registration(self):
        async def register():
            await asyncio.sleep(0.05)
            camera._registered_uids["feeder"] = "private-uid"
        with patch.dict(camera._registered_uids, {}, clear=True), patch.object(
                devices, "get_device_state", return_value={"cameraSwitch": True}):
            registering = asyncio.create_task(register())
            ws = await self.connect()
            await registering
            await self.finish(ws)

    async def test_disabled_camera_without_auto_power_rejects_immediately(self):
        with patch.dict(camera._registered_uids, {}, clear=True):
            async with asyncio.timeout(0.5):
                response = await self.client.get("/talk/feeder")
        self.assertEqual(response.status, 409)
        self.assertFalse(talk._sessions)
        self.assertIsNone(self.encoder.returncode)

    async def test_registration_wait_revalidates_device_online(self):
        cfg = {"feeder": {"device_type": "camera_feeder", "camera_power_with_live_view": True}}
        with patch.dict(camera._registered_uids, {}, clear=True), patch.object(
                storage, "get_devices", return_value=cfg), patch.object(
                devices, "is_online", side_effect=[True, False, False]):
            response = await self.client.get("/talk/feeder")
        self.assertEqual(response.status, 409)
        self.assertFalse(talk._sessions)
        self.assertIsNone(self.encoder.returncode)

    async def test_waiting_sockets_claim_registration_atomically(self):
        cfg = {"feeder": {"device_type": "camera_feeder", "camera_power_with_live_view": True}}
        with patch.dict(camera._registered_uids, {}, clear=True), patch.object(
                storage, "get_devices", return_value=cfg):
            async def connect_then_register():
                await asyncio.sleep(0.05)
                camera._registered_uids["feeder"] = "private-uid"
            registering = asyncio.create_task(connect_then_register())
            results = await asyncio.gather(
                self.client.ws_connect("/talk/feeder"),
                self.client.ws_connect("/talk/feeder"), return_exceptions=True,
            )
            await registering
            losers = [r for r in results if isinstance(r, aiohttp.WSServerHandshakeError)]
            winners = [r for r in results if isinstance(r, aiohttp.ClientWebSocketResponse)]
            self.assertEqual(len(losers), 1)
            self.assertEqual(losers[0].status, 409)
            self.assertEqual(len(winners), 1)
            self.assertEqual((await winners[0].receive_json(timeout=2))["type"], "ready")
            await self.finish(winners[0])

    async def test_browser_disconnect_releases_ownership(self):
        ws = await self.connect()
        owner = talk._sessions["feeder"]
        await ws.close()
        await asyncio.wait_for(asyncio.shield(owner), 2)
        self.assertFalse(talk._sessions)
        self.assertIsNotNone(self.encoder.returncode)

    async def test_setup_timeout_closes_process_and_socket(self):
        self.block_setup = True
        with patch.object(talk, "_SETUP_TIMEOUT", 0.1):
            ws = await self.client.ws_connect("/talk/feeder")
            message = await ws.receive_json(timeout=2)
            self.assertEqual(message["type"], "error")
            await ws.close()
        self.assertFalse(talk._sessions)
        self.assertIsNotNone(self.encoder.returncode)

    async def test_inactivity_timeout_stops_audio(self):
        with patch.object(talk, "_IDLE_TIMEOUT", 0.1):
            ws = await self.connect()
            owner = talk._sessions["feeder"]
            await ws.send_bytes(b"\x00\x00")
            self.assertEqual((await ws.receive_json(timeout=2))["type"], "error")
            await ws.close()
            await asyncio.wait_for(asyncio.shield(owner), 2)
        self.assertFalse(talk._sessions)

    async def test_max_duration_stops_audio(self):
        with patch.object(talk, "_MAX_DURATION", 0.1):
            ws = await self.connect()
            owner = talk._sessions["feeder"]
            self.assertEqual((await ws.receive_json(timeout=2))["type"], "error")
            await ws.close()
            await asyncio.wait_for(asyncio.shield(owner), 2)
        self.assertFalse(talk._sessions)


if __name__ == "__main__":
    unittest.main()
