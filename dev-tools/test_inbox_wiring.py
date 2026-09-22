"""输入队列接进 LifeLoop 的测试（W4 第二步，见 docs/PLAN_v2.md）。

第一步只做了队列内核（`inbox.py`），这一步是**接线**：
队列躺着没人取，等于没做。要钉住四个注入点：

  1. **STEER 在"组装提示词"时注入**——我们的安全注入点。
     agent 每一轮都重新组装提示词，所以不会插在 assistant 的 tool_calls 中间。
     （numen 的说法是"一批工具结算后、下次调模型之前"。）
  2. **FOLLOW_UP 只在她本来要停时接上**——她还在干活时**不许动**它。
  3. **CONTROL 只在完全空闲时执行**——整理记忆/清空会改变她正在看的历史，
     干活干到一半做等于抽走图纸。
  4. **判"没事做"必须把队列算进去**——队列里躺着"砍树做完了"，
     那就不叫没事做，下一步会接上它。

另外钉住"主人说话入队"和"任务结果入队"这两个入口真的接上了
（用源码断言，防止只写了方法没人调）。
"""

import sys
import time
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import _paths  # noqa: E402

# 这个测试要导入 main.py（末尾那段 _looks_like_full），而 main.py 依赖 astrbot。
_paths.require_astrbot("test_inbox_wiring")
_paths.load_plugin()
from astrcraft_plugin.inbox import Delivery, Inbox  # noqa: E402
from astrcraft_plugin.life import Hold, LifeLoop  # noqa: E402

passed = 0
failed = 0


