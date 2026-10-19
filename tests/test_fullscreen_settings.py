"""Fullscreen rotation preferences migrate and persist without losing direction."""

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "fullscreen_storage", Path(__file__).parents[1] / "addon" / "app" / "storage.py",
)
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class FullscreenSettingsTests(unittest.TestCase):
    def test_legacy_rotation_migrates_on_read_and_unrelated_save(self):
        for enabled, expected in [(True, "counterclockwise"), (False, "off")]:
            with self.subTest(enabled=enabled), patch.object(storage, "_load", return_value={
                "settings": {"camera_force_landscape_mobile": enabled},
            }), patch.object(storage, "_save") as save:
                self.assertEqual(storage.get_settings()["camera_fullscreen_rotation"], expected)
                result = storage.save_settings({"language": "en"})
                self.assertEqual(result["camera_fullscreen_rotation"], expected)
                self.assertEqual(save.call_args.args[0]["settings"]["camera_fullscreen_rotation"], expected)

    def test_each_direction_overrides_legacy_enabled(self):
        for mode in ["off", "clockwise", "counterclockwise"]:
            with self.subTest(mode=mode), patch.object(storage, "_load", return_value={
                "settings": {"camera_force_landscape_mobile": True, "camera_fullscreen_rotation": mode},
            }), patch.object(storage, "_save"):
                self.assertEqual(storage.get_settings()["camera_fullscreen_rotation"], mode)
                self.assertEqual(storage.save_settings({"camera_fullscreen_rotation": mode})["camera_fullscreen_rotation"], mode)

    def test_invalid_rotation_is_rejected_without_saving(self):
        for value in [True, 90, "left", None]:
            with self.subTest(value=value), patch.object(storage, "_load", return_value={}), patch.object(storage, "_save") as save:
                with self.assertRaises(ValueError):
                    storage.save_settings({"camera_fullscreen_rotation": value})
                save.assert_not_called()
