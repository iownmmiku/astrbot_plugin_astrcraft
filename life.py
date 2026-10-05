"""过日子系统：把"等指令干活"变成"自己在世界里生活"。

和原来的目标系统（`goals.py`）的区别：
- `goals.py`：你交代一件事 → 拆成步骤 → 做完为止 → 汇报。**工人逻辑**
- 这里：没人管的时候，她自己决定接下来干嘛，并且会记下来、会想分享。**过日子逻辑**

三层决策（按代价从低到高）：
1. **驱动层**（不花 LLM）：哪个欲望最强 → 给一个倾向
2. **决策层**（一次 LLM 调用）：结合处境、记忆、人格，决定"现在做什么"
3. **执行层**：把决定交给现有的技能/动作体系去做

为什么不让 LLM 每次都自由发挥：那样她会飘（今天挖矿明天忘了自己是谁）。
驱动力提供稳定的倾向，记忆提供连续性，人格决定表达方式——
三者叠加才有"一个角色在过日子"的感觉，而不是"每次随机找个事做"。

为什么不让规则决定一切：MC 太开放了，写死的规则撑不住。
所以规则只负责"想干什么"，具体"怎么干"交给模型。
"""

from __future__ import annotations

import asyncio
import json
import math
import random
import time
from enum import Enum

from .inbox import Delivery, Inbox, type_of
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from astrbot.api import logger

from .advisor import FOODS, RAW_FOODS, WOOD_NAMES, advise, advise_for_prompt
from .drives import DriveSystem
from .memory import MemoryStore
from .life_types import HOLD_RELEASE, HOLD_WHY, Hold, LifeDecision
from .life_render import PromptRenderMixin

# 决策阶段的行为约束（配合 perception_agent 的只读工具）
PERCEPTION_PROMPT_EXTRA = """在决定"接下来做什么"时：
- 需要事实就**先查看**（mc_status / mc_inventory / mc_scan / mc_players 都是只读的），
  不要凭印象猜背包里有什么、附近有没有树。
- **但状态简报已经把位置/背包/血量/时间内联在上面了** —— 大多数情况**直接给出决定**；
  只有简报里没有的事实才值得查，**至多查 1 次**（查最缺的那一样）。
- 查看完必须给出最终决定（那个 JSON），不要只查不做。
- **决定权在你**：「生存现状」只是参考信息，你可以按自己的想法来。"""

# 她可以"说出口"的话术模板。刻意写得含糊，让 LLM/persona 去润色，
# 避免出现"我是 AI 助手，正在为您执行任务"这种腔调。
SHARE_TEMPLATES = [
    "（在游戏里自言自语）{text}",
    "{text}",
]


def render_skill_catalog(skills) -> str:
    """把引擎给的技能清单渲染成提示词里的那几行（P1）。

    ## 为什么必须渲染**全部**技能

    这里原来是 `skills[:12]`——引擎有 21 个技能时，模型**看不到**这 9 个：
    `cook_food / hunt / food_chain / blueprint / sleep / interact / shoot / shield / craft`。

    后果不是"少了个选项"，而是**它不知道自己会**：不会想到"照图纸盖房子""打猎"
    "射箭""举盾""单件合成"，只能靠 advisor 恰好建议、或者主动调 `mc_skills` 去查。
    这与整个设计目标——**"它知道的 = 它能做的"**——直接矛盾。

    ## 代价与"为什么不能挪进动态段"

    实测渲染前 12 项 = 1038 字符，渲染全部 21 项 = **1610 字符**（+572）。
    这个代价可以接受，因为**这段是静态的**：它拼进 `system` 段（跨轮完全一致、
    可缓存），而每轮都在变的观察内容在 `user` 段。**不要因为"提示词变长了"
    就把它挪进动态段**——那会打穿前缀缓存，每一轮都要为这几千字重新付费，
    代价远大于 572 字符。

    ## 兼容两种清单形状

    `skill.list` 给的是 dict 列表（`{skill, description, params}`），
    也可能有人直接传字符串列表（`"chop_tree(count=8)：找树砍木材…"`）。
    两种都要能渲染——这条路径上出过"切片直接抛 KeyError"的坑。

    做成**模块级纯函数**（而不是写在 `_decide` 里）是为了能被测试直接喂假清单：
    `dev-tools/test_skill_visibility.py` 用它断言"21 个技能名一个都不能少"。
    """
    lines: list[str] = []
    for item in skills or []:
        if isinstance(item, dict):
            name = str(item.get("skill") or item.get("name") or "").strip()
            if not name:
                continue
            desc = str(item.get("description") or "").strip()
            params = item.get("params") or {}
            ps = ", ".join(f"{k}={v}" for k, v in params.items())
            if ps:
                lines.append(f"- {name}({ps})：{desc}" if desc else f"- {name}({ps})")
            else:
                lines.append(f"- {name}：{desc}" if desc else f"- {name}")
        else:
            text = str(item).strip()
            if text:
                lines.append(f"- {text}")
    return "\n".join(lines)




def _clip(text: str | None, limit: int) -> str:
    """把一段文本截到 limit 字以内（超了就截断并标明"还有更多"）。

    为什么要标明：直接截断会让模型以为"就这些了"，从而漏掉关键信息；
    写一句"（后面还有 N 字没显示）"它就知道可以用工具去查。
    """
    t = (text or "").strip()
    if len(t) <= limit:
        return t
    return f"{t[:limit].rstrip()}…（后面还有 {len(t) - limit} 字没显示）"







