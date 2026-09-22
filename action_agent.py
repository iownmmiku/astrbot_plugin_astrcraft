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

**第二重要的规则：多步的事，用「技能工具」，不要用原语一步步硬拼。**

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

**最重要的规则：查看不要超过 2 次，然后必须动手。**
（每一步都是一次模型往返，你要站着等好几秒。看一眼就够，别把时间花在反复确认上。）

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

    def get_plain_text(self) -> str:
        return ""

    def plain_result(self, text: str):
        return text


class ActionAgent:
    """带完整工具集的 ReAct 循环（自主行动的"手"）。"""

    def __init__(self, plugin):
        self.plugin = plugin
        self.max_steps = MAX_STEPS

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
        """跑一轮自主行动。

        @return (模型最后的总结文本, 调用过的工具名列表)
                文本为 None 表示这条路径不可用（没有 provider / 没有工具集），
                调用方应该退回"挑技能"的旧路径。
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
            return None, []

        contexts: list[Message] = [Message(role="user", content=prompt)]
        event = _ActionEvent(umo)
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
                logger.warning("自主行动的模型调用失败：%s", exc)
                return (None, used) if not used else ("（模型调用失败，先这样）", used)

            # **记一次用量**（W6）。每一步都是一次模型往返，所以每一轮都要记——
            # 只记最后一步的话，"一次决策花多少 token"会严重低估
            # （6 步就是 6 次往返）。
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

            names = list(getattr(resp, "tools_call_name", None) or [])
            args_list = list(getattr(resp, "tools_call_args", None) or [])
            ids = list(getattr(resp, "tools_call_ids", None) or [])

            if not names:
                text = getattr(resp, "completion_text", None) or ""
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

            for idx, nm in enumerate(names):
                a = args_list[idx] if idx < len(args_list) else {}
                if not isinstance(a, dict):
                    try:
                        a = json.loads(a or "{}")
                    except Exception:  # noqa: BLE001
                        a = {}
                call_id = ids[idx] if idx < len(ids) else f"call_{idx}"
                used.append(nm)
                logger.info("她自己动手：%s(%s)", nm, json.dumps(a, ensure_ascii=False)[:80])
                out = await self._execute(nm, a, event)
                contexts.append(
                    ToolCallMessageSegment(role="tool", tool_call_id=call_id, content=str(out))
                )
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
                    return "（已经交代下去了，等它跑完）", used

        logger.warning("自主行动超过 %s 步，收尾", self.max_steps)
        return "（这一轮做了不少事，先停一下）", used
