"""Meal-call commands require device acknowledgement; clips retain their source."""

import asyncio
import ast
import importlib.util
import json
import logging
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
import wave
from unittest.mock import AsyncMock, Mock, patch

APP = Path(__file__).parents[1] / "addon/app"
spec = importlib.util.spec_from_file_location("feeding_audio_devices", APP / "devices.py")
devices = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"aiomqtt": Mock(), "ha_mqtt": Mock(), "device_types": Mock()}), \
        patch("logging.handlers.RotatingFileHandler", return_value=logging.NullHandler()):
    spec.loader.exec_module(devices)
spec = importlib.util.spec_from_file_location("feed_audio", APP / "feed_audio.py")
feed_audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feed_audio)


class FeedingAudioTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        devices._devices = {"feeder": ("PLAF203", "camera_feeder")}
        devices._online = {"feeder": True}
        devices._state.clear()
        devices._audio_urls.clear()
        devices._pending_audio_acks.clear()
        for name in ("_persist_state_cache", "_publish_ha_state", "_check_and_fire_alerts"):
            item = patch.object(devices, name, AsyncMock())
            item.start()
            self.addCleanup(item.stop)
        item = patch.object(devices, "_mark_online", Mock())
        item.start()
        self.addCleanup(item.stop)
        item = patch.object(devices, "FEEDING_AUDIO_ACK_TIMEOUT_SECS", 0.01)
        item.start()
        self.addCleanup(item.stop)

    def reply(self, serial, payload, code=0):
        devices._handle_message(serial, f"dl/PLAF203/{serial}/device/service/post", json.dumps({
            "cmd": "ATTR_SET_SERVICE", "msgId": payload["msgId"], "code": code,
        }))

    async def test_file_and_enable_flag_are_acknowledged_without_plan_repeat_field(self):
        async def send(serial, payload):
            self.assertNotIn("soundRepititions", payload)
            self.assertNotIn("audioTimes", payload)
            self.assertNotIn("enableAudio", devices._state.get(serial, {}))
            self.reply(serial, payload)
            return True
        url = "http://192.168.1.2:8765/audio/feeding/clip.aac"
        with patch.object(devices, "send_command", side_effect=send):
            await devices.set_feeding_audio("feeder", {"enableAudio": True, "audioUrl": url})
        self.assertTrue(devices._state["feeder"]["enableAudio"])
        self.assertNotIn("audioUrl", devices._state["feeder"])
        self.assertEqual(devices._audio_urls["feeder"], url)
        self.assertFalse(devices._pending_audio_acks)

    async def test_captured_sound_ack_without_code_is_accepted(self):
        captured = json.loads((Path(__file__).parent / "fixtures/plaf203_audio_ack.json").read_text())
        async def send(serial, payload):
            self.assertEqual(payload["msgId"], captured["msgId"])
            devices._handle_message(serial, f"dl/PLAF203/{serial}/device/service/post", json.dumps(captured))
            return True
        url = "http://192.168.2.200:8765/audio/feeding/clip.aac"
        with patch.object(devices.uuid, "uuid4", return_value=SimpleNamespace(hex=captured["msgId"])), \
                patch.object(devices, "send_command", side_effect=send):
            await devices.set_feeding_audio("feeder", {"audioUrl": url, "enableAudio": True})
        self.assertEqual(devices._audio_urls["feeder"], url)
        self.assertTrue(devices._state["feeder"]["enableAudio"])

    async def test_code_less_ack_requires_matching_id_and_device_reply_topic(self):
        async def send(serial, payload):
            for topic, msg_id in (
                (f"dl/PLAF203/{serial}/device/service/sub", payload["msgId"]),
                (f"dl/PLAF203/{serial}/device/service/post", "unrelated"),
            ):
                devices._handle_message(serial, topic, json.dumps({"cmd": "ATTR_SET_SERVICE", "msgId": msg_id}))
            return True
        with patch.object(devices, "send_command", side_effect=send):
            with self.assertRaisesRegex(RuntimeError, "did not acknowledge"):
                await devices.set_feeding_audio("feeder", {"enableAudio": True})
        self.assertNotIn("enableAudio", devices._state.get("feeder", {}))

    async def test_global_meal_call_can_be_enabled_without_changing_volume_or_hours(self):
        async def send(serial, payload):
            self.assertEqual(set(payload), {"enableAudio", "msgId"})
            self.reply(serial, payload)
            return True
        with patch.object(devices, "send_command", side_effect=send):
            await devices.handle_ha_command("feeder", {"enableAudio": True})
        self.assertTrue(devices._state["feeder"]["enableAudio"])

    async def test_rejection_wrong_device_timeout_and_publish_failure_do_not_save(self):
        for mode in ("reject", "wrong-device", "timeout", "publish-failure", "boolean-code", "null-code"):
            devices._state.clear()
            async def send(serial, payload):
                if mode == "reject":
                    self.reply(serial, payload, 1)
                elif mode == "boolean-code":
                    self.reply(serial, payload, True)
                elif mode == "null-code":
                    self.reply(serial, payload, None)
                elif mode == "wrong-device":
                    self.reply("other", payload)
                return mode != "publish-failure"
            with self.subTest(mode=mode), patch.object(devices, "send_command", side_effect=send):
                with self.assertRaises(RuntimeError):
                    await devices.set_feeding_audio("feeder", {"enableAudio": True})
            self.assertNotIn("enableAudio", devices._state.get("feeder", {}))
            self.assertFalse(devices._pending_audio_acks)

    async def test_invalid_flag_and_offline_feeder_never_publish(self):
        with patch.object(devices, "send_command", AsyncMock()) as send:
            for payload in ({"enableAudio": "true"}, {"enableAudio": True, "volume": 50}):
                with self.assertRaises(ValueError):
                    await devices.set_feeding_audio("feeder", payload)
            devices._online["feeder"] = False
            with self.assertRaises(RuntimeError):
                await devices.set_feeding_audio("feeder", {"enableAudio": True})
            send.assert_not_called()

    def test_unrelated_granary_setting_never_clears_the_private_audio_url(self):
        self.assertNotIn("audioUrl", devices._granary_settings_bundle("feeder", {"volume": 25}))
        devices._audio_urls["feeder"] = "http://local/audio/call.aac"
        bundle = devices._granary_settings_bundle("feeder", {"volume": 25})
        self.assertEqual(bundle["audioUrl"], "http://local/audio/call.aac")


