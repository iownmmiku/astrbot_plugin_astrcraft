"""WebUI HTTP authorization, live snapshots, asynchronous controls and shutdown."""
from __future__ import annotations

import asyncio
import http.client
import json
import sys
import tempfile
import unittest
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths

web = _paths.plugin_module("webui_server")


class Hold(Enum):
    NONE = "none"


def plugin():
    async def call(method, params, **_):
        if method == "status":
            return {"connected": True, "current_task": None, "queue": [], "history": []}
        if method == "state.get":
            return {"connected": True, "health": 0, "food": 0, "position": {"x": 0, "y": 64, "z": 0},
                    "inventory": [{"slot": 36, "name": "oak_log", "count": 8}]}
        if method == "viewer.status":
            return {"running": False}
        return {"ok": True}

    return SimpleNamespace(
        engine=SimpleNamespace(running=True, call=AsyncMock(side_effect=call), say=AsyncMock()),
        connected=True, _emergency_stopped=False, _manual_disconnect_requested=False, _terminating=False,
        life=SimpleNamespace(running=True, paused=False, current=None, _intention="准备木头", _plan=[],
                             _recent_outcomes=[], current_hold=lambda: Hold.NONE, hold_explain=lambda: "行动正常",
                             describe=lambda: "自主生活", pause=Mock()), goals=None, _event_buffer=[],
        _cfg=lambda key, default=None: default,
        _emergency_stop=AsyncMock(return_value={"cancelled": ["t1"]}),
        _do_disconnect=AsyncMock(return_value="已断开"), _ensure_engine=AsyncMock(return_value=True),
        _auto_connect=AsyncMock(), _resume_play=AsyncMock(return_value="已恢复"),
        _pause_play=AsyncMock(return_value="已暂停"), _abandon_goal=AsyncMock(return_value="已放弃"),
        _start_player_goal=AsyncMock(return_value="已开始目标"),
    )


