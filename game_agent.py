"""游戏内对话代理：让玩家在游戏里说的话能真正驱动动作。

**为什么需要它**（这是用户报"什么都做不了"的根因）：

之前的游戏内聊天路径是：
    玩家说话 → 拼一段提示词 → llm_generate → 生成文字 → 在游戏里说出来

那条路径上 **LLM 根本拿不到工具**。所以玩家说"砍树"，
她用人格回一句"好呀我去砍树"，然后一动不动——她只能在 QQ 渠道干活
（QQ 消息走 AstrBot 的正常管线，那里有完整的工具调用循环），
在游戏里她"只会说不会做"。

这个模块给游戏内对话补上一个**小型工具调用循环**：
    玩家说话 → LLM（带着 mc_* 工具）→ 决定调工具 → 执行 → 结果喂回去 → 再决定
    ……直到 LLM 给出最终文字 → 在游戏里说出来

实现说明（都是扒 AstrBot 源码确认的）：
- 工具来自 `context.provider_manager.llm_tools`（FunctionToolManager），
  只取 `mc_*` 前缀（本插件的工具），避免把别的插件/MCP 的工具塞进来污染上下文
- 调用 `provider.text_chat(contexts=..., func_tool=ToolSet)` 让模型决定调不调工具
- 模型给出 tool_calls 后，直接调 `FuncTool.handler(event, **kwargs)`——
  handler 就是插件里被 @llm_tool 装饰的方法（绑定在插件实例上）
- event 用一个轻量替身：工具方法只需要 `plain_result()` 和 `unified_msg_origin`
- 结果以 role=tool 的消息追加进 contexts，再让模型继续
"""

from __future__ import annotations

import inspect
import json
from typing import Any

from astrbot.api import logger

# AstrBot 内部类型。导入放在模块顶层：插件本来就运行在 AstrBot 里，
# 这些模块一定存在；万一 API 变了，让错误在加载时暴露，而不是静默降级。
from astrbot.core.agent.message import (
    AssistantMessageSegment,
    Message,
    ToolCallMessageSegment,
)
from astrbot.core.agent.tool import ToolSet

# 给 LLM 的额外行为约束：游戏内对话要能"动手"
GAME_ACTION_PROMPT = """玩家在游戏里跟你说话时：
- 如果他让你做事（去某地、砍树、挖矿、跟随、盖房、停下来等），**直接调用工具去做**，不要只是口头答应
- 长动作（砍树、挖矿、寻路）调用后会立刻返回任务号，你不用等它做完，用一句话告诉玩家你已经开始做了
- 如果做不到（没进服、缺工具、找不到目标），直说原因，不要假装做了
- 行动之外仍用你的人格说话：简短、口语化、不超过 60 字"""

# 游戏内对话要排除的工具。
#
# 为什么不是全部 39 个：工具的 schema 会随每次 LLM 调用一起发送，
# 39 个工具约占 8000 token——玩家说句"早上好"也要花这么多，太浪费。
# 所以游戏内只带"玩家会让她做的事"，把 AstrBot 管理面的工具留在 QQ 侧。
#
# 排除项与理由：
#   mc_set_goal / mc_goal_*   目标管理是你在 QQ 侧的安排，游戏内玩家不该动
#   mc_visit                  从 QQ 侧"拜访她"的入口，在游戏里没意义
#   mc_her_persona / mc_persona_list  人格管理是 AstrBot 侧的事
#   mc_her_memories           她的记忆查看主要服务 QQ 侧的你
GAME_ONLY_EXCLUDE = {
    "mc_set_goal",
    "mc_goal_status",
    "mc_goal_pause",
    "mc_goal_resume",
    "mc_visit",
    "mc_her_persona",
    "mc_persona_list",
    "mc_her_memories",
}


def _bind_if_needed(handler, instance):
    """把"从类上取下来的普通函数"绑定到实例上。

    AstrBot 的工具管理器里存的 handler 是未绑定的函数（签名首参是 self），
    AstrBot 自己的执行路径用的是绑定过的对象，所以没暴露这个问题；
    我们自己调用时就必须补上，否则 event 会被当成 self，
    报 `missing 1 required positional argument: 'event'`。

    已经不绑定/已绑定的情况都要兼容：只有在首参确实是 self/cls 时才绑定。
    """
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


class _PlainResultShim:
    """模拟 MessageEventResult 的最小实现（工具方法只需要 get_plain_text）。"""

    def __init__(self, text: str):
        self._text = text

    def get_plain_text(self) -> str:
        return self._text


