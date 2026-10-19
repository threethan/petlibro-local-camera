"""PLAF203 direct-LAN camera bridge and Home Assistant snapshot publisher."""

import asyncio
import logging
import os
import re
from urllib.parse import quote, urlencode

import aiohttp

_LOGGER = logging.getLogger(__name__)

_BRIDGE_API = "http://127.0.0.1:8081"
_RTSP_URL = "rtsp://127.0.0.1:8554/device/{serial}"
_GO2RTC_API = "http://127.0.0.1:11984"
_HA_RTSP_HOST = "172.30.32.1"
_HA_RTSP_PORT = 18556
_INTERNAL_RTSP_HOST = "127.0.0.1"
_INTERNAL_RTSP_PORT = 18556
_GO2RTC_WEBRTC = f"{_GO2RTC_API}/api/webrtc?src={{serial}}"
_SNAPSHOT_INTERVAL_SECS = 5
_SNAPSHOTS_ENABLED = False
_STREAM_READ_TIMEOUT_SECS = 25
_MAX_JPEG_BYTES = 2 * 1024 * 1024
_SERIAL_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_UID_RE = re.compile(r"^[!-~]{20}$")

_http: aiohttp.ClientSession | None = None
_bridge_process: asyncio.subprocess.Process | None = None
_tasks: dict[str, asyncio.Task] = {}
_keep_open_tasks: dict[str, asyncio.Task] = {}
_snapshots: dict[str, bytes] = {}
_registered_uids: dict[str, str] = {}
_live_exposed: set[str] = set()
_camera_available: dict[str, bool] = {}
_snapshot_available: dict[str, bool] = {}
_live_available: dict[str, bool] = {}
_stream_sources: dict[str, tuple[str, ...]] = {}
_stream_locks: dict[str, asyncio.Lock] = {}
_live_serial: str | None = None
_live_process: asyncio.subprocess.Process | None = None
_go2rtc_process: asyncio.subprocess.Process | None = None
_ha_rtsp_server: asyncio.Server | None = None
_ha_rtsp_tasks: set[asyncio.Task] = set()
_ha_rtsp_lock = asyncio.Lock()
_webrtc_sessions: dict[str, str] = {}


def live_stream_available(serial: str) -> bool:
    """Return whether this feeder is registered and the single live slot is free."""
    return bool(
        _SERIAL_RE.fullmatch(serial)
        and serial in _registered_uids
        and _bridge_process is not None
        and _bridge_process.returncode is None
        and _live_serial is None
    )


def latest_snapshot(serial: str) -> bytes | None:
    """Return the most recent JPEG emitted for HA, if one is available."""
    return _snapshots.get(serial)


def _vp8_transcode_source(raw_source: str) -> str:
    """Use go2rtc's FFmpeg templates to publish a VP8 RTSP producer."""
    return f"ffmpeg:{raw_source}#input=vp8input#video=vp8"


def _live_stream_sources(serial: str, vp8_enabled: bool) -> list[str]:
    stream_name = f"plaf203_{serial}"
    raw_source = _RTSP_URL.format(serial=serial)
    sources = [_vp8_transcode_source(raw_source)] if vp8_enabled else []
    sources.extend((raw_source, f"ffmpeg:{stream_name}#audio=opus"))
    return sources


async def live_frames(serial: str):
    """Yield low-rate JPEG frames for one explicitly requested live viewer."""
    global _live_serial, _live_process
    if not live_stream_available(serial):
        raise RuntimeError("Camera is not registered or the live viewer is busy")
    _live_serial = serial
    process = None
    stderr_task = None
    stderr_tail = bytearray()
    try:
        process = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-rtsp_transport", "tcp", "-i", _RTSP_URL.format(serial=serial),
            "-an", "-vf", "fps=8,scale='min(960,iw)':-2", "-q:v", "7",
            "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _live_process = process
        stderr_task = asyncio.create_task(_drain_stderr(process.stderr, stderr_tail))
        async for frame in _jpeg_frames(process.stdout):
            yield frame
        await process.wait()
        if stderr_task:
            await stderr_task
            stderr_task = None
        detail = stderr_tail.decode("utf-8", errors="replace").strip()[-1000:]
        raise RuntimeError(f"FFmpeg stream ended ({process.returncode}): {detail or 'no diagnostic output'}")
    finally:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        if stderr_task:
            stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
        _live_process = None
        _live_serial = None


