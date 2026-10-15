"""Supervisor API calls for managing the Mosquitto add-on."""

import logging
import os

import aiohttp

from ha_config import SUPERVISOR_TOKEN, _headers

_LOGGER = logging.getLogger(__name__)

SUPERVISOR_URL = "http://supervisor"
MOSQUITTO_SLUG = "core_mosquitto"


def _action_headers() -> dict:
    """Headers for Supervisor action POSTs (no body, so no Content-Type)."""
    return {"Authorization": f"Bearer {SUPERVISOR_TOKEN}"}


async def _addon_action(action: str) -> bool:
    if not SUPERVISOR_TOKEN:
        _LOGGER.error("SUPERVISOR_TOKEN is not set — hassio_api may not be enabled")
        return False

    url = f"{SUPERVISOR_URL}/addons/{MOSQUITTO_SLUG}/{action}"
    _LOGGER.info("Supervisor: POST %s", url)
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                headers=_action_headers(),
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                text = await resp.text()
                if resp.status == 200:
                    _LOGGER.info("Mosquitto %s: OK (response: %s)", action, text[:120])
                    return True
                _LOGGER.error(
                    "Mosquitto %s failed: HTTP %d — %s",
                    action, resp.status, text[:300],
                )
                return False
    except Exception:
        _LOGGER.exception("Mosquitto %s request failed", action)
        return False


async def get_addon_info() -> dict:
    """Fetch Mosquitto add-on info for diagnostics. Logs the slug + state."""
    if not SUPERVISOR_TOKEN:
        _LOGGER.error("SUPERVISOR_TOKEN not set")
        return {}
    url = f"{SUPERVISOR_URL}/addons/{MOSQUITTO_SLUG}/info"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                url,
                headers=_action_headers(),
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    state = data.get("data", {}).get("state", "?")
                    _LOGGER.info("Mosquitto info: state=%s", state)
                    return data
                text = await resp.text()
                _LOGGER.error("Mosquitto info failed: HTTP %d — %s", resp.status, text[:200])
                return {}
    except Exception:
        _LOGGER.exception("Mosquitto info request failed")
        return {}


async def stop_mosquitto() -> bool:
    return await _addon_action("stop")


async def start_mosquitto() -> bool:
    return await _addon_action("start")


