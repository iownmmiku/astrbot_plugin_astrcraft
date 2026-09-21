#!/usr/bin/env python3
"""测试：人格桥接 / 记忆 / 驱动力 / 过日子 四个模块能否正常工作。

不依赖 AstrBot 运行时（用假的 Context 与假的人格库），也不依赖 Minecraft。
验证的是**逻辑**：人格能不能读到、记忆能不能检索到对的东西、
驱动力会不会随时间推移、过日子的决策链路能不能走通。

这几个模块的 bug 有个共同特点：**不会报错，只会"感觉不对"**
（记忆检索不出相关的、驱动力永远不动、人格读成空）。
所以必须有测试把中间值断言下来，不能靠肉眼看。

用法：
  $env:PYTHONPATH='D:\\AstrBot\\backend\\app'
  D:\\AstrBot\\backend\\python\\python.exe bot\\tools\\test_life.py
"""

from __future__ import annotations

import asyncio
import io
import shutil
import sys
import tempfile
import time
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent.parent
sys.path.insert(0, str(_REPO))

problems: list[str] = []
passed = 0


def ok(msg):
    global passed
    passed += 1
    print(f"  ✅ {msg}")


def bad(msg):
    problems.append(msg)
    print(f"  ❌ {msg}")


# ---------------------------------------------------------------- 假 AstrBot

class FakePersona:
    def __init__(self, pid, name, prompt):
        self.persona_id = pid
        self.name = name
        self.system_prompt = prompt


class FakePersonaManager:
    """模拟 AstrBot 的 PersonaManager。"""

    def __init__(self):
        self.personas = {
            "shasume": FakePersona("shasume", "纱雾", "你叫和泉纱雾，是个怕生的家里蹲少女，说话小声、偶尔傲娇。"),
            "lazycat": FakePersona("lazycat", "懒猫", "你是一只很懒的猫，能躺着不坐着，讨厌干活，喜欢晒太阳。"),
            "curious": FakePersona("curious", "小好奇", "你好奇心旺盛、精力充沛，什么都想看看，闲不住。"),
        }

    async def get_all_personas(self):
        return list(self.personas.values())

    async def get_persona(self, pid):
        if pid not in self.personas:
            raise ValueError(f"Persona {pid} does not exist")
        return self.personas[pid]

    async def get_default_persona_v3(self, umo=None):
        p = self.personas["shasume"]
        return {"prompt": p.system_prompt, "name": p.name}

    async def create_persona(self, persona_id, system_prompt, **kw):
        p = FakePersona(persona_id, persona_id, system_prompt)
        self.personas[persona_id] = p
        return p


class FakeContext:
    def __init__(self):
        self.persona_manager = FakePersonaManager()


# ---------------------------------------------------------------- 测试主体

