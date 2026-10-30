"""Bounded runtime measurements and explanations, without extra engine reads."""
from __future__ import annotations

from collections import deque
import math
import time


def distribution(values):
    ordered = sorted(values)
    if not ordered:
        return {"samples": 0, "last": None, "p95": None}
    return {"samples": len(ordered), "last": round(values[-1], 1),
            "p95": round(ordered[max(0, math.ceil(len(ordered) * .95) - 1)], 1)}


class RuntimeMetrics:
    def __init__(self):
        self.observations = deque(maxlen=100)
        self.handoffs = deque(maxlen=100)
        self.shared_reads = self.discarded_reads = 0
        self._finished_at = None
        self._seen = deque(maxlen=200)

    def reset_handoff(self):
        self._finished_at = None

    def task_event(self, event, data, *, continuing, now=None):
        if event not in ("task.started", "task.finished", "task.failed", "task.cancelled"):
            return
        if data.get("kind") == "reflex":
            return
        if data.get("kind") != "skill":
            self.reset_handoff()
            return
        identity = data.get("task_id") or data.get("id")
        if not identity:
            return
        key = (event, identity)
        if key in self._seen:
            return
        self._seen.append(key)
        now = time.monotonic() if now is None else now
        if event == "task.started":
            if continuing and self._finished_at is not None and now >= self._finished_at:
                self.handoffs.append((now - self._finished_at) * 1000)
            self._finished_at = None
        else:
            result = data.get("result")
            succeeded = data.get("status") == "done" and not (isinstance(result, dict) and result.get("ok") is False)
            self._finished_at = now if continuing and succeeded else None

    def snapshot(self):
        return {"observation_ms": distribution(self.observations), "handoff_ms": distribution(self.handoffs),
                "shared_reads": self.shared_reads, "discarded_reads": self.discarded_reads}


def waiting_status(life, *, emergency=False, now=None):
    """Expose existing control/cooldown facts; never invent a retry deadline."""
    now = time.time() if now is None else now
    if emergency:
        return {"kind": "emergency", "reason": "已急停全部动作", "retry_at": None,
                "release_when": "确认安全后由主人继续游玩", "attempts": None}
    hold = life.current_hold()
    retry_at, attempts = None, None
    kind, reason = hold.value, life.hold_explain()
    # Keep the WebUI adapter usable without importing the AstrBot runtime.
    release = {"none": "按当前状态继续计划", "dead": "恢复生命（收到进服或重生通知）",
               "world_changing": "当前维度加载完成", "disconnected": "重新进服",
               "engine_down": "引擎进程起来"}.get(kind, "按当前状态继续计划")
    if kind == "paused_by_owner":
        deadline = getattr(life, "_pause_until", 0)
        if isinstance(deadline, (float, int)) and deadline > now:
            retry_at = deadline
        release = "主人继续游玩" if retry_at is None else "暂停期限到达或主人继续游玩"
    elif kind == "blocked":
        deadline = getattr(life, "_decision_retry_at", 0)
        retry_at = deadline if deadline > now else None
        attempts = getattr(life, "_decide_timeouts", 0)
        release = "模型探测成功；已排好的安全补给仍可继续"
    elif kind == "none":
        supply_reason = getattr(life, "_rule_supply_wait_reason", "")
        deadline = getattr(life, "_decision_retry_at", 0)
        if supply_reason:
            kind, reason = "supply", supply_reason
            release = "下一轮重新核验身体、物资和环境，条件满足后继续"
        elif deadline > now:
            kind, reason = "decision_retry", "决策暂未成功，等待下次探测"
            retry_at, attempts = deadline, getattr(life, "_decide_timeouts", 0)
            release = "到达重试时间后按最新状态重新决策"
        plan = getattr(life, "_plan", [])
        if not supply_reason and plan:
            skill = plan[0].get("skill")
            cooldown = getattr(life, "_failure_cooldowns", {}).get(skill, 0)
            if cooldown > now:
                kind, reason, retry_at = "skill_cooldown", f"{skill} 正在失败冷却", cooldown
                release = "冷却结束或观察到新的有效资源后重新安排"
    return {"kind": kind, "reason": reason, "retry_at": retry_at, "release_when": release, "attempts": attempts}
