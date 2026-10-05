"""动作代理：让「过日子」的 LLM **直接驱动她做事**，而不是挑一个技能名。

## 为什么要换掉"挑技能名"

改造前的自主行动是这样的：

    拼简报 → LLM 输出一句 JSON（{"skill": "chop_tree"}）→ 我提交一个技能任务 → 等它跑完

也就是说 **LLM 其实没在控制她**：它只在一个我写死的技能表上按了个按钮，
真正干活的是我写的 1.3 万行脚本。后果就是用户看到的那一串症状——
技能失败了她原地挣扎、走路会乱挖、复杂的事永远做不完。

更好的做法是：**让模型每一步都过一遍**，
它拿到的是一双手（工具），自己决定走哪一步、挖哪一格、什么时候换个做法：

    观察 → 模型决定调哪些工具 → 执行 → 结果喂回 → 模型再决定 → …… → 收尾说一句

## 和 perception_agent 的分工

- `perception_agent`：**只读**，用来"先看一眼再决定"（决策前的侦察）
- `action_agent`（本模块）：**可写**，用来真正动手（这一步会改变世界）

分开是因为它们的约束不同：侦察不该有副作用，动手必须受权限与步数约束。
"""

from __future__ import annotations

import asyncio
import inspect
import json
import time
from typing import Any

from astrbot.api import logger

from astrbot.core.agent.message import (
    AssistantMessageSegment,
    Message,
    ToolCallMessageSegment,
)
from astrbot.core.agent.tool import ToolSet
from .game_agent import tool_changes_body
from .inbox import Delivery

# **动作代理能用的工具**：所有 mc_ 开头的能力工具。
#
# 不做白名单（除了下面这几个"不该由她自己决定"的）：
# 原则很清楚——模型手上的工具就是它的双手，
# 按我的判断去裁剪它反而会让它做不成事。
#
# **这里只允许出现真实注册过的工具名。**
# 早期这一列里躺着 9 个**根本不存在**的幽灵名字（配置 / 重载 / 重启 / 停止 /
# 启动 / 暂停人生 / 恢复人生 / 设置人格 / 绑定，都带 mc_ 前缀）——
# 那些管理面能力从来没有做成 LLM 工具（它们是 `/mc` 指令）。
# 幽灵条目没有任何作用，却让人以为"管理工具已经被挡住了"，
# 而检查器也无从判断这一列里的名字到底合不合法。
# 现在由 dev-tools/check_tool_prompts.py 断言这一列里的名字全部真实存在。
# （注意：别在这里把那些旧名字按原样写回来——test_action_agent.py 会扫描本文件
#   里的所有 mc_ 名字并断言它们真实存在，写回来就会把它判成幻影工具。）
EXCLUDED_TOOLS = (
    # **任务管理类不算"她的手"**：实测她拿到这些工具后，
    # 会把整整 8 步预算花在 `mc_task_status` 轮询上——
    # 每 3 秒问一次"砍树做完了吗"，每次问都是一次 LLM 往返（几秒），
    # 结果是她在原地站了一分钟什么也没干（用户："基本上不动"）。
    # 提交任务后**不需要轮询**：下一轮自然就能看到结果。
    "mc_task_status",
    "mc_task_cancel",
)

# 单轮自主行动最多调几次工具。
#
# **每一次调用都是一次 LLM 往返**（几秒），所以步数直接等于"她站着不动的时长"。
# 8 步实测会让她站 30~60 秒，而且模型经常把预算全花在"查看"上、一步没动。
# 4 步够做完"看一眼 → 动手 → 确认"这样一轮；要接着做，下一轮会自然继续。
# 单轮自主行动最多调几次工具。
#
# **为什么可以从 4 调回 6**：原来的 4 步之所以不够，是因为"提交了长任务就结束"
# 这条规则**只写在提示词里、代码没强制**，于是模型会把预算烧在等待和查询上。
# 现在代码里一看到 `task_id` 就跳出循环（见下面的 return），
# 步数不再被浪费——多出来的两步留给"先查看再决定"这种正常情况。
# 而且每一步都是一次模型往返（几秒），上限仍然不能大。
MAX_STEPS = 6

