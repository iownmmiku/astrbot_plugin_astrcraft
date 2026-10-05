"""ActionAgent 的行为测试（T4：技能承担多步）。

钉住的是**"提交长任务就结束这一轮"在代码里真的生效**——
这条规则原来只写在提示词里，模型不听话时会把步数预算烧在等待和查询上，
用户看到的就是"一堆无意义的动作、忙半天什么都没做成"。

同时也钉住两件事，它们都是实际踩过的坑：
  1. 判据要匹配**中文的"任务号"**。我第一版写成 `"task_id" in out`，
     而技能工具返回的文案里只有"任务号"、没有字面 task_id →
     这个提前结束**永远不会触发**（写了等于没写）。
  2. 提示词里引用的工具名必须真实存在。我上一版让模型调
     `mc_skill_run(skill="chop_tree")`，而 58 个工具里**根本没有这个工具** →
     模型只能退回用 mc_craft 一步步硬拼。
"""

import sys
import asyncio
import re
import pathlib
import copy
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import _paths  # noqa: E402

# action_agent 依赖 astrbot（astrbot.core.agent.*）。
_paths.require_astrbot("test_action_agent")
_paths.load_plugin()
from astrcraft_plugin.action_agent import ActionAgent, MAX_STEPS  # noqa: E402

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


class _Resp:
    def __init__(self, names, args):
        self.tools_call_name = names
        self.tools_call_args = args
        self.tools_call_ids = [f"c{i}" for i in range(len(names))]
        self.completion_text = ""

    def to_openai_tool_calls_model(self):
        return []


class _Provider:
    """第一轮提交一个技能工具；之后每被调用一次就记一笔（说明没提前停）。"""

    def __init__(self, first_names, first_args):
        self.calls = 0
        self.first_names = first_names
        self.first_args = first_args

    async def text_chat(self, **kw):
        self.calls += 1
        if self.calls == 1:
            return _Resp(self.first_names, self.first_args)
        return _Resp(["mc_inventory"], [{}])


class _Ctx:
    async def get_using_provider_async(self):
        return None


class _Plugin:
    def __init__(self, provider):
        self._provider = provider
        self.context = _Ctx()

    async def get_provider(self):
        return self._provider


def build(provider, execute):
    """绕开 __init__，直接拼一个能跑 act() 的 agent。"""
    a = ActionAgent.__new__(ActionAgent)
    a.max_steps = MAX_STEPS
    a.plugin = _Plugin(provider)
    a._toolset = lambda: "FAKE"
    a._execute = execute
    return a


def run(agent):
    # act() 里会 await plugin.context.get_using_provider_async()；
    # 这里把 provider 直接塞进去
    async def fake_get():
        return agent.plugin._provider

    agent.plugin.context.get_using_provider_async = fake_get
    return asyncio.run(agent.act(prompt="测试", system="测试"))


print("=== 常量 ===")
ok("步数上限调回了 6", MAX_STEPS == 6, f"MAX_STEPS={MAX_STEPS}")

print("\n=== 提交长任务 → 立刻结束这一轮 ===")
calls = []


async def ex_skill(name, args, event):
    calls.append(name)
    return "已让机器人开始「砍树」，任务号 t123。\n这会持续一段时间——**你这一轮就到此为止**"


prov = _Provider(["mc_chop_tree"], [{"count": 8}])
text, used = run(build(prov, ex_skill))
ok("只调了 1 次工具就停", used == ["mc_chop_tree"], f"used={used}")
ok("模型只被调用 1 次（没有第二轮）", prov.calls == 1, f"模型调用 {prov.calls} 次")
ok("返回了收尾说明", text is not None and "交代" in str(text), f"text={text}")

print("\n=== 只读工具不会提前结束（该继续就继续）===")
calls2 = []


async def ex_read(name, args, event):
    calls2.append(name)
    return "位置 (0, 64, 0) ｜ 血量 20/20"


prov2 = _Provider(["mc_status"], [{}])
text2, used2 = run(build(prov2, ex_read))
ok("只读工具后继续跑（模型被调用多次）", prov2.calls > 1, f"模型调用 {prov2.calls} 次")
ok("步数没有超过上限", len(used2) <= MAX_STEPS, f"调了 {len(used2)} 次")