class ClipPreparationTests(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(os.environ.get("FFMPEG_BINARY") or shutil.which("ffmpeg"), "FFmpeg not installed")
    async def test_real_encoder_converts_a_long_48khz_mono_clip_to_short_stereo_aac(self):
        executable = os.environ.get("FFMPEG_BINARY") or shutil.which("ffmpeg")
        execute = asyncio.create_subprocess_exec
        async def encode(command, *args, **kwargs):
            return await execute(executable, *args, **kwargs)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "long.wav"
            with wave.open(str(source), "wb") as recording:
                recording.setnchannels(1)
                recording.setsampwidth(2)
                recording.setframerate(48000)
                recording.writeframes(b"\0\0" * 48000 * 12)
            original_size = source.stat().st_size
            with patch.object(feed_audio.asyncio, "create_subprocess_exec", side_effect=encode):
                name = await feed_audio.prepare(str(source), str(Path(directory) / "feeding"))
            data = (Path(directory) / "feeding" / name).read_bytes()
            position = frames = 0
            while position < len(data):
                header = data[position:position + 7]
                self.assertEqual(header[0], 0xff)
                self.assertEqual(header[1] & 0xf6, 0xf0)
                self.assertEqual((header[2] >> 6) + 1, 2)  # AAC-LC
                self.assertEqual((header[2] >> 2) & 15, 4)  # 44.1 kHz
                self.assertEqual(((header[2] & 1) << 2) | (header[3] >> 6), 2)
                length = ((header[3] & 3) << 11) | (header[4] << 3) | (header[5] >> 5)
                self.assertGreaterEqual(length, 7)
                position += length
                frames += 1
            self.assertEqual(position, len(data))
            self.assertGreater(frames * 1024 / 44100, 9.9)
            self.assertLess(frames * 1024 / 44100, 10.1)
            self.assertEqual(source.stat().st_size, original_size)

    async def test_prepared_clip_is_cached_and_replacement_gets_a_new_url(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "original.aac"
            source.write_bytes(b"original long recording")
            cache = Path(directory) / "feeding"
            async def encode(*args, **kwargs):
                self.assertEqual(args[args.index("-t") + 1], "10")
                self.assertEqual(args[args.index("-ar") + 1], "44100")
                self.assertEqual(args[args.index("-ac") + 1], "2")
                self.assertEqual(args[args.index("-profile:a") + 1], "aac_low")
                self.assertEqual(args[args.index("-b:a") + 1], "128k")
                self.assertEqual(args[args.index("-f") + 1], "adts")
                Path(args[-1]).write_bytes(b"prepared AAC")
                return Mock(returncode=0, communicate=AsyncMock(return_value=(None, b"")))
            with patch.object(feed_audio.asyncio, "create_subprocess_exec", side_effect=encode) as process:
                first = await feed_audio.prepare(str(source), str(cache))
                self.assertEqual(first, await feed_audio.prepare(str(source), str(cache)))
                self.assertEqual(process.await_count, 1)
                self.assertEqual(source.read_bytes(), b"original long recording")
                source.write_bytes(b"replacement recording")
                second = await feed_audio.prepare(str(source), str(cache))
                self.assertNotEqual(first, second)
                self.assertEqual((cache / first).read_bytes(), b"prepared AAC")
                self.assertEqual((cache / second).read_bytes(), b"prepared AAC")
                self.assertFalse(list(cache.glob("*.tmp")))

    async def test_failed_encoder_leaves_no_partial_clip(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "bad.aac"
            source.write_bytes(b"broken")
            cache = Path(directory) / "feeding"
            process = Mock(returncode=1, communicate=AsyncMock(return_value=(None, b"invalid input")))
            with patch.object(feed_audio.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)):
                with self.assertRaises(ValueError):
                    await feed_audio.prepare(str(source), str(cache))
            self.assertFalse(list(cache.iterdir()))


class AudioApiTests(unittest.IsolatedAsyncioTestCase):
    def setup_api(self, functions):
        tree = ast.parse((APP / "main.py").read_text(encoding="utf-8"))
        nodes = [node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                 and node.name in functions]
        namespace = {
            "asyncio": asyncio, "os": Mock(path=Mock(exists=lambda path: path.startswith("/data/audio/"))),
            "storage": Mock(get_settings=lambda: {"local_audio_base_url": "http://192.168.1.2:8765"},
                            get_devices=lambda: {"feeder": {"device_type": "camera_feeder"}}),
            "devices": Mock(set_feeding_audio=AsyncMock()),
            "feed_audio": Mock(prepare=AsyncMock(return_value="prepared.aac"),
                               check_download=AsyncMock()),
            "_AUDIO_NAME_RE": __import__("re").compile(r"^[a-z0-9_-]{1,40}$"),
            "_LOGGER": Mock(),
            "web": SimpleNamespace(json_response=lambda value: value,
                                   Response=lambda **values: values,
                                   FileResponse=lambda path, **values: {"path": path, **values}),
        }
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "main.py", "exec"), namespace)
        return namespace

    async def test_push_uses_prepared_clip_and_surfaces_device_rejection(self):
        api = self.setup_api({"handle_api_device_push_audio"})
        request = SimpleNamespace(match_info={"serial": "feeder"},
                                  json=AsyncMock(return_value={"name": "breakfast"}))
        result = await api["handle_api_device_push_audio"](request)
        self.assertEqual(result["audio_url"], "http://192.168.1.2:8765/audio/feeding/prepared.aac")
        api["feed_audio"].prepare.assert_awaited_once_with("/data/audio/breakfast.aac")
        api["devices"].set_feeding_audio.assert_awaited_once_with("feeder", {
            "audioUrl": result["audio_url"], "enableAudio": True,
        }, repetitions=1)
        api["devices"].set_feeding_audio.side_effect = RuntimeError("Feeder rejected the feeding sound")
        result = await api["handle_api_device_push_audio"](request)
        self.assertEqual(result["status"], 400)
        self.assertIn("rejected", result["text"])

    async def test_prepared_download_route_serves_cache_without_changing_library_route(self):
        api = self.setup_api({"handle_audio_serve"})
        request = SimpleNamespace(match_info={"name": "prepared.aac"},
                                  path="/audio/feeding/prepared.aac", remote="192.168.1.3")
        result = await api["handle_audio_serve"](request)
        self.assertEqual(result["path"], "/data/audio/feeding/prepared.aac")
        self.assertEqual(result["headers"]["Content-Type"], "audio/aac")
        request.path = "/audio/prepared.aac"
        result = await api["handle_audio_serve"](request)
        self.assertEqual(result["path"], "/data/audio/prepared.aac")


if __name__ == "__main__":
    unittest.main()
