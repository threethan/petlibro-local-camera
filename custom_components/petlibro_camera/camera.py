"""Native streaming camera entities discovered from Petlibro Local MQTT."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from homeassistant.components import mqtt
from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import AVAILABILITY_TOPIC, DISCOVERY_TOPIC, DOMAIN, RTSP_HOST, RTSP_PORT, SERIAL_PATTERN

_SERIAL_RE = re.compile(SERIAL_PATTERN)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> bool:
    entities: dict[str, PetlibroLiveCamera] = {}
    availability: dict[str, bool] = {}

    async def remove_entity(entity: PetlibroLiveCamera) -> None:
        # Discovery can be withdrawn before HA finishes adding a just-created entity.
        for _ in range(20):
            if entity.entity_id and entity.platform:
                er.async_get(hass).async_remove(entity.entity_id)
                return
            await asyncio.sleep(0.05)

    @callback
    def handle_discovery(message: mqtt.ReceiveMessage) -> None:
        parts = message.topic.split("/")
        if len(parts) != 4 or not _SERIAL_RE.fullmatch(parts[2]):
            return
        serial = parts[2]
        if not message.payload:
            entity = entities.pop(serial, None)
            if entity:
                hass.async_create_task(remove_entity(entity))
            return
        try:
            config = json.loads(message.payload)
        except (TypeError, ValueError):
            return
        if not isinstance(config, dict) or config.get("serial") != serial:
            return
        source = config.get("stream_source", "")
        expected = f"rtsp://{RTSP_HOST}:{RTSP_PORT}/plaf203_{serial}"
        if source != expected:
            return
        entity = entities.get(serial)
        if entity is None:
            entity = PetlibroLiveCamera(serial, config, source, availability.get(serial, False))
            entities[serial] = entity
            async_add_entities([entity])
        else:
            entity.update_config(config, source)

    @callback
    def handle_availability(message: mqtt.ReceiveMessage) -> None:
        parts = message.topic.split("/")
        if len(parts) != 4 or not _SERIAL_RE.fullmatch(parts[1]):
            return
        serial = parts[1]
        available = message.payload == "online"
        availability[serial] = available
        if entity := entities.get(serial):
            entity.set_available(available)

    remove_discovery = await mqtt.async_subscribe(hass, DISCOVERY_TOPIC, handle_discovery, qos=1)
    remove_availability = await mqtt.async_subscribe(hass, AVAILABILITY_TOPIC, handle_availability, qos=1)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = (remove_discovery, remove_availability)
    return True


class PetlibroLiveCamera(Camera):
    _attr_has_entity_name = True
    _attr_supported_features = CameraEntityFeature.STREAM

    def __init__(self, serial: str, config: dict[str, Any], source: str, available: bool) -> None:
        super().__init__()
        self._serial = serial
        self._source = source
        self._attr_unique_id = config.get("unique_id", f"petlibro_{serial}_camera_live")
        self._attr_name = config.get("name", "Live Camera")
        self._attr_available = available
        self._attr_device_info = self._device_info(config)

    def _device_info(self, config: dict[str, Any]) -> DeviceInfo:
        device = config.get("device", {})
        info = {key: device[key] for key in ("name", "manufacturer", "model", "sw_version", "hw_version") if device.get(key)}
        info["identifiers"] = {("mqtt", f"petlibro_local_{self._serial}")}
        return DeviceInfo(**info)

    async def stream_source(self) -> str:
        # HA's stream pipeline uses H.264/AAC; browser WebRTC can use the
        # shared stream's VP8/Opus tracks without changing HA's selection.
        return f"{self._source}?video=h264&audio=aac"

    @property
    def use_stream_for_stills(self) -> bool:
        """Let HA render previews from the relay without an active live viewer."""
        return True

    async def async_camera_image(self, width: int | None = None, height: int | None = None) -> bytes | None:
        return None

    @callback
    def update_config(self, config: dict[str, Any], source: str) -> None:
        self._source = source
        self._attr_device_info = self._device_info(config)
        self.async_write_ha_state()

    @callback
    def set_available(self, available: bool) -> None:
        self._attr_available = available
        self.async_write_ha_state()
