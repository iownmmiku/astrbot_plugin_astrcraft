"""记忆累积语义的测试（W5，见 docs/PLAN_v2.md）。

钉住一句话：**记忆是累积的账，只能增补，不能反复转述。**

这条来自 numen 的 Compactor（它的原话）：
    不这么做的话，上一份摘要会随着"较早的部分"被再总结一遍——
    **每压缩一轮，三轮前记下的坐标与教训就少一点，而且没人会发现。**

我们这边的对应问题是 `MemoryStore._consolidate`：它把同类条目合并时
**只保留第一条的文本**，而判重用的 `normalize_text` 会把数字换成 N、
把括号内容删掉。于是：

    「走不到 (12, -58, 40)」和「走不到 (99, -12, 7)」
    → 认成同一件事 → 合并 → **第二个坐标永久丢失，而且没人会发现**

这个测试就是钉住"不会再有这种事"：
  1. 合并后**每一个原始坐标都还在**（evidence）
  2. **首见时间不被覆盖**（原来被 max 成最近一次）
  3. 合并**只增不改**：已有的 text 不会被改写
  4. 证据有上限（不能无限涨）
  5. 老格式文件读进来不丢信息（向后兼容）
"""

import sys
import time
import pathlib
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import _paths  # noqa: E402

# memory.py 顶层 import `astrbot.api` → 没有 AstrBot 运行时就大声 SKIP
_paths.require_astrbot("test_memory_ledger")

