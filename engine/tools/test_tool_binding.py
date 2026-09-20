#!/usr/bin/env python3
"""用**真实的工具注册表**验证：工具在真实 AstrBot 里到底能不能被执行。

**这个测试的存在理由**（很重要，别再删）：

线上真实故障是——模型正确调用了跟随工具，工具却全部报
`tool_mc_goto() missing 1 required positional argument: 'event'`，
所以她"只会回话、不会动"。根因是 AstrBot 的绑定生命周期只处理
`__module__` 等于插件主模块路径的 handler，而本插件的工具定义在
`llm_tools_core.py` 等子模块里，永远匹配不上 → handler 保持**未绑定**。

之前的 `test_game_agent.py` 用的是自己造的假 handler（闭包，已绑定），
**永远发现不了**这个问题。所以这里刻意复刻真实时序：

  1) 先把**未绑定的原始函数**注册进真实的 FunctionToolManager（= 线上状态）
  2) 再走 `plugin.initialize()`（内含 `_bind_llm_tools()` 自愈）
  3) 断言：绑定被修好，且两种调用路径都能真正执行
       - 我们自己的路径：`game_agent._execute_tool(...)`
       - AstrBot 的路径：`handler(event, **kwargs)`（QQ 渠道就是这么调的）

用法：
  $env:PYTHONPATH='D:\\AstrBot\\backend\\app'
  D:\\AstrBot\\backend\\python\\python.exe bot\\tools\\test_tool_binding.py
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import io
import json
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

problems: list[str] = []
passed = 0


def ok(msg):
    global passed
    passed += 1
    print(f"  ✅ {msg}")


def bad(msg):
    problems.append(msg)
    print(f"  ❌ {msg}")


class FakeContext:
    """AstrBot Context 替身：人格库 + **真实**的工具管理器。"""

    def __init__(self, tool_manager):
        self.persona_manager = self._make_pm()
        self.provider_manager = type("PM", (), {"llm_tools": tool_manager})()

    @staticmethod
    def _make_pm():
        class _P:
            persona_id = "default"
            name = "测试人格"
            system_prompt = "你是一个安静的角色。"

        class _PM:
            async def get_all_personas(self):
                return [_P()]

            async def get_default_persona_v3(self, umo=None):
                return {"prompt": _P.system_prompt, "name": _P.name}

            async def get_persona(self, pid):
                if pid == "default":
                    return _P()
                raise ValueError(pid)

        return _PM()

    def add_llm_tools(self, *tools):
        pass

    def get_all_stars(self):
        return []

    async def send_message(self, umo, chain):
        pass


def collect_tool_methods(plugin_cls) -> dict:
    """收集插件类上所有 @llm_tool 方法（拿到的是**未绑定的原始函数**）。"""
    out = {}
    for cls in type.mro(plugin_cls):
        for attr_name, attr in vars(cls).items():
            if callable(attr) and attr_name.startswith("tool_mc_"):
                out[attr_name[len("tool_"):]] = attr
    return out


async def main() -> int:
    print("=== 工具绑定与执行测试（真实注册表 + 真实时序）===\n")

    if not PLUGIN_DIR.exists():
        print(f"❌ 找不到已安装的插件：{PLUGIN_DIR}")
        return 1

    sys.path.insert(0, str(PLUGIN_DIR.parent))
    import importlib

    mod = importlib.import_module(f"{PLUGIN_DIR.name}.main")
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))

    from astrbot.core.provider.func_tool_manager import FunctionToolManager

    tool_methods = collect_tool_methods(mod.MinecraftPlugin)
    if not tool_methods:
        bad("没找到任何工具方法")
        return 1
    ok(f"从插件类上收集到 {len(tool_methods)} 个工具方法（未绑定原始函数）")

    # ---------------------------------------------------------- 1. 复刻线上状态
    print("\n[1] 复刻线上状态：把未绑定函数注册进真实管理器")
    manager = FunctionToolManager()
    for name, fn in tool_methods.items():
        manager.add_func(name=name, func_args=[], desc="测试", handler=fn)

    sample = manager.get_func("mc_status") or manager.get_func(sorted(tool_methods)[0])
    first = list(inspect.signature(sample.handler).parameters)[0]
    if first == "self":
        ok(f"{sample.name} 的 handler 首参 = self（= 未绑定，正是线上故障状态）")
    else:
        bad(f"测试前提不成立：首参是 {first}，不是 self")

    # 顺便验证：这正是 AstrBot 执行工具时会炸的形态
    from astrbot_plugin_mc_player.game_agent import GameEventShim

    shim = GameEventShim("测试玩家")
    try:
        res = sample.handler(shim)
        if inspect.isasyncgen(res):
            async for _ in res:
                pass
        elif inspect.isawaitable(res):
            await res
        bad("未绑定的 handler 竟然执行成功了？测试前提有误")
    except TypeError as exc:
        ok(f"未绑定时确实会失败（复刻成功）：{str(exc)[:70]}")

    # ---------------------------------------------------------- 2. initialize 自愈
    print("\n[2] 走真实 initialize()：应当自动把工具绑定到实例")
    plugin = mod.MinecraftPlugin(FakeContext(manager), cfg)
    await plugin.initialize()

    still_raw = []
    for name in tool_methods:
        func = manager.get_func(name)
        if func is None:
            continue
        h = func.handler
        raw = h.func if isinstance(h, functools.partial) else h
        try:
            params = list(inspect.signature(raw).parameters)
        except (TypeError, ValueError):
            continue
        if params and params[0] == "self":
            # partial 里绑的是不是本实例？
            if not (isinstance(h, functools.partial) and h.args and h.args[0] is plugin):
                still_raw.append(name)

    if still_raw:
        bad(f"这些工具的绑定没修好：{still_raw[:6]}")
    else:
        ok(f"{len(tool_methods)} 个工具已全部绑定到插件实例")

    if not plugin.engine or not plugin.engine.running:
        bad("引擎没起来，无法验证真实执行")
        return 1
    ok("引擎已启动")

    # ---------------------------------------------------------- 3. 真实执行
    from astrbot_plugin_mc_player.game_agent import GameChatAgent

    agent = GameChatAgent(plugin)
    probes = [n for n in ("mc_skills", "mc_status", "mc_players") if n in tool_methods]

    print("\n[3] 我们自己路径：game_agent._execute_tool")
    for name in probes:
        result = await agent._execute_tool(name, {}, shim)
        if result.startswith("error:"):
            bad(f"{name} 执行失败：{result[:110]}")
        else:
            ok(f"{name} 执行成功：{result[:66].replace(chr(10), ' ')}")

    print("\n[4] AstrBot 自己的路径：handler(event, **kwargs)（QQ 渠道走这条）")
    for name in probes:
        func = manager.get_func(name)
        try:
            res = func.handler(shim)
            last = None
            if inspect.isasyncgen(res):
                async for item in res:
                    last = item
            elif inspect.isawaitable(res):
                last = await res
            else:
                last = res
            text = last.get_plain_text() if hasattr(last, "get_plain_text") else str(last)
            if "error" in text.lower() and "缺少" in text:
                bad(f"{name} 经 AstrBot 路径失败：{text[:100]}")
            else:
                ok(f"{name} 经 AstrBot 路径成功：{text[:66].replace(chr(10), ' ')}")
        except Exception as exc:  # noqa: BLE001
            bad(f"{name} 经 AstrBot 路径抛异常：{type(exc).__name__}: {exc}")

    # ---------------------------------------------------------- 5. 幂等性
    print("\n[5] 重复绑定应当是幂等的（AstrBot 之后可能还会自己绑一次）")
    before = manager.get_func(probes[0]).handler
    plugin._bind_llm_tools()
    after = manager.get_func(probes[0]).handler
    if isinstance(after, functools.partial) and after.args[0] is plugin:
        ok("重复调用 _bind_llm_tools 不会破坏已有绑定")
    else:
        bad(f"重复绑定把 handler 弄坏了：{after!r}")

    # ---------------------------------------------------------- 6. 工具集过滤
    print("\n[6] 游戏内工具集应排除 QQ 管理面工具")
    ts = agent._mc_toolset()
    names = set()
    if ts is not None:
        for attr in ("tools", "func_tools", "_tools"):
            tools = getattr(ts, attr, None)
            if tools:
                names = set(tools.keys()) if isinstance(tools, dict) else {
                    getattr(t, "name", "") for t in tools
                }
                break
    leaked = names & {"mc_set_goal", "mc_visit", "mc_her_persona", "mc_goal_pause"}
    if not names:
        bad("游戏内工具集为空")
    elif leaked:
        bad(f"管理面工具泄漏：{sorted(leaked)}")
    else:
        ok(f"工具集 {len(names)} 个，未泄漏管理面工具")

    # ---------------------------------------------------------- 8. 全工具冒烟
    print("\n[8] 把每个工具都真实调用一遍（抓「运行时才炸」的类型错误）")
    # 为什么必要：`await` 一个 async generator 这类错误**只在运行到那一行时才抛**，
    # 工具注册、签名检查、加载测试全都发现不了。实测它让 10 个技能工具全部瘫痪，
    # 还被更早的另一个错误掩盖了很久。所以这里逐个真调。
    real_errors: list[str] = []
    need_args: list[str] = []
    ok_count = 0
    for name in sorted(tool_methods):
        result = await agent._execute_tool(name, {}, shim)
        if not str(result).startswith("error:"):
            ok_count += 1
            continue
        text = str(result)
        # 缺必填参数属于"调用方没给参数"，不是工具本身坏了
        if "required positional argument" in text and "event" not in text:
            need_args.append(name)
        elif "async_generator" in text or "can't be used in 'await'" in text:
            real_errors.append(f"{name}: {text[:90]}")
        else:
            real_errors.append(f"{name}: {text[:90]}")

    if real_errors:
        for e in real_errors:
            bad(e)
    else:
        extra = f"，{len(need_args)} 个缺必填参数（正常）" if need_args else ""
        ok(f"{ok_count} 个工具都能正常执行{extra}")

    print("\n[7] 收尾")
    await plugin.terminate()
    ok("插件已卸载")

    print("\n=== 结果 ===")
    if problems:
        print(f"❌ {len(problems)} 个问题：")
        for p in problems:
            print(f"  ✗ {p}")
        return 1
    print(f"✅ 全部通过（{passed} 项断言）")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
