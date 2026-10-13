"""PLAF203 direct-LAN camera bridge and Home Assistant snapshot publisher."""

import asyncio
import logging
import os
import re

import aiohttp

_LOGGER = logging.getLogger(__name__)

_BRIDGE_API = "http://127.0.0.1:8081"
_RTSP_URL = "rtsp://127.0.0.1:8554/device/{serial}"
_SNAPSHOT_INTERVAL_SECS = 5
_STREAM_READ_TIMEOUT_SECS = 25
_MAX_JPEG_BYTES = 2 * 1024 * 1024
_SERIAL_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_UID_RE = re.compile(r"^[!-~]{20}$")

_http: aiohttp.ClientSession | None = None
_bridge_process: asyncio.subprocess.Process | None = None
_tasks: dict[str, asyncio.Task] = {}
_registered_uids: dict[str, str] = {}
_camera_available: dict[str, bool] = {}


async def start_bridge() -> bool:
    """Start the pinned camera bridge, bound to loopback only."""
    global _http, _bridge_process
    if _http is None or _http.closed:
        _http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5))
    if _bridge_process is None or _bridge_process.returncode is not None:
        try:
            _bridge_process = await asyncio.create_subprocess_exec(
                "/usr/local/bin/petlibro-camera-bridge",
                env={
                    **os.environ,
                    "CAMERA_BRIDGE_LISTEN_ADDR": "127.0.0.1:8081",
                    "PETLIBRO_CAMERA_MEDIA_RTSP_LISTEN_ADDR": "127.0.0.1:8554",
                    "PETLIBRO_CAMERA_IDLE_TIMEOUT_SECONDS": "10",
                    "PETLIBRO_CAMERA_DISCOVERY_BROADCAST_FALLBACK": "true",
                },
            )
        except Exception:
            _LOGGER.exception("Could not start PLAF203 camera bridge")
            return False

    for _ in range(20):
        if _bridge_process.returncode is not None:
            _LOGGER.error("PLAF203 camera bridge exited with status %s", _bridge_process.returncode)
            return False
        try:
            async with _http.get(f"{_BRIDGE_API}/healthz") as response:
                if response.status == 200:
                    _LOGGER.info("PLAF203 direct-LAN camera bridge ready")
                    return True
        except (aiohttp.ClientError, asyncio.TimeoutError):
            pass
        await asyncio.sleep(0.25)
    _LOGGER.error("PLAF203 camera bridge did not become healthy")
    return False


async def stop_bridge() -> None:
    """Stop snapshot tasks and the bridge during add-on shutdown."""
    global _http, _bridge_process
    for serial in list(_tasks):
        await stop_device(serial)
    _registered_uids.clear()
    if _bridge_process and _bridge_process.returncode is None:
        _bridge_process.terminate()
        try:
            await asyncio.wait_for(_bridge_process.wait(), timeout=5)
        except asyncio.TimeoutError:
            _bridge_process.kill()
            await _bridge_process.wait()
    _bridge_process = None
    if _http and not _http.closed:
        await _http.close()
    _http = None


async def update_device(serial: str, uid: str, enabled: bool) -> None:
    """Register a camera UID and start or stop its on-demand snapshot loop."""
    if not _SERIAL_RE.fullmatch(serial) or not _UID_RE.fullmatch(uid):
        _LOGGER.warning("Ignoring invalid PLAF203 camera identity for %s...", serial[:6])
        return
    if not enabled:
        await stop_device(serial)
        return
    if _http is None or _bridge_process is None or _bridge_process.returncode is not None:
        _LOGGER.warning("Camera for %s... is enabled but the bridge is unavailable", serial[:6])
        return

    if _registered_uids.get(serial) != uid:
        try:
            async with _http.put(
                f"{_BRIDGE_API}/devices/{serial}", json={"uid": uid}
            ) as response:
                if response.status != 200:
                    detail = await response.text()
                    raise RuntimeError(f"bridge registration returned {response.status}: {detail[:160]}")
            _registered_uids[serial] = uid
        except Exception:
            _LOGGER.exception("Could not register camera UID for %s...", serial[:6])
            return

    task = _tasks.get(serial)
    if task is None or task.done():
        _LOGGER.info("Starting HA camera snapshots for %s...", serial[:6])
        _tasks[serial] = asyncio.create_task(_snapshot_loop(serial), name=f"camera-{serial}")


