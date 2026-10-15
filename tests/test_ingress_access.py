"""LAN clients can fetch feeder resources, but not the add-on dashboard."""

import ast
import ipaddress
import logging
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock


class _Response:
    def __init__(self, status=200, text=""):
        self.status = status
        self.text = text


# Load only the middleware so these access checks can run without the add-on's
# aiohttp, MQTT, and camera dependencies on the development machine.
source = ast.parse((Path(__file__).parents[1] / "addon/app/main.py").read_text())
middleware_node = next(
    node for node in source.body
    if isinstance(node, ast.AsyncFunctionDef) and node.name == "_restrict_ingress_middleware"
)
middleware_node.decorator_list = []
namespace = {
    "ipaddress": ipaddress,
    "web": SimpleNamespace(Response=_Response),
    "_LOGGER": logging.getLogger(__name__),
    "_INGRESS_NETWORK": ipaddress.ip_network("172.30.32.0/23"),
}
exec(compile(ast.Module(body=[middleware_node], type_ignores=[]), "main.py", "exec"), namespace)
restrict_ingress = namespace["_restrict_ingress_middleware"]


class IngressAccessTests(unittest.IsolatedAsyncioTestCase):
    async def test_lan_cannot_access_dashboard_assets_or_api(self):
        for path in ("/", "/index.html", "/app.css", "/icon.png", "/locales/en.json", "/api/settings"):
            with self.subTest(path=path):
                handler = AsyncMock(return_value=_Response())
                response = await restrict_ingress(SimpleNamespace(path=path, remote="192.168.1.25"), handler)
                self.assertEqual(response.status, 403)
                handler.assert_not_awaited()

    async def test_ingress_can_access_dashboard_and_api(self):
        for path in ("/", "/app.css", "/api/settings"):
            with self.subTest(path=path):
                expected = _Response()
                handler = AsyncMock(return_value=expected)
                response = await restrict_ingress(SimpleNamespace(path=path, remote="172.30.32.2"), handler)
                self.assertIs(response, expected)
                handler.assert_awaited_once()

    async def test_lan_can_fetch_feeder_resources(self):
        for path in ("/audio/come_to_eat.aac", "/images/feeder"):
            with self.subTest(path=path):
                expected = _Response()
                handler = AsyncMock(return_value=expected)
                response = await restrict_ingress(SimpleNamespace(path=path, remote="192.168.1.25"), handler)
                self.assertIs(response, expected)
                handler.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