# 观察只为补足下一步的事实。预算包含重复请求；命中缓存也不能无限问模型。
MAX_OBSERVATIONS = 2
READ_ONLY_TOOLS = {
    "mc_status", "mc_inventory", "mc_scan", "mc_plan_route", "mc_inspect_block",
    "mc_scan_entities", "mc_check_danger", "mc_world_info", "mc_players", "mc_skills",
    "mc_her_memories", "mc_goal_status", "mc_todo_read", "mc_load_skill",
    "mc_knowledge_search", "mc_her_persona", "mc_persona_list", "mc_her_wish",
    "mc_whats_she_doing",
}
# 背包可由真实快照完整核对；地形、远处实体、笔记等没有完备更新版本，
# 因此其余观察只在同一批调用内复用，不能跨模型往返沿用旧结果。
CROSS_ROUND_READS = {"mc_inventory"}

# 提示词里要提到"最多几步"。**用一个占位符，不要硬编码数字。**
#
# 踩过：上一轮把 MAX_STEPS 从 4 调到 6，但提示词里还写着"你只有 4 步""最多 4 步"——
# 于是模型按 4 步给自己压预算，**正好抵消了那次修复**。
# 这类"常量和文案各写一份"的地方，只要没人盯着就一定会漂。
# 现在只有 MAX_STEPS 一个真源，提示词从它插值。
_STEPS_TOKEN = "{{MAX_STEPS}}"

