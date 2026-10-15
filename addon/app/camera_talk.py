"""Bounded browser PCM microphone relay to the local camera talkback bridge."""

import asyncio
import json
import logging

import aiohttp
from aiohttp import web

import camera
import devices
import storage

_LOGGER = logging.getLogger(__name__)
_MAX_PCM_BYTES = 32768
_SETUP_TIMEOUT = 15
_IDLE_TIMEOUT = 5
_MAX_DURATION = 120
_REGISTRATION_TIMEOUT = 5
_sessions: dict[str, asyncio.Task] = {}


def _unavailable(serial):
    cfg = storage.get_devices().get(serial)
    if not cfg or cfg.get("device_type") != "camera_feeder":
        return 404, "Camera feeder not found"
    if not devices.is_online(serial):
        return 409, "Feeder is offline"
    if not camera._SERIAL_RE.fullmatch(serial):
        return 400, "Invalid device identifier"
    if (serial not in camera._registered_uids or camera._bridge_process is None
            or camera._bridge_process.returncode is not None):
        return 409, "Enable the camera and wait for it to connect before speaking"
    if serial in _sessions:
        return 409, "Another microphone session is already active"
    return None


def _awaiting_registration(serial):
    """A power-on command can precede asynchronous camera UID registration."""
    cfg = storage.get_devices().get(serial, {})
    if (cfg.get("device_type") != "camera_feeder"
            or not camera._SERIAL_RE.fullmatch(serial)
            or not devices.is_online(serial)
            or serial in _sessions
            or serial in camera._registered_uids
            or camera._bridge_process is None
            or camera._bridge_process.returncode is not None):
        return False
    state = devices.get_device_state(serial)
    return bool(cfg.get("camera_power_with_live_view") or
                state.get("cameraSwitch", state.get("enableCamera", False)))


async def stop_device(serial):
    """Only internal lifecycle events can cancel a different socket's owner."""
    task = _sessions.get(serial)
    if task is not None and task is not asyncio.current_task():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def stop_all():
    for serial in list(_sessions):
        await stop_device(serial)


async def on_shutdown(app):
    await stop_all()


async def _drain_stderr(stream):
    # Drain continuously without retaining microphone data or unbounded logs.
    while await stream.read(4096):
        pass


async def handle_talk(request):
    """Binary messages are LE mono PCM16 at 44100 Hz; text accepts only stop."""
    serial = request.match_info["serial"]
    deadline = asyncio.get_running_loop().time() + _REGISTRATION_TIMEOUT
    while _awaiting_registration(serial) and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.1)
    # Revalidate every constraint after waiting, then claim without an await.
    problem = _unavailable(serial)
    if problem:
        status, message = problem
        return web.json_response({"error": message}, status=status)

    # A competing socket can never steal ownership between validation and claim.
    owner = asyncio.current_task()
    _sessions[serial] = owner
    ws = web.WebSocketResponse(max_msg_size=_MAX_PCM_BYTES, heartbeat=15, timeout=1)
    proc = None
    tasks = []
    ready = asyncio.Event()
    try:
        await ws.prepare(request)
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "s16le", "-ar", "44100", "-ac", "1",
            "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0",
            "-vn", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "64k",
            "-ar", "44100", "-ac", "1", "-flush_packets", "1",
            "-f", "adts", "pipe:1",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        tasks.append(asyncio.create_task(_drain_stderr(proc.stderr)))

        async def encoded_audio():
            # Flush HTTP headers before microphone frames exist. Recent
            # aiohttp buffers headers until the first payload write; an empty
            # write sends headers without an ADTS frame or chunk terminator.
            yield b""
            while chunk := await proc.stdout.read(4096):
                yield chunk

        async def relay():
            # A separate session avoids the snapshot client's five-second limit.
            timeout = aiohttp.ClientTimeout(total=None, sock_connect=5)
            async with aiohttp.ClientSession(timeout=timeout) as http:
                async with asyncio.timeout(_SETUP_TIMEOUT):
                    response = await http.post(
                        f"{camera._BRIDGE_API}/devices/{serial}/talkback",
                        data=encoded_audio(), headers={"Content-Type": "audio/aac"},
                    )
                try:
                    if response.status != 200:
                        raise RuntimeError("Speaker connection could not start")
                    await ws.send_json({"type": "ready", "sampleRate": 44100,
                                        "channels": 1, "format": "pcm_s16le"})
                    ready.set()
                    # The bridge closes its response on device failure. Do not
                    # retain or forward untrusted bridge diagnostics to clients.
                    await response.content.read(1)
                    raise RuntimeError("Speaker connection ended")
                finally:
                    response.close()

        async def receive():
            async for message in _messages(ws, ready):
                if message.type == aiohttp.WSMsgType.BINARY:
                    if not ready.is_set():
                        raise ValueError("Wait for the speaker before sending audio")
                    data = message.data
                    if not data or len(data) % 2 or len(data) > _MAX_PCM_BYTES:
                        raise ValueError("Invalid microphone audio")
                    if not devices.is_online(serial):
                        raise RuntimeError("Feeder is offline")
                    proc.stdin.write(data)
                    await asyncio.wait_for(proc.stdin.drain(), _IDLE_TIMEOUT)
                elif message.type == aiohttp.WSMsgType.TEXT:
                    try:
                        command = json.loads(message.data)
                    except (ValueError, TypeError):
                        raise ValueError("Invalid microphone command") from None
                    if not isinstance(command, dict) or command.get("type") != "stop":
                        raise ValueError("Invalid microphone command")
                    return
                elif message.type == aiohttp.WSMsgType.ERROR:
                    raise RuntimeError("Microphone connection failed")

        relay_task = asyncio.create_task(relay())
        receive_task = asyncio.create_task(receive())
        process_task = asyncio.create_task(proc.wait())
        tasks.extend([relay_task, receive_task, process_task])
        done, _ = await asyncio.wait(
            [relay_task, receive_task, process_task],
            timeout=_MAX_DURATION, return_when=asyncio.FIRST_COMPLETED,
        )
        if not done:
            raise TimeoutError("Microphone session reached its time limit")
        for task in done:
            task.result()
        if process_task in done and receive_task not in done:
            raise RuntimeError("Microphone encoder ended")
    except asyncio.CancelledError:
        pass
    except Exception as error:
        # Never expose process output, credentials, UID or internal addresses.
        message = str(error) if isinstance(error, ValueError) else "Speaker connection failed or timed out"
        _LOGGER.warning("Microphone relay failed for %s... (%s)", serial[:6], type(error).__name__)
        if ws.prepared and not ws.closed:
            try:
                await ws.send_json({"type": "error", "message": message})
            except (ConnectionError, RuntimeError):
                pass
    finally:
        for task in tasks:
            task.cancel()
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        await asyncio.gather(*tasks, return_exceptions=True)
        if proc is not None:
            await proc.wait()
        if _sessions.get(serial) is owner:
            _sessions.pop(serial, None)
        if ws.prepared:
            await ws.close()
    return ws


async def _messages(ws, ready):
    while True:
        message = await asyncio.wait_for(
            ws.receive(), _IDLE_TIMEOUT if ready.is_set() else _SETUP_TIMEOUT,
        )
        if message.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED,
                            aiohttp.WSMsgType.CLOSING):
            return
        yield message
