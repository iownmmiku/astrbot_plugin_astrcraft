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
import random
import time
from enum import Enum

from .inbox import Delivery, Inbox
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from astrbot.api import logger

from .advisor import advise, advise_for_prompt
from .drives import DriveSystem
from .memory import MemoryStore

# 决策阶段的行为约束（配合 perception_agent 的只读工具）
PERCEPTION_PROMPT_EXTRA = """在决定"接下来做什么"时：
- 需要事实就**先查看**（mc_status / mc_inventory / mc_scan / mc_players 都是只读的），
  不要凭印象猜背包里有什么、附近有没有树。
- 查看是为了决定，通常 0~2 次就够，不要无休止地查。
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


@dataclass
class LifeDecision:
    """一次"我现在要做什么"的决定。"""

    activity: str
    drive: str | None
    skill: str | None = None
    params: dict = field(default_factory=dict)
    say: str | None = None
    reason: str = ""
    # 她正在做的"打算"（跨多轮持续的目标）。真人不是每 90 秒从零开始想，
    # 而是心里有件事在推进；这个字段让决定之间有连续性，且**由 LLM 自己设定**。
    intention: str | None = None
    at: float = field(default_factory=time.time)

    def to_json(self) -> dict:
        return {
            "activity": self.activity,
            "drive": self.drive,
            "skill": self.skill,
            "params": self.params,
            "say": self.say,
            "reason": self.reason,
            "intention": self.intention,
            "at": self.at,
        }


def _clip(text: str | None, limit: int) -> str:
    """把一段文本截到 limit 字以内（超了就截断并标明"还有更多"）。

    为什么要标明：直接截断会让模型以为"就这些了"，从而漏掉关键信息；
    写一句"（后面还有 N 字没显示）"它就知道可以用工具去查。
    """
    t = (text or "").strip()
    if len(t) <= limit:
        return t
    return f"{t[:limit].rstrip()}…（后面还有 {len(t) - limit} 字没显示）"


class Hold(Enum):
    """她为什么**不能**动——**唯一答案**。

    这是把原来散在 `_loop` 里的几个条件收成一张表。收之前的样子：

        self._paused            # 主人按了暂停
        self._pause_until       # 暂停超时（补丁）
        self._busy_until        # 刚提交任务后的等待期
        self._is_connected()    # 没进服
        self._engine_busy()     # 引擎在忙

    五个独立条件、每个都能**静默** `continue` —— 于是"她站在原地什么都不干"时，
    日志里只有一行"跳过"，没人说得清到底是哪一个。`_auto_resume_if_expired()`
    就是给 `_paused` 打的补丁（它自己的注释写着："早期版本只 pause、
    靠 task.finished 事件 resume，结果工具执行失败时根本不会有任务产生，
    于是她永久停滞"）。

    现在：`current_hold()` 合成唯一答案，每种停牌都配一张"**谁来解开**"的表，
    进/出**只在变化沿打一条日志**（停牌期间每 tick 都不刷屏）。
    """

    NONE = "none"  # 没有停牌：可以跑
    DEAD = "dead"  # 她死了
    DISCONNECTED = "disconnected"  # 没进服
    PAUSED_BY_OWNER = "paused_by_owner"  # 主人在用她 / 按了暂停
    BLOCKED = "blocked"  # 模型端点不可用
    ENGINE_DOWN = "engine_down"  # 引擎进程没了


# **谁来解开**——照 numen 的 releasedBy 表。缺了这张表，停牌就会变成"永久停滞"。
HOLD_RELEASE: dict["Hold", str] = {
    Hold.NONE: "",
    Hold.DEAD: "复活（收到 bot.spawn）",
    Hold.DISCONNECTED: "重新进服",
    Hold.PAUSED_BY_OWNER: "主人恢复，或暂停超时自动恢复",
    Hold.BLOCKED: "模型端点恢复（配好 provider 后自己解开）",
    Hold.ENGINE_DOWN: "引擎进程起来",
}

# 给人看的一句话
HOLD_WHY: dict["Hold", str] = {
    Hold.NONE: "她在正常过日子",
    Hold.DEAD: "她已经死了，在等复活",
    Hold.DISCONNECTED: "她还没进服",
    Hold.PAUSED_BY_OWNER: "自主行动被暂停了（主人在用她，或按了暂停）",
    Hold.BLOCKED: "拿不到模型（provider 没配好或调用失败）",
    Hold.ENGINE_DOWN: "引擎进程不在（node 挂了或没启动）",
}


class LifeLoop:
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
        # **有序计划（任务排序）**：LLM 一次给几步，循环里按顺序执行，
        # 中间不再问模型 —— 这是"连续行动"的关键。
        self._plan: list[dict] = []
        self._plan_source: str = ""
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
        # **决策失败最多重试几次**（W3）：照 numen 的"每条链只重试一次"。
        # 到上限就进 BLOCKED 停牌并说清楚，而不是每 8 秒无限重试
        # （实测那样能连着几十次，她一直在"想事情"却什么都没做）。
        self._decide_retry_limit = 2
        # ---- 永不空闲（W7）----
        # **只对"同一件事反复失败"退避**，不对所有决策退避。
        # 上一轮那个 `min_decide_gap = 6`（一刀切）已经拆掉：
        # 它治错了病——病根是"重新规划太频繁"，而副作用是"没事做时也要干等 6 秒"。
        self._idle_rounds = 0  # 连续"这一轮什么都没做成"的次数
        self._idle_since = 0.0  # 从什么时候开始连续没事做
        self._last_idle_note_at = 0.0  # 上次把"没事做"说出去的时间（别刷屏）
        self._backoff_until = 0.0  # 失败退避到什么时候
        # ---- 输入队列（W4，见 docs/PLAN_v2.md）----
        # 主人的话与世界事件**共用**这一个队列。没有它的时候：
        # 她跑长任务时主人说话她听不见；世界事件只有下一轮决策时才知道。
        self.inbox = inbox if inbox is not None else Inbox()
        # 本轮要接上的"排着的事"（FOLLOW_UP），由循环在"她本来要停"时填。
        self._pending_follow_up: str = ""
        # 急件叫醒：叫的是"来问吧"，**不递事件**——
        # 正确性从不依赖叫醒（队列的 ready()/has_urgent() 随时可问、答案一致）。
        try:
            self.inbox.on_urgent(lambda: self._wake.set())
        except Exception as exc:  # noqa: BLE001
            logger.debug("登记急件叫醒失败：%s", exc)
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

    def _drain_steer_text(self) -> str:
        """**取插话并渲染**——在"下次调模型之前"注入（W4）。

        对应 numen 的 STEER：一批工具结算后、下次调模型之前注入。
        我们的等价点是"每次组装提示词的时候"——agent 每一轮都会重新组装提示词，
        所以这里就是安全的注入点（不会插在 assistant 的 tool_calls 中间）。

        **取走即出队**：不重复注入同一条。
        """
        try:
            taken = self.inbox.take_steer()
        except Exception as exc:  # noqa: BLE001
            logger.debug("取插话失败：%s", exc)
            return ""
        if not taken:
            return ""
        lines = Inbox.render(taken)
        note = self.inbox.take_dropped_note()
        body = "\n".join(lines)
        if note:
            body += f"\n{note}"
        logger.info("注入 %d 条插话（主人说话/世界事件）", len(taken))
        return f"【刚刚发生的事（你要先看这个）】\n{body}\n"

    def _take_follow_up_text(self) -> str:
        """取接续——**只在她本来要停的时候**用（W4）。

        和插话的区别：插话是"她要继续干活，顺便告诉她新情况"；
        接续是"她本来要停下来了，正好有件事可以接着做"。
        """
        try:
            taken = self.inbox.take_follow_up()
        except Exception as exc:  # noqa: BLE001
            logger.debug("取接续失败：%s", exc)
            return ""
        if not taken:
            return ""
        return "\n".join(Inbox.render(taken))

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
            logger.debug("取控制条目失败：%s", exc)
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
                done.append("清空计划和清单")
            elif e.type == "compact":
                # 整理记忆：把同类条目合并（W5 之后是"只增补"的合并，不会丢信息）
                try:
                    if self.memory is not None:
                        self.memory.prune()
                        done.append("整理记忆")
                except Exception as exc:  # noqa: BLE001
                    logger.debug("整理记忆失败：%s", exc)
            else:
                done.append(f"（不认识的控制器 {e.type}，跳过）")
        text = "、".join(done) if done else ""
        if text:
            logger.info("执行控制条目：%s", text)
        return text

    def note_owner_said(self, text: str) -> None:
        """主人说了一句话——**入队**，不是直接执行（W4）。

        由 main.py 在收到消息时调用。这样她跑长任务时主人说话也**不会丢**：
        话躺在队列里，等她到安全注入点（下次组装提示词）就会看到。
        """
        entry = self.inbox.push("owner", text)
        if entry is not None:
            logger.info("主人的话入队：%s", text[:60])

    def note_world_event(self, kind: str, text: str, *, urgent: bool = False) -> None:
        """世界事件入队（受伤/工具坏/箱子满/任务完成…）。由 main.py 在引擎事件时调用。"""
        entry = self.inbox.push(kind, text, urgent=urgent)
        if entry is not None:
            logger.debug("世界事件入队（%s）：%s", kind, text[:60])

    def inbox_summary(self) -> str:
        """给 /mc状态 用：队列里还排着什么。"""
        n = len(self.inbox)
        if not n:
            return "队列空"
        kinds: dict[str, int] = {}
        for e in self.inbox.entries:
            kinds[e.type] = kinds.get(e.type, 0) + 1
        detail = "、".join(f"{k}×{v}" for k, v in kinds.items())
        urgent = "（有急件）" if self.inbox.has_urgent() else ""
        return f"排队 {n} 条{urgent}：{detail}"

    def _should_back_off(self) -> bool:
        """该不该退避一下？**只对"同一件事反复失败"退避**，不对所有决策退避。

        这是 W7 的核心：用户要"没有任务就立刻发起一个"，
        所以**不能**像上一轮那样对所有决策一律压 6 秒。
        真正该歇一会儿的只有一种情况——同一个技能在短时间内反复失败
        （说明她卡住了，再立刻重试还是同样结果，只会刷日志）。
        """
        now = time.time()
        if now < self._backoff_until:
            return True
        # 同一个技能失败 3 次以上 → 歇 30 秒（`_recent_failures` 是 W3 之前就有的）
        counts = self._failure_counts()
        if counts and max(counts.values()) >= 3:
            self._backoff_until = now + 30.0
            logger.info(
                "失败退避 30 秒（同一件事已经失败 %d 次：%s）——"
                "这不是'没事做'，是它卡住了，立刻重试只会得到同样结果",
                max(counts.values()),
                "、".join(sorted(counts)[:3]),
            )
            return True
        return False

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

    def state_note(self, text: str) -> None:
        """往状态简报里写一句（给 LLM 和 /mc状态 看）。"""
        try:
            self._on_activity(text)
        except Exception as exc:  # noqa: BLE001
            logger.debug("写状态简报失败：%s", exc)

    def idle_explain(self) -> str:
        """她是不是"能跑但没事做"——给 /mc状态 用。"""
        if self.current_hold() is not Hold.NONE:
            return ""  # 停牌有停牌的说法，别混
        if self._idle_rounds <= 0:
            return ""
        mins = (time.time() - self._idle_since) / 60.0 if self._idle_since else 0.0
        return (
            f"她已经连续 {self._idle_rounds} 轮没做成事（约 {mins:.1f} 分钟）。"
            "**她没有停牌，是确实没事做**——可以给她一个目标，或者看看是不是卡在某个失败上"
        )

    def note_task_result(self, name: str, ok: bool, error: str = "") -> None:
        """记录一次任务结果（由插件在 task.finished 时调用）。

        只记技能名，用于"别在同一件事上无限循环"。成功会**清掉**该技能的失败记录——
        这样"失败过但后来做成了"不会一直被念叨。
        同时存进"最近做过的事"，让决策时能回想刚才发生了什么。
        """
        if not name:
            return
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

        if ok:
            self._recent_failures.pop(name, None)
            if name in ("build_shelter", "建庇护所"):
                self._has_shelter = True
            return
        bucket = self._recent_failures.setdefault(name, [])
        bucket.append(now)
        # 只保留窗口内的
        self._recent_failures[name] = [t for t in bucket if now - t <= self._failure_window][-8:]
        # **一步失败就丢掉剩余计划**：计划是按"前一步成功"排的，
        # 前一步失败还硬按原顺序做后面的事，只会连环失败。
        # 丢掉之后下一轮会重新问 LLM 排一份新的（它会看到失败记录）。
        if self._plan:
            self.clear_plan(f"{name} 失败：{(error or '')[:40]}")
        logger.debug("记录失败：%s（近半小时第 %d 次）%s", name, len(self._recent_failures[name]), error[:60])
        # **学习回路**：同一个坑摔第三次就停下来总结一条教训。
        #
        # 为什么是"第三次"而不是每次：第一次可能是偶发（网络、地形），
        # 第二次还可能是运气；连续三次说明这是**规律**，值得记下来。
        # 而且每次失败都去调模型总结太贵（一次往返几秒 + token）。
        if self.knowledge is not None and len(self._recent_failures[name]) == 3:
            self._schedule_lesson(name, error or "")

    def _schedule_lesson(self, skill: str, error: str) -> None:
        """把"提炼教训"排进后台，不阻塞主循环。"""
        async def _learn() -> None:
            try:
                brief = await self._brief()
            except Exception:  # noqa: BLE001
                brief = ""
            prompt = self.knowledge.build_lesson_prompt(skill=skill, error=error, context=brief)
            try:
                raw = await self._llm(prompt, "你在总结一条以后能用的经验。只回答那条经验本身。")
            except Exception as exc:  # noqa: BLE001
                logger.debug("提炼教训失败：%s", exc)
                return
            result = self.knowledge.parse_lesson(raw, skill=skill, source="失败总结")
            if result:
                logger.info("她总结出一条经验：%s", result[:60])

        try:
            asyncio.get_running_loop().create_task(_learn())
        except RuntimeError:
            logger.debug("没有事件循环，跳过教训提炼")

    @staticmethod
    def _death_recovery_todos() -> list[dict]:
        """**死亡恢复清单**（C 批次，见 docs/DEATH_RECOVERY.md）。

        顺序是有讲究的——**按"能不能徒手做到"排**：

          1. 砍树拿木头 —— **徒手就能砍**，所以排第一（她死后身上什么都没有）
          2. 做工作台 + 木镐 —— 有了木头就能做
          3. 挖石头做石制工具 —— 有镐了才行
          4. 再想死前那件事 —— 最后，因为那时才具备条件

        为什么必须写成"有名字的东西"：用户实测反馈"死过一次之后，他不会做木镐了，
        直接开始挖泥土"。原因是她死后**泥土徒手就能挖、立刻成功**，
        而做木镐要先砍树、容易失败——**没有任何东西告诉她"你现在一无所有、
        必须先重建工具"**。这份清单就是那个"东西"。

        （另外它被 `bot/tools/check_capabilities.py` 的承诺表盯着——
          "死亡时写入恢复清单"这条承诺必须能找到这个符号。）
        """
        return [
            {"text": "砍树拿木头（徒手也能砍，先砍 4~6 个原木）", "done": False},
            {"text": "做工作台 + 木镐", "done": False},
            {"text": "有镐了再挖石头，做石制工具（石镐/石剑/石斧）", "done": False},
            {"text": "有余力再想死前那件事（现在身上什么都没有，先别急）", "done": False},
        ]

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

    def _render_progress_since(self, since: float, *, limit: int = 8) -> str:
        """**自某个时刻以来的累计进展**（W5）——给"打算"当评估证据用。

        为什么不能只看"最近 5 条"：她可能在同一个打算上做了 20 轮，
        而最近 5 条里全是失败——模型就会以为"这件事我根本没做成过"，
        然后去做别的（numen 记录过：评估器咬定"没有挖矿证据"，
        把她赶去满世界找矿四分钟）。

        所以这里按 `since` 起算，**把做成过什么、失败过什么分别列出来**。
        """
        if not since:
            return ""
        rows = [o for o in self._recent_outcomes if o.get("at", 0) >= since]
        if not rows:
            return ""
        done: dict[str, int] = {}
        failed: dict[str, int] = {}
        for o in rows:
            name = str(o.get("skill") or "（未知）")
            if o.get("ok"):
                done[name] = done.get(name, 0) + 1
            elif not o.get("decision"):
                # "想事情失败"不算"做事失败"，别混进来（见 W3）
                failed[name] = failed.get(name, 0) + 1
        parts = []
        if done:
            parts.append("做成过：" + "、".join(f"{k}×{v}" for k, v in sorted(done.items())[:limit]))
        if failed:
            parts.append("失败过：" + "、".join(f"{k}×{v}" for k, v in sorted(failed.items())[:limit]))
        if not parts:
            return ""
        return (
            f"——**自这个打算开始以来**（共 {len(rows)} 条记录）："
            + "；".join(parts)
            + "。\n（这是累计的账，不是最近几条——别因为最近几次失败就说'我没做成过'）\n"
        )

    def _render_recent(self) -> str:
        """把"最近做过的事 + 刚死过"渲染成给 LLM 看的一小段。"""
        lines: list[str] = []
        # **死亡那段改用 death_drop_hint()**（C 批次）。
        # 原来只有一句"要不要回去捡，你自己决定"——**没给判断依据**，
        # 而掉落物 5 分钟就消失，她很可能花 6 分钟走回去、什么都没捡到
        # （那比不去更糟）。现在给她可执行的判据："2 分钟内能走到就去，否则别去"。
        death_hint = self.death_drop_hint()
        if death_hint:
            lines.append(death_hint)
        if self._recent_outcomes:
            lines.append("- 你最近做过的事：")
            for o in reversed(self._recent_outcomes[-5:]):
                when = time.strftime("%H:%M", time.localtime(o["at"]))
                if o.get("decision"):
                    # **"想事情失败"要和"做事失败"分开说**（W3）。
                    # 不分开的话，她会以为自己试过某件事而其实那轮根本没跑起来。
                    lines.append(
                        f"    {when}  ⚠️ 上一轮{ o['detail'] }"
                        "——**那一轮什么都没做成**，别以为你做过什么"
                    )
                elif o["ok"]:
                    lines.append(f"    {when}  {o['skill']} → 做成了")
                else:
                    detail = f"：{o['detail']}" if o["detail"] else ""
                    lines.append(f"    {when}  {o['skill']} → 没做成{detail}")
        return "\n".join(lines)

    def _failure_counts(self) -> dict[str, int]:
        now = time.time()
        out = {}
        for name, times in self._recent_failures.items():
            n = len([t for t in times if now - t <= self._failure_window])
            if n:
                out[name] = n
        return out

    async def _gather_state(self) -> dict:
        """取真实状态给顾问用（拿不到就返回空，顾问会用保守默认值）。"""
        out: dict = {}
        if not self._state_provider:
            return out
        try:
            data = await self._state_provider()
            if isinstance(data, dict):
                out.update(data)
        except Exception as exc:  # noqa: BLE001
            logger.debug("取状态失败（顾问将用默认值）：%s", exc)
        return out

    async def _build_advice(self) -> object:
        """算一次生存建议。"""
        st = await self._gather_state()
        adv = advise(
            st.get("inventory") or {},
            health=float(st.get("health", 20) or 20),
            food=int(st.get("food", 20) or 20),
            has_shelter=bool(st.get("has_shelter", self._has_shelter)),
            recent_failures=self._failure_counts(),
            is_night=bool(st.get("is_night", False)),
            inventory_slots_used=int(st.get("inventory_slots_used", 0) or 0),
        )
        self._last_advice = adv
        return adv

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stopped = False
        self._task = asyncio.create_task(self._loop(), name="mc-life-loop")
        logger.info("「过日子」循环已启动（每 %.0f 秒想一次自己在干嘛）", self._decide_interval)

    async def stop(self) -> None:
        self._stopped = True
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
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

    def _auto_resume_if_expired(self) -> None:
        """暂停超期就自动恢复，避免"一次失败导致永久停滞"。"""
        if self._paused and self._pause_until and time.time() >= self._pause_until:
            logger.warning(
                "过日子循环的暂停已超过期限（原因：%s），自动恢复自主行动",
                self._pause_reason or "未记录",
            )
            self.resume()

    # ------------------------------------------------------------ 停牌（Hold）

    def current_hold(self) -> Hold:
        """她为什么**不能**动——唯一答案。

        **别处不许再各自判断这些条件。** 想知道"她为什么没动"就调这一个。
        顺序有意义：死 > 掉线 > 引擎没了 > 被暂停 > 模型不可用。
        （死着的时候"没进服"是废话，所以死排最前。）
        """
        if self._dead:
            return Hold.DEAD
        if self._is_connected and not self._is_connected():
            return Hold.DISCONNECTED
        if not self._engine_up:
            return Hold.ENGINE_DOWN
        if self._paused:
            return Hold.PAUSED_BY_OWNER
        if self._blocked_reason:
            return Hold.BLOCKED
        return Hold.NONE

    def hold_explain(self) -> str:
        """一句人话：她为什么没在动 + 什么能解开它。"""
        h = self.current_hold()
        if h is Hold.NONE:
            return HOLD_WHY[h]
        why = HOLD_WHY[h]
        rel = HOLD_RELEASE.get(h) or "（没写谁来解开——这是个 bug）"
        detail = ""
        if h is Hold.BLOCKED and self._blocked_reason:
            detail = f"（{self._blocked_reason}）"
        elif h is Hold.PAUSED_BY_OWNER and self._pause_reason:
            detail = f"（{self._pause_reason}）"
        return f"{why}{detail}；解开条件：{rel}"

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
        """她死了/复活了。由 main.py 在 bot.death / bot.spawn 时调用。"""
        self._dead = bool(dead)
        self._announce_hold()

    def note_engine_up(self, up: bool) -> None:
        """引擎进程在不在。由 main.py 在引擎启停时调用。"""
        self._engine_up = bool(up)
        self._announce_hold()

    def note_blocked(self, reason: str = "") -> None:
        """模型端点不可用（拿不到 provider、调用连续失败…）。"""
        self._blocked_reason = str(reason or "未知原因")
        self._announce_hold()

    def note_unblocked(self) -> None:
        """模型端点恢复了。"""
        self._blocked_reason = ""
        self._announce_hold()

    @property
    def running(self) -> bool:
        return bool(self._task and not self._task.done() and not self._stopped)

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

    @property
    def paused(self) -> bool:
        return self._paused

    # ------------------------------------------------------------ 主循环

    async def _loop(self) -> None:
        # 进服后先等一会儿，别一上来就开始折腾
        await asyncio.sleep(20)
        while not self._stopped:
            try:
                # **用"可被唤醒的等待"代替固定 sleep。**
                #
                # 早期是 `await asyncio.sleep(90)` + 动作后再压 120 秒，
                # 于是实测她的决策间隔是 **190~200 秒**——哪怕技能 10 秒就做完了，
                # 她也要干站着三分半才想下一件事。用户看到的就是"她不动"。
                # 真人做完一件事会**立刻**想下一步，所以这里改成：
                #   - 平时最多等 decide_interval 秒
                #   - 任务一结束（task.finished）立刻唤醒她继续想
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=self._decide_interval)
                    self._wake.clear()
                except asyncio.TimeoutError:
                    pass
                if self._stopped:
                    break

                # **失败感知退避（W7），取代上一轮那个"一刀切 6 秒"。**
                #
                # 上一轮我加过 `min_decide_gap = 6`（对所有决策一律压 6 秒），
                # 用来治"乱走乱挖"。但那个药方是错的：病根是**重新规划太频繁
                # （每决策一次就改主意）**，不是"手上没活"。一刀切压间隔的副作用是
                # **她没事做的时候也要干等 6 秒**——而用户明确要求"没有任务就立刻发起一个"。
                #
                # 现在的分工：
                #   - "别频繁改主意" 交给**计划连续性**（见下面的计划优先）
                #   - 时间退避**只用于"同一件事反复失败"**（真的卡住了才歇）
                #   - 其余情况**一律立刻行动**，不等待
                if self._should_back_off():
                    await asyncio.sleep(2.0)
                    continue

                self.drives.tick()
                self.drives.save()

                # 暂停超期自动恢复：不能让一次失败（比如工具报错、没有产生任务）
                # 把她永久按在原地——那正是"她再也不自己动"的原因。
                self._auto_resume_if_expired()

                # **停牌判断收成一处**（W2）。
                #
                # 原来是 5 个独立条件、各自 `continue`，而且**一句日志都没有**——
                # 她站在原地不动时，日志里只有一行"跳过"，没人说得清是哪一个。
                # 现在：current_hold() 合成唯一答案，进/出只在变化沿打日志。
                self._announce_hold()
                hold = self.current_hold()
                if hold is not Hold.NONE:
                    # 停牌期间不空转：等一会儿再看（_wake 会在有输入时立刻叫醒）
                    try:
                        await asyncio.wait_for(self._wake.wait(), timeout=5.0)
                        self._wake.clear()
                    except asyncio.TimeoutError:
                        pass
                    continue

                if time.time() < self._busy_until:
                    continue

                # 引擎空闲才自主行动：有任务在跑说明你（或目标系统）已经在用她
                busy = await self._engine_busy()
                if busy:
                    continue

                # **控制条目只在完全空闲时执行**（W4）。
                #
                # 走到这里 = 没停牌 + 引擎空闲 + 计划空 —— 也就是"她确实没事做"。
                # 整理记忆/清空上下文会改变她正在看的历史，干活干到一半做等于抽走图纸，
                # 所以它们排在队首当屏障，等到这一刻才执行。
                if self.inbox.head_is_control():
                    what = self._run_control()
                    if what:
                        self.state_note(f"我{what}了")
                    continue

                # **接续：只在她本来要停的时候接上**（W4）。
                #
                # 和插话的区别：插话是"她还要继续干活，顺便告诉她新情况"；
                # 接续是"她本来要停下来了，正好有件事可以接着做"。
                # 没有这一步的话，队列里躺着"砍树做完了""箱子满了"这类事，
                # 而她会因为"计划空 + 没任务"被判成没事做（IDLE_NO_WORK）。
                follow_up = self._take_follow_up_text()
                if follow_up:
                    logger.info("接上排队的后续事项，继续干活")
                    self._note_busy_round()
                    self._pending_follow_up = follow_up
                else:
                    self._pending_follow_up = ""

                # **agent 写的计划要在下一轮生效**（C 批次）。
                #
                # 计划机制本来就在，但只有旧路径会写它；走 agent 路径时
                # agent 每轮都返回"我处理了"，于是计划机制是死的 ——
                # 她每走一步都要过一次模型（玩家看到的就是"老站着不动"）。
                if self._pending_plan and not self._plan:
                    self._set_plan(self._pending_plan, source="agent")
                    self._pending_plan = []

                # **计划优先：有计划就直接执行下一步，不调模型（W7 的核心）。**
                #
                # 为什么必须放在 agent 之前：agent 正常可用时**每轮都会返回 True**
                # （"这一轮我处理了"），于是它下面的 `_pop_plan_step()` 永远轮不到
                # ——**计划机制在 agent 可用时是死代码**。而它正是那条
                # "不花 token 的路"。用户要的"没有任务就立刻发起一个"，
                # 最省的做法就是先把已经想好的下一步做掉。
                step = self._pop_plan_step()
                if step is not None:
                    decision = self._decision_from_step(step)
                    logger.info(
                        "按计划执行（还剩 %d 步）：%s（技能 %s）——不调模型",
                        len(self._plan),
                        decision.activity,
                        decision.skill,
                    )
                    self._note_busy_round()
                    await self._act(decision)
                    continue

                # **首选：让 LLM 用工具直接驱动她**（让模型直接用工具）。
                #
                # 早期这里是"LLM 挑一个技能名 → 我提交技能任务"，
                # 也就是说真正干活的是我写的脚本，LLM 只是在按按钮。
                # 现在改成：把观察 + 完整工具集交给模型，它自己一步步动手。
                # 拿不到工具集（没配 provider 等）时返回 None，自动退回旧路径。
                if self.action_agent is not None:
                    try:
                        handled = await asyncio.wait_for(
                            self._act_via_agent(), timeout=self._decide_timeout
                        )
                    except asyncio.TimeoutError:
                        # **失败要留痕 + 只重试一次**（W3，见 docs/PLAN_v2.md）。
                        #
                        # 原来这里只是"打一行日志 + sleep(8) 重来"，两个毛病：
                        #   ① 模型不知道上一轮被切断了 → 下一轮可能原样再来一遍，
                        #      或者以为自己做过什么（其实那轮根本没跑起来）
                        #   ② **无限重试**：`_decide_timeouts` 只计数从不放弃，
                        #      实测能连着几十次，她一直在"想事情"但什么都没做
                        # 现在：记进"最近做过的事"（下一轮观察里带着），
                        # 连续 2 次就进 BLOCKED 停牌并说清楚——
                        # 端点真有问题就该让人知道，而不是假装还在努力。
                        self._decide_timeouts = getattr(self, "_decide_timeouts", 0) + 1
                        self.note_decision_cut(
                            f"{self._decide_timeout:.0f} 秒没想出来", kind="timeout"
                        )
                        if self._decide_timeouts >= self._decide_retry_limit:
                            logger.error(
                                "自主行动连续超时 %d 次（每次 %.0f 秒），"
                                "不再重试——进停牌，等端点恢复或人来处理",
                                self._decide_timeouts,
                                self._decide_timeout,
                            )
                            self.note_blocked(
                                f"连续 {self._decide_timeouts} 次决策超时"
                                f"（每次 {self._decide_timeout:.0f} 秒）"
                            )
                            continue
                        logger.warning(
                            "自主行动超时（%.0f 秒，第 %d/%d 次），8 秒后重试一次",
                            self._decide_timeout,
                            self._decide_timeouts,
                            self._decide_retry_limit,
                        )
                        await asyncio.sleep(8)
                        continue
                    except asyncio.CancelledError:
                        self.note_decision_cut("循环被取消", kind="cancelled")
                        raise
                    except Exception as exc:  # noqa: BLE001
                        self.note_decision_cut(str(exc), kind="failed")
                        self._decide_timeouts = getattr(self, "_decide_timeouts", 0) + 1
                        if self._decide_timeouts >= self._decide_retry_limit:
                            logger.error("自主行动连续出错 %d 次，进停牌", self._decide_timeouts)
                            self.note_blocked(f"连续 {self._decide_timeouts} 次决策出错：{exc}")
                            continue
                        await asyncio.sleep(8)
                        continue
                    if handled:
                        self._decide_timeouts = 0
                        # **成功一次就把"模型不可用"解开**：说明端点其实好的。
                        if self._blocked_reason:
                            self.note_unblocked()
                        # **agent 跑了一轮**，但它可能什么都没提交（只是看了看、
                        # 或者想不出该干嘛）。
                        #
                        # **判"没事做"必须把队列也算进去**（W4）：队列里躺着
                        # "砍树做完了""箱子满了"这类排着的事，那就不叫没事做
                        # ——下一步就会接上它们。只看"计划空 + 没提交任务"
                        # 会把"有活排队"误判成空闲。
                        if (
                            not self._plan
                            and not await self._engine_busy()
                            and len(self.inbox) == 0
                        ):
                            self.note_idle_round("agent 这一轮没有提交任何任务，队列也空")
                        else:
                            self._note_busy_round()
                        continue

                # 走到这里说明：没停牌、引擎空闲、**计划也空了**、agent 也帮不上
                # （不可用，或者它这一轮什么都没做）。
                #
                # **旧路径的 decide()**：agent 完全不可用时退回"挑技能"的老办法。
                # （原来上面还有一段"有计划就执行下一步"，已经挪到 agent 之前了
                # —— 放在这里它在 agent 可用时是死代码。）
                #
                # 决策必须带超时。LLM 卡住时若一直等，循环会永久冻结且不留日志，
                # 表现成"她启动了却什么都不做"，排查时毫无线索。
                try:
                    decision = await asyncio.wait_for(self.decide(), timeout=self._decide_timeout)
                    self._decide_timeouts = 0
                    if self._blocked_reason:
                        self.note_unblocked()  # 成功一次就说明端点其实好的
                except asyncio.TimeoutError:
                    # 同 W3：留痕 + 只重试一次，到上限就进停牌（不再无限重试）
                    self._decide_timeouts = getattr(self, "_decide_timeouts", 0) + 1
                    self.note_decision_cut(
                        f"{self._decide_timeout:.0f} 秒没想出来", kind="timeout"
                    )
                    if self._decide_timeouts >= self._decide_retry_limit:
                        logger.error(
                            "想事情连续超时 %d 次，不再重试——进停牌", self._decide_timeouts
                        )
                        self.note_blocked(
                            f"连续 {self._decide_timeouts} 次决策超时"
                            f"（每次 {self._decide_timeout:.0f} 秒）"
                        )
                        continue
                    logger.warning(
                        "想事情超时（%.0f 秒，第 %d/%d 次），8 秒后重试一次",
                        self._decide_timeout,
                        self._decide_timeouts,
                        self._decide_retry_limit,
                    )
                    await asyncio.sleep(8)
                    continue

                if decision is None:
                    # 旧路径也没想出任何事 → 同样是"能跑但没事做"（W7）。
                    # 但**队列不空就不算**（W4）：还有排着的事要办。
                    if len(self.inbox) == 0:
                        self.note_idle_round("想不出该做什么，队列也空")
                    continue

                self._note_busy_round()
                await self._act(decision)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.error("过日子循环异常：%s", exc)

    async def _engine_busy(self) -> bool:
        try:
            status = await self._call("task.list", {})
        except Exception:  # noqa: BLE001
            return True  # 问不到状态就当忙，别乱动
        if not isinstance(status, dict):
            return True
        if status.get("current"):
            return True
        if status.get("queued"):
            return True
        return False

    # ------------------------------------------------------------ 决策

    async def decide(self) -> LifeDecision | None:
        """决定"现在想做什么"。先问 LLM，问不到就退回规则。"""
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
                logger.debug("取技能清单失败：%s", exc)
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
        prompt = f"""你现在正在 Minecraft 里自己玩，没人给你派活。决定一下接下来做什么。

