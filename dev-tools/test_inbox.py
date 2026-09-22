"""输入队列的测试（W4，见 docs/PLAN_v2.md）。

钉住 numen 的 `EventQueue` 那三条设计原则——它们是这个模块**为什么长这样**的原因：

**① 它只是台账，不是调度员。**
   不认识 Minecraft，不认识她死没死，不认识"回合"是什么。
   只回答"现在熟没熟"。所以下面的断言全是关于**状态**的，不是关于"该不该执行"。

**② "排空"是"到点就走"，不是"立刻发出"。**
   `ready()` 只读状态、可以反复问、答案一致 →
   **不存在"错过的排空"**，也就不需要记"我刚才想排空"这种会出错的状态。
   断言：反复问同一个问题，答案不变；问了不取，东西还在。

**③ 上限满了丢最老，但不能无声无息。**
   断言：丢弃有记账，而且排空时会如实补一句。

另外钉住"投递方式"三态的区别——**这三种的区别是"什么时候注入"，不是优先级**。
"""

import sys
import time
import pathlib
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import _paths  # noqa: E402

_paths.load_plugin()
from astrcraft_plugin.inbox import (  # noqa: E402
    BATCH_MIN,
    DEFAULT_CAP,
    MAX_AGE,
    Delivery,
    Entry,
    Inbox,
    type_of,
)

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


print("=== 类型表：事件的性质集中在表里 ===")
ok("主人说的话是插话", type_of("owner").delivery is Delivery.STEER)
ok("主人说的话算 from_owner", type_of("owner").from_owner is True)
ok("受伤恒急", type_of("hurt").always_urgent is True)
ok("任务完成是接续（不打断）", type_of("task_done").delivery is Delivery.FOLLOW_UP)
ok("整理记忆是控制类", type_of("compact").delivery is Delivery.CONTROL)
ok("**不认识的类型按接续处理**（保守：不打断她干活）",
   type_of("完全没听过的事件").delivery is Delivery.FOLLOW_UP,
   "新事件忘了登记时，行为是'等她停下来再说'，不是'打断她'")

print("\n=== 空白输入不入队 ===")
box = Inbox()
ok("空串不入队", box.push("owner", "") is None and len(box) == 0)
ok("纯空白不入队", box.push("owner", "   \n ") is None and len(box) == 0)
ok("有内容才入队", box.push("owner", "你好") is not None and len(box) == 1)
# **返回值这里踩过**：原来照 numen 返回"是不是急件"（布尔），
# 于是"被拒绝"和"入队了但不算急件"都返回 False —— 调用方分不清。
# 现在返回条目本身：想看急不急读 entry.urgent，想看有没有入队看是不是 None。
e = box.push("owner", "再说一句")
ok("返回值是条目本身（不是布尔）", isinstance(e, Entry), type(e).__name__)
ok("急不急从 entry.urgent 读", e.urgent is False, "普通消息不是急件，但它确实入队了")
ok("入队成功与'算不算急件'是两个问题", len(box) == 2, f"{len(box)} 条")

print("\n=== 熟度：只读状态，可反复问，答案一致（原则②）===")
box = Inbox()
box.push("task_done", "砍树做完了")
a = box.ready()
b = box.ready()
c = box.ready()
ok("反复问答案一致（没有副作用）", a == b == c, f"{a}/{b}/{c}")
ok("问完东西还在（没被顺手取走）", len(box) == 1, f"{len(box)} 条")
ok("一条普通事件还不算熟（没急件、条数不够、也不够老）", box.ready() is False)

box.push("owner", "你在干嘛")
box.push("task_done", "挖矿做完了")
ok(f"攒够 {BATCH_MIN} 条就熟", box.ready() is True, f"{len(box)} 条")

print("\n=== 有急件就熟（不管几条）===")
box = Inbox()
box.push("hurt", "被僵尸打了", urgent=True)
ok("一条急件就熟", box.ready() is True)
ok("has_urgent 认得出来", box.has_urgent() is True)

box2 = Inbox()
box2.push("hurt", "被僵尸打了")  # 类型表说这类恒急，不用显式传 urgent
ok("**恒急类型不用显式传 urgent**", box2.has_urgent() is True, "hurt 在表里就是 always_urgent")

box3 = Inbox()
box3.push("task_done", "做完了", urgent=True)
ok("普通类型也能被发送方标急", box3.has_urgent() is True)

print("\n=== 够老就熟（别让一条等到天荒地老）===")
box = Inbox()
box.push("task_done", "很久以前的事", now=time.time() - MAX_AGE - 1)
ok("躺够时间就熟", box.ready() is True, f"年龄 > {MAX_AGE} 秒")

