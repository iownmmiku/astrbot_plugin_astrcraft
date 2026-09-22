"""**C 批次：agent 路径产出计划**（治「每次停下来思考的时间太长」）。

## 这条测试要钉住什么

用户反馈：「每次停下来思考的时间太长了，动作也不够流畅」。

根因之一（结构性）：`_act_via_agent()` 走 agent 路径时**每轮决策都要过一次模型**，
一次决策最多 6 轮往返（`MAX_STEPS=6`）；而「有计划就直接执行下一步、不调模型"
那条路**只在旧路径 `decide()` 下生效** ——
**计划机制在 agent 可用时是死的**（agent 每轮都返回」我处理了「，
于是 `_pop_plan_step()` 永远拿到空计划）。

C 批次做的事：让 agent 能用 `mc_plan_do` 留下接下来的几步，
循环在下一轮把它装进计划表，**然后就不再调模型**。

## 测什么

① `note_plan_from_agent` 收得下计划、且**核对技能名**（防」计划指向不存在的技能"
   —— 那正是 D 批次 `check_capabilities.py` 要防的那类病）
② 拿不到技能清单时 **fail-open**（引擎没起来不该因此把她锁死）
③ **核心断言**：agent 写了计划之后，`_pop_plan_step()` 能拿到，
   而且循环走的是「按计划执行」那条分支（**不调模型**）
"""

from __future__ import annotations

import sys
import pathlib

# **用他们的 _paths.py 加载插件包**（life.py 用的是相对导入 `from .inbox import ...`，
# 直接 `import life` 会报 "attempted relative import with no known parent package"）。
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import _paths  # noqa: E402

_paths.load_plugin()
LifeLoop = _paths.plugin_module("life").LifeLoop

passed = 0
failed = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✅ {label}" + (f" — {detail}" if detail else ""))
    else:
        failed += 1
        print(f"  ❌ {label}" + (f" — {detail}" if detail else ""))


def make_loop(known: list | None = None) -> LifeLoop:
    """造一个**只测计划逻辑**的 LifeLoop（不连引擎、不起循环）。"""
    lp = LifeLoop.__new__(LifeLoop)
    lp._plan = []
    lp._pending_plan = []
    lp._plan_source = ""
    lp._known_skills = list(known) if known is not None else []
    lp._intention = ""
    lp._todos = []
    return lp


print("=== ① 收下计划 + 核对技能名 ===")
lp = make_loop(known=["chop_tree", "make_tools", "mine_stone"])
r = lp.note_plan_from_agent([{"skill": "chop_tree"}, {"skill": "make_tools"}], why="先有木头")
check("收下了 2 步", r.get("ok") and r.get("accepted") == 2, str(r.get("steps")))
check("步骤顺序保住了", r.get("steps") == ["chop_tree", "make_tools"], str(r.get("steps")))
check("写进了 _pending_plan", len(lp._pending_plan) == 2, f"{len(lp._pending_plan)} 步")
check("返回里说明了「下一轮不再问模型」", "不再问模型" in str(r.get("note")), str(r.get("note"))[:40])

print("\n=== ② 不存在的技能要被拦下（防「计划指向不存在的动作」）===")
lp2 = make_loop(known=["chop_tree"])
r2 = lp2.note_plan_from_agent([{"skill": "chop_tree"}, {"skill": "mc_skill_run"}])
check("认得出的那步收下了", r2.get("ok") and r2.get("accepted") == 1, str(r2.get("steps")))
check("不存在的那步被拦下并报出来", "mc_skill_run" in (r2.get("unknown") or []), str(r2.get("unknown")))
lp3 = make_loop(known=["chop_tree"])
r3 = lp3.note_plan_from_agent([{"skill": "mc_skill_run"}])
check("全是假技能 → 整份不收", not r3.get("ok"), str(r3.get("reason"))[:50])
check("并且没污染 _pending_plan", len(lp3._pending_plan) == 0, f"{len(lp3._pending_plan)} 步")
check("报错里给了真实技能名（她才能改对）", bool(r3.get("known_skills")), str(r3.get("known_skills")))

print("\n=== ③ 拿不到技能清单时 fail-open（引擎没起来不该锁死她）===")
lp4 = make_loop(known=[])  # 引擎没起来
r4 = lp4.note_plan_from_agent([{"skill": "chop_tree"}, {"skill": "随便什么"}])
check("清单为空时放行（不因为「我不知道」就拒绝）", r4.get("ok") and r4.get("accepted") == 2, str(r4.get("steps")))

print("\n=== ④ 宽容：模型直接给技能名（字符串）也认 ===")
lp5 = make_loop(known=["chop_tree", "mine_stone"])
r5 = lp5.note_plan_from_agent(["chop_tree", "mine_stone"])
check("字符串形式也收", r5.get("ok") and r5.get("accepted") == 2, str(r5.get("steps")))

print("\n=== ⑤ 核心：agent 写的计划，下一轮能被 _pop_plan_step 拿到（= 不调模型）===")
lp6 = make_loop(known=["chop_tree", "make_tools", "mine_stone"])
lp6.note_plan_from_agent([{"skill": "chop_tree"}, {"skill": "make_tools"}])
check("此时 _plan 还是空的（还没到下一轮）", len(lp6._plan) == 0, f"{len(lp6._plan)} 步")
check("但 _pending_plan 里有 2 步（等着下一轮装）", len(lp6._pending_plan) == 2)

# 模拟循环顶部那一步：把 agent 的计划装进计划表
if lp6._pending_plan and not lp6._plan:
    lp6._set_plan(lp6._pending_plan, source="agent")
    lp6._pending_plan = []
check("装进 _plan 了", len(lp6._plan) == 2, f"{len(lp6._plan)} 步")
check("来源标成 agent（可追溯）", lp6._plan_source == "agent", lp6._plan_source)

step = lp6._pop_plan_step()
check("**第一步能取出来**（循环就是靠这个不调模型的）", step is not None and step.get("skill") == "chop_tree", str(step))
step2 = lp6._pop_plan_step()
check("第二步也能取出来（连贯执行）", step2 is not None and step2.get("skill") == "make_tools", str(step2))
check("取完之后计划空了（不会重复做）", len(lp6._plan) == 0, f"{len(lp6._plan)} 步")
check("再取返回 None（该回去调模型了）", lp6._pop_plan_step() is None)

print("\n=== ⑥ 不会覆盖已经排好的计划 ===")
# **known 要给全**：他们的 _set_plan 会核对技能名（比我们这边更严，是好事），
# 只给 chop_tree 的话 mine_stone 会被过滤掉，计划就空了、这条断言测不到东西。
lp7 = make_loop(known=["chop_tree", "mine_stone"])
lp7._set_plan([{"skill": "mine_stone"}], source="llm")
lp7.note_plan_from_agent([{"skill": "chop_tree"}])
# 循环里的条件是 `if self._pending_plan and not self._plan` → 有计划在跑就不装新的
if lp7._pending_plan and not lp7._plan:
    lp7._set_plan(lp7._pending_plan, source="agent")
check("正在跑的计划没被顶掉", len(lp7._plan) == 1 and lp7._plan[0]["skill"] == "mine_stone", str(lp7._plan))

print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
sys.exit(1 if failed else 0)
