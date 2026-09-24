"""**`life.py` 里的类型定义**（搬出来避免循环 import）。

`Hold` / `HOLD_RELEASE` / `HOLD_WHY` / `LifeDecision` 这几个名字，
`life.py` 和 `life_render.py` **都要用**。

放在 `life.py` 里的话，`life_render.py` 就得反过来 import `life.py` ——
**循环 import**。而且失败方式很隐蔽：`from __future__ import annotations`
会把注解里的 `NameError` 藏起来，看起来只是"循环莫名其妙不动了"。

所以放进这个独立模块，两边都从这里 import。
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
