"""Prepare meal calls in the format used by the vendor app's recorder."""

import asyncio
import hashlib
from pathlib import Path
import uuid

import aiohttp


async def check_download(url: str) -> None:
    """Reject broken audio-server settings before asking firmware to fetch them.

    This checks reachability from the add-on; the feeder still needs LAN access.
    Use GET since a successful HEAD alone does not establish a readable file.
    """
    try:
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, allow_redirects=False) as response:
                if response.status != 200 or not await response.content.read(1):
                    raise ValueError("The feeding sound URL did not return an audio file; check Local Audio Base URL in Settings")
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
        raise ValueError("Cannot download the feeding sound; check Local Audio Base URL in Settings") from exc


async def prepare(source: str, cache_dir: str = "/data/audio/feeding") -> str:
    # Content-based filenames also make replacing a clip trigger a fresh download.
    digest = hashlib.sha256(b"aac-lc-44100-stereo-128k-10s-v1\0")
    with open(source, "rb") as stream:
        while chunk := stream.read(65536):
            digest.update(chunk)
    name = digest.hexdigest()[:32] + ".aac"
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / name
    if target.is_file():
        return name
    temporary = cache / (uuid.uuid4().hex + ".tmp")
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-i", source, "-t", "10", "-vn",
            "-acodec", "aac", "-profile:a", "aac_low", "-b:a", "128k",
            "-ar", "44100", "-ac", "2", "-f", "adts", str(temporary),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        try:
            await asyncio.wait_for(proc.communicate(), 30)
        except BaseException:
            if proc.returncode is None:
                proc.kill()
                await proc.communicate()
            raise
        if proc.returncode or not temporary.is_file() or not temporary.stat().st_size:
            raise ValueError("Could not prepare that feeding sound")
        temporary.replace(target)
        return name
    finally:
        temporary.unlink(missing_ok=True)
