"""Hold 停牌表的测试（W2，见 docs/PLAN_v2.md）。

钉住的是**"她为什么没在动"只有一个答案，而且每种停牌都有人能解开**。

改之前的样子：`_paused` / `_pause_until` / `_busy_until` / `_is_connected()` /
`_engine_busy()` 五个条件散在主循环里，每个都静默 `continue` —— 她不动时
日志里只有一行"跳过"，没人说得清是哪一个。`_auto_resume_if_expired()` 是
给 `_paused` 打的补丁，它自己的注释写着"早期版本只 pause、靠 task.finished
resume，结果工具执行失败时根本不会有任务产生，于是她永久停滞"。

所以这个测试要证明三件事：
  1. **优先级与合成**：多个停牌同时成立时，答案是确定的
  2. **每一种都能被解开**：每个 Hold 都有释放路径，没有"永久停滞"的状态
  3. **变化沿只报一次**：停牌期间反复调用不刷屏
"""

import sys
import time
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import _paths  # noqa: E402

# **需要 AstrBot 运行时**：`life.py` 在模块顶层就 `from astrbot.api import logger`，
# 没有它连 import 都过不去。用 `require_astrbot` 而不是让它抛
# `ModuleNotFoundError`——环境缺失要**大声说清缺什么**，而不是伪装成"测试失败"。
_paths.require_astrbot("test_hold")

_paths.load_plugin()
from astrcraft_plugin.life import HOLD_RELEASE, HOLD_WHY, Hold, LifeLoop  # noqa: E402

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


def make_loop(*, connected=True, engine_up=True):
    """造一个只带 Hold 相关字段的 LifeLoop（不走完整 __init__）。

    `__init__` 需要一堆回调和 provider；Hold 的判断只依赖几个布尔量，
    所以这里直接把字段摆好——测的是判断逻辑，不是装配。
    """
    loop = LifeLoop.__new__(LifeLoop)
    loop._dead = False
    loop._engine_up = engine_up
    loop._blocked_reason = ""
    loop._paused = False
    loop._pause_reason = ""
    loop._pause_until = 0.0
    loop._announced_hold = None
    loop._is_connected = lambda: connected
    return loop


print("=== 没停牌时是 NONE ===")
lp = make_loop()
ok("一切正常 → NONE", lp.current_hold() is Hold.NONE, lp.current_hold().value)
ok("NONE 的说明是人话", "正常" in lp.hold_explain(), lp.hold_explain())

print("\n=== 五种停牌各自成立 ===")
for label, act, want, conn in [
    ("死亡", lambda x: x.note_dead(True), Hold.DEAD, True),
    ("没进服", lambda x: None, Hold.DISCONNECTED, False),
    ("引擎没了", lambda x: x.note_engine_up(False), Hold.ENGINE_DOWN, True),
    ("主人暂停", lambda x: x.pause(reason="测试"), Hold.PAUSED_BY_OWNER, True),
    ("模型不可用", lambda x: x.note_blocked("provider 没配"), Hold.BLOCKED, True),
]:
    loop = make_loop(connected=conn)
    act(loop)
    got = loop.current_hold()
    ok(f"{label} → {want.value}", got is want, f"实际 {got.value}")

print("\n=== 优先级是确定的（同时成立时谁说了算）===")
lp = make_loop(connected=False, engine_up=False)
lp.note_dead(True)
lp.pause(reason="测试")
lp.note_blocked("测试")
ok("全都不满足时，死排最前（死着说'没进服'是废话）", lp.current_hold() is Hold.DEAD)

lp.note_dead(False)
ok("不死之后 → 掉线优先于引擎/暂停/模型", lp.current_hold() is Hold.DISCONNECTED)

lp2 = make_loop(connected=True, engine_up=False)
lp2.pause(reason="测试")
lp2.note_blocked("测试")
ok("引擎没了优先于暂停和模型", lp2.current_hold() is Hold.ENGINE_DOWN)

lp3 = make_loop()
lp3.pause(reason="测试")
lp3.note_blocked("测试")
ok("暂停优先于模型不可用", lp3.current_hold() is Hold.PAUSED_BY_OWNER)

print("\n=== 每一种停牌都有人能解开（没有'永久停滞'）===")
for h in Hold:
    if h is Hold.NONE:
        continue
    rel = HOLD_RELEASE.get(h, "")
    ok(f"{h.value} 有释放路径", bool(rel.strip()), rel or "（空——这就是永久停滞）")

lp = make_loop()
lp.note_dead(True)
ok("死亡后是 DEAD", lp.current_hold() is Hold.DEAD)
lp.note_dead(False)
ok("复活后回到 NONE", lp.current_hold() is Hold.NONE, "note_dead(False)")

lp.note_engine_up(False)
ok("引擎没了 → ENGINE_DOWN", lp.current_hold() is Hold.ENGINE_DOWN)
lp.note_engine_up(True)
ok("引擎起来 → NONE", lp.current_hold() is Hold.NONE, "note_engine_up(True)")

lp.pause(reason="测试")
ok("暂停 → PAUSED_BY_OWNER", lp.current_hold() is Hold.PAUSED_BY_OWNER)
lp.resume()
ok("恢复 → NONE", lp.current_hold() is Hold.NONE, "resume()")

lp.note_blocked("provider 没配")
ok("模型不可用 → BLOCKED", lp.current_hold() is Hold.BLOCKED)
lp.note_unblocked()
ok("端点恢复 → NONE", lp.current_hold() is Hold.NONE, "note_unblocked()")

lp.pause(reason="测试", max_seconds=0.01)
time.sleep(0.05)
lp._auto_resume_if_expired()
ok("暂停超时能自动恢复", lp.current_hold() is Hold.NONE, "max_seconds 到期")

print("\n=== 变化沿只报一次（停牌期间不刷屏）===")
lp = make_loop()
lp._announced_hold = Hold.NONE
lp.note_blocked("测试")
first = lp._announced_hold
for _ in range(10):
    lp._announce_hold()
ok("状态没变时反复调用不改变 announced", lp._announced_hold is first, f"announced={first.value}")
ok("状态确实变成了 BLOCKED", first is Hold.BLOCKED, f"announced={first.value}")
lp.note_unblocked()
ok("解除后 announced 跟着回到 NONE", lp._announced_hold is Hold.NONE)

print("\n=== 说明文字必须包含'谁来解开' ===")
lp = make_loop()
lp.note_blocked("provider 没配好")
text = lp.hold_explain()
ok("BLOCKED 的说明里有原因", "provider 没配好" in text, text)
ok("BLOCKED 的说明里有解开条件", "解开条件" in text, text)
lp2 = make_loop()
lp2.pause(reason="主人在用她")
ok("PAUSED 的说明里有暂停原因", "主人在用她" in lp2.hold_explain(), lp2.hold_explain())

print("\n=== 每个 Hold 都有给人看的说明 ===")
_missing = [h.value for h in Hold if not HOLD_WHY.get(h, "").strip()]
ok("HOLD_WHY 覆盖全部状态", not _missing, f"缺: {_missing}" if _missing else "全覆盖")

print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
sys.exit(1 if failed else 0)