async def live_video_chunks(serial: str):
    """Yield fragmented H.264/AAC MP4 for one temporary ingress viewer."""
    global _live_serial, _live_process
    if not live_stream_available(serial):
        raise RuntimeError("Camera is not registered or the live viewer is busy")
    _live_serial = serial
    process = None
    stderr_task = None
    stderr_tail = bytearray()
    try:
        process = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-rtsp_transport", "tcp", "-i", _RTSP_URL.format(serial=serial),
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "fps=15,scale='min(960,iw)':-2",
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
            "-profile:v", "baseline", "-level:v", "3.1", "-pix_fmt", "yuv420p",
            "-g", "15", "-bf", "0", "-sc_threshold", "0",
            "-c:a", "aac", "-profile:a", "aac_low", "-ar", "44100",
            "-ac", "1", "-b:a", "64k",
            "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
            "-f", "mp4", "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _live_process = process
        stderr_task = asyncio.create_task(_drain_stderr(process.stderr, stderr_tail))
        while chunk := await asyncio.wait_for(
            process.stdout.read(64 * 1024), timeout=_STREAM_READ_TIMEOUT_SECS
        ):
            yield chunk
        await process.wait()
        if stderr_task:
            await stderr_task
            stderr_task = None
        detail = stderr_tail.decode("utf-8", errors="replace").strip()[-1000:]
        raise RuntimeError(f"FFmpeg stream ended ({process.returncode}): {detail or 'no diagnostic output'}")
    finally:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        if stderr_task:
            stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
        _live_process = None
        _live_serial = None


async def start_bridge() -> bool:
    """Start the pinned camera bridge, bound to loopback only."""
    import storage

    global _http, _bridge_process, _go2rtc_process
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
                    "PETLIBRO_CAMERA_H264_STARTUP_FIX": "true" if storage.get_settings().get("camera_h264_startup_fix", True) is True else "false",
                    "PETLIBRO_CAMERA_DISCOVERY_BROADCAST_FALLBACK": "true",
                },
            )
        except Exception:
            _LOGGER.exception("Could not start PLAF203 camera bridge")
            return False

    try:
        await _start_go2rtc()
    except Exception:
        _LOGGER.exception("Could not start go2rtc WebRTC server")

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


