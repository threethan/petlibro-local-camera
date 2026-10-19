from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace import LOVELACE_DATA
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN, PLATFORMS


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Make the bundled dashboard cards available without a HACS resource."""
    await hass.http.async_register_static_paths([
        StaticPathConfig("/petlibro_camera/dashboard.js", str(Path(__file__).with_name("dashboard.js")), False),
    ])
    resource_url = "/petlibro_camera/dashboard.js?v=1.2.1"
    lovelace = hass.data[LOVELACE_DATA]
    if lovelace.resource_mode == "storage":
        resources = lovelace.resources
        await resources.async_get_info()  # Load existing items before checking.
        existing = next((item for item in resources.async_items()
                         if item["url"].split("?", 1)[0] == "/petlibro_camera/dashboard.js"), None)
        if existing is None:
            await resources.async_create_item({"url": resource_url, "res_type": "module"})
        elif existing["url"] != resource_url or existing["type"] != "module":
            await resources.async_update_item(existing["id"], {"url": resource_url, "res_type": "module"})
    else:
        # Respect YAML-managed resources and load the bundled module separately.
        frontend.add_extra_js_url(hass, resource_url)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    for unsubscribe in hass.data.get(DOMAIN, {}).pop(entry.entry_id, ()):
        unsubscribe()
    return True