async def main() -> int:
    print("=== 人格 / 记忆 / 驱动力 / 过日子 模块测试 ===\n")

    from plugin.persona import MinecraftPersona
    from plugin.memory import MemoryStore
    from plugin.drives import DriveSystem
    from plugin.life import LifeLoop

    tmp = Path(tempfile.mkdtemp(prefix="mc-life-test-"))
    print(f"临时数据目录：{tmp}\n")

    try:
        # ---------------------------------------------------------- 人格
        print("[1] 人格桥接")
        cfg_values: dict = {}
        persona = MinecraftPersona(context=FakeContext(), data_dir=tmp, cfg=lambda k, d=None: cfg_values.get(k, d))

        cur = await persona.resolve()
        ok(f"读到 AstrBot 默认人格：{cur['name']}（来源 {cur['source']}）") if cur["prompt"] else bad("默认人格读不到")

        listed = await persona.list_personas()
        if len(listed) == 3:
            ok(f"列人格：{', '.join(p['name'] for p in listed)}")
        else:
            bad(f"人格列表数量不对：{len(listed)}")

        # 切换
        msg = await persona.set_persona("懒猫")
        cur2 = await persona.resolve()
        if cur2["name"] == "懒猫" and cur2["source"] == "astrbot":
            ok(f"切换人格成功：{msg}")
        else:
            bad(f"切换人格失败：{cur2}")

        # 持久化：新实例应该记得选择
        persona2 = MinecraftPersona(context=FakeContext(), data_dir=tmp, cfg=lambda k, d=None: None)
        cur3 = await persona2.resolve()
        if cur3["name"] == "懒猫":
            ok("人格选择已持久化（新实例仍读到懒猫）")
        else:
            bad(f"人格选择没持久化：{cur3['name']}")

        # 切回默认
        await persona.set_persona("默认")
        cur4 = await persona.resolve()
        if cur4["name"] == "纱雾":
            ok("恢复默认人格成功")
        else:
            bad(f"恢复默认人格失败：{cur4['name']}")

        # system prompt 组装
        sp = await persona.build_system_prompt()
        if "纱雾" in sp and "Minecraft" in sp and "AI" in sp:
            ok(f"system prompt 组装正确（{len(sp)} 字符：人格 + MC 行为准则）")
        else:
            bad("system prompt 组装不对（缺人格或行为准则）")

        # 不存在的人格要给出可用列表
        miss = await persona.set_persona("不存在的人")
        if "没有找到" in miss and "纱雾" in miss:
            ok("切换不存在的人格时给出可用列表")
        else:
            bad(f"不存在人格的报错不友好：{miss}")

        # ---------------------------------------------------------- 记忆
        print("\n[2] 记忆层")
        mem = MemoryStore(tmp)
        mem.remember("death", "我在 (-100, 12, 200) 死了，是被岩浆烫的", tags=["岩浆", "矿洞"])
        mem.remember("treasure", "第一次挖到 diamond×3", tags=["diamond"])
        mem.remember("discovery", "第一次见到 panda", tags=["panda"])
        mem.remember("social", "张三 跟我说：要不要一起挖矿", tags=["张三"])
        mem.remember("trivial", "我自己决定去随便逛逛", tags=["leisure"])
        stats = mem.stats()
        if stats["total"] == 5:
            ok(f"写入 5 条记忆（{stats['by_kind']}）")
        else:
            bad(f"记忆条数不对：{stats}")

        # 去重
        again = mem.remember("death", "我在 (-100, 12, 200) 死了，是被岩浆烫的", dedupe_window=60)
        if again is None:
            ok("同一条记忆在时间窗内不会重复写入")
        else:
            bad("去重失效，重复写入了")

        # 检索：问"岩浆 危险"应该把那次死亡排在很前面。
        # 断言"命中即可、且顺序按相关度"，不强求一定第一：
        # 熊猫那条会命中"熊猫"+"panda"两个词，权重加成也可能很高。
        hits = mem.recall("岩浆 危险", limit=3)
        matched = [h for h in hits if "岩浆" in h.text]
        if matched:
            ok(f"检索「岩浆 危险」命中相关记忆（排在第 {hits.index(matched[0]) + 1} 位）")
        else:
            bad(f"检索没命中相关记忆：{[h.text for h in hits]}")

        # 渲染必须保持相关度顺序（最相关的在最前）
        top_hit = hits[0]
        rendered_check = mem.render_for_prompt(hits)
        if rendered_check.splitlines()[0].endswith(top_hit.text):
            ok("记忆渲染保持相关度顺序（最相关在最前）")
        else:
            bad(f"记忆渲染把顺序打乱了：{rendered_check.splitlines()[0][:40]} vs {top_hit.text[:40]}")

        # 检索：问"熊猫"应该能想起那次发现。
        # 注意断言写成"命中集合里有"，而不是"排第一"——
        # 死亡记忆的权重更高（9 vs 6），排在前面是**合理**的排序，不该失败。
        hits2 = mem.recall("熊猫 panda", limit=3)
        matched = [h for h in hits2 if "panda" in h.text]
        if matched:
            ok(f"检索「熊猫」命中相关记忆（排在第 {hits2.index(matched[0]) + 1} 位）")
        else:
            bad(f"检索「熊猫」没命中：{[h.text for h in hits2]}")

        # 检索无关话题时不该塞进琐事
        hits3 = mem.recall("红石电路怎么做", limit=5)
        trivial_in = [h for h in hits3 if h.kind == "trivial"]
        if not trivial_in:
            ok("检索无关话题时不会塞进琐碎记忆（省 token）")
        else:
            bad(f"无关检索里混入了琐事：{[h.text for h in trivial_in]}")

        # 落盘与载入
        mem.save(force=True)
        mem2 = MemoryStore(tmp)
        if mem2.stats()["total"] == 5:
            ok("记忆已落盘并能重新载入")
        else:
            bad(f"记忆落盘/载入不对：{mem2.stats()}")

        # 渲染
        rendered = mem.render_for_prompt(mem.recent(3))
        if rendered and rendered.count("\n") >= 2 and "（" in rendered:
            ok("记忆渲染格式正常（带时间与类型）")
        else:
            bad(f"记忆渲染异常：{rendered[:80]}")

        # ---------------------------------------------------------- 驱动力
        print("\n[3] 驱动力")
        drives = DriveSystem(tmp)
        # 模拟过了 3 小时 → 各欲望都该涨
        drives.tick(now=time.time() + 3 * 3600)
        levels = drives.snapshot()["levels"]
        if all(v > 0.3 for v in levels.values()):
            ok(f"3 小时后各动机都涨起来了：{levels}")
        else:
            bad(f"动机没有随时间增长：{levels}")

        top = drives.top_drive()
        ok(f"最强动机：{top.label}（{top.level:.2f}）")

        s = drives.suggest_activity()
        if s["activity"] and s["label"]:
            ok(f"给出建议：{s['activity']}")
        else:
            bad("建议为空")

        # 满足后应该回落
        before = drives._drives[top.key].level
        drives.satisfy(top.key)
        after = drives._drives[top.key].level
        if after < before:
            ok(f"做完了对应动机回落：{before:.2f} → {after:.2f}")
        else:
            bad(f"满足后动机没回落：{before} → {after}")

        # 人格偏置：懒猫应该更偏向"悠闲"
        from plugin.drives import TRAIT_BIAS

        drives2 = DriveSystem(tmp)
        drives2.apply_personality("你是一只很懒的猫，能躺着不坐着，讨厌干活")
        bias = drives2.snapshot()["bias"]
        if bias.get("leisure", 1.0) > 1.0:
            ok(f"「懒」的人格让悠闲欲更敏感：{bias}")
        else:
            bad(f"人格偏置没生效：{bias}")

        # 好奇的人格应该偏向探索
        drives3 = DriveSystem(tmp)
        drives3.apply_personality("你好奇心旺盛、精力充沛，什么都想看看，闲不住")
        bias3 = drives3.snapshot()["bias"]
        if bias3.get("explore", 1.0) > 1.0:
            ok(f"「好奇」的人格让探索欲更敏感：{bias3}")
        else:
            bad(f"人格偏置（探索）没生效：{bias3}")

        # 避免重复：连续两次建议不该完全一样
        drives4 = DriveSystem(tmp)
        drives4.tick(now=time.time() + 5 * 3600)
        a1 = drives4.suggest_activity()
        drives4.note_activity(drive=a1["drive"], activity=a1["activity"])
        a2 = drives4.suggest_activity()
        if a2["activity"] != a1["activity"]:
            ok(f"不会连续做同一件事：{a1['activity'][:20]} → {a2['activity'][:20]}")
        else:
            bad("连续给出同一个建议")

        # ---------------------------------------------------------- 过日子
        print("\n[4] 过日子循环（决策链路）")

        engine_calls: list[tuple] = []
        shared: list[str] = []

        async def fake_engine_call(method, params=None, **kw):
            engine_calls.append((method, params))
            if method == "task.list":
                return {"current": None, "queued": []}
            if method == "skill.list":
                return {"skills": ["chop_tree(count=8)：找树砍木材", "mine_ores(ore=iron, count=8)：挖矿"], "names": ["chop_tree", "mine_ores"]}
            return {"ok": True}

        async def fake_brief():
            return "位置 (0, 64, 0) 主世界 | 生命 20/20 | 饱食 18/20 | 背包 空"

        async def fake_skill_catalog():
            # 真实实现返回的是 list[dict]（不是引擎的原始响应），照这个契约来
            return [
                {"skill": "chop_tree", "description": "找树砍木材", "params": {"count": 8}},
                {"skill": "mine_ores", "description": "挖矿", "params": {"ore": "iron", "count": 8}},
            ]

        async def fake_system_prompt():
            return await persona.build_system_prompt()

        llm_replies = [
            '```json\n{"activity": "去挖点矿攒点铁", "skill": "mine_ores", "params": {"ore": "iron", "count": 6}, "say": "去挖矿了", "reason": "想攒点家底"}\n```',
            '{"activity": "坐在山坡上看日落", "skill": null, "params": {}, "say": null, "reason": "有点累了"}',
        ]
        llm_calls: list[str] = []

        # 分享用的是同一个 _llm，但期望的是"一句人话"而不是决策 JSON。
        # 真实实现里这是两次不同的调用（不同的 prompt），这里用调用顺序区分：
        # 第 1、2 次是 decide，之后是分享。
        async def fake_llm_ordered(prompt=None, system=None, **kw):
            # **记录 system + user 的合并文本**。
            #
            # 决策的静态指令（含"请用 JSON 回答"和技能清单）现在放在 system 里
            # （见 life.decide 里"上下文分层"的说明：静态前缀才能被提示词缓存命中），
            # 所以只记 prompt 会看不到它们——早期版本就是因为只记 prompt 而误判。
            combined = f"{system or ''}\n{prompt or ''}"
            llm_calls.append(combined)
            p = combined
            if "请用 JSON 回答" in p:
                return llm_replies[min(len([c for c in llm_calls if "请用 JSON 回答" in c]) - 1, len(llm_replies) - 1)]
            # 分享：返回一句人话
            return "挖到钻石啦，运气不错！"

        async def fake_share(text):
            shared.append(text)

        async def fake_activity(decision):
            pass

        life = LifeLoop(
            engine_call=fake_engine_call,
            memory=mem,
            drives=drives,
            brief_provider=fake_brief,
            llm=fake_llm_ordered,
            system_prompt_provider=fake_system_prompt,
            skill_catalog_provider=fake_skill_catalog,
            on_share=fake_share,
            on_activity=fake_activity,
            decide_interval=1,
            share_cooldown=0,
        )
        life.bind_data_dir(tmp)

        d1 = await life.decide()
        if d1 and d1.skill == "mine_ores" and d1.params.get("ore") == "iron":
            ok(f"决策链路走通（含 ```json 包裹的容错）：{d1.activity} → {d1.skill}")
        else:
            bad(f"决策解析失败：{d1}")

        # prompt 里应该带上记忆
        if llm_calls and "记得的事" in llm_calls[0]:
            ok("决策 prompt 里带了相关记忆")
        else:
            bad("决策 prompt 里没带记忆")

        if llm_calls and "你可以做的事" in llm_calls[0]:
            ok("决策 prompt 里带了技能清单")
        else:
            bad("决策 prompt 里没带技能清单")

        await life._act(d1)
        if shared and shared[0] == "去挖矿了":
            ok(f"她说了想说的话：{shared[0]}")
        else:
            bad(f"分享没生效：{shared}")

        if any(m == "skill.run" and p.get("skill") == "mine_ores" for m, p in engine_calls):
            ok("决定的事情真的通过 skill.run 交给了引擎")
        else:
            bad(f"没有把决定交给引擎：{engine_calls}")

        # 不动手的决定也要能处理
        d2 = await life.decide()
        if d2 and d2.skill is None:
            await life._act(d2)
            ok(f"「什么都不做」的决定也能正确处理：{d2.activity}")
        else:
            bad(f"第二种决定解析失败：{d2}")

        # LLM 挂掉时的兜底
        async def broken_llm(prompt=None, system=None, **kw):
            return None

        life._llm = broken_llm
        d3 = await life.decide()
        if d3 and d3.activity:
            ok(f"LLM 不可用时退化为按驱动行事：{d3.activity} → {d3.skill}")
        else:
            bad("LLM 挂掉后没有兜底")

        # 忙碌检测
        async def busy_engine(method, params=None, **kw):
            if method == "task.list":
                return {"current": {"name": "挖矿"}}
            return {}

        life._call = busy_engine
        if await life._engine_busy():
            ok("引擎有任务在跑时，判定为忙（不会和你抢机器人）")
        else:
            bad("忙碌检测失效")

        # 分享冷却
        # 注意：先把 llm 换回正常的——上一段测"LLM 挂掉"时把它换成了 broken_llm，
        # 不换回来后面的分享测试全会失败（这个坑我自己踩了一次）。
        life._llm = fake_llm_ordered
        life._call = fake_engine_call
        life._last_share_at = 0
        shared.clear()
        got = await life.share_event(kind="treasure", text="挖到钻石了")
        if got and shared:
            ok(f"事件分享走通：{shared[-1][:30]}")
        else:
            bad("事件分享失败")

        # 死亡应该能绕过冷却
        life._last_share_at = time.time()
        shared.clear()
        got2 = await life.share_event(kind="death", text="我死了", force=True)
        if got2:
            ok("死亡分享能绕过冷却（大事要立刻说）")
        else:
            bad("死亡分享被冷却挡住了")

        # 状态描述
        desc = life.describe()
        if "刚才决定" in desc or "最近做过" in desc:
            ok("状态描述可读")
        else:
            bad(f"状态描述异常：{desc[:80]}")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n=== 结果 ===")
    if problems:
        print(f"❌ {len(problems)} 个问题：")
        for p in problems:
            print(f"  ✗ {p}")
        return 1
    print(f"✅ 全部通过（{passed} 项断言）")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
