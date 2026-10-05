"""工具契约回归：执行真实工具、NDJSON RPC 和引擎 handler，不连接测试服。"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths  # noqa: E402

_paths.require_astrbot("test_tool_contracts")
_paths.load_plugin()

from astrcraft_plugin.bridge_client import EngineClient, EngineConfig, EngineError  # noqa: E402
from astrcraft_plugin.knowledge import KnowledgeBase  # noqa: E402
from astrcraft_plugin.drives import DriveSystem  # noqa: E402
from astrcraft_plugin.life import LifeDecision, LifeLoop  # noqa: E402
from astrcraft_plugin.llm_tools_core import McPerceptionTools  # noqa: E402
from astrcraft_plugin.llm_tools_life import McLifeTools  # noqa: E402
from astrcraft_plugin.llm_tools_skills import McSkillTools  # noqa: E402
from astrcraft_plugin.memory import MemoryStore  # noqa: E402
from astrbot.core.star.register.star_handler import llm_tools  # noqa: E402

# 只替换游戏连接对象。index.js、RpcPeer、TaskQueue、Actions.withdraw 和
# Navigator.toPlayer 均为仓库实际实现，寻路与容器窗口用模拟游戏状态响应。
# 模拟的位置和箱子用于验证 RPC 最终把参数交给正确动作，整个测试不连接 Minecraft。
NODE_FIXTURE = r"""
const { TaskQueue } = require('./goals');
const { vec3 } = require('./util');
const { Actions } = require('./actions');
const { Navigator } = require('./movement');
class FixtureEngine {
  constructor() {
    this.queue = new TaskQueue();
    this.config = { get: () => true, update: () => {} };
    this.fixtureInventory = { bread: 0 };
    this.fixtureContainers = new Map();
    this.bot = {
      entity: { position: vec3(0, 64, 0), onGround: true },
      players: { Alice: { entity: { position: vec3(4, 64, 6) } } },
      entities: {},
      blockAt: (position) => ({ name: position.y === 63 ? 'stone' : 'chest', position }),
      findBlocks: () => [vec3(2, 64, 0)],
      findBlock: (opts) => {
        const block = { name: 'chest', position: vec3(2, 64, 0) };
        if (opts.maxDistance !== 16 || !opts.matching(block)) throw new Error('附近容器扫描参数错误');
        return block;
      },
      openContainer: async (block) => {
        this.lastOpened = block.position;
        const key = `${block.position.x},${block.position.y},${block.position.z}`;
        if (!this.fixtureContainers.has(key)) this.fixtureContainers.set(key, 5);
        const window = {
          containerItems: () => this.fixtureContainers.get(key) > 0 ? [{ name: 'bread', count: this.fixtureContainers.get(key), type: 1 }] : [],
          items: () => this.fixtureInventory.bread > 0 ? [{ name: 'bread', count: this.fixtureInventory.bread, type: 1 }] : [],
          withdraw: async (type, metadata, count) => {
            if (this.fixtureContainers.get(key) < count) throw new Error('模拟容器库存不足');
            this.lastWithdraw = { type, count };
            this.fixtureContainers.set(key, this.fixtureContainers.get(key) - count);
            this.fixtureInventory.bread += count;
          },
          close: () => { if (this.bot.currentWindow === window) this.bot.currentWindow = null; },
        };
        this.bot.currentWindow = window;
        return window;
      },
      clearControlStates() {},
    };
    this.state = {
      scanBlocks: () => [{ name: 'chest', x: 2, y: 64, z: 0, distance: 2 }],
    };
    this.nav = Object.assign(Object.create(Navigator.prototype), {
      _bot: this.bot,
      goTo: async (p) => {
        this.bot.entity.position = vec3(p.x, p.y ?? 64, p.z);
        return {
          arrived: true, final_position: this.bot.entity.position,
          distance_to_target: 0, fixture_timeout_ms: p.timeoutMs,
        };
      },
      follow: async () => { throw new Error('到玩家身边不应该进入持续跟随'); },
      stop() {},
    });
    this.nav.toPlayer = async (target, opts) => ({
      ...(await Navigator.prototype.toPlayer.call(this.nav, target, opts)),
      fixture_timeout_ms: opts.timeoutMs, final_position: this.bot.entity.position,
    });
    this.actions = new Actions({ bot: this.bot, config: this.config, navigator: this.nav });
    const withdraw = this.actions.withdraw.bind(this.actions);
    this.actions.withdraw = async (p) => ({
      ...(await withdraw(p)),
      fixture_params: { ...p, ...this.lastOpened }, fixture_withdraw: this.lastWithdraw,
    });
  }
  assertCanAct() {}
  requireBot() { return this.bot; }
  ensureChunks() { return Promise.resolve(); }
  submitAction(p) { return this.queue.submit(p); }
  cancelAll(reason) { return { ok: true, cancelled: this.queue.cancelAll({ reason }) }; }
  shutdown() { this.queue.cancelAll({ reason: 'fixture exit' }); }
}
const filename = require.resolve('./bot');
require.cache[filename] = { id: filename, filename, loaded: true, exports: { McEngine: FixtureEngine } };
require('./index');
"""


class Event:
    def __init__(self, sender: str = ""):
        self._sender = sender

    def plain_result(self, text: str) -> str:
        return text


class ToolHost(McPerceptionTools, McLifeTools, McSkillTools):
    def __init__(self, engine=None, knowledge=None):
        self.engine = engine
        self.knowledge = knowledge
        self.connected = True
        self.notifications = []

    async def _ensure_engine(self):
        return self.engine is not None and self.engine.running

    async def _notify_subscribers(self, text):
        self.notifications.append(text)


async def tool_text(generator) -> str:
    return "\n".join([text async for text in generator])


class RecordingClient(EngineClient):
    def __init__(self, config):
        super().__init__(config)
        self.calls = []
        self.replies = []

    async def call(self, method, params=None, *, timeout=30.0):
        self.calls.append((method, params, timeout))
        result = await super().call(method, params, timeout=timeout)
        self.replies.append((method, result))
        return result


class RpcContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = RecordingClient(EngineConfig(engine_dir=_paths.ENGINE_DIR))
        env = dict(os.environ, MC_ENGINE_LOG_LEVEL="error")
        self.client._proc = await asyncio.create_subprocess_exec(
            self.client._cfg.resolve_node(), "-e", NODE_FIXTURE,
            cwd=str(_paths.ENGINE_DIR),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=env,
        )
        self.client._reader_task = asyncio.create_task(self.client._read_loop())
        self.client._stderr_task = asyncio.create_task(self.client._drain_stderr())
        ready = await self.client._wait_ready(timeout=10.0)
        self.assertIsNotNone(ready, "fixture 未就绪：" + "\n".join(self.client._last_stderr))
        self.host = ToolHost(self.client)

    async def asyncTearDown(self):
        await self.client.stop()

    async def await_task(self, task_id):
        for _ in range(60):
            result = await self.client.call("task.status", {"task_id": task_id}, timeout=3.0)
            if result.get("status") in {"done", "failed", "cancelled"}:
                return result
            await asyncio.sleep(0.02)
        self.fail("有限移动任务未结束")

    async def test_goto_player_finishes_and_frees_queue(self):
        output = await tool_text(self.host.tool_mc_goto(Event(), player="Alice"))
        self.assertIn("任务号", output)
        self.assertEqual(self.client.calls[0][0:2], (
            "move.to_player", {"target": "Alice", "timeout_ms": 60000},
        ))
        task = self.client.replies[0][1]
        status = await self.await_task(task["task_id"])
        self.assertEqual(status["status"], "done", status)
        self.assertTrue(status["result"]["arrived"])
        self.assertEqual(status["result"]["fixture_timeout_ms"], 60000)
        self.assertEqual(status["result"]["final_position"], {"x": 4, "y": 64, "z": 6})
        # 到达后能接受下一次有限移动，而不是一直占据身体。
        await tool_text(self.host.tool_mc_goto(Event(), x=8, z=9))
        next_task = next(result for method, result in reversed(self.client.replies) if method == "move.to")
        self.assertEqual((await self.await_task(next_task["task_id"]))["status"], "done")

    async def test_implicit_game_sender_uses_finite_goto(self):
        await tool_text(self.host.tool_mc_goto(Event("Alice")))
        self.assertEqual(self.client.calls[0][0], "move.to_player")
        self.assertEqual(self.client.calls[0][1]["target"], "Alice")
        status = await self.await_task(self.client.replies[0][1]["task_id"])
        self.assertEqual(status["status"], "done", status)

    async def test_take_items_resolves_nearby_container(self):
        output = await tool_text(self.host.tool_mc_take_items(Event(), item="bread", count=2))
        self.assertEqual(self.client.calls[0][0:2], ("container.withdraw", {"item": "bread", "count": 2}))
        self.assertIn("bread×2", output)
        result = self.client.replies[0][1]
        self.assertTrue(result["ok"])
        args = result["fixture_params"]
        self.assertEqual((args["x"], args["y"], args["z"]), (2, 64, 0))
        self.assertEqual((args["item"], args["count"]), ("bread", 2))

    async def test_withdraw_explicit_coords_and_invalid_partial_coords(self):
        result = await self.client.call("container.withdraw", {
            "item": "bread", "count": 1, "x": 12, "y": 64, "z": -3,
        }, timeout=3.0)
        args = result["fixture_params"]
        self.assertEqual((args["x"], args["y"], args["z"]), (12, 64, -3))
        with self.assertRaises(EngineError):
            await self.client.call("container.withdraw", {"item": "bread", "x": 12}, timeout=3.0)


class PlanContracts(unittest.IsolatedAsyncioTestCase):
    async def test_registered_schema_explains_parameterized_json_plan(self):
        schema = llm_tools.get_func("mc_plan_do").parameters
        self.assertEqual(schema["properties"]["steps"]["type"], "string")
        description = schema["properties"]["steps"]["description"]
        self.assertIn("JSON", description)
        self.assertIn('"params":{"count":4}', description)
        self.assertIn('"tier":"stone"', description)
        self.assertEqual(schema["properties"]["why"]["type"], "string")

    async def asyncSetUp(self):
        self.data = tempfile.TemporaryDirectory()
        self.addCleanup(self.data.cleanup)
        self.calls = []

        async def engine(method, params=None, **kwargs):
            self.calls.append((method, params))
            return {"task_id": f"t{len(self.calls)}"}

        async def brief():
            return "血量20，饱食度20"

        async def system():
            return "你是 Minecraft 玩家"

        async def llm(*args):
            self.fail("执行已知计划时不应重新调用模型")

        root = Path(self.data.name)
        self.loop = LifeLoop(
            engine_call=engine, memory=MemoryStore(root), drives=DriveSystem(root),
            brief_provider=brief, system_prompt_provider=system, llm=llm,
            is_connected=lambda: True,
        )
        self.loop._known_skills = {"chop_tree", "make_tools", "mine_stone"}
        self.host = ToolHost()
        self.host.life = self.loop

    async def test_json_plan_keeps_skill_parameters_through_execution(self):
        steps = [
            {"skill": "chop_tree", "params": {"count": 4}, "why": "先取木头"},
            {"skill": "make_tools", "params": {"tier": "stone", "kinds": ["pickaxe", "axe"]}},
        ]
        output = await tool_text(self.host.tool_plan_do(Event(), steps=json.dumps(steps), why="准备下矿"))
        self.assertIn("记下了 2 步", output)
        self.assertEqual(self.loop._pending_plan[0], steps[0])
        self.loop._set_plan(self.loop._pending_plan, source="agent")
        self.loop._pending_plan = []
        for expected in steps:
            step = self.loop._pop_plan_step()
            self.assertEqual(step["skill"], expected["skill"])
            self.assertEqual(step["params"], expected["params"])
            await self.loop._act(LifeDecision(
                activity=step["skill"], drive="gather", skill=step["skill"],
                params=step["params"], reason=step["why"],
            ))
        self.assertIsNone(self.loop._pop_plan_step())
        self.assertEqual(self.calls, [
            ("skill.run", {"skill": step["skill"], "params": {
                **step["params"], **({"safe_search": True} if step["skill"] == "make_tools" else {}),
            }}) for step in steps
        ])
        self.assertEqual(steps[1]["params"], {"tier": "stone", "kinds": ["pickaxe", "axe"]},
                         "the autonomous boundary adds safety to its dispatched copy, not the original goal")

    async def test_plain_skill_names_still_accept_commas_and_newlines(self):
        output = await tool_text(self.host.tool_plan_do(Event(), steps=" chop_tree, \n make_tools\nmine_stone "))
        self.assertIn("记下了 3 步", output)
        self.assertEqual(self.loop._pending_plan, [
            {"skill": name, "params": {}, "why": ""} for name in ("chop_tree", "make_tools", "mine_stone")
        ])

    async def test_invalid_json_preserves_existing_and_pending_plans(self):
        self.loop._set_plan([{"skill": "mine_stone", "params": {"count": 6}}], source="agent")
        self.loop.note_plan_from_agent([{"skill": "chop_tree", "params": {"count": 2}}])
        active_before = json.dumps(self.loop._plan, sort_keys=True)
        pending_before = json.dumps(self.loop._pending_plan, sort_keys=True)
        for invalid in (
            '[{"skill":"chop_tree",]',
            '{"skill":"chop_tree"}',
            '[{"skill":"chop_tree"},{"skill":"make_tools","params":[]}]',
            '[{"skill":"chop_tree"},null]',
            '[{"skill":42}]',
            '[{"skill":""}]',
        ):
            with self.subTest(steps=invalid):
                output = await tool_text(self.host.tool_plan_do(Event(), steps=invalid))
                self.assertIn("JSON", output)
                self.assertIn("之前的计划已保留", output)
                self.assertEqual(json.dumps(self.loop._plan, sort_keys=True), active_before)
                self.assertEqual(json.dumps(self.loop._pending_plan, sort_keys=True), pending_before)
        self.assertEqual(self.calls, [])


class DirectSkillContracts(unittest.IsolatedAsyncioTestCase):
    def make_host(self, state):
        import test_supply_resume as S
        loop = S.SupplyResumeTests.make_loop(self, state)
        loop.note_unblocked()
        engine = SimpleNamespace(running=True, run_skill=AsyncMock(return_value={"task_id": "direct-work"}))
        host = ToolHost(engine)
        host.life = loop
        return host

    async def test_autonomous_outdoor_tool_uses_fresh_home_and_task_world_without_mutating_goal(self):
        import test_base_food as B
        home = B.record()
        state = {"server": home["server"], "dimension": home["dimension"], "health": 20, "food": 20,
                 "inventory": {"bread": 4, "stone_pickaxe": 1}, "position": {"x": 40, "y": 64, "z": 40},
                 "is_night": False, "home_status": {"condition": "missing", "safe": False, "loaded": True, "inside": False}}
        host = self.make_host(state)
        host.life.remember_home(home)
        host.life._return_boundary_state = {"server": "stale-cache", "dimension": "the_nether"}
        params = {"count": 8, "radius": 9}
        original = copy.deepcopy(params)
        plan_before, pending_before = copy.deepcopy(host.life._plan), copy.deepcopy(host.life._pending_plan)
        fresh = {"is_night": False, **copy.deepcopy(state)}
        with patch.object(host.life, "_gather_state", wraps=host.life._gather_state) as gather, \
                patch.object(host.life, "register_task_submission", wraps=host.life.register_task_submission) as register:
            event = SimpleNamespace(astrcraft_autonomous=True, plain_result=lambda text: text)
            output = await host._submit_skill(event, "mine_stone", params, "挖圆石")
        self.assertIn("任务号 direct-work", output)
        self.assertGreaterEqual(gather.await_count, 1)
        register.assert_called_once()
        self.assertEqual(register.call_args.kwargs["state"], fresh)
        self.assertEqual(host.life._return_task_attempt["world"], (home["server"], home["dimension"]))
        skill, dispatched = host.engine.run_skill.await_args.args
        self.assertEqual(skill, "mine_stone")
        protected = dispatched["protected_home"]
        self.assertEqual(protected["origin"], home["origin"])
        self.assertEqual(protected["server"], home["server"])
        self.assertEqual({key: value for key, value in dispatched.items() if key != "protected_home"}, original)
        self.assertEqual(params, original)
        self.assertEqual(host.life._plan, plan_before)
        self.assertEqual(host.life._pending_plan, pending_before)

    async def test_manual_skill_does_not_add_autonomous_protection_or_submission_ownership(self):
        import test_base_food as B
        home = B.record()
        state = {"server": home["server"], "dimension": home["dimension"], "health": 20, "food": 20,
                 "inventory": {"bread": 4}, "position": {"x": 40, "y": 64, "z": 40}}
        host = self.make_host(state)
        host.life.remember_home(home)
        host.life._set_plan([{"skill": "mine_stone", "params": {"count": 6}, "why": "previous plan"}])
        host.life.note_plan_from_agent([{"skill": "chop_tree", "params": {"count": 2}}])
        plan_before, pending_before = copy.deepcopy(host.life._plan), copy.deepcopy(host.life._pending_plan)
        params = {"count": 3}
        with patch.object(host.life, "_gather_state", new=AsyncMock(side_effect=AssertionError("manual command must not add an autonomous check"))), \
                patch.object(host.life, "register_task_submission", wraps=host.life.register_task_submission) as register:
            output = await host._submit_skill(Event(), "mine_stone", params, "手动挖圆石")
        self.assertIn("任务号 direct-work", output)
        host.engine.run_skill.assert_awaited_once_with("mine_stone", {"count": 3})
        register.assert_not_called()
        self.assertEqual(params, {"count": 3})
        self.assertEqual(host.life._plan, plan_before)
        self.assertEqual(host.life._pending_plan, pending_before)


class KnowledgeContracts(unittest.IsolatedAsyncioTestCase):
    async def test_registered_docs_only_for_both_entry_points(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            docs = root / "skills_docs"
            docs.mkdir()
            (docs / "mining.md").write_text("合法攻略", encoding="utf-8")
            (root / "private.md").write_text("不该读到的内容", encoding="utf-8")
            kb = KnowledgeBase(docs_dir=docs)
            host = ToolHost(knowledge=kb)
            self.assertEqual(kb.read_doc(" MINING.md "), "合法攻略")
            self.assertEqual(await tool_text(host.tool_load_skill(Event(), name="mining.md")), "合法攻略")
            for name in ("../private", "..\\private", str(root / "private"), "mining.md.md", "missing"):
                with self.subTest(name=name):
                    self.assertIsNone(kb.read_doc(name))
                    output = await tool_text(host.tool_load_skill(Event(), name=name))
                    self.assertIn("没有", output)
                    self.assertNotIn("不该读到的内容", output)
            self.assertEqual(len(host.notifications), 1)
            self.assertEqual(await tool_text(host.tool_load_skill(Event())), "可以读的攻略：mining")

    async def test_external_symlink_not_registered(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            docs = root / "skills_docs"
            docs.mkdir()
            private = root / "private.md"
            private.write_text("外部内容", encoding="utf-8")
            try:
                (docs / "link.md").symlink_to(private)
            except OSError as exc:
                self.skipTest(f"当前账户不能创建文件符号链接：{exc}")
            kb = KnowledgeBase(docs_dir=docs)
            self.assertEqual(kb.docs(), [])
            self.assertIsNone(kb.read_doc("link"))

    async def test_lessons_keep_distinct_ores_tools_and_quantities(self):
        with tempfile.TemporaryDirectory() as td:
            kb = KnowledgeBase(Path(td))
            iron = "挖铁矿前必须先用石镐，木镐挖不动"
            diamond = "挖钻石矿前必须先用铁镐，石镐挖不动"
            self.assertIn("记住了", kb.add_lesson(iron, tags=["mine_ores"]))
            self.assertIn("记住了", kb.add_lesson(diamond, tags=["mine_ores"]))
            self.assertEqual(len(kb.lessons()), 2)
            self.assertIn("很像", kb.add_lesson(iron, tags=["mine_ores"]))
            kb.add_lesson("下矿前带8个火把，洞里黑就先照亮")
            kb.add_lesson("下矿前带32个火把，洞里黑就先照亮")
            self.assertEqual(len(kb.lessons()), 4)
            self.assertIn("记住了", kb.add_lesson("挖铁矿前必须先用木镐，石镐挖不动"))
            kb.add_lesson("挖石头前先确认手上有镐，没有就先做一把")
            self.assertIn("很像", kb.add_lesson("挖石头前一定要先看看有没有镐"))
            reloaded = KnowledgeBase(Path(td))
            self.assertEqual(len(reloaded.lessons()), 6)
            self.assertIn(diamond, [entry["text"] for entry in reloaded.lessons()])


class RunnerContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("astrcraft_run_all", _paths.DEV_TOOLS / "run_all.py")
        cls.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.runner)

    def run_result(self, status, name="test_fixture.py"):
        result = {"name": name, "status": status, "summary": "fixture", "detail": "", "output": "", "secs": 0}
        output = io.StringIO()
        with patch.object(sys, "argv", ["run_all.py"]), \
                patch.object(self.runner, "discover", return_value=[Path(name)]), \
                patch.object(self.runner, "port_open", return_value=False), \
                patch.object(self.runner, "needs_server", return_value=False), \
                patch.object(self.runner, "run_one", return_value=result), \
                contextlib.redirect_stdout(output):
            code = self.runner.main()
        return code, output.getvalue()

    def test_failed_or_unfinished_scripts_always_fail_suite(self):
        for status in ("timeout", "error", "fail"):
            for name in ("test_fixture.py", "test_survival_chain.js"):
                with self.subTest(status=status, name=name):
                    code, output = self.run_result(status, name)
                    self.assertNotEqual(code, 0)
                    self.assertNotIn("全部通过", output)
        code, output = self.run_result("ok")
        self.assertEqual(code, 0)
        self.assertIn("已执行检查全部通过", output)
        code, output = self.run_result("skip")
        self.assertEqual(code, 0)
        self.assertIn("另有跳过", output)

    def test_process_launch_errors_and_timeouts_are_reported(self):
        for exception, expected in ((PermissionError("fixture"), "error"),
                                    (subprocess.TimeoutExpired("fixture", 1), "timeout")):
            with self.subTest(status=expected), patch.object(self.runner.subprocess, "run", side_effect=exception):
                result = self.runner.run_one(Path("test_fixture.py"), timeout=1)
                self.assertEqual(result["status"], expected)

    def test_skip_status_requires_an_explicit_environment_marker(self):
        for output in ("⏭  SKIP：需要实际配置", "[fixture] SKIP unavailable", "跳过：需要 AstrBot",
                       "[5] 已跳过进服测试（设 MC_TEST_CONNECT=1 启用）"):
            with self.subTest(output=output):
                self.assertEqual(self.runner.parse_result(output, 0)[0], "SKIP")
        self.assertEqual(self.runner.parse_result("跳过手动补位\n38/38 passed", 0)[0], "38/38 passed")
        self.assertNotEqual(self.runner.parse_result("PASS 已跳过危险方向", 0)[0], "SKIP")


if __name__ == "__main__":
    unittest.main(verbosity=2)
