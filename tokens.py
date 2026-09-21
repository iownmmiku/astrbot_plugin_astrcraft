"""Token 台账（W6，见 docs/PLAN_v2.md）。

**为什么需要这个**：在这之前完全没有用量记录——我不知道一次决策花多少 token、
缓存有没有生效、提示词分层（把稳定内容放 system）到底省下了多少。
没有数据就没法谈"不烧 token"。

照 numen 的 `TokenLedger`，但有一个关键细节必须照做：

    **要显示"上一轮"的命中率，不是累计命中率。**
    numen 的注释原话："累计命中率会被历史稀释，看不出刚才那轮打穿了缓存。"

这句话是有道理的：她可能前面几十轮都命中缓存，刚才那一轮因为改了一句
system 提示词而全部重算——**累计命中率几乎看不出变化**，
而"上一轮命中率"会立刻掉到 0。

四元用量（AstrBot 的 `TokenUsage` 就是这个形状）：
    input_other   输入里没命中缓存的
    input_cached  输入里命中缓存的
    output        输出
    total         = 三者之和
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class Usage:
    """一次调用的用量（四元）。字段名对齐 AstrBot 的 `TokenUsage`。"""

    input_other: int = 0
    input_cached: int = 0
    output: int = 0

    @property
    def input_total(self) -> int:
        return self.input_other + self.input_cached

    @property
    def total(self) -> int:
        return self.input_other + self.input_cached + self.output

    @property
    def hit_rate(self) -> float:
        """缓存命中率（0~1）。没有输入时算 0，不返回 NaN。"""
        n = self.input_total
        return (self.input_cached / n) if n else 0.0

    def __add__(self, other: "Usage") -> "Usage":
        return Usage(
            input_other=self.input_other + other.input_other,
            input_cached=self.input_cached + other.input_cached,
            output=self.output + other.output,
        )

    def is_empty(self) -> bool:
        return self.total == 0

    @staticmethod
    def from_any(obj) -> "Usage":
        """从 AstrBot 的 `TokenUsage`（或任何同形状的对象）转过来。

        **宽容取值**：不同 provider 给的字段可能不全（比如没有缓存字段），
        缺的按 0 算——台账不能因为少一个字段就整个坏掉。
        """
        if obj is None:
            return Usage()

        def pick(*names) -> int:
            for n in names:
                v = getattr(obj, n, None)
                if v is None and isinstance(obj, dict):
                    v = obj.get(n)
                if isinstance(v, (int, float)) and v > 0:
                    return int(v)
            return 0

        # 有的 provider 用 prompt_tokens / completion_tokens 这套名字
        return Usage(
            input_other=pick("input_other", "prompt_tokens", "input_tokens"),
            input_cached=pick("input_cached", "cached_tokens", "cache_read_input_tokens"),
            output=pick("output", "completion_tokens", "output_tokens"),
        )


@dataclass
class TokenLedger:
    """跨轮累计 + **上一轮**分开记。

    只用两个槽：`total`（累计）和 `latest`（最近一次）。
    "上一轮命中率"取 `latest`——这正是 numen 强调的那个区别。
    """

    total: Usage = field(default_factory=Usage)
    latest: Usage = field(default_factory=Usage)
    calls: int = 0
    last_at: float = 0.0
    # 最近若干次是否**一次都没命中缓存**——用来判断"缓存是不是根本没生效"
    _zero_hit_streak: int = 0
    started_at: float = field(default_factory=time.time)

    def record(self, usage) -> Usage:
        """记一次调用。返回归一化后的 Usage（方便调用方直接打印）。"""
        u = usage if isinstance(usage, Usage) else Usage.from_any(usage)
        if u.is_empty():
            # 没报用量的 provider：不算进 calls（否则"平均每次"会被 0 拉低）
            return u
        self.total = self.total + u
        self.latest = u
        self.calls += 1
        self.last_at = time.time()
        if u.input_total and u.input_cached == 0:
            self._zero_hit_streak += 1
        else:
            self._zero_hit_streak = 0
        return u

    # ------------------------------------------------------------ 读

    @property
    def latest_hit_rate(self) -> float:
        """**上一轮**的命中率。这是最该看的那个数（累计会被历史稀释）。"""
        return self.latest.hit_rate

    @property
    def total_hit_rate(self) -> float:
        return self.total.hit_rate

    def cache_suspect(self) -> str:
        """缓存看起来没生效吗？返回原因，正常则返回空串。

        判据：连续多次调用**输入不为 0 但命中为 0**。
        一次两次可能是内容真的变了；连着十几次就是缓存根本没工作
        （提示词前缀不稳定、或者 provider 不支持缓存）。
        """
        if self._zero_hit_streak >= 10 and self.calls >= 10:
            return (
                f"连续 {self._zero_hit_streak} 次调用一次缓存都没命中"
                "——提示词前缀可能不稳定（有每次都变的内容混进了 system），"
                "或者这个 provider 不支持缓存"
            )
        return ""

    def describe(self, *, short: bool = False) -> str:
        """一句人话。给 /mc状态 和日志用。"""
        if not self.calls:
            return "还没有用量记录（她还没调过模型）"
        lat = self.latest
        pct = self.latest_hit_rate * 100
        line = (
            f"上一轮：输入 {lat.input_total}（命中缓存 {lat.input_cached}，"
            f"命中率 {pct:.0f}%）+ 输出 {lat.output} = {lat.total}"
        )
        if short:
            return line
        tot = self.total
        mins = max(1.0, (time.time() - self.started_at) / 60.0)
        out = [
            line,
            f"累计：{self.calls} 次调用，输入 {tot.input_total}"
            f"（命中 {tot.input_cached}，命中率 {self.total_hit_rate * 100:.0f}%）"
            f" + 输出 {tot.output} = **{tot.total}**",
            f"平均每次 {tot.total / max(1, self.calls):.0f} token"
            f"（约 {tot.total / mins:.0f}/分钟）",
        ]
        suspect = self.cache_suspect()
        if suspect:
            out.append(f"⚠️ {suspect}")
        return "\n".join(out)


# 全局单例：插件和 agent 都往这里记，/mc状态 从它读。
# 用单例而不是注入，是因为记录点分散在多个 agent 里，
# 而台账本身没有任何依赖（不需要配置、不需要事件循环）。
_LEDGER = TokenLedger()


def ledger() -> TokenLedger:
    return _LEDGER


def reset() -> None:
    """清空（测试和 /mc重置用量 用）。"""
    global _LEDGER
    _LEDGER = TokenLedger()
