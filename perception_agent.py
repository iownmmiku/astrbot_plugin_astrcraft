"""感知代理：让「过日子」的 LLM 能**自己查看**，再决定做什么。

## 为什么需要它

之前的决策路径是：

    拼一段固定简报 → llm_generate（**没有任何工具**）→ 生成一句 JSON 决定

也就是说她"决定要干什么"的时候，只能看那一小段简报，**不能主动去看**：
背包里到底有什么、附近有没有树、天还有多久黑、旁边有没有怪。

真人不是这样——真人会先看一圈再决定。结果是她的决定经常和现实脱节
（比如身上没木头却决定去做工具），然后失败、再决定、再失败。

这个模块给决策补上一个**只读**的小工具循环：

    LLM（带感知工具）→ 决定查看什么 → 执行 → 结果喂回 → …… → 输出最终决定 JSON

## 为什么只给只读工具

动作类工具（mc_goto / mc_chop_tree …）是"决定之后"才该用的，属于执行层。
如果决策阶段也能随手调它们，就会出现"还没决定就先动手"的混乱，
而且决策阶段本来就不该产生副作用。所以这里只放感知类：
状态、背包、扫描、玩家、技能清单、记忆。
"""

from __future__ import annotations

import inspect
import json
from typing import Any

from astrbot.api import logger

from astrbot.core.agent.message import (
    AssistantMessageSegment,
    Message,
    ToolCallMessageSegment,
)
from astrbot.core.agent.tool import ToolSet

# 允许决策阶段调用的工具。
#
# 为什么是这几个：它们回答的正是"我该干什么"需要知道的事——
#   我在哪、什么状态、身上有什么、周围有什么、别人在不在、我会什么、我经历过什么。
# **任何会改变世界的工具都不在这里**（那是决定之后的事）。
#
# 后半段这几个（todo_* / load_skill / plan_route）**不改变世界**，
# 但决策提示词（life.py 的 static_rules）明确让她用它们：
#   · `mc_todo_write` / `mc_todo_done` —— "清单是**你自己的**，随时可以重写"
#     （见 life.py 的 write_todos 与 ACTION_PROMPT 里的同一句话）。
#     设计意图是"清单归她管"，那就得让这条路径上真的有这两个工具。
#   · `mc_load_skill` —— "遇到多步、容易出错的大事，先读攻略再动手"
#   · `mc_plan_route` —— "走不通时先看要挖哪几格、要不要垫脚"
#
# 早期这三类工具**只写在提示词里、却不在工具集里**：模型照着提示词去调，
# 结果拿到的是"没有工具 mc_todo_write"。提示词承诺了就必须给得出来，
# 这条一致性由 dev-tools/check_tool_prompts.py 守住。
PERCEPTION_TOOLS = (
    "mc_status",       # 位置/血量/饱食/手持/附近实体
    "mc_inventory",    # 背包明细
    "mc_scan",         # 附近指定方块（找树、找石头）
    "mc_players",      # 谁在线、离我多远
    "mc_skills",       # 我会做的事
    "mc_her_memories", # 我的记忆
    "mc_goal_status",  # 当前长期目标
    "mc_todo_read",    # 我给自己列的清单（只读）
    "mc_todo_write",   # 重写清单（改的是她自己的笔记，不动世界）
    "mc_todo_done",    # 划掉一项
    "mc_load_skill",   # 读攻略（只读）
    "mc_plan_route",   # 看路线要挖哪几格（只描述，不改世界）
)

# 决策阶段的行为约束
PERCEPTION_PROMPT = """你在决定"接下来自己要做什么"。

- 需要事实就**先查看**：不确定背包里有什么就调 mc_inventory，
  不确定附近有没有树就调 mc_scan。不要凭印象猜。
- 查看是为了决定，不要无休止地查——通常 0~2 次查看就够。
- 查看完必须给出最终决定（JSON），不要只查不做。
- 决定权在你：建议只是参考，你可以按自己的想法来。"""


def _bind_if_needed(handler, instance):
    """把"从类上取下来的普通函数"绑定到实例上。

    与 game_agent 里同一个坑：AstrBot 注册的工具 handler 是未绑定函数，
    直接调用会把 event 塞给 self，然后报
    "missing 1 required positional argument: 'event'"。
    """
    if handler is None:
        return None
    if inspect.ismethod(handler):
        return handler
    try:
        params = list(inspect.signature(handler).parameters)
    except (TypeError, ValueError):
        return handler
    if params and params[0] in ("self", "cls"):
        try:
            return handler.__get__(instance, type(instance))
        except Exception:  # noqa: BLE001
            return handler
    return handler


class _PerceptionEvent:
    """工具方法只需要这两个东西：回一个 result、知道会话来源。"""

    def __init__(self, umo: str = ""):
        self.unified_msg_origin = umo or "mc-life"

    def plain_result(self, text: str):
        return _PlainResult(text)


class _PlainResult:
    def __init__(self, text: str):
        self._text = str(text)

    def get_plain_text(self) -> str:
        return self._text

    def __str__(self) -> str:  # pragma: no cover - 兜底
        return self._text


