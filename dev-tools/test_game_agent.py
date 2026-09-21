#!/usr/bin/env python3
"""游戏内对话代理（game_agent）测试：验证工具调用循环真的能驱动动作。

这是"她在游戏里只会说不会做"的修复验证。用假的 provider 模拟模型决策：
  第一轮：模型要求调 mc_chop_tree(count=2)
  第二轮：模型返回最终文字
断言：
  - 工具真的被执行了（handler 被调到）
  - 工具结果以 role=tool 的消息喂回了上下文
  - 最终返回模型的话

用法：
  $env:PYTHONPATH='D:\\AstrBot\\backend\\app'
  D:\\AstrBot\\backend\\python\\python.exe bot\\tools\\test_game_agent.py
"""

from __future__ import annotations

import asyncio
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

problems: list[str] = []
passed = 0


def ok(msg):
    global passed
    passed += 1
    print(f"  ✅ {msg}")


def bad(msg):
    problems.append(msg)
    print(f"  ❌ {msg}")


# ---------------------------------------------------------------- 假对象

from astrbot.core.provider.entities import LLMResponse


class FakeFuncTool:
    """模拟 FunctionToolManager 里的 FuncTool。"""

    def __init__(self, name, handler):
        self.name = name
        self.handler = handler
        self.description = f"测试工具 {name}"
        self.parameters = {"type": "object", "properties": {}}
        self.active = True


class FakeToolManager:
    def __init__(self, handlers: dict):
        self.func_list = [FakeFuncTool(name, h) for name, h in handlers.items()]

    def get_func(self, name):
        for t in self.func_list:
            if t.name == name:
                return t
        return None


class FakeProviderManager:
    def __init__(self, manager):
        self.llm_tools = manager


class FakeProvider:
    """模拟模型：按脚本返回工具调用或最终文字。"""

    def __init__(self, script: list):
        self.script = script
        self.calls: list[dict] = []

    async def text_chat(self, contexts=None, system_prompt=None, func_tool=None, tool_calls_result=None, **kw):
        self.calls.append(
            {
                "contexts_count": len(contexts or []),
                "contexts_roles": [getattr(c, "role", None) or (c.get("role") if isinstance(c, dict) else None) for c in (contexts or [])],
                "system_prompt_len": len(system_prompt or ""),
                "has_tools": func_tool is not None,
            }
        )
        step = self.script[min(len(self.calls) - 1, len(self.script) - 1)]
        if step["type"] == "tool_call":
            return LLMResponse(
                role="assistant",
                completion_text="",
                tools_call_name=[step["name"]],
                tools_call_args=[step["args"]],
                tools_call_ids=[step.get("id", "call_1")],
            )
        return LLMResponse(role="assistant", completion_text=step["text"])


class FakePersona:
    async def build_system_prompt(self, *, extra=None, umo=None):
        return "你是测试人格。" + ("\n" + extra if extra else "")


class FakeMemory:
    def recall(self, query, limit=5):
        return []

    def render_for_prompt(self, entries):
        return ""


class FakePlugin:
    """模拟插件实例（game_agent 复用的那些东西）。"""

    def __init__(self, provider, manager):
        self.context = type(
            "Ctx",
            (),
            {
                "provider_manager": FakeProviderManager(manager),
                "get_using_provider_async": staticmethod(lambda: provider),
            },
        )()
        self._provider = provider

    async def _system_prompt_for_mc(self, extra=None):
        return "你是测试人格。" + ("\n" + extra if extra else "")

    async def _get_brief(self, max_age=8.0):
        return "位置 (0, 64, 0) 主世界 | 生命 20/20"

    async def _my_memory(self, query, limit=4):
        return ""


# ---------------------------------------------------------------- 测试主体

