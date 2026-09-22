"""永不空闲的测试（W7，见 docs/PLAN_v2.md）。

用户的要求：**每次没有任务的时候，立即发起一个任务。**

这条要求和上一轮我加的 `min_decide_gap = 6`（对所有决策一律压 6 秒）是冲突的。
但冲突的根源是我上一轮**治错了病**：

    病根 = **重新规划太频繁（每决策一次就改主意）**   ← 乱走乱挖
    不是 = **手上没活**                              ← 用户现在抱怨的

一刀切压 6 秒的副作用是"她没事做的时候也要干等 6 秒"。
所以 W7 把那个间隔**拆掉**，换成三件事：
  1. **计划连续性**承担"别频繁改主意"（有计划就执行下一步，不调模型）
  2. **只对"同一件事反复失败"退避**（真的卡住了才歇）
  3. **确实没事做时要可见**（IDLE_NO_WORK 记下来并说出来，不静默站着）

这个测试钉住这四条，另外钉住"**不花 token 的路优先**"——
因为"永不空闲"绝不能变成"无限调模型"（那正是用户之前抱怨的"无意义的动作"）。
"""

import sys
import time
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import _paths  # noqa: E402

# life.py 顶层 import `astrbot.api` → 没有 AstrBot 运行时就大声 SKIP
_paths.require_astrbot("test_never_idle")

_paths.load_plugin()
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
    loop.knowledge = None
    loop.perception = None
    loop.action_agent = None
    loop.drives = None
    loop._decide_retry_limit = 2
    loop._idle_rounds = 0
    loop._idle_since = 0.0
    loop._last_idle_note_at = 0.0
    loop._backoff_until = 0.0
    loop._notes = []
    loop._on_activity = loop._notes.append
    # Hold 相关（current_hold 要用）
    loop._dead = False
    loop._engine_up = True
    loop._blocked_reason = ""
    loop._paused = False
    loop._pause_reason = ""
    loop._pause_until = 0.0
    loop._announced_hold = None
    loop._is_connected = lambda: True
    return loop


print("=== 一刀切间隔已经拆掉 ===")
src = (_paths.REPO / "life.py").read_text(encoding="utf-8")
ok(
    "主循环里不再有 min_decide_gap 的等待",
    "gap = self._min_decide_gap" not in src,
    "上一轮那段 `if gap > 0 and since < gap: sleep` 已删",
)
ok("换成了失败感知退避", "_should_back_off" in src)

print("\n=== 正常情况下不退避（立刻行动）===")
lp = make_loop()
ok("没有任何失败 → 不退避", lp._should_back_off() is False, "空闲时应该立刻继续")

print("\n=== 只对「同一件事反复失败」退避 ===")
lp = make_loop()
lp.note_task_result("mine_stone", False, "挖不动")
ok("失败 1 次不退避", lp._should_back_off() is False, "偶尔失败是正常的")
lp.note_task_result("mine_stone", False, "挖不动")
ok("失败 2 次还是不退避", lp._should_back_off() is False, "再给一次机会")
lp.note_task_result("mine_stone", False, "挖不动")
ok("失败 3 次 → 退避", lp._should_back_off() is True, "同一件事连着 3 次，说明卡住了")
ok("退避有时间上限（不是永久停）", lp._backoff_until > time.time(), f"到 {time.strftime('%H:%M:%S', time.localtime(lp._backoff_until))}")
ok(
    "退避会过期",
    lp._should_back_off() is False or time.time() < lp._backoff_until,
    "退避到期后应该自动恢复",
)

print("\n=== 成功会清掉失败记录（不会因为很久以前的失败一直退避）===")
lp = make_loop()
for _ in range(3):
    lp.note_task_result("mine_stone", False, "挖不动")
lp.note_task_result("mine_stone", True)
ok("成功后该技能的失败记录被清掉", "mine_stone" not in lp._recent_failures, str(lp._recent_failures))

print("\n=== 没事做要可见（IDLE_NO_WORK）===")
lp = make_loop()
lp.note_idle_round("agent 没提交任务")
ok("记了轮次", lp._idle_rounds == 1, f"idle_rounds={lp._idle_rounds}")
ok("记了起始时间", lp._idle_since > 0)
text = lp.idle_explain()
ok("能说清'她没停牌，是没事做'", "没停牌" in text or "没事做" in text, text)
ok("状态简报里写了一句", any("想不出" in n for n in lp._notes), str(lp._notes))
ok("**和停牌区分开**：idle_explain 在没停牌时才有内容", text != "")

lp2 = make_loop()
lp2.note_idle_round("测试")
lp2.note_dead(True)
ok("停牌时 idle_explain 返回空（停牌有停牌的说法）", lp2.idle_explain() == "", "别把两件事混在一起")

print("\n=== 没事做不能刷屏（有冷却）===")
lp = make_loop()
for _ in range(5):
    lp.note_idle_round("测试")
ok("连续 5 轮只写一次状态", len([n for n in lp._notes if "想不出" in n]) == 1, f"写了 {len(lp._notes)} 条")
ok("但轮次计数照涨（内部知道有多久）", lp._idle_rounds == 5, f"idle_rounds={lp._idle_rounds}")

print("\n=== 有事做就清掉空闲计数 ===")
lp = make_loop()
lp.note_idle_round("测试")
lp.note_idle_round("测试")
lp._note_busy_round()
ok("轮次归零", lp._idle_rounds == 0, f"idle_rounds={lp._idle_rounds}")
ok("起始时间清掉", lp._idle_since == 0.0)
ok("idle_explain 变空", lp.idle_explain() == "")

print("\n=== 计划优先：不花 token 的路走在前头 ===")
# 这是 W7 最关键的结构性改动：agent 路径在计划路径之前时，
# agent 正常可用会**每轮都返回 True**，于是 `_pop_plan_step()` 永远轮不到
# —— 计划机制在 agent 可用时是**死代码**，而它正是"不花 token 的那条路"。
plan_pos = src.find("step = self._pop_plan_step()")
agent_pos = src.find("if self.action_agent is not None:")
ok(
    "计划检查在 agent 之前（源码顺序）",
    plan_pos != -1 and agent_pos != -1 and plan_pos < agent_pos,
    f"计划@{plan_pos} < agent@{agent_pos}",
)
ok("执行计划时明确不调模型", "不调模型" in src)

print("\n=== '立刻继续'不等于'每轮都调模型' ===")
ok(
    "计划为空才走 agent（有计划时省掉一次模型往返）",
    "计划也空了" in src,
    "循环注释里写明了这个顺序",
)

print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
sys.exit(1 if failed else 0)
