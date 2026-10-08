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

import copy
import math
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

    def snapshot(self) -> dict:
        return {
            "input_other": self.input_other, "input_cached": self.input_cached,
            "input_total": self.input_total, "output": self.output,
            "total": self.total, "hit_rate": self.hit_rate,
        }

    @staticmethod
    def from_any(obj) -> "Usage":
        """从 AstrBot 的 `TokenUsage`（或任何同形状的对象）转过来。

        **宽容取值**：不同 provider 给的字段可能不全（比如没有缓存字段），
        缺的按 0 算——台账不能因为少一个字段就整个坏掉。
        """
        if obj is None:
            return Usage()

        def read(source, name):
            return source.get(name) if isinstance(source, dict) else getattr(source, name, None)

        def pick(source, *names) -> int | None:
            for n in names:
                v = read(source, n)
                if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
                    # 显式 0 是有效值，不能继续回退到另一套字段重复计缓存。
                    return max(0, int(v))
            return None

        uncached = pick(obj, "input_other")
        cached = pick(obj, "input_cached")
        output = pick(obj, "output", "completion_tokens", "output_tokens") or 0
        if uncached is not None or cached is not None:
            # AstrBot 已完成缓存拆分；不能再从 prompt_tokens/input_tokens 加一次。
            return Usage(uncached or 0, cached or 0, output)

        cache_read = pick(obj, "cache_read_input_tokens")
        cache_creation = pick(obj, "cache_creation_input_tokens")
        if cache_read is not None or cache_creation is not None:
            # Anthropic 的 input_tokens 本来就不含读取/创建缓存的输入。
            return Usage(
                (pick(obj, "input_tokens", "prompt_tokens") or 0) + (cache_creation or 0),
                cache_read or 0, output,
            )

        cached = pick(obj, "cached_tokens")
        if cached is None:
            for field_name in ("prompt_tokens_details", "input_tokens_details"):
                cached = pick(read(obj, field_name), "cached_tokens")
                if cached is not None:
                    break
        total_input = pick(obj, "prompt_tokens", "input_tokens")
        cached = cached or 0
        if total_input is not None:
            # OpenAI 两套 API 的输入合计均包含命中缓存的部分。
            cached = min(cached, total_input)
        return Usage(
            input_other=max(0, (total_input or 0) - cached),
            input_cached=cached,
            output=output,
        )


