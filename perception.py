"""感知层：把引擎的状态快照翻译成给 LLM 看的紧凑中文简报。

这一层是 **token 预算的守门人**。设计原则：
- 简报有硬长度上限，超了就截断，绝不把几十格背包和几十个实体原样塞进上下文
- 事件（掉血、被怪围、任务失败）优先于状态：LLM 更需要对"变化"做反应
- 空闲时克制：没有实质变化就不反复陈述同样的状态
"""

from __future__ import annotations

from typing import Any

# 简报硬上限（字符）。超过就截断——这是防止上下文爆炸的最后一道闸门
BRIEF_MAX_CHARS = 800

DIMENSION_NAMES = {
    "minecraft:overworld": "主世界",
    "minecraft:the_nether": "下界",
    "minecraft:the_end": "末地",
    "overworld": "主世界",
    "the_nether": "下界",
    "the_end": "末地",
}

# 值得主动打断 LLM 的事件（其余事件只在被问到时才提）
ALERT_EVENTS = frozenset(
    {
        "bot.death",
        "bot.kicked",
        "bot.disconnect",
        "entity.threat",
        "task.finished",
        "bot.respawn",
    }
)


def dimension_text(dim: str | None) -> str:
    if not dim:
        return ""
    return DIMENSION_NAMES.get(dim, str(dim))


def time_text(tick: Any) -> str:
    if tick is None:
        return "未知"
    try:
        t = int(tick) % 24000
    except (TypeError, ValueError):
        return "未知"
    if t < 6000:
        return "清晨"
    if t < 12000:
        return "白天"
    if t < 13800:
        return "黄昏"
    if t < 22200:
        return "夜晚"
    return "黎明"


def format_state(snapshot: dict, *, include_full_inventory: bool = False) -> str:
    """把 state.get 的快照整理成多行中文说明。"""
    if not snapshot or not snapshot.get("connected"):
        return "【机器人当前未进入服务器】"

    pos = snapshot.get("position") or {}
    lines: list[str] = []

    head = (
        f"位置 ({pos.get('x')}, {pos.get('y')}, {pos.get('z')}) {dimension_text(snapshot.get('dimension'))} | "
        f"生命 {snapshot.get('health')}/{snapshot.get('max_health')} | 饱食 {snapshot.get('food')}/20"
    )
    lines.append(head)

    held = snapshot.get("held_item")
    if held:
        dur = f"（耐久 {held.get('durability_pct')}%）" if held.get("durability_pct") is not None else ""
        lines.append(f"手持：{held.get('name')}×{held.get('count')}{dur}")

    armor = snapshot.get("armor") or []
    if armor:
        lines.append("护甲：" + "、".join(a.get("name", "?") for a in armor))

    effects = snapshot.get("effects") or []
    if effects:
        lines.append("状态效果：" + "、".join(e.get("name", "?") for e in effects))

    inv = snapshot.get("inventory_summary") or {}
    if inv:
        lines.append(f"背包（{inv.get('used_slots', 0)} 格）：{inv.get('text', '空')}")

    env_bits = []
    if snapshot.get("standing_on"):
        env_bits.append(f"脚下 {snapshot['standing_on']}")
    if snapshot.get("light") is not None:
        env_bits.append(f"光照 {snapshot['light']}")
    env_bits.append(f"时间 {time_text(snapshot.get('time_of_day'))}")
    if snapshot.get("is_raining"):
        env_bits.append("正在下雨")
    if snapshot.get("in_water"):
        env_bits.append("在水中")
    if snapshot.get("in_lava"):
        env_bits.append("在岩浆里")
    lines.append(" | ".join(env_bits))

    entities = snapshot.get("nearby_entities") or []
    if entities:
        parts = []
        for e in entities[:8]:
            cnt = e.get("count", 1)
            label = f"{e.get('name')}×{cnt}" if cnt > 1 else str(e.get("name"))
            mark = "⚠" if e.get("hostile") else ""
            parts.append(f"{mark}{label} {e.get('distance')}格")
        lines.append("附近：" + " | ".join(parts))

    others = [p for p in (snapshot.get("players_online") or [])]
    if others:
        lines.append("在线玩家：" + "、".join(others))

    if include_full_inventory:
        inv_full = snapshot.get("inventory") or []
        if inv_full:
            lines.append(
                "背包明细："
                + "、".join(f"{i.get('name')}×{i.get('count')}" for i in inv_full[:30])
            )
    return "\n".join(lines)


def format_brief(brief_text: str) -> str:
    """引擎已经生成好简报，这里只做长度兜底。"""
    text = (brief_text or "").strip()
    if not text:
        return "【机器人未进服】"
    if len(text) > BRIEF_MAX_CHARS:
        return text[: BRIEF_MAX_CHARS - 12] + "…(已截断)"
    return text


