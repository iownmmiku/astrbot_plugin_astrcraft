"""Token 台账的测试（W6，见 docs/PLAN_v2.md）。

钉住的核心是 numen 强调的那个区别：

    **要显示"上一轮"的命中率，不是累计命中率。**
    它的原话："累计命中率会被历史稀释，看不出刚才那轮打穿了缓存。"

为什么这句话在这里很重要：她可能前面几十轮都命中缓存，
刚才那一轮因为改了一句 system 提示词而全部重算——
**累计命中率几乎看不出变化**，而"上一轮命中率"会立刻掉到 0。
没有这个数，就没法判断"提示词分层到底有没有生效"。

另外钉住：
  - 四元用量（input_other / input_cached / output / total）
  - 不同 provider 的字段名都能读（prompt_tokens 那套 / 缺字段不炸）
  - 没报用量的调用**不算进次数**（否则"平均每次"会被 0 拉低）
  - 缓存连续不命中要能报出来（提示词前缀不稳定）
"""

import sys
import pathlib
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import _paths  # noqa: E402

_paths.load_plugin()
from astrcraft_plugin.tokens import Usage, TokenLedger  # noqa: E402

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


print("=== 四元用量 ===")
u = Usage(input_other=100, input_cached=900, output=50)
ok("输入合计 = 未命中 + 命中", u.input_total == 1000, f"{u.input_total}")
ok("总量 = 输入 + 输出", u.total == 1050, f"{u.total}")
ok("命中率 = 命中/输入合计", abs(u.hit_rate - 0.9) < 1e-9, f"{u.hit_rate}")
ok("空用量命中率是 0（不是 NaN）", Usage().hit_rate == 0.0, f"{Usage().hit_rate}")
ok("空用量 is_empty", Usage().is_empty() is True)

print("\n=== 相加（累计用）===")
a = Usage(input_other=10, input_cached=90, output=5)
b = Usage(input_other=20, input_cached=80, output=7)
s = a + b
ok("input_other 相加", s.input_other == 30, f"{s.input_other}")
ok("input_cached 相加", s.input_cached == 170, f"{s.input_cached}")
ok("output 相加", s.output == 12, f"{s.output}")

print("\n=== 读不同 provider 的字段名 ===")
class AstrBotStyle:
    input_other = 10
    input_cached = 90
    output = 5


class OpenAIStyle:
    prompt_tokens = 100
    completion_tokens = 5
    cached_tokens = 40


class Bare:
    prompt_tokens = 7


ok("AstrBot 的 TokenUsage 形状", Usage.from_any(AstrBotStyle()).total == 105)
o = Usage.from_any(OpenAIStyle())
ok("OpenAI 输入合计包含缓存，先减去命中部分", o.input_other == 60 and o.output == 5 and o.total == 105, str(o))
ok("OpenAI 的 cached_tokens 也认", o.input_cached == 40, str(o))
ok("字段不全不炸（缺的按 0）", Usage.from_any(Bare()).total == 7, str(Usage.from_any(Bare())))
ok("None 不炸", Usage.from_any(None).is_empty() is True)
ok("OpenAI Chat 原始嵌套缓存", Usage.from_any({
    "prompt_tokens": 100, "completion_tokens": 5,
    "prompt_tokens_details": {"cached_tokens": 40},
}) == Usage(60, 40, 5))
ok("OpenAI Responses 原始嵌套缓存", Usage.from_any(SimpleNamespace(
    input_tokens=100, output_tokens=5, input_tokens_details=SimpleNamespace(cached_tokens=40),
)) == Usage(60, 40, 5))
ok("AstrBot 显式 0 不回退到原始 prompt/output 字段", Usage.from_any({
    "input_other": 0, "input_cached": 100, "output": 0,
    "prompt_tokens": 100, "completion_tokens": 5,
}) == Usage(0, 100, 0))
ok("Anthropic 输入本来不含缓存，加创建部分而不重复扣除读取部分", Usage.from_any({
    "input_tokens": 10, "cache_creation_input_tokens": 20,
    "cache_read_input_tokens": 90, "output_tokens": 5,
}) == Usage(30, 90, 5))
ok("无效数值不污染 JSON", Usage.from_any({
    "prompt_tokens": float("inf"), "cached_tokens": True, "completion_tokens": float("nan"),
}).is_empty())
ok("异常缓存不能超过 provider 输入合计", Usage.from_any({
    "input_tokens": 10, "cached_tokens": 50, "output_tokens": 1,
}) == Usage(0, 10, 1))

print("\n=== **上一轮** vs 累计（这是核心）===")
led = TokenLedger()
# 前面 20 轮全部命中缓存（前缀稳定）
for _ in range(20):
    led.record(Usage(input_other=10, input_cached=990, output=50))