async def stop_device(serial: str) -> None:
    task = _tasks.pop(serial, None)
    if task:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    _registered_uids.pop(serial, None)
    await _set_available(serial, False)
    if _http and not _http.closed:
        try:
            async with _http.delete(f"{_BRIDGE_API}/devices/{serial}"):
                pass
        except aiohttp.ClientError:
            pass


async def _snapshot_loop(serial: str) -> None:
    failures = 0
    try:
        while True:
            process = None
            stderr_task = None
            try:
                process = await asyncio.create_subprocess_exec(
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                    "-rtsp_transport", "tcp", "-i", _RTSP_URL.format(serial=serial),
                    "-an", "-vf", f"fps=1/{_SNAPSHOT_INTERVAL_SECS},scale='min(640,iw)':-2",
                    "-q:v", "6", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stderr_task = asyncio.create_task(_drain_stderr(process.stderr))
                async for image in _jpeg_frames(process.stdout):
                    failures = 0
                    try:
                        import devices
                        published = await devices.publish_camera_image(serial, image)
                        if published:
                            await _set_available(serial, True)
                    except Exception:
                        _LOGGER.exception("Could not publish HA camera image for %s...", serial[:6])
                failures += 1
                _LOGGER.warning("Camera RTSP stream ended for %s... (%d consecutive)", serial[:6], failures)
            except asyncio.CancelledError:
                raise
            except Exception:
                failures += 1
                _LOGGER.warning("Camera RTSP stream failed for %s... (%d consecutive)", serial[:6], failures, exc_info=True)
            finally:
                if process is not None and process.returncode is None:
                    process.kill()
                    await process.wait()
                if stderr_task:
                    stderr_task.cancel()
                    await asyncio.gather(stderr_task, return_exceptions=True)
            if failures >= 3:
                await _set_available(serial, False)
            await asyncio.sleep(min(5 * failures, 30))
    except asyncio.CancelledError:
        raise
    except Exception:
        _LOGGER.exception("HA camera snapshot loop failed for %s...", serial[:6])
    finally:
        await _set_available(serial, False)
        _tasks.pop(serial, None)


async def _drain_stderr(stream) -> None:
    if stream is None:
        return
    while await stream.read(4096):
        pass


async def _jpeg_frames(stream):
    """Yield complete JPEG frames from FFmpeg's concatenated image2pipe output."""
    pending = bytearray()
    while True:
        chunk = await asyncio.wait_for(
            stream.read(64 * 1024), timeout=_STREAM_READ_TIMEOUT_SECS
        )
        if not chunk:
            return
        pending.extend(chunk)
        while True:
            start = pending.find(b"\xff\xd8")
            if start < 0:
                if len(pending) > 1:
                    del pending[:-1]
                break
            if start:
                del pending[:start]
            end = pending.find(b"\xff\xd9", 2)
            if end < 0:
                if len(pending) > _MAX_JPEG_BYTES:
                    raise ValueError("FFmpeg produced an oversized JPEG frame")
                break
            frame_end = end + 2
            if frame_end > _MAX_JPEG_BYTES:
                raise ValueError("FFmpeg produced an oversized JPEG frame")
            frame = bytes(pending[:frame_end])
            del pending[:frame_end]
            yield frame


async def _set_available(serial: str, available: bool) -> None:
    if _camera_available.get(serial) is available:
        return
    try:
        import devices
        published = await devices.publish_camera_availability(serial, available)
    except Exception:
        _LOGGER.debug("Camera availability publish failed for %s...", serial[:6], exc_info=True)
        return
    if published:
        _camera_available[serial] = available