class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.p = plugin()
        self.ui = web.WebUI(self.p, host="127.0.0.1", port=0, token="test-secret", version="test")
        self.ui.start()

    async def asyncTearDown(self):
        await self.ui.close()

    async def request(self, method="GET", path="/api/state", body=None, auth=True, headers=None):
        def read():
            connection = http.client.HTTPConnection("127.0.0.1", self.ui.port, timeout=15)
            values = {"Content-Type": "application/json"}
            if auth:
                values["Authorization"] = "Bearer test-secret"
            values.update(headers or {})
            payload = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
            try:
                connection.request(method, path, payload, values)
                response = connection.getresponse()
                return response.status, dict(response.getheaders()), response.read()
            finally:
                connection.close()
        return await asyncio.to_thread(read)

    async def finish(self, job):
        await self.ui.tasks[job["id"]]
        return self.ui.jobs[job["id"]]

    async def test_static_shell_has_csp_and_no_credentials(self):
        for path, mime in (("/", "text/html"), ("/app.js", "text/javascript"), ("/app.css", "text/css"), ("/favicon.svg", "image/svg+xml")):
            status, headers, data = await self.request(path=path, auth=False)
            self.assertEqual(status, 200)
            self.assertTrue(headers["Content-Type"].startswith(mime))
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
            self.assertNotIn(b"test-secret", data)

    async def test_api_requires_auth_for_reads_and_writes(self):
        for method, path, body in (("GET", "/api/state", None), ("POST", "/api/action", {"action": "stop"})):
            status, headers, _ = await self.request(method, path, body, auth=False)
            self.assertEqual(status, 401)
            self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.p._emergency_stop.assert_not_called()

    async def test_token_in_query_or_wrong_header_is_rejected(self):
        status, _, _ = await self.request(path="/api/state?token=test-secret", auth=False)
        self.assertEqual(status, 401)
        status, _, _ = await self.request(headers={"Authorization": "Bearer wrong"})
        self.assertEqual(status, 401)

    async def test_no_directory_traversal(self):
        for path in ("/../main.py", "/%2e%2e/main.py", "/webui_token.txt", "/_conf_schema.json"):
            self.assertEqual((await self.request(path=path))[0], 404)

    async def test_cross_origin_mutation_rejected(self):
        for headers in ({"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}):
            self.assertEqual((await self.request("POST", "/api/action", {"action": "stop"}, headers=headers))[0], 403)
        self.p._emergency_stop.assert_not_called()

    async def test_same_origin_mutation_accepted(self):
        status, _, raw = await self.request("POST", "/api/action", {"action": "stop"},
                                           headers={"Origin": f"http://127.0.0.1:{self.ui.port}"})
        self.assertEqual(status, 202)
        job = await self.finish(json.loads(raw))
        self.assertEqual(job["status"], "done")
        self.assertTrue(self.p._emergency_stopped)

    async def test_https_reverse_proxy_origin_supported(self):
        status, _, raw = await self.request("POST", "/api/action", {"action": "pause"},
                                           headers={"Host": "mc.example.org", "Origin": "https://mc.example.org"})
        self.assertEqual(status, 202)
        self.assertEqual((await self.finish(json.loads(raw)))["status"], "done")

    async def test_malformed_and_oversized_bodies(self):
        cases = [(b"{", {}, 400), (["stop"], {}, 400), ({"action": "eval"}, {}, 400),
                 ({"action": "say", "text": "x" * 251}, {}, 400),
                 ({"action": "goal", "text": " "}, {}, 400),
                 (b"x" * 4097, {}, 413), ({"action": "stop"}, {"Content-Type": "text/plain"}, 415)]
        for body, headers, expected in cases:
            self.assertEqual((await self.request("POST", "/api/action", body, headers=headers))[0], expected)

    async def test_snapshot_keeps_zero_and_caches_rpc_only(self):
        first = await self.ui.snapshot()
        self.assertEqual(first["state"]["health"], 0)
        self.assertEqual(first["state"]["food"], 0)
        self.assertEqual(first["state"]["inventory"][0]["count"], 8)
        self.p._emergency_stopped = True
        second = await self.ui.snapshot()
        self.assertTrue(second["plugin"]["emergency_stopped"])
        self.assertEqual(self.p.engine.call.await_count, 3)
        self.assertNotIn("token", second)

    async def test_concurrent_pollers_share_engine_snapshot(self):
        values = await asyncio.gather(*(self.ui.snapshot() for _ in range(12)))
        self.assertEqual(len(values), 12)
        self.assertEqual(self.p.engine.call.await_count, 3)

    async def test_engine_failure_does_not_fabricate_game_metrics(self):
        self.p.engine.call.side_effect = RuntimeError("offline")
        snapshot = await self.ui.snapshot()
        self.assertIsNone(snapshot["state"])
        self.assertEqual(len(snapshot["errors"]), 3)
        self.p.engine.running = False
        self.ui._cached_at = 0
        snapshot = await self.ui.snapshot()
        self.assertFalse(snapshot["engine_running"])
        self.assertIsNone(snapshot["engine"])

    async def test_actions_reuse_plugin_controls_and_engine(self):
        self.p.goals = SimpleNamespace()
        for action, method in (("pause", "_pause_play"), ("resume", "_resume_play"), ("abandon", "_abandon_goal"),
                               ("connect", "_auto_connect"), ("disconnect", "_do_disconnect"), ("goal", "_start_player_goal")):
            job = await self.finish(await self.ui.submit({"action": action, "text": "砍 10 根木头"}))
            self.assertEqual(job["status"], "done")
            getattr(self.p, method).assert_awaited()
        self.assertEqual((await self.finish(await self.ui.submit({"action": "say", "text": "你好"})))["status"], "done")
        self.p.engine.say.assert_awaited_once_with("你好")
        await self.finish(await self.ui.submit({"action": "viewer"}))
        self.p.engine.call.assert_any_await("viewer.start", {}, timeout=30)

    async def test_slow_goal_receipt_is_immediate_and_busy_rejected(self):
        gate = asyncio.Event()
        self.p.goals = SimpleNamespace()
        async def goal(_):
            await gate.wait()
            return "目标已开始"
        self.p._start_player_goal.side_effect = goal
        job = await self.ui.submit({"action": "goal", "text": "慢目标"})
        await asyncio.sleep(0)
        self.assertEqual(job["status"], "running")
        with self.assertRaises(web.ApiError) as caught:
            await self.ui.submit({"action": "resume"})
        self.assertEqual(caught.exception.status, 409)
        gate.set()
        self.assertEqual((await self.finish(job))["status"], "done")

    async def test_stop_interrupts_pending_goal_and_no_late_completion(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def goal(_):
            started.set()
            await release.wait()
            self.p.connected = False  # Would prove a late mutation if resumed.
        self.p.goals = SimpleNamespace()
        self.p._start_player_goal.side_effect = goal
        old = await self.ui.submit({"action": "goal", "text": "慢目标"})
        await started.wait()
        stop = await self.ui.submit({"action": "stop"})
        await self.finish(stop)
        release.set()
        await asyncio.gather(self.ui.tasks[old["id"]], return_exceptions=True)
        self.assertEqual(self.ui.jobs[old["id"]]["status"], "cancelled")
        self.assertTrue(self.p.connected)
        self.assertTrue(self.p._emergency_stopped)

    async def test_errors_have_failed_receipts(self):
        self.p._resume_play.side_effect = RuntimeError("恢复失败")
        job = await self.finish(await self.ui.submit({"action": "resume"}))
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["message"], "恢复失败")
        self.p.connected = False
        job = await self.finish(await self.ui.submit({"action": "say", "text": "hi"}))
        self.assertEqual(job["status"], "failed")
        self.p.engine.say.assert_not_awaited()

    async def test_shutdown_cancels_jobs_and_rejects_new_controls(self):
        started = asyncio.Event()
        async def long_resume():
            started.set()
            await asyncio.Event().wait()
        self.p._resume_play.side_effect = long_resume
        job = await self.ui.submit({"action": "resume"})
        await started.wait()
        await self.ui.close()
        self.assertTrue(self.ui.tasks[job["id"]].cancelled())
        self.assertFalse(self.ui.thread.is_alive())
        with self.assertRaises(web.ApiError) as caught:
            await self.ui.submit({"action": "connect"})
        self.assertEqual(caught.exception.status, 503)

    async def test_auto_token_persists_and_configured_token_takes_priority(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            first = web.WebUI.load_token(data)
            self.assertGreaterEqual(len(first), 40)
            self.assertEqual(web.WebUI.load_token(data), first)
            self.assertEqual(web.WebUI.load_token(data, " configured "), "configured")
            self.assertEqual(web.WebUI.load_token(data), first)


if __name__ == "__main__":
    unittest.main(verbosity=2)
