"""过日子循环的节奏测试：唤醒机制。

为什么要专门测这个：
实测她的**决策间隔是 190~200 秒**（配置里写的 90 秒），
因为循环里是"固定 sleep 90 秒" + "动作后再压 120 秒"。
哪怕技能 10 秒就做完了，她也要干站着三分半才想下一件事——
用户看到的就是"她还是不能自己活动"。

修法是"可被唤醒的等待"：任务一结束就立刻叫醒她继续想。
这个测试把两条行为都钉住：
  1. 唤醒后能立刻继续（不必等满间隔）
  2. 她正忙的时候不要打扰（别打断正在跑的技能）
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent.parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(Path(r"D:\AstrBot\backend\app")))

from plugin import life as L  # noqa: E402

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


acts: list[float] = []
_orig_act = L.LifeLoop._act


async def _traced_act(self, decision):
    acts.append(time.time())
    return await _orig_act(self, decision)


L.LifeLoop._act = _traced_act


class _Mem:
    def remember(self, *a, **k):
        return None

    def recall(self, *a, **k):
        return []

    def render_for_prompt(self, *a, **k):
        return ""


class _Drv:
    def tick(self):
        return None

    def save(self):
        return None

    def suggest_activity(self):
        return {"activity": "发呆", "label": "悠闲", "level": 0.5, "voice": "没什么想做的", "drive": "leisure"}

    def note_activity(self, **k):
        return None


async def _llm(prompt, system=None, umo=None):
    return '{"activity":"待着","skill":null,"params":{},"intention":null,"say":null,"reason":"x"}'


async def _engine_call(method, params=None, **kw):
    # task.list 必须返回"不忙"，否则循环会一直跳过（这是有意的保守设计）
    return {"current": None, "queued": 0} if method == "task.list" else {"ok": True}


async def _brief():
    return "位置 (0,64,0)"


async def _sysp():
    return "你是纱雾"


async def _state():
    return {"inventory": {}, "health": 20, "food": 20}


async def main() -> None:
    print("=== 过日子循环的节奏（唤醒机制）===")
    loop = L.LifeLoop(
        engine_call=_engine_call,
        memory=_Mem(),
        drives=_Drv(),
        brief_provider=_brief,
        llm=_llm,
        system_prompt_provider=_sysp,
        state_provider=_state,
        # 测试里用短间隔：循环开头有 20 秒"进服后先等一会儿"，
        # 间隔取 8 秒才能在 30 秒内稳定看到第一次决定。
        decide_interval=8,
    )
    loop.start()
    await asyncio.sleep(30)
    n0 = len(acts)
    check("循环能自己跑起来并做出决定", n0 >= 1, f"30 秒内行动 {n0} 次")

    print("\n--- 唤醒：任务结束应立刻继续想 ---")
    loop._busy_until = time.time() + 300  # 模拟"刚提交技能后的等待期"
    loop.wake(reason="测试：任务结束")
    await asyncio.sleep(4)
    gained = len(acts) - n0
    check(
        "唤醒后 4 秒内就继续想（不必等满间隔）",
        gained > 0,
        f"新增 {gained} 次行动",
    )

    print("\n--- 对照：她正忙的时候不要打扰 ---")
    loop._busy_until = time.time() + 300
    b2 = len(acts)
    await asyncio.sleep(10)
    n2 = len(acts) - b2
    check("忙的时候不会插进来（不打断正在跑的技能）", n2 == 0, f"新增 {n2} 次")

    print("\n--- 唤醒会清掉 busy 标记 ---")
    loop._busy_until = time.time() + 300
    loop.wake()
    check("wake() 清掉了 busy_until", loop._busy_until == 0.0, f"busy_until={loop._busy_until}")
    await loop.stop()

    print("\n=== 任务排序（计划队列）===")
    loop2 = L.LifeLoop(
        engine_call=_engine_call,
        memory=_Mem(),
        drives=_Drv(),
        brief_provider=_brief,
        llm=_llm,
        system_prompt_provider=_sysp,
        state_provider=_state,
        decide_interval=8,
    )
    # 用 json.dumps 构造，别写字符串字面量：
    # 手写 JSON 字面量在多次编辑后很容易被转义/编码搞坏
    # （实测踩过一次：文件看着没问题，但 json.loads 报 "Expecting ':' delimiter"）。
    raw = json.dumps(
        {
            "activity": "干活",
            "intention": "攒木头",
            "plan": [
                {"skill": "chop_tree", "params": {"count": 4}, "why": "砍木头"},
                {"skill": "make_tools", "params": {"tier": "wooden"}, "why": "做工具"},
                {"skill": "mine_stone", "params": {"count": 8}, "why": "挖石头"},
            ],
            "say": None,
            "reason": "按顺序来",
        },
        ensure_ascii=False,
    )
    d = loop2._parse_decision(raw, {"drive": "gather"})
    check("计划的第一步成为当前决定", d is not None and d.skill == "chop_tree", f"skill={getattr(d, 'skill', None)}")
    check(
        "剩下的步骤进队列且顺序保持",
        [p["skill"] for p in loop2._pending_plan] == ["make_tools", "mine_stone"],
        str([p["skill"] for p in loop2._pending_plan]),
    )

    loop2._set_plan(loop2._pending_plan, source="test")
    check("队列装载成功", len(loop2._plan) == 2, f"{len(loop2._plan)} 步")

    s1 = loop2._pop_plan_step()
    s2 = loop2._pop_plan_step()
    s3 = loop2._pop_plan_step()
    check(
        "出队顺序正确（先排的先做）",
        s1 and s2 and s1["skill"] == "make_tools" and s2["skill"] == "mine_stone",
        f"{s1['skill'] if s1 else None} → {s2['skill'] if s2 else None}",
    )
    check("队列空了返回 None", s3 is None)

    loop2._set_plan([{"skill": "a"}, {"skill": "b"}, {"skill": "c"}])
    loop2.note_task_result("make_tools", False, "材料不够")
    check("一步失败就丢弃剩余计划（避免连环失败）", loop2._plan == [], f"剩 {len(loop2._plan)} 步")

    loop2._set_plan([{"skill": "a"}, {"skill": "b"}])
    loop2.on_session_start()
    check("进游戏会清空旧计划、准备重排（每次进游戏生成新任务）", loop2._plan == [], f"剩 {len(loop2._plan)} 步")

    d2 = loop2._parse_decision(
        '{"activity":"发呆","skill":null,"params":{},"intention":null,"say":null,"reason":"x"}',
        {"drive": "leisure"},
    )
    check("没有 plan 字段也不报错（兼容旧格式）", d2 is not None and loop2._pending_plan == [])
    await loop2.stop()

    print("\n=== 任务清单（todo_write）===")
    loop3 = L.LifeLoop(
        engine_call=_engine_call,
        memory=_Mem(),
        drives=_Drv(),
        brief_provider=_brief,
        llm=_llm,
        system_prompt_provider=_sysp,
        state_provider=_state,
        decide_interval=8,
    )
    rendered = loop3.write_todos(["挖 60 个圆石", "做工作台和石镐", "盖 5×5 小屋", "放门和火把"])
    check("清单写入成功", len(loop3.todos) == 4, f"{len(loop3.todos)} 项")
    check("清单会渲染进提示词", "挖 60 个圆石" in rendered and "□" in rendered)
    check("清单有上限（最多 12 项）", len(loop3.write_todos([f"任务{i}" for i in range(20)]).splitlines()) <= 13)
    # 重新写一份干净的清单再测划掉（上一步的"上限"检查把清单换掉了）
    loop3.write_todos(["挖 60 个圆石", "做工作台和石镐", "盖 5×5 小屋", "放门和火把"])
    msg = loop3.mark_todo_done("2")
    check("能划掉第 2 项", loop3.todos[1]["done"] is True, msg[:30])
    check("按文字也能划掉", loop3.mark_todo_done("盖").startswith("已划掉"), "")
    check("划掉不存在的项会如实说", "没找到" in loop3.mark_todo_done("不存在的事"))

    print("\n=== 自主行动走 agent（LLM 用工具直接驱动）===")

    class _StubAgent:
        def __init__(self):
            self.called = 0

        async def act(self, *, prompt, system, umo=""):
            self.called += 1
            return "我去砍了点树", ["mc_status", "mc_skill_run"]

    class _NullAgent:
        async def act(self, *, prompt, system, umo=""):
            return None, []

    loop3.action_agent = _StubAgent()
    handled = await loop3._act_via_agent()
    check("agent 可用时这一轮由它处理", handled is True and loop3.action_agent.called == 1)
    check("这一轮被记下来（供日志与聊天用）", loop3.current is not None and "砍了点树" in loop3.current.activity)

    loop3.action_agent = _NullAgent()
    handled = await loop3._act_via_agent()
    check("agent 不可用时如实返回 False（好退回旧路径）", handled is False)

    await loop3.stop()

    print("\n=== 结果 ===")
    if failed == 0:
        print(f"✅ 全部通过（{passed} 项断言）")
        sys.exit(0)
    print(f"❌ {failed} 项失败（{passed} 项通过）")
    sys.exit(1)


asyncio.run(main())
