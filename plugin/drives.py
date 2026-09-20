"""驱动力系统：让她"自己找事做"，而不是等指令。

设计思路（和"任务执行器"的根本区别）：
- 工人：目标由外部下发，做完就停
- 真人：有几个持续的内在动机，此消彼长，最强的那个决定"现在想干嘛"

所以这里不做"目标队列"，而是维护几个**欲望水位**：
长时间不做某类事，对应的欲望就涨；做了就回落。任何时刻都有"最想做的那件事"。

关键取舍：**决策权仍然给 LLM，驱动只负责"影响心情 + 给建议"**。
理由是写死的规则不可能覆盖 MC 的开放玩法，但纯 LLM 又会飘（今天挖矿明天就忘了自己是谁）。
驱动提供稳定的倾向，LLM 负责具体怎么做——两者结合才有"像人的连续感"。
"""

from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass, field
from pathlib import Path

from astrbot.api import logger


@dataclass
class Drive:
    """一个内在动机。"""

    key: str
    label: str
    # 每小时自然增长多少（越大越"容易想"）
    rise_per_hour: float = 0.25
    # 做完一次掉多少
    drop_on_satisfy: float = 0.6
    # 对应她可以做的事（给 LLM 的建议候选）
    activities: list[str] = field(default_factory=list)
    # 这个动机下她说出来会是什么语气
    voice: str = ""

    level: float = 0.0  # 0..1，越高越想做
    last_satisfied: float = 0.0


# 五个动机。activities 里写的是**技能名或自然语言**，插件会拼成给 LLM 的候选。
DEFAULT_DRIVES = [
    Drive(
        key="explore",
        label="探索欲",
        rise_per_hour=0.30,
        drop_on_satisfy=0.7,
        activities=[
            "往一个没去过的方向走一段，看看有什么",
            "爬上高处眺望四周",
            "找个没去过的生物群系",
        ],
        voice="好奇、想看看外面",
    ),
    Drive(
        key="build",
        label="建造欲",
        rise_per_hour=0.20,
        drop_on_satisfy=0.8,
        activities=[
            "盖个小房子或者扩一下现在的住处",
            "把住处修整得更像样一点（铺地板、加窗户、插火把）",
            "搭个箱子区把东西整理好",
        ],
        voice="想留下点自己的东西",
    ),
    Drive(
        key="gather",
        label="收集欲",
        rise_per_hour=0.28,
        drop_on_satisfy=0.6,
        activities=[
            "去挖点矿，攒些铁",
            "砍点木头备着",
            "收集食物存在箱子里",
        ],
        voice="想攒点家底，心里踏实",
    ),
    Drive(
        key="social",
        label="社交欲",
        rise_per_hour=0.35,
        drop_on_satisfy=0.9,
        activities=[
            "去别的玩家身边待着，看看他们在干嘛",
            "在公共频道里搭句话",
            "跟着某个人一起行动",
        ],
        voice="想找人说话、凑热闹",
    ),
    Drive(
        key="leisure",
        label="悠闲欲",
        rise_per_hour=0.18,
        drop_on_satisfy=0.5,
        activities=[
            "随便逛逛，看看风景",
            "坐在高处发呆一会儿",
            "看看日落/日出，或者听听雨",
        ],
        voice="想歇会儿，不想干活",
    ),
]

# 人格倾向 → 动机偏置。
# 这里刻意保持"通用词表"而不是写死具体人格名：
# 任何人格只要描述里出现这些词，就会自然地偏向对应的动机。
# 比如人格写着"懒散"，她就更容易发呆；写着"好奇"，她就更爱乱跑。
TRAIT_BIAS = {
    "explore": ["好奇", "冒险", "探索", "自由", "野", "活泼", "精力", "好动", "旅行", "游荡"],
    "build": ["认真", "细心", "整理", "完美", "匠", "专注", "踏実", "踏实", "规划", "手艺"],
    "gather": ["勤俭", "务实", "收集", "囤", "精明", "谨慎", "计划", "算", "省"],
    "social": ["温柔", "热情", "话多", "粘人", "关心", "开朗", "喜欢人", "健谈", "撒娇", "八卦"],
    "leisure": ["懒", "悠", "慢", "随性", "佛", "安静", "沉默", "冷淡", "厌世", "躺"],
}