ok("累计命中率很高", led.total_hit_rate > 0.98, f"{led.total_hit_rate * 100:.1f}%")
# 刚才那一轮前缀变了 → 全部重算
led.record(Usage(input_other=1000, input_cached=0, output=50))
ok(
    "**上一轮命中率掉到 0**（一眼看出刚打穿了缓存）",
    led.latest_hit_rate == 0.0,
    f"上一轮 {led.latest_hit_rate * 100:.0f}%",
)
ok(
    "而累计命中率几乎没变（这正是「会被历史稀释」的意思）",
    led.total_hit_rate > 0.94,
    f"累计 {led.total_hit_rate * 100:.1f}%（从 99% 只掉到 94%，看不出问题）",
)
ok("两个数是分开的（不是同一个）", led.latest_hit_rate != led.total_hit_rate)

print("\n=== 累计与次数 ===")
led = TokenLedger()
led.record(Usage(input_other=100, input_cached=0, output=10))
led.record(Usage(input_other=200, input_cached=0, output=20))
ok("次数是 2", led.calls == 2, f"{led.calls}")
ok("累计总量 = 330", led.total.total == 330, f"{led.total.total}")
ok("latest 是最后那次", led.latest.output == 20, f"{led.latest.output}")

print("\n=== 没报用量的调用不算进次数 ===")
led = TokenLedger()
led.record(Usage(input_other=100, input_cached=0, output=10))
led.record(None)  # provider 没报
led.record(Usage())  # 全 0
ok("只算报了用量的那次", led.calls == 1, f"calls={led.calls}")
ok("平均每次不会被 0 拉低", led.total.total / max(1, led.calls) == 110, "110")
ok("未知请求也计模型调用次数", led.requests == 3 and led.snapshot()["unknown_calls"] == 2)
ok("最近一次未知不会沿用上次用量", led.snapshot()["latest"]["usage"] is None
   and "上一轮：用量未知" in led.describe(short=True))

print("\n=== 控制台 DTO：分组、未知与耗时 ===")
led = TokenLedger()
ok("没有报告用量时总量为 null", led.snapshot()["total"] is None)
led.record(Usage(20, 80, 5), kind="autonomous", duration_seconds=0.2)
led.record(None, kind="planning", duration_seconds=0.1)
led.record(Usage(5, 10, 2), kind="perception", duration_seconds=0.3)
led.record(None, kind="chat", duration_seconds=0.4, status="failed")
led.record(None, kind="planning", duration_seconds=0.5, status="cancelled")
snapshot = led.snapshot()
ok("所有调用与报告调用分开", snapshot["calls"] == 5 and snapshot["reported_calls"] == 2
   and snapshot["unknown_calls"] == 3 and snapshot["total"]["total"] == 122)
ok("规划有调用但消耗未知", snapshot["groups"]["planning"]["calls"] == 2
   and snapshot["groups"]["planning"]["total"] is None)
ok("失败与取消有独立计数", snapshot["failed_calls"] == snapshot["cancelled_calls"] == 1)
ok("统计模型往返延迟（不混入工具耗时）", snapshot["latency_ms"]["average"] == 300
   and snapshot["groups"]["planning"]["latency_ms"]["average"] == 300)
ok("DTO 是合法 JSON", json.loads(json.dumps(snapshot, allow_nan=False))["latest"]["status"] == "cancelled")
snapshot["groups"]["autonomous"]["latest"]["usage"]["total"] = -1
ok("DTO 修改不污染台账", led.snapshot()["groups"]["autonomous"]["latest"]["usage"]["total"] == 105)
for _ in range(40):
    led.record(None, kind="chat")
ok("最近请求历史有界，未知延迟不显示为 0", len(led.snapshot()["recent"]) == 30
   and led.snapshot()["latest"]["duration_ms"] is None)
unknown_only = TokenLedger()
unknown_only.record(None)
ok("只有未知调用时状态明确说明未知", "用量未知" in unknown_only.describe())

print("\n=== 缓存看起来没生效要能报出来 ===")
led = TokenLedger()
for _ in range(11):
    led.record(Usage(input_other=500, input_cached=0, output=20))
ok("连续不命中 → 有告警", led.cache_suspect() != "", led.cache_suspect()[:60])
led2 = TokenLedger()
for _ in range(11):
    led2.record(Usage(input_other=100, input_cached=400, output=20))
ok("正常命中 → 没告警", led2.cache_suspect() == "", "命中率 80%")

