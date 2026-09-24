"""**`LifeLoop` 的只读渲染/查询方法**（从 `life.py` 搬出来的）。

## 为什么单独一个文件

`life.py` 原本 2129 行、65 个方法 —— 找东西要搜半天。
但**不能随便拆**：最大的几个方法（`decide` 256 行 / `_loop` 251 行 /
`_act_via_agent` 140 行）**都改状态**，和 `self` 绑得太紧。

所以这里只搬**不改状态**的那一类：**读状态、产出文字或判断**。
它们靠 mixin 注入 —— `class LifeLoop(PromptRenderMixin)` ——
所以**调用点一行都没改**，`self` 还是那个 `LifeLoop` 实例。

## 判据（往这里加方法前先看）

**可以搬**：方法体里没有 `self.xxx = ...` 赋值。
**不要搬**：会改状态的。那需要连状态一起搬，是真正的重构。

搬法是 `dev-tools/extract_life_mixin.py`（判据也写在那里面）。

## 这一批搬了什么

- `_drain_steer_text`
- `_take_follow_up_text`
- `note_owner_said`
- `note_world_event`
- `inbox_summary`
- `state_note`
- `idle_explain`
- `_schedule_lesson`
- `_death_recovery_todos`
- `_render_progress_since`
- `_render_recent`
- `_failure_counts`
- `_gather_state`
- `_auto_resume_if_expired`
- `current_hold`
- `hold_explain`
- `running`
- `paused`
- `_engine_busy`
- `mark_todo_done`
- `render_todos`
- `todos`
- `_skill_is_known`
- `_pop_plan_step`
- `_decision_from_step`
- `_reconsider_if_looping`
- `_fallback_decision`
- `_save_state`
- `failure_summary`
- `describe`
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from enum import Enum
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable
from astrbot.api import logger
import time as _t

from .inbox import Inbox
from .life_types import HOLD_RELEASE, HOLD_WHY, Hold, LifeDecision


class PromptRenderMixin:
    """只读的渲染/查询方法。靠 mixin 注入 `LifeLoop`，所以调用点不用改。"""

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
            logger.info("取插话失败：%s", exc)
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
            logger.info("取接续失败：%s", exc)
            return ""
        if not taken:
            return ""
        return "\n".join(Inbox.render(taken))

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

    def state_note(self, text: str) -> None:
        """往状态简报里写一句（给 LLM 和 /mc状态 看）。"""
        try:
            self._on_activity(text)
        except Exception as exc:  # noqa: BLE001
            logger.info("写状态简报失败：%s", exc)

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
                logger.info("提炼教训失败：%s", exc)
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
            logger.info("取状态失败（顾问将用默认值）：%s", exc)
        return out

    def _auto_resume_if_expired(self) -> None:
        """暂停超期就自动恢复，避免"一次失败导致永久停滞"。"""
        if self._paused and self._pause_until and time.time() >= self._pause_until:
            logger.warning(
                "过日子循环的暂停已超过期限（原因：%s），自动恢复自主行动",
                self._pause_reason or "未记录",
            )
            self.resume()

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

    @property
    def running(self) -> bool:
        return bool(self._task and not self._task.done() and not self._stopped)

    @property
    def paused(self) -> bool:
        return self._paused

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
            logger.info("保存生活状态失败：%s", exc)

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
