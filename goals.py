"""目标系统：把"长期目标"翻译成技能链，并驱动执行与重规划。

为什么需要这一层（而不是让 LLM 直接一步步调工具）：
- LLM 逐格决策会又慢又贵，而且会在"我走到哪了"这种小事上迷路
- 生存任务有确定的顺序（先有木头才能有工作台，先有工作台才能有石镐），
  这部分知识应该固化在代码里，而不是每轮都靠模型推理
- 失败必须能重规划：挖不到铁是"换个方向继续找"，而不是"报错结束"

分层：
  目标文本 → GoalPlan（技能步骤 + 前置条件 + 重试策略）→ 交给引擎执行 → 结果回填 → 决定重试/继续/放弃
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

from astrbot.api import logger

from .perception import format_skill_result

# 目标状态
GOAL_IDLE = "idle"
GOAL_RUNNING = "running"
GOAL_PAUSED = "paused"
GOAL_DONE = "done"
GOAL_FAILED = "failed"
GOAL_ABANDONED = "abandoned"


@dataclass
class GoalStep:
    """目标链中的一步。"""

    skill: str
    params: dict = field(default_factory=dict)
    # 这一步完成后的"成功判据"：可选，用于判断是否真的达成（而不是技能自报成功）
    verify: Callable[[dict], bool] | None = None
    # 允许的最大尝试次数（包含首次）
    max_attempts: int = 2
    # 步骤描述（给人和 LLM 看）
    label: str = ""
    # 失败是否致命：False 表示失败也继续下一步（例如"顺便做点火把"）
    required: bool = True

    def describe(self) -> str:
        return self.label or f"{self.skill}({self.params})"


@dataclass
class GoalPlan:
    """一个长期目标的完整执行计划。"""

    goal: str
    steps: list[GoalStep]
    source: str = "template"  # template | llm | manual
    created_at: float = field(default_factory=time.time)

    def describe(self) -> str:
        return " → ".join(s.describe() for s in self.steps)


# ---------------------------------------------------------------- 目标模板

def _template_chop(count: int) -> GoalPlan:
    return GoalPlan(
        goal=f"砍 {count} 根木头",
        steps=[GoalStep("chop_tree", {"count": count}, label=f"砍树 ×{count}")],
    )


def _template_tools(tier: str) -> GoalPlan:
    return GoalPlan(
        goal=f"做一套{tier}级工具",
        steps=[GoalStep("make_tools", {"tier": tier}, label=f"合成{tier}工具")],
    )


def _template_mine(ore: str, count: int) -> GoalPlan:
    return GoalPlan(
        goal=f"挖 {count} 个{ore}",
        steps=[GoalStep("mine_ores", {"ore": ore, "count": count}, label=f"挖{ore} ×{count}", max_attempts=3)],
    )


def _template_shelter() -> GoalPlan:
    return GoalPlan(
        goal="盖一个能过夜的庇护所",
        steps=[
            GoalStep("mine_stone", {"count": 40}, label="备建材（挖石头）", max_attempts=2),
            GoalStep("build_shelter", {"size": 3, "roof": True, "door": True, "torch": True}, label="建造庇护所", max_attempts=2),
        ],
    )


def _template_survive() -> GoalPlan:
    """生存自给自足：这是"像玩家一样游玩"的完整闭环，也最适合作为默认长期目标。"""
    return GoalPlan(
        goal="自给自足地生存下去",
        steps=[
            GoalStep("chop_tree", {"count": 8}, label="砍树取木头"),
            GoalStep("make_tools", {"tier": "stone"}, label="升级到石制工具", max_attempts=2),
            GoalStep("mine_ores", {"ore": "iron", "count": 6}, label="挖铁矿", max_attempts=3, required=False),
            GoalStep("smelt", {}, label="熔炼矿物", max_attempts=2, required=False),
            GoalStep("cook_food", {"count": 4}, label="准备食物", max_attempts=2, required=False),
            GoalStep("mine_stone", {"count": 40}, label="备建材", max_attempts=2),
            GoalStep("build_shelter", {"size": 3}, label="建造庇护所", max_attempts=2),
            GoalStep("store_items", {}, label="把物资存起来", max_attempts=1, required=False),
        ],
    )


# 中文/英文目标文本 → 计划的匹配规则。
# 顺序有意义：越具体的规则放越前面。
_PATTERNS: list[tuple[re.Pattern, Callable[[re.Match], GoalPlan]]] = [
    (re.compile(r"(?:砍|弄|搞|收集|要)\s*(\d+)?\s*(?:个|根|块)?\s*(?:木头|原木|木材|木|wood|log)", re.I),
     lambda m: _template_chop(int(m.group(1)) if m.group(1) else 8)),
    (re.compile(r"(?:做|要|来|升级到|弄)\s*(木|石|铁|钻石)?\s*(?:制)?\s*(?:工具|镐|工具组)", re.I),
     lambda m: _template_tools({"木": "wooden", "石": "stone", "铁": "iron", "钻石": "diamond"}.get(m.group(1) or "", "stone"))),
    (re.compile(r"(?:挖|采|弄)\s*(\d+)?\s*(?:个|块)?\s*(煤矿|铁矿|金矿|钻石|红石|青金石|绿宝石|煤|铁|金|石头|圆石|ore|iron|diamond|coal|stone)", re.I),
     lambda m: _template_mine(_ore_key(m.group(2)), int(m.group(1)) if m.group(1) else 8)),
    (re.compile(r"(?:盖|建|造|搭)\s*(?:一个|个|座)?\s*(?:房子|屋子|庇护所|小屋|家|shelter|house)", re.I),
     lambda m: _template_shelter()),
    (re.compile(r"(?:生存|活下去|自己活|自给自足|随便玩玩|自由活动|自己玩)", re.I),
     lambda m: _template_survive()),
    (re.compile(r"(?:食物|吃的|吃饭|肉|food)", re.I), lambda m: GoalPlan(goal="准备食物", steps=[GoalStep("cook_food", {"count": 4}, label="准备食物")])),
    (re.compile(r"(?:存东西|整理背包|收好|装箱|store)", re.I), lambda m: GoalPlan(goal="整理物资", steps=[GoalStep("store_items", {}, label="存东西")])),
]

_ORE_MAP = {
    "煤矿": "coal", "煤": "coal", "coal": "coal",
    "铁矿": "iron", "铁": "iron", "iron": "iron",
    "金矿": "gold", "金": "gold", "gold": "gold",
    "钻石": "diamond", "钻石矿": "diamond", "diamond": "diamond",
    "红石": "redstone", "redstone": "redstone",
    "青金石": "lapis", "lapis": "lapis",
    "绿宝石": "emerald", "emerald": "emerald",
    "石头": "stone", "圆石": "stone", "stone": "stone",
    "石英": "quartz", "下界合金": "ancient_debris",
}


def _ore_key(text: str) -> str:
    t = (text or "").strip().lower()
    if t in _ORE_MAP:
        return _ORE_MAP[t]
    for k, v in _ORE_MAP.items():
        if k in t:
            return v
    return "iron"


def plan_from_text(goal: str) -> GoalPlan | None:
    """用固定模板解析目标文本。解析不出来返回 None（交给 LLM 兜底）。"""
    text = (goal or "").strip()
    if not text:
        return None
    for pattern, builder in _PATTERNS:
        m = pattern.search(text)
        if m:
            plan = builder(m)
            plan.source = "template"
            return plan
    return None


# ---------------------------------------------------------------- 目标管理器


class GoalManager:
    """持有当前长期目标，按步骤驱动执行，失败能重试与降级。"""

    def __init__(
        self,
        *,
        engine_call: Callable[..., Awaitable[Any]],
        on_event: Callable[[str, dict], Awaitable[None] | None] | None = None,
        llm_planner: Callable[[str, str], Awaitable[str | None]] | None = None,
    ):
        self._call = engine_call
        self._on_event = on_event
        self._llm_planner = llm_planner

        self.plan: GoalPlan | None = None
        self.status: str = GOAL_IDLE
        self.step_index: int = 0
        self.attempt: int = 0
        self.log: list[dict] = []
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.last_error: str | None = None
        self.current_task_id: str | None = None
        self._task: asyncio.Task | None = None
        self._pause_event = asyncio.Event()
        self._pause_event.set()
        self._cancel_requested = False

    # ------------------------------------------------------------ 查询

    @property
    def active(self) -> bool:
        return self.status in (GOAL_RUNNING, GOAL_PAUSED)

    def describe(self) -> str:
        if not self.plan:
            return "当前没有长期目标"
        total = len(self.plan.steps)
        done = min(self.step_index, total)
        status_cn = {
            GOAL_IDLE: "未开始",
            GOAL_RUNNING: "进行中",
            GOAL_PAUSED: "已暂停",
            GOAL_DONE: "已完成",
            GOAL_FAILED: "失败",
            GOAL_ABANDONED: "已放弃",
        }.get(self.status, self.status)
        lines = [f"目标：{self.plan.goal}（{status_cn}，进度 {done}/{total}）"]
        if self.status == GOAL_RUNNING and self.step_index < total:
            step = self.plan.steps[self.step_index]
            lines.append(f"当前步骤：{step.describe()}（第 {self.attempt + 1}/{step.max_attempts} 次尝试）")
        if self.last_error:
            lines.append(f"最近问题：{self.last_error}")
        recent = self.log[-4:]
        if recent:
            lines.append("最近结果：")
            for entry in recent:
                mark = "✅" if entry.get("ok") else "❌"
                lines.append(f"  {mark} {entry.get('step')}：{entry.get('summary', '')}")
        return "\n".join(lines)

    def progress_brief(self) -> str | None:
        """给状态简报用的一行进度。"""
        if not self.plan or not self.active:
            return None
        total = len(self.plan.steps)
        if self.step_index < total:
            step = self.plan.steps[self.step_index]
            return f"{self.plan.goal}（{self.step_index + 1}/{total}：{step.describe()}）"
        return f"{self.plan.goal}（{total}/{total}）"

    # ------------------------------------------------------------ 控制

    async def start(self, goal: str | None = None, plan: GoalPlan | None = None) -> str:
        if self.active:
            await self.abandon(reason="被新目标替换")

        if plan is None:
            if goal:
                plan = plan_from_text(goal)
            if plan is None and goal and self._llm_planner:
                plan = await self._plan_with_llm(goal)
            if plan is None:
                raise ValueError(
                    f"没法把「{goal}」拆成可执行的步骤。可以试试更具体的说法，例如："
                    "「砍 10 根木头」「挖 8 个铁矿」「做一套石制工具」「盖一个庇护所」「自己去生存」"
                )

        self.plan = plan
        self.status = GOAL_RUNNING
        self.step_index = 0
        self.attempt = 0
        self.log = []
        self.started_at = time.time()
        self.finished_at = None
        self.last_error = None
        self._cancel_requested = False
        self._pause_event.set()
        self._task = asyncio.create_task(self._run_loop(), name="mc-goal-loop")
        await self._emit("goal.started", {"goal": plan.goal, "steps": [s.describe() for s in plan.steps], "source": plan.source})
        return f"已开始目标「{plan.goal}」，共 {len(plan.steps)} 步：{plan.describe()}"

    async def pause(self) -> str:
        if self.status != GOAL_RUNNING:
            return "当前没有正在进行的目标"
        self.status = GOAL_PAUSED
        self._pause_event.clear()
        # 同时停掉正在执行的动作，避免"暂停了但身体还在走"
        await self._safe_cancel_current()
        await self._emit("goal.paused", {"goal": self.plan.goal if self.plan else None})
        return "目标已暂停（当前动作也已停止）"

    async def resume(self) -> str:
        if self.status != GOAL_PAUSED:
            return "当前没有被暂停的目标"
        self.status = GOAL_RUNNING
        self._pause_event.set()
        await self._emit("goal.resumed", {"goal": self.plan.goal if self.plan else None})
        return "目标已继续"

    async def abandon(self, *, reason: str = "用户放弃") -> str:
        if not self.plan:
            return "当前没有目标"
        self._cancel_requested = True
        self._pause_event.set()
        await self._safe_cancel_current()
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self.status = GOAL_ABANDONED
        self.finished_at = time.time()
        await self._emit("goal.abandoned", {"goal": self.plan.goal, "reason": reason})
        return f"已放弃目标「{self.plan.goal}」（{reason}）"

    async def stop(self) -> None:
        """插件卸载时调用。"""
        self._cancel_requested = True
        self._pause_event.set()
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    # ------------------------------------------------------------ 执行循环

    async def _run_loop(self) -> None:
        assert self.plan is not None
        try:
            while self.step_index < len(self.plan.steps):
                if self._cancel_requested:
                    return
                await self._pause_event.wait()
                if self._cancel_requested:
                    return

                step = self.plan.steps[self.step_index]
                self.attempt += 1
                logger.info("目标步骤 %s/%s：%s（第 %s 次）", self.step_index + 1, len(self.plan.steps), step.describe(), self.attempt)

                result = await self._execute_step(step)
                ok = bool(result.get("ok"))
                summary = _summarize(result)
                self.log.append(
                    {"step": step.describe(), "ok": ok, "summary": summary, "at": time.time(), "attempt": self.attempt}
                )
                await self._emit("goal.step", {"step": step.describe(), "ok": ok, "summary": summary})

                if ok:
                    self.step_index += 1
                    self.attempt = 0
                    continue

                self.last_error = summary
                if self.attempt < step.max_attempts:
                    # 重试前稍等，并让引擎把卡住的状态清掉
                    logger.info("步骤失败，准备第 %s 次重试：%s", self.attempt + 1, summary)
                    await asyncio.sleep(2.0)
                    continue

                self.attempt = 0
                if step.required:
                    self.status = GOAL_FAILED
                    self.finished_at = time.time()
                    await self._emit(
                        "goal.failed",
                        {"goal": self.plan.goal, "step": step.describe(), "reason": summary},
                    )
                    return
                # 非必需步骤失败 → 跳过继续
                logger.info("非必需步骤失败，跳过继续：%s", step.describe())
                self.step_index += 1

            self.status = GOAL_DONE
            self.finished_at = time.time()
            await self._emit("goal.done", {"goal": self.plan.goal, "steps": len(self.plan.steps), "log": self.log[-6:]})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.error("目标执行循环异常：%s", exc)
            self.status = GOAL_FAILED
            self.last_error = str(exc)
            self.finished_at = time.time()
            await self._emit("goal.failed", {"goal": self.plan.goal if self.plan else None, "reason": str(exc)})

    async def _execute_step(self, step: GoalStep) -> dict:
        """提交技能并等它结束（异步等待，不阻塞事件循环）。"""
        try:
            started = await self._call("skill.run", {"skill": step.skill, "params": step.params})
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "reason": f"提交技能失败：{exc}"}

        task_id = (started or {}).get("task_id")
        self.current_task_id = task_id
        if not task_id:
            return {"ok": False, "reason": "引擎没有返回 task_id"}

        # 轮询直到结束。技能可能跑几分钟，所以轮询间隔逐渐拉长。
        interval = 1.5
        waited = 0.0
        while True:
            if self._cancel_requested:
                await self._safe_cancel_current()
                return {"ok": False, "reason": "目标被放弃"}
            await self._pause_event.wait()
            await asyncio.sleep(interval)
            waited += interval
            interval = min(5.0, interval * 1.2)
            try:
                st = await self._call("task.status", {"task_id": task_id})
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "reason": f"查询任务状态失败：{exc}"}

            status = (st or {}).get("status")
            if status in ("done", "failed", "cancelled"):
                self.current_task_id = None
                if status == "done":
                    result = (st or {}).get("result")
                    payload = result if isinstance(result, dict) else {}
                    if step.verify and not step.verify(payload):
                        return {"ok": False, **payload, "reason": payload.get("reason") or "步骤完成但结果不符合预期"}
                    return {"ok": True, **payload}
                if status == "cancelled":
                    return {"ok": False, "reason": (st or {}).get("error") or "动作被取消"}
                return {"ok": False, "reason": (st or {}).get("error") or "动作失败"}

            if waited > 900:  # 单步上限 15 分钟
                await self._safe_cancel_current()
                return {"ok": False, "reason": "单步执行超过 15 分钟，已中止"}

    async def _safe_cancel_current(self) -> None:
        task_id = self.current_task_id
        self.current_task_id = None
        if not task_id:
            return
        try:
            await self._call("task.cancel", {"task_id": task_id})
        except Exception:  # noqa: BLE001
            pass

    # ------------------------------------------------------------ LLM 兜底规划

    async def _plan_with_llm(self, goal: str) -> GoalPlan | None:
        """模板匹配不上时，让 LLM 给出技能序列（只允许调用已注册的技能）。"""
        if not self._llm_planner:
            return None
        try:
            skills_desc = await self._call("skill.list", {})
        except Exception:  # noqa: BLE001
            return None
        catalog = "\n".join((skills_desc or {}).get("skills", []))
        if not catalog:
            return None

        prompt = (
            "你是 Minecraft 机器人的任务规划器。把用户的目标拆成若干技能调用。\n"
            f"可用技能：\n{catalog}\n\n"
            f"用户目标：{goal}\n\n"
            "只输出 JSON 数组，每项形如 {\"skill\":\"技能名\",\"params\":{...},\"label\":\"一句话说明\"}。"
            "不要输出任何解释、不要用 markdown 代码块。最多 6 步。"
        )
        try:
            raw = await self._llm_planner(prompt, "你是一个只输出 JSON 的任务规划器。")
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM 规划失败：%s", exc)
            return None
        if not raw:
            return None

        import json

        text = raw.strip()
        if text.startswith("```"):
            text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
            text = re.sub(r"\n?```$", "", text)
        # 容错：截取第一个 [ 到最后一个 ]
        start, end = text.find("["), text.rfind("]")
        if start >= 0 and end > start:
            text = text[start : end + 1]
        try:
            items = json.loads(text)
        except json.JSONDecodeError:
            logger.warning("LLM 规划的 JSON 无法解析：%s", text[:200])
            return None
        if not isinstance(items, list) or not items:
            return None

        known = set((skills_desc or {}).get("names", []))
        steps: list[GoalStep] = []
        for item in items[:6]:
            if not isinstance(item, dict):
                continue
            skill = str(item.get("skill", "")).strip()
            if skill not in known:
                logger.debug("LLM 规划里出现未知技能，已忽略：%s", skill)
                continue
            params = item.get("params") if isinstance(item.get("params"), dict) else {}
            steps.append(
                GoalStep(
                    skill=skill,
                    params=params,
                    label=str(item.get("label") or skill),
                    max_attempts=2,
                    required=len(steps) == 0,  # 只强制要求第一步，后面失败可跳过
                )
            )
        if not steps:
            return None
        return GoalPlan(goal=goal, steps=steps, source="llm")

    async def _emit(self, event: str, data: dict) -> None:
        if not self._on_event:
            return
        try:
            r = self._on_event(event, data)
            if asyncio.iscoroutine(r):
                await r
        except Exception as exc:  # noqa: BLE001
            logger.error("目标事件回调出错：%s", exc)


def _summarize(result: dict) -> str:
    """把技能结果压成一句话，用于目标日志。"""
    if not result:
        return "无结果"
    if result.get("ok"):
        note = result.get("note")
        if note:
            return str(note)
        produced = {k: v for k, v in (result.get("produced") or {}).items() if v and v > 0}
        if produced:
            return "获得 " + "、".join(f"{k}×{v}" for k, v in list(produced.items())[:6])
        return "完成"
    return str(result.get("reason") or format_skill_result(result))
