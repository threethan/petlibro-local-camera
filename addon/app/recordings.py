"""Ingress-only SD recording browser backed by the local PLAF203 bridge."""

import asyncio
import logging

import aiohttp
from aiohttp import web

import camera
import devices
import storage

_LOGGER = logging.getLogger(__name__)
_viewers: dict[str, asyncio.Task] = {}
_MAX_TIME = 0x7FFFFFFF  # The Android plugin passes signed 32-bit Unix seconds.


def _integer(query, key, default=None, maximum=_MAX_TIME):
    value = query.get(key, default)
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(text=f"Invalid {key}") from None
    if str(number) != str(value) or not 0 <= number <= maximum:
        raise web.HTTPBadRequest(text=f"Invalid {key}")
    return number


def _check_device(serial):
    cfg = storage.get_devices().get(serial)
    if not cfg or cfg.get("device_type") != "camera_feeder":
        raise web.HTTPNotFound(text="Camera feeder not found")
    if not devices.is_online(serial):
        raise web.HTTPConflict(text="Feeder is offline")
    if not camera._SERIAL_RE.fullmatch(serial):
        raise web.HTTPBadRequest(text="Invalid device identifier")
    if (serial not in camera._registered_uids or camera._bridge_process is None
            or camera._bridge_process.returncode is not None):
        raise web.HTTPConflict(text="Enable the camera and wait for it to connect")


async def _ready(serial):
    # Camera-power commands may complete before the UID registration callback.
    deadline = asyncio.get_running_loop().time() + 5
    while serial not in camera._registered_uids:
        cfg = storage.get_devices().get(serial, {})
        state = devices.get_device_state(serial)
        if (cfg.get("device_type") != "camera_feeder" or not devices.is_online(serial)
                or not (cfg.get("camera_power_with_live_view")
                        or state.get("cameraSwitch", state.get("enableCamera", False)))
                or asyncio.get_running_loop().time() >= deadline):
            break
        await asyncio.sleep(0.1)
    _check_device(serial)


def _bridge_failure(status):
    if status == 400:
        return web.HTTPBadRequest(text="Invalid recording or seek position")
    if status == 404:
        return web.HTTPNotFound(text="Recording or camera not found")
    if status == 409:
        return web.HTTPConflict(text="The camera is busy. Stop other playback and retry")
    if status == 504:
        return web.HTTPGatewayTimeout(text="The SD card did not respond. Retry when the camera is connected")
    return web.HTTPBadGateway(text="The camera could not read this SD recording")


async def handle_list(request):
    serial = request.match_info["serial"]
    start = _integer(request.query, "start")
    end = _integer(request.query, "end")
    if start <= 0 or not start < end <= start + 26 * 3600:
        raise web.HTTPBadRequest(text="Choose a single calendar day")
    await _ready(serial)
    try:
        timeout = aiohttp.ClientTimeout(total=25, sock_connect=5)
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.get(
                f"{camera._BRIDGE_API}/devices/{serial}/recordings",
                params={"start": str(start), "end": str(end - 1)},
            ) as response:
                if response.status != 200:
                    raise _bridge_failure(response.status)
                data = await response.json()
        # An incomplete enumeration must never masquerade as an empty card.
        if not isinstance(data, dict) or data.get("complete") is not True or not isinstance(data.get("recordings"), list):
            raise web.HTTPBadGateway(text="The camera returned an incomplete recording list")
        return web.json_response(data, headers={"Cache-Control": "no-store"})
    except (aiohttp.ClientError, ValueError) as error:
        _LOGGER.warning("SD recording list failed: %s", type(error).__name__)
        raise web.HTTPBadGateway(text="Could not read the SD recording list") from None
    except TimeoutError:
        raise web.HTTPGatewayTimeout(text="The SD card did not respond") from None


