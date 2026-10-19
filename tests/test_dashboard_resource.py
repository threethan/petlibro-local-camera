"""The integration serves and registers the packaged dashboard card module."""

import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock


ROOT = Path(__file__).parents[1]
INTEGRATION = ROOT / "custom_components/petlibro_camera"


class DashboardResourceTests(unittest.IsolatedAsyncioTestCase):
    def setup_registration(self, mode="storage", items=None):
        node = next(node for node in ast.parse((INTEGRATION / "__init__.py").read_text()).body
                    if isinstance(node, ast.AsyncFunctionDef) and node.name == "async_setup")
        frontend = Mock()
        namespace = {"__file__": str(INTEGRATION / "__init__.py"), "Path": Path,
                     "HomeAssistant": object, "frontend": frontend,
                     "StaticPathConfig": lambda *args: args, "LOVELACE_DATA": "lovelace"}
        exec(compile(ast.Module(body=[node], type_ignores=[]), "__init__.py", "exec"), namespace)
        register = AsyncMock()
        resources = Mock(async_get_info=AsyncMock(), async_items=Mock(return_value=items or []),
                         async_create_item=AsyncMock(), async_update_item=AsyncMock())
        hass = SimpleNamespace(http=SimpleNamespace(async_register_static_paths=register),
                               data={"lovelace": SimpleNamespace(resource_mode=mode, resources=resources)})
        return namespace["async_setup"], hass, register, resources, frontend

    async def test_resource_registration_uses_bundled_file(self):
        setup, hass, register, resources, frontend = self.setup_registration()
        self.assertTrue(await setup(hass, {}))
        path = register.call_args.args[0][0]
        self.assertEqual(path[0], "/petlibro_camera/dashboard.js")
        self.assertTrue(Path(path[1]).is_file())
        self.assertFalse(path[2])
        resources.async_get_info.assert_awaited_once()
        resources.async_create_item.assert_awaited_once_with({
            "url": "/petlibro_camera/dashboard.js?v=1.2.1", "res_type": "module"})
        frontend.add_extra_js_url.assert_not_called()

    async def test_existing_resource_is_updated_without_creating_duplicates(self):
        for url, resource_type, updates in [
            ("/petlibro_camera/dashboard.js?v=1.2.0", "module", True),
            ("/petlibro_camera/dashboard.js?v=1.2.1", "js", True),
            ("/petlibro_camera/dashboard.js?v=1.2.1", "module", False),
        ]:
            with self.subTest(url=url, resource_type=resource_type):
                setup, hass, _, resources, _ = self.setup_registration(items=[
                    {"id": "other", "url": "/unrelated.js", "type": "module"},
                    {"id": "petlibro", "url": url, "type": resource_type}])
                await setup(hass, {})
                resources.async_create_item.assert_not_awaited()
                if updates:
                    resources.async_update_item.assert_awaited_once_with("petlibro", {
                        "url": "/petlibro_camera/dashboard.js?v=1.2.1", "res_type": "module"})
                else:
                    resources.async_update_item.assert_not_awaited()

    async def test_yaml_resources_are_not_modified(self):
        setup, hass, _, resources, frontend = self.setup_registration(mode="yaml")
        await setup(hass, {})
        resources.async_create_item.assert_not_awaited()
        resources.async_update_item.assert_not_awaited()
        frontend.add_extra_js_url.assert_called_once_with(hass, "/petlibro_camera/dashboard.js?v=1.2.1")

    async def test_hacs_and_integration_ship_the_same_card(self):
        self.assertEqual((ROOT / "dist/petlibro-local-status-card.js").read_bytes(),
                         (INTEGRATION / "dashboard.js").read_bytes())
