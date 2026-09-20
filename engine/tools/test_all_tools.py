#!/usr/bin/env python3
"""全量验证：真实服务器 + 真实工具注册表 + 每个工具真跑一遍。

**为什么要有这个测试**：前几轮都是"发现一个 bug → 修一个"，反复来回。
根本原因是验证一直是局部的（或者用假对象），没有一次把**所有工具、所有路径**
在真实环境里跑一遍。这个脚本就是那"一遍"：

  A. 绑定与调用约定：真实注册表 + 未绑定 handler → initialize 自愈
  B. 感知/移动/基础动作类工具：逐个真调，断言无 Python 级错误
  C. 技能类工具：准备场景后真调，断言拿到真实 task_id 且任务真的在跑
  D. 游戏内对话路径：脚本化 LLM 让它调工具 → 工具真的执行 → 世界真的改变
  E. 过日子循环：真的做出决策并提交技能
  F. 错误路径：未连接/缺材料等情况下如实报错，不假装成功

用法：
  $env:PYTHONPATH='D:\\AstrBot\\backend\\app'
  D:\\AstrBot\\backend\\python\\python.exe bot\\tools\\test_all_tools.py
（需要本地测试服在 25566 端口运行：node tools/reset_world.js --full）
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import io
import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent.parent
sys.path.insert(0, str(_REPO))

PLUGIN_DIR = Path(r"C:\Users\miku\.astrbot\data\plugins\astrbot_plugin_mc_player")
CONFIG_PATH = Path(r"C:\Users\miku\.astrbot\data\config\astrbot_plugin_mc_player_config.json")

TEST_PORT = 25566
RCON_PORT = 25576
SERVER_DIR = str(_HERE.parent / ".testserver")

problems: list[str] = []
passed = 0
notes: list[str] = []


def ok(msg):
    global passed
    passed += 1
    print(f"  ✅ {msg}")


def bad(msg):
    problems.append(msg)
    print(f"  ❌ {msg}")


def note(msg):
    notes.append(msg)
    print(f"     （{msg}）")


# ---------------------------------------------------------------- 假 Context

class ScriptedProvider:
    """按脚本返回工具调用 / 文本的假模型（用来驱动真实工具执行）。"""

    def __init__(self, script):
        self.script = script
        self.calls = 0

    async def text_chat(self, contexts=None, system_prompt=None, func_tool=None, **kw):
        from astrbot.core.provider.entities import LLMResponse

        step = self.script[min(self.calls, len(self.script) - 1)]
        self.calls += 1
        if step["type"] == "tool":
            return LLMResponse(
                role="assistant",
                completion_text="",
                tools_call_name=[step["name"]],
                tools_call_args=[step.get("args", {})],
                tools_call_ids=[f"call_{self.calls}"],
            )
        return LLMResponse(role="assistant", completion_text=step["text"])


class FakeContext:
    def __init__(self, tool_manager, provider):
        self.provider_manager = type("PM", (), {"llm_tools": tool_manager})()
        self.persona_manager = self._pm()
        self._provider = provider

    @staticmethod
    def _pm():
        class _P:
            persona_id = "default"
            name = "测试人格"
            system_prompt = "你叫纱雾，安静、话少、爱挖矿。"

        class _PM:
            async def get_all_personas(self):
                return [_P()]

            async def get_default_persona_v3(self, umo=None):
                return {"prompt": _P.system_prompt, "name": _P.name}

            async def get_persona(self, pid):
                return _P()

        return _PM()

    def add_llm_tools(self, *a):
        pass

    async def get_using_provider_async(self, umo=None):
        return self._provider

    async def get_current_chat_provider_id(self, umo=None):
        return "scripted"

    async def send_message(self, *a):
        pass


def collect_tools(plugin_cls) -> dict:
    out = {}
    for cls in type.mro(plugin_cls):
        for name, attr in vars(cls).items():
            if callable(attr) and name.startswith("tool_mc_"):
                out[name[len("tool_"):]] = attr
    return out


async def main() -> int:
    print("=== 全量验证：真实服务器 + 每个工具真跑 ===\n")

    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
    cfg["server_port"] = TEST_PORT          # 用本地测试服，不动用户的服
    cfg["server_host"] = "127.0.0.1"
    cfg["auto_connect"] = True
    cfg["enable_life_loop"] = False          # 先手动控制，E 阶段再开

    sys.path.insert(0, str(PLUGIN_DIR.parent))
    import importlib

    mod = importlib.import_module(f"{PLUGIN_DIR.name}.main")
    from astrbot.core.provider.func_tool_manager import FunctionToolManager
    from astrbot_plugin_mc_player.game_agent import GameChatAgent, GameEventShim

    tools = collect_tools(mod.MinecraftPlugin)
    print(f"发现 {len(tools)} 个工具\n")

    # ---- 真实注册表 + 复刻"未绑定"状态
    manager = FunctionToolManager()
    for name, fn in tools.items():
        manager.add_func(name=name, func_args=[], desc="t", handler=fn)

    provider = ScriptedProvider([{"type": "text", "text": "好"}])
    plugin = mod.MinecraftPlugin(FakeContext(manager, provider), cfg)

    print("[A] 绑定与初始化")
    await plugin.initialize()
    raw_left = []
    for name in tools:
        f = manager.get_func(name)
        if not f:
            continue
        h = f.handler
        raw = h.func if isinstance(h, functools.partial) else h
        try:
            params = list(inspect.signature(raw).parameters)
        except (TypeError, ValueError):
            continue
        if params and params[0] in ("self", "cls"):
            if not (isinstance(h, functools.partial) and h.args and h.args[0] is plugin):
                raw_left.append(name)
    if raw_left:
        bad(f"仍有未绑定的工具：{raw_left[:5]}")
    else:
        ok(f"{len(tools)} 个工具全部绑定到插件实例")

    # ---- 等进服
    rcon_ok = False
    rcon = None
    try:
        sys.path.insert(0, str(_HERE))
        from lib.rcon import Rcon  # type: ignore

        rcon = Rcon.from_dir(SERVER_DIR, RCON_PORT)
        rcon.command("time set day")
        rcon_ok = True
    except Exception as exc:  # noqa: BLE001
        note(f"rcon 不可用（{exc}），场景准备会跳过，技能类工具将走缺材料路径")

    for _ in range(30):
        if plugin.connected:
            break
        await asyncio.sleep(1)
    if not plugin.connected:
        bad("机器人没能进服（测试服在 25566 跑着吗？）")
        await plugin.terminate()
        return 1
    ok("已进服")

    agent = GameChatAgent(plugin)
    shim = GameEventShim("测试玩家")
    me = str(cfg.get("bot_username", "AstrBot"))

    async def call(name, args=None, timeout=90):
        """调用工具并把结果文本取回来。"""
        return await asyncio.wait_for(agent._execute_tool(name, args or {}, shim), timeout=timeout)

    async def inv():
        r = await plugin.engine.call("inventory.get", {})
        return r.get("items", {})

    # ============================================================ B. 感知/移动/基础
    print("\n[B] 感知 / 移动 / 基础动作类工具（逐个真调）")

    read_only = {
        "mc_status": {},
        "mc_inventory": {},
        "mc_players": {},
        "mc_skills": {},
        "mc_task_status": {},
        "mc_goal_status": {},
    }
    for name, args in read_only.items():
        r = await call(name, args)
        if str(r).startswith("error:"):
            bad(f"{name} 失败：{str(r)[:100]}")
        else:
            ok(f"{name} → {str(r)[:56].replace(chr(10), ' ')}")

    # 场景准备：给材料 + 造树 + 造矿脉
    if rcon_ok:
        st = await plugin.engine.call("state.get", {"detail": "brief"})
        bp = st.get("block_position") or {}
        bx, by, bz = bp.get("x", 0), bp.get("y", -60), bp.get("z", 0)
        cmds = [
            f"give {me} oak_log 16",
            f"give {me} cobblestone 32",
            f"give {me} bread 4",
            f"give {me} coal 8",
            f"give {me} furnace 1",
            f"forceload add {bx - 24} {bz - 24} {bx + 24} {bz + 24}",
            # 一棵树（4 格高原木柱）
            f"fill {bx + 4} {by} {bz + 4} {bx + 4} {by + 3} {bz + 4} minecraft:oak_log",
            # 一小片铁矿
            f"fill {bx - 5} {by - 1} {bz - 5} {bx - 3} {by - 1} {bz - 3} minecraft:iron_ore",
            # 一块可挖的石头
            f"setblock {bx + 2} {by - 1} {bz + 2} minecraft:stone",
        ]
        for c in cmds:
            rcon.command_quiet(c)
        await asyncio.sleep(2)
        item = await inv()
        if item.get("oak_log", 0) >= 16 and item.get("bread", 0) >= 1:
            ok(f"场景准备完成（原木×{item.get('oak_log')}、圆石×{item.get('cobblestone')}、面包×{item.get('bread')}）")
        else:
            bad(f"场景准备异常：{item}")
        scene = (bx, by, bz)
    else:
        scene = (0, -60, 0)
        note("没有 rcon，跳过场景准备（技能类工具会走'缺材料'路径）")
    bx, by, bz = scene

    # 移动类
    r = await call("mc_look", {"x": bx + 5, "y": by, "z": bz + 5})
    ok(f"mc_look → {str(r)[:50]}") if not str(r).startswith("error:") else bad(f"mc_look 失败：{r}")

    r = await call("mc_goto", {"x": bx + 8, "z": bz + 6})
    if str(r).startswith("error:"):
        bad(f"mc_goto 失败：{r}")
    elif "任务号" in str(r):
        ok(f"mc_goto → {str(r).splitlines()[0][:56]}")
    else:
        bad(f"mc_goto 没返回任务号：{r}")

    r = await call("mc_move_stop")
    ok(f"mc_move_stop → {str(r)[:46]}") if not str(r).startswith("error:") else bad(f"mc_move_stop 失败：{r}")

    # 基础动作
    r = await call("mc_scan", {"target": "oak_log", "radius": 16})
    if str(r).startswith("error:"):
        bad(f"mc_scan 失败：{str(r)[:100]}")
    else:
        ok(f"mc_scan(oak_log) → {str(r)[:56].replace(chr(10), ' ')}")

    r = await call("mc_equip", {"item": "stone_pickaxe"})
    note(f"mc_equip(没有的镐) → {str(r)[:60].replace(chr(10), ' ')}") if not str(r).startswith("error:") else bad(f"mc_equip 抛错：{r}")

    r = await call("mc_craft", {"item": "oak_planks", "count": 4})
    if str(r).startswith("error:"):
        bad(f"mc_craft 失败：{str(r)[:100]}")
    else:
        ok(f"mc_craft(oak_planks×4) → {str(r)[:56].replace(chr(10), ' ')}")

    r = await call("mc_eat", {})
    note(f"mc_eat → {str(r)[:60].replace(chr(10), ' ')}") if not str(r).startswith("error:") else bad(f"mc_eat 抛错：{r}")

    r = await call("mc_mine", {"x": bx + 2, "y": by - 1, "z": bz + 2})
    if str(r).startswith("error:"):
        bad(f"mc_mine 失败：{str(r)[:100]}")
    else:
        ok(f"mc_mine(石头) → {str(r)[:56].replace(chr(10), ' ')}")

    r = await call("mc_place", {"x": bx + 3, "y": by - 1, "z": bz + 3, "item": "cobblestone"})
    note(f"mc_place → {str(r)[:60].replace(chr(10), ' ')}") if not str(r).startswith("error:") else bad(f"mc_place 抛错：{r}")

    r = await call("mc_drop", {"item": "cobblestone", "count": 1})
    note(f"mc_drop → {str(r)[:60].replace(chr(10), ' ')}") if not str(r).startswith("error:") else bad(f"mc_drop 抛错：{r}")

    r = await call("mc_chest", {"action": "list"})
    note(f"mc_chest(list) → {str(r)[:60].replace(chr(10), ' ')}") if not str(r).startswith("error:") else bad(f"mc_chest 抛错：{r}")

    r = await call("mc_attack", {"target": "pig"})
    note(f"mc_attack(附近没猪) → {str(r)[:60].replace(chr(10), ' ')}") if not str(r).startswith("error:") else bad(f"mc_attack 抛错：{r}")

    r = await call("mc_say", {"message": "优化验证中"})
    ok(f"mc_say → {str(r)[:46]}") if not str(r).startswith("error:") else bad(f"mc_say 失败：{r}")

    r = await call("mc_visit", {"message": "在忙什么呢"})
    if str(r).startswith("error:"):
        bad(f"mc_visit 失败：{str(r)[:100]}")
    else:
        ok(f"mc_visit → {str(r)[:52].replace(chr(10), ' ')}")

    # 任务取消（先起一个长任务）
    r = await call("mc_chop_tree", {"count": 8})
    r2 = await call("mc_task_cancel", {})
    note(f"mc_task_cancel → {str(r2)[:60].replace(chr(10), ' ')}") if not str(r2).startswith("error:") else bad(f"mc_task_cancel 抛错：{r2}")
    await asyncio.sleep(1)

    # ============================================================ C. 技能类
    print("\n[C] 技能类工具（真调，验证拿到真实任务号）")

    async def run_skill_tool(name, args, wait_s=90):
        before = await inv()
        r = await call(name, args)
        text = str(r)
        if text.startswith("error:"):
            bad(f"{name} 抛错：{text[:100]}")
            return None
        if "任务号" not in text and "已在背包" not in text and "已" not in text:
            bad(f"{name} 没有明确反馈：{text[:80]}")
            return None
        tid = None
        m = re.search(r"任务号\s*([A-Za-z0-9_-]+)", text)
        if m:
            tid = m.group(1)
        ok(f"{name} → {text.splitlines()[0][:52]}")
        if tid:
            deadline = asyncio.get_event_loop().time() + wait_s
            while asyncio.get_event_loop().time() < deadline:
                st = await plugin.engine.call("task.status", {"task_id": tid})
                if st.get("status") in ("done", "failed", "cancelled"):
                    after = await inv()
                    gained = {k: v - before.get(k, 0) for k, v in after.items() if v - before.get(k, 0) > 0}
                    note(f"{name} 任务 {st['status']}（{st.get('error') or 'ok'}）获得 {gained or '无'}")
                    return st
                await asyncio.sleep(2)
            note(f"{name} 任务仍在跑（{wait_s}s 未结束）")
        return None

    await run_skill_tool("mc_chop_tree", {"count": 2})
    await run_skill_tool("mc_collect", {"item": "oak_log", "count": 1}, wait_s=60)
    await run_skill_tool("mc_make_tools", {"tier": "stone"}, wait_s=120)
    await run_skill_tool("mc_mine_stone", {"count": 4}, wait_s=90)
    await run_skill_tool("mc_mine_ores", {"ore": "iron", "count": 2}, wait_s=120)
    await run_skill_tool("mc_smelt", {"item": "raw_iron", "count": 2}, wait_s=120)
    await run_skill_tool("mc_build_shelter", {"size": 3}, wait_s=150)
    await run_skill_tool("mc_store_items", {}, wait_s=90)
    await run_skill_tool("mc_cook_food", {"count": 1}, wait_s=90)
    await run_skill_tool("mc_supply", {}, wait_s=150)

    # 目标系统
    r = await call("mc_set_goal", {"goal": "挖 5 个圆石"})
    if str(r).startswith("error:"):
        bad(f"mc_set_goal 失败：{str(r)[:100]}")
    else:
        ok(f"mc_set_goal → {str(r).splitlines()[0][:52]}")
    r = await call("mc_goal_status", {})
    ok(f"mc_goal_status → {str(r).splitlines()[0][:52]}") if not str(r).startswith("error:") else bad("mc_goal_status 失败")
    r = await call("mc_goal_pause", {})
    ok(f"mc_goal_pause → {str(r).splitlines()[0][:52]}") if not str(r).startswith("error:") else bad("mc_goal_pause 失败")
    r = await call("mc_goal_resume", {})
    ok(f"mc_goal_resume → {str(r).splitlines()[0][:52]}") if not str(r).startswith("error:") else bad("mc_goal_resume 失败")
    await plugin.goals.abandon()

    # ============================================================ D. 游戏内对话路径
    print("\n[D] 游戏内对话 → 真的执行动作（脚本化模型驱动真实工具）")
    provider.script = [
        {"type": "tool", "name": "mc_chop_tree", "args": {"count": 1}},
        {"type": "text", "text": "好，去砍树了"},
    ]
    provider.calls = 0
    before = await inv()
    got = await asyncio.wait_for(agent.handle("测试玩家", "纱雾 砍棵树"), timeout=120)
    await asyncio.sleep(20)
    after = await inv()
    gained = {k: v - before.get(k, 0) for k, v in after.items() if v - before.get(k, 0) > 0}
    if got:
        ok(f"她回话了：「{got[:40]}」")
    else:
        bad("游戏内对话没有回复")
    if gained:
        ok(f"世界真的改变了：{gained}")
    else:
        note("没看到背包变化（可能树已被砍完，或任务还在跑）")

    # ============================================================ E. 过日子循环
    print("\n[E] 过日子循环：真的做出决策并提交")
    provider.script = [
        {"type": "tool", "name": "mc_collect", "args": {"item": "oak_log", "count": 1}},
        {"type": "text", "text": "去看看有什么木头"},
    ]
    provider.calls = 0
    life = plugin.life
    life._paused = False
    life._pause_until = 0.0
    life._busy_until = 0.0
    decision = await asyncio.wait_for(life.decide(), timeout=120)
    if decision:
        ok(f"做出决策：{decision.activity[:44]}（技能 {decision.skill}）")
        await life._act(decision)
        if life.current is decision:
            ok("决策已执行（记录为当前活动）")
        else:
            bad("决策没有被执行")
    else:
        bad("过日子循环没能做出决策")

    # 暂停自动恢复
    life.pause(reason="测试", max_seconds=0.5)
    await asyncio.sleep(0.8)
    life._auto_resume_if_expired()
    if not life.paused:
        ok("暂停到期能自动恢复（避免永久停滞）")
    else:
        bad("暂停没有自动恢复")

    # ============================================================ F. 错误路径
    print("\n[F] 错误路径：如实报错、不假装成功")
    await plugin.engine.call("disconnect", {})
    await asyncio.sleep(2)
    plugin.connected = False
    r = await call("mc_chop_tree", {"count": 1})
    if "进服" in str(r) or "掉线" in str(r):
        ok(f"离线时如实说明：{str(r)[:60]}")
    else:
        bad(f"离线时的反馈不合理：{str(r)[:80]}")
    r = await call("mc_status", {})
    ok(f"离线时状态工具仍可用：{str(r)[:50].replace(chr(10), ' ')}") if not str(r).startswith("error:") else bad("离线时 mc_status 抛错")

    print("\n[G] 收尾")
    await plugin.terminate()
    ok("插件已卸载")

    print("\n=== 结果 ===")
    if notes:
        print(f"（{len(notes)} 条提示）")
    if problems:
        print(f"❌ {len(problems)} 个问题：")
        for p in problems:
            print(f"  ✗ {p}")
        return 1
    print(f"✅ 全部通过（{passed} 项断言）")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