print("\n=== 提示词里的步数必须和 MAX_STEPS 一致 ===")
# 踩过：上一轮把 MAX_STEPS 从 4 调到 6，但提示词里还写着"你只有 4 步""最多 4 步"
# ——模型按 4 步给自己压预算，**正好抵消那次修复**，而且没人发现。
# 现在提示词从 MAX_STEPS 插值，这个断言负责在它再次漂移时立刻炸。
from astrcraft_plugin.action_agent import ACTION_PROMPT, _STEPS_TOKEN  # noqa: E402

ok("提示词里没有残留占位符", _STEPS_TOKEN not in ACTION_PROMPT, _STEPS_TOKEN)
# **只认"最多 N 步"这种"声称步数预算"的表述**（这一轮收窄的）。
#
# 原来是 `(\d+)\s*步` —— 太宽：提示词里新加了一句
# "一次给出 2~5 步"（说的是**计划长度**，不是步数预算），
# 也被它当成"声称了一个不同的 MAX_STEPS"，于是测试红了。
#
# 断言的**真实意图**是"提示词不能声称一个和代码不一致的**步数上限**"，
# 所以只该匹配"最多 N 步"。宽的正则会让**正确的文案**被判成错 ——
# 那种测试最后只会被人改成"反正它老红，跳过吧"。
_step_nums = re.findall(r"最多\s*(\d+)\s*步", ACTION_PROMPT)
ok("提示词里确实提到了步数（断言本身有效）", len(_step_nums) >= 1, f"找到 {_step_nums}")
_step_bad = sorted({int(n) for n in _step_nums if int(n) != MAX_STEPS})
ok(
    "提示词里声称的步数上限等于 MAX_STEPS",
    not _step_bad,
    f"提示词={_step_nums}，MAX_STEPS={MAX_STEPS}"
    + (f"，不一致的有 {_step_bad}" if _step_bad else ""),
)

print("\n=== 判据必须匹配中文「任务号」 ===")
src = _paths.REPO / "action_agent.py"
t = src.read_text(encoding="utf-8")
ok(
    "提前结束的判据里含中文「任务号」",
    '"任务号" in str(out)' in t,
    "技能工具返回的文案里是「任务号 xxx」，没有字面 task_id",
)
ok(
    "英文 task_id 也一起判（两种写法都覆盖）",
    '"task_id" in str(out)' in t,
)

print("\n=== 提示词里引用的工具必须真实存在 ===")
names = set()
for p in _paths.REPO.glob("llm_tools_*.py"):
    names |= set(re.findall(r'@filter\.llm_tool\(name="(mc_[a-z_]+)"', p.read_text(encoding="utf-8")))
# EXCLUDED_TOOLS 是**故意**不暴露给 agent 的管理类工具（改配置/重启/暂停人生…），
# 它们出现在文件里是正确的，不算"幻影工具"。
ex_block = t.split("EXCLUDED_TOOLS = (")[1].split(")")[0]
excluded = set(re.findall(r'"(mc_[a-z_]+)"', ex_block))
mentioned = set(re.findall(r"\bmc_[a-z_]+\b", t))
phantom = mentioned - names - excluded
ok(
    "提示词里没有引用不存在的工具",
    not phantom,
    f"可疑: {sorted(phantom)}" if phantom else f"全部存在（另有 {len(excluded)} 个是故意排除的管理工具）",
)
ok(
    "特别地：不再引用 mc_skill_run（它不存在）",
    "mc_skill_run" not in t,
    "已改成真实工具名 mc_chop_tree / mc_make_tools…",
)

print("\n=== 真实注册表和工具 handler：观察预算、失效与计时 ===")
from astrbot.core.provider.func_tool_manager import FunctionToolManager  # noqa: E402
from astrcraft_plugin.llm_tools_core import McPerceptionTools  # noqa: E402
from astrcraft_plugin.llm_tools_skills import McSkillTools  # noqa: E402