ACTION_PROMPT = """你现在正在 Minecraft 里自己过日子，没有人在指挥你。

**你是用工具来行动的**——想做什么就直接调工具，不要只描述。
比如"去砍树"就调 `mc_chop_tree(count=8)`；"看看背包"就调 `mc_inventory`。
工具返回什么，你就根据真实结果决定下一步。

先保证能活着完成目标：饥饿或受伤时先补给，残血且附近有敌人先避险。
优先利用手上的食材、已有工作台/熔炉和看得见的动物；原矿先加工成铁锭再升级工具。
连续计划在步骤之间会检查生存需求，必要时先吃饭或恢复，再接回原计划；不要因为补给重新安排整套开荒。
已放下的家具不在背包里，判断屋里有没有床或箱子需要查看世界，不能只看物品数量。

**第二重要的规则：多步的事，用「技能工具」，不要用原语一步步硬拼。**

**和上面同等重要：知道接下来几步就一次交代清楚（`mc_plan_do`）。**

为什么这条是"省时间"的关键：**你每做一步，我都要停下来问你一次。**
而问你一次要**好几秒**（你要读状态、想、回答）—— 那几秒里**她是站着不动的**。
玩家看到的就是"她做完一件事就发呆一会儿，才做下一件"。

**所以：只要你知道接下来要干什么，就用 `mc_plan_do(steps="...")` 一次给出 2~5 步。**
我会按顺序替她执行，**中间不再来问你**。这样她做完第一步会**立刻**接第二步。

    mc_plan_do(steps="chop_tree, make_tools, mine_stone")
    mc_plan_do(steps='[{"skill":"chop_tree","params":{"count":4}},{"skill":"make_tools","params":{"tier":"wooden","kinds":["pickaxe"]}}]')

不带参数时可以用逗号分隔技能名；**需要数量、工具等级等参数时，steps 必须是 JSON 数组字符串**，
每一步写 skill 和 params，不要把函数调用表达式写进技能名。

**什么时候不用**：你也不确定下一步该干嘛（那就先看一眼情况再说）。
**不确定也可以写短的** —— 写一步也比不写好（至少省一次往返）。



这是最容易犯的错。原语（mc_craft / mc_mine / mc_goto / mc_place…）是**单个动作**；
技能工具是**一整套做完为止的流程**，它内部会处理依赖、重试、找材料。

| 你想做的事 | **该用**（一次调用） | 不该这样（拼原语） |
|---|---|---|
| 要一把木镐 | `mc_make_tools(tier="wooden")` | mc_craft(oak_planks) → mc_craft(sticks) → mc_place(table) → mc_craft(pickaxe) |
| 要木头 | `mc_chop_tree(count=8)` | mc_scan → mc_goto → mc_mine ×8 |
| 要圆石 | `mc_mine_stone(count=20)` | mc_goto → mc_mine ×20 |
| 要铁矿 | `mc_mine_ores(ore="iron", count=5)` | 一步步挖 |
| 要盖房子 | `mc_build_shelter()` 或 `mc_blueprint` | 一块块 mc_place |
| 要存东西 | `mc_store_items()` | 一格一格搬 |
| 要熔炼 | `mc_smelt(item="iron_ingot", count=3)` | 一个个烧 |
| **你知道接下来该干什么** | `mc_plan_do(steps="chop_tree, make_tools")` | 一步步来（每步都要停下来想，慢） |
| 要吃饭 | `mc_cook_food()` 或 `mc_supply` | 一步步找食材 |
| **掉进坑里/出不来** | `mc_climb_out()` | 硬走（**2 格以上跳不上去，走不出来的**） |
| **前面过不去（坑/沟/岩浆）** | `mc_pave(direction="forward", count=4)` | 硬走 |
| **要上高处但跳不上去** | `mc_pave(direction="up", count=3)` | 硬跳 |
| **走不到、被方块挡住** | `mc_dig_path(x, z, max_blocks=8)` | mc_mine 一格一格挖 |
| **死了要回去捡东西** | `mc_recover_drops(x, y, z, age_seconds)` | 硬走（它会告诉你值不值得去） |

（想看完整技能清单就调 `mc_skills`。）

**为什么这条重要**：你每一步都要过一次模型（好几秒）。用技能一次就顶十几个原语，
而且技能内部会自己处理"材料不够 → 先去拿"这种依赖。
你只有 {{MAX_STEPS}} 步，拿原语拼是拼不完一件完整的事的——**结果是忙了半天什么都没做成。**

**查看通常不超过 2 次；相同状态下重复查看会复用结果，观察预算用完就必须收尾。**
（每一步都是一次模型往返，你要站着等好几秒。看一眼就够，别把时间花在反复确认上。）
已有事实足够时安排下一步；事实不足或没有安全做法时说明缺少什么，不要为了动手而猜。

其他规则：
- 需要事实就先看（mc_status / mc_inventory / mc_scan / mc_scan_entities），不要凭印象猜。
- 一次可以做多件事（连续调几个工具），但**最多 {{MAX_STEPS}} 步**。
- **提交了长任务就结束这一轮**（技能返回 task_id 就说明它在跑了）——
  不要反复问"做完了吗"，下一轮你自己就能看到结果。
- 工具报错时**读懂它说了什么**，换个做法，不要原样重试同一个调用。
  特别是报错里写"**这已经是第 N 次尝试…失败了**"的时候——**立刻换思路**，
  别再试第三次。报错里写"**目标在你上方/下方 N 格**"的时候，
  那说明**不是走几步的事**：要挖阶梯上去/下去，或者干脆换个目标。
- **走路不会改动世界**（这是有意的）。走不通时先用 `mc_plan_route` 看
  "要挖哪几格、要不要垫脚"，再决定值不值得动世界；要挖就用 mc_mine 逐格挖。
- 遇到多步、容易出错的大事，**先读攻略**：`mc_load_skill`，
  可选 building（盖房）/ tools（从零到石制工具）/ food（吃饱肚子）/
  mining（安全挖矿）/ combat（打架与自保）/ storage（安顿好家）/
  strategy（**什么时候该放弃、找多远**）。
- 复杂的事用 `mc_todo_write` 给自己列清单，做完一项划掉一项。
- 手上没有合适的工具时就别硬做（比如没有镐就挖不动石头）——
  先去做能拿到工具的事。
- **同一件事反复做不成，就承认它做不成**，去做别的。真人也这样。
  死磕一件事一小时不是坚持，是卡住了。
- 做完后**用一句话说明你干了什么**（用你的人格说话，不要像任务汇报）。

注意：这一步是**你自己的生活**，不是替谁完成任务。你可以按自己的想法来。"""

# 把占位符换成真实的步数（**唯一真源是 MAX_STEPS**）。
# 用 replace 而不是 f-string / .format()：提示词里以后可能加 `{` `}`，
# 那样 format 会直接抛异常，而 replace 不会。
ACTION_PROMPT = ACTION_PROMPT.replace(_STEPS_TOKEN, str(MAX_STEPS))

# 自检：提示词里不许再留占位符，也不许出现和 MAX_STEPS 不一致的步数说法。
# 放在模块级是为了**导入时就炸**——这类漂移必须在开发阶段发现，
# 而不是等模型按错数字给自己压预算（上一轮就是这么漏的）。
if _STEPS_TOKEN in ACTION_PROMPT:  # pragma: no cover - 防御性
    raise RuntimeError(f"ACTION_PROMPT 里还有没替换的占位符 {_STEPS_TOKEN}")


