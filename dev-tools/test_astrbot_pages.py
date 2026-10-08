"""Native Pages format and actual AstrBot authenticated extension dispatch.

The installed AstrBot supplies the router, JWT authentication, request bridge
and Page discovery/asset rewriting. Minecraft RPC is substituted locally.
"""
from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths

_paths.require_astrbot("test_astrbot_pages")
try:
    import httpx
    import jwt
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from astrbot.dashboard.api import plugins as astrbot_plugins
    from astrbot.dashboard.responses import ApiError
    from astrbot.dashboard.services.plugin_page_service import PluginPageService
except ImportError:
    print("SKIP: installed AstrBot does not provide native Pages API")
    raise SystemExit(0)

from test_webui import plugin, web

NAME = "astrbot_plugin_astrcraft"


class Context:
    def __init__(self):
        self.registered_web_apis = []

    def register_web_api(self, route, handler, methods, desc):
        for index, entry in enumerate(self.registered_web_apis):
            if entry[0] == route and entry[2] == methods:
                self.registered_web_apis[index] = (route, handler, methods, desc)
                return
        self.registered_web_apis.append((route, handler, methods, desc))


class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.p = plugin()
        self.context = Context()
        self.ui = web.WebUI(self.p, native=True, version="test")
        self.ui.register(self.context, NAME)
        self.app = FastAPI()
        self.app.state.core_lifecycle = SimpleNamespace(star_context=self.context)
        self.app.state.jwt_secret = "local-pages-test-secret-only-1234567890"

        @self.app.exception_handler(ApiError)
        async def error_handler(_request, exc):
            return JSONResponse({"status": "error", "message": exc.message}, status_code=exc.status_code)

        self.app.include_router(astrbot_plugins.legacy_router)
        self.app.include_router(astrbot_plugins.router, prefix="/api/v1")
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://astrbot.test")
        self.auth = {"Authorization": "Bearer " + jwt.encode(
            {"username": "astrbot", "exp": int(time.time()) + 60}, self.app.state.jwt_secret, algorithm="HS256")}

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.ui.close()

    async def test_both_astrbot_routes_require_dashboard_login(self):
        for prefix in ("/api/plug/", "/api/v1/plugins/extensions/"):
            for method, suffix in (("GET", "state"), ("POST", "action")):
                response = await self.client.request(method, prefix + NAME + "/" + suffix, json={"action": "stop"})
                self.assertEqual(response.status_code, 401)
        self.p._emergency_stop.assert_not_awaited()

    async def test_authenticated_snapshot_and_controls_use_public_dispatch(self):
        for prefix in ("/api/plug/", "/api/v1/plugins/extensions/"):
            response = await self.client.get(prefix + NAME + "/state", headers=self.auth)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["state"]["health"], 0)
            self.assertIn("usage", response.json())
            self.assertNotIn("token", response.json())
            self.assertEqual(response.headers["cache-control"], "no-store")
            response = await self.client.post(prefix + NAME + "/action", json={"action": "stop"}, headers=self.auth)
            self.assertEqual(response.status_code, 202)
            job = response.json()
            await self.ui.tasks[job["id"]]
            self.assertEqual(self.ui.jobs[job["id"]]["status"], "done")

    async def test_native_errors_have_astrbot_envelope(self):
        path = "/api/plug/" + NAME + "/action"
        for payload, expected in (({"action": "eval"}, 400), (["stop"], 400), ({"action": "say", "text": "x" * 251}, 400)):
            response = await self.client.post(path, json=payload, headers=self.auth)
            self.assertEqual(response.status_code, expected)
            self.assertEqual(response.json()["status"], "error")
        response = await self.client.post(path, content=b"x" * 4097,
                                          headers={**self.auth, "Content-Type": "application/json"})
        self.assertEqual(response.status_code, 413)
        response = await self.client.post(path, json={"action": "stop"},
                                          headers={**self.auth, "Origin": "https://other.test"})
        self.assertEqual(response.status_code, 403)
        self.p._emergency_stop.assert_not_awaited()

    async def test_reload_unregisters_only_own_handlers(self):
        newer = web.WebUI(self.p, native=True, version="new")
        newer.register(self.context, NAME)
        await self.ui.close()
        self.assertEqual(len(self.context.registered_web_apis), 2)
        response = await self.client.get("/api/plug/" + NAME + "/state", headers=self.auth)
        self.assertEqual(response.json()["version"], "new")
        await newer.close()
        self.assertEqual(self.context.registered_web_apis, [])

    async def test_actual_page_service_discovers_and_rewrites_assets(self):
        metadata = SimpleNamespace(name=NAME, root_dir_name=_paths.REPO.name, reserved=False,
                                   activated=True, display_name="Astrcraft", i18n={})
        manager = SimpleNamespace(plugin_store_path=str(_paths.REPO.parent),
                                  context=SimpleNamespace(get_all_stars=lambda: [metadata]))
        service = PluginPageService(manager)
        pages = await service.discover_plugin_pages(metadata)
        self.assertEqual([page.name for page in pages], ["control"])
        html = (_paths.REPO / "pages/control/index.html").read_text(encoding="utf-8")
        rewritten = service.rewrite_plugin_page_html(html, NAME, "control", "index.html", theme="dark")
        self.assertIn('data-theme="dark"', rewritten)
        self.assertIn("/api/plugin/page/bridge-sdk.js", rewritten)
        self.assertIn(f"/api/plugin/page/content/{NAME}/control/app.js", rewritten)
        self.assertIn('type="module"', rewritten)
        self.assertNotIn('src="/app.js"', rewritten)
        translated = json.loads((_paths.REPO / ".astrbot-plugin/i18n/zh-CN.json").read_text(encoding="utf-8"))
        self.assertEqual(translated["pages"]["control"]["title"], "Astrcraft 控制台")


if __name__ == "__main__":
    unittest.main(verbosity=2)
