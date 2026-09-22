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
ok("OpenAI 的 prompt/completion 那套", o.input_other == 100 and o.output == 5, str(o))
ok("OpenAI 的 cached_tokens 也认", o.input_cached == 40, str(o))
ok("字段不全不炸（缺的按 0）", Usage.from_any(Bare()).total == 7, str(Usage.from_any(Bare())))
ok("None 不炸", Usage.from_any(None).is_empty() is True)

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
ok(
    "action_agent 每一步都记（不是只记最后一步）",
    aa.count("ledger().record(") >= 1 and "for _ in range(self.max_steps)" in aa,
    "6 步 = 6 次往返，只记最后一步会严重低估",
)

print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
sys.exit(1 if failed else 0)