【当前状态】
{brief}

{advice_show}
{intention_text}

{self.render_todos()}

{f'【你的近期经历】{chr(10)}{recent_show}{chr(10)}' if recent_show else ''}
{f'【你记得的事】{chr(10)}{memo_show}{chr(10)}' if memo_show else ''}
【你现在的心情】
{suggestion['label']}（强度 {suggestion['level']}）：{suggestion['voice']}"""

        # 上下文分层 + 体积分解（排查"为什么慢"时直接看日志）
        system = f"{system}\n\n{static_rules}"
        logger.debug(
            "决策上下文分层：system %d 字（静态，可缓存）｜ user %d 字（动态）"
            "｜ 其中 状态%d 打算%d 清单%d 经历%d 顾问%d 心情%d 记忆%d 技能%d",
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
        )

        # 优先走"带感知工具"的决策：她可以先查看再决定（这才是真人在做的事）。
        # 拿不到工具（没 provider / 工具管理器不可用）就退回纯文本决策，功能不受影响。
        #
        # **连续失败就暂时不再尝试**：实测感知路径因为一个字段名错误每次都抛异常，
        # 结果每轮决策都白等一次 LLM 往返（甚至撑到超时），她看起来完全不动。
        # 这里失败 3 次就停用 10 分钟，让决策走纯文本（至少她还在动）。
        raw = None
        used_tools: list[str] = []
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
        if raw is None:
            raw = await self._llm(prompt, system)

        decision = self._parse_decision(raw, suggestion)
        if decision is None:
            decision = self._fallback_decision(suggestion, advice)
        else:
            if used_tools:
                logger.info("她决定前先查看了：%s", "、".join(used_tools))
            decision = await self._reconsider_if_looping(decision, prompt, system, suggestion)

        self._note_intention(decision)
        # 把 LLM 给的"有序几步"装进计划队列：循环里会直接按顺序执行，
        # 中间不再问模型 —— 这是"连续行动"的关键。
        self._set_plan(self._pending_plan, source="llm" if self._pending_plan else "empty")
        self._pending_plan = []
        self._last_decide_at = time.time()
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

    def mark_todo_done(self, index_or_text: str) -> str:
        """划掉清单里的一项。"""
        key = str(index_or_text or "").strip()
        for i, t in enumerate(self._todos):
            if str(i + 1) == key or key and key in t["text"]:
                t["done"] = True
                self._save_state()
                return f"已划掉第 {i + 1} 项：{t['text']}"
        return f"清单里没找到「{key}」"

    def render_todos(self) -> str:
        """把清单渲染进提示词。"""
        if not self._todos:
            return ""
        lines = [f"{'✔' if t['done'] else '□'} {t['text']}" for t in self._todos]
        return "【你给自己列的任务清单】\n" + "\n".join(lines)

    @property
    def todos(self) -> list:
        return list(self._todos)

    # ------------------------------------------------------------ 用工具直接行动（ReAct）

    async def _act_via_agent(self) -> bool:
        """让 LLM 带完整工具集自己动手做一轮。

        @return True = 这一轮由 agent 处理了（不论成没成）；
                False = agent 路径不可用，调用方该退回"挑技能"的旧路径。
        """
        agent = self.action_agent
        if agent is None:
            return False

        # **计时**（用户反馈"每次停下来思考的时间太长了"）：
        # 决策前的准备工作（状态简报 / 生存建议 / 知识库检索）**每轮都做**，
        # 而且都是 await —— 但我之前**不知道它们各花多久**，改的时候只能猜。
        # 这里把每一段和"模型本身花了多久"分开打出来，
        # 这样"想得慢"到底慢在哪一段是有数据的，不是感觉。
        import time as _t

        _t0 = _t.perf_counter()
        _marks: list[tuple[str, float]] = []

        def _mark(label: str) -> None:
            _marks.append((label, _t.perf_counter() - _t0))

        suggestion = self.drives.suggest_activity()
        _mark("心情")
        brief = await self._brief()
        _mark("状态简报（引擎 RPC）")
        advice_text = ""
        try:
            advice = await self._build_advice()
            advice_text = self._render_advice(advice) if advice else ""
        except Exception as exc:  # noqa: BLE001
            logger.debug("拼生存建议失败：%s", exc)
        _mark("生存建议")

        recent_text = self._render_recent()
        # **把她自己学到的经验摆到面前**（按当前处境检索，最相关的几条）。
        # 这是"她会学着怎样做更好的"落地点：知识库里的教训会在下一轮出现。
        learned = ""
        if self.knowledge is not None:
            try:
                query = f"{self._intention or ''} {' '.join(self._recent_failures.keys())} {advice_text[:200]}"
                learned = self.knowledge.render_for_prompt(query)
            except Exception as exc:  # noqa: BLE001
                logger.debug("检索知识库失败：%s", exc)
        _mark("知识库检索")

        # **插话注入点**（W4）：主人的话和世界事件在"组装提示词"这一刻注入——
        # 这是我们的安全注入点（agent 每一轮都重新组装提示词，
        # 不会插在 assistant 的 tool_calls 中间）。
        # 对应 numen 的 STEER："一批工具结算后、下次调模型之前"。
        steer_text = self._drain_steer_text()
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

{f'【你的近期经历】{chr(10)}{recent_text}{chr(10)}' if recent_text else ''}
{advice_text}

【你现在的心情】
{suggestion['label']}（强度 {suggestion['level']}）：{suggestion['voice']}

现在开始做你想做的事。需要就先查看，然后**用工具真正动手**，最后说一句话收尾。"""

        system = await self._system_prompt()
        from .action_agent import ACTION_PROMPT

        _mark("拼提示词")
        _t_model = _t.perf_counter()
        summary, used = await agent.act(
            prompt=prompt,
            system=f"{system}\n\n{ACTION_PROMPT}",
        )
        _model_ms = (_t.perf_counter() - _t_model) * 1000
        if summary is None and not used:
            return False  # agent 不可用 → 退回旧路径

        # **把"想得慢"的账算清楚**（用户反馈"每次停下来思考的时间太长了"）：
        # 准备工作 vs 模型本身分开报，而且带上"发了多大的提示词"——
        # 模型往返的耗时主要取决于输入大小，这是我们能控制的。
        _prep_ms = _marks[-1][1] * 1000 if _marks else 0
        _detail = "，".join(f"{k} {v * 1000:.0f}ms" for k, v in _marks)
        # **别在这里重建工具集**：`_toolset()` 每次都重新遍历 func_list 构建一个
        # ToolSet —— 虽然只是微秒级，但**我自己在日志里又调了一次**纯属浪费，
        # 而且写日志不该有副作用。工具数从注册表直接数就行。
        _tool_count = 0
        try:
            mgr = getattr(getattr(self.action_agent, "plugin", None), "context", None)
            mgr = getattr(mgr, "provider_manager", None)
            mgr = getattr(mgr, "llm_tools", None)
            for t in getattr(mgr, "func_list", []) or []:
                if str(getattr(t, "name", "")).startswith("mc_"):
                    _tool_count += 1
        except Exception:  # noqa: BLE001
            pass
        logger.info(
            "决策耗时：准备 %.0fms（%s）+ 模型 %.0fms = 共 %.0fms；"
            "提示词 %d 字符，工具约 %d 个，本轮调了 %d 次工具",
            _prep_ms,
            _detail,
            _model_ms,
            _prep_ms + _model_ms,
            len(prompt) + len(system) + len(ACTION_PROMPT),
            _tool_count,
            len(used),
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

    def _skill_is_known(self, name: str) -> bool:
        """这个技能名在引擎注册表里真的存在吗（B3）。

        **为什么必须校验**：`_set_plan()` / `_parse_decision()` 早期只过滤
        "非空字符串"，于是模型幻觉出来的技能名会被原样当成技能提交。
        代价是**整整一轮模型往返**（几秒到几十秒）＋一条失败记录，
        而失败记录还会把 `_should_back_off()` 的 30 秒退避触发出来——
        她卡在那儿什么都不做，日志里只看到"没有这个技能：xxx"。
        实测的现成例子就是 advisor 曾经建议的 `craft`（当时注册表里没有）。

        **拿不到清单时一律放行（返回 True）**：`_known_skills` 为空说明
        "引擎没起来 / skill.list 失败 / 还没决策过"，此时如果一律判成未知技能，
        她会**彻底不动**——那比偶尔提交一个坏技能严重得多。
        所以这里只在"手里有可信清单"时才拦。
        """
        known = self._known_skills
        if not known:
            return True
        return str(name).strip() in known

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

    def _pop_plan_step(self) -> dict | None:
        """取计划里的下一步（取走即出队）。"""
        if not self._plan:
            return None
        return self._plan.pop(0)

    def _decision_from_step(self, step: dict) -> LifeDecision:
        """把计划里的一步变成一次决定。"""
        why = step.get("why") or ""
        return LifeDecision(
            activity=why or f"按计划做 {step['skill']}",
            drive=None,
            skill=step["skill"],
            params=dict(step.get("params") or {}),
            say=None,
            reason=f"（计划中的一步：{why}）" if why else "（计划中的一步）",
            intention=self._intention or None,
        )

    def clear_plan(self, reason: str = "") -> None:
        """丢掉剩余计划（环境变了、某一步失败、玩家插手等）。"""
        if self._plan:
            logger.info("放弃剩余 %d 步计划（%s）", len(self._plan), reason or "原因未记录")
        self._plan = []

    def on_session_start(self) -> None:
        """每次进游戏时调用：清掉旧计划，让她重新排一份。

        用户要的"每一次进游戏也会生成一个任务"就落在这里——
        进服后第一次决策会产出一份新计划（而不是接着上次的旧计划干）。
        """
        self._plan = []
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

    async def _reconsider_if_looping(
        self,
        decision: LifeDecision,
        prompt: str,
        system: str,
        suggestion: dict,
    ) -> LifeDecision:
        """她挑了一个"最近反复失败"的技能时，**把这件事告诉她，让她重新决定**。

        这里刻意**不替她做决定**——决定权在 LLM。
        早期版本是直接用规则改成顾问的建议，那等于剥夺了它的决策权；
        现在改成"把失败记录摆到它面前，再问一次"，它仍然可以选择坚持
        （比如它认为上次失败是地形问题，这次换了地方就能成）。
        只有在它第二次仍然选同一个、且失败次数已经很多（≥5）时，
        才退回规则兜底——那是为了避免出现实测过的"一小时死循环"。
        """
        skill = decision.skill
        if not skill:
            return decision
        fails = self._failure_counts()
        n = fails.get(skill, 0)
        if n < 3:
            return decision

        logger.info("她想做的「%s」最近失败 %d 次，把这件事告诉她、让她重新考虑", skill, n)
        retry_prompt = (
            f"{prompt}\n\n"
            f"【重要提醒】你刚才选择做「{skill}」，但这个做法最近已经失败 {n} 次了。\n"
            "请重新考虑：是换个做法、先解决它缺的前置条件，还是坚持原来的选择"
            "（如果坚持，请在 reason 里说明这次有什么不同）。\n"
            "仍然只输出那个 JSON。"
        )
        raw2 = None
        if self.perception is not None:
            try:
                raw2, _ = await self.perception.decide(prompt=retry_prompt, system=system)
            except Exception:  # noqa: BLE001
                raw2 = None
        if raw2 is None:
            raw2 = await self._llm(retry_prompt, system)
        second = self._parse_decision(raw2, suggestion)
        if second is None:
            return decision
        if second.skill != skill:
            logger.info("她改了主意：%s → %s", skill, second.skill)
            return second
        # 她坚持原选择：尊重她的决定（但失败太多时兜底，避免死循环）
        if n >= 5 and self._last_advice and self._last_advice.skill and self._last_advice.skill != skill:
            # **顾问的建议也要过技能名白名单**（B3 的补口）。
            #
            # 这条路径绕过了 _set_plan / _parse_decision，是当初 `craft`
            # 被原样提交出去的真实入口之一。顾问是人写的常量表，
            # 将来照样可能写错一个名字——写错了就会白烧一轮模型往返、
            # 记一笔失败、再触发 30 秒退避。所以这里同样校验一次。
            if not self._skill_is_known(self._last_advice.skill):
                logger.warning(
                    "生存顾问建议的「%s」不在引擎注册表里，放弃这次兜底（改为不动手）",
                    self._last_advice.skill,
                )
                return LifeDecision(
                    activity=decision.activity,
                    drive=decision.drive,
                    skill=None,
                    params={},
                    say=decision.say,
                    intention=decision.intention,
                    reason=f"（原本坚持 {skill}，兜底建议的技能名不存在，先不动手）",
                )
            logger.warning(
                "「%s」已连续失败 %d 次且她仍坚持，退回生存兜底「%s」以避免死循环",
                skill,
                n,
                self._last_advice.skill,
            )
            return LifeDecision(
                activity=f"换个做法：{self._last_advice.why or self._last_advice.skill}",
                drive=decision.drive,
                skill=self._last_advice.skill,
                params=dict(self._last_advice.params or {}),
                say=decision.say,
                intention=decision.intention,
                reason=f"（原本坚持 {skill}，但它已失败 {n} 次）",
            )
        logger.info("她坚持原来的选择「%s」（失败 %d 次）：%s", skill, n, (second.reason or "")[:60])
        return second

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
            logger.debug("过日子的决定解析失败：%s", text[:150])
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

    def _fallback_decision(self, suggestion: dict, advice=None) -> LifeDecision:
        """LLM 不可用时的兜底：**按生存阶段**选一个真实有效的技能。

        早期这里是写死的"驱动 → 技能"映射（explore→move.to 之类），
        问题有两个：一是用了 move.to 这种底层命令（skill.run 根本不认），
        二是完全不看状态——她有 40 个圆石时还去砍树。
        现在交给生存顾问：它知道"缺什么、下一步该做什么"。
        """
        drive = suggestion.get("drive")
        if advice is not None and advice.skill:
            # **顾问的建议同样要过白名单**（B3 的补口）。
            #
            # `advice.skill` 是 advisor.py 里的字面量，而这个函数会把它
            # **直接当技能名返回**——这正是当初 `craft`（当时注册表里没有）
            # 被提交给 skill.run 的真实路径：白烧一轮模型往返、
            # 记一笔失败、触发 30 秒失败退避，而日志里只有一句
            # "没有这个技能：craft"。
            #
            # 顾问写错了名字时：**丢掉这条建议**，往下走本函数本来就有的
            # "按驱动选一个"兜底（那张表里的技能同样被 check_skill_names 守着）。
            # 这里不选"直接不动手"，是因为这个函数的设计目的就是
            # "LLM 不可用时也要让她有事做"，而按驱动选出来的技能是可信的。
            if not self._skill_is_known(advice.skill):
                logger.warning(
                    "生存顾问建议的「%s」不在引擎注册表里（advisor.py 写错了？），"
                    "丢掉这条建议，退回按驱动选择",
                    advice.skill,
                )
            else:
                return LifeDecision(
                    activity=suggestion.get("activity") or advice.why or "做点该做的事",
                    drive=drive,
                    skill=advice.skill,
                    params=dict(advice.params or {}),
                    say=None,
                    reason=f"（按生存阶段决定的：{advice.stage_label or advice.stage}）",
                )
        # 顾问也没建议（比如已定居且什么都不缺）→ 按驱动做点轻松的事
        by_drive = {
            "explore": ("chop_tree", {"count": 4}),
            "build": ("build_shelter", {"size": 3}),
            "gather": ("mine_stone", {"count": 16}),
            "leisure": (None, {}),
            "social": (None, {}),
        }
        skill, params = by_drive.get(drive, (None, {}))
        return LifeDecision(
            activity=suggestion.get("activity") or "去砍点木头，准备点物资",
            drive=drive,
            skill=skill,
            params=params,
            say=None,
            reason="（按当前最想做的事决定的）",
        )

    # ------------------------------------------------------------ 执行

    async def _act(self, decision: LifeDecision) -> None:
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
                logger.debug("on_activity 回调异常：%s", exc)

        # 说点什么（受冷却限制，避免刷屏）
        if decision.say:
            await self._maybe_share(decision.say)

        # 真的去做
        if decision.skill:
            try:
                if str(decision.skill).startswith("move."):
                    await self._call(decision.skill, decision.params or {})
                else:
                    await self._call("skill.run", {"skill": decision.skill, "params": decision.params or {}})
                # **不要在这里压一个长等待**。
                # 早期这里是 `+120` 秒，配合循环里的 90 秒 sleep，
                # 实测决策间隔变成 190~200 秒——技能 10 秒做完她也要干站三分半。
                # 真正该用的信号是"引擎里还有没有任务在跑"（_engine_busy），
                # 所以这里只留一个很短的宽限期，避免刚提交就立刻改主意。
                self._busy_until = time.time() + 8
            except Exception as exc:  # noqa: BLE001
                logger.warning("她想做的技能 %s 没能开始（检查是否在线）：%s", decision.skill, exc)
                self._busy_until = time.time() + 20
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
            logger.debug("分享失败：%s", exc)

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

    def _save_state(self) -> None:
        if not self._data_dir:
            return
        try:
            self._data_dir.mkdir(parents=True, exist_ok=True)
            payload = {
                "version": 1,
                "saved_at": time.time(),
                "current": self.current.to_json() if self.current else None,
                "history": [d.to_json() for d in self.history[-20:]],
                # 把"打算"存下来：重启插件后她仍然记得自己要做什么，
                # 这才是"过日子"该有的连续性（而不是重启就失忆）。
                "intention": self._intention,
                "intention_rounds": self._intention_rounds,
                "intention_since": self._intention_since,
                "has_shelter": self._has_shelter,
                # LLM 自己写的任务清单也要存：重启后她接着自己的清单干
                "todos": self._todos,
            }
            (self._data_dir / "life.json").write_text(
                json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("保存生活状态失败：%s", exc)

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
            logger.debug("读取生活状态失败：%s", exc)
            return
        if not isinstance(data, dict):
            return
        intention = str(data.get("intention") or "").strip()
        if intention:
            self._intention = intention
            self._intention_rounds = int(data.get("intention_rounds") or 0)
            self._intention_since = float(data.get("intention_since") or 0.0)
            logger.info("她记得自己的打算：%s（已做 %d 轮）", intention, self._intention_rounds)
        self._has_shelter = bool(data.get("has_shelter", False))
        todos = data.get("todos")
        if isinstance(todos, list):
            self._todos = [
                {"text": str(t.get("text") or ""), "done": bool(t.get("done"))}
                for t in todos
                if isinstance(t, dict) and str(t.get("text") or "").strip()
            ][:12]
            if self._todos:
                logger.info("她记得自己的任务清单：%d 项", len(self._todos))

    def failure_summary(self) -> str:
        """最近反复失败的技能（诊断视图用）。

        "她在什么事上一直摔跟头"是排查的关键线索——比"她刚才做了什么"更重要，
        因为反复失败通常意味着某个前置条件一直没满足。
        """
        if not self._recent_failures:
            return ""
        now = time.time()
        parts = []
        for name, times in self._recent_failures.items():
            recent = [t for t in times if now - t <= self._failure_window]
            if recent:
                parts.append((len(recent), name))
        if not parts:
            return ""
        parts.sort(reverse=True)
        return "【最近失败的】" + "、".join(f"{name}×{n}" for n, name in parts[:6])

    def describe(self) -> str:
        lines = []
        if self._paused:
            lines.append("（自主行动已暂停——你正在指派任务）")
        elif not self.running:
            lines.append("（过日子循环未运行）")
        else:
            # **"没事做"和"停牌"要分开说**（W7）。
            # 停牌有停牌的说法（见 main.py 的【能动吗】那一行）；
            # 这里说的是"她能跑，但确实没活"——这一种以前是完全不可见的。
            idle = self.idle_explain()
            if idle:
                lines.append(f"（{idle}）")
            else:
                # **不再说"每 N 秒想一次"**：W7 之后没有那个固定间隔了，
                # 没任务就立刻接着做。写着一个不存在的间隔只会误导排查。
                plan = f"，计划里还剩 {len(self._plan)} 步" if self._plan else ""
                lines.append(f"（有事就立刻做，没有固定间隔{plan}）")

        if self.current:
            ago = int(time.time() - self.current.at)
            lines.append(f"刚才决定：{self.current.activity}（{ago} 秒前）")
            if self.current.reason:
                lines.append(f"  理由：{self.current.reason}")
        if self.history:
            lines.append("最近做过：")
            for d in self.history[-5:][::-1]:
                when = time.strftime("%H:%M", time.localtime(d.at))
                lines.append(f"  {when}  {d.activity}")
        return "\n".join(lines)
