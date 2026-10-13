"""PLAF203 camera feeder (AF0301 serial family).

The captured device reports food state and requests feeding-plan sync on
PLAF203 topics. Manual dispensing is supported by the relay's confirmed
MANUAL_FEEDING_SERVICE path.
"""

from . import granary

DEVICE_TYPES = ["camera_feeder"]

MQTT_MODELS = {
    "camera_feeder": "PLAF203",
}

ALERT_MESSAGES = granary.ALERT_MESSAGES
DEFAULT_NOTIFICATIONS = granary.DEFAULT_NOTIFICATIONS


def compute_alerts(state: dict, cfg: dict, online: bool) -> set:
    return granary.compute_alerts(state, cfg, online)


def track_intake(old_state: dict, new_state: dict, min_grams: float = 5) -> float | None:
    return granary.track_intake(old_state, new_state, min_grams)
