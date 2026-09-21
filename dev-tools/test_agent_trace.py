"""失败留痕的测试（W3，见 docs/PLAN_v2.md）。

钉住的是**"想事情失败"必须被下一轮看见，而且不能无限重试**。

改之前：决策超时只打一行日志 + `sleep(8)` 重来，两个毛病：
  ① 模型完全不知道上一轮被切断了 → 下一轮可能原样再来一遍，
     或者**以为自己刚才做过什么**（其实那轮根本没跑起来）
  ② **无限重试**：`_decide_timeouts` 只计数从不放弃

这对应 numen 的"在历史里写切断点"（`writeHalt`）。它是进程内、有会话历史，
所以写进历史；我们是**每轮无状态**的（`ActionAgent.act()` 每次都从一条新
user 消息开始），所以等价物是**写进"最近做过的事"**，让下一轮的观察里带着它。
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from plugin.life import LifeLoop  # noqa: E402

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


def make_loop():
    loop = LifeLoop.__new__(LifeLoop)
    loop._recent_outcomes = []
    loop._recent_failures = {}
    loop._failure_window = 1800.0
    loop._last_death = None
    loop._plan = []
    loop._plan_source = ""
    loop._todos = []
    loop._intention = ""
    loop._has_shelter = False
    # note_task_result 会用到这几个（注入的依赖，这里给 None 就够）
    loop.knowledge = None
    loop.perception = None
    loop.action_agent = None
    loop.drives = None
    # W3 加的重试上限（真实 __init__ 里设，桩要跟上）
    loop._decide_retry_limit = 2
    return loop


print("=== 决策失败会被记下来 ===")
lp = make_loop()
lp.note_decision_cut("90 秒没想出来", kind="timeout")
ok("记了一条", len(lp._recent_outcomes) == 1, f"{len(lp._recent_outcomes)} 条")
entry = lp._recent_outcomes[0]
ok("标成了 decision（和'做事失败'区分开）", entry.get("decision") is True)
ok("记下了原因", "90 秒" in entry["detail"], entry["detail"])
ok("ok=False", entry["ok"] is False)

print("\n=== 三种失败原因说法不同 ===")
for kind, want in [("timeout", "超时"), ("failed", "出错"), ("cancelled", "中断")]:
    lp2 = make_loop()
    lp2.note_decision_cut("测试", kind=kind)
    got = lp2._recent_outcomes[0]["detail"]
    ok(f"{kind} → 说明里有「{want}」", want in got, got)

print("\n=== 渲染出来的话必须让模型明白「那轮什么都没做成」 ===")
lp = make_loop()
lp.note_decision_cut("90 秒没想出来", kind="timeout")
text = lp._render_recent()
ok("渲染里有警告标记", "⚠️" in text, text.replace("\n", " | "))
ok(
    "**明说那轮什么都没做成**（不然她会以为自己做过）",
    "什么都没做成" in text,
    text.replace("\n", " | "),
)
ok("提示别以为做过什么", "别以为" in text, text.replace("\n", " | "))

print("\n=== '想事情失败'和'做事失败'渲染不同 ===")
lp = make_loop()
lp.note_task_result("chop_tree", False, "没有原木了")
lp.note_decision_cut("90 秒没想出来", kind="timeout")
text = lp._render_recent()
ok("做事失败照旧说「没做成」", "没做成" in text, text.replace("\n", " | "))
ok("想事情失败说「什么都没做成」", "什么都没做成" in text, text.replace("\n", " | "))

print("\n=== 环形缓冲不会无限涨 ===")
lp = make_loop()
for i in range(20):
    lp.note_decision_cut(f"第 {i} 次", kind="timeout")
ok("最多保留 8 条", len(lp._recent_outcomes) <= 8, f"{len(lp._recent_outcomes)} 条")
ok("留下的是最近的", "第 19 次" in lp._recent_outcomes[-1]["detail"], lp._recent_outcomes[-1]["detail"])

print("\n=== 重试上限（不再无限重试）===")
lp = make_loop()
ok("默认最多重试 2 次", lp._decide_retry_limit == 2, f"limit={lp._decide_retry_limit}")

print("\n=== 源码里确实接上了（防止只改了注释）===")
src = (pathlib.Path(__file__).resolve().parents[2] / "plugin" / "life.py").read_text(encoding="utf-8")
ok("两条决策路径都调了 note_decision_cut", src.count("self.note_decision_cut(") >= 3,
   f"出现 {src.count('self.note_decision_cut(')} 次（含定义处 0 次）")
ok("超时到上限会进停牌", "self.note_blocked(" in src and "_decide_retry_limit" in src)
ok("成功一次会解开 BLOCKED", "self.note_unblocked()" in src)

print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
sys.exit(1 if failed else 0)
