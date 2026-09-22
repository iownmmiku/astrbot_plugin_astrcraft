"""记忆压缩测试（1.3）。

钉住的是三件事：
  1. **判重两层**：时间窗内完全相同的丢弃；归一化后相同的合并进已有条目（count+1）
  2. **归并**：同 kind + 同归一化文本的条目合成一条，count 累加、时间取最近、权重取最大
  3. **渲染**：重复次数要显示出来（"发生过 29 次"和"发生过 1 次"是两回事）

背景（实测数据）：她的记忆库 392 条里只有 173 条不同——65% 是重复，
"砍树失败：Cannot read properties of null" 重复了 29 次。这些重复把真正
有用的记忆挤出了上限，而且每轮塞进提示词的都是同一句话的 29 个副本。
"""

import sys
import time
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _paths  # noqa: E402

# memory.py 顶层 import `astrbot.api` → 没有 AstrBot 运行时就大声 SKIP
_paths.require_astrbot("test_memory")

_paths.load_plugin()
from astrcraft_plugin.memory import MemoryEntry, MemoryStore, normalize_text  # noqa: E402

passed = 0
failed = 0


def ok(msg: str, cond: bool, detail: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✅ {msg}{' — ' + detail if detail else ''}")
    else:
        failed += 1
        print(f"  ❌ {msg}{' — ' + detail if detail else ''}")


print("=== 归一化 ===")
ok(
    "数字被抹平（同一件事）",
    normalize_text("挖矿失败：走到 (12, -58, 40) 被挡住了")
    == normalize_text("挖矿失败：走到 (99, -12, 7) 被挡住了"),
)
ok(
    "不同的事不会被抹平",
    normalize_text("砍树失败") != normalize_text("挖石头失败"),
)

print("\n=== 判重：归一化后相同的合并 ===")
tmp = Path(tempfile.mkdtemp())
m = MemoryStore(tmp)
e1 = m.remember("mishap", "砍树失败：走到 (12, -58, 40) 被挡住了")
ok("第一次是新增", e1 is not None and e1.count == 1)
w1 = e1.weight  # **先存下来**：第二次返回的是同一个对象，直接比较会永远相等
time.sleep(0.01)
e2 = m.remember("mishap", "砍树失败：走到 (99, -12, 7) 被挡住了")
ok("第二次不新增条目", len(m._entries) == 1, f"{len(m._entries)} 条")
ok("第二次把 count 累加", e2 is not None and e2.count == 2, f"count={e2.count if e2 else '?'}")
ok("第二次刷新了时间", e2 is not None and e2.at >= e1.at)
ok("反复发生会变重", e2 is not None and e2.weight > w1, f"{w1:.2f} → {e2.weight:.2f}")

print("\n=== 判重：短时间窗内完全相同的丢弃 ===")
m2 = MemoryStore(tmp / "second")
m2.remember("trivial", "完全一样的一句话")
r = m2.remember("trivial", "完全一样的一句话")
ok("窗口内重复的直接丢弃", r is None and len(m2._entries) == 1)

print("\n=== 不同 kind 不互相合并 ===")
m3 = MemoryStore(tmp / "third")
m3.remember("death", "被僵尸打死了")
m3.remember("mishap", "被僵尸打死了")
ok("同文本不同 kind 各算一条", len(m3._entries) == 2, f"{len(m3._entries)} 条")

print("\n=== 归并（_consolidate）===")
raw = [
    MemoryEntry(kind="mishap", text="挖石头失败：走到 (1, 2, 3) 没进展", at=100.0, weight=3.0),
    MemoryEntry(kind="mishap", text="挖石头失败：走到 (4, 5, 6) 没进展", at=200.0, weight=5.0),
    MemoryEntry(kind="mishap", text="挖石头失败：走到 (7, 8, 9) 没进展", at=150.0, weight=2.0),
    MemoryEntry(kind="death", text="死了", at=120.0, weight=6.0),
]
merged = MemoryStore._consolidate(raw)
ok("三条同类的合成一条", len(merged) == 2, f"{len(merged)} 条")
first = [e for e in merged if e.kind == "mishap"][0]
ok("count 累加为 3", first.count == 3, f"count={first.count}")
ok("时间取最近", first.at == 200.0, f"at={first.at}")
ok("权重取最大（重要的事不被稀释）", first.weight == 5.0, f"weight={first.weight}")

print("\n=== 超上限时先归并再淘汰 ===")
m4 = MemoryStore(tmp / "fourth", max_entries=10)
for i in range(40):
    m4.remember("mishap", f"挖石头失败：走到 ({i}, 0, {i}) 没进展")
ok("40 条重复被压成 1 条", len(m4._entries) == 1, f"{len(m4._entries)} 条")
ok("count 记录了真实次数", m4._entries[0].count == 40, f"count={m4._entries[0].count}")

print("\n=== 渲染时显示次数 ===")
m5 = MemoryStore(tmp / "fifth")
for i in range(3):
    m5.remember("mishap", f"砍树失败：位置 ({i}, 0, 0)")
text = m5.render_for_prompt(m5.recent(5))
ok("显示了发生过几次", "发生过 3 次" in text, text.strip()[:60])
m6 = MemoryStore(tmp / "sixth")
m6.remember("death", "被苦力怕炸死了")
text6 = m6.render_for_prompt(m6.recent(5))
ok("只发生一次时不显示次数", "发生过" not in text6, text6.strip()[:50])

print("\n=== 落盘/载入保留 count ===")
m7 = MemoryStore(tmp / "seventh")
for i in range(5):
    m7.remember("mishap", f"砍树失败：位置 ({i}, 0, 0)")
m7.save(force=True)
m8 = MemoryStore(tmp / "seventh")
ok("重新载入后 count 还在", m8._entries[0].count == 5, f"count={m8._entries[0].count}")

print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
sys.exit(1 if failed else 0)