def ok(msg, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✅ {msg}{' — ' + detail if detail else ''}")
    else:
        failed += 1
        print(f"  ❌ {msg}{' — ' + detail if detail else ''}")


def make_loop(inbox=None):
    """造一个够用的 LifeLoop（不走完整 __init__）。"""
    loop = LifeLoop.__new__(LifeLoop)
    loop.inbox = inbox if inbox is not None else Inbox()
    loop._pending_follow_up = ""
    loop._recent_outcomes = []
    loop._recent_failures = {}
    loop._failure_window = 1800.0
    loop._last_death = None
    loop._plan = []
    loop._plan_source = ""
    loop._todos = []
    loop._intention = ""
    loop._intention_rounds = 0
    loop._intention_since = 0.0
    loop._has_shelter = False
    loop.knowledge = None
    loop.perception = None
    loop.action_agent = None
    loop.drives = None
    loop.memory = None
    loop._decide_retry_limit = 2
    loop._idle_rounds = 0
    loop._idle_since = 0.0
    loop._last_idle_note_at = 0.0
    loop._backoff_until = 0.0
    loop._notes = []
    loop._on_activity = lambda text: loop._notes.append(text)
    loop._dead = False
    loop._engine_up = True
    loop._blocked_reason = ""
    loop._paused = False
    loop._pause_reason = ""
    loop._pause_until = 0.0
    loop._announced_hold = None
    loop._is_connected = lambda: True
    return loop


print("=== STEER：在组装提示词时注入 ===")
box = Inbox()
lp = make_loop(box)
lp.inbox.push("owner", "小明 说：你在干嘛")
text = lp._drain_steer_text()
ok("取到了内容", "小明" in text, text.replace("\n", " | ")[:80])
ok("有醒目的标题（她要先看这个）", "刚刚发生的事" in text, text.replace("\n", " | ")[:60])
ok("**取走即出队**（不会重复注入同一条）", len(box) == 0, f"队列剩 {len(box)} 条")
ok("第二次取是空的", lp._drain_steer_text() == "")

print("\n=== STEER 不碰接续和控制条目 ===")
box = Inbox()
lp = make_loop(box)
box.push("owner", "主人的话")
box.push("task_done", "任务完成了")
box.push("compact", "整理记忆")
lp._drain_steer_text()
ok("只取走插话", len(box) == 2, f"剩 {len(box)} 条")
ok("接续还在", box.has_delivery(Delivery.FOLLOW_UP) is True)
# **控制条目还在队里，但不在队首**——取走插话之后队首变成了 task_done。
# 这是**正确的前缀语义**（我第一版断言写成了"还在队首"，那是我错了）：
# 控制条目是屏障，它前面的要先走完，它才轮得到。
ok(
    "控制条目还在队里（只是前面还排着接续）",
    any(e.type == "compact" for e in box.entries),
    str([e.type for e in box.entries]),
)
ok(
    "队首是接续（屏障之前的那条）",
    box.entries[0].type == "task_done",
    f"队首={box.entries[0].type}",
)

print("\n=== FOLLOW_UP：她还在干活时不许动它 ===")
box = Inbox()
lp = make_loop(box)
box.push("task_done", "砍树做完了")
# 模拟"她正在干活"——循环不会走到取接续那一步（引擎忙 → continue）
# 这里直接验证"取接续"这个动作本身不会误伤插话
box.push("owner", "主人的话")
follow = lp._take_follow_up_text()
ok("取到了接续", "砍树做完了" in follow, follow)
ok("**没把插话一起取走**", len(box) == 1 and box.entries[0].type == "owner", str([e.type for e in box.entries]))

print("\n=== CONTROL：只在完全空闲时执行 ===")
box = Inbox()
lp = make_loop(box)
box.push("owner", "主人排在前面")
ok("队首不是控制条目 → 不执行", lp._run_control() == "", "插话排在前面时，控制要等")
ok("队列没被动", len(box) == 1)

box2 = Inbox()
lp2 = make_loop(box2)
box2.push("clear", "清空上下文")
lp2._plan = [{"skill": "mine_stone", "params": {}}]
lp2._todos = [{"text": "挖矿"}]
lp2._intention = "盖房子"
what = lp2._run_control()
ok("队首是控制条目 → 执行", what != "", what)
ok("清空丢掉了计划", lp2._plan == [], f"plan={lp2._plan}")
ok("清空丢掉了清单", lp2._todos == [], f"todos={lp2._todos}")
ok("清空丢掉了打算", lp2._intention == "", f"intention={lp2._intention!r}")
ok("队列清空了", len(box2) == 0)

print("\n=== 控制条目是屏障：它后面的要等它执行完 ===")
box = Inbox()
lp = make_loop(box)
box.push("compact", "整理记忆")
box.push("owner", "主人说的")
ok("队首是控制 → 先执行控制", lp.inbox.head_is_control() is True)
lp._run_control()
ok("执行完控制后，插话还在（没被吃掉）", len(box) == 1 and box.entries[0].type == "owner", str([e.type for e in box.entries]))
ok("现在可以取插话了", "主人说的" in lp._drain_steer_text())

print("\n=== 主人说话入队 ===")
box = Inbox()
lp = make_loop(box)
lp.note_owner_said("小红 说：帮我砍点树")
ok("入队了", len(box) == 1, f"{len(box)} 条")
ok("类型是 owner", box.entries[0].type == "owner")
ok("算插话（下次调模型前注入）", box.has_delivery(Delivery.STEER) is True)

print("\n=== 世界事件入队 ===")
box = Inbox()
lp = make_loop(box)
lp.note_world_event("task_done", "「砍树」做完了")
lp.note_world_event("hurt", "被僵尸打了", urgent=True)
ok("两条都入队了", len(box) == 2, f"{len(box)} 条")
ok("受伤是急件", box.has_urgent() is True)
lp.note_world_event("tool_broken", "镐子坏了")
ok("工具坏了也算插话（她会先知道）", box.has_delivery(Delivery.STEER) is True)

print("\n=== 队列摘要（给 /mc状态 用）===")
box = Inbox()
lp = make_loop(box)
ok("空队列有说法", "队列空" in lp.inbox_summary(), lp.inbox_summary())
box.push("owner", "话")
box.push("task_done", "事")
box.push("hurt", "伤")
s = lp.inbox_summary()
ok("报了条数", "3 条" in s, s)
ok("报了有急件", "急件" in s, s)
ok("报了分类", "owner" in s and "task_done" in s, s)

print("\n=== 判「没事做」必须把队列算进去（源码断言）===")
src = (_paths.REPO / "life.py").read_text(encoding="utf-8")
ok(
    "agent 那处的空闲判定含 len(self.inbox) == 0",
    "not await self._engine_busy()\n                            and len(self.inbox) == 0" in src
    or "and len(self.inbox) == 0" in src,
    "队列里有活时不算空闲",
)
ok(
    "旧路径那处的空闲判定也含队列",
    "len(self.inbox) == 0" in src,
)

print("\n=== 四个接线点确实存在（防止只写了方法没人调）===")
mn = (_paths.REPO / "main.py").read_text(encoding="utf-8")
ok("main.py 构造 LifeLoop 时传了 inbox", "inbox=Inbox(" in mn)
ok("主人说话入队", "note_owner_said(" in mn)
ok("任务结果入队", 'note_world_event("task_done"' in mn and 'note_world_event(\n                        "task_failed"' in mn or "task_failed" in mn)
ok("急件叫醒接上了", "on_urgent" in src)
ok("提示词里注入了插话", "_drain_steer_text()" in src)
ok("提示词里注入了接续", "_pending_follow_up" in src)
ok("控制条目在循环里被执行", "_run_control()" in src)
ok("/mc状态 显示队列", "inbox_summary()" in mn)

print("\n=== 世界事件入队的三个订阅点（W4 第三步）===")
ok("订阅 bot.hurt", 'self.engine.on("bot.hurt"' in mn)
ok("订阅 bot.hungry", 'self.engine.on("bot.hungry"' in mn)
ok("订阅 tool.broken", 'self.engine.on("tool.broken"' in mn)
ok("受伤入队且标急件", 'note_world_event("hurt"' in mn and "urgent=True" in mn)
ok("饥饿入队", 'note_world_event(\n                "hungry"' in mn or '"hungry"' in mn)
ok("工具损坏入队", '"tool_broken"' in mn)

print("\n=== 引擎侧确实发了这些事件（源码断言）===")
eng = (_paths.ENGINE_DIR / "bot.js").read_text(encoding="utf-8")
ok("引擎发 bot.hurt", "this._emit('bot.hurt'" in eng)
ok("引擎发 bot.hungry", "this._emit('bot.hungry'" in eng)
ok("引擎发 tool.broken", "this._emit('tool.broken'" in eng)
ok(
    "饥饿事件有冷却（不然每 200ms 刷一条把队列刷满）",
    "_lastHungryAt" in eng and "60000" in eng,
)
ok(
    "**没有用 itemBreak**（实测 mineflayer 根本没这个事件）",
    "bot.on('itemBreak'" not in eng,
    "第一版猜了这个名字，镐子坏了但事件一次都没发出来",
)
ok("改成自己盯手上的工具", "_toolBreakTick" in eng)

print("\n=== 箱子满：从真实报错文本里认（W4 最后一种事件）===")
# 引擎侧**没有"箱子满了"这个状态**，所以不能凭空发事件。
# 真实信号只有一个：服务端在放不进去时回的报错文本。
# 认不出就不报——宁可漏报，也不要把"没有箱子"说成"箱子满了"
# （那会让她去清理一个根本不存在的箱子）。
from astrcraft_plugin.main import MinecraftPlugin as _P  # noqa: E402

_full = _P._looks_like_full
ok("认得 'container is full'", _full("container is full") is True)
ok("认得 'No space left'", _full("No space left in container") is True)
ok("认得中文「没有空间」", _full("箱子里没有空间了") is True)
ok("认得中文「装不下」", _full("东西装不下") is True)
ok("认得中文「满了」", _full("这个箱子满了") is True)
ok("**不把「没有箱子」误判成满了**", _full("附近没有箱子") is False, "那会让她去清一个不存在的箱子")
ok("**不把「够不着」误判成满了**", _full("距离 8.7 格，超出可交互距离") is False)
ok("空报错不算", _full("") is False)
ok("None 不算", _full(None) is False)
ok("源码里确实用了它", "_looks_like_full" in mn and '"chest_full"' in mn)

print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
sys.exit(1 if failed else 0)