class LifeLoop(PromptRenderMixin):
    """她自己过日子的循环。

    @param engine_call 调引擎的入口（通常是 plugin._engine_call）
    @param memory 记忆
    @param drives 驱动力
    @param brief_provider 取当前状态简报的协程
    @param llm 调 LLM 的协程 (prompt, system) -> str|None
    @param system_prompt_provider 取人格 system prompt 的协程
    @param on_share 她说了一句想分享的话（发到 QQ / 游戏内）
    @param on_activity 她决定并开始做某件事（用于日志与订阅推送）
    """

    PREPARATION_SKILLS = frozenset(("make_tools", "cook_food", "food_chain", "smelt", "craft"))
    OUTDOOR_SKILLS = frozenset(("chop_tree", "mine_stone", "mine_ores", "collect", "hunt"))

    @classmethod
    def _needs_work_boundary(cls, skill: str) -> bool:
        return skill in cls.OUTDOOR_SKILLS or skill in cls.PREPARATION_SKILLS

    def __init__(
        self,
        *,
        engine_call: Callable[..., Awaitable[Any]],
        memory: MemoryStore,
        drives: DriveSystem,
        brief_provider: Callable[[], Awaitable[str]],
        llm: Callable[..., Awaitable[str | None]],
        system_prompt_provider: Callable[[], Awaitable[str]],
        skill_catalog_provider: Callable[[], Awaitable[list[dict]]] | None = None,
        on_share: Callable[[str], Awaitable[None]] | None = None,
        on_activity: Callable[[LifeDecision], Awaitable[None]] | None = None,
        inbox=None,
        is_connected: Callable[[], bool] | None = None,
        state_provider: Callable[[], Awaitable[dict]] | None = None,
        decide_interval: float = 90.0,
        min_decide_gap: float = 6.0,
        share_cooldown: float = 600.0,
    ):
        self._call = engine_call
        self.memory = memory
        self.drives = drives
        self._brief = brief_provider
        self._llm = llm
        self._system_prompt = system_prompt_provider
        self._skill_catalog = skill_catalog_provider
        self._on_share = on_share
        self._on_activity = on_activity
        self._is_connected = is_connected
        # 取真实状态（背包/血量/饥饿/是否夜晚），供生存顾问判断阶段
        self._state_provider = state_provider
        # 失败记忆：技能名 → 失败时间戳列表。
        # 没有它就会出现实测过的那种死循环：同一个技能连失败几十次、
        # 每 3 分钟重试一次、持续一小时，而决策层完全不知道"这个刚失败过"。
        self._recent_failures: dict[str, list[float]] = {}
        self._failure_window = 1800.0  # 只看最近半小时
        # "可被唤醒的等待"：任务结束时叫醒她，别干等一整个间隔
        self._wake = asyncio.Event()
        self._has_shelter = False
        self._homes: list[dict] = []
        self._last_advice = None
        # 她当前的"打算"：由 LLM 自己设定并跨轮保持，让过日子有连续性。
        # 真人心里一直有件事在推进（"我要盖个房子"），而不是每 90 秒重新掷骰子。
        self._intention: str = ""
        self._intention_rounds: int = 0
        self._intention_since: float = 0.0
        # 最近做过的事与结果（按时间倒序的小环形缓冲）。
        # 真人决策时会回想"我刚才在干嘛、成没成"，之前她完全没有这份信息——
        # 只有一份"当前状态"，所以看起来像失忆。
        self._recent_outcomes: list[dict] = []
        self._completed_tool_breaks: tuple | None = None
        # 最近一次死亡（位置+时间）。真人死后第一反应是"我的东西掉在那儿了"，
        # 而 MC 里掉落物大约 5 分钟就消失——不知道这件事就永远不会去捡。
        self._last_death: dict | None = None
        # 决策阶段用来"先查看再决定"的感知代理（由 main.py 注入，可为 None）
        self.perception = None
        # 自主行动用的动作代理（带完整工具集，由 main.py 注入）
        self.action_agent = None
        # 知识库（攻略 + 她自己总结的教训，由 main.py 注入）
        self.knowledge = None
        # 感知决策的失败计数与熔断（连续失败就退回纯文本，别让她停摆）
        self._perception_failures = 0
        self._perception_disabled_until = 0.0
        self._decide_timeouts = 0
        self._decision_retry_at = 0.0
        self._probing_endpoint = False
        # 未被模型成功处理的输入跨重试保留，避免一次端点故障吃掉玩家指令。
        self._decision_input_text = ""
        # **有序计划（任务排序）**：LLM 一次给几步，循环里按顺序执行，
        # 中间不再问模型 —— 这是"连续行动"的关键。
        self._plan: list[dict] = []
        self._plan_source: str = ""
        self._plan_revision = 0
        # 解析出来的"待装入"计划（_parse_decision 填、decide 末尾装队列）
        self._pending_plan: list[dict] = []
        self._session_planned = False
        # **LLM 自己写的任务清单**（todo_write 工具维护）
        self._todos: list[dict] = []
        # **技能名白名单**（引擎注册表里的真实技能名）。
        # 每次决策取技能清单时顺带刷新；为空表示"还没有可信清单"，
        # 此时一律放行（见 _skill_is_known 的说明）。
        self._known_skills: set[str] = set()

        self._decide_interval = decide_interval
        # 两次决策之间的最小间隔（"承诺机制"，见 _loop 里的说明）。
        # **必须是构造参数**：life.py 这个模块没有 _cfg（配置读取在 main.py），
        # 我第一版写成 self._cfg(...) → AttributeError 被循环的 except 吞掉 →
        # 每 8 秒重试一次、**永远不决策**（test_life_rhythm 立刻抓到："30 秒内行动 0 次"）。
        self._min_decide_gap = float(min_decide_gap or 0)
        # 连续失败两次后进入端点退避；到期自动探测，成功后解除。
        self._decide_retry_limit = 2
        # ---- 永不空闲（W7）----
        # **只对"同一件事反复失败"退避**，不对所有决策退避。
        # 上一轮那个 `min_decide_gap = 6`（一刀切）已经拆掉：
        # 它治错了病——病根是"重新规划太频繁"，而副作用是"没事做时也要干等 6 秒"。
        self._idle_rounds = 0  # 连续"这一轮什么都没做成"的次数
        self._idle_since = 0.0  # 从什么时候开始连续没事做
        self._last_idle_note_at = 0.0  # 上次把"没事做"说出去的时间（别刷屏）
        self._backoff_until = 0.0  # 失败退避到什么时候
        self._failure_cooldowns: dict[str, float] = {}
        self._failure_backoff_seen: dict[str, tuple] = {}
        self._failure_revisions: dict[str, int] = {}
        # Completion is checked against the next real supply snapshot.
        self._rule_supply_candidate: dict | None = None
        self._rule_supply_attempt: dict | None = None
        self._rule_supply_wait_reason = ""
        self._rule_supply_stalls: dict[str, dict] = {}
        # Historical failures inform the model; rule retries have a separate,
        # bounded budget that only fresh, verified supplies can renew.
        self._rule_supply_failures: dict[str, dict] = {}
        # Completion needs a fresh world and body check, including nested mining.
        self._return_task_attempt: dict | None = None
        self._mining_return: dict | None = None
        self._return_control_generation = 0
        self._return_boundary_state: dict = {}
        # ---- 输入队列（W4，见 docs/PLAN_v2.md）----
        # 主人的话与世界事件**共用**这一个队列。没有它的时候：
        # 她跑长任务时主人说话她听不见；世界事件只有下一轮决策时才知道。
        self.inbox = inbox if inbox is not None else Inbox()
        # 本轮要接上的"排着的事"（FOLLOW_UP），由循环在"她本来要停"时填。
        self._pending_follow_up: str = ""
        # Owner input remains authoritative after it leaves the inbox, including
        # provider failures. World events never acquire this permission barrier.
        self._decision_owner_pending = False
        self._decision_owner_generation = 0
        # 急件叫醒：叫的是"来问吧"，**不递事件**——
        # 正确性从不依赖叫醒（队列的 ready()/has_urgent() 随时可问、答案一致）。
        try:
            self.inbox.on_urgent(lambda: self._wake.set())
        except Exception as exc:  # noqa: BLE001
            logger.info("登记急件叫醒失败：%s", exc)
        self._share_cooldown = share_cooldown
        self._last_share_at = 0.0
        self._last_decide_at = 0.0
        self._task: asyncio.Task | None = None
        self._stopped = False
        self._paused = False
        self._pause_reason = ""
        self._pause_until = 0.0
        # ---- Hold（停牌）的真实状态源 ----
        # 这里只存**事实**，判断集中在 current_hold() 一处。
        # 原来这些条件散在 _loop 里各判各的，谁也说不清她为什么没动。
        self._dead = False  # 死了（等复活）
        self._world_changing = False
        self._engine_up = True  # 引擎进程在不在（默认乐观，由 main.py 告知）
        self._blocked_reason = ""  # 模型端点不可用的原因（空 = 可用）
        self._announced_hold: Hold | None = None  # 只为找"变化沿"，不参与判断
        self._busy_until = 0.0
        # 单次决策的超时。必须有：LLM 卡住时若没有超时，整个循环会**永久冻结**，
        # 而且不留任何日志——实测她因此"一次都没自己动过"，
        # 排查时完全没有线索（只能看到一个启动日志）。
        #
        # 这个值要**够大**：决策现在可能包含多次 LLM 往返
        # （先查看 → 决定 → 发现失败过再问一次），每次 10~30 秒很常见。
        # 早期设 90 秒，实测在"感知工具报错退回纯文本 + 再问一次"的路径上会稳定超时。
        self._decide_timeout = 150.0

        self.current: LifeDecision | None = None
        self.history: list[LifeDecision] = []
        self._data_dir: Path | None = None

    # ------------------------------------------------------------ 生命周期

    def bind_data_dir(self, data_dir: Path) -> None:
        self._data_dir = Path(data_dir)
        # 立刻读回长期状态（打算/住处），这样重启后她不会失忆
        self._load_state()

    # ------------------------------------------------------------ 失败记忆

    def note_decision_cut(self, reason: str, *, kind: str = "timeout") -> None:
        """**记一次"想事情本身没成"**（W3，见 docs/PLAN_v2.md）。

        为什么必须记：原来决策超时只打一行日志 + `sleep(8)` 重来，
        **模型完全不知道上一轮失败了** ✗ 于是下一轮可能原样再来一遍，
        或者以为自己刚才做过什么（其实被切断了）。

        这对应 numen 的"在历史里写切断点"（`writeHalt`）——
        它是进程内、有会话历史，所以写进历史；我们是**每轮无状态**的
        （`ActionAgent.act()` 每次都从一条新 user 消息开始），
        所以等价物是**写进"最近做过的事"**，让下一轮的观察里带着它。

        @param kind timeout（超时）/ failed（调用出错）/ cancelled（被取消）
        """
        detail = {
            "timeout": "想事情超时了，没想出来",
            "failed": "想事情的时候出错了",
            "cancelled": "想事情被中断了",
        }.get(kind, "想事情没成")
        self._recent_outcomes.append(
            {
                "at": time.time(),
                "skill": "（想事情）",
                "ok": False,
                "detail": f"{detail}：{str(reason or '').strip()[:60]}",
                # 标出来，渲染时用不同的说法——"想事情失败"和"做事失败"不是一回事
                "decision": True,
            }
        )
        if len(self._recent_outcomes) > 8:
            self._recent_outcomes = self._recent_outcomes[-8:]
        logger.warning("记下一次决策失败（%s）：%s", kind, reason)

    # ------------------------------------------------------------ 永不空闲（W7）

    # ------------------------------------------------------------ 输入队列（W4）



    def _run_control(self) -> str:
        """执行控制条目——**只在完全空闲时**（W4）。

        为什么只在完全空闲：整理记忆/清空上下文会**改变她正在看的历史**，
        干活干到一半做这个等于把图纸抽走。所以它们排在队首当屏障，
        等她真的没事了再执行。
        """
        if not self.inbox.head_is_control():
            return ""
        try:
            taken = self.inbox.take_control()
        except Exception as exc:  # noqa: BLE001
            logger.info("取控制条目失败：%s", exc)
            return ""
        if not taken:
            return ""
        done = []
        for e in taken:
            if e.type == "clear":
                # 清空：丢掉计划、清单和打算——下一次决策从干净的状态开始
                self.clear_plan("主人要求清空上下文")
                self._todos = []
                self._intention = ""
                self._intention_rounds = 0
                self._intention_since = 0.0
                self._acknowledge_decision_inputs()
                done.append("清空计划和清单")
            elif e.type == "compact":
                # 整理记忆：把同类条目合并（W5 之后是"只增补"的合并，不会丢信息）
                try:
                    if self.memory is not None:
                        self.memory.prune()
                        done.append("整理记忆")
                except Exception as exc:  # noqa: BLE001
                    logger.info("整理记忆失败：%s", exc)
            else:
                done.append(f"（不认识的控制器 {e.type}，跳过）")
        text = "、".join(done) if done else ""
        if text:
            logger.info("执行控制条目：%s", text)
        return text




    def _should_back_off(self, skill: str | None = None) -> bool:
        """该不该退避一下？**只对"同一件事反复失败"退避**，不对所有决策退避。

        这是 W7 的核心：用户要"没有任务就立刻发起一个"，
        所以**不能**像上一轮那样对所有决策一律压 6 秒。
        真正该歇一会儿的只有一种情况——同一个技能在短时间内反复失败
        （说明她卡住了，再立刻重试还是同样结果，只会刷日志）。
        """
        now = time.time()
        counts = self._failure_counts()
        seen = getattr(self, "_failure_backoff_seen", {})
        revisions = getattr(self, "_failure_revisions", {})
        fresh = {}
        cooldowns = getattr(self, "_failure_cooldowns", {})
        for failed_skill, count in counts.items():
            signature = (revisions.get(failed_skill, 0), tuple(self._recent_failures[failed_skill]))
            if count >= 3 and seen.get(failed_skill) != signature:
                fresh[failed_skill] = count
                seen[failed_skill] = signature
                cooldowns[failed_skill] = now + 30.0
        self._failure_backoff_seen = seen
        # 只有主人新指令能覆盖失败冷却；受伤等世界事件不能让
        # 同一个已经失败的行为立即重试。失败事实仍留给模型换策略。
        inbox = getattr(self, "inbox", None)
        if inbox is not None and self._queued_owner_steer():
            cooldowns.clear()
            self._backoff_until = 0.0
            return False
        self._failure_cooldowns = {name: until for name, until in cooldowns.items() if until > now}
        self._backoff_until = max(self._failure_cooldowns.values(), default=0.0)
        if fresh:
            logger.info(
                "这些技能暂缓重试 30 秒（已失败 %d 次：%s），其他行动可以继续",
                max(fresh.values()),
                "、".join(sorted(fresh)[:3]),
            )
        return bool(self._failure_cooldowns) if skill is None else skill in self._failure_cooldowns

    def skill_retry_ready(self, skill: str) -> bool:
        """自主行动是否可重试这个技能；不限制玩家直接指派的行动。"""
        return not self._should_back_off(str(skill or ""))

    def _queued_owner_steer(self) -> bool:
        """Only an unconsumed owner entry grants a fresh failure retry override."""
        for entry in self.inbox.entries:
            spec = type_of(entry.type)
            if spec.delivery is Delivery.CONTROL:
                break
            if spec.from_owner and spec.delivery is Delivery.STEER:
                return True
        return False

    def _owner_steer_pending(self) -> bool:
        """Keep the rule-action barrier until the owner's input is processed successfully."""
        return getattr(self, "_decision_owner_pending", False) or self._queued_owner_steer()

    def _note_busy_round(self) -> None:
        """这一轮**有事做**（执行了计划的一步）→ 清掉"没事做"的计数。"""
        self._idle_rounds = 0
        self._idle_since = 0.0

    def note_idle_round(self, why: str = "") -> None:
        """这一轮**什么都没做成**——记下来，而且**要说出去**（W7）。

        为什么必须可见：用户看到的是"她站在原地"，而日志里什么都没有。
        真人也一样：没事干的时候会嘟囔一句，不会像死机一样杵着。
        但也不能每轮都喊——所以有冷却（默认 60 秒说一次）。
        """
        self._idle_rounds += 1
        if not self._idle_since:
            self._idle_since = time.time()
        now = time.time()
        if now - self._last_idle_note_at < 60.0:
            return
        self._last_idle_note_at = now
        mins = (now - self._idle_since) / 60.0
        detail = f"（{why}）" if why else ""
        logger.warning(
            "她已经连续 %d 轮没做成任何事%s，持续 %.1f 分钟——**这不是停牌**，"
            "是「能跑但确实没活」（IDLE_NO_WORK）",
            self._idle_rounds,
            detail,
            mins,
        )
        self.state_note(f"我暂时想不出该做什么{detail}")



    @staticmethod
    def _return_position(value: object) -> dict | None:
        if not isinstance(value, dict):
            return None
        if not all(type(value.get(k)) in (int, float) and math.isfinite(value[k])
                   and abs(value[k]) < 32_000_000 for k in ("x", "y", "z")):
            return None
        return {k: float(value[k]) for k in ("x", "y", "z")}

    @staticmethod
    def _return_world(state: dict) -> tuple:
        return (state.get("server"), str(state.get("dimension") or "").removeprefix("minecraft:"))

    @staticmethod
    def _return_distance(a: dict, b: dict) -> float:
        return math.sqrt(sum((a[k] - b[k]) ** 2 for k in ("x", "y", "z")))

    def register_task_submission(self, skill: str, state: dict | None = None) -> dict | None:
        """Register before RPC; a completion arriving before its reply is buffered."""
        if not self.may_act(allow_model_block=True) or self._owner_steer_pending():
            return None
        previous = self._return_task_attempt
        if previous and not previous.get("task_id") and previous["skill"] == skill:
            return previous
        snapshot = state if isinstance(state, dict) else self._return_boundary_state
        pending = self._mining_return if skill == "climb_out" else None
        token = {"skill": skill, "revision": self._plan_revision,
                 "owner": self._decision_owner_generation, "generation": self._return_control_generation,
                 "world": self._return_world(snapshot), "task_id": None, "early": {},
                 "pending": pending, "position": self._return_position(snapshot.get("position")),
                 "supply_return": self._mining_return if skill in ("eat", "recover") else None}
        self._return_task_attempt = token
        if pending is not None:
            pending["attempts"] += 1
            pending["awaiting"] = True
            pending["before"] = token["position"]
        return token

    def bind_task_submission(self, token: dict | None, reply: dict | None) -> None:
        """Bind the real task id; None releases a failed submission safely."""
        if token is None or self._return_task_attempt is not token:
            return
        task_id = (reply or {}).get("task_id") if isinstance(reply, dict) else None
        if not task_id:
            self._return_task_attempt = None
            pending = token.get("pending")
            if pending is not None and self._mining_return is pending:
                pending["reported"] = {"ok": False, "reason": "脱困任务未能提交"}
            return
        token["task_id"] = str(task_id)
        completion = token["early"].get(str(task_id))
        token["early"].clear()
        if completion:
            if len(completion) == 2:
                _, reason = completion
                self.note_task_cancelled(token["skill"], reason, task_id=str(task_id))
            else:
                ok, error, result = completion
                self.note_task_result(token["skill"], ok, error, result=result, task_id=str(task_id))

    def _return_token_current(self, token: dict) -> bool:
        return (token["revision"] == self._plan_revision
                and token["owner"] == self._decision_owner_generation
                and token["generation"] == self._return_control_generation
                and self.may_act(allow_model_block=True) and not self._owner_steer_pending())

    def _accept_return_completion(self, name: str, ok: bool, error: str,
                                  result: dict, task_id: str | None) -> bool | None:
        token = self._return_task_attempt
        if token is None or token["skill"] != name or not self._return_token_current(token):
            return None
        if task_id and token["task_id"] is None:
            # Do not let an old same-name task steal the new submission.
            if len(token["early"]) < 4:
                token["early"][str(task_id)] = (ok, error, result)
            return None
        if task_id and str(task_id) != token["task_id"]:
            return None
        self._return_task_attempt = None
        status = result["return_status"]
        pending = token.get("pending")
        if pending is not None:
            if self._mining_return is not pending:
                return None
            pending["reported"] = dict(status)
            return True
        if status.get("required") is not True:
            return False
        world = self._return_world(status)
        if not all(world) or token["world"][0] and token["world"] != world:
            return None
        # Partial collection invalidates dependent work, but still needs rescue.
        if result.get("collection_ok") is not True:
            self.clear_plan(f"{name} 没有采足材料，脱困后重新安排")
        self._mining_return = {
            "revision": self._plan_revision, "owner": self._decision_owner_generation,
            "generation": self._return_control_generation, "world": world,
            "target": self._return_position(status.get("target")), "reported": dict(status),
            "attempts": 0, "no_progress": 0, "awaiting": False, "before": None,
        }
        self._wake.set()
        return True

    def _return_verified(self, pending: dict, state: dict) -> bool:
        report = pending.get("reported") or {}
        position, reported = self._return_position(state.get("position")), self._return_position(report.get("position"))
        safety = state.get("mining_return_safety") or {}
        if (report.get("ok") is not True or self._return_world(report) != pending["world"]
                or position is None or reported is None or self._return_distance(position, reported) > 1.5
                or not all(safety.get(k) is True for k in ("safe", "loaded", "on_ground"))
                or safety.get("underground") is not False):
            return False
        # The original entrance guides rescue, but a different verified surface
        # exit is equally valid. Height alone never proves a safe exit.
        return True

    def note_owner_said(self, text: str) -> None:
        super().note_owner_said(text)
        if self._mining_return is not None or self._return_task_attempt is not None:
            self.clear_plan("主人给了新指令，旧采矿返程计划作废")

    def _mining_return_step(self, state: dict, advice: object, observation: dict) -> dict | None:
        pending = self._mining_return
        if pending is None:
            return None
        world = self._return_world(state)
        if (pending["revision"] != self._plan_revision or pending["owner"] != self._decision_owner_generation
                or pending["generation"] != self._return_control_generation or world != pending["world"] and all(world)):
            self.clear_plan("返程等待期间世界或指令已变化，旧采矿计划作废")
            return None
        if not all(world) or self._return_position(state.get("position")) is None:
            self._rule_supply_wait_reason = "采矿后尚未取得完整返程状态，保留计划等待核验"
            return None
        if self._safe_home_for_state(state) is not None or self._return_verified(pending, state):
            self._mining_return = None
            self._failure_cooldowns.pop("climb_out", None)
            self.state_note("采矿返程已由最新位置和安全地面核验，接回后续计划")
            return None
        # Existing food and recovery are urgent; searching for new supplies must
        # not resume arbitrary work while the body is still underground.
        if (advice.priority == "survival" and advice.skill in ("eat", "recover")
                and self._skill_is_known(advice.skill) and self.skill_retry_ready(advice.skill)
                and not self._rule_supply_stalled(advice.skill, advice.params, observation)
                and not self._rule_supply_failed(advice.skill, observation)):
            self._rule_supply_candidate = {"skill": advice.skill, "params": dict(advice.params),
                                           "state": observation, "revision": self._plan_revision,
                                           "return_pending": pending}
            return {"skill": advice.skill, "params": dict(advice.params), "why": advice.why}
        if pending["awaiting"] and pending.get("reported") is None:
            self._rule_supply_wait_reason = "脱困任务仍等待完成通知，保留后续计划"
            return None
        if pending["awaiting"]:
            before, after, target = pending["before"], self._return_position(state["position"]), pending["target"]
            improved = before is not None and (after["y"] >= before["y"] + 0.5
                or target is not None and self._return_distance(after, target) < self._return_distance(before, target) - 1)
            pending["no_progress"] = 0 if improved else pending["no_progress"] + 1
            pending["awaiting"] = False
        if pending["no_progress"] >= 2 or pending["attempts"] >= 4 or not self._skill_is_known("climb_out"):
            reason = "采矿返程仍未安全完成，自动脱困已达重试上限；需要重新观察路线或等待救援"
            self.clear_plan(reason)
            self._failure_cooldowns["climb_out"] = time.time() + 30
            self._recent_outcomes.append({"at": time.time(), "skill": "climb_out", "ok": False,
                                          "detail": reason[:60]})
            self._recent_outcomes = self._recent_outcomes[-8:]
            self.state_note(reason)
            return None
        pending["reported"] = None
        params = {"max_steps": 40}
        if pending["target"] is not None:
            params["return_target"] = dict(pending["target"])
        return {"skill": "climb_out", "params": params, "why": "先安全离开矿洞，再继续已取得材料后的计划"}

    def note_task_result(self, name: str, ok: bool, error: str = "", *, expected_unavailable: bool = False,
                         result: dict | None = None, task_id: str | None = None,
                         _completed_supply: dict | None = None) -> None:
        """记录一次任务结果（由插件在 task.finished 时调用）。

        只记技能名，用于"别在同一件事上无限循环"。成功会**清掉**该技能的失败记录——
        这样"失败过但后来做成了"不会一直被念叨。
        同时存进"最近做过的事"，让决策时能回想刚才发生了什么。
        """
        if not name:
            return
        token = self._return_task_attempt
        completed_return = (_completed_supply is not None and _completed_supply.get("skill") == name
                            and self._completed_supply_return_current(_completed_supply))
        if (name in ("eat", "recover") and self._mining_return is not None
                and not completed_return and (token is None or token["skill"] != name)):
            return  # Untracked meal success must not renew failed food during a newer rescue either.
        if task_id and token is not None and token["skill"] == name:
            if not self._return_token_current(token):
                return
            if token["task_id"] is None:
                if len(token["early"]) < 4:
                    token["early"][str(task_id)] = (ok, error, result)
                return
            if str(task_id) != token["task_id"]:
                return
        keep_return_plan = bool(completed_return)
        return_proof = None
        if isinstance(result, dict) and isinstance(result.get("return_status"), dict):
            accepted = self._accept_return_completion(name, ok, error, result, task_id)
            if accepted is None:
                return  # Superseded, unknown or awaiting the actual RPC task id.
            keep_return_plan = accepted
        elif self._mining_return is not None and name == "climb_out":
            if token is None or token["skill"] != name or not self._return_token_current(token):
                return
            self._return_task_attempt = None
            if self._mining_return is token.get("pending"):
                # A legacy or forged success without physical return evidence
                # never unlocks the queued work.
                self._mining_return["reported"] = {"ok": False, "reason": error or "缺少返程核验结果"}
                keep_return_plan = True
        elif token is not None and token["skill"] == name:
            if not self._return_token_current(token):
                return
            pending = token.get("supply_return")
            current_supply_return = bool(pending is not None and self._mining_return is pending
                and all(token["world"]) and token["world"] == pending["world"]
                and pending["revision"] == token["revision"]
                and pending["owner"] == token["owner"] and pending["generation"] == token["generation"])
            keep_return_plan = keep_return_plan or (not ok and current_supply_return)
            if ok and current_supply_return and token.get("task_id"):
                return_proof = token
            self._return_task_attempt = None
        attempt = getattr(self, "_rule_supply_attempt", None)
        if attempt is not None and attempt["skill"] == name:
            attempt["ok"] = bool(ok)
            if return_proof is not None and attempt.get("return_pending") is return_proof.get("supply_return"):
                attempt["return_proof"] = return_proof
        elif ok:
            getattr(self, "_rule_supply_stalls", {}).pop(name, None)
        now = time.time()
        # 最近做过的事（保留最近 8 条，给决策当"短期记忆"）
        self._recent_outcomes.append(
            {
                "at": now,
                "skill": name,
                "ok": bool(ok),
                "detail": (error or "").strip()[:60],
            }
        )
        if len(self._recent_outcomes) > 8:
            self._recent_outcomes = self._recent_outcomes[-8:]

        if isinstance(result, dict) and isinstance(result.get("return_status"), dict):
            self._recent_outcomes[-1].update(
                produced=dict(result.get("produced") or {}),
                collection_ok=result.get("collection_ok"),
                return_status=dict(result["return_status"]),
            )
            if ok and result.get("collection_ok") is True:
                # Keep entry identities: Windows wall-clock timestamps can be
                # equal for a completion and a genuinely later new break.
                self._completed_tool_breaks = (self._recent_outcomes[-1],
                    tuple(entry for entry in self.inbox.entries if entry.type == "tool_broken"))
        if ok:
            self._recent_failures.pop(name, None)
            self._rule_supply_failures.pop(name, None)
            getattr(self, "_failure_cooldowns", {}).pop(name, None)
            getattr(self, "_failure_backoff_seen", {}).pop(name, None)
            if not self._failure_counts():
                self._backoff_until = 0.0
            if name in ("build_shelter", "建庇护所"):
                self._has_shelter = True
            return
        # A verified empty shelf is a useful observation, not a broken route.
        # Keep only the matching rule's established work; the stock TTL selects
        # cooking/hunting next without poisoning route failure counts.
        if (expected_unavailable and name == "resupply_food" and attempt is not None
                and attempt["skill"] == name and attempt["revision"] == self._plan_revision):
            return
        observation = attempt.get("state") if attempt is not None and attempt["skill"] == name else None
        if observation is None:
            boundary = self._return_boundary_state
            if (isinstance(boundary.get("inventory"), dict) and boundary.get("food") is not None
                    and boundary.get("health") is not None):
                observation = self._supply_observation(boundary)
        if observation is not None and name in ("eat", "cook_food", "hunt", "recover", "store_items",
                                               "resupply_food", "leave_home", "sleep", "return_home", "build_shelter"):
            previous = self._rule_supply_failures.get(name, {})
            failed = {"count": previous.get("count", 0) + 1, "state": observation,
                      "params": dict(attempt["params"]) if attempt is not None and attempt["skill"] == name else {}}
            self._rule_supply_failures[name] = failed
            if failed["count"] >= 2:
                self._failure_cooldowns[name] = now + 30.0
        bucket = self._recent_failures.setdefault(name, [])
        bucket.append(now)
        revisions = getattr(self, "_failure_revisions", {})
        revisions[name] = revisions.get(name, 0) + 1
        self._failure_revisions = revisions
        # 只保留窗口内的
        self._recent_failures[name] = [t for t in bucket if now - t <= self._failure_window][-8:]
        # **一步失败就丢掉剩余计划**：计划是按"前一步成功"排的，
        # 前一步失败还硬按原顺序做后面的事，只会连环失败。
        # 丢掉之后下一轮会重新问 LLM 排一份新的（它会看到失败记录）。
        if not keep_return_plan and (self._plan or getattr(self, "_pending_plan", [])):
            self.clear_plan(f"{name} 失败：{(error or '')[:40]}")
        logger.info("记录失败：%s（近半小时第 %d 次）%s", name, len(self._recent_failures[name]), error[:60])
        # **学习回路**：同一个坑摔第三次就停下来总结一条教训。
        #
        # 为什么是"第三次"而不是每次：第一次可能是偶发（网络、地形），
        # 第二次还可能是运气；连续三次说明这是**规律**，值得记下来。
        # 而且每次失败都去调模型总结太贵（一次往返几秒 + token）。
        if not keep_return_plan and self.knowledge is not None and len(self._recent_failures[name]) == 3:
            self._schedule_lesson(name, error or "")



    def note_task_cancelled(self, name: str, reason: str = "", *, task_id: str | None = None) -> None:
        """安全抢占或主人取消属于中断，不作为技能失败或学习材料。"""
        if not name:
            return
        if task_id:
            token = self._return_task_attempt
            if token is None or token["skill"] != name or not self._return_token_current(token):
                return
            if token["task_id"] is None:
                if len(token["early"]) < 4:
                    token["early"][str(task_id)] = ("cancelled", reason)
                return
            if token["task_id"] != str(task_id):
                return
        if self._rule_supply_attempt is not None and self._rule_supply_attempt["skill"] == name:
            self._rule_supply_attempt = None
        if self._return_task_attempt is not None and self._return_task_attempt["skill"] == name:
            self._return_task_attempt = None
        if self._mining_return is not None:
            self.clear_plan("返程任务被中断，旧采矿计划作废")
        self._recent_outcomes.append({
            "at": time.time(), "skill": name, "ok": None, "cancelled": True,
            "detail": (reason or "任务被中断").strip()[:60],
        })
        self._recent_outcomes = self._recent_outcomes[-8:]
        if self._plan or self._pending_plan:
            self.clear_plan(f"{name} 被中断，依赖它的后续步骤需重新观察")

    def note_death(self, position: dict | None = None) -> None:
        """记住"我刚死在哪"，并**真的把状态重置成"从零开始"**（C 批次）。

        **改之前它只打了一行日志**——注释写着"死亡是重大变故：原来的打算多半要
        重新考虑"，但代码什么都没做。后果（用户实测反馈）：
          "死过一次之后，他不会做木镐什么的了，直接开始挖泥土，也不去拾取掉落的装备"

        为什么会那样：她死后**身上什么都没有**，而打算/清单还是死前那套
        （比如"盖个房子"）。泥土**徒手就能挖**、立刻"任务成功"；
        做木镐要先砍树还要合成、容易失败。**没有任何东西告诉她"你现在一无所有、
        必须先重建工具"** —— 所以她做的是**能成功的事**，不是**该做的事**。

        现在：清掉打算/清单/计划，**写一份"死亡恢复"清单**。
        用现成的 todo 机制，不需要新机制——需要的是"死亡时真的用它"。
        """
        self._last_death = {
            "at": time.time(),
            "position": dict(position or {}),
        }
        logger.info("记下死亡地点：%s", self._last_death["position"])

        # ---- 真的做注释说的事 ----
        if self._intention:
            logger.info("她死了，丢掉原来的打算「%s」", self._intention)
        self._intention = ""
        self._intention_rounds = 0
        self._intention_since = 0.0
        self.clear_plan("她死了，死前的计划作废")
        self._rule_supply_candidate = self._rule_supply_attempt = None
        self._rule_supply_stalls.clear()
        # **写一份恢复清单**：顺序是有讲究的——
        # 先徒手能做的（砍树），再做工具，然后才是石头；最后才轮到死前那件事。
        self._todos = self._death_recovery_todos()
        logger.warning(
            "她死了：已丢掉打算和计划，写入 %d 条死亡恢复清单"
            "（先砍树 → 做木镐 → 挖石头 → 再想原来的事）",
            len(self._todos),
        )
        # 叫醒她：别等下一个决策间隔，立刻按新清单开始
        try:
            self._wake.set()
        except Exception:  # noqa: BLE001
            pass

    def death_drop_hint(self) -> str:
        """给提示词用：**该不该回去捡**（C 批次，含时间判断）。

        **为什么必须做时间判断**：MC 里掉落物大约 **5 分钟**消失。
        不做判断的话会出现"她花 6 分钟走回去、什么都没捡到"——**那比不去更糟**
        （浪费 6 分钟，而且失败会写进她的教训里）。
        """
        d = self._last_death
        if not d:
            return ""
        ago = time.time() - float(d.get("at") or 0)
        mins = ago / 60.0
        pos = d.get("position") or {}
        where = f"({pos.get('x')}, {pos.get('y')}, {pos.get('z')})" if pos else "某处"
        if ago > 360:
            # 超过 6 分钟：东西早没了，别让她白跑
            self._last_death = None
            return ""
        if mins >= 4:
            return (
                f"- 你 {int(mins)} 分钟前死在 {where}，**掉落物基本已经消失了**，"
                "别再回去找了，直接从砍树开始重建。"
            )
        return (
            f"- 你 {int(mins)} 分钟前死在 {where}，身上的东西都掉在那里。"
            f"**掉落物大约 5 分钟就消失**——所以：\n"
            f"    · 如果你判断**能在 2 分钟内走到**（大约 100 格以内、路上没有大坑或水），"
            f"就去捡（mc_recover_drops 会告诉你值不值得去）；\n"
            f"    · 否则**别去**，直接开始重建（先砍树做木镐）——"
            f"走一趟捡不到东西比不去更亏。"
        )





    async def _build_advice(self, state: dict | None = None) -> object:
        """算一次生存建议。"""
        st = state if state is not None else await self._gather_state()
        adv = advise(
            st.get("inventory") or {},
            health=float(st["health"] if st.get("health") is not None else 20),
            food=int(st["food"] if st.get("food") is not None else 20),
            has_shelter=bool(st.get("has_shelter", self._has_shelter)),
            recent_failures=self._failure_counts(),
            is_night=bool(st.get("is_night", False)),
            inventory_slots_used=int(st.get("inventory_slots_used", 0) or 0),
            nearby_entities=st.get("nearby_entities") or [],
            home=self._home_for_state(st),
            home_status=st.get("home_status") or {},
        )
        self._last_advice = adv
        return adv

    @staticmethod
    def _valid_home(home: object) -> bool:
        if (not isinstance(home, dict) or not isinstance(home.get("server"), str) or not home["server"]
                or not isinstance(home.get("dimension"), str) or not home["dimension"]):
            return False
        origin = home.get("origin")
        return (isinstance(origin, dict) and all(type(origin.get(k)) is int for k in ("x", "y", "z"))
                and type(home.get("size")) is int and 4 <= home["size"] <= 8
                and type(home.get("wall_height")) is int and 2 <= home["wall_height"] <= 4
                and home.get("complete") is True and home.get("has_roof") is True
                and isinstance(home.get("verified_at", 0), (int, float)) and 0 <= home.get("verified_at", 0) < 1e16)

    def home_for_world(self, state: dict) -> dict | None:
        """A historical base belongs to one server and dimension; its safety is checked separately."""
        server = state.get("server")
        dimension = str(state.get("dimension") or "").removeprefix("minecraft:")
        if not server or not dimension:
            return None
        matches = [home for home in self._homes if home["server"] == server
                   and str(home["dimension"]).removeprefix("minecraft:") == dimension]
        return dict(max(matches, key=lambda home: float(home.get("verified_at") or 0))) if matches else None

    def _home_for_state(self, state: dict) -> dict | None:
        offered = state.get("home")
        if (self._valid_home(offered) and offered["server"] == state.get("server")
                and str(offered["dimension"]).removeprefix("minecraft:") ==
                str(state.get("dimension") or "").removeprefix("minecraft:")):
            return offered
        return self.home_for_world(state)

    def remember_home(self, home: dict) -> bool:
        """Called only for a completed construction result containing an actual world report."""
        if not self._valid_home(home):
            return False
        record = json.loads(json.dumps(home, ensure_ascii=False))
        record["dimension"] = str(record["dimension"]).removeprefix("minecraft:")
        record["condition"] = "intact"
        record["verified_at"] = record.get("verified_at") or time.time() * 1000
        self._homes = [old for old in self._homes if not (old["server"] == record["server"]
                       and old["dimension"] == record["dimension"] and old["origin"] == record["origin"])]
        self._homes.append(record)
        self._homes = sorted(self._homes, key=lambda h: float(h.get("verified_at") or 0))[-8:]
        self._save_state()
        return True

    def note_home_status(self, home: dict, status: dict) -> None:
        """Unknown chunks preserve location; a real missing structure stops being a safe home."""
        if status.get("condition") not in ("intact", "missing", "unknown"):
            return
        for record in self._homes:
            if (record["server"] == home.get("server") and record["dimension"] == str(home.get("dimension") or "").removeprefix("minecraft:")
                    and record["origin"] == home.get("origin")):
                # Losing chunk visibility does not repair previously observed damage.
                if record.get("condition") == "missing" and status["condition"] == "unknown":
                    break
                changed = record.get("condition") != status["condition"]
                record["condition"] = status["condition"]
                if status.get("loaded") and isinstance(status.get("furniture"), dict):
                    changed = changed or record.get("furnished") != status["furniture"]
                    record["furnished"] = dict(status["furniture"])
                if changed:
                    self._save_state()
                break

    def note_home_food(self, home: dict, result: dict) -> None:
        """Only a complete actual stock check can briefly suppress an empty trip."""
        checked = result.get("food_stock_checked") is True
        empty = result.get("food_stock_empty")
        produced = result.get("produced") or {}
        ordinary = set(FOODS) - {"golden_apple", "enchanted_golden_apple"}
        got_food = isinstance(produced, dict) and any(type(produced.get(name)) in (int, float)
                   and produced[name] > 0 for name in ordinary if name in produced)
        if not (checked and type(empty) is bool) and not got_food:
            return
        for record in self._homes:
            if (record["server"] == home.get("server") and record["dimension"] ==
                    str(home.get("dimension") or "").removeprefix("minecraft:")
                    and record["origin"] == home.get("origin")):
                record["food_stock_empty"] = empty if checked else False
                record["food_stock_checked_at"] = time.time()
                self._save_state()
                break

    def _supply_observation(self, state: dict) -> dict:
        inv = state["inventory"]
        count = lambda names: sum(int(inv.get(name, 0) or 0) for name in names)
        status = state.get("home_status") or {}
        furniture = status.get("furniture") or {}
        verified_furniture = (furniture if self._home_for_state(state) is not None
            and status.get("loaded") is True and status.get("condition") == "intact" else {})
        return {
            "server": state.get("server"), "dimension": state.get("dimension"),
            "inside_home": (state.get("home_status") or {}).get("inside"),
            "food": state["food"], "health": state["health"],
            "ready": count(FOODS), "raw": count(RAW_FOODS), "wheat": count(("wheat",)),
            "wood": count(WOOD_NAMES) + count(name for name in inv if name.endswith("_planks")),
            "fuel": count(("coal", "charcoal")),
            "stations": count(("crafting_table", "furnace", "smoker", "blast_furnace"))
                + sum(verified_furniture.get(kind) is True for kind in ("crafting_table", "furnace", "smoker", "blast_furnace")),
            "storage": count(("chest", "trapped_chest", "barrel")) + (verified_furniture.get("chest") is True),
            "slots": state.get("inventory_slots_used"), "items": count(inv),
            "animals": sorted({e.get("name") for e in (state.get("nearby_entities") or [])
                               if isinstance(e, dict) and e.get("name") in ("cow", "pig", "sheep", "chicken", "rabbit")}),
        }

    @staticmethod
    def _supply_progress(skill: str, before: dict, after: dict) -> bool:
        if skill == "eat":
            return after["food"] > before["food"]
        if skill in ("cook_food", "hunt", "resupply_food"):
            return (after["food"] > before["food"] or after["ready"] > before["ready"]
                    or (skill == "hunt" and after["raw"] > before["raw"]))
        if skill == "recover":
            return after["health"] > before["health"]
        if skill == "leave_home":
            return before.get("inside_home") is True and after.get("inside_home") is False
        if skill == "store_items":
            return (after["items"] < before["items"] or
                    (before["slots"] is not None and after["slots"] is not None
                     and after["slots"] < before["slots"]))
        return False

    def _observe_rule_supply(self, observation: dict) -> None:
        attempt, self._rule_supply_attempt = self._rule_supply_attempt, None
        if (attempt is None or attempt.get("ok") is not True
                or attempt["revision"] != self._plan_revision
                or any(attempt["state"][k] != observation[k] for k in ("server", "dimension"))):
            return
        returning = attempt.get("return_pending") is not None
        if returning and not self._completed_supply_return_current(attempt):
            return  # Old or unbound meal success cannot affect a different rescue.
        skill = attempt["skill"]
        if self._supply_progress(skill, attempt["state"], observation):
            self._rule_supply_stalls.pop(skill, None)
            return
        previous = self._rule_supply_stalls.get(skill, {})
        stalled = {"count": previous.get("count", 0) + 1, "state": observation,
                   "params": attempt["params"]}
        self._rule_supply_stalls[skill] = stalled
        if stalled["count"] >= 2:
            reason = f"补给 {skill} 连续两次报告完成，但实际状态没有改善，先重新观察并换策略"
            self.note_task_result(skill, False, reason, _completed_supply=attempt if returning else None)
            self._failure_cooldowns[skill] = time.time() + 30.0
            if not returning:
                self.clear_plan(reason)
            self.state_note(reason)

    def _completed_supply_return_current(self, attempt: dict) -> bool:
        """A finished real meal can retain only the physical duty it actually interrupted."""
        proof, pending = attempt.get("return_proof"), attempt.get("return_pending")
        return bool(attempt.get("ok") is True and pending is not None and self._mining_return is pending
            and isinstance(proof, dict) and proof.get("task_id") and proof.get("skill") == attempt.get("skill")
            and proof.get("supply_return") is pending and self._return_token_current(proof)
            and attempt.get("revision") == proof["revision"] == pending["revision"]
            and proof["owner"] == pending["owner"] and proof["generation"] == pending["generation"]
            and all(proof["world"]) and proof["world"] == pending["world"]
            and self._return_world(self._return_boundary_state) == pending["world"])

    def _rule_supply_stalled(self, skill: str, params: dict, observation: dict) -> bool:
        stalled = self._rule_supply_stalls.get(skill)
        if not stalled:
            return False
        before = stalled["state"]
        # Real improvement, new supplies or a new target can unlock a rule.
        # A further drop in hunger alone cannot make a stalled rule viable.
        changed = (self._supply_progress(skill, before, observation) or params != stalled["params"]
                   or any(before[k] != observation[k] for k in ("server", "dimension")))
        if skill in ("eat", "cook_food", "hunt", "resupply_food"):
            changed = changed or any(observation[k] > before[k] for k in ("ready", "raw", "wheat"))
        if skill == "cook_food":
            changed = changed or any(observation[k] > before[k] for k in ("wood", "fuel", "stations"))
            changed = changed or bool(set(observation["animals"]) - set(before["animals"]))
        if changed:
            self._rule_supply_stalls.pop(skill, None)
            return False
        return stalled["count"] >= 2

    def _rule_supply_failed(self, skill: str, observation: dict) -> bool:
        """Keep old failures visible without blocking genuinely replenished supplies."""
        failed = self._rule_supply_failures.get(skill)
        if failed is None:
            # Unobserved failures carry no proof of changed prerequisites.
            return self._failure_counts().get(skill, 0) >= 2
        before = failed["state"]
        known_world = all(before.get(k) and observation.get(k) for k in ("server", "dimension"))
        if failed["count"] < 2:
            return self._failure_counts().get(skill, 0) >= 2 and not known_world
        changed = known_world and any(before[k] != observation[k] for k in ("server", "dimension"))
        if known_world:
            changed = changed or self._supply_progress(skill, before, observation)
            if skill in ("eat", "cook_food", "hunt", "resupply_food"):
                changed = changed or any(observation[k] > before[k] for k in ("ready", "raw", "wheat"))
            if skill == "cook_food":
                changed = changed or any(observation[k] > before[k] for k in ("wood", "fuel", "stations"))
                changed = changed or bool(set(observation["animals"]) - set(before["animals"]))
            if skill == "recover":
                changed = changed or observation["food"] > before["food"]
            if skill == "store_items":
                changed = changed or any(observation[k] > before[k] for k in ("storage", "wood", "stations"))
        if changed and self.skill_retry_ready(skill):
            self._rule_supply_failures[skill] = {"count": 0, "state": observation,
                                                "params": dict(failed["params"])}
            return False
        return True

    def _rule_supply_remedy(self, step: dict, supply_skill: str, state: dict) -> bool:
        """A stalled supply permits a concrete remedy, not arbitrary old work."""
        skill, params = step["skill"], step.get("params") or {}
        stalled = self._rule_supply_stalls.get(supply_skill) or self._rule_supply_failures.get(supply_skill)
        if stalled is None:
            return False
        failed = self._rule_supply_failures.get(supply_skill)
        if skill == supply_skill and failed is not None and failed["count"] >= 2:
            return False  # A different count cannot renew unchanged failed prerequisites.
        if skill == supply_skill and params == stalled["params"]:
            return False
        # Full storage is maintenance; escaping or returning to safety can also
        # help when eating, cooking or recovery has stalled.
        if supply_skill == "store_items" or skill in ("return_home", "climb_out"):
            return True
        inv = state["inventory"]
        item = str(params.get("item") or "").removeprefix("minecraft:").lower()
        if skill == "eat":
            try:
                target = float(params.get("target_food", 18))
            except (TypeError, ValueError):
                return False
            # At 18/19 hunger, eating to 20 is still a useful recovery remedy.
            return state["food"] < target <= 20 and (
                bool(inv.get(item)) if item in FOODS + RAW_FOODS else
                not item and any(inv.get(name) for name in FOODS + RAW_FOODS))
        hungry = state["food"] <= 10 or (state["health"] <= 12 and state["food"] < 18)
        if not hungry:
            return False
        if skill == "cook_food":
            return any(inv.get(name) for name in RAW_FOODS) or inv.get("wheat", 0) >= 3
        if skill == "hunt":
            mob = str(params.get("mob") or "cow").lower()
            return state["health"] > 8 and any(e.get("name") == mob and not e.get("hostile")
                for e in state.get("nearby_entities") or [] if isinstance(e, dict))
        raw = any(inv.get(name) for name in RAW_FOODS)
        need_furnace = raw and not inv.get("furnace")
        need_table = (inv.get("wheat", 0) >= 3 or need_furnace) and not inv.get("crafting_table")
        need_stone = need_furnace and sum(inv.get(name, 0) for name in
            ("cobblestone", "cobbled_deepslate", "blackstone")) < 8
        # Keep this aligned with actions._findFuel / mining.hasFuel: wood and
        # sticks already in the pack are usable, so they do not justify mining coal.
        need_fuel = raw and not any(inv.get(name) for name in (
            "coal", "charcoal", "oak_planks", "birch_planks", "spruce_planks",
            "oak_log", "birch_log", "spruce_log", "stick", "lava_bucket", "dried_kelp_block", "blaze_rod"))
        need_pick = (need_stone or need_fuel) and not any(
            count and name.endswith("_pickaxe") for name, count in inv.items())
        materials = set(FOODS + RAW_FOODS + ("wheat",))
        planks = sum(count for name, count in inv.items() if name.endswith("_planks"))
        wood_units = planks + 4 * sum(inv.get(name, 0) for name in WOOD_NAMES)
        # A table needs four planks; a wooden pick and its sticks need five more.
        need_wood = wood_units < (4 if need_table else 0) + (5 if need_pick else 0) or need_fuel
        if need_wood:
            materials.update(WOOD_NAMES)
        if need_table or need_pick or need_fuel:
            materials.update(name.rsplit("_", 1)[0] + "_planks" for name in WOOD_NAMES)
        if need_table:
            materials.add("crafting_table")
        if need_furnace:
            materials.add("furnace")
        if need_stone:
            materials.update(("cobblestone", "cobbled_deepslate", "blackstone"))
        if need_fuel:
            materials.update(("coal", "charcoal"))
        if need_pick:
            materials.update(("wooden_pickaxe", "stone_pickaxe", "stick"))
        if skill in ("collect", "craft"):
            return item in materials
        if skill == "smelt":
            return item in RAW_FOODS or need_fuel and item in WOOD_NAMES
        if skill == "chop_tree":
            return need_wood
        if skill == "mine_stone":
            return need_stone
        if skill == "mine_ores":
            return need_fuel and str(params.get("ore") or "iron").removeprefix("minecraft:").lower() == "coal"
        if skill == "make_tools":
            return need_pick and str(params.get("tier", "stone")).lower() in ("wooden", "stone") and params.get("kinds") == ["pickaxe"]
        return False

    def _safe_home_for_state(self, state: dict) -> dict | None:
        home = self._home_for_state(state)
        status = state.get("home_status") or {}
        return home if (home and status.get("safe") is True and status.get("loaded") is True
                        and status.get("condition") == "intact") else None

    def _skill_needs_outdoors(self, skill: str, params: dict, state: dict) -> bool:
        """Budget the dependencies that native skills actually gather automatically.

        A usable partial meal is worth making before a trip. Missing diamonds,
        smelting input and torch coal are reported by the native skills instead
        of being silently searched for, so they do not authorize leaving home.
        """
        if skill in self.OUTDOOR_SKILLS:
            return True
        if skill not in self.PREPARATION_SKILLS or params.get("allow_search") is False or skill == "craft":
            return False
        inventory = state.get("inventory")
        if not isinstance(inventory, dict):
            return False
        inv = {name: max(0, int(count or 0)) for name, count in inventory.items()}
        count = lambda names: sum(inv.get(name, 0) for name in names)
        planks = count(name for name in inv if name.endswith("_planks"))
        wood_units = planks + 4 * count(WOOD_NAMES)
        furniture = (state.get("home_status") or {}).get("furniture") or {}
        actual_furniture = furniture if self._safe_home_for_state(state) else {}
        table = inv.get("crafting_table", 0) > 0 or actual_furniture.get("crafting_table") is True
        def fuel_capacity(name: str) -> float:
            if name.startswith(("crimson_", "warped_")):
                return 0
            if name.endswith(("_planks", "_log", "_wood")):
                return 1.5
            return {"coal": 8, "charcoal": 8, "stick": 0.5, "dried_kelp_block": 20,
                    "blaze_rod": 12, "lava_bucket": 100}.get(name, 0)
        fuel = any(fuel_capacity(name) * amount >= 1 for name, amount in inv.items())
        food_inputs = set(RAW_FOODS)
        blast_inputs = {"raw_iron", "iron_ore", "deepslate_iron_ore", "raw_gold", "gold_ore", "deepslate_gold_ore",
                        "nether_gold_ore", "raw_copper", "copper_ore", "deepslate_copper_ore", "ancient_debris"}

        def furnace(input_name: str) -> bool:
            return bool(inv.get("furnace") or actual_furniture.get("furnace") is True
                or input_name in food_inputs and actual_furniture.get("smoker") is True
                or input_name in blast_inputs and actual_furniture.get("blast_furnace") is True)

        def smelt_search(inputs: list[str]) -> bool:
            inputs = [name for name in inputs if inv.get(name, 0) > 0]
            if not inputs:
                return False
            def lit(name: str) -> bool:
                return (actual_furniture.get("furnace") is True and actual_furniture.get("furnace_lit") is True
                    or name in food_inputs and actual_furniture.get("smoker") is True
                    and actual_furniture.get("smoker_lit") is True
                    or name in blast_inputs and actual_furniture.get("blast_furnace") is True
                    and actual_furniture.get("blast_furnace_lit") is True)
            # Lit is a real block observation, not a promise of enough residual
            # seconds. Native smelting verifies the remaining heat and reports
            # any shortage without starting a hidden indoor gathering trip.
            return (any(not fuel and not lit(name) for name in inputs)
                    or any(not furnace(name) for name in inputs) and inv.get("cobblestone", 0) < 8)

        def food_search(target: int) -> bool:
            if count(FOODS) >= target:
                return False
            if inv.get("wheat", 0) >= 3 and (table or wood_units >= 4):
                return False
            raw = [name for name in RAW_FOODS if inv.get(name, 0) > 0]
            if raw and not smelt_search(raw):
                return False
            return True

        def tool_search(tier: str, kinds: list[str]) -> bool:
            material_cost = {"pickaxe": 3, "axe": 3, "sword": 2, "shovel": 1}
            stick_cost = {"pickaxe": 2, "axe": 2, "sword": 1, "shovel": 2}
            if tier not in ("wooden", "stone", "iron", "diamond") or any(kind not in material_cost for kind in kinds):
                return False
            missing = [kind for kind in dict.fromkeys(kinds) if not inv.get(f"{tier}_{kind}")]
            if not missing:
                return False
            materials = sum(material_cost[kind] for kind in missing)
            sticks = sum(stick_cost[kind] for kind in missing)
            if tier == "diamond" and inv.get("diamond", 0) < materials:
                return False
            if tier == "stone" and inv.get("cobblestone", 0) < materials:
                return True
            if tier == "iron" and inv.get("iron_ingot", 0) < materials:
                iron_inputs = ["raw_iron", "iron_ore", "deepslate_iron_ore"]
                if inv.get("iron_ingot", 0) + count(iron_inputs) < materials or smelt_search(iron_inputs):
                    return True
            needed_planks = (materials if tier == "wooden" else 0)
            needed_planks += ((max(0, sticks - inv.get("stick", 0)) + 3) // 4) * 2
            needed_planks += 0 if table else 4
            return wood_units < needed_planks

        if skill == "make_tools":
            kinds = params.get("kinds") or ["pickaxe", "axe", "sword", "shovel"]
            return tool_search(str(params.get("tier") or "stone").lower(), kinds if isinstance(kinds, list) else [])
        if skill == "cook_food":
            return food_search(max(1, int(params.get("count") or 4)))
        if skill == "smelt":
            item = str(params.get("item") or "").removeprefix("minecraft:")
            inputs = [item] if item else list(blast_inputs | food_inputs | {"sand", "cobblestone"})
            return smelt_search(inputs)
        if skill == "food_chain":
            if food_search(4):
                return True
            if count(FOODS) < 4:
                # The first stage can make a partial meal and stops there when
                # fewer than four are ready; tools must not trigger an early trip.
                return False
            has_pick = any(inv.get(f"{tier}_pickaxe") for tier in ("wooden", "stone", "iron", "diamond", "netherite"))
            remaining_sticks, remaining_wood = inv.get("stick", 0), wood_units
            if not has_pick:
                tier = "stone" if inv.get("cobblestone", 0) >= 3 else "wooden"
                if tool_search(tier, ["pickaxe"]):
                    return True
                # One shared budget: sticks are made in batches of four, then
                # the pickaxe consumes two. Its material and newly needed table
                # also spend planks before the torch stage gets the remainder.
                stick_batches = (max(0, 2 - remaining_sticks) + 3) // 4
                remaining_sticks += stick_batches * 4 - 2
                remaining_wood -= stick_batches * 2 + (3 if tier == "wooden" else 0) + (0 if table else 4)
            if inv.get("torch", 0) < 4 and count(("coal", "charcoal")) > 0:
                return remaining_sticks < 1 and remaining_wood < 2
        return False

    def _preparation_params(self, skill: str, params: dict, state: dict) -> dict:
        result = dict(params)
        if skill in self.PREPARATION_SKILLS:
            result["safe_search"] = True
            home = self._safe_home_for_state(state)
            if home:
                result.update(home=home, allow_search=False)
        return result

    def _protected_work_params(self, skill: str, params: dict, state: dict) -> dict:
        """Keep known same-world homes out of autonomous material searches."""
        result = dict(params)
        if skill in self.OUTDOOR_SKILLS or skill in self.PREPARATION_SKILLS or skill == "climb_out":
            home = self._home_for_state(state)
            if home is not None:
                result["protected_home"] = dict(home)
        return result

    async def _survival_step(self) -> dict | None:
        """空闲边界按真实状态补给；空计划和模型故障也能处理紧急需求。"""
        self._rule_supply_candidate = None
        self._rule_supply_wait_reason = ""
        if not self._state_provider:
            return None
        revision = self._plan_revision
        state = await self._gather_state()
        if (revision != self._plan_revision or not self.may_act(allow_model_block=True)
                or self.inbox.has_delivery(Delivery.STEER) or self._owner_steer_pending()):
            return None
        if not isinstance(state.get("inventory"), dict) or state.get("food") is None or state.get("health") is None:
            if self._mining_return is not None:
                self._rule_supply_wait_reason = "采矿后尚未取得完整身体状态，保留计划等待核验"
            if self._plan and self._plan[0]["skill"] in self.PREPARATION_SKILLS:
                self._rule_supply_wait_reason = "准备任务尚未拿到完整的新状态，保留计划稍后重试"
            return None
        if state["health"] <= 0:
            self.note_dead(True)
            return None
        observation = self._supply_observation(state)
        self._return_boundary_state = dict(state)
        self._observe_rule_supply(observation)
        advice = await self._build_advice(state)
        if self._mining_return is not None:
            return_step = self._mining_return_step(state, advice, observation)
            if return_step is not None or self._mining_return is not None or revision != self._plan_revision:
                return return_step
        # A failed strategy remains failed while the clock is unknown or the
        # body rests. Process its bounded retry/remedy semantics before travel.
        remedy = None
        if advice.priority == "survival" and advice.skill:
            stalled = self._rule_supply_stalled(advice.skill, advice.params, observation)
            failed = self._rule_supply_failed(advice.skill, observation)
            if stalled or failed:
                if self._plan and self._rule_supply_remedy(self._plan[0], advice.skill, state):
                    remedy = self._plan[0]
                else:
                    if self._plan or self._pending_plan:
                        self.clear_plan(f"生存补给 {advice.skill} 没有实际进展，先重新观察并换策略")
                    return None
        home = self._home_for_state(state)
        status = state.get("home_status") or {}
        ordinary_work = bool((remedy is not None or advice.priority not in ("survival", "maintenance"))
            and self._plan and self._skill_needs_outdoors(self._plan[0]["skill"], self._plan[0]["params"], state))
        # An empty shelf can require a daytime hunt. Exit first; the next fresh
        # snapshot selects the hunt and preserves the original work parameters.
        food_search = advice.priority == "survival" and self._skill_needs_outdoors(advice.skill, advice.params, state)
        preparation_search = (food_search and advice.skill in self.PREPARATION_SKILLS or ordinary_work
            and self._plan[0]["skill"] in self.PREPARATION_SKILLS)
        if remedy is not None and ordinary_work and (state.get("is_night") is not False or state["health"] <= 8):
            self._rule_supply_wait_reason = "补给缺料仍需外出，保留补料步骤等待天亮和身体恢复"
            return None
        if preparation_search and (state.get("is_night") is not False or state["health"] <= 8):
            self._rule_supply_wait_reason = "准备技能需要外出补材料，保留计划等待天亮和身体恢复"
            return None
        if home and status.get("safe") is True and (ordinary_work or food_search):
            if (state.get("is_night") is not False or state["health"] <= 8
                    or ordinary_work and remedy is None and state["food"] <= 10):
                self._rule_supply_wait_reason = "当前仍需在基地内休息，保留计划等待可安全出门"
                return None
            if (not self._skill_is_known("leave_home") or not self.skill_retry_ready("leave_home")
                    or self._failure_counts().get("leave_home", 0) >= 2):
                if self._plan:
                    self.clear_plan("基地出门尚未成功，先重新观察出口再安排屋外工作")
                return None
            advice.skill, advice.params = "leave_home", {"home": home, "timeout_seconds": 20}
            advice.why = "白天先实际开门走出基地并关门，再按最新状态接回原任务"
            advice.priority = "survival"
        if advice.priority not in ("survival", "maintenance") or not advice.skill or not self._skill_is_known(advice.skill):
            return None
        if advice.priority == "maintenance" and (not self._plan or not self._skill_needs_outdoors(
                self._plan[0]["skill"], self._plan[0]["params"], state)):
            return None
        if remedy is not None and advice.skill != "leave_home":
            return None
        if self._rule_supply_stalled(advice.skill, advice.params, observation):
            if self._plan and not self._rule_supply_remedy(self._plan[0], advice.skill, state):
                self.clear_plan(f"生存补给 {advice.skill} 没有实际进展，先重新观察")
            return None
        if self._rule_supply_failed(advice.skill, observation):
            if self._plan or self._pending_plan:
                self.clear_plan(f"生存补给 {advice.skill} 连续失败，重新观察并换策略")
            return None
        if not self.skill_retry_ready(advice.skill):
            return None
        if advice.skill in ("eat", "cook_food", "hunt", "recover", "store_items", "resupply_food", "leave_home"):
            self._rule_supply_candidate = {"skill": advice.skill, "params": dict(advice.params),
                                           "state": observation, "revision": self._plan_revision}
        if self._plan and self._plan[0]["skill"] == advice.skill:
            # 同名任务仍可能在追不存在的动物或只吃到旧的目标饱食度。
            # 更新当前步骤，避免补给后又把过时参数执行一遍。
            self._plan[0] = {"skill": advice.skill, "params": dict(advice.params), "why": advice.why}
            return None
        logger.info("计划先处理生存需求：%s；原来的 %d 步保留", advice.why, len(self._plan))
        return {"skill": advice.skill, "params": advice.params, "why": advice.why}

    async def _resolve_completed_tool_breaks(self) -> bool:
        """A handled break must not erase completed work or its return obligation."""
        prefix = []
        broken = []
        for entry in self.inbox.entries:
            delivery = type_of(entry.type).delivery
            if delivery is Delivery.CONTROL:
                break
            prefix.append(entry)
            if delivery is Delivery.STEER:
                if entry.type != "tool_broken":
                    return False
                broken.append(entry)
        if not broken or self._owner_steer_pending() or not self._recent_outcomes:
            return False
        outcome = self._recent_outcomes[-1]
        status = outcome.get("return_status") or {}
        # The native skill accepted the drops, but may still be below ground.
        # Losing a pick never releases the existing physical escape obligation.
        returning = self._mining_return is not None
        revision = self._plan_revision
        if not returning:
            proof = self._completed_tool_breaks
            picks = tuple(f"{tier}_pickaxe" for tier in
                          ("wooden", "stone", "iron", "golden", "diamond", "netherite"))
            if (outcome.get("collection_ok") is not True or outcome.get("ok") is not True
                    or proof is None or proof[0] is not outcome or not self._state_provider
                    or any(not any(entry is handled for handled in proof[1]) for entry in broken)
                    or any(entry.text.removeprefix("我的").removesuffix("用坏了") not in picks for entry in broken)):
                return False
            state = await self._gather_state()
            inventory = state.get("inventory")
            if (not isinstance(inventory, dict) or not all(self._return_world(status))
                    or self._return_world(state) != self._return_world(status)
                    or not any(type(inventory.get(name)) in (int, float)
                               and inventory[name] > 0 for name in picks)):
                return False
        # A state read yields: newer owner/world input still owns the boundary.
        current = self.inbox.entries
        if (revision != self._plan_revision or self._owner_steer_pending()
                or not self.may_act(allow_model_block=True)
                or len(current) < len(prefix)
                or any(a is not b for a, b in zip(prefix, current))):
            return False
        for entry in current[len(prefix):]:
            delivery = type_of(entry.type).delivery
            if delivery is Delivery.CONTROL:
                break
            if delivery is Delivery.STEER:
                return False
        # Entries form a FIFO, so a normal notification may sit between two
        # already handled breaks. Use the normal consumers in order; controls
        # keep their barrier and every fact remains in the next model context.
        while self.inbox.entries and not self.inbox.head_is_control():
            follow = self._take_follow_up_text()
            if follow:
                self._pending_follow_up = "\n".join(
                    text for text in (self._pending_follow_up, follow) if text)
            self._decision_inputs()
        logger.info("采料已完成；工具破损已由新背包或待完成返程接管，保留后续计划")
        return True

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stopped = False
        self._task = asyncio.create_task(self._loop(), name="mc-life-loop")
        logger.info("「过日子」循环已启动（每 %.0f 秒想一次自己在干嘛）", self._decide_interval)

    async def stop(self) -> None:
        self._stopped = True
        if self._return_task_attempt is not None or self._mining_return is not None:
            self.clear_plan("自主循环停止，旧采矿返程计划作废")
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            # 清理路径：取消时抛什么都不重要，这里就是要吞掉
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._save_state()

    def pause(self, *, reason: str = "", max_seconds: float = 600.0) -> None:
        """用户明确在指派任务时，暂停自主行动（避免和你抢机器人）。

        **必须带自动恢复期限**：早期版本只 pause、靠 task.finished 事件 resume，
        结果工具执行失败时根本不会有任务产生，于是她**永久停滞**——
        实测表现就是"你让她跟着你，之后她再也不自己动了"。
        """
        self._paused = True
        if self._return_task_attempt is not None or self._mining_return is not None:
            self.clear_plan("主人暂停自主行动，旧采矿返程计划作废")
        self._pause_reason = reason
        self._pause_until = time.time() + max_seconds if max_seconds else 0.0
        if reason:
            logger.debug("过日子循环暂停（%s），最迟 %.0f 秒后自动恢复", reason, max_seconds)

    def resume(self) -> None:
        if self._paused:
            logger.debug("过日子循环恢复（原暂停原因：%s）", self._pause_reason or "未记录")
        self._paused = False
        self._pause_reason = ""
        self._pause_until = 0.0


    # ------------------------------------------------------------ 停牌（Hold）



    def _announce_hold(self) -> None:
        """**只在变化沿打日志**：停牌期间每 tick 都调也不会刷屏。

        这条是 numen 的做法（`announceHold` 只找变化沿）。原来的毛病是
        "她不动"时日志里什么都没有，或者反过来每 tick 刷一行。
        """
        now = self.current_hold()
        if now == self._announced_hold:
            return
        prev = self._announced_hold
        self._announced_hold = now
        if prev is None:
            return  # 第一次不报（启动时 NONE 很正常）
        if now is Hold.NONE:
            logger.info("停牌解除（原来是 %s）——她可以动了", prev.value)
        else:
            logger.warning("停牌：%s", self.hold_explain())

    def note_dead(self, dead: bool) -> None:
        """她死了/复活了。由 main.py 在死亡、进服和重生通知中调用。"""
        self._dead = bool(dead)
        if dead and (self._return_task_attempt is not None or self._mining_return is not None):
            self.clear_plan("身体已死亡，旧采矿返程计划作废")
        self._announce_hold()

    def note_engine_up(self, up: bool) -> None:
        """引擎进程在不在。由 main.py 在引擎启停时调用。"""
        self._engine_up = bool(up)
        if not up and (self._return_task_attempt is not None or self._mining_return is not None):
            self.clear_plan("引擎掉线，旧采矿返程计划作废")
        self._announce_hold()

    def note_blocked(self, reason: str = "", *, retry_after: float = 30.0) -> None:
        """模型暂时不可用：有限退避后自动探测，不永久停住生活循环。"""
        self._blocked_reason = str(reason or "未知原因")
        self._decision_retry_at = time.time() + max(0.0, float(retry_after))
        self._announce_hold()

    def note_unblocked(self) -> None:
        """模型端点恢复了。"""
        self._blocked_reason = ""
        self._decision_retry_at = 0.0
        self._decide_timeouts = 0
        self._announce_hold()

    def retry_decision_now(self) -> None:
        """配置或端点恢复后立即探测；保留停牌原因直到真正成功。"""
        self._decision_retry_at = 0.0
        self._wake.set()

    def may_act(self, *, allow_model_block: bool = False) -> bool:
        """提交动作前再次检查，防止模型请求期间的暂停被旧结果覆盖。"""
        hold = self.current_hold()
        return hold is Hold.NONE or (
            hold is Hold.BLOCKED and (allow_model_block or getattr(self, "_probing_endpoint", False))
        )

    def _note_decision_failure(self, reason: str, *, kind: str = "failed") -> None:
        self.note_decision_cut(reason, kind=kind)
        self._decide_timeouts += 1
        delay = 8.0 if self._decide_timeouts < self._decide_retry_limit else (
            30.0 * 2 ** min(2, self._decide_timeouts - self._decide_retry_limit)
        )
        self._decision_retry_at = time.time() + delay
        if self._decide_timeouts >= self._decide_retry_limit:
            self.note_blocked(
                f"连续 {self._decide_timeouts} 次决策失败：{reason}", retry_after=delay
            )
        logger.warning("决策暂不可用，%.0f 秒后自动重试（第 %d 次）", delay, self._decide_timeouts)


    def wake(self, reason: str = "") -> None:
        """叫醒她：手头的事做完了，可以立刻想下一步。

        由插件在 task.finished / task.cancelled 时调用。
        没有这个机制时，她要等满一个完整的决策间隔（实测 190~200 秒）
        才会想下一件事——看起来就像"她做完就呆住了"。
        """
        self._busy_until = 0.0
        self._wake.set()
        if reason:
            logger.debug("唤醒过日子循环：%s", reason)


    # ------------------------------------------------------------ 主循环

    async def _loop(self) -> None:
        # 区块加载给一点宽限；进服事件已经叫醒时立即开始。
        try:
            await asyncio.wait_for(self._wake.wait(), timeout=20.0)
        except asyncio.TimeoutError:
            # 启动宽限自然到期是预期路径，随后正常开始决策。
            pass
        next_wait = 0.0
        while not self._stopped:
            try:
                if next_wait > 0:
                    try:
                        await asyncio.wait_for(self._wake.wait(), timeout=next_wait)
                    except asyncio.TimeoutError:
                        # 唤醒等待的期限到达是正常轮询，不是决策失败。
                        pass
                self._wake.clear()
                if self._stopped:
                    break
                next_wait = self._decide_interval
                self._probing_endpoint = False
                self.drives.tick()
                self.drives.save()
                self._auto_resume_if_expired()
                self._announce_hold()
                hold = self.current_hold()
                now = time.time()
                # 模型故障只限制新的模型决策；规则补给和已确定的计划
                # 仍可执行。主人控制、死亡、掉线和引擎停牌始终是屏障。
                if hold not in (Hold.NONE, Hold.BLOCKED):
                    if hold in (Hold.DISCONNECTED, Hold.ENGINE_DOWN, Hold.DEAD, Hold.WORLD_CHANGING):
                        if self._mining_return is not None or self._return_task_attempt is not None:
                            self.clear_plan("身体或连接已改变，旧采矿返程计划作废")
                    next_wait = min(5.0, self._decide_interval)
                    continue
                if now < self._busy_until:
                    next_wait = min(2.0, self._busy_until - now)
                    continue
                if await self._engine_busy():
                    # 完成事件会直接唤醒；事件丢失时也有短轮询兜底。
                    next_wait = min(2.0, self._decide_interval)
                    continue

                if self.inbox.head_is_control():
                    what = self._run_control()
                    if what:
                        self.state_note(f"我{what}了")
                    next_wait = 0.0
                    continue

                follow_up = self._take_follow_up_text()
                if follow_up:
                    self._pending_follow_up = "\n".join(
                        text for text in (self._pending_follow_up, follow_up) if text
                    )

                if self._pending_plan and not self._plan:
                    self._set_plan(self._pending_plan, source="agent")
                    self._pending_plan = []
                # 普通完成通知不打断既定计划；受伤、工具坏或新指令在步骤边界重规划。
                if (self.inbox.has_delivery(Delivery.STEER)
                        and not await self._resolve_completed_tool_breaks()):
                    self.clear_plan("有新的指令或环境变化，先处理输入")
                    if self._owner_steer_pending():
                        # 在模型读取并移走主人输入之前消费这次覆盖，
                        # 否则工具提交时会忘记主人要求重新尝试过。
                        self._should_back_off()
                    else:
                        # 受伤等事实留给下一次模型，同时允许先按新快照补给。
                        # 主人指令仍由模型处理，规则不能在它前面擅自动手。
                        self._decision_inputs()

                if self.inbox.head_is_control():
                    next_wait = 0.0
                    continue

                # 计划优先：正常的步骤衔接不调模型。
                boundary_revision = self._plan_revision
                had_plan = bool(self._plan)
                step = await self._survival_step()
                if boundary_revision != self._plan_revision or not self.may_act(allow_model_block=True) or (had_plan and self.inbox.has_delivery(Delivery.STEER)):
                    next_wait = 0.0
                    continue
                if step is None:
                    if self._rule_supply_wait_reason:
                        next_wait = min(5.0, max(1.0, self._decide_interval))
                        continue
                    if self._plan and not self.skill_retry_ready(self._plan[0]["skill"]):
                        self.clear_plan("这项技能仍在失败冷却中，重新安排其他做法")
                        next_wait = 0.0
                        continue
                    step = self._pop_plan_step()
                if step is not None:
                    decision = self._decision_from_step(step)
                    logger.info(
                        "按计划执行（还剩 %d 步）：%s（技能 %s）——不调模型",
                        len(self._plan), decision.activity, decision.skill,
                    )
                    self._note_busy_round()
                    await self._act(decision, allow_model_block=True)
                    next_wait = min(2.0, self._decide_interval)
                    continue

                # 没停牌、引擎空闲、计划也空了，才需要一次新的模型决策。
                now = time.time()
                if now < self._decision_retry_at:
                    next_wait = min(5.0, self._decision_retry_at - now)
                    continue
                if self.current_hold() is Hold.BLOCKED:
                    # 仅这次实际模型探测可以越过 BLOCKED，成功才解除故障。
                    self._probing_endpoint = True
                if self.action_agent is not None:
                    try:
                        handled = await asyncio.wait_for(
                            self._act_via_agent(), timeout=self._decide_timeout
                        )
                    except asyncio.TimeoutError:
                        self._note_decision_failure(
                            f"{self._decide_timeout:.0f} 秒没想出来", kind="timeout"
                        )
                        next_wait = min(5.0, self._decision_retry_at - time.time())
                        continue
                    except asyncio.CancelledError:
                        self.note_decision_cut("循环被取消", kind="cancelled")
                        raise
                    except Exception as exc:  # noqa: BLE001
                        self._note_decision_failure(str(exc))
                        next_wait = min(5.0, self._decision_retry_at - time.time())
                        continue
                    if handled:
                        if getattr(self, "_decision_model_ok", False):
                            self.note_unblocked()
                            self._acknowledge_decision_inputs(getattr(self, "_decision_model_owner_generation", None))
                        if (
                            not self._plan
                            and not self._pending_plan
                            and not await self._engine_busy()
                            and len(self.inbox) == 0
                        ):
                            self.note_idle_round("agent 这一轮没有提交任何任务，队列也空")
                            next_wait = min(6.0, self._decide_interval)
                        else:
                            self._note_busy_round()
                            next_wait = 0.0 if self._pending_plan else min(2.0, self._decide_interval)
                        continue

                decision_revision = self._plan_revision
                try:
                    decision = await asyncio.wait_for(
                        self.decide(), timeout=self._decide_timeout
                    )
                except asyncio.TimeoutError:
                    self._note_decision_failure(
                        f"{self._decide_timeout:.0f} 秒没想出来", kind="timeout"
                    )
                    next_wait = min(5.0, self._decision_retry_at - time.time())
                    continue
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    self._note_decision_failure(str(exc))
                    next_wait = min(5.0, self._decision_retry_at - time.time())
                    continue

                if decision is None and decision_revision != self._plan_revision:
                    # 重连或重新安排使这轮作废，正常丢弃不计为模型故障。
                    # 保留输入，立刻重新观察新会话。
                    next_wait = 0.0
                    continue
                if getattr(self, "_decision_model_ok", True):
                    self.note_unblocked()
                    self._acknowledge_decision_inputs(getattr(self, "_decision_model_owner_generation", None))
                else:
                    self._note_decision_failure("模型没有返回可用决定")
                if decision is None:
                    if len(self.inbox) == 0:
                        self.note_idle_round("想不出该做什么，队列也空")
                    next_wait = min(6.0, self._decide_interval)
                    continue
                if self._needs_work_boundary(decision.skill):
                    # The JSON response carries its first step separately from
                    # the remaining plan. Give it the same fresh survival/door
                    # boundary as later steps, retaining its original metadata.
                    self._plan.insert(0, {"skill": decision.skill, "params": dict(decision.params),
                                          "why": decision.activity, "decision": decision})
                    next_wait = 0.0
                    continue
                self._note_busy_round()
                await self._act(decision)
                next_wait = min(2.0, self._decide_interval)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.error("过日子循环异常：%s", exc)
                next_wait = min(5.0, self._decide_interval)
            finally:
                self._probing_endpoint = False


    # ------------------------------------------------------------ 决策

    def _retain_decision_input(self, text: str) -> None:
        self._decision_input_text = "\n".join(
            part for part in (getattr(self, "_decision_input_text", ""), text) if part
        )

    def _acknowledge_decision_inputs(self, owner_generation: int | None = None) -> bool:
        """A response cannot consume newer owner input that arrived while it was pending."""
        if owner_generation is not None and owner_generation != getattr(self, "_decision_owner_generation", 0):
            return False
        self._decision_input_text = ""
        self._decision_owner_pending = False
        self._pending_follow_up = ""
        return True

    def _decision_inputs(self) -> str:
        """暂存输入直到决策成功，失败重试与旧路径都能看到同一条指令。"""
        steer = self._drain_steer_text()
        follow = getattr(self, "_pending_follow_up", "") or ""
        follow_block = f"【排着的事】\n{follow}\n" if follow else ""
        self._retain_decision_input("\n".join(text for text in (steer, follow_block) if text))
        self._pending_follow_up = ""
        return self._decision_input_text

    async def decide(self) -> LifeDecision | None:
        """决定"现在想做什么"。先问 LLM，问不到就退回规则。"""
        plan_revision = self._plan_revision
        # 思考时间探针：从 decide 入口到下面 INFO 行（提示词装配完成）的耗时，
        # 配合"决策上下文分层"行的体积 —— 「更短思考」目标的基线/回归都看它。
        t_prompt0 = time.time()
        self._decision_model_ok = False
        self.drives.tick()
        suggestion = self.drives.suggest_activity()
        system = await self._system_prompt()
        brief = await self._brief()

        # 相关记忆：让决定带上"经历"（她可能会想起上次在矿洞里的遭遇）
        memos = self.memory.recall(f"{suggestion['activity']} {suggestion['label']}", limit=4)
        memo_text = self.memory.render_for_prompt(memos)

        skills = []
        if self._skill_catalog:
            try:
                raw = await self._skill_catalog()
                # 防御：提供方可能返回 dict（如直接透传引擎的 skill.list 响应）
                # 或 list。这里统一成 list，否则下面的切片会直接抛 KeyError。
                if isinstance(raw, dict):
                    skills = raw.get("skills") or []
                elif isinstance(raw, list):
                    skills = raw
                else:
                    skills = []
            except Exception as exc:  # noqa: BLE001
                logger.info("取技能清单失败：%s", exc)
                skills = []

        # 技能清单可能是"字符串列表"也可能是"dict 列表"，两种都要能渲染。
        # **渲染全部技能**（P1，见 render_skill_catalog 的说明）：原来切前 12 项，
        # 让模型看不到自己会"照图纸建造/睡觉/打猎/射箭/举盾/单件合成"。
        skill_text = render_skill_catalog(skills)

        # **顺手把"真实技能名"缓存下来，当白名单用**（B3）。
        #
        # 渲染现在是全量，但这两件事**仍然是分开的**：白名单只认"名字"，
        # 而渲染还要名字+参数+描述。分开写是为了将来任何一侧改格式时，
        # 另一侧不会跟着坏（早期"用前 12 项当白名单"就是这么埋下误杀隐患的）。
        #
        # 只在拿到非空清单时覆盖：engine 没起来 / skill.list 偶发失败时
        # 不要把已有缓存清空（清空等于"没有可信清单"，见 _skill_is_known）。
        names_seen = set()
        for item in skills or []:
            if isinstance(item, dict):
                nm = str(item.get("skill") or item.get("name") or "").strip()
            else:
                # 形如 "chop_tree(count=8)：找树砍木材…"
                nm = str(item).split("(", 1)[0].strip()
            if nm:
                names_seen.add(nm)
        if names_seen:
            self._known_skills = names_seen

        # 生存顾问：把"真玩家脑子里的清单"摆到 LLM 面前。
        # 没有这一段时，LLM 只能从一段状态简报里猜该干什么——
        # 实测它会在"挖石头失败→做工具失败→建庇护所失败"之间循环一小时，
        # 因为它不知道前置条件（没木头就没工具）、也不知道这些刚失败过。
        advice = await self._build_advice()
        advice_text = advise_for_prompt(advice)
        # "刚才发生了什么"——真人决策时会回想这个，之前她只有当前状态、像失忆
        recent_text = self._render_recent()

        # 她当前的"打算"：让决定之间有连续性。
        # 真人心里一直有件事在推进（"我要盖个能过夜的地方"），
        # 而不是每 90 秒从零开始掷骰子。
        if self._intention:
            stuck_hint = ""
            fails = self._failure_counts()
            if self._intention_rounds >= 4:
                recent_fail_total = sum(fails.values())
                mins = int((time.time() - self._intention_since) / 60) if self._intention_since else 0
                stuck_hint = (
                    f"\n——注意：这件事已经做了 {self._intention_rounds} 轮"
                    f"（约 {mins} 分钟），最近失败了 {recent_fail_total} 次。"
                    "真人这时会停下来想想：是卡在某个前置条件上（缺工具？缺材料？地形不对？），"
                    "还是该先做别的事、或者换个做法。**你也可以干脆放弃这个打算。**"
                )
            # **把"自打算设定以来的进展"给出来**（W5，见 docs/PLAN_v2.md）。
            #
            # 为什么需要：`_render_recent()` 只给**最近 5 条**，而她可能在同一个打算上
            # 已经做了 20 轮——于是模型看不到累计证据，会咬定"我没做过这件事"。
            #
            # 这是 numen 记录过的真实事故（GoalSteward 的注释）：
            #   "她可能分三次才凑够数，只看末尾就永远拼不出累计的证据——实测过一次：
            #    第一轮挖到 64/128 那条早滚出窗口，后面几轮评估器咬定'没有挖矿证据'，
            #    把她赶去满世界找矿四分钟。"
            #
            # 所以窗口**从打算设定的那一刻起算**，不是"最近几句"。
            progress = self._render_progress_since(self._intention_since)
            intention_text = (
                f"【你正在做的事（打算）】\n{self._intention}"
                f"（已经做了 {self._intention_rounds} 轮）{stuck_hint}\n"
                f"{progress}"
                "——你可以继续推进它，也可以改主意（在 intention 里写新的打算）；"
                "如果这件事已经做完或不想做了，intention 填 null。"
            )
        else:
            intention_text = (
                "【你正在做的事（打算）】\n（目前没有明确的打算）\n"
                "——如果你决定要做一件需要多步才能完成的事（比如盖房子、攒够做铁镐的材料），"
                "在 intention 里写下来，下一轮你还会记得它。"
            )

        # ============================================================
        # **上下文分层**（为什么这样切）
        #
        # 提示词缓存（DeepSeek/OpenAI/Anthropic 都有）只认**前缀**：
        # 前缀只要有一个字节变了，后面全部作废。原来的写法是把
        # 「任务清单说明 / 攻略说明 / 走路说明 / plan 规则 / JSON 格式」
        # 这一大段**静态文字夹在动态内容中间**，等于每次调用前缀都在变，
        # 缓存永远命中不了，每一轮都要为这几千字重新付费、重新计算。
        #
        # 现在切成两层：
        #   system = 人格 + **静态规则**（跨轮完全一致 → 可缓存）
        #   user   = 观察（每轮都变 → 放在最后，不污染前缀）
        # ============================================================
        static_rules = f"""【你可以做的事（技能）】
{skill_text}

请用 JSON 回答，不要输出别的：
{{
  "activity": "一句话说明你要做什么（口语化，像在自言自语）",
  "intention": "你接下来要推进的那件事（一句话；没有就填 null）",
  "plan": [
    {{"skill": "第一个技能名", "params": {{}}, "why": "为什么先做这个"}},
    {{"skill": "第二个技能名", "params": {{}}, "why": "..."}}
  ],
  "say": "如果此刻想跟人分享一句，写在这里；不想说话就填 null",
  "reason": "为什么想做这件事（一句话）"
}}

**关于你的任务清单（todo_write，很重要）**：
- 你可以用 `mc_todo_write` 工具**给自己列一份任务清单**（最多 12 项），
  它会被记住、重启也不丢，并且每次决定时都会摆在你面前。
- 复杂的事（盖房子、攒装备）本来就该拆成几步写进清单，做完一项用
  `mc_todo_done` 划掉——这样你不会做一半忘了自己要干什么。
- 清单是**你自己的**，随时可以重写。

**关于攻略（load_skill，很有用）**：
- 遇到多步、容易出错的大事，先用 `mc_load_skill` 读攻略再动手。
  可选：building（盖房）/ tools（从零到石制工具）/ food（吃饱肚子）/
  mining（安全挖矿）/ combat（打架与自保）/ storage（安顿好家）/
  blueprint（照着图纸盖房子）/ strategy（**什么时候该放弃、找多远、怎么调这些**）。

**关于走路（重要）**：
- **走路不会改动世界**（这是有意的设计）。走不通时用 `mc_plan_route` 看
  "要挖哪几格、要不要垫脚"，再决定值不值得动世界。

**关于 plan（很重要）**：
- 你要给出**接下来几步的有序安排**（2~5 步），我会按顺序替你执行，
  中间不会再来问你。所以请像真人一样"想好一串要做的事"。
- 每一步的 skill 必须是上面清单里真实存在的技能名。
- 步骤之间要有依赖关系上的顺序：比如先"砍树"拿木头 → 再"做工具"；
  先"挖圆石" → 再"做石制工具"；材料不够时先"收集"再"合成"。
- 如果只想做一件事，plan 里就写一步。如果想发呆/看风景，plan 填 []。
- 环境变化时我会重新问你，所以不用把计划排得太长（2~5 步最好）。

要求：
- 用你的人格说话，不要像任务汇报
- 可以什么都不做（比如只是发呆、看风景）——那 plan 填 [] 且 activity 写你在做什么
- 做的事要和当前状态相符（比如血量很低就别去挖矿）
- 需要事实就先查看（有 mc_status / mc_inventory / mc_scan 等只读工具），不要凭印象猜
- 决定权在你：「生存现状」那段只是参考，你可以按自己的想法来；
  但如果那里指出前置条件不满足（没木头就没工具），硬做后面的事只会失败
- 如果某个做法反复失败过，换个思路或先解决它缺的前置条件，不要重复同一个动作"""

        # 动态部分：**每轮都在变，所以放在最后**（放前面会让缓存前缀失效）
        #
        # **观察精炼**：动态段按"做决定最需要什么"排序，而且每一段都有硬上限。
        # 为什么要有上限：这些段都可能无限长——经历越攒越多、顾问建议会随阶段变长、
        # 记忆条数虽然限了但每条长度没限。实测把它们原样塞进去时，
        # 动态段能涨到一千多字，而其中大部分对"现在该做什么"毫无帮助。
        # 真人做决定时脑子里也就那么几件事，不是把一整天的流水账过一遍。
        recent_show = _clip(recent_text, 400)
        advice_show = _clip(advice_text, 500)
        memo_show = _clip(memo_text, 300)
        inputs = self._decision_inputs()
        prompt = f"""你现在正在 Minecraft 里自己玩，没人给你派活。决定一下接下来做什么。

{inputs}

【当前状态】
{brief}

{advice_show}
{intention_text}

{self.render_todos()}

{f'【你的近期经历】{chr(10)}{recent_show}{chr(10)}' if recent_show else ''}
{f'【你记得的事】{chr(10)}{memo_show}{chr(10)}' if memo_show else ''}
【你现在的心情】
{suggestion['label']}（强度 {suggestion['level']}）：{suggestion['voice']}"""

        # 上下文分层 + 体积分解（排查"为什么慢"时直接看日志）。
        # **INFO 级 + 构建耗时**（原来是 debug，等于没人看得见）：
        # 「思考时间」目标的基线与回归探针 —— 每轮一行，和其它决策日志同级。
        system = f"{system}\n\n{static_rules}"
        logger.info(
            "决策上下文分层：system %d 字（静态，可缓存）｜ user %d 字（动态）"
            "｜ 其中 状态%d 打算%d 清单%d 经历%d 顾问%d 心情%d 记忆%d 技能%d｜装配 %.0f ms",
            len(system),
            len(prompt),
            len(brief),
            len(intention_text),
            len(self.render_todos()),
            len(recent_show),
            len(advice_show),
            len(suggestion.get("voice") or ""),
            len(memo_show),
            len(skill_text),
            (time.time() - t_prompt0) * 1000,
        )

        # 优先走"带感知工具"的决策：她可以先查看再决定（这才是真人在做的事）。
        # 拿不到工具（没 provider / 工具管理器不可用）就退回纯文本决策，功能不受影响。
        #
        # **连续失败就暂时不再尝试**：实测感知路径因为一个字段名错误每次都抛异常，
        # 结果每轮决策都白等一次 LLM 往返（甚至撑到超时），她看起来完全不动。
        # 这里失败 3 次就停用 10 分钟，让决策走纯文本（至少她还在动）。
        raw = None
        used_tools: list[str] = []
        owner_generation = getattr(self, "_decision_owner_generation", 0)
        if plan_revision != self._plan_revision:
            self._wake.set()
            return None
        now_ts = time.time()
        perception_usable = (
            self.perception is not None and now_ts >= getattr(self, "_perception_disabled_until", 0)
        )
        if perception_usable:
            try:
                raw, used_tools = await self.perception.decide(
                    prompt=prompt,
                    system=system + "\n\n" + PERCEPTION_PROMPT_EXTRA,
                )
                if raw is not None:
                    self._perception_failures = 0
            except Exception as exc:  # noqa: BLE001
                self._perception_failures = getattr(self, "_perception_failures", 0) + 1
                logger.warning(
                    "带感知工具的决策失败（连续第 %d 次），退回纯文本：%s",
                    self._perception_failures,
                    exc,
                )
                if self._perception_failures >= 3:
                    self._perception_disabled_until = time.time() + 600
                    self._perception_failures = 0
                    logger.warning("感知决策连续失败，暂停 10 分钟，先用纯文本决策（保证她还在动）")
                raw = None
        if plan_revision != self._plan_revision:
            self._wake.set()
            return None
        if raw is None:
            raw = await self._llm(prompt, system)

        if plan_revision != self._plan_revision:
            self._wake.set()
            return None
        decision = self._parse_decision(raw, suggestion)
        self._decision_model_ok = decision is not None
        if decision is None:
            if self._owner_steer_pending():
                return None
            decision = self._fallback_decision(suggestion, advice)
        else:
            if used_tools:
                logger.info("她决定前先查看了：%s", "、".join(used_tools))
            decision = await self._reconsider_if_looping(decision, prompt, system, suggestion)

        if plan_revision != self._plan_revision:
            self._wake.set()
            return None
        self._note_intention(decision)
        # 把 LLM 给的"有序几步"装进计划队列：循环里会直接按顺序执行，
        # 中间不再问模型 —— 这是"连续行动"的关键。
        self._set_plan(self._pending_plan, source="llm" if self._pending_plan else "empty")
        self._pending_plan = []
        self._last_decide_at = time.time()
        self._decision_model_owner_generation = owner_generation
        return decision

    def _note_intention(self, decision: LifeDecision) -> None:
        """更新"打算"。**由 LLM 自己设定**，这里只负责记住与计数。"""
        new = (decision.intention or "").strip() if decision.intention is not None else None
        if decision.intention is None:
            # 模型没提 intention 字段 → 保持原样（不要因为漏字段就把她的打算清掉）
            decision.intention = self._intention or None
            return
        if not new:
            if self._intention:
                logger.info("她放下了原来的打算：%s", self._intention)
            self._intention = ""
            self._intention_rounds = 0
            self._intention_since = 0.0
            decision.intention = None
            return
        if new != self._intention:
            logger.info("她定下了新的打算：%s", new)
            self._intention = new
            self._intention_rounds = 1
            self._intention_since = time.time()
        else:
            self._intention_rounds += 1
        decision.intention = self._intention

    # ------------------------------------------------------------ 计划（任务排序）

    # ------------------------------------------------------------ TODO（LLM 自己写的清单）
    def write_todos(self, todos: list) -> str:
        """LLM 自己写的任务清单（模型自己写的清单）。

        为什么要让 LLM 自己写：
        早期"任务排序"是我在代码里替她排的（plan 字段由模型一次性给出、我按顺序执行），
        但那本质还是"我给的结构"。更好的做法是给模型一个清单工具，
        **清单是它的**——它可以随时改、划掉、加新的，这才叫"它在控制角色"。
        """
        cleaned = []
        for item in todos or []:
            if isinstance(item, str):
                text = item.strip()
                if text:
                    cleaned.append({"text": text, "done": False})
            elif isinstance(item, dict):
                text = str(item.get("text") or item.get("task") or "").strip()
                if text:
                    cleaned.append({"text": text, "done": bool(item.get("done"))})
            if len(cleaned) >= 12:
                break
        self._todos = cleaned
        logger.info(
            "她更新了任务清单（%d 项）：%s",
            len(cleaned),
            "；".join(("✔" if t["done"] else "□") + t["text"][:18] for t in cleaned) or "（清空）",
        )
        self._save_state()
        return self.render_todos()




    # ------------------------------------------------------------ 用工具直接行动（ReAct）

    async def _act_via_agent(self) -> bool:
        """让 LLM 带完整工具集自己动手做一轮。

        @return True = 这一轮由 agent 处理了（不论成没成）；
                False = agent 路径不可用，调用方该退回"挑技能"的旧路径。
        """
        agent = self.action_agent
        if agent is None:
            return False
        plan_revision = self._plan_revision
        self._decision_model_ok = False

        # **计时**（用户反馈"每次停下来思考的时间太长了"）：
        # 决策前的准备工作（状态简报 / 生存建议 / 知识库检索）**每轮都做**，
        # 而且都是 await —— 但我之前**不知道它们各花多久**，改的时候只能猜。
        # 这里把每一段和"模型本身花了多久"分开打出来，
        # 这样"想得慢"到底慢在哪一段是有数据的，不是感觉。
        import time as _t

        _t0 = _t.perf_counter()
        _last_mark = _t0
        _marks: list[tuple[str, float]] = []

        def _mark(label: str) -> None:
            nonlocal _last_mark
            now = _t.perf_counter()
            _marks.append((label, now - _last_mark))
            _last_mark = now

        suggestion = self.drives.suggest_activity()
        _mark("心情")
        brief = await self._brief()
        _mark("状态简报（引擎 RPC）")
        advice_text = ""
        state = {}
        try:
            state = await self._gather_state()
            advice = await self._build_advice(state)
            advice_text = advise_for_prompt(advice) if advice else ""
        except Exception as exc:  # noqa: BLE001
            logger.info("拼生存建议失败：%s", exc)
        _mark("生存建议")

        # 正常自主路径也必须拿到真实技能名，不能只让旧 JSON 路径维护白名单。
        if not self._known_skills and self._skill_catalog:
            try:
                raw_skills = await self._skill_catalog()
                skills = raw_skills.get("skills", []) if isinstance(raw_skills, dict) else raw_skills
                for item in skills or []:
                    name = (item.get("skill") or item.get("name") or "") if isinstance(item, dict) else str(item).split("(", 1)[0]
                    if str(name).strip():
                        self._known_skills.add(str(name).strip())
            except Exception as exc:  # noqa: BLE001
                logger.info("取真实技能名失败：%s", exc)
        _mark("技能清单")

        recent_text = self._render_recent()
        # **把她自己学到的经验摆到面前**（按当前处境检索，最相关的几条）。
        # 这是"她会学着怎样做更好的"落地点：知识库里的教训会在下一轮出现。
        learned = ""
        if self.knowledge is not None:
            try:
                query = f"{self._intention or ''} {' '.join(self._recent_failures.keys())} {advice_text[:200]}"
                learned = self.knowledge.render_for_prompt(query)
            except Exception as exc:  # noqa: BLE001
                logger.info("检索知识库失败：%s", exc)
        _mark("知识库检索")
        remembered = self._contextual_memories(state)
        _mark("相关经历")

        # **插话注入点**（W4）：主人的话和世界事件在"组装提示词"这一刻注入——
        # 这是我们的安全注入点（agent 每一轮都重新组装提示词，
        # 不会插在 assistant 的 tool_calls 中间）。
        # 对应 numen 的 STEER："一批工具结算后、下次调模型之前"。
        steer_text = self._decision_inputs()
        # **接续**（W4）：只在她本来要停时才取（循环那边已经判定过了）。
        # 和插话分开写，是因为两者的语义不同：
        #   插话 = "你继续干活，但先知道这件事"
        #   接续 = "你本来要停了，正好有件事接着做"
        follow_text = getattr(self, "_pending_follow_up", "") or ""
        follow_block = f"【排着的事（做完手头这个就接着办）】\n{follow_text}\n\n" if follow_text else ""
        prompt = f"""【当前状态】
{brief}

{steer_text}{follow_block}{self._intention or ''}

{self.render_todos()}

{learned}

{remembered}

{f'【你的近期经历】{chr(10)}{recent_text}{chr(10)}' if recent_text else ''}
{advice_text}

【你现在的心情】
{suggestion['label']}（强度 {suggestion['level']}）：{suggestion['voice']}

现在开始做你想做的事。需要就先查看，然后**用工具真正动手**，最后说一句话收尾。"""

        system = await self._system_prompt()
        from .action_agent import ACTION_PROMPT

        if plan_revision != self._plan_revision:
            self._wake.set()
            return True
        _mark("拼提示词")
        _t_model = _t.perf_counter()
        summary, used = await agent.act(
            prompt=prompt,
            system=f"{system}\n\n{ACTION_PROMPT}",
        )
        timing = getattr(agent, "last_timing", {}) or {}
        result_revision = timing.get("decision_revision", plan_revision)
        if result_revision != self._plan_revision:
            self._wake.set()
            return True
        _agent_ms = (_t.perf_counter() - _t_model) * 1000
        if summary is None and not used:
            return False  # agent 不可用 → 退回旧路径
        self._decision_model_ok = bool(summary or used) and timing.get("exit_reason") not in ("state_changed", "unavailable")
        self._decision_model_owner_generation = timing.get("owner_generation", getattr(self, "_decision_owner_generation", 0))

        # **把"想得慢"的账算清楚**（用户反馈"每次停下来思考的时间太长了"）：
        # 准备工作 vs 模型本身分开报，而且带上"发了多大的提示词"——
        # 模型往返的耗时主要取决于输入大小，这是我们能控制的。
        _prep_ms = sum(v for _, v in _marks) * 1000
        _detail = "，".join(f"{k} {v * 1000:.0f}ms" for k, v in _marks)
        # **别在这里重建工具集**：`_toolset()` 每次都重新遍历 func_list 构建一个
        # ToolSet —— 虽然只是微秒级，但**我自己在日志里又调了一次**纯属浪费，
        # 而且写日志不该有副作用。工具数从注册表直接数就行。
        _tool_count = 0
        try:
            from .action_agent import EXCLUDED_TOOLS
            mgr = getattr(getattr(self.action_agent, "plugin", None), "context", None)
            mgr = getattr(mgr, "provider_manager", None)
            mgr = getattr(mgr, "llm_tools", None)
            for t in getattr(mgr, "func_list", []) or []:
                if str(getattr(t, "name", "")).startswith("mc_") and t.name not in EXCLUDED_TOOLS:
                    _tool_count += 1
        # **尽力而为**的统计：拿不到就当 0，不影响主流程
        except Exception:  # noqa: BLE001
            pass
        if timing:
            agent_detail = (
                f"模型 {timing.get('provider_seconds', 0) * 1000:.0f}ms"
                f"/{timing.get('provider_calls', 0)} 轮，"
                f"工具执行 {timing.get('tool_seconds', 0) * 1000:.0f}ms"
                f"/{timing.get('tool_calls', 0)} 次，"
                f"缓存核验 {timing.get('state_check_seconds', 0) * 1000:.0f}ms，"
                f"复用观察 {timing.get('read_cache_hits', 0)} 次"
            )
        else:
            agent_detail = "未提供模型与工具分项计时"
        logger.info(
            "决策耗时：准备 %.0fms（%s），代理总计 %.0fms（%s），共 %.0fms；"
            "提示词 %d 字符，可见工具 %d 个，本轮请求了 %d 次工具",
            _prep_ms, _detail, _agent_ms, agent_detail, _prep_ms + _agent_ms,
            len(prompt) + len(system) + len(ACTION_PROMPT), _tool_count, len(used),
        )

        if used:
            logger.info("她自己动手做了 %d 件事：%s", len(used), "、".join(used[:8]))
        if summary:
            logger.info("她这一轮：%s", summary[:80])
            self.current = LifeDecision(
                activity=summary,
                drive=suggestion.get("drive"),
                skill=None,
                params={},
                say=summary if len(summary) < 60 else None,
                reason="（她自己动手做的）",
                intention=self._intention or None,
            )
            self.history.append(self.current)
            self.history = self.history[-20:]
            self.drives.note_activity(drive=suggestion.get("drive"), activity=summary)
            # 说过的话要真的说出去（否则她"做了但没说"）
            if self.current.say:
                await self._maybe_share(self.current.say)

        self._last_decide_at = time.time()
        self._save_state()
        return True

    # ------------------------------------------------------------ 技能知识（Markdown）


    def note_plan_from_agent(self, steps: list, why: str = "") -> dict:
        """**agent 留下接下来的几步**（C 批次）。

        为什么要有这个：计划机制本来就在（`_set_plan` + `_pop_plan_step`），
        但**只有旧路径 `decide()` 会写它**。走 agent 路径时，agent 每轮都返回
        "我处理了"，于是 `_pop_plan_step()` 永远拿到空计划 ——
        **计划机制在 agent 可用时是死的**。

        后果就是用户反馈的那句"每次停下来思考的时间太长了"：
        她每走一步都要过一次模型（实测一次决策最多 6 轮往返）。

        现在 agent 可以用 `mc_plan_do` 留下接下来的几步，
        循环那边会在下一轮把它装进计划表，**然后就不再调模型**。
        """
        cleaned = []
        unknown = []
        known = set(self._known_skills or [])
        for item in steps or []:
            if isinstance(item, str):
                item = {"skill": item}
            if not isinstance(item, dict):
                continue
            skill = str(item.get("skill") or item.get("name") or "").strip()
            if not skill:
                continue
            # **fail-open**：拿不到技能清单时（引擎没起来）就放行
            if known and skill not in known:
                unknown.append(skill)
                continue
            cleaned.append(
                {
                    "skill": skill,
                    "params": dict(item.get("params") or {}),
                    "why": str(item.get("why") or item.get("reason") or "").strip(),
                }
            )
        if not cleaned:
            return {
                "ok": False,
                "reason": (
                    f"这几步里没有认得出的技能：{'、'.join(unknown[:5])}"
                    if unknown
                    else "没给步骤"
                ),
                "known_skills": sorted(known)[:12],
            }
        self._pending_plan = cleaned
        logger.info(
            "agent 留下了 %d 步计划：%s",
            len(cleaned),
            " → ".join(s["skill"] for s in cleaned),
        )
        return {
            "ok": True,
            "accepted": len(cleaned),
            "steps": [s["skill"] for s in cleaned],
            "unknown": unknown,
            "note": (
                f"记下了 {len(cleaned)} 步，**下一轮开始我直接按这个做，不再问模型**"
                "（所以这几步要写具体、能独立跑完）"
            ),
        }

    def _set_plan(self, plan: list, source: str = "llm") -> None:
        """装入一份有序计划。

        计划就是"任务排序"：LLM 一次给出几步、按顺序执行，
        中间不再问模型，所以她做完一步会**立刻**接下一步（连贯）。
        """
        cleaned = []
        for item in plan or []:
            if not isinstance(item, dict):
                continue
            skill = str(item.get("skill") or "").strip()
            if not skill:
                continue
            # 未知技能直接丢掉这一步（B3）：留着只会白烧一轮模型往返 + 记一笔失败
            if not self._skill_is_known(skill):
                logger.warning(
                    "计划里的技能「%s」不在引擎注册表里，丢掉这一步（已知技能 %d 个：%s）",
                    skill,
                    len(self._known_skills),
                    "、".join(sorted(self._known_skills)[:8]) or "（清单为空）",
                )
                continue
            cleaned.append(
                {
                    "skill": skill,
                    "params": dict(item.get("params") or {}),
                    "why": str(item.get("why") or item.get("reason") or "").strip(),
                }
            )
            if len(cleaned) >= 6:  # 太长的计划容易在环境变化后变成负担
                break
        self._plan = cleaned
        self._plan_source = source
        if cleaned:
            logger.info(
                "她排好了 %d 步计划（%s）：%s",
                len(cleaned),
                source,
                " → ".join(s["skill"] for s in cleaned),
            )



    def clear_plan(self, reason: str = "") -> None:
        """丢掉剩余计划（环境变了、某一步失败、玩家插手等）。"""
        if self._plan:
            logger.info("放弃剩余 %d 步计划（%s）", len(self._plan), reason or "原因未记录")
        self._plan = []
        self._pending_plan = []
        self._plan_revision = getattr(self, "_plan_revision", 0) + 1
        self._return_control_generation = getattr(self, "_return_control_generation", 0) + 1
        self._return_task_attempt = self._mining_return = None
        self._completed_tool_breaks = None
        self._return_boundary_state = {}

    def on_session_start(self) -> None:
        """每次进游戏时调用：清掉旧计划，让她重新排一份。

        用户要的"每一次进游戏也会生成一个任务"就落在这里——
        进服后第一次决策会产出一份新计划（而不是接着上次的旧计划干）。
        """
        self.clear_plan("重新进服，旧会话计划作废")
        self._rule_supply_candidate = self._rule_supply_attempt = None
        self._rule_supply_stalls.clear()
        self._world_changing = False
        self._intention_rounds = 0
        self._session_planned = False
        # **进游戏也要清打算和清单**（C 批次）。
        # 原来只清了 _plan 和 _intention_rounds —— 于是"死过之后又进游戏"
        # 会带着死前的打算（比如"盖个房子"）和死前的清单，
        # 而身上什么都没有。她就会去挖泥土（唯一能立刻成功的事）。
        if self._intention:
            logger.info("进游戏，丢掉上次的打算「%s」", self._intention)
        self._intention = ""
        self._intention_since = 0.0
        if self._todos:
            logger.info("进游戏，清掉上次的 %d 条清单", len(self._todos))
        self._todos = []
        self._wake.set()
        logger.info("她进游戏了：清空旧计划和打算，准备重新安排要做的事")

    def on_world_change(self) -> None:
        """Invalidate old-world work without altering owner pause, model faults or recovery todos."""
        self._world_changing = True
        self._rule_supply_candidate = self._rule_supply_attempt = None
        self._rule_supply_stalls.clear()
        self.clear_plan("切换维度，旧世界计划和模型结果作废")
        self._busy_until = 0.0
        self._wake.set()

    def on_world_ready(self) -> None:
        self._world_changing = False
        self._wake.set()


    def _parse_decision(self, raw: str | None, suggestion: dict) -> LifeDecision | None:
        if not raw:
            return None
        text = raw.strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:]
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            logger.info("过日子的决定解析失败：%s", text[:150])
            return None
        if not isinstance(data, dict):
            return None

        activity = str(data.get("activity") or "").strip()
        if not activity:
            return None
        say = data.get("say")
        if say is not None:
            say = str(say).strip() or None
        params = data.get("params")
        if not isinstance(params, dict):
            params = {}
        skill = data.get("skill")
        if skill is not None:
            skill = str(skill).strip() or None

        # **计划（任务排序）**：LLM 给的有序几步。
        # 兼容两种格式：
        #   "plan": [{"skill": "chop_tree", "params": {...}, "why": "..."}, ...]
        #   "skill" + "params"（只做一件事）→ 包成一步的计划
        #
        # **每一步的技能名都要校验**（B3）：模型幻觉出来的名字（比如早期的
        # `craft`、或者它自己编的 `mine_diamond`）会被原样提交给 skill.run，
        # 换来一句"没有这个技能：xxx"——白烧一轮模型往返，还会记进
        # `_recent_failures` 触发 30 秒失败退避。未知技能在这里就丢掉，
        # 并留下一条能定位的日志（模型到底编了什么名字）。
        plan = []
        raw_plan = data.get("plan")
        if isinstance(raw_plan, list):
            for item in raw_plan:
                if isinstance(item, dict):
                    s = str(item.get("skill") or "").strip()
                    if not s:
                        continue
                    if not self._skill_is_known(s):
                        logger.warning("她写了一个不存在的技能「%s」，丢掉这一步", s)
                        continue
                    plan.append(
                        {
                            "skill": s,
                            "params": item.get("params") if isinstance(item.get("params"), dict) else {},
                            "why": str(item.get("why") or item.get("reason") or "").strip(),
                        }
                    )
                elif isinstance(item, str) and item.strip():
                    s = item.strip()
                    if not self._skill_is_known(s):
                        logger.warning("她写了一个不存在的技能「%s」，丢掉这一步", s)
                        continue
                    plan.append({"skill": s, "params": {}, "why": ""})
        if not plan and skill:
            if self._skill_is_known(skill):
                plan = [{"skill": skill, "params": params, "why": str(data.get("reason") or "").strip()}]
            else:
                logger.warning("她写了一个不存在的技能「%s」，丢掉这一步", skill)

        # 本次决定 = 计划的第一步（立刻执行）；剩下的进队列，由循环逐步执行。
        if plan:
            skill = plan[0]["skill"]
            params = plan[0]["params"]
            self._pending_plan = plan[1:]
        else:
            skill = None
            params = {}
            self._pending_plan = []

        # intention 字段要区分"没写"和"写了 null"：
        #   没写（键不存在）→ None，表示"保持原打算不变"（防模型漏字段时误清空）
        #   写了 null/空串 → ""，表示"她主动放下了这件事"
        intention_raw = data.get("intention", None) if "intention" in data else None
        if intention_raw is None and "intention" not in data:
            intention = None
        elif intention_raw is None:
            intention = ""
        else:
            intention = str(intention_raw).strip()

        return LifeDecision(
            activity=activity,
            drive=suggestion.get("drive"),
            skill=skill,
            params=params,
            say=say,
            reason=str(data.get("reason") or "").strip(),
            intention=intention,
        )


    # ------------------------------------------------------------ 执行

    async def _act(self, decision: LifeDecision, *, allow_model_block: bool = False) -> None:
        plan_revision = getattr(self, "_plan_revision", 0)
        if not self.may_act(allow_model_block=allow_model_block):
            logger.info("决策期间状态已变化，暂停这次动作：%s", self.hold_explain())
            return
        if allow_model_block and self._owner_steer_pending():
            return
        self.current = decision
        self.history.append(decision)
        if len(self.history) > 50:
            self.history = self.history[-50:]

        logger.info(
            "她想做：%s%s",
            decision.activity,
            f"（技能 {decision.skill}）" if decision.skill else "（不动手，只是待着）",
        )

        # 记进记忆：她自己的决定也是一种经历
        self.memory.remember(
            "trivial",
            f"我自己决定去{decision.activity}",
            tags=[decision.drive or "", decision.skill or ""],
            weight=2,
        )

        if self._on_activity:
            try:
                await self._on_activity(decision)
            except Exception as exc:  # noqa: BLE001
                logger.info("on_activity 回调异常：%s", exc)

        # 说点什么（受冷却限制，避免刷屏）
        if decision.say:
            await self._maybe_share(decision.say)

        # 真的去做
        if decision.skill:
            submission = None
            try:
                # 分享/回调也会让出事件循环，提交前再检查一次。
                if not self.may_act(allow_model_block=allow_model_block):
                    return
                if allow_model_block and self._owner_steer_pending():
                    return
                if plan_revision != getattr(self, "_plan_revision", 0):
                    self._wake.set()
                    return
                if self.inbox.has_delivery(Delivery.STEER):
                    self.clear_plan("提交动作前收到新指令或环境变化")
                    self._wake.set()
                    return
                if not self.skill_retry_ready(decision.skill) and not (
                        decision.skill == "climb_out" and self._mining_return is not None):
                    logger.info("暂缓重复失败的技能 %s，下一轮换个做法", decision.skill)
                    return
                payload_params = dict(decision.params or {})
                work_state = self._return_boundary_state
                if decision.skill in self.PREPARATION_SKILLS:
                    state = await self._gather_state() if self._state_provider else {}
                    work_state = state
                    if (plan_revision != self._plan_revision or not self.may_act(allow_model_block=allow_model_block)
                            or self._owner_steer_pending() or self.inbox.has_delivery(Delivery.STEER)):
                        self._wake.set()
                        return
                    needs_search = self._skill_needs_outdoors(decision.skill, payload_params, state)
                    home = self._safe_home_for_state(state)
                    incomplete = self._state_provider and (not isinstance(state.get("inventory"), dict)
                        or state.get("health") is None or state.get("food") is None)
                    if incomplete or needs_search and (home or (self._state_provider and
                            (state.get("is_night") is not False or state.get("health", 0) <= 8))):
                        # State can change during sharing or a callback. Put the
                        # exact goal back before the remaining plan and let its
                        # next fresh boundary choose food, sleep or door exit.
                        self._plan.insert(0, {"skill": decision.skill, "params": payload_params,
                                              "why": decision.activity, "decision": decision})
                        self._rule_supply_wait_reason = "提交前材料或身体状态已变化，保留原步骤重新核验"
                        self._wake.set()
                        return
                    payload_params = self._preparation_params(decision.skill, payload_params, state)
                payload_params = self._protected_work_params(decision.skill, payload_params, work_state)
                candidate = self._rule_supply_candidate
                self._rule_supply_candidate = None
                if (allow_model_block and candidate is not None
                        and candidate["skill"] == decision.skill and candidate["params"] == decision.params
                        and candidate["revision"] == plan_revision):
                    self._rule_supply_attempt = candidate
                # 先登记宽限，再提交：极短任务可能在 RPC 返回前就发出完成事件。
                # 完成事件的 wake() 清掉宽限后，不能再被旧请求覆盖。
                self._busy_until = time.time() + 8
                if str(decision.skill).startswith("move."):
                    await self._call(decision.skill, decision.params or {})
                else:
                    submission = self.register_task_submission(decision.skill, state=work_state)
                    reply = await self._call("skill.run", {"skill": decision.skill, "params": payload_params})
                    self.bind_task_submission(submission, reply)
                # **不要在这里压一个长等待**。
                # 早期这里是 `+120` 秒，配合循环里的 90 秒 sleep，
                # 实测决策间隔变成 190~200 秒——技能 10 秒做完她也要干站三分半。
                # 真正该用的信号是"引擎里还有没有任务在跑"（_engine_busy），
                # 所以这里只留一个很短的宽限期，避免刚提交就立刻改主意。
            except Exception as exc:  # noqa: BLE001
                logger.warning("她想做的技能 %s 没能开始（检查是否在线）：%s", decision.skill, exc)
                if (submission is self._return_task_attempt and submission is not None
                        and submission.get("supply_return") is self._mining_return
                        and self._mining_return is not None):
                    # Preserve the still-current meal submission as evidence
                    # until its failure has retained the physical return duty.
                    self.note_task_result(decision.skill, False, str(exc))
                    self.bind_task_submission(submission, None)
                else:
                    self.bind_task_submission(submission, None)
                    self.note_task_result(decision.skill, False, str(exc))
                self._busy_until = 0.0
        else:
            # 不动手（发呆/看风景）：给一个"待着"的时间，然后重新想
            self._busy_until = time.time() + 25

        self.drives.note_activity(drive=decision.drive, activity=decision.activity)
        self._save_state()

    async def _maybe_share(self, text: str) -> None:
        now = time.time()
        if now - self._last_share_at < self._share_cooldown:
            logger.debug("分享冷却中，暂不发送：%s", text[:40])
            return
        self._last_share_at = now
        if not self._on_share:
            return
        try:
            await self._on_share(text)
        except Exception as exc:  # noqa: BLE001
            logger.info("分享失败：%s", exc)

    # ------------------------------------------------------------ 分享

    async def share_event(self, *, kind: str, text: str, force: bool = False) -> bool:
        """发生了值得说的事 → 用她的人格组织一句话分享出去。

        @param kind 事件类型（death/treasure/discovery/...）——决定分享的语气
        @param force 跳过冷却（死亡这类大事值得立刻说）
        """
        now = time.time()
        if not force and now - self._last_share_at < self._share_cooldown:
            return False

        # 取人格化的 system prompt（构造时以 system_prompt_provider 传入，存为 _system_prompt）
        system = await self._system_prompt()
        try:
            brief = await self._brief()
        except Exception:  # noqa: BLE001
            brief = ""

        tone = {
            "death": "你刚刚死了，有点懊恼或者后怕。",
            "treasure": "你挖到了值钱的东西，挺高兴。",
            "discovery": "你看到了以前没见过的东西，觉得新鲜。",
            "milestone": "你走了很远的路。",
            "social": "有人跟你搭话了。",
        }.get(kind, "有件事发生了。")

        prompt = (
            f"{tone}\n\n【当前状态】\n{brief}\n\n【发生了什么】{text}\n\n"
            "用你的人格在 Minecraft 聊天里说一句（不超过 30 字，口语化，不要像汇报）。只输出这句话本身。"
        )
        line = await self._llm(prompt, system)
        if not line:
            return False
        line = line.strip().splitlines()[0][:120]
        if not line:
            return False
        self._last_share_at = now
        if self._on_share:
            await self._on_share(line)
        return True

    # ------------------------------------------------------------ 状态


    def _load_state(self) -> None:
        """读回"打算"等长期状态（重启后不失忆）。"""
        if not self._data_dir:
            return
        path = self._data_dir / "life.json"
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception as exc:  # noqa: BLE001
            logger.info("读取生活状态失败：%s", exc)
            return
        if not isinstance(data, dict):
            return
        intention = str(data.get("intention") or "").strip()
        if intention:
            self._intention = intention
            self._intention_rounds = int(data.get("intention_rounds") or 0)
            self._intention_since = float(data.get("intention_since") or 0.0)
            logger.info("她记得自己的打算：%s（已做 %d 轮）", intention, self._intention_rounds)
        # The old boolean has no coordinates or world identity and cannot prove safety after restart.
        self._has_shelter = False
        homes = data.get("homes")
        if isinstance(homes, list):
            self._homes = [home for home in homes if self._valid_home(home)][-8:]
        todos = data.get("todos")
        if isinstance(todos, list):
            self._todos = [
                {"text": str(t.get("text") or ""), "done": bool(t.get("done"))}
                for t in todos
                if isinstance(t, dict) and str(t.get("text") or "").strip()
            ][:12]
            if self._todos:
                logger.info("她记得自己的任务清单：%d 项", len(self._todos))


