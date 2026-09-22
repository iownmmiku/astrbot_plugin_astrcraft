"""生存顾问与「防死循环」闸门的测试。

为什么要专门测这个：这一层是**决策逻辑**，出错的表现不是崩溃而是
"她一直在做傻事"——比如实测过的"同一个失败技能重复一小时"。
那种问题在日志里不显眼，所以必须有断言守住。
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import _paths  # noqa: E402

# **需要 AstrBot 运行时**（`life.py` / `advisor.py` 顶层就 import `astrbot.api`）。
# 环境缺失时大声 SKIP，而不是抛一个看着像"测试坏了"的 ModuleNotFoundError。
_paths.require_astrbot("test_advisor")

# 用包导入方式（life.py 内部是相对导入 `from .advisor import ...`）
_paths.load_plugin()
from astrcraft_plugin import advisor as A  # noqa: E402
from astrcraft_plugin import life as L  # noqa: E402

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  ✅ {name}" + (f" — {detail}" if detail else ""))
    else:
        failed += 1
        print(f"  ❌ {name}" + (f" — {detail}" if detail else ""))


print("=== 生存顾问：阶段判定与建议 ===")
cases = [
    ({}, "chop_tree", "一穷二白先砍树"),
    ({"oak_log": 4}, "make_tools", "有木头先做工具"),
    ({"wooden_pickaxe": 1, "oak_log": 4}, "mine_stone", "木镐→挖石头换石镐"),
    ({"stone_pickaxe": 1, "cobblestone": 40}, "build_shelter", "有材料→盖房"),
    ({"stone_pickaxe": 1, "cobblestone": 6}, "mine_stone", "材料不够→先攒建材"),
    ({"iron_pickaxe": 1, "cobblestone": 64, "bread": 3}, "mine_ores", "定居后→攒铁矿"),
]
for inv, want, label in cases:
    adv = A.advise(inv, has_shelter=(want == "mine_ores"))
    check(f"{label}", adv.skill == want, f"得到 {adv.skill}（{adv.why[:24]}）")

print("\n=== 前置条件标记（hard）===")
a1 = A.advise({})
check("一穷二白时建议是硬性的（不该去做别的）", a1.hard is True)
a2 = A.advise({"stone_pickaxe": 1, "cobblestone": 64}, has_shelter=False)
check("材料够时盖房不是硬性的（白天可以先玩别的）", a2.hard is False)

print("\n=== 危险与压力提示 ===")
a3 = A.advise({"stone_pickaxe": 1}, health=4)
check("血量很低会提醒别去冒险", any("血量" in w for w in a3.warnings), a3.warnings[0][:30] if a3.warnings else "")
a4 = A.advise({}, food=3)
check("很饿且没食物会提醒", any("饿" in w for w in a4.warnings))
a5 = A.advise({"wooden_pickaxe": 1}, is_night=True, has_shelter=False)
check(
    "天黑且没住处、而建议不是盖房时会提醒",
    any("黑" in w and "住处" in w for w in a5.warnings),
    f"stage={a5.stage} skill={a5.skill}",
)
a5b = A.advise({"stone_pickaxe": 1, "cobblestone": 40}, is_night=True, has_shelter=False)
check(
    "已经在建议盖房时不再重复念叨天黑",
    a5b.skill == "build_shelter" and not any("黑" in w for w in a5b.warnings),
    f"建议 {a5b.skill}",
)
a6 = A.advise({"stone_pickaxe": 1}, inventory_slots_used=36)
check("背包快满会提醒", any("背包" in w for w in a6.warnings))

print("\n=== 失败记忆会影响提示 ===")
a7 = A.advise({"wooden_pickaxe": 1}, recent_failures={"mine_stone": 3})
check(
    "反复失败的技能会被点名",
    any("mine_stone" in w and "失败" in w for w in a7.warnings),
    next((w[:40] for w in a7.warnings if "mine_stone" in w), ""),
)

print("\n=== 工具/阶段识别的边界 ===")
check("钻石镐算定居级", A.best_tool_tier({"diamond_pickaxe": 1}, ("pickaxe",)) == "diamond")
check("木斧能识别为斧", A.best_tool_tier({"wooden_axe": 1}, ("axe",)) == "wooden")
check("数量为 0 不算拥有", A.best_tool_tier({"iron_pickaxe": 0}, ("pickaxe",)) is None)
check(
    "石制材料三种都算（圆石/深板岩圆石/黑石）",
    A.count_any({"cobblestone": 1, "cobbled_deepslate": 2, "blackstone": 3}, A.STONE_MATERIALS) == 6,
)

print("\n=== 决策权在 LLM：失败后先「再问一次」，而不是替他决定 ===")


def make_loop(llm=None) -> "L.LifeLoop":
    async def _noop(*a, **k):
        return None

    return L.LifeLoop(
        engine_call=_noop,
        memory=type("M", (), {"remember": lambda *a, **k: None, "recall": lambda *a, **k: [], "render_for_prompt": lambda *a, **k: ""})(),
        drives=type("D", (), {"tick": lambda *a, **k: None, "suggest_activity": lambda *a, **k: {"activity": "x", "label": "y", "level": 1, "voice": "z", "drive": "gather"}})(),
        brief_provider=_noop,
        llm=llm or _noop,
        system_prompt_provider=_noop,
    )


SUGGESTION = {"activity": "去挖矿", "label": "手痒", "level": 1, "voice": "想干活", "drive": "gather"}


async def test_reconsider_changes_mind():
    prompts: list[str] = []

    async def fake_llm(prompt, system=None, umo=None):
        prompts.append(prompt)
        return '{"activity":"换个地方砍树","skill":"chop_tree","params":{"count":4},"intention":"攒点木头","say":null,"reason":"上次是地形问题"}'

    loop = make_loop(llm=fake_llm)
    for _ in range(3):
        loop.note_task_result("mine_stone", False, "连续多次没有进展")
    bad = L.LifeDecision(activity="再去挖石头", drive="gather", skill="mine_stone", params={"count": 8})
    out = await loop._reconsider_if_looping(bad, "PROMPT", "SYSTEM", SUGGESTION)
    check("会把「失败过 3 次」明确告诉她", any("失败 3 次" in p for p in prompts))
    check("她改主意后尊重新选择（不是被规则改掉）", out.skill == "chop_tree", f"得到 {out.skill}")


async def test_reconsider_honors_insistence():
    async def fake_llm(prompt, system=None, umo=None):
        return '{"activity":"还是想挖石头","skill":"mine_stone","params":{"count":8},"say":null,"reason":"这次往山下挖，换个地方"}'

    loop = make_loop(llm=fake_llm)
    for _ in range(3):
        loop.note_task_result("mine_stone", False, "x")
    bad = L.LifeDecision(activity="挖石头", drive="gather", skill="mine_stone", params={})
    out = await loop._reconsider_if_looping(bad, "PROMPT", "SYSTEM", SUGGESTION)
    check("她坚持时尊重她的决定（3 次还没到兜底线）", out.skill == "mine_stone", f"得到 {out.skill}")


async def test_reconsider_fallback_on_deadloop():
    async def fake_llm(prompt, system=None, umo=None):
        return '{"activity":"继续挖石头","skill":"mine_stone","params":{},"say":null,"reason":"就是要挖"}'

    loop = make_loop(llm=fake_llm)
    for _ in range(5):
        loop.note_task_result("mine_stone", False, "x")
    loop._last_advice = A.advise({})  # 一穷二白 → chop_tree
    bad = L.LifeDecision(activity="挖石头", drive="gather", skill="mine_stone", params={})
    out = await loop._reconsider_if_looping(bad, "PROMPT", "SYSTEM", SUGGESTION)
    check("失败 5 次仍坚持时退回兜底（避免一小时死循环）", out.skill == "chop_tree", f"得到 {out.skill}")


asyncio.run(test_reconsider_changes_mind())
asyncio.run(test_reconsider_honors_insistence())
asyncio.run(test_reconsider_fallback_on_deadloop())

print("\n=== 连续的打算（intention）：由 LLM 设定、跨轮保持 ===")
loop_i = make_loop()
d1 = L.LifeDecision(activity="砍树", drive="gather", skill="chop_tree", params={}, intention="盖一个能过夜的小屋")
loop_i._note_intention(d1)
check("LLM 设定的打算被记住", loop_i._intention == "盖一个能过夜的小屋")
check("打算从第 1 轮开始计数", loop_i._intention_rounds == 1)

d2 = L.LifeDecision(activity="挖石头", drive="gather", skill="mine_stone", params={}, intention="盖一个能过夜的小屋")
loop_i._note_intention(d2)
check("同一打算会累加轮数", loop_i._intention_rounds == 2, f"{loop_i._intention_rounds} 轮")

d3 = L.LifeDecision(activity="发呆", drive="leisure", skill=None, params={}, intention=None)
loop_i._note_intention(d3)
check("模型漏了 intention 字段时不清空她的打算（防误伤）", loop_i._intention == "盖一个能过夜的小屋")

d4 = L.LifeDecision(activity="逛风景", drive="leisure", skill=None, params={}, intention="")
loop_i._note_intention(d4)
check("模型明确填 null/空时才放下打算", loop_i._intention == "")

d5 = L.LifeDecision(activity="挖矿", drive="gather", skill="mine_ores", params={}, intention="攒够做铁镐的材料")
loop_i._note_intention(d5)
check("换新打算会重新计数", loop_i._intention == "攒够做铁镐的材料" and loop_i._intention_rounds == 1)

print("\n=== 建过庇护所会被记住 ===")
loop3 = make_loop()
loop3.note_task_result("build_shelter", True)
check("庇护所建成后 has_shelter=True", loop3._has_shelter is True)
adv3 = A.advise({"stone_pickaxe": 1, "cobblestone": 64}, has_shelter=loop3._has_shelter)
check("有住处后不再建议盖房", adv3.skill != "build_shelter", f"建议 {adv3.skill}")

print("\n=== 近期经历（真人决策时会回想刚才发生了什么）===")
loop_r = make_loop()
loop_r.note_task_result("chop_tree", False, "附近找不到树")
loop_r.note_task_result("mine_stone", True)
text = loop_r._render_recent()
check("记下了没做成的事和原因", "chop_tree" in text and "附近找不到树" in text, text.split("\n")[-1].strip()[:40])
check("也记下了做成的事", "mine_stone" in text and "做成了" in text)

loop_r.note_death({"x": 100, "y": 12, "z": 200})
text2 = loop_r._render_recent()
check("死亡地点会告诉她", "100" in text2 and "200" in text2)
check("并且提醒东西会消失（掉落物 5 分钟）", "5 分钟" in text2, "提示掉落物时限")
# **契约变了**（C 批次，见 docs/DEATH_RECOVERY.md）：
# 原来这里断言"你自己决定"——那句话**没给她判断依据**，而掉落物 5 分钟就消失，
# 她很可能花 6 分钟走回去、什么都没捡到（**比不去更糟**）。
# 现在给她可执行的判据："能在 2 分钟内走到就去，否则别去"。
check(
    "给了可执行的判断依据（不是丢一句「你自己决定」）",
    "2 分钟" in text2 and "别去" in text2,
    "掉落物 5 分钟消失 → 给她'能不能在 2 分钟内走到'这个判据",
)
# **死亡时要写恢复清单**（C 批次的核心）：她死后身上什么都没有，
# 而泥土徒手就能挖、立刻"成功"，做木镐要先砍树、容易失败——
# 没有清单她就会一直挖泥土（用户实测反馈）。
check(
    "死亡时写入了恢复清单（先砍树 → 做木镐）",
    len(loop_r._todos) >= 3
    and any("砍树" in t["text"] for t in loop_r._todos)
    and any("木镐" in t["text"] for t in loop_r._todos),
    f"{len(loop_r._todos)} 条",
)
check(
    "死亡时丢掉了死前的打算（不然她还惦记着'盖房子'）",
    loop_r._intention == "",
    f"intention={loop_r._intention!r}",
)

# 很久以前的死亡不该再念叨（东西早没了）
loop_r._last_death["at"] -= 4000
text3 = loop_r._render_recent()
check("太久远的死亡不再提醒（东西早消失了）", "死了" not in text3, "已清理")

print("\n=== 最近做过的事有上限（不会无限增长）===")
loop_r2 = make_loop()
for i in range(20):
    loop_r2.note_task_result(f"skill_{i}", True)
check("只保留最近 8 条", len(loop_r2._recent_outcomes) == 8, f"{len(loop_r2._recent_outcomes)} 条")

print("\n=== 卡住的打算会被点出来（真人这时会停下来想想）===")


async def test_stuck_intention_hint():
    prompts: list[str] = []

    async def fake_llm(prompt, system=None, umo=None):
        prompts.append(prompt)
        return '{"activity":"x","skill":null,"params":{},"intention":null,"say":null,"reason":"y"}'

    async def fake_state():
        return {"inventory": {}, "health": 20, "food": 20}

    async def brief():
        return "位置 (0,64,0)"

    async def sysp():
        return "你是纱雾"

    async def noop(*a, **k):
        return None

    loop = make_loop(llm=fake_llm)
    loop._brief = brief
    loop._system_prompt = sysp
    loop._state_provider = fake_state
    loop._intention = "盖一个能过夜的小屋"
    loop._intention_rounds = 5
    loop._intention_since = time.time() - 600
    for _ in range(3):
        loop.note_task_result("build_shelter", False, "材料凑不齐")
    await loop.decide()
    p = prompts[0] if prompts else ""
    check("会点出已经做了几轮", "已经做了 5 轮" in p)
    check("会点出最近失败了几次", "最近失败了 3 次" in p)
    check("会提示她可以放弃这个打算", "放弃这个打算" in p)


asyncio.run(test_stuck_intention_hint())

print("\n=== 渲染给 LLM 的片段 ===")
text = A.advise_for_prompt(A.advise({"wooden_pickaxe": 1}, recent_failures={"mine_stone": 3}))
check("包含【你的生存现状】标题", "【你的生存现状】" in text)
check("包含阶段", "阶段" in text)
check("包含建议下一步", "建议下一步" in text)
check("包含注意项", "注意" in text)

print("\n=== 端到端：建议真的进了提示词，闸门真的改写了决定 ===")


class _Mem:
    def remember(self, *a, **k):
        return None

    def recall(self, *a, **k):
        return []

    def render_for_prompt(self, *a, **k):
        return ""


class _Drives:
    def tick(self):
        return None

    def suggest_activity(self):
        return {"activity": "去挖矿", "label": "手痒", "level": 0.6, "voice": "想干点活", "drive": "gather"}


async def _integration() -> None:
    prompts: list[str] = []
    calls = {"n": 0}

    async def fake_llm(prompt, system=None, umo=None):
        prompts.append(prompt)
        calls["n"] += 1
        if calls["n"] == 1:
            # 第一次故意选一个"最近反复失败"的技能
            return '{"activity":"再去挖石头","skill":"mine_stone","params":{"count":8},"say":null,"reason":"手痒"}'
        # 被"再问一次"之后，她改主意了（决定权在她）
        return (
            '{"activity":"先砍点木头","skill":"chop_tree","params":{"count":4},'
            '"intention":"先攒点木头再做工具","say":null,"reason":"刚才那个一直失败，换个前置条件"}'
        )

    async def fake_state():
        # 一穷二白 + 没有木头 → 顾问应该建议 chop_tree
        return {"inventory": {}, "health": 20, "food": 20, "has_shelter": False, "is_night": False}

    async def noop(*a, **k):
        return None

    loop2 = L.LifeLoop(
        engine_call=noop,
        memory=_Mem(),
        drives=_Drives(),
        brief_provider=lambda: _async("位置 (0,64,0) 主世界"),
        llm=fake_llm,
        system_prompt_provider=lambda: _async("你是纱雾"),
        state_provider=fake_state,
        decide_interval=1,
    )
    # 制造"挖石头连续失败 3 次"的历史
    for _ in range(3):
        loop2.note_task_result("mine_stone", False, "连续多次没有进展")

    decision = await loop2.decide()
    check("提示词里包含【你的生存现状】", any("【你的生存现状】" in p for p in prompts))
    check("提示词里包含建议下一步", any("建议下一步" in p for p in prompts))
    check(
        "提示词里包含失败记忆的提醒",
        any("失败 3 次" in p or "反复失败" in p for p in prompts),
    )
    check("失败后会再问她一次（第二次提示里点明失败次数）", calls["n"] >= 2 and any("已经失败 3 次" in p for p in prompts))
    check(
        "她改主意后的选择被采纳（决定权在 LLM）",
        decision is not None and decision.skill == "chop_tree",
        f"最终技能 {getattr(decision, 'skill', None)}",
    )
    check(
        "她的打算被记住（intention 生效）",
        decision is not None and (decision.intention or "") != "" and loop2._intention != "",
        f"打算：{getattr(decision, 'intention', None)}",
    )


async def _async(text):
    return text


asyncio.run(_integration())

print("\n=== 结果 ===")
if failed == 0:
    print(f"✅ 全部通过（{passed} 项断言）")
    sys.exit(0)
print(f"❌ {failed} 项失败（{passed} 项通过）")
sys.exit(1)