class DriveSystem:
    """维护各动机的水位，并给出"现在最想做什么"。"""

    def __init__(self, data_dir: Path, *, drives: list[Drive] | None = None, tick_seconds: float = 300.0):
        self._dir = Path(data_dir)
        self._path = self._dir / "drives.json"
        self._drives = {d.key: d for d in (drives or DEFAULT_DRIVES)}
        self._bias: dict[str, float] = {}
        self._tick_seconds = tick_seconds
        self._last_tick = time.time()
        self._last_activity: dict | None = None
        self._load()

    # ------------------------------------------------------------ 持久化

    def _load(self) -> None:
        try:
            if not self._path.exists():
                return
            data = json.loads(self._path.read_text(encoding="utf-8"))
            for key, val in (data.get("drives") or {}).items():
                if key in self._drives:
                    self._drives[key].level = float(val.get("level", 0))
                    self._drives[key].last_satisfied = float(val.get("last_satisfied", 0))
            self._last_tick = float(data.get("last_tick", time.time()))
            self._last_activity = data.get("last_activity") or None
        except Exception as exc:  # noqa: BLE001
            logger.warning("载入驱动状态失败（从零开始）：%s", exc)

    def save(self) -> None:
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            payload = {
                "version": 1,
                "last_tick": self._last_tick,
                "last_activity": self._last_activity,
                "drives": {
                    k: {"level": round(d.level, 3), "last_satisfied": d.last_satisfied}
                    for k, d in self._drives.items()
                },
            }
            self._path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            logger.warning("保存驱动状态失败：%s", exc)

    # ------------------------------------------------------------ 人格偏置

    def apply_personality(self, persona_prompt: str) -> None:
        """根据人格描述调整各动机的敏感度。

        不是"人格决定她做什么"，而是"人格让她更容易想起哪类事"。
        """
        text = str(persona_prompt or "")
        bias: dict[str, float] = {}
        for key, words in TRAIT_BIAS.items():
            hits = sum(1 for w in words if w in text)
            # 命中越多偏置越强，但封顶 1.8 倍，避免人格描述一句话就彻底定型
            bias[key] = min(1.8, 1.0 + hits * 0.2)
        self._bias = bias
        if any(v > 1.0 for v in bias.values()):
            top = sorted(bias.items(), key=lambda x: x[1], reverse=True)[:2]
            logger.info(
                "根据人格调整了动机倾向：%s",
                "、".join(f"{self._drives[k].label}×{v:.1f}" for k, v in top if k in self._drives),
            )

    # ------------------------------------------------------------ 水位推进

    def tick(self, *, now: float | None = None) -> None:
        """按经过的时间抬高各动机水位。"""
        now = now or time.time()
        elapsed_h = max(0.0, (now - self._last_tick) / 3600.0)
        self._last_tick = now
        if elapsed_h <= 0:
            return
        for key, d in self._drives.items():
            mult = self._bias.get(key, 1.0)
            d.level = min(1.0, d.level + d.rise_per_hour * mult * elapsed_h)

    def satisfy(self, key: str, *, now: float | None = None) -> None:
        """她做了某类事 → 对应欲望回落。"""
        d = self._drives.get(key)
        if not d:
            return
        now = now or time.time()
        d.level = max(0.0, d.level - d.drop_on_satisfy)
        d.last_satisfied = now
        self.save()

    # ------------------------------------------------------------ 决策

    def top_drive(self) -> Drive:
        """当前最强的动机。"""
        return max(self._drives.values(), key=lambda d: d.level)

    def ranked(self) -> list[Drive]:
        return sorted(self._drives.values(), key=lambda d: d.level, reverse=True)

    def snapshot(self) -> dict:
        return {
            "top": self.top_drive().key,
            "levels": {k: round(d.level, 2) for k, d in self._drives.items()},
            "bias": {k: round(v, 2) for k, v in self._bias.items() if v > 1.0},
        }

    def mood_line(self) -> str:
        """一句"她现在的心情/想干嘛"，用于简报与 prompt。"""
        top = self.top_drive()
        if top.level < 0.25:
            return "（没什么特别的念头）"
        intensity = "很想" if top.level > 0.75 else "有点想"
        return f"{intensity}{top.label.replace('欲', '')}——{top.voice}"

    def suggest_activity(self, *, avoid_repeat: bool = True) -> dict:
        """给出"现在想做什么"的建议。

        @return {"drive": key, "label": label, "activity": str, "voice": str, "level": float, "candidates": [...]}
        """
        self.tick()
        top = self.top_drive()
        candidates = list(top.activities)
        # 刚做过的事不马上重复（否则她会一直在同一个地方盖同一种房子）
        if avoid_repeat and self._last_activity:
            last = self._last_activity.get("activity")
            if last in candidates and len(candidates) > 1:
                candidates = [c for c in candidates if c != last]
        activity = random.choice(candidates) if candidates else "随便逛逛"
        return {
            "drive": top.key,
            "label": top.label,
            "activity": activity,
            "voice": top.voice,
            "level": round(top.level, 2),
            "candidates": top.activities,
        }

    def note_activity(self, *, drive: str | None, activity: str) -> None:
        """记下她刚做了什么（用于避免重复 + 满足对应动机）。"""
        self._last_activity = {"drive": drive, "activity": activity, "at": time.time()}
        if drive:
            self.satisfy(drive)
        else:
            self.save()

    def describe_all(self) -> str:
        """给 `/mc状态` 或调试用：把所有动机水位列出来。"""
        lines = []
        for d in self.ranked():
            bar_len = int(round(d.level * 10))
            bar = "█" * bar_len + "·" * (10 - bar_len)
            lines.append(f"{d.label}  {bar}  {d.level:.2f}")
        line = self._last_activity
        if line:
            import datetime

            when = datetime.datetime.fromtimestamp(line.get("at", 0)).strftime("%H:%M")
            lines.append(f"最近做过：{line.get('activity')}（{when}）")
        return "\n".join(lines)