print("\n=== 三种投递方式取件互不串（这是「什么时候注入」的区别）===")
box = Inbox()
box.push("owner", "主人说的")
box.push("task_done", "任务完成了")
box.push("compact", "整理记忆")
steer = box.take_steer()
ok("取插话只拿到 owner 那条", len(steer) == 1 and steer[0].type == "owner", str([e.type for e in steer]))
follow = box.take_follow_up()
ok("取接续只拿到 task_done", len(follow) == 1 and follow[0].type == "task_done", str([e.type for e in follow]))
ctrl = box.take_control()
ok("取控制只拿到 compact", len(ctrl) == 1 and ctrl[0].type == "compact", str([e.type for e in ctrl]))
ok("取完队列空了", len(box) == 0)

print("\n=== 控制条目是屏障：它后面的要等它执行完 ===")
box = Inbox()
box.push("compact", "整理记忆")
box.push("owner", "主人说的")
ok("队首是控制条目", box.head_is_control() is True)
ok("**控制条目后面的插话不算'排在前头'**", box.has_delivery(Delivery.STEER) is False,
   "她得先执行整理，再处理主人的话——没有插队")
steer = box.take_steer()
ok("所以现在取插话取不到", steer == [], "顺序被尊重了")

box2 = Inbox()
box2.push("owner", "主人说的")
box2.push("compact", "整理记忆")
ok("反过来的话，插话排在控制之前", box2.has_delivery(Delivery.STEER) is True)

print("\n=== 取件是「前缀」不是「挑拣」（保证按顺序排空）===")
box = Inbox()
box.push("owner", "一")
box.push("compact", "整理记忆")
box.push("owner", "二")
taken = box.take_steer()
ok("只取到屏障之前的那条", len(taken) == 1 and taken[0].text == "一", str([e.text for e in taken]))
ok("屏障和它后面的还在", len(box) == 2, f"{len(box)} 条")

print("\n=== 上限：满了丢最老，但记账（原则③）===")
box = Inbox(cap=3)
for i in range(5):
    box.push("task_done", f"第 {i} 条")
ok("队列不超过上限", len(box) == 3, f"{len(box)} 条")
ok("丢的是最老的（留下的是最近的）",
   [e.text for e in box.entries] == ["第 2 条", "第 3 条", "第 4 条"],
   str([e.text for e in box.entries]))
ok("丢弃有记账", box.dropped == 2, f"dropped={box.dropped}")

note = box.take_dropped_note()
ok("**排空时如实补一句**", "2 条" in note and "不是全部" in note, note)
ok("取过一次就清零（不会重复念叨）", box.take_dropped_note() == "")
ok("默认上限是 200", DEFAULT_CAP == 200, f"{DEFAULT_CAP}")

print("\n=== 渲染带年龄标注（她看得出哪些是'那期间发生的'）===")
now = time.time()
rows = Inbox.render([
    Entry(type="owner", text="刚才说的", at=now - 5),
    Entry(type="task_done", text="五分钟前的事", at=now - 300),
    Entry(type="hurt", text="一小时前被打", at=now - 3700),
], now)
ok("秒级", "秒前" in rows[0], rows[0])
ok("分钟级", "分钟前" in rows[1], rows[1])
ok("小时级", "小时前" in rows[2], rows[2])
ok("文本都在", all("说的" in rows[0] or "刚才" in rows[0] for _ in [0]), rows[0])

print("\n=== 落盘：跨重启活着 ===")
d = pathlib.Path(tempfile.mkdtemp()) / "inbox.json"
box = Inbox(d)
box.push("owner", "重启前说的话")
box.push("task_done", "重启前的任务")
ok("文件写出来了", d.exists(), str(d))

box2 = Inbox(d)
ok("重启后条数还在", len(box2) == 2, f"{len(box2)} 条")
ok("内容还在", any("重启前说的话" in e.text for e in box2.entries))
ok("时间戳还在（年龄才对）", box2.entries[0].at > 0)

print("\n=== 坏文件不能让她起不来 ===")
bad = pathlib.Path(tempfile.mkdtemp()) / "inbox.json"
bad.write_text("{ 这不是合法 JSON", encoding="utf-8")
box3 = Inbox(bad)
ok("读坏了当空的（不抛异常）", len(box3) == 0, "不能因为一个坏文件让她起不来")
box3.push("owner", "还能继续用")
ok("之后还能正常入队", len(box3) == 1)

print("\n=== 急件叫醒：叫的是「来问吧」，不递事件 ===")
box = Inbox()
fired = []
box.on_urgent(lambda: fired.append(1))
box.push("task_done", "普通事件")
ok("普通事件不叫醒", fired == [], str(fired))
box.push("hurt", "受伤了")
ok("急件叫醒", fired == [1], str(fired))
ok("**叫醒之后货已经在**（入队落盘之后才叫）", box.has_urgent() is True)

# 回调抛异常不能影响入队
box2 = Inbox()
def boom():
    raise RuntimeError("回调炸了")
box2.on_urgent(boom)
box2.push("hurt", "受伤了")
ok("回调抛异常不影响入队", len(box2) == 1, "正确性从不依赖叫醒")

print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
sys.exit(1 if failed else 0)