async def main() -> int:
    print("=== 游戏内对话代理测试 ===\n")

    from plugin.game_agent import GameChatAgent, GameEventShim

    # ---------------------------------------------------------- 1. 工具调用循环
    print("[1] 玩家说「砍树」→ 模型决定调工具 → 工具被执行 → 回话")

    executed: list[tuple] = []

    async def chop_handler(event, count=1):
        executed.append(("mc_chop_tree", count, event.unified_msg_origin))
        yield event.plain_result(f"已开始砍树，任务号 t123")

    async def goto_handler(event, player="", x=0.0, z=0.0):
        executed.append(("mc_goto", player or (x, z)))
        yield event.plain_result("已让机器人前往，任务号 t456")

    handlers = {
        "mc_chop_tree": chop_handler,
        "mc_goto": goto_handler,
        "mc_status": lambda e: None,  # 不带 handler 签名的也能兜底
        "mc_set_goal": lambda e: None,  # 在 GAME_ONLY_EXCLUDE 里，不该进游戏内工具集
        "some_other_tool": lambda e: None,  # 非 mc_ 前缀，不该被选中
    }
    manager = FakeToolManager(handlers)

    script = [
        {"type": "tool_call", "name": "mc_chop_tree", "args": {"count": 2}, "id": "call_a1"},
        {"type": "text", "text": "好嘞，我去砍树了"},
    ]
    provider = FakeProvider(script)
    plugin = FakePlugin(provider, manager)

    # get_using_provider_async 需要是协程
    async def get_provider():
        return provider

    plugin.context.get_using_provider_async = get_provider

    agent = GameChatAgent(plugin)
    reply = await agent.handle("张三", "纱雾 去砍两棵树")

    if executed and executed[0][0] == "mc_chop_tree" and executed[0][1] == 2:
        ok(f"工具真的被执行了：mc_chop_tree(count=2)")
    else:
        bad(f"工具没被执行或参数不对：{executed}")

    if reply == "好嘞，我去砍树了":
        ok(f"最终回复来自模型：「{reply}」")
    else:
        bad(f"最终回复不对：{reply!r}")

    # 验证上下文结构：user → assistant(带 tool_calls) → tool(结果) → 第二轮
    second_call = provider.calls[1] if len(provider.calls) >= 2 else None
    if second_call and "tool" in second_call["contexts_roles"] and "assistant" in second_call["contexts_roles"]:
        ok(f"工具结果以 role=tool 喂回了上下文：{second_call['contexts_roles']}")
    else:
        bad(f"第二轮上下文结构不对：{second_call}")

    if provider.calls[0]["has_tools"]:
        ok("第一轮调用带了工具集")
    else:
        bad("第一轮调用没带工具集——模型根本看不到工具")

    # ---------------------------------------------------------- 2. 多步调用
    print("\n[2] 连续两个工具调用（跟随 + 砍树）")
    executed.clear()
    script2 = [
        {"type": "tool_call", "name": "mc_goto", "args": {"player": "张三"}, "id": "call_b1"},
        {"type": "tool_call", "name": "mc_chop_tree", "args": {"count": 1}, "id": "call_b2"},
        {"type": "text", "text": "我过去找你，顺便砍点木头"},
    ]
    provider2 = FakeProvider(script2)
    plugin2 = FakePlugin(provider2, manager)

    async def get_provider2():
        return provider2

    plugin2.context.get_using_provider_async = get_provider2
    agent2 = GameChatAgent(plugin2)
    reply2 = await agent2.handle("张三", "跟着我，砍一棵树")

    names = [e[0] for e in executed]
    if names == ["mc_goto", "mc_chop_tree"]:
        ok(f"两个工具按顺序执行了：{names}")
    else:
        bad(f"工具执行顺序不对：{names}")

    if reply2 == "我过去找你，顺便砍点木头":
        ok("最终回复正确")
    else:
        bad(f"最终回复不对：{reply2!r}")

    # ---------------------------------------------------------- 3. 纯聊天（模型不调工具）
    print("\n[3] 闲聊（模型直接回话，不调工具）")
    executed.clear()
    script3 = [{"type": "text", "text": "今天天气真好"}]
    provider3 = FakeProvider(script3)
    plugin3 = FakePlugin(provider3, manager)

    async def get_provider3():
        return provider3

    plugin3.context.get_using_provider_async = get_provider3
    agent3 = GameChatAgent(plugin3)
    reply3 = await agent3.handle("张三", "纱雾 早上好")
    if reply3 == "今天天气真好" and not executed:
        ok("纯聊天不触发工具，直接回话")
    else:
        bad(f"纯聊天路径不对：reply={reply3!r} executed={executed}")

    # ---------------------------------------------------------- 4. 工具执行失败 → 如实回给模型
    print("\n[4] 工具抛异常 → 错误如实回给模型，循环不崩")

    async def broken_handler(event, **kw):
        raise RuntimeError("引擎未运行")

    handlers4 = {"mc_chop_tree": broken_handler}
    manager4 = FakeToolManager(handlers4)
    captured_results: list[str] = []

    class SpyProvider(FakeProvider):
        async def text_chat(self, contexts=None, **kw):
            for c in contexts or []:
                role = getattr(c, "role", None)
                if role == "tool":
                    captured_results.append(getattr(c, "content", ""))
            return await super().text_chat(contexts=contexts, **kw)

    script4 = [
        {"type": "tool_call", "name": "mc_chop_tree", "args": {}, "id": "call_c1"},
        {"type": "text", "text": "抱歉，引擎好像没起来"},
    ]
    provider4 = SpyProvider(script4)
    plugin4 = FakePlugin(provider4, manager4)

    async def get_provider4():
        return provider4

    plugin4.context.get_using_provider_async = get_provider4
    agent4 = GameChatAgent(plugin4)
    reply4 = await agent4.handle("张三", "砍树")

    if captured_results and "error" in captured_results[0] and "引擎未运行" in captured_results[0]:
        ok(f"工具异常如实回给模型：{captured_results[0][:50]}")
    else:
        bad(f"工具异常没如实回传：{captured_results}")

    if reply4 == "抱歉，引擎好像没起来":
        ok("模型拿到错误后能如实告知玩家")
    else:
        bad(f"模型没拿到错误：reply={reply4!r}")

    # ---------------------------------------------------------- 5. 工具集过滤
    print("\n[5] 工具集过滤：mc_* 且不在排除名单里的工具才会被带进去")
    ts = agent._mc_toolset()
    if ts is not None:
        names_in_set = set()
        for attr in ("tools", "func_tools", "_tools"):
            tools = getattr(ts, attr, None)
            if tools:
                if isinstance(tools, dict):
                    names_in_set = set(tools.keys())
                else:
                    names_in_set = {getattr(t, "name", "") for t in tools}
                break
        if (
            "mc_chop_tree" in names_in_set
            and "some_other_tool" not in names_in_set
            and "mc_set_goal" not in names_in_set
        ):
            ok(f"工具集过滤正确（{len(names_in_set)} 个）：排除了非 mc_ 前缀与 QQ 管理面工具")
        else:
            bad(f"工具集过滤不对：{sorted(names_in_set)}")
    else:
        bad("工具集为空")

    # ---------------------------------------------------------- 6. 玩家指派 → 暂停过日子
    print("\n[6] 玩家让她做事时，过日子循环被暂停")

    class FakeLife:
        def __init__(self):
            self.paused = False
            self.pause_calls = 0

        def pause(self):
            self.paused = True
            self.pause_calls += 1

    executed.clear()
    script6 = [
        {"type": "tool_call", "name": "mc_chop_tree", "args": {"count": 1}, "id": "call_d1"},
        {"type": "text", "text": "好，这就去"},
    ]
    provider6 = FakeProvider(script6)
    plugin6 = FakePlugin(provider6, manager)
    plugin6.life = FakeLife()

    async def get_provider6():
        return provider6

    plugin6.context.get_using_provider_async = get_provider6
    agent6 = GameChatAgent(plugin6)
    await agent6.handle("张三", "纱雾 砍一棵树")

    if plugin6.life.paused and plugin6.life.pause_calls == 1:
        ok("执行了玩家指派的工具 → 过日子循环已暂停")
    else:
        bad(f"过日子循环没被暂停：paused={plugin6.life.paused} calls={plugin6.life.pause_calls}")

    # 纯聊天不该暂停
    plugin6.life = FakeLife()
    executed.clear()
    script6b = [{"type": "text", "text": "早"}]
    provider6b = FakeProvider(script6b)

    async def get_provider6b():
        return provider6b

    plugin6.context.get_using_provider_async = get_provider6b
    await agent6.handle("张三", "纱雾 早上好")
    if not plugin6.life.paused:
        ok("纯聊天不会暂停过日子循环")
    else:
        bad("纯聊天也暂停了过日子循环")

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