class Clock:
    def __init__(self):
        self.value = 0.0

    def now(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class FixtureEngine:
    """只替换 RPC 对端；注册表、ActionAgent 和感知/动作 handler 均为真实实现。"""

    def __init__(self, clock=None):
        self.clock = clock
        self.calls = []
        self.items = {"bread": 2, "stone_pickaxe": 1}
        self.state = {
            "connected": True, "position": {"x": 0, "y": 64, "z": 0},
            "health": 20, "food": 20, "dimension": "overworld", "time_of_day": 1000,
            "held_item": None, "inventory_summary": {"entries": [{"name": "bread", "count": 2}]},
        }
        self.entered = asyncio.Event()
        self.release = None
        self.fail_state = False

    async def call(self, method, params=None, **kwargs):
        self.calls.append((method, copy.deepcopy(params or {})))
        if self.clock:
            self.clock.advance(0.003 if method == "state.get" else 0.020)
        if method == "state.get":
            if self.fail_state:
                raise RuntimeError("状态暂时不可读")
            return copy.deepcopy(self.state)
        if method == "inventory.get":
            if self.release is not None:
                self.entered.set()
                await self.release.wait()
            return {"items": dict(self.items), "held": copy.deepcopy(self.state["held_item"])}
        if method == "block.scan":
            return {"count": 1, "blocks": [{"name": params["names"][0], "x": self.state["position"]["x"] + 2, "y": 64, "z": 0, "distance": 2}]}
        if method == "equip":
            self.state["held_item"] = {"name": params["item"], "count": 1}
            return {"equipped": params["item"], "destination": "hand"}
        if method == "craft":
            self.items[params["item"]] = self.items.get(params["item"], 0) + params["count"]
            return {"item": params["item"], "produced": params["count"], "delta": {}}
        raise AssertionError(f"未预期 RPC：{method}")

    async def task_status(self):
        return {"current": None}

    async def run_skill(self, skill, params):
        self.calls.append(("skill.run", {"skill": skill, "params": params}))
        return {"task_id": "fixture-task"}


class ScriptedProvider:
    def __init__(self, replies, *, before=None, clock=None):
        self.replies = replies
        self.before = before
        self.clock = clock
        self.calls = 0
        self.contexts = []

    async def text_chat(self, **kwargs):
        self.calls += 1
        self.contexts.append(kwargs["contexts"])
        if self.clock:
            self.clock.advance(0.005)
        if self.before:
            result = self.before(self.calls)
            if asyncio.iscoroutine(result):
                await result
        if self.calls > len(self.replies):
            raise AssertionError("发生未安排的模型调用")
        reply = self.replies[self.calls - 1]
        if isinstance(reply, Exception):
            raise reply
        if isinstance(reply, str):
            return SimpleNamespace(tools_call_name=[], completion_text=reply, usage=None)
        names, args = reply
        result = _Resp(names, args)
        result.usage = None
        return result


class FixturePlugin(McPerceptionTools, McSkillTools):
    def __init__(self, provider, engine):
        self.engine, self.connected, self.life, self.goals = engine, True, None, None
        self._brief_revision = 0
        manager = FunctionToolManager()
        for name, handler in (
            ("mc_inventory", McPerceptionTools.tool_mc_inventory),
            ("mc_scan", McPerceptionTools.tool_mc_scan),
            ("mc_equip", McPerceptionTools.tool_mc_equip),
            ("mc_craft", McPerceptionTools.tool_mc_craft),
            ("mc_chop_tree", McSkillTools.tool_mc_chop_tree),
        ):
            manager.add_func(name=name, func_args=[], desc="回归测试", handler=handler)

        async def get_provider():
            return provider

        self.context = SimpleNamespace(
            get_using_provider_async=get_provider,
            provider_manager=SimpleNamespace(llm_tools=manager),
        )

    async def _ensure_engine(self):
        return True


def rpc_count(engine, method):
    return sum(name == method for name, _ in engine.calls)


async def real_handler_checks():
    engine = FixtureEngine()
    provider = ScriptedProvider([(["mc_inventory"], [{}]), (["mc_inventory"], [{}]), "确认背包后结束"])
    agent = ActionAgent(FixturePlugin(provider, engine))
    summary, _ = await agent.act(prompt="查看背包", system=ACTION_PROMPT)
    ok("相同真实状态下重复查看背包只执行一次 handler", rpc_count(engine, "inventory.get") == 1)
    ok("重复观察仍计入预算，且允许模型诚实收尾", agent.last_timing["read_cache_hits"] == 1 and summary == "确认背包后结束")
    ok("真实模型请求次数与缓存命中分别统计", agent.last_timing["provider_calls"] == 3 and agent.last_timing["tool_calls"] == 1)
    ok("预算提醒放在完整 tool 结果之后", "观察预算" in str(provider.contexts[2][-1].content))

    engine = FixtureEngine()
    provider = ScriptedProvider([(["mc_inventory"], [{}])] * 3)
    agent = ActionAgent(FixturePlugin(provider, engine))
    summary, _ = await agent.act(prompt="缺少事实时可以停止", system=ACTION_PROMPT)
    ok("纯重复观察最多三轮模型而非六轮空转", provider.calls == 3 and rpc_count(engine, "inventory.get") == 1)
    ok("预算耗尽不凭空提交动作", agent.last_timing["body_attempts"] == 0 and agent.last_timing["exit_reason"] == "observation_budget")
    ok("如实说明本轮没有额外观察或猜测动作", "未再查询或猜测动作" in summary)

    engine = FixtureEngine()
    provider = ScriptedProvider([(["mc_scan", "mc_scan"], [{"target": "oak_log"}, {"radius": 16, "target": "oak_log"}]), "结束"])
    agent = ActionAgent(FixturePlugin(provider, engine))
    await agent.act(prompt="同一目标", system=ACTION_PROMPT)
    ok("同批参数省略/显式默认值按实际 handler 归一化", rpc_count(engine, "block.scan") == 1 and agent.last_timing["read_cache_hits"] == 1)

    engine = FixtureEngine()
    provider = ScriptedProvider([(["mc_scan", "mc_scan"], [{"target": "oak_log"}, {"target": "iron_ore"}]), "结束"])
    agent = ActionAgent(FixturePlugin(provider, engine))
    await agent.act(prompt="不同目标", system=ACTION_PROMPT)
    ok("不同查询参数不会误复用", rpc_count(engine, "block.scan") == 2 and agent.last_timing["read_cache_hits"] == 0)

    engine = FixtureEngine()
    provider = ScriptedProvider([(["mc_scan"], [{"target": "oak_log"}]), (["mc_scan"], [{"target": "oak_log"}]), "结束"])
    agent = ActionAgent(FixturePlugin(provider, engine))
    await agent.act(prompt="世界方块可能在模型往返间改变", system=ACTION_PROMPT)
    ok("地形查询跨模型回合重新读取，不沿用旧地形", rpc_count(engine, "block.scan") == 2)

    for label, mutate in (
        ("位置改变", lambda p: p.engine.state["position"].update(x=1)),
        ("背包改变", lambda p: (p.engine.items.update(bread=3), p.engine.state["inventory_summary"].update(entries=[{"name": "bread", "count": 3}]))),
        ("状态版本改变", lambda p: setattr(p, "_brief_revision", 1)),
        ("引擎实例改变", lambda p: setattr(p, "engine", FixtureEngine())),
    ):
        engine = FixtureEngine()
        holder = {}
        def before(number):
            if number == 2:
                mutate(holder["plugin"])
        provider = ScriptedProvider([(["mc_inventory"], [{}]), (["mc_inventory"], [{}]), "结束"], before=before)
        plugin = FixturePlugin(provider, engine)
        holder["plugin"] = plugin
        agent = ActionAgent(plugin)
        await agent.act(prompt=label, system=ACTION_PROMPT)
        ok(f"{label}使缓存失效", agent.last_timing["read_cache_hits"] == 0 and agent.last_timing["tool_calls"] == 2)

    engine = FixtureEngine()
    provider = ScriptedProvider([(["mc_inventory", "mc_equip", "mc_inventory"], [{}, {"item": "stone_pickaxe"}, {}]), "结束"])
    agent = ActionAgent(FixturePlugin(provider, engine))
    await agent.act(prompt="装备后重新看真实状态", system=ACTION_PROMPT)
    ok("身体动作之后旧观察失效，并可验证新状态", rpc_count(engine, "inventory.get") == 2 and rpc_count(engine, "equip") == 1)
    ok("动作后刷新结果真实带上新手持", any("手持：stone_pickaxe" in str(getattr(message, "content", "")) for message in provider.contexts[-1]))

    engine = FixtureEngine()
    provider = ScriptedProvider([(["mc_equip", "mc_equip"], [{"item": "stone_pickaxe"}, {"destination": "auto", "item": "stone_pickaxe"}]), "结束"])
    agent = ActionAgent(FixturePlugin(provider, engine))
    await agent.act(prompt="禁止重复执行同一动作", system=ACTION_PROMPT)
    ok("同一身体动作只执行一次，包括显式默认参数", rpc_count(engine, "equip") == 1 and agent.last_timing["duplicate_actions_blocked"] == 1)

    engine = FixtureEngine()
    provider = ScriptedProvider([(["mc_craft", "mc_craft"], [{"item": "stick", "count": 1.0}, {"item": "stick", "count": 1}]), "结束"])
    agent = ActionAgent(FixturePlugin(provider, engine))
    await agent.act(prompt="等价 JSON 数值不能重放身体动作", system=ACTION_PROMPT)
    ok("整数与等值浮点参数不会重复合成", rpc_count(engine, "craft") == 1 and engine.items["stick"] == 1)

    engine = FixtureEngine()
    provider = ScriptedProvider([(["mc_inventory"], [{}]), (["mc_inventory"], [{}]), "结束"], before=lambda n: engine.state.update(time_of_day=1000+n))
    agent = ActionAgent(FixturePlugin(provider, engine))
    await agent.act(prompt="时钟前进不改变背包事实", system=ACTION_PROMPT)
    ok("真实世界时钟前进时，未变的背包仍可复用", rpc_count(engine, "inventory.get") == 1 and agent.last_timing["read_cache_hits"] == 1)

    engine = FixtureEngine()
    del engine.state["inventory_summary"]
    provider = ScriptedProvider([(["mc_inventory"], [{}]), (["mc_inventory"], [{}]), "结束"])
    agent = ActionAgent(FixturePlugin(provider, engine))
    await agent.act(prompt="残缺状态不能证明背包相同", system=ACTION_PROMPT)
    ok("残缺快照不复用背包结果", rpc_count(engine, "inventory.get") == 2 and agent.last_timing["read_cache_hits"] == 0)

    engine = FixtureEngine()
    provider = ScriptedProvider([(["mc_inventory", "mc_inventory", "mc_inventory", "mc_chop_tree", "mc_equip"], [{}, {}, {}, {"count": 2}, {"item": "stone_pickaxe"}])])
    agent = ActionAgent(FixturePlugin(provider, engine))
    await agent.act(prompt="预算限制不会拦住同批已有事实的计划", system=ACTION_PROMPT)
    ok("同批观察超预算仍可提交已有事实支持的长任务", rpc_count(engine, "skill.run") == 1 and agent.last_timing["exit_reason"] == "task_submitted")
    ok("长任务提交立即收尾，不执行后续身体动作", provider.calls == 1 and rpc_count(engine, "equip") == 0)

    engine = FixtureEngine()
    engine.fail_state = True
    provider = ScriptedProvider([(["mc_inventory"], [{}]), (["mc_inventory"], [{}]), "结束"])
    agent = ActionAgent(FixturePlugin(provider, engine))
    await agent.act(prompt="不能确认状态时重新查询", system=ACTION_PROMPT)
    ok("状态检查失败时不缓存、不假装世界没变", rpc_count(engine, "inventory.get") == 2 and agent.last_timing["read_cache_hits"] == 0)

    engine = FixtureEngine()
    provider = ScriptedProvider([(["mc_inventory"], [{}]), "结束", (["mc_inventory"], [{}]), "结束"])
    agent = ActionAgent(FixturePlugin(provider, engine))
    await agent.act(prompt="第一轮", system=ACTION_PROMPT)
    await agent.act(prompt="第二轮", system=ACTION_PROMPT)
    ok("观察结果与计时在 act 回合之间隔离", rpc_count(engine, "inventory.get") == 2 and agent.last_timing["read_cache_hits"] == 0 and agent.last_timing["provider_calls"] == 2)

    clock = Clock()
    engine = FixtureEngine(clock)
    provider = ScriptedProvider([(["mc_inventory"], [{}]), "结束"], clock=clock)
    agent = ActionAgent(FixturePlugin(provider, engine))
    with patch("astrcraft_plugin.action_agent.time.perf_counter", side_effect=clock.now):
        await agent.act(prompt="分别计时", system=ACTION_PROMPT)
    timing = agent.last_timing
    ok("模型计时只覆盖 Provider，不混入真实 handler/RPC", abs(timing["provider_seconds"] - 0.010) < 1e-9 and abs(timing["tool_seconds"] - 0.020) < 1e-9, str(timing))
    ok("状态检查单独计时，总时长可核对", abs(timing["state_check_seconds"] - 0.006) < 1e-9 and abs(timing["total_seconds"] - 0.036) < 1e-9)

    for phase in ("provider", "tool"):
        engine = FixtureEngine()
        entered, release = asyncio.Event(), asyncio.Event()
        async def before(number):
            if phase == "provider":
                entered.set()
                await release.wait()
        if phase == "tool":
            engine.release = release
            entered = engine.entered
        provider = ScriptedProvider([(["mc_inventory"], [{}]), "结束"], before=before)
        agent = ActionAgent(FixturePlugin(provider, engine))
        task = asyncio.create_task(agent.act(prompt="取消", system=ACTION_PROMPT))
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        else:
            raise AssertionError("取消应向调用者传播")
        ok(f"{phase} 被取消仍记录计时与退出原因", agent.last_timing["exit_reason"] == "cancelled" and agent.last_timing[f"{phase}_seconds"] >= 0)
        engine.release = None
        provider.before = None
        provider.calls = 0
        await agent.act(prompt="取消后的新回合", system=ACTION_PROMPT)
        ok(f"{phase} 取消不留下可复用的半次观察", agent.last_timing["read_cache_hits"] == 0 and agent.last_timing["tool_calls"] == 1)

    engine = FixtureEngine()
    provider = ScriptedProvider([RuntimeError("端点不可用")])
    agent = ActionAgent(FixturePlugin(provider, engine))
    try:
        await agent.act(prompt="模型故障", system=ACTION_PROMPT)
    except RuntimeError:
        pass
    else:
        raise AssertionError("没有动作时的模型故障应交给生活循环恢复")
    ok("Provider 故障也有独立计时与计数", agent.last_timing["exit_reason"] == "error" and agent.last_timing["provider_calls"] == 1 and agent.last_timing["tool_calls"] == 0)

    from test_life_recovery import make_loop
    for from_owner in (True, False):
        life, _ = make_loop()
        for _ in range(3):
            life.note_task_result("mine_stone", False, "没有镐")
        assert not life.skill_retry_ready("mine_stone")

        def interrupted(number):
            if number == 1:
                if from_owner:
                    life.note_owner_said("Alice：镐换好了，立刻再挖石头")
                else:
                    life.note_world_event("hurt", "刚刚受伤，先看清周围")

        engine = FixtureEngine()
        provider = ScriptedProvider([
            (["mc_inventory"], [{}]),
            (["mc_mine_stone"], [{"count": 4}]),
            "结束",
        ], before=interrupted)
        plugin = FixturePlugin(provider, engine)
        plugin.life = life
        plugin.context.provider_manager.llm_tools.add_func(
            name="mc_mine_stone", func_args=[], desc="回归测试", handler=McSkillTools.tool_mc_mine_stone)
        agent = ActionAgent(plugin)
        await agent.act(prompt="继续安排", system=ACTION_PROMPT)
        label = "主人要求重试" if from_owner else "世界受伤事件"
        ok(f"模型思考期间的{label}按输入来源处理技能冷却",
           rpc_count(engine, "skill.run") == (1 if from_owner else 0))
        ok(f"{label}已经注入且不留在收件箱，冷却状态仍正确",
           len(life.inbox) == 0 and life.skill_retry_ready("mine_stone") == from_owner)


asyncio.run(real_handler_checks())
print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
sys.exit(1 if failed else 0)