class PerceptionAgent:
    """只读感知循环：让模型先查、再决定。"""

    def __init__(self, plugin, *, max_steps: int = 3):
        self.plugin = plugin
        self.max_steps = max_steps

    # ------------------------------------------------------------ 工具集

    def _manager(self):
        context = getattr(self.plugin, "context", None)
        provider_manager = getattr(context, "provider_manager", None)
        return getattr(provider_manager, "llm_tools", None)

    def _toolset(self) -> ToolSet | None:
        manager = self._manager()
        if manager is None:
            return None
        toolset = ToolSet()
        count = 0
        for tool in getattr(manager, "func_list", []) or []:
            name = getattr(tool, "name", "") or ""
            if name in PERCEPTION_TOOLS:
                toolset.add_tool(tool)
                count += 1
        return toolset if count else None

    async def _execute(self, name: str, args: dict, event) -> str:
        manager = self._manager()
        if manager is None:
            return "error: 工具管理器不可用"
        func = manager.get_func(name)
        if func is None:
            return f"error: 没有工具 {name}"
        handler = getattr(func, "handler", None)
        if handler is None:
            return f"error: 工具 {name} 没有 handler"
        handler = _bind_if_needed(handler, self.plugin)
        try:
            result = handler(event, **(args or {}))
            last = None
            if inspect.isasyncgen(result):
                async for item in result:
                    last = item
            elif inspect.isawaitable(result):
                last = await result
            else:
                last = result
            if last is None:
                return "ok（无文本结果）"
            if hasattr(last, "get_plain_text"):
                return str(last.get_plain_text())
            return str(last)
        except Exception as exc:  # noqa: BLE001
            logger.warning("感知工具 %s 执行失败：%s", name, exc)
            return f"error: {type(exc).__name__}: {exc}"

    # ------------------------------------------------------------ 主入口

    async def decide(self, *, prompt: str, system: str, umo: str = "") -> tuple[str | None, list[str]]:
        """带感知工具地拿一次决定。

        @return (模型最终输出的文本, 调用过的工具名列表)
                文本为 None 表示这条路径不可用（没有 provider / 没有工具集），
                调用方应该退回纯文本决策。
        """
        plugin = self.plugin
        try:
            provider = await plugin.context.get_using_provider_async()
        except Exception as exc:  # noqa: BLE001
            logger.debug("取 provider 失败：%s", exc)
            provider = None
        if provider is None:
            return None, []

        toolset = self._toolset()
        if toolset is None:
            # 工具管理器不可用（或没有感知工具）：退回纯文本，不影响决策本身
            return None, []

        contexts: list[Message] = [Message(role="user", content=prompt)]
        event = _PerceptionEvent(umo)
        used: list[str] = []

        for _ in range(self.max_steps):
            try:
                resp = await provider.text_chat(
                    contexts=list(contexts),
                    system_prompt=system,
                    func_tool=toolset,
                    tool_choice="auto",
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("感知决策调用失败，退回纯文本决策：%s", exc)
                return None, used

            names = getattr(resp, "tools_call_name", None) or []
            args_list = getattr(resp, "tools_call_args", None) or []
            ids = getattr(resp, "tools_call_ids", None) or []

            if not names:
                text = (getattr(resp, "completion_text", None) or "").strip()
                return text or None, used

            # 把模型的工具调用回显进上下文。
            #
            # **字段名必须用对**：ToolCallMessageSegment 只有
            # role / content / tool_calls / tool_call_id 四个字段，
            # 没有 tool_name / tool_args。早期这里自己造了字段名，
            # 结果每次都在这里抛 pydantic 校验错误：
            #   "1 validation error for ToolCallMessage"
            # → 整条"先查看再决定"的路径每次都退回纯文本（功能等于没生效）。
            # 正确写法照抄能正常工作的 game_agent：
            #   assistant 消息带 tool_calls=resp.to_openai_tool_calls_model()
            #   工具结果用 ToolCallMessageSegment(role="tool", tool_call_id=..., content=...)
            try:
                contexts.append(
                    AssistantMessageSegment(
                        role="assistant",
                        content=(getattr(resp, "completion_text", None) or ""),
                        tool_calls=resp.to_openai_tool_calls_model(),
                    )
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("回显工具调用失败（不影响执行）：%s", exc)

            for idx, nm in enumerate(names):
                a = args_list[idx] if idx < len(args_list) else {}
                if not isinstance(a, dict):
                    try:
                        a = json.loads(a or "{}")
                    except Exception:  # noqa: BLE001
                        a = {}
                call_id = ids[idx] if idx < len(ids) else f"call_{idx}"
                used.append(nm)
                logger.info("决策前先查看：%s(%s)", nm, json.dumps(a, ensure_ascii=False)[:80])
                out = await self._execute(nm, a, event)
                contexts.append(
                    ToolCallMessageSegment(
                        role="tool",
                        tool_call_id=call_id,
                        content=str(out),
                    )
                )

        # 查了太多次还没决定：再要一次纯文本结论
        contexts.append(Message(role="user", content="请现在直接给出你的最终决定（JSON），不要再查看。"))
        try:
            resp = await provider.text_chat(contexts=list(contexts), system_prompt=system)
            text = (getattr(resp, "completion_text", None) or "").strip()
            return text or None, used
        except Exception as exc:  # noqa: BLE001
            logger.warning("要最终决定失败：%s", exc)
            return None, used