async def remove_mosquitto_login(username: str) -> str:
    """Remove a login entry from Mosquitto's options.

    Returns:
        "removed"   — entry found and removed
        "not_found" — entry was not present, no change
        "error"     — Supervisor API call failed
    """
    if not SUPERVISOR_TOKEN:
        _LOGGER.error("SUPERVISOR_TOKEN is not set")
        return "error"

    info_url = f"{SUPERVISOR_URL}/addons/{MOSQUITTO_SLUG}/info"
    options_url = f"{SUPERVISOR_URL}/addons/{MOSQUITTO_SLUG}/options"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(info_url, headers=_action_headers(), timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    _LOGGER.error("Could not read Mosquitto info: HTTP %d — %s", resp.status, text[:200])
                    return "error"
                info = await resp.json()
        current_opts = info.get("data", {}).get("options", {})
        logins = list(current_opts.get("logins", []))
        new_logins = [entry for entry in logins if entry.get("username") != username]
        if len(new_logins) == len(logins):
            _LOGGER.info("Login for %s... not found in Mosquitto (nothing to remove)", username[:4])
            return "not_found"
        async with aiohttp.ClientSession() as session:
            async with session.post(options_url, json={"options": {**current_opts, "logins": new_logins}}, headers={**_action_headers(), "Content-Type": "application/json"}, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status == 200:
                    _LOGGER.info("Removed Mosquitto login for %s...", username[:4])
                    return "removed"
                text = await resp.text()
                _LOGGER.error("Failed to save Mosquitto options: HTTP %d — %s", resp.status, text[:200])
                return "error"
    except Exception:
        _LOGGER.exception("remove_mosquitto_login failed")
        return "error"


async def remove_mosquitto_logins_matching(name: str) -> str:
    """Remove logins whose username contains the normalized name phrase.

    Hyphens and underscores are treated as spaces, so ``petlibro-local`` and
    ``Petlibro Local`` both match the phrase ``petlibro local``.
    Returns "removed", "not_found", or "error".
    """
    if not SUPERVISOR_TOKEN:
        _LOGGER.error("SUPERVISOR_TOKEN is not set")
        return "error"

    normalize = lambda value: " ".join(
        str(value).lower().replace("-", " ").replace("_", " ").split()
    )
    phrase = normalize(name)
    info_url = f"{SUPERVISOR_URL}/addons/{MOSQUITTO_SLUG}/info"
    options_url = f"{SUPERVISOR_URL}/addons/{MOSQUITTO_SLUG}/options"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(info_url, headers=_action_headers(), timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    _LOGGER.error("Could not read Mosquitto info: HTTP %d — %s", resp.status, text[:200])
                    return "error"
                info = await resp.json()

        current_opts = info.get("data", {}).get("options", {})
        logins = list(current_opts.get("logins", []))
        new_logins = [entry for entry in logins if phrase not in normalize(entry.get("username", ""))]
        if len(new_logins) == len(logins):
            return "not_found"

        async with aiohttp.ClientSession() as session:
            async with session.post(
                options_url,
                json={"options": {**current_opts, "logins": new_logins}},
                headers={**_action_headers(), "Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    _LOGGER.info("Removed %d Mosquitto login(s) matching %s", len(logins) - len(new_logins), name)
                    return "removed"
                text = await resp.text()
                _LOGGER.error("Failed to save Mosquitto options: HTTP %d — %s", resp.status, text[:200])
                return "error"
    except Exception:
        _LOGGER.exception("remove_mosquitto_logins_matching failed")
        return "error"

async def add_mosquitto_login(username: str, password: str) -> str:
    """Add a login entry to Mosquitto's options and save.

    Returns:
        "added"  — credentials were new and saved successfully
        "exists" — credentials already present, no change made
        "error"  — Supervisor API call failed
    """
    if not SUPERVISOR_TOKEN:
        _LOGGER.error("SUPERVISOR_TOKEN is not set")
        return "error"

    info_url = f"{SUPERVISOR_URL}/addons/{MOSQUITTO_SLUG}/info"
    options_url = f"{SUPERVISOR_URL}/addons/{MOSQUITTO_SLUG}/options"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                info_url,
                headers=_action_headers(),
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    _LOGGER.error("Could not read Mosquitto info: HTTP %d — %s", resp.status, text[:200])
                    return "error"
                info = await resp.json()

        current_opts = info.get("data", {}).get("options", {})
        logins = list(current_opts.get("logins", []))
        for entry in logins:
            if entry.get("username") == username:
                if entry.get("password") == password:
                    _LOGGER.info("Login for %s... already exists in Mosquitto (unchanged)", username[:4])
                    return "exists"
                # Same username, different password — update it.
                entry["password"] = password
                _LOGGER.info("Login for %s... exists in Mosquitto — updating password", username[:4])
                new_options = {**current_opts, "logins": logins}
                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        options_url,
                        json={"options": new_options},
                        headers={**_action_headers(), "Content-Type": "application/json"},
                        timeout=aiohttp.ClientTimeout(total=10),
                    ) as resp:
                        if resp.status == 200:
                            return "added"
                        text = await resp.text()
                        _LOGGER.error("Failed to update Mosquitto password for %s...: HTTP %d — %s", username[:4], resp.status, text[:200])
                        return "error"

        logins.append({"username": username, "password": password})
        new_options = {**current_opts, "logins": logins}

        async with aiohttp.ClientSession() as session:
            async with session.post(
                options_url,
                json={"options": new_options},
                headers={**_action_headers(), "Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    _LOGGER.info("Added Mosquitto login for %s...", username[:4])
                    return "added"
                text = await resp.text()
                _LOGGER.error("Failed to save Mosquitto options: HTTP %d — %s", resp.status, text[:200])
                return "error"
    except Exception:
        _LOGGER.exception("add_mosquitto_login failed")
        return "error"