@dataclass
class TokenLedger:
    """跨轮累计 + **上一轮**分开记。

    `total` / `latest` 保留已报告用量的旧接口；requests、分组与 recent
    也记录未报告用量的请求，供控制台区分未知消耗和实际的零缓存命中。
    """

    total: Usage = field(default_factory=Usage)
    latest: Usage = field(default_factory=Usage)
    calls: int = 0
    last_at: float = 0.0
    # 最近若干次是否**一次都没命中缓存**——用来判断"缓存是不是根本没生效"
    _zero_hit_streak: int = 0
    started_at: float = field(default_factory=time.time)
    requests: int = 0
    failed_calls: int = 0
    cancelled_calls: int = 0
    _latest_record: dict | None = None
    _groups: dict = field(default_factory=dict)
    _recent: list = field(default_factory=list)

    def record(self, usage, *, kind: str = "autonomous", duration_seconds: float | None = None,
               status: str = "ok") -> Usage:
        """记一次模型请求；已报告用量和未知用量分开，兼容旧 calls 接口。

        AstrBot 的默认 TokenUsage() 全为 0，代表 provider 未报告用量；
        这类请求仍统计次数和延迟，但不会作为零消耗加入 token 均值。
        """
        u = usage if isinstance(usage, Usage) else Usage.from_any(usage)
        if kind not in ("autonomous", "planning", "perception", "chat"):
            kind = "autonomous"
        if status not in ("ok", "failed", "cancelled"):
            status = "ok"
        elapsed = None
        if (isinstance(duration_seconds, (int, float)) and not isinstance(duration_seconds, bool)
                and math.isfinite(duration_seconds) and duration_seconds >= 0):
            elapsed = round(duration_seconds * 1000, 3)
        now = time.time()
        self.requests += 1
        self.last_at = now
        self.failed_calls += status == "failed"
        self.cancelled_calls += status == "cancelled"
        group = self._groups.setdefault(kind, {
            "calls": 0, "reported_calls": 0, "failed_calls": 0, "cancelled_calls": 0,
            "total": Usage(), "duration_ms": 0.0, "duration_samples": 0,
            "last_duration_ms": None, "latest": None,
        })
        group["calls"] += 1
        group["failed_calls"] += status == "failed"
        group["cancelled_calls"] += status == "cancelled"
        if elapsed is not None:
            group["duration_ms"] += elapsed
            group["duration_samples"] += 1
        group["last_duration_ms"] = elapsed
        record = {"kind": kind, "status": status, "at": now,
                  "duration_ms": elapsed, "usage": None if u.is_empty() else u.snapshot()}
        group["latest"] = record
        self._latest_record = record
        self._recent.append(record)
        del self._recent[:-30]
        if u.is_empty():
            self._zero_hit_streak = 0
            return u
        group["reported_calls"] += 1
        group["total"] = group["total"] + u
        self.total = self.total + u
        self.latest = u
        self.calls += 1
        if u.input_total and u.input_cached == 0:
            self._zero_hit_streak += 1
        else:
            self._zero_hit_streak = 0
        return u

    def snapshot(self) -> dict:
        """JSON DTO，未知用量/延迟为 null；总量只累计 provider 报告部分。"""
        groups = {}
        for kind in ("autonomous", "planning", "perception", "chat"):
            group = self._groups.get(kind, {})
            calls = group.get("calls", 0)
            reported = group.get("reported_calls", 0)
            samples = group.get("duration_samples", 0)
            duration = group.get("duration_ms", 0.0)
            groups[kind] = {
                "calls": calls, "reported_calls": reported, "unknown_calls": calls - reported,
                "failed_calls": group.get("failed_calls", 0),
                "cancelled_calls": group.get("cancelled_calls", 0),
                "total": group["total"].snapshot() if reported else None,
                "latest": group.get("latest"),
                "latency_ms": {"total": round(duration, 3), "samples": samples,
                               "average": round(duration / samples, 3) if samples else None,
                               "latest": group.get("last_duration_ms")},
            }
        duration = sum(group["latency_ms"]["total"] for group in groups.values())
        samples = sum(group["latency_ms"]["samples"] for group in groups.values())
        return copy.deepcopy({
            "schema_version": 1, "started_at": self.started_at, "last_at": self.last_at or None,
            "calls": self.requests, "reported_calls": self.calls,
            "unknown_calls": self.requests - self.calls,
            "failed_calls": self.failed_calls, "cancelled_calls": self.cancelled_calls,
            "total": self.total.snapshot() if self.calls else None,
            "latest": self._latest_record, "groups": groups,
            "latency_ms": {"total": round(duration, 3), "samples": samples,
                           "average": round(duration / samples, 3) if samples else None,
                           "latest": self._latest_record["duration_ms"] if self._latest_record else None},
            "recent": list(self._recent), "cache_warning": self.cache_suspect(),
        })

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
        if not self.requests:
            return "还没有用量记录（她还没调过模型）"
        if not self.calls:
            return f"已调用模型 {self.requests} 次；用量未知（provider 未报告 Token）"
        lat = self.latest
        pct = self.latest_hit_rate * 100
        line = (
            f"上一轮：输入 {lat.input_total}（命中缓存 {lat.input_cached}，"
            f"命中率 {pct:.0f}%）+ 输出 {lat.output} = {lat.total}"
        )
        if self._latest_record and self._latest_record["usage"] is None:
            line = "上一轮：用量未知（provider 未报告 Token）"
        if short:
            return line
        tot = self.total
        mins = max(1.0, (time.time() - self.started_at) / 60.0)
        out = [
            line,
            f"累计：{self.requests} 次调用（{self.calls} 次报告用量，"
            f"{self.requests - self.calls} 次未知），已报告输入 {tot.input_total}"
            f"（命中 {tot.input_cached}，命中率 {self.total_hit_rate * 100:.0f}%）"
            f" + 输出 {tot.output} = **{tot.total}**",
            f"已报告调用平均每次 {tot.total / max(1, self.calls):.0f} token"
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