async def _forward_ha_rtsp(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Relay a Home Assistant client to go2rtc's private RTSP listener."""
    task = asyncio.current_task()
    _ha_rtsp_tasks.add(task)
    upstream_writer = None
    pumps = []

    async def copy(source, destination):
        while data := await source.read(65536):
            destination.write(data)
            await destination.drain()

    try:
        upstream_reader, upstream_writer = await asyncio.wait_for(
            asyncio.open_connection(_INTERNAL_RTSP_HOST, _INTERNAL_RTSP_PORT), timeout=5,
        )
        pumps = [
            asyncio.create_task(copy(reader, upstream_writer)),
            asyncio.create_task(copy(upstream_reader, writer)),
        ]
        await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
    except (OSError, asyncio.TimeoutError):
        _LOGGER.warning("Could not connect HA camera relay to go2rtc", exc_info=True)
    finally:
        for pump in pumps:
            pump.cancel()
        await asyncio.gather(*pumps, return_exceptions=True)
        writers = [writer] + ([upstream_writer] if upstream_writer is not None else [])
        for connection in writers:
            connection.close()
        await asyncio.gather(*(connection.wait_closed() for connection in writers), return_exceptions=True)
        _ha_rtsp_tasks.discard(task)


async def _start_ha_rtsp() -> None:
    global _ha_rtsp_server
    if _ha_rtsp_server is None:
        _ha_rtsp_server = await asyncio.start_server(_forward_ha_rtsp, _HA_RTSP_HOST, _HA_RTSP_PORT)
        _LOGGER.info("Home Assistant camera relay started")


async def _stop_ha_rtsp() -> None:
    global _ha_rtsp_server
    server = _ha_rtsp_server
    _ha_rtsp_server = None
    if server is not None:
        server.close()
    tasks = list(_ha_rtsp_tasks)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    if server is not None:
        await server.wait_closed()
        _LOGGER.info("Home Assistant camera relay stopped")


async def _start_go2rtc() -> None:
    global _go2rtc_process
    # App viewers, FFmpeg callbacks and background consumers stay on loopback.
    # The separate Supervisor-facing relay exists only for exposed cameras.
    if _go2rtc_process is not None and _go2rtc_process.returncode is None:
        return
    config = "/data/go2rtc.yaml"
    with open(config, "w", encoding="utf-8") as stream:
        stream.write(
            'api:\n'
            '  listen: "127.0.0.1:11984"\n'
            'rtsp:\n'
            '  listen: "127.0.0.1:18556"\n'
            'webrtc:\n'
            '  listen: ":18555"\n'
            'ffmpeg:\n'
            # The bridge can be probed as 90,000 fps (its RTP clock rate).
            # Bound the encoder cadence explicitly so FFmpeg cannot duplicate
            # the first decoded image at that rate and fall behind live video.
            '  vp8: "-r 15 -fps_mode cfr -c:v libvpx -deadline realtime -cpu-used 8 -lag-in-frames 0 -auto-alt-ref 0 -error-resilient 1 -g 15 -keyint_min 15 -b:v 1200k -pix_fmt yuv420p"\n'
            # Keep FFmpeg's RTSP probe buffer enabled for transcoding:
            # nobuffer can discard the first fresh IDR's SPS/PPS before the
            # decoder has configured itself.
            '  vp8input: "-flags low_delay -timeout {timeout} -user_agent go2rtc/ffmpeg -rtsp_flags prefer_tcp -analyzeduration 1000000 -probesize 1000000 -i {input}"\n'
            'streams: {}\n'
        )
    _go2rtc_process = await asyncio.create_subprocess_exec(
        "/usr/local/bin/go2rtc", "-config", config,
    )
    for _ in range(40):
        if _go2rtc_process.returncode is not None:
            raise RuntimeError("go2rtc exited during startup")
        try:
            async with _http.get(f"{_GO2RTC_API}/api/streams") as response:
                if response.status == 200:
                    return
        except (aiohttp.ClientError, asyncio.TimeoutError):
            pass
        await asyncio.sleep(0.25)
    raise RuntimeError("go2rtc did not become healthy")


async def _ensure_live_stream(serial: str) -> str:
    """Reuse running producers; PUT replaces a go2rtc stream and makes it cold."""
    import storage

    stream_name = f"plaf203_{serial}"
    sources = tuple(_live_stream_sources(
        serial, storage.get_settings().get("camera_vp8_transcoding", False) is True,
    ))
    async with _stream_locks.setdefault(serial, asyncio.Lock()):
        async with _http.get(f"{_GO2RTC_API}/api/streams") as response:
            if response.status != 200:
                raise RuntimeError(f"go2rtc stream check returned HTTP {response.status}")
            streams = await response.json()
        if _stream_sources.get(serial) == sources and isinstance(streams, dict) and stream_name in streams:
            return stream_name
        params = [("name", stream_name)]
        params.extend(("src", source) for source in sources)
        async with _http.put(
            f"{_GO2RTC_API}/api/streams?{urlencode(params)}"
        ) as response:
            status = response.status
            detail = (await response.text())[:300] if status >= 400 else ""
        # A config persistence error can follow successful in-memory registration.
        async with _http.get(f"{_GO2RTC_API}/api/streams") as response:
            if response.status != 200:
                raise RuntimeError(f"go2rtc stream check returned HTTP {response.status}")
            streams = await response.json()
        if not isinstance(streams, dict) or stream_name not in streams:
            raise RuntimeError(f"go2rtc did not register camera stream (HTTP {status}): {detail}")
        _stream_sources[serial] = sources
        return stream_name


async def exchange_webrtc(serial: str, offer: bytes) -> tuple[bytes, str | None]:
    if serial not in _registered_uids or _http is None:
        raise RuntimeError("Camera is not registered - try again in a few minutes.")
    stream_name = await _ensure_live_stream(serial)
    async with _http.post(
        _GO2RTC_WEBRTC.format(serial=quote(stream_name)), data=offer,
        headers={"Content-Type": "application/sdp"},
        timeout=aiohttp.ClientTimeout(total=30),
    ) as response:
        if response.status >= 400:
            detail = (await response.text())[:300]
            raise RuntimeError(f"go2rtc WebRTC exchange returned {response.status}: {detail}")
        return await response.read(), response.headers.get("Location")


async def set_live_exposure(serial: str, enabled: bool, config: dict, state: dict) -> None:
    """Publish/remove the HA entity independently of the shared relay."""
    if _http is None:
        raise RuntimeError("Camera bridge is not running")
    import ha_mqtt
    async with _ha_rtsp_lock:
        stream_name = f"plaf203_{serial}"
        if enabled:
            if serial not in _registered_uids:
                raise RuntimeError("Feeder camera is not online or enabled")
            if serial in _live_exposed:
                await _start_ha_rtsp()
                return
            await _ensure_live_stream(serial)
            await _start_ha_rtsp()
            try:
                await ha_mqtt.publish_live_camera_discovery(
                    serial, config, state, f"rtsp://{_HA_RTSP_HOST}:{_HA_RTSP_PORT}/{stream_name}"
                )
            except BaseException:
                # Failed/cancelled registration must not leave an unused listener.
                if not _live_exposed:
                    await _stop_ha_rtsp()
                raise
            _live_exposed.add(serial)
            if __import__("storage").get_settings().get("camera_stream_lifetime") != "home_assistant":
                _live_available[serial] = True
            await _publish_available(serial)
            return

        await ha_mqtt.remove_live_camera_discovery(serial)
        _live_exposed.discard(serial)
        if not _live_exposed:
            await _stop_ha_rtsp()
        if __import__("storage").get_settings().get("camera_stream_lifetime") != "home_assistant":
            _live_available.pop(serial, None)
        await _publish_available(serial)
    # The app and background consumer still use this stream. Only stop_device
    # removes its producer; withdrawing HA discovery must not interrupt it.


async def refresh_live_exposures() -> None:
    """Re-register exposed streams after changing the transcoding setting."""
    serials = set(_live_exposed) | set(_keep_open_tasks)
    if _http is None or _http.closed or not serials:
        return
    for serial in serials:
        try:
            await _ensure_live_stream(serial)
        except (aiohttp.ClientError, asyncio.TimeoutError, RuntimeError):
            _LOGGER.warning("Could not refresh live camera stream for %s...", serial[:6], exc_info=True)


async def close_webrtc(session_id: str) -> None:
    location = _webrtc_sessions.pop(session_id, None)
    if location and _http and not _http.closed:
        try:
            target = location if location.startswith("http") else f"{_GO2RTC_API}{location}"
            async with _http.delete(target):
                pass
        except aiohttp.ClientError:
            pass


async def stop_bridge() -> None:
    """Stop snapshot tasks and the bridge during add-on shutdown."""
    global _http, _bridge_process, _go2rtc_process
    for serial in set(_registered_uids) | set(_tasks) | set(_keep_open_tasks) | set(_live_exposed):
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
    await _stop_ha_rtsp()
    if _go2rtc_process and _go2rtc_process.returncode is None:
        _go2rtc_process.terminate()
        try:
            await asyncio.wait_for(_go2rtc_process.wait(), timeout=5)
        except asyncio.TimeoutError:
            _go2rtc_process.kill()
            await _go2rtc_process.wait()
    _go2rtc_process = None
    _live_exposed.clear()
    if _http and not _http.closed:
        await _http.close()
    _http = None


async def update_device(serial: str, uid: str, enabled: bool) -> None:
    """Register a camera UID and start or stop its snapshot loop."""
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

    import storage
    cfg = storage.get_devices().get(serial, {})
    _start_keep_open(serial)
    try:
        import devices
        await set_live_exposure(serial, bool(cfg.get("live_camera_exposed")), cfg, devices.get_device_state(serial))
    except Exception:
        _LOGGER.exception("Could not restore HA live camera exposure for %s...", serial[:6])

    if not _SNAPSHOTS_ENABLED:
        await _set_available(serial, False)
        return

    task = _tasks.get(serial)
    if task is None or task.done():
        _LOGGER.info("Starting HA camera snapshots for %s...", serial[:6])
        _tasks[serial] = asyncio.create_task(_snapshot_loop(serial), name=f"camera-{serial}")


def _start_keep_open(serial: str) -> None:
    import storage

    if storage.get_settings().get("camera_stream_lifetime") != "home_assistant":
        return
    task = _keep_open_tasks.get(serial)
    if task is None or task.done():
        _keep_open_tasks[serial] = asyncio.create_task(
            _keep_open_loop(serial), name=f"camera-keep-open-{serial}"
        )


async def refresh_stream_lifetime() -> None:
    """Apply stream lifetime changes immediately to all registered cameras."""
    tasks = list(_keep_open_tasks.values())
    _keep_open_tasks.clear()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    import storage
    import devices

    persistent = storage.get_settings().get("camera_stream_lifetime") == "home_assistant"
    configs = storage.get_devices()
    for serial in tuple(_registered_uids):
        cfg = configs.get(serial, {})
        if cfg.get("live_camera_exposed"):
            if not persistent:
                _live_available[serial] = True
            try:
                await set_live_exposure(serial, True, cfg, devices.get_device_state(serial))
            except Exception:
                _LOGGER.warning("Could not expose live camera for %s...", serial[:6], exc_info=True)
        else:
            await set_live_exposure(serial, False, cfg, devices.get_device_state(serial))
        await _publish_available(serial)
        _start_keep_open(serial)


async def _keep_open_loop(serial: str) -> None:
    """Keep the shared HA/WebRTC video and audio producers running."""
    next_exposure_retry = 0.0
    while True:
        process = None
        stderr_task = None
        try:
            import storage
            import devices

            cfg = storage.get_devices().get(serial, {})
            if cfg.get("live_camera_exposed"):
                try:
                    await set_live_exposure(serial, True, cfg, devices.get_device_state(serial))
                except Exception:
                    _LOGGER.warning("Could not expose live camera for %s...; keeping relay running", serial[:6], exc_info=True)
            await _ensure_live_stream(serial)
            # Request both video codecs so HA's H.264 source stays warm even
            # when browsers prefer VP8. Opus keeps browser audio ready too.
            tracks = [("video", "h264"), ("audio", "opus"), ("audio", "aac")]
            if storage.get_settings().get("camera_vp8_transcoding", False) is True:
                tracks.insert(0, ("video", "vp8"))
            source = f"rtsp://{_INTERNAL_RTSP_HOST}:{_INTERNAL_RTSP_PORT}/plaf203_{serial}?{urlencode(tracks)}"
            process = await asyncio.create_subprocess_exec(
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                "-rtsp_transport", "tcp", "-timeout", "15000000",
                "-i", source,
                "-map", "0:v", "-map", "0:a?", "-c", "copy",
                "-progress", "pipe:1", "-f", "null", "-",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stderr_task = asyncio.create_task(_drain_stderr(process.stderr))
            while line := await asyncio.wait_for(
                process.stdout.readline(), timeout=_STREAM_READ_TIMEOUT_SECS
            ):
                if line.startswith(b"frame="):
                    frames = line.removeprefix(b"frame=").strip()
                    if frames.isdigit() and int(frames) > 0:
                        # MQTT can still be connecting when the private relay
                        # starts. Retry HA exposure without restarting video.
                        cfg = storage.get_devices().get(serial, {})
                        now = asyncio.get_running_loop().time()
                        if cfg.get("live_camera_exposed") and serial not in _live_exposed and now >= next_exposure_retry:
                            next_exposure_retry = now + 5
                            try:
                                await set_live_exposure(serial, True, cfg, devices.get_device_state(serial))
                            except Exception:
                                _LOGGER.debug("HA camera exposure retry pending for %s...", serial[:6], exc_info=True)
                        _live_available[serial] = True
                        await _publish_available(serial)
            _LOGGER.warning("Persistent camera stream ended for %s...; retrying", serial[:6])
        except asyncio.CancelledError:
            raise
        except Exception:
            _LOGGER.warning("Persistent camera stream failed for %s...; retrying", serial[:6], exc_info=True)
        finally:
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
            if stderr_task:
                stderr_task.cancel()
                await asyncio.gather(stderr_task, return_exceptions=True)
            _live_available[serial] = False
            await _publish_available(serial)
        await asyncio.sleep(5)


async def set_snapshot_interval(seconds: int) -> None:
    """Apply a new snapshot cadence and restart active FFmpeg capture loops."""
    global _SNAPSHOT_INTERVAL_SECS
    import storage

    if (
        isinstance(seconds, bool)
        or not isinstance(seconds, int)
        or not storage.CAMERA_SNAPSHOT_INTERVAL_MIN_SECONDS <= seconds
        <= storage.CAMERA_SNAPSHOT_INTERVAL_MAX_SECONDS
    ):
        raise ValueError("Camera snapshot interval is outside the supported range")
    if seconds == _SNAPSHOT_INTERVAL_SECS:
        return

    active_serials = [serial for serial, task in _tasks.items() if not task.done()]
    tasks = [_tasks[serial] for serial in active_serials]
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

    _SNAPSHOT_INTERVAL_SECS = seconds
    for serial in active_serials:
        if serial in _registered_uids:
            _tasks[serial] = asyncio.create_task(
                _snapshot_loop(serial), name=f"camera-{serial}"
            )
    _LOGGER.info("Camera snapshot interval set to %d seconds", seconds)


async def set_snapshots_enabled(enabled: bool) -> None:
    """Start snapshot capture only after the user explicitly enables it."""
    global _SNAPSHOTS_ENABLED
    if not isinstance(enabled, bool):
        raise ValueError("Camera snapshot enabled must be a boolean")
    if enabled == _SNAPSHOTS_ENABLED:
        return
    _SNAPSHOTS_ENABLED = enabled
    if not enabled:
        serials = list(_tasks)
        tasks = [_tasks.pop(serial) for serial in serials]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for serial in serials:
            await _set_available(serial, False)
        return
    for serial in list(_registered_uids):
        task = _tasks.get(serial)
        if task is None or task.done():
            _tasks[serial] = asyncio.create_task(
                _snapshot_loop(serial), name=f"camera-{serial}"
            )
            _LOGGER.info("Starting HA camera snapshots for %s...", serial[:6])


async def stop_device(serial: str) -> None:
    keep_open_task = _keep_open_tasks.pop(serial, None)
    if keep_open_task:
        keep_open_task.cancel()
        await asyncio.gather(keep_open_task, return_exceptions=True)
    if _live_serial == serial and _live_process and _live_process.returncode is None:
        _live_process.kill()
    task = _tasks.pop(serial, None)
    if task:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    _registered_uids.pop(serial, None)
    _snapshots.pop(serial, None)
    _stream_sources.pop(serial, None)
    _live_available.pop(serial, None)
    await _set_available(serial, False)
    try:
        import ha_mqtt
        await ha_mqtt.remove_live_camera_discovery(serial)
    except Exception:
        _LOGGER.debug("Could not retract live camera discovery for %s...", serial[:6], exc_info=True)
    async with _ha_rtsp_lock:
        _live_exposed.discard(serial)
        if not _live_exposed:
            await _stop_ha_rtsp()
    if _http and not _http.closed:
        try:
            async with _http.delete(f"{_GO2RTC_API}/api/streams?src={quote(f'plaf203_{serial}')}"):
                pass
        except aiohttp.ClientError:
            pass
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
                    _snapshots[serial] = image
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


async def _drain_stderr(stream, tail: bytearray | None = None) -> None:
    if stream is None:
        return
    while chunk := await stream.read(4096):
        if tail is not None:
            tail.extend(chunk)
            if len(tail) > 4096:
                del tail[:-4096]


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
    _snapshot_available[serial] = available
    await _publish_available(serial)


async def _publish_available(serial: str) -> None:
    # The native live camera shares the existing availability topic. Snapshot
    # capture being disabled must not mark a healthy live stream offline.
    available = bool(_snapshot_available.get(serial) or _live_available.get(serial))
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
