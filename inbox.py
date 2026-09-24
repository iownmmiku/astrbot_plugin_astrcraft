"""输入队列（W4，见 docs/PLAN_v2.md）。

**它解决什么问题**：在这之前，她跑长任务时主人说话她**听不见**；
世界事件（受伤、工具坏、箱子满）也**只有下一轮决策时才知道**。
因为根本没有一个"把话和事件送进去"的地方——只有一个 `task.finished → wake()`。

照 numen 的 `EventQueue` + `EventTypes.Delivery`，三条设计原则必须照做：

**① 它只是台账，不是调度员。**
不认识 Minecraft，不认识她死没死，不认识"回合"是什么。
它只回答一个问题：**现在熟没熟**。
  有急件 → 熟了
  没急件 → 看条数、看时长
没有第三条。她当时在干嘛、消费者方不方便——一律不看。

**② "排空"是"到点就走"，不是"立刻发出"。**
`ready()` / `should_drain()` **只读状态、可以反复问、答案一致**。
上层因为协议原因（不能往 assistant 的 tool_calls 中间插 user 消息）这次排不成，
下一轮再问就是了——**不存在"错过的排空"**，
也就不需要记住"我刚才想排空"这种会出错的状态。

**③ 上限满了丢最老，但**不能无声无息**。**
消费者可能很久不来取（她死着躺一晚上）。不设上限会把上下文撑爆；
但丢弃必须记账，排空时如实补一句"中间丢了 N 条"——
主人得知道自己看到的是全部还是残片。
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path

# 队列默认上限（numen 也是 200）
DEFAULT_CAP = 200


class Delivery(Enum):
    """一条输入该怎么送进去。

    **这三种的区别就是"什么时候注入"**，不是优先级。
    """

    STEER = "steer"  # 插话：一批工具结算后、下次调模型之前注入
    FOLLOW_UP = "follow_up"  # 接续：只在她**本来要停**的时候接上
    CONTROL = "control"  # 控制：只在**完全空闲**时执行（整理记忆这类）


@dataclass(frozen=True)
class Type:
    """一种事件的性质。

    @param delivery    怎么投递
    @param from_owner  是不是主人说的（决定注入时用什么口吻、算不算"插话"）
    @param always_urgent 这类事件是不是**恒急**（受伤、被攻击）
    """

    delivery: Delivery = Delivery.FOLLOW_UP
    from_owner: bool = False
    always_urgent: bool = False


# 类型表：**事件的性质集中在这里**，队列本身不认识任何具体类型。
# 加一种新事件只改这张表，不用动队列逻辑。
TYPES: dict[str, Type] = {
    # 主人说的话：插话，不是恒急（急不急听发送方的）
    "owner": Type(delivery=Delivery.STEER, from_owner=True),
    # 世界事件
    "hurt": Type(delivery=Delivery.STEER, always_urgent=True),
    "danger": Type(delivery=Delivery.STEER, always_urgent=True),
    "task_done": Type(delivery=Delivery.FOLLOW_UP),
    "task_failed": Type(delivery=Delivery.FOLLOW_UP),
    "hungry": Type(delivery=Delivery.FOLLOW_UP),
    "tool_broken": Type(delivery=Delivery.STEER),
    "chest_full": Type(delivery=Delivery.FOLLOW_UP),
    "death": Type(delivery=Delivery.STEER, always_urgent=True),
    "respawn": Type(delivery=Delivery.STEER, always_urgent=True),
    "player_near": Type(delivery=Delivery.FOLLOW_UP),
    # 控制类：只在完全空闲时执行
    "compact": Type(delivery=Delivery.CONTROL),
    "clear": Type(delivery=Delivery.CONTROL),
}

# 熟度：没急件时，攒够这么多条就该排空
BATCH_MIN = 3
# 熟度：没急件时，最老的这条躺了这么久也该排空（别让它等到天荒地老）
MAX_AGE = 20.0


def type_of(name: str) -> Type:
    """查类型表。**不认识的类型按 FOLLOW_UP 处理**（保守：不打断她干活）。"""
    return TYPES.get(str(name or ""), Type())


@dataclass
class Entry:
    """一条待处理的输入。`at` 是**真实时间戳**（不是入队顺序）。"""

    type: str
    text: str
    at: float = field(default_factory=time.time)
    urgent: bool = False

    def age(self, now: float | None = None) -> float:
        return max(0.0, (now or time.time()) - self.at)


class Inbox:
    """主人的话与世界事件**共用**的这一个队列。

    线程/协程安全：只在事件循环里用，不加锁（numen 也是这个取舍）。
    """

    def __init__(self, path: Path | None = None, *, cap: int = DEFAULT_CAP):
        self._entries: list[Entry] = []
        self._cap = max(1, int(cap))
        self._path = Path(path) if path else None
        self._dropped = 0
        # 急件叫醒名单：回调只做"完成一个等待"这类轻动作，不递事件
        self._urgent_listeners: list = []
        if self._path:
            self._load()

    # ------------------------------------------------------------ 进

    def push(
        self, type: str, text: str, *, urgent: bool = False, now: float | None = None
    ) -> "Entry | None":
        """收一条。满了丢最老并记账。

        急不急：类型表说这类恒急就是急件，否则听发送方的 `urgent`。
        **条目上记的是生效后的结果**——落盘、渲染、熟度判断都只认它。

        @return 入队的那条（`entry.urgent` 是生效后的结果）；空白输入不入队，返回 None

        **返回值这里改过一次**：原来是照 numen 返回"是不是急件"（布尔），
        于是"被拒绝"和"入队了但不算急件"都返回 False —— **调用方分不清**
        （我自己的测试就先撞上了这个歧义）。现在返回条目本身，
        想看急不急读 `entry.urgent`，想看有没有入队看是不是 None。
        """
        text = str(text or "").strip()
        if not text:
            return None
        spec = type_of(type)
        effective = bool(spec.always_urgent or urgent)
        entry = Entry(type=str(type), text=text, at=now or time.time(), urgent=effective)
        self._entries.append(entry)
        while len(self._entries) > self._cap:
            self._entries.pop(0)
            self._dropped += 1
        self._save()
        if effective:
            # **叫醒在入队落盘之后**：等待者被叫起来一问，货一定已经在。
            # 叫的内容只是"来问吧"，**不递事件**——正确性从不依赖叫醒
            # （`has_urgent` / `ready` 是随时可问、答案一致的状态）。
            for cb in list(self._urgent_listeners):
                try:
                    cb()
                # **回调**：监听者抛异常不该影响调用方
                except Exception:  # noqa: BLE001
                    pass
        return entry

    def on_urgent(self, callback) -> None:
        """登记急件叫醒（叫"来问吧"，不递事件）。"""
        self._urgent_listeners.append(callback)

    # ------------------------------------------------------------ 读（纯状态）

    def __len__(self) -> int:
        return len(self._entries)

    @property
    def entries(self) -> list[Entry]:
        """看一眼（不改）。"""
        return list(self._entries)

    @property
    def dropped(self) -> int:
        return self._dropped

    def has_urgent(self) -> bool:
        return any(e.urgent for e in self._entries)

    def ready(self, now: float | None = None) -> bool:
        """**熟没熟**——只读状态，可以反复问，答案一致。

        有急件 → 熟
        没急件 → 看条数、看最老那条的年龄
        """
        if not self._entries:
            return False
        if self.has_urgent():
            return True
        if len(self._entries) >= BATCH_MIN:
            return True
        oldest = min(e.at for e in self._entries)
        return ((now or time.time()) - oldest) >= MAX_AGE

    # 别名：语义上"该排空了"，和 ready 是同一个判断
    should_drain = ready

    def head_is_control(self) -> bool:
        return bool(self._entries) and type_of(self._entries[0].type).delivery is Delivery.CONTROL

    def has_delivery(self, delivery: Delivery) -> bool:
        """排在**第一条控制条目之前**，有没有这种投递方式的条目。

        控制条目是"到了它就先做它"的屏障——它后面的要等它执行完。
        """
        for e in self._entries:
            if type_of(e.type).delivery is Delivery.CONTROL:
                return False
            if type_of(e.type).delivery is delivery:
                return True
        return False

    # ------------------------------------------------------------ 取

    def _take(self, predicate, now: float | None = None) -> list[Entry]:
        """按顺序取走满足条件的前缀（遇到第一条不满足的就停）。

        为什么要"前缀"而不是"挑出所有满足的"：这样队列能**按顺序**排空。
        遇到一条不该当文本处理的（比如整理记忆），前面的先走完，
        它留在队首等下一个安全点。没有插队，
        也就不用为以后每种新类型回答"它插不插队"。
        """
        n = 0
        while n < len(self._entries) and predicate(self._entries[n]):
            n += 1
        if n == 0:
            return []
        taken = self._entries[:n]
        del self._entries[:n]
        self._save()
        return taken

    def take_steer(self, now: float | None = None) -> list[Entry]:
        """取插话（工具批结算后、下次调模型前用）。"""
        return self._take(lambda e: type_of(e.type).delivery is Delivery.STEER, now)

    def take_follow_up(self, now: float | None = None) -> list[Entry]:
        """取接续（只在她本来要停时用）。"""
        return self._take(lambda e: type_of(e.type).delivery is Delivery.FOLLOW_UP, now)

    def take_control(self, now: float | None = None) -> list[Entry]:
        """取控制条目（只在完全空闲时用）。"""
        return self._take(lambda e: type_of(e.type).delivery is Delivery.CONTROL, now)

    def take_all(self, now: float | None = None) -> list[Entry]:
        """取走全部（不分类，按入队顺序）。"""
        return self._take(lambda e: True, now)

    def take_dropped_note(self) -> str:
        """把"丢过多少条"取出来并清零——排空时如实补一句。

        **丢弃不能无声无息**：主人得知道自己看到的是全部还是残片。
        """
        if not self._dropped:
            return ""
        n, self._dropped = self._dropped, 0
        return f"（中间有 {n} 条输入因为积压太久被丢弃了，你看到的不是全部）"

    # ------------------------------------------------------------ 渲染

    @staticmethod
    def render(entries: list[Entry], now: float | None = None) -> list[str]:
        """渲染成给模型看的几行。**带年龄标注**——她看得出哪些是"那期间发生的"。"""
        now = now or time.time()
        out = []
        for e in entries:
            age = e.age(now)
            if age < 60:
                when = f"{int(age)} 秒前"
            elif age < 3600:
                when = f"{int(age / 60)} 分钟前"
            else:
                when = f"{int(age / 3600)} 小时前"
            out.append(f"[{when}] {e.text}")
        return out

    # ------------------------------------------------------------ 落盘

    def _save(self) -> None:
        if not self._path:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            data = {
                "entries": [asdict(e) for e in self._entries],
                "dropped": self._dropped,
            }
            self._path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:  # noqa: BLE001
            # 落盘失败不影响主流程（队列在内存里仍然是对的）
            pass

    def _load(self) -> None:
        if not self._path or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            self._entries = [
                Entry(
                    type=str(d.get("type") or ""),
                    text=str(d.get("text") or ""),
                    at=float(d.get("at") or time.time()),
                    urgent=bool(d.get("urgent")),
                )
                for d in (data.get("entries") or [])
                if str(d.get("text") or "").strip()
            ]
            self._dropped = int(data.get("dropped") or 0)
        except Exception:  # noqa: BLE001
            # 读坏了就当空的（不能因为一个坏文件让她起不来）
            self._entries = []
            self._dropped = 0

    def clear(self) -> None:
        self._entries = []
        self._dropped = 0
        self._save()