class GameEventShim:
    """给工具方法用的假消息事件。

    插件的工具方法签名是 `(self, event, **params)`，它们只用到：
      - `event.plain_result(text)` → 返回带 get_plain_text() 的结果对象
      - `event.unified_msg_origin` → 个别工具用它解析模型 provider
    游戏内聊天没有真实事件，所以造一个替身。
    """

    def __init__(self, sender: str):
        self.unified_msg_origin = None  # 走默认 provider
        self._sender = sender

    def plain_result(self, text: str) -> _PlainResultShim:
        return _PlainResultShim(str(text))


class GameChatAgent:
    """游戏内聊天的工具调用循环。

    @param plugin 插件实例（复用它的 engine / persona / memory / llm 解析 / 配置）
    """

    # 最大工具调用轮数。防止模型陷入"调工具→再调→再调"的死循环。
    #
    # **6 步不够**：实测玩家说"做把木镐"，她的调用链是
    #   mc_craft(wooden_pickaxe) 失败（缺木板）
    #   → mc_craft(spruce_planks)（还挑错了木头）
    #   → mc_craft(wooden_pickaxe) 再失败
    #   → mc_inventory
    #   → mc_collect(wooden_pickaxe)
    #   → mc_task_status
    # = 6 步刚好用光，**在第 6 步被中止**，玩家看到的就是"让她做木镐，失败了"。
    # 一条完整的合成链（原木→木板→木棍→工作台→工具）本来就该允许更多步。
    MAX_STEPS = 12

    def __init__(self, plugin):
        self.plugin = plugin

    # ------------------------------------------------------------ 工具集

    def _mc_toolset(self) -> ToolSet | None:
        """从 AstrBot 的工具管理器里挑出本插件的工具，组装成 ToolSet。

        注意：不能用 get_full_tool_set()——那会带上其它插件和 MCP 的全部工具，
        游戏内对话的上下文会被污染，模型也容易调错。
        """
        context = getattr(self.plugin, "context", None)
        provider_manager = getattr(context, "provider_manager", None)
        manager = getattr(provider_manager, "llm_tools", None)
        if manager is None:
            return None

        toolset = ToolSet()
        count = 0
        for tool in getattr(manager, "func_list", []) or []:
            name = getattr(tool, "name", "") or ""
            if not name.startswith("mc_"):
                continue
            if name in GAME_ONLY_EXCLUDE:
                continue
            toolset.add_tool(tool)
            count += 1
        return toolset if count else None

    # ------------------------------------------------------------ 工具执行

    async def _execute_tool(self, name: str, args: dict, event: GameEventShim) -> str:
        """执行一个工具调用，返回给模型的结果文本。"""
        manager = self._manager()
        if manager is None:
            return f"error: 工具管理器不可用"
        func = manager.get_func(name)
        if func is None:
            return f"error: 没有工具 {name}"
        handler = getattr(func, "handler", None)
        if handler is None:
            return f"error: 工具 {name} 没有可执行的 handler"

        # 关键：AstrBot 注册进来的是**从类上取下来的普通函数**（未绑定），
        # 第一个参数是 self。直接 handler(event, **args) 会把 event 塞给 self，
        # 然后抛 "missing 1 required positional argument: 'event'"——
        # 实测就是这个错误让所有游戏内工具调用全部失败（她只会回话、不会动）。
        # 所以这里补上绑定：把 self 换成插件实例。
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

            if last is not None and hasattr(last, "get_plain_text"):
                return str(last.get_plain_text())
            if last is None:
                return "ok（工具执行完成，无文本结果）"
            return str(last)
        except Exception as exc:  # noqa: BLE001
            logger.warning("游戏内执行工具 %s 失败：%s", name, exc)
            return f"error: {type(exc).__name__}: {exc}"

    def _manager(self):
        context = getattr(self.plugin, "context", None)
        provider_manager = getattr(context, "provider_manager", None)
        return getattr(provider_manager, "llm_tools", None)

    # ------------------------------------------------------------ 主入口

    async def handle(self, sender: str, message: str) -> str | None:
        """处理一条游戏内消息，可能驱动动作。

        @return 要在游戏里回的话；None 表示"没有可说的"（比如 LLM 不可用）
        """
        plugin = self.plugin

        provider = await plugin.context.get_using_provider_async()
        if provider is None:
            logger.debug("游戏内对话：没有可用的 LLM provider")
            return None

        toolset = self._mc_toolset()
        if toolset is None:
            # 工具管理器不可用：退回纯文字聊天（由调用方处理）
            return None

        system = await plugin._system_prompt_for_mc(extra=GAME_ACTION_PROMPT)

        try:
            brief = await plugin._get_brief()
        except Exception:  # noqa: BLE001
            brief = "（状态读取失败）"
        try:
            memos = await plugin._my_memory(f"{message} {sender}", limit=4)
        except Exception:  # noqa: BLE001
            memos = ""

        parts = [f"【你当前的状态】\n{brief}"]
        if memos:
            parts.append(f"【你记得的事】\n{memos}")
        parts.append(f"【{sender} 对你说】{message}")
        user_text = "\n\n".join(parts)

        contexts: list[Message] = [Message(role="user", content=user_text)]
        event = GameEventShim(sender)
        executed: list[str] = []
        executed_ok: list[str] = []

        for step in range(self.MAX_STEPS):
            try:
                resp = await provider.text_chat(
                    contexts=list(contexts),
                    system_prompt=system,
                    func_tool=toolset,
                    tool_choice="auto",
                )
            except Exception as exc:  # noqa: BLE001
                logger.error("游戏内 LLM 调用失败：%s", exc)
                return None

            # 记一次用量（W6）——和 action_agent 记进同一个台账，
            # 否则 /mc状态 显示的用量只覆盖"自主行动"，玩家对话那条路是黑的。
            try:
                from .tokens import ledger

                ledger().record(getattr(resp, "usage", None))
            except Exception as exc:  # noqa: BLE001
                logger.debug("记录用量失败（不影响主流程）：%s", exc)

            tool_names = list(getattr(resp, "tools_call_name", None) or [])
            tool_args = list(getattr(resp, "tools_call_args", None) or [])
            tool_ids = list(getattr(resp, "tools_call_ids", None) or [])

            if not tool_names:
                # 没有工具调用 → 这就是最终回复
                text = (getattr(resp, "completion_text", None) or "").strip()
                if executed:
                    logger.info(
                        "游戏内对话驱动了 %s 个工具：%s（成功 %s 个）→ 回复「%s」",
                        len(executed),
                        "、".join(executed),
                        len(executed_ok),
                        text[:40],
                    )
                    if executed_ok:
                        self._on_player_requested_action()
                    else:
                        # 工具全部失败（比如引擎没起来）→ 不要暂停她的自主行动，
                        # 否则没有任务产生、也就永远等不到恢复事件，她会彻底停滞。
                        logger.warning(
                            "游戏内工具全部执行失败，不暂停过日子循环（避免永久停滞）"
                        )
                return text or None

            # 有工具调用：把 assistant 消息与工具结果都追加进上下文，继续循环
            contexts.append(
                AssistantMessageSegment(
                    role="assistant",
                    content=(getattr(resp, "completion_text", None) or ""),
                    tool_calls=resp.to_openai_tool_calls_model(),
                )
            )

            # **按下标取参数，不要用 zip**。
            #
            # 早期这里是 `for name, args, call_id in zip(tool_names, tool_args, tool_ids)`。
            # zip 的语义是"取最短"：只要三个列表长度不一致（provider 不返回
            # tool_call id、或 args 缺失时只回了 name），它就会**静默产出 0 次迭代**——
            # 玩家在游戏里让她做的事**全部被丢弃**，她只回话不动手。
            # 这恰恰是这个模块当初要修的病（"她只会说'好的'然后站着不动"）。
            #
            # action_agent.py 与 perception_agent.py 都用下标访问 + call_id 兜底，
            # 只有这里漏了。三处现在写法一致。
            for idx, name in enumerate(tool_names):
                args = tool_args[idx] if idx < len(tool_args) else {}
                if not isinstance(args, dict):
                    try:
                        args = json.loads(args or "{}")
                    except Exception:  # noqa: BLE001
                        args = {}
                call_id = tool_ids[idx] if idx < len(tool_ids) else f"call_{idx}"
                logger.info("游戏内 %s 的请求 → 调用工具 %s(%s)", sender, name, json.dumps(args, ensure_ascii=False))
                result_text = await self._execute_tool(name, args, event)
                executed.append(name)
                if not str(result_text).startswith("error:"):
                    executed_ok.append(name)
                contexts.append(
                    ToolCallMessageSegment(
                        role="tool",
                        tool_call_id=call_id,
                        content=result_text,
                    )
                )

        logger.warning("游戏内对话的工具循环超过 %s 步，中止", self.MAX_STEPS)
        return "（脑子里转了好几个弯，先这样吧）"

    # ------------------------------------------------------------ 与过日子循环的协调

    def _on_player_requested_action(self) -> None:
        """玩家让她做事了 → 暂停过日子循环，别让她的"自己的想法"插队。

        之前的缺口：玩家说"跟着我"，她刚跟上，过日子循环到点了，
        决定"我想去挖矿"，人就跑了——跟在玩家视角就是"她根本不听我的"。

        恢复由插件主类在 task.finished / task.cancelled 时做（她手上的事做完了，
        才继续过自己的日子）。
        """
        life = getattr(self.plugin, "life", None)
        if life and not life.paused:
            life.pause()
            logger.debug("玩家指派了动作，过日子循环已暂停（任务结束后恢复）")