_paths.load_plugin()
from astrcraft_plugin.memory import (  # noqa: E402
    MAX_EVIDENCE,
    MemoryEntry,
    MemoryStore,
    normalize_text,
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


def store():
    return MemoryStore(pathlib.Path(tempfile.mkdtemp()))


print("=== 前提：判重确实会把坐标抹掉（所以必须靠 evidence 留住）===")
a = "挖矿失败：走到 (12, -58, 40) 被挡住了"
b = "挖矿失败：走到 (99, -12, 7) 被挡住了"
ok("两句的归一化结果相同（会被认成同一件事）", normalize_text(a) == normalize_text(b))
ok("归一化后数字没了", "-58" not in normalize_text(a), normalize_text(a))

print("\n=== 核心：合并后每个坐标都还在 ===")
s = store()
s.remember("mishap", a, dedupe_window=0)
s.remember("mishap", b, dedupe_window=0)
merged = s._consolidate(list(s._entries)) if hasattr(s, "_entries") else None
entries = s.recent(10) if merged is None else merged
hits = [e for e in entries if "挖矿失败" in e.text]
ok("合并成了一条", len(hits) == 1, f"{len(hits)} 条")
if hits:
    e = hits[0]
    ok("次数是 2", e.count == 2, f"count={e.count}")
    joined = " ".join(e.evidence)
    ok("**第一个坐标还在**", "-58" in joined or "(12" in joined, joined)
    ok("**第二个坐标也还在（原来这里会丢）**", "-12" in joined or "(99" in joined, joined)
    ok("text 保持原样（没被改写）", e.text == a, e.text)

print("\n=== 首见时间不被覆盖（原来被 max 成最近一次）===")
s = store()
t0 = time.time() - 3600  # 一小时前
s.remember("mishap", a, dedupe_window=0)
first = s.recent(1)[0]
first.first_seen = t0
first.at = t0
# 再记一条同类的（现在的时刻）
s.remember("mishap", b, dedupe_window=0)
e = [x for x in s.recent(10) if "挖矿失败" in x.text][0]
ok("first_seen 还是最早那次", abs(e.first_seen - t0) < 5, f"first_seen={e.first_seen:.0f} vs {t0:.0f}")
ok("at（最近一次）已经更新", e.at > t0 + 60, f"at={e.at:.0f}")
ok("首见确实早于最近", e.first_seen < e.at)

print("\n=== 合并只增不改 ===")
s = store()
s.remember("mishap", a, dedupe_window=0)
before = s.recent(1)[0].text
s.remember("mishap", b, dedupe_window=0)
after = [x for x in s.recent(10) if "挖矿失败" in x.text][0].text
ok("已有文本没被改写", before == after, f"{before!r} → {after!r}")
ok("证据只增不减（>=2 条）", len([x for x in s.recent(10) if "挖矿失败" in x.text][0].evidence) >= 2)

print("\n=== 证据有上限（不能无限涨）===")
s = store()
for i in range(20):
    s.remember("mishap", f"走不到目标：卡在 ({i}, {i * 2}, {i * 3})", dedupe_window=0)
e = [x for x in s.recent(50) if "走不到目标" in x.text][0]
ok(f"证据不超过 {MAX_EVIDENCE} 条", len(e.evidence) <= MAX_EVIDENCE, f"{len(e.evidence)} 条")
ok("次数照实累计（20）", e.count == 20, f"count={e.count}")
ok("留下的是最近的几条", f"({19}," in " ".join(e.evidence) or "(19," in " ".join(e.evidence), " ".join(e.evidence)[-60:])

print("\n=== 渲染：多次发生时要说清'最早'和'具体几次' ===")
s = store()
old = time.time() - 7200
s.remember("mishap", a, dedupe_window=0)
ent = s.recent(1)[0]
ent.first_seen = old
ent.at = old
s.remember("mishap", b, dedupe_window=0)
target = [x for x in s.recent(10) if "挖矿失败" in x.text]
text = s.render_for_prompt(target)
ok("说了发生过几次", "发生过 2 次" in text, text.replace("\n", " | "))
ok("说了最早在什么时候", "最早在" in text, text.replace("\n", " | "))
ok("把具体证据也给了出来", "具体几次" in text, text.replace("\n", " | "))
ok("**第二个坐标出现在渲染里**（模型真的能看到）", "-12" in text or "(99" in text, text.replace("\n", " | "))

print("\n=== 只发生过一次时不啰嗦 ===")
s = store()
s.remember("mishap", a, dedupe_window=0)
text = s.render_for_prompt(s.recent(1))
ok("没有'发生过 N 次'", "发生过" not in text, text)
ok("没有'具体几次'", "具体几次" not in text, text)

print("\n=== 向后兼容：老文件（没有 first_seen/evidence）读进来不丢信息 ===")
old_json = {
    "kind": "mishap",
    "text": a,
    "at": 1700000000.0,
    "weight": 4,
    "tags": ["失败"],
    "context": {"position": {"x": 12}},
    "count": 3,
}
e = MemoryEntry.from_json(old_json)
ok("老条目的文本还在", e.text == a)
ok("老条目的次数还在", e.count == 3)
ok("first_seen 回落到 at（不丢时间）", e.first_seen == 1700000000.0, f"{e.first_seen}")
ok("evidence 回落到 [text]（不丢证据）", e.evidence == [a], str(e.evidence))

print("\n=== 落盘再读回来，证据还在 ===")
d = pathlib.Path(tempfile.mkdtemp())
s1 = MemoryStore(d)
s1.remember("mishap", a, dedupe_window=0)
s1.remember("mishap", b, dedupe_window=0)
s1.save() if hasattr(s1, "save") else None
s2 = MemoryStore(d)
e2 = [x for x in s2.recent(10) if "挖矿失败" in x.text]
ok("重新加载后还是一条", len(e2) == 1, f"{len(e2)} 条")
if e2:
    joined = " ".join(e2[0].evidence)
    ok("两个坐标都还在", ("-58" in joined or "(12" in joined) and ("-12" in joined or "(99" in joined), joined)

print("\n=== 评估窗口从'目标设定那一刻'起算（W5 第二部分）===")
# numen 的真实事故：她分三次才凑够数，而只看末尾就永远拼不出累计证据——
# "第一轮挖到 64/128 那条早滚出窗口，后面几轮评估器咬定'没有挖矿证据'，
#   把她赶去满世界找矿四分钟。"
# 我们这边 `_render_recent()` 只给最近 5 条，同样会丢累计证据。
from astrcraft_plugin.life import LifeLoop  # noqa: E402

lp = LifeLoop.__new__(LifeLoop)
lp._recent_outcomes = []
lp._recent_failures = {}
lp._failure_window = 1800.0
_t0 = time.time() - 600
for i in range(3):
    lp._recent_outcomes.append({"at": _t0 + i, "skill": "mine_stone", "ok": True, "detail": ""})
for i in range(5):
    lp._recent_outcomes.append(
        {"at": time.time() - i, "skill": "mine_ore", "ok": False, "detail": "没有镐"}
    )

text = lp._render_progress_since(_t0)
ok("累计进展里有'做成过'", "做成过" in text, text.replace("\n", " | "))
ok("**早先做成的那 3 次看得见**（这正是原来会丢的）", "mine_stone" in text, text.replace("\n", " | "))
ok("失败也如实列出", "mine_ore" in text, text.replace("\n", " | "))
ok(
    "明说这是累计的账、不是最近几条",
    "累计的账" in text,
    "防止模型因为最近几次失败就说'我没做成过'",
)
# 对照：证明"只看最近 5 条"确实看不见那 3 次成功
_recent5 = lp._recent_outcomes[-5:]
ok(
    "对照：最近 5 条里确实没有那 3 次成功（说明这个机制是必要的）",
    not any(o["skill"] == "mine_stone" for o in _recent5),
    "这就是 numen 那个 64/128 事故的形状",
)

print("\n=== '想事情失败'不算'做事失败'（和 W3 对齐）===")
lp2 = LifeLoop.__new__(LifeLoop)
lp2._recent_outcomes = [
    {"at": time.time(), "skill": "（想事情）", "ok": False, "detail": "超时", "decision": True},
    {"at": time.time(), "skill": "chop_tree", "ok": True, "detail": ""},
]
text2 = lp2._render_progress_since(time.time() - 60)
ok("决策失败不进'失败过'那一栏", "（想事情）" not in text2, text2.replace("\n", " | "))
ok("做成的照常显示", "chop_tree" in text2, text2.replace("\n", " | "))

print("\n=== 没有记录时不硬凑 ===")
lp3 = LifeLoop.__new__(LifeLoop)
lp3._recent_outcomes = []
ok("没有记录 → 返回空", lp3._render_progress_since(time.time() - 60) == "")
ok("没给 since → 返回空", lp3._render_progress_since(0) == "")

print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
sys.exit(1 if failed else 0)