def format_task_status(status: dict) -> str:
    """把任务状态翻译成一句人话。"""
    if not status:
        return "没有正在进行的任务"
    if "current" in status and status.get("current") is None and not status.get("queued"):
        hist = status.get("history") or []
        if hist:
            last = hist[-1]
            return f"当前空闲。上一个动作：{last.get('name')}（{_status_cn(last.get('status'))}）"
        return "当前空闲，没有进行中的动作"

    state = status.get("status")
    name = status.get("name") or "动作"
    if state == "running":
        detail = status.get("progress") or status.get("detail") or ""
        elapsed = (status.get("elapsed_ms") or 0) / 1000
        return f"「{name}」进行中（{elapsed:.0f} 秒）{f'：{detail}' if detail else ''}"
    if state == "pending":
        return f"「{name}」在排队，还没开始"
    if state == "done":
        result = status.get("result") or {}
        note = result.get("note") if isinstance(result, dict) else None
        return f"「{name}」已完成{f'：{note}' if note else ''}"
    if state == "failed":
        return f"「{name}」失败：{status.get('error')}"
    if state == "cancelled":
        return f"「{name}」已取消"
    return f"「{name}」状态：{state}"


def _status_cn(status: str | None) -> str:
    return {
        "done": "已完成",
        "failed": "失败",
        "cancelled": "已取消",
        "running": "进行中",
        "pending": "排队中",
    }.get(status or "", status or "未知")


def format_skill_result(result: dict) -> str:
    """技能返回值的可读化。这段文字会直接被 LLM 读到，所以要给出"做成了什么、为什么没做成"。"""
    if not result:
        return "技能没有返回结果"
    if isinstance(result, str):
        return result

    ok = result.get("ok")
    note = result.get("note") or ""
    reason = result.get("reason") or ""
    produced = result.get("produced") or {}
    steps = result.get("steps") or []

    head = "✅ " if ok else "❌ "
    lines = [head + (note or ("完成" if ok else "没做成"))]
    if produced:
        pos = {k: v for k, v in produced.items() if v and v > 0}
        if pos:
            lines.append("获得：" + "、".join(f"{k}×{v}" for k, v in list(pos.items())[:12]))
        used = {k: v for k, v in produced.items() if v and v < 0}
        if used:
            lines.append("消耗：" + "、".join(f"{k}×{-v}" for k, v in list(used.items())[:12]))
    if not ok and reason:
        lines.append(f"原因：{reason}")
    if steps:
        tail = steps[-6:]
        lines.append("过程：" + " → ".join(str(s) for s in tail))
    text = "\n".join(lines)
    if len(text) > 900:
        text = text[:880] + "…"
    return text


def format_event(event: str, data: dict) -> str | None:
    """把引擎事件翻译成一句适合插进上下文的提示。返回 None 表示不值得上报。"""
    data = data or {}
    if event == "bot.spawn":
        return f"【事件】机器人已进入服务器（{data.get('username')}，版本 {data.get('version')}）"
    if event == "bot.death":
        pos = data.get("position") or {}
        return f"【事件】机器人死了，位置 ({pos.get('x')}, {pos.get('y')}, {pos.get('z')})，会自动重生"
    if event == "bot.respawn":
        return "【事件】机器人已重生"
    if event == "bot.hurt":
        return f"【事件】机器人受伤，当前生命 {data.get('health')}"
    if event == "entity.threat":
        return f"【事件】危险实体靠近：{data.get('name')} 距 {data.get('distance')} 格（附近同类 {data.get('count')} 个）"
    if event == "bot.kicked":
        return f"【事件】被服务器踢出：{data.get('reason')}"
    if event == "bot.disconnect":
        reason = data.get("reason") or ""
        manual = "（主动断开）" if data.get("manual") else ""
        return f"【事件】与服务器断开连接{manual}：{reason}"
    if event == "bot.reconnecting":
        return f"【事件】正在尝试第 {data.get('attempt')}/{data.get('max')} 次重连（{int((data.get('wait_ms') or 0) / 1000)} 秒后）"
    if event == "task.finished":
        status = data.get("status")
        name = data.get("name")
        if status == "done":
            return f"【事件】动作完成：{name}"
        if status == "failed":
            return f"【事件】动作失败：{name} —— {data.get('error')}"
        if status == "cancelled":
            return f"【事件】动作被取消：{name}"
        return None
    if event == "bot.inventory":
        summary = data.get("summary") or {}
        return f"【事件】背包变化：{summary.get('text', '')}"
    if event == "bot.health":
        delta = data.get("delta")
        if delta and delta < 0:
            return f"【事件】掉血 {abs(delta)}，当前生命 {data.get('health')}"
        return None
    if event == "bot.moved":
        to = data.get("to") or {}
        return f"【事件】移动了 {data.get('distance')} 格，到达 ({to.get('x')}, {to.get('y')}, {to.get('z')})"
    return None


def build_context_for_llm(
    *,
    brief: str,
    goal: str | None = None,
    events: list[str] | None = None,
    extra: str | None = None,
) -> str:
    """把简报 + 事件 + 目标拼成注入给 LLM 的一段上下文。"""
    parts: list[str] = []
    if goal:
        parts.append(f"当前长期目标：{goal}")
    parts.append("当前状态：\n" + brief)
    if events:
        parts.append("最近发生：\n" + "\n".join(f"- {e}" for e in events[-5:]))
    if extra:
        parts.append(extra)
    return "\n\n".join(parts)