def _bind_if_needed(handler, instance):
    """把"从类上取下来的普通函数"绑定到实例上。

    与 game_agent / perception_agent 同一个坑：AstrBot 注册的工具 handler
    是未绑定函数，直接调会报 `missing 1 required positional argument: 'event'`。
    """
    if inspect.ismethod(handler):
        return handler
    try:
        return handler.__get__(instance, type(instance))
    except Exception:  # noqa: BLE001
        return handler


class _ActionEvent:
    """工具 handler 需要一个 event 参数；自主行动时没有真实消息事件。

    用一个最小的替身：带上 umo（工具里可能用它定位会话），其余按需返回 None。
    """

    def __init__(self, umo: str = ""):
        self.unified_msg_origin = umo or "mc-autonomy"
        self.astrcraft_autonomous = True

    def get_plain_text(self) -> str:
        return ""

    def plain_result(self, text: str):
        return text


class ActionAgent:
    """带完整工具集的 ReAct 循环（自主行动的"手"）。"""

    def __init__(self, plugin):
        self.plugin = plugin
        self.max_steps = MAX_STEPS
        self.max_observations = MAX_OBSERVATIONS
        self.last_timing: dict[str, Any] = {}

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
            if not name.startswith("mc_"):
                continue
            if name in EXCLUDED_TOOLS:
                continue
            toolset.add_tool(tool)
            count += 1
        return toolset if count else None

    async def _execute(self, name: str, args: dict, event) -> str:
        if not name.startswith("mc_") or name in EXCLUDED_TOOLS:
            return f"error: 当前自主行动不允许调用工具 {name}"
        if tool_changes_body(name, args or {}):
            life = getattr(self.plugin, "life", None)
            if getattr(self.plugin, "_emergency_stopped", False):
                return "error: 机器人已急停，请先由主人恢复行动"
            if life is not None and callable(getattr(life, "may_act", None)) and not life.may_act():
                return f"error: 当前不能自主行动：{life.hold_explain()}"
            if life is not None and life.inbox.has_delivery(Delivery.STEER):
                return "error: 有新的指令或紧急情况，请先读取新输入再决定动作"
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
            logger.warning("自主行动工具 %s 执行失败：%s", name, exc)
            return f"error: {type(exc).__name__}: {exc}"

    # ------------------------------------------------------------ 主入口

    async def act(self, *, prompt: str, system: str, umo: str = "") -> tuple[str | None, list[str]]:
        """执行一轮，并留下包含取消/异常路径的独立模型、工具和状态检查计时。"""
        timing = {
            "provider_seconds": 0.0, "tool_seconds": 0.0,
            "state_check_seconds": 0.0, "preparation_seconds": 0.0,
            "total_seconds": 0.0, "other_seconds": 0.0,
            "provider_calls": 0, "tool_calls": 0, "tool_requests": 0,
            "read_cache_hits": 0, "observation_requests": 0,
            "observation_budget_rejections": 0, "duplicate_actions_blocked": 0,
            "body_attempts": 0, "exit_reason": "running",
        }
        started = time.perf_counter()
        try:
            return await self._act_round(prompt=prompt, system=system, umo=umo, timing=timing)
        except asyncio.CancelledError:
            timing["exit_reason"] = "cancelled"
            raise
        except Exception:
            timing["exit_reason"] = "error"
            raise
        finally:
            timing["total_seconds"] = time.perf_counter() - started
            measured = sum(timing[key] for key in (
                "provider_seconds", "tool_seconds", "state_check_seconds", "preparation_seconds",
            ))
            timing["other_seconds"] = max(0.0, timing["total_seconds"] - measured)
            self.last_timing = timing

    def _read_key(self, name: str, args: dict) -> str | None:
        """使用实际 handler 的默认参数归一化，不把不同坐标/数量混成一次观察。"""
        try:
            manager = self._manager()
            func = manager.get_func(name) if manager is not None else None
            handler = getattr(func, "handler", None)
            normalized = args
            if handler is not None:
                signature = inspect.signature(_bind_if_needed(handler, self.plugin))
                bound = signature.bind(_ActionEvent(), **args)
                bound.apply_defaults()
                normalized = dict(bound.arguments)
                normalized.pop(next(iter(signature.parameters)), None)
            def canonical(value):
                if isinstance(value, dict):
                    return {key: canonical(item) for key, item in value.items()}
                if isinstance(value, list):
                    return [canonical(item) for item in value]
                if isinstance(value, float) and value.is_integer():
                    return int(value)
                return value
            return json.dumps([name, canonical(normalized)], sort_keys=True, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError, StopIteration):
            # 参数不符合 handler 签名时交给原执行路径报告；不能沿用另一次调用的结果。
            return None

    async def _observation_state(self, timing: dict, name: str) -> str | None:
        """缓存命中前确认真实状态；不可读取时不复用旧观察。"""
        engine = getattr(self.plugin, "engine", None)
        if engine is None or not callable(getattr(engine, "call", None)):
            return None
        started = time.perf_counter()
        try:
            state = await engine.call("state.get", {"detail": "normal"}, timeout=2.0)
            if not isinstance(state, dict) or not state.get("connected"):
                return None
            if name in CROSS_ROUND_READS:
                inventory = state.get("inventory_summary")
                if not isinstance(inventory, dict) or not isinstance(inventory.get("entries"), list):
                    return None
                # 背包结果不依赖不断前进的世界时钟；保留物品、手持、地点与会话。
                # 摘要 entries 覆盖 36 格主背包的物品种类，不能只比较总物品数。
                state = {key: state.get(key) for key in (
                    "connected", "position", "dimension", "server", "version",
                    "inventory_summary", "held_item",
                )}
            life = getattr(self.plugin, "life", None)
            return json.dumps(
                [id(engine), getattr(self.plugin, "_brief_revision", 0),
                 getattr(life, "_plan_revision", 0), state],
                sort_keys=True, ensure_ascii=False, allow_nan=False,
            )
        except Exception as exc:  # noqa: BLE001
            logger.info("无法确认观察缓存状态，重新读取：%s", exc)
            return None
        finally:
            timing["state_check_seconds"] += time.perf_counter() - started

    async def _act_round(self, *, prompt: str, system: str, umo: str, timing: dict) -> tuple[str | None, list[str]]:
        """跑一轮自主行动。

        @return (模型最后的总结文本, 调用过的工具名列表)
                文本为 None 表示这条路径不可用（没有 provider / 没有工具集），
                调用方应该退回"挑技能"的旧路径。
        """
        plugin = self.plugin
        life = getattr(plugin, "life", None)
        initial_revision = getattr(life, "_plan_revision", 0)
        preparation_started = time.perf_counter()
        try:
            provider = await plugin.context.get_using_provider_async()
        except Exception as exc:  # noqa: BLE001
            logger.info("取 provider 失败：%s", exc)
            provider = None
        finally:
            timing["preparation_seconds"] += time.perf_counter() - preparation_started
        if provider is None:
            timing["exit_reason"] = "unavailable"
            return None, []
        if initial_revision != getattr(life, "_plan_revision", 0):
            timing["exit_reason"] = "state_changed"
            return "（环境已改变，重新观察后再安排）", []

        preparation_started = time.perf_counter()
        try:
            toolset = self._toolset()
        finally:
            timing["preparation_seconds"] += time.perf_counter() - preparation_started
        if toolset is None:
            timing["exit_reason"] = "unavailable"
            return None, []

        contexts: list[Message] = [Message(role="user", content=prompt)]
        event = _ActionEvent(umo)
        used: list[str] = []
        read_cache: dict[tuple, str] = {}
        attempted_actions: set[str] = set()
        observations = 0
        budget = max(1, int(getattr(self, "max_observations", MAX_OBSERVATIONS)))

        for round_index in range(self.max_steps):
            life = getattr(plugin, "life", None)
            plan_revision = getattr(life, "_plan_revision", 0)
            pending_before = getattr(life, "_pending_plan", None)
            if pending_before:
                timing["exit_reason"] = "plan_ready"
                return "（收到新的计划，先按最新安排做）", used
            provider_started = time.perf_counter()
            owner_generation = getattr(life, "_decision_owner_generation", 0)
            timing["provider_calls"] += 1
            try:
                resp = await provider.text_chat(
                    contexts=list(contexts),
                    system_prompt=system,
                    func_tool=toolset,
                    tool_choice="auto",
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("自主行动的模型调用失败：%s", exc)
                # 调用失败要传给恢复回路，不能伪装成代理不可用后再烧一次模型请求。
                if not timing["body_attempts"]:
                    raise RuntimeError(f"自主行动模型调用失败：{exc}") from exc
                timing["exit_reason"] = "provider_failed_after_action"
                return "（模型调用失败，已执行的动作先保留）", used
            finally:
                timing["provider_seconds"] += time.perf_counter() - provider_started

            # 收到响应就记费用；环境变化后丢弃的决定也已经消耗 token。
            # 每一步都记，不能只记本轮最后的总结或真正执行了工具的响应。
            try:
                from .tokens import ledger

                u = ledger().record(getattr(resp, "usage", None))
                if not u.is_empty():
                    logger.debug(
                        "用量：输入 %d（缓存命中 %d，%.0f%%）+ 输出 %d = %d",
                        u.input_total,
                        u.input_cached,
                        u.hit_rate * 100,
                        u.output,
                        u.total,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.debug("记录用量失败（不影响主流程）：%s", exc)

            life = getattr(plugin, "life", None)
            if plan_revision != getattr(life, "_plan_revision", 0):
                # 重连或计划被撤销后，旧模型响应不属于现在的会话。
                timing["exit_reason"] = "state_changed"
                return "（环境已改变，重新观察后再安排）", used
            if (life is not None and getattr(life, "_pending_plan", None)
                    and life._pending_plan is not pending_before):
                # 玩家在模型思考期间写了计划，旧响应不能再覆盖它或提交旧动作。
                timing["exit_reason"] = "plan_ready"
                return "（收到新的计划，先按最新安排做）", used
            if life is not None and life.inbox.has_delivery(Delivery.STEER):
                # 与生活循环的边界处理一致：主人可以要求重新尝试失败技能。
                # 先消费这次覆盖，再取走输入，否则提交工具时已看不到主人指令。
                owner_pending = getattr(life, "_owner_steer_pending", None)
                consume_retry_override = getattr(life, "_should_back_off", None)
                if callable(owner_pending) and owner_pending() and callable(consume_retry_override):
                    consume_retry_override()
                fresh = life._drain_steer_text()
                if fresh:
                    retain = getattr(life, "_retain_decision_input", None)
                    if callable(retain):
                        retain(fresh)
                    else:
                        life._decision_input_text = "\n".join(
                            text for text in (getattr(life, "_decision_input_text", ""), fresh) if text
                        )
                    life.clear_plan("模型思考期间收到新输入")
                    # 这次响应还没执行工具，可安全丢弃旧决定并重新读最新情况。
                    contexts.append(Message(role="user", content=fresh))
                    read_cache.clear()
                    observations = 0
                    continue

            # Only an accepted response can acknowledge the owner input it saw.
            # Later failed/discarded replies retain the last accepted generation.
            timing["decision_revision"] = plan_revision
            timing["owner_generation"] = owner_generation

            names = list(getattr(resp, "tools_call_name", None) or [])
            args_list = list(getattr(resp, "tools_call_args", None) or [])
            ids = list(getattr(resp, "tools_call_ids", None) or [])

            if not names:
                text = getattr(resp, "completion_text", None) or ""
                timing["exit_reason"] = "completed"
                return (str(text).strip() or None), used

            # 回显工具调用（字段名照 game_agent 的正确写法）
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

            budget_rejected = False
            wrote_in_batch = False
            for idx, nm in enumerate(names):
                if plan_revision != getattr(life, "_plan_revision", 0):
                    timing["exit_reason"] = "state_changed"
                    return "（环境已改变，重新观察后再安排）", used
                a = args_list[idx] if idx < len(args_list) else {}
                if not isinstance(a, dict):
                    try:
                        a = json.loads(a or "{}")
                    except Exception:  # noqa: BLE001
                        a = {}
                call_id = ids[idx] if idx < len(ids) else f"call_{idx}"
                used.append(nm)
                timing["tool_requests"] += 1
                if not isinstance(a, dict):
                    contexts.append(ToolCallMessageSegment(
                        role="tool", tool_call_id=call_id, content="error: 工具参数必须是 JSON 对象",
                    ))
                    continue
                is_read = nm in READ_ONLY_TOOLS or (nm == "mc_chest" and a.get("action") == "list")
                changes_body = tool_changes_body(nm, a)
                key = self._read_key(nm, a)
                if is_read:
                    timing["observation_requests"] += 1
                    if observations >= budget:
                        timing["observation_budget_rejections"] += 1
                        budget_rejected = True
                        contexts.append(ToolCallMessageSegment(
                            role="tool", tool_call_id=call_id,
                            content="观察预算已用完；请根据已有事实安排安全的下一步，或说明缺少什么并结束。本次没有再次查询世界。",
                        ))
                        continue
                    observations += 1
                    state_before = await self._observation_state(timing, nm) if key is not None else None
                    if plan_revision != getattr(life, "_plan_revision", 0):
                        timing["exit_reason"] = "state_changed"
                        return "（环境已改变，重新观察后再安排）", used
                    cache_key = (key, state_before, None if nm in CROSS_ROUND_READS else round_index)
                    if state_before is not None and cache_key in read_cache:
                        timing["read_cache_hits"] += 1
                        out = read_cache[cache_key]
                        logger.debug("复用本轮相同状态下的观察：%s", nm)
                    else:
                        started = time.perf_counter()
                        timing["tool_calls"] += 1
                        try:
                            out = await self._execute(nm, a, event)
                        finally:
                            timing["tool_seconds"] += time.perf_counter() - started
                        state_after = await self._observation_state(timing, nm) if state_before is not None else None
                        if state_before is not None and state_before == state_after and not str(out).startswith("error:"):
                            read_cache[cache_key] = str(out)
                else:
                    # 清单/知识写入也会让旧观察失效，不能误当作只读工具缓存。
                    read_cache.clear()
                    action_key = key or json.dumps([nm, a], sort_keys=True, ensure_ascii=False)
                    if changes_body and action_key in attempted_actions:
                        timing["duplicate_actions_blocked"] += 1
                        contexts.append(ToolCallMessageSegment(
                            role="tool", tool_call_id=call_id,
                            content="error: 本轮已经尝试过这个动作，不会再次执行。请读取已有结果并换一种做法。",
                        ))
                        continue
                    if changes_body:
                        timing["body_attempts"] += 1
                        attempted_actions.add(action_key)
                    observations = 0
                    wrote_in_batch = True
                    logger.info("她自己动手：%s(%s)", nm, json.dumps(a, ensure_ascii=False)[:80])
                    started = time.perf_counter()
                    timing["tool_calls"] += 1
                    try:
                        out = await self._execute(nm, a, event)
                    finally:
                        timing["tool_seconds"] += time.perf_counter() - started
                contexts.append(
                    ToolCallMessageSegment(role="tool", tool_call_id=call_id, content=str(out))
                )
                if life is not None and getattr(life, "_pending_plan", []):
                    logger.info("她已经交代完整计划，立即交给生活循环连续执行")
                    timing["exit_reason"] = "plan_ready"
                    return "（安排好了，按顺序开始做）", used
                # **提交了长任务就立刻结束这一轮——在代码里强制，不能只写在提示词里。**
                #
                # 为什么必须强制：技能工具（mc_chop_tree / mc_make_tools…）返回的是
                # "已让机器人开始「砍树」，**任务号** xxx"，表示"这件事已经在跑了"。
                # 原来只靠提示词说"提交了就停"，而模型经常不听话，继续一轮轮调工具
                # **把 4 步预算烧在等待和查询上**，结果是"忙了半天什么都没做成"
                # （用户看到的就是"一堆无意义的动作"）。
                #
                # 注意判据要匹配**中文的"任务号"**：我第一版写成 `"task_id" in out`，
                # 而工具返回的文案里根本没有字面 task_id（只有"任务号"），
                # 于是这个提前结束**永远不会触发**。
                if "任务号" in str(out) or "task_id" in str(out):
                    logger.info("她提交了长任务（%s），这一轮到此为止", nm)
                    timing["exit_reason"] = "task_submitted"
                    return "（已经交代下去了，等它跑完）", used

            if budget_rejected and not wrote_in_batch:
                timing["exit_reason"] = "observation_budget"
                return "（观察预算已用完；本轮未再查询或猜测动作，等待补足事实后重新安排）", used
            if observations >= budget:
                # 放在整批 tool 消息之后，保持 assistant/tool 调用配对完整。
                contexts.append(Message(
                    role="user", content="本轮观察预算已用完。已有事实足够就安排安全的下一步；不足就说明缺少什么并结束，不要继续重复查询。",
                ))

        logger.warning("自主行动超过 %s 步，收尾", self.max_steps)
        timing["exit_reason"] = "step_limit"
        return "（这一轮做了不少事，先停一下）", used