async def stop_device(serial):
    task = _viewers.get(serial)
    if task and task is not asyncio.current_task():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def handle_delete(request):
    serial = request.match_info["serial"]
    start = _integer(request.match_info, "start")
    if start <= 0:
        raise web.HTTPBadRequest(text="Invalid recording start")
    await _ready(serial)
    if serial in _viewers:
        raise web.HTTPConflict(text="Stop playback before deleting a recording")
    try:
        timeout = aiohttp.ClientTimeout(total=30, sock_connect=5)
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.delete(f"{camera._BRIDGE_API}/devices/{serial}/recordings/{start}") as response:
                if response.status != 200:
                    raise _bridge_failure(response.status)
                data = await response.json()
        if not isinstance(data, dict) or data.get("deleted") != start:
            raise web.HTTPBadGateway(text="The device did not confirm deletion")
        return web.json_response({"deleted": start}, headers={"Cache-Control": "no-store"})
    except (aiohttp.ClientError, ValueError):
        raise web.HTTPBadGateway(text="Could not confirm recording deletion") from None
    except TimeoutError:
        raise web.HTTPGatewayTimeout(text="Deletion was not confirmed. Refresh recordings before retrying") from None


async def stop_all():
    for serial in list(_viewers):
        await stop_device(serial)


async def on_shutdown(app):
    await stop_all()


async def handle_video(request):
    """Transcode a historical stream to bounded, browser-compatible fMP4."""
    serial = request.match_info["serial"]
    start = _integer(request.query, "start")
    offset = _integer(request.query, "offset", 0, maximum=86400)
    if start <= 0:
        raise web.HTTPBadRequest(text="Invalid recording start")
    await _ready(serial)
    if serial in _viewers:
        raise web.HTTPConflict(text="Another recording is playing on this camera")
    owner = asyncio.current_task()
    _viewers[serial] = owner
    process = None
    tasks = []
    prepared = False
    try:
        async def watch_disconnect():
            while request.transport and not request.transport.is_closing():
                await asyncio.sleep(0.25)
            owner.cancel()

        tasks.append(asyncio.create_task(watch_disconnect()))
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=5, sock_read=45)
        async with aiohttp.ClientSession(timeout=timeout) as http:
            async with http.get(
                f"{camera._BRIDGE_API}/devices/{serial}/recordings/stream",
                params={"start": str(start), "offset": str(offset), "format": "mpegts"},
            ) as upstream:
                if upstream.status != 200:
                    raise _bridge_failure(upstream.status)
                process = await asyncio.create_subprocess_exec(
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                    "-fflags", "+genpts", "-f", "mpegts", "-i", "pipe:0",
                    "-map", "0:v:0", "-map", "0:a:0?",
                    "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "96k",
                    "-vf", "scale='min(1280,iw)':-2",
                    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                    "-profile:v", "baseline", "-level:v", "3.1", "-pix_fmt", "yuv420p",
                    "-g", "15", "-bf", "0", "-sc_threshold", "0",
                    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
                    "-f", "mp4", "pipe:1",
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )

                async def feed():
                    try:
                        async for chunk in upstream.content.iter_chunked(65536):
                            process.stdin.write(chunk)
                            await process.stdin.drain()
                    finally:
                        process.stdin.close()

                async def drain_errors():
                    while await process.stderr.read(4096):
                        pass

                tasks = [asyncio.create_task(feed()), asyncio.create_task(drain_errors()), *tasks]
                first = await asyncio.wait_for(process.stdout.read(65536), 25)
                if not first:
                    raise web.HTTPBadGateway(text="This recording contains no playable video")
                response = web.StreamResponse(headers={
                    "Content-Type": "video/mp4", "Cache-Control": "no-store",
                    "X-Accel-Buffering": "no",
                })
                await response.prepare(request)
                prepared = True
                await response.write(first)
                while chunk := await asyncio.wait_for(process.stdout.read(65536), 25):
                    await response.write(chunk)
                await tasks[0]  # Propagate a truncated upstream stream.
                await process.wait()
                if process.returncode != 0:
                    raise RuntimeError("Recording decoder failed")
                await response.write_eof()
                return response
    except (ConnectionResetError, BrokenPipeError):
        if prepared:
            return response
        raise web.HTTPBadGateway(text="The recording connection ended") from None
    except (aiohttp.ClientError, TimeoutError, OSError, RuntimeError) as error:
        _LOGGER.warning("SD recording playback failed: %s", type(error).__name__)
        if prepared:
            if request.transport:
                request.transport.close()
            return response
        raise web.HTTPBadGateway(text="SD recording playback could not start") from None
    finally:
        for task in tasks:
            task.cancel()
        if process and process.returncode is None:
            process.kill()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if process:
            await process.wait()
        if _viewers.get(serial) is owner:
            _viewers.pop(serial, None)