print("\n=== 渲染 ===")
led = TokenLedger()
led.record(Usage(input_other=100, input_cached=900, output=50))
text = led.describe()
ok("说了上一轮", "上一轮" in text, text.replace("\n", " | "))
ok("说了命中率", "命中率" in text, text.replace("\n", " | "))
ok("说了累计", "累计" in text, text.replace("\n", " | "))
ok("说了平均每次", "平均每次" in text, text.replace("\n", " | "))
short = led.describe(short=True)
ok("short 模式只有一行", "\n" not in short, short)

led_empty = TokenLedger()
ok("没有记录时给人话", "还没有" in led_empty.describe(), led_empty.describe())

print("\n=== 接入点确实存在（防止只写了模块没接上）===")
root = _paths.REPO
aa = (root / "action_agent.py").read_text(encoding="utf-8")
ga = (root / "game_agent.py").read_text(encoding="utf-8")
mn = (root / "main.py").read_text(encoding="utf-8")
ok("action_agent 记用量", "ledger().record(" in aa)
ok("game_agent 记用量（玩家对话那条路不能是黑的）", "ledger().record(" in ga)
ok("/mc状态 显示用量", "【用量】" in mn and "ledger().describe()" in mn)

print("\n=== ActionAgent 多轮调用实际记账 ===")
if _paths.astrbot_available():
    from astrbot.core.provider.func_tool_manager import FunctionToolManager
    from astrcraft_plugin.action_agent import ActionAgent, ACTION_PROMPT
    from astrcraft_plugin.llm_tools_core import McPerceptionTools
    from astrcraft_plugin.perception_agent import PerceptionAgent
    from astrcraft_plugin.game_agent import GameChatAgent
    from astrcraft_plugin.main import MinecraftPlugin
    from unittest.mock import AsyncMock
    from astrbot.core.provider.entities import TokenUsage

    ok("实际 AstrBot TokenUsage 的全缓存输入", Usage.from_any(
        TokenUsage(input_other=0, input_cached=100, output=5),
    ) == Usage(0, 100, 5))

    class UsageEngine:
        async def call(self, method, params=None, **kwargs):
            if method == "state.get":
                return {
                    "connected": True, "position": {"x": 0, "y": 64, "z": 0},
                    "dimension": "overworld", "held_item": None,
                    "inventory_summary": {"entries": [{"name": "bread", "count": 2}]},
                }
            if method == "inventory.get":
                return {"items": {"bread": 2}, "held": None}
            raise AssertionError(f"未预期 RPC：{method}")

    class UsageProvider:
        def __init__(self, before=None):
            self.calls = 0
            self.before = before

        async def text_chat(self, **kwargs):
            self.calls += 1
            if self.before is not None:
                self.before()
            names = ["mc_inventory"] if self.calls <= 2 else []
            return SimpleNamespace(
                tools_call_name=names, tools_call_args=[{}] if names else [],
                tools_call_ids=[f"usage-{self.calls}"] if names else [],
                completion_text="已确认背包" if not names else "",
                usage=Usage(input_other=10 * self.calls, input_cached=90, output=self.calls),
                to_openai_tool_calls_model=lambda: [],
            )

    class UsagePlugin(McPerceptionTools):
        def __init__(self, provider):
            self.engine, self.connected, self.life = UsageEngine(), True, None
            self._brief_revision = 0
            manager = FunctionToolManager()
            manager.add_func(
                name="mc_inventory", func_args=[], desc="用量回归测试",
                handler=McPerceptionTools.tool_mc_inventory,
            )

            async def get_provider():
                return provider

            self.context = SimpleNamespace(
                get_using_provider_async=get_provider,
                provider_manager=SimpleNamespace(llm_tools=manager),
            )

        async def _ensure_engine(self):
            return True

        async def _system_prompt_for_mc(self, **kwargs):
            return "计量测试"

        async def _get_brief(self):
            return "位置已知，背包有面包"

        async def _my_memory(self, *args, **kwargs):
            return ""

    provider = UsageProvider()
    agent = ActionAgent(UsagePlugin(provider))
    measured = TokenLedger()
    with patch("astrcraft_plugin.tokens.ledger", return_value=measured):
        asyncio.run(agent.act(prompt="确认背包后结束", system=ACTION_PROMPT))
    ok(
        "每次模型往返都记，包括最后总结",
        provider.calls == measured.calls == 3 and measured.total.total == 336,
        f"provider={provider.calls}, 台账={measured.calls}, total={measured.total.total}",
    )
    ok(
        "工具缓存命中不减少模型用量，latest 仍是最后一次响应",
        agent.last_timing["read_cache_hits"] == 1 and measured.latest == Usage(30, 90, 3),
    )
    ok("自主请求分类和延迟有记录", measured.snapshot()["groups"]["autonomous"]["calls"] == 3
       and measured.snapshot()["latency_ms"]["samples"] == 3)

    provider = UsageProvider()
    plugin = UsagePlugin(provider)
    plugin.life = SimpleNamespace(_plan_revision=0, _pending_plan=None)
    provider.before = lambda: setattr(plugin.life, "_plan_revision", 1)
    agent = ActionAgent(plugin)
    measured = TokenLedger()
    with patch("astrcraft_plugin.tokens.ledger", return_value=measured):
        _, used = asyncio.run(agent.act(prompt="重连时旧响应作废", system=ACTION_PROMPT))
    ok(
        "环境变化后丢弃的响应也记录已消耗的用量",
        agent.last_timing["exit_reason"] == "state_changed" and used == []
        and provider.calls == measured.calls == 1 and measured.total.total == 101,
    )

    print("\n=== 侦察与聊天每轮计量（含最终总结） ===")
    provider = UsageProvider()
    measured = TokenLedger()
    with patch("astrcraft_plugin.tokens.ledger", return_value=measured):
        result, used = asyncio.run(PerceptionAgent(UsagePlugin(provider)).decide(
            prompt="先确认背包", system="输出决定",
        ))
    ok("侦察工具轮与强制最终结论均只记一次", result == "已确认背包"
       and len(used) == 2 and provider.calls == measured.requests == measured.calls == 3
       and measured.total.total == 336 and measured.snapshot()["groups"]["perception"]["calls"] == 3)

    provider = UsageProvider()
    measured = TokenLedger()
    with patch("astrcraft_plugin.tokens.ledger", return_value=measured):
        result = asyncio.run(GameChatAgent(UsagePlugin(provider)).handle("主人", "查一下背包"))
    ok("聊天工具轮和最终回复均只记一次", result == "已确认背包"
       and provider.calls == measured.requests == measured.calls == 3
       and measured.total.total == 336 and measured.snapshot()["groups"]["chat"]["calls"] == 3)

    print("\n=== 主入口：规划、纯文字、自主兜底及失败/取消 ===")
    async def main_usage():
        plugin = MinecraftPlugin.__new__(MinecraftPlugin)
        plugin._resolve_provider_id = AsyncMock(return_value="metrics-provider")
        plugin.context = SimpleNamespace(llm_generate=AsyncMock(return_value=SimpleNamespace(
            completion_text="测试响应", usage=TokenUsage(input_other=0, input_cached=100, output=5),
        )))
        measured = TokenLedger()
        with patch("astrcraft_plugin.tokens.ledger", return_value=measured):
            await plugin._llm_plan("规划", "JSON")
            await plugin._llm("自主兜底")
            await plugin._llm("玩家聊天", kind="chat")
            plugin.context.llm_generate.side_effect = RuntimeError("测试 provider 失败")
            value = await plugin._llm_plan("失败规划", "JSON")
            plugin.context.llm_generate.side_effect = asyncio.CancelledError()
            cancelled = False
            try:
                await plugin._llm("取消请求", kind="chat")
            except asyncio.CancelledError:
                cancelled = True
            plugin._resolve_provider_id.return_value = None
            await plugin._llm("没有配置模型")
        return measured, value, cancelled, plugin.context.llm_generate.await_count

    measured, failed_value, was_cancelled, actual_calls = asyncio.run(main_usage())
    snapshot = measured.snapshot()
    ok("主入口只记真正发出的请求，无 provider 不记", snapshot["calls"] == actual_calls == 5
       and snapshot["reported_calls"] == 3 and snapshot["total"]["total"] == 315)
    ok("规划/自主/聊天正确分组", [snapshot["groups"][key]["calls"]
       for key in ("planning", "autonomous", "chat")] == [2, 1, 2])
    ok("主入口失败和取消不被误算为零消耗", failed_value is None and was_cancelled
       and snapshot["failed_calls"] == snapshot["cancelled_calls"] == 1
       and snapshot["unknown_calls"] == 2 and snapshot["latest"]["usage"] is None)
    ok("所有已发出请求均有模型延迟", snapshot["latency_ms"]["samples"] == 5)

    class FailingProvider:
        async def text_chat(self, **kwargs):
            raise RuntimeError("测试 provider 失败")

    measured = TokenLedger()
    with patch("astrcraft_plugin.tokens.ledger", return_value=measured):
        result, used = asyncio.run(PerceptionAgent(UsagePlugin(FailingProvider())).decide(
            prompt="侦察失败", system="测试",
        ))
    ok("侦察失败也统计一次未知请求", result is None and not used
       and measured.snapshot()["groups"]["perception"]["failed_calls"] == 1
       and measured.requests == 1 and measured.calls == 0)
else:
    print("  ⏭ SKIP：ActionAgent 实际记账测试需要 AstrBot 运行时；纯台账测试已执行")

print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
sys.exit(1 if failed else 0)
