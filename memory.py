"""记忆层：让她"记得经历过什么"。

设计取舍（为什么不做向量库）：
- 插件要跑在用户机器上，引入 embedding 依赖会让安装变重
- MC 的记忆条目短、数量可控（几百条），关键词 + 重要度 + 新鲜度足够
- 关键检索场景是"跟当前处境有关的事"（在矿洞里 → 想起上次在矿洞差点死掉），
  这种场景靠关键词就能命中，不需要语义相似度

记忆的三条来源：
1. 引擎报告的事实（第一次见到某生物/方块、挖到值钱东西、走了很远）→ 最客观
2. 插件观察到的生存事件（死亡、被踢、断线）→ 带情绪色彩
3. 她自己说过的话与去过的地方 → 让人格表现有连续性

每条记忆带 `weight`（重要性），检索时按 weight × 新鲜度 × 关键词命中排序。
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable

from astrbot.api import logger

# 记忆类型 → 权重基数。决定"什么更值得被想起来"
KIND_WEIGHT = {
    "death": 9,  # 死亡最难忘
    "achievement": 8,  # 第一次做成某事
    "milestone": 7,  # 里程碑（走了很远、建好房子）
    "discovery": 6,  # 第一次见到某种生物/方块/地形
    "treasure": 5,  # 挖到好东西
    "social": 5,  # 和玩家的互动
    "place": 3,  # 去过的地方
    "mishap": 4,  # 小意外（掉坑、卡住、被岩浆烫）
    "trivial": 1,  # 日常琐事
}

# 检索时用来做关键词命中的类型标签
KIND_LABEL = {
    "death": "死亡",
    "achievement": "成就",
    "milestone": "里程碑",
    "discovery": "发现",
    "treasure": "收获",
    "social": "社交",
    "place": "地点",
    "mishap": "意外",
    "trivial": "日常",
}

MAX_ENTRIES = 400


def normalize_text(text: str) -> str:
    """把一句话归一化成"同类型的事长什么样"，用于判重。

    去掉数字、括号里的细节、空白——这样
    「挖矿失败：走到 (12, -58, 40) 被挡住了」和
    「挖矿失败：走到 (99, -12, 7) 被挡住了」会被认成同一件事。
    """
    t = str(text or "")
    t = re.sub(r"-?\d+(?:\.\d+)?", "N", t)  # 数字 → N
    t = re.sub(r"[（(][^）)]*[)）]", "", t)  # 括号里的细节去掉
    t = re.sub(r"\s+", "", t)  # 空白去掉
    return t


@dataclass
class MemoryEntry:
    kind: str
    text: str
    at: float = field(default_factory=time.time)
    weight: float = 0.0
    tags: list[str] = field(default_factory=list)
    # 发生时的上下文快照（位置/维度等），供"回想起当时的处境"
    context: dict = field(default_factory=dict)
    # **同一件事重复发生过几次**（见 remember 里的判重）
    count: int = 1

    def __post_init__(self):
        if not self.weight:
            self.weight = KIND_WEIGHT.get(self.kind, 2)

    def to_json(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_json(d: dict) -> "MemoryEntry":
        return MemoryEntry(
            kind=d.get("kind", "trivial"),
            text=d.get("text", ""),
            at=float(d.get("at", time.time())),
            weight=float(d.get("weight", 1)),
            tags=list(d.get("tags") or []),
            context=dict(d.get("context") or {}),
            count=int(d.get("count", 1) or 1),
        )


class MemoryStore:
    """她的经历记录。落盘为 JSON，随插件数据目录保存。"""

    def __init__(self, data_dir: Path, *, max_entries: int = MAX_ENTRIES):
        self._dir = Path(data_dir)
        self._path = self._dir / "memory.json"
        self._max = max_entries
        self._entries: list[MemoryEntry] = []
        self._dirty = False
        self._load()

    # ------------------------------------------------------------ 持久化

    def _load(self) -> None:
        try:
            if not self._path.exists():
                return
            data = json.loads(self._path.read_text(encoding="utf-8"))
            raw = [MemoryEntry.from_json(d) for d in (data.get("entries") or [])]
            # **载入时就归并一次**：老版本攒下来的重复条目（实测 392 条里
            # 只有 173 条不同）在这里一次性合并，不用等下次 prune。
            self._entries = self._consolidate(raw)
            if len(self._entries) != len(raw):
                self._dirty = True
                logger.info(
                    "已载入 %s 条 Minecraft 记忆（归并了 %s 条重复）",
                    len(self._entries),
                    len(raw) - len(self._entries),
                )
            else:
                logger.info("已载入 %s 条 Minecraft 记忆", len(self._entries))
        except Exception as exc:  # noqa: BLE001
            logger.warning("载入记忆失败（从空开始）：%s", exc)
            self._entries = []

    def save(self, *, force: bool = False) -> None:
        if not self._dirty and not force:
            return
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            # 只保留权重最高的若干条 + 最近的若干条，避免文件无限增长
            kept = self._prune()
            payload = {
                "version": 1,
                "saved_at": time.time(),
                "entries": [e.to_json() for e in kept],
            }
            self._path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
            self._dirty = False
        except Exception as exc:  # noqa: BLE001
            logger.warning("保存记忆失败：%s", exc)

    def _prune(self) -> list[MemoryEntry]:
        """超上限时**先归并、再淘汰**。

        原来只做"留最近的 + 留最重要的"，多出来的**直接丢掉**——等于把
        "这件事发生过很多次"这个信息一起丢了。实测她的记忆库 392 条里
        只有 173 条不同（65% 是重复），全是同一个失败攒出来的。

        现在分两步：
          1. **归并**：同一个 kind 里文字归一化后相同的，合成一条并把 count 累加
             （"砍树失败 ×29" 比 29 条一模一样的话有用得多，也占得少得多）
          2. 还不够就按"最近 + 最重要"淘汰
        """
        self._entries = self._consolidate(self._entries)
        if len(self._entries) <= self._max:
            return self._entries
        recent = sorted(self._entries, key=lambda e: e.at, reverse=True)[: self._max // 2]
        important = sorted(self._entries, key=lambda e: e.weight, reverse=True)[: self._max // 2]
        merged = {id(e): e for e in recent + important}
        kept = sorted(merged.values(), key=lambda e: e.at)
        self._entries = kept
        return kept

    @staticmethod
    def _consolidate(entries: list[MemoryEntry]) -> list[MemoryEntry]:
        """把同 kind + 同归一化文本的条目合成一条（保留最早的 at、累加 count）。"""
        by_key: dict[tuple[str, str], MemoryEntry] = {}
        out: list[MemoryEntry] = []
        for e in entries:
            key = (e.kind, normalize_text(e.text))
            first = by_key.get(key)
            if first is None:
                by_key[key] = e
                out.append(e)
                continue
            # 合成：次数累加，时间取最近，权重取最大（重要的事不该被稀释）
            first.count += e.count
            first.at = max(first.at, e.at)
            first.weight = max(first.weight, e.weight)
            if not first.context and e.context:
                first.context = e.context
        return out

    # ------------------------------------------------------------ 写入

    def remember(
        self,
        kind: str,
        text: str,
        *,
        tags: Iterable[str] | None = None,
        weight: float | None = None,
        context: dict | None = None,
        dedupe_window: float = 60.0,
    ) -> MemoryEntry | None:
        """记一件事。

        **判重分两层**（早期只有第一层，结果同一个失败攒了 29 条）：
          1. 短时间内（默认 60 秒）完全相同的文本 → 直接丢弃（防事件风暴）
          2. **归一化后相同的文本**（数字/括号细节不同也算同一件事）→
             不新增条目，而是把已有那条的 `count +1`、刷新时间、必要时提高权重

        为什么第二层重要：实测她的记忆库 392 条里只有 173 条不同——
        "砍树失败：Cannot read properties of null" 重复了 29 次，
        "挖石头失败：连续多次没有进展" 重复了 21 次。这些重复把真正有用的
        记忆挤出了上限，而且每轮塞进提示词的都是同一句话的 29 个副本。

        `count` 本身是**有用的信息**：失败 29 次说明这件事有系统性问题，
        比"失败过一次"值得注意得多（渲染时会显示"发生过 N 次"）。
        """
        text = (text or "").strip()
        if not text:
            return None
        now = time.time()
        # 第一层：时间窗内**同 kind** 且完全相同的，直接丢。
        # （要比 kind：同一句话可能既是"死亡"又是"意外"，那是两件事，
        #   实测不加这一条会把不同类型的事件互相吃掉）
        for e in reversed(self._entries[-20:]):
            if e.kind == kind and e.text == text and now - e.at < dedupe_window:
                return None

        # 第二层：归一化后相同 → 合并进已有条目（不新增）
        norm = normalize_text(text)
        if norm:
            for e in reversed(self._entries):
                if e.kind != kind:
                    continue
                if normalize_text(e.text) != norm:
                    continue
                e.count += 1
                e.at = now
                # 反复发生的事会"变重"，但设上限避免一条噪音压过一切
                e.weight = min(9.0, max(e.weight, float(weight) if weight is not None else e.weight) + 0.15)
                if context:
                    e.context = dict(context)
                self._dirty = True
                return e

        entry = MemoryEntry(
            kind=kind,
            text=text,
            at=now,
            weight=float(weight) if weight is not None else KIND_WEIGHT.get(kind, 2),
            tags=[str(t) for t in (tags or [])],
            context=dict(context or {}),
        )
        self._entries.append(entry)
        self._dirty = True
        return entry

    # ------------------------------------------------------------ 检索

    def recall(
        self,
        query: str = "",
        *,
        limit: int = 5,
        kinds: Iterable[str] | None = None,
        now: float | None = None,
        min_score: float = 0.0,
    ) -> list[MemoryEntry]:
        """按"跟当前处境的相关度"取几条记忆。

        打分 = 重要度 × 新鲜度衰减 × 关键词命中加成。
        关键词命中用简单分词：中文按 2-gram、英文按单词，够用且不引依赖。

        @param min_score 低于这个分数的直接丢掉（用于"只要真正相关的"）
        """
        now = now or time.time()
        kind_set = set(kinds) if kinds else None
        tokens = _tokenize(query)

        scored: list[tuple[float, MemoryEntry]] = []
        for e in self._entries:
            if kind_set and e.kind not in kind_set:
                continue
            age_h = max(0.0, (e.at - now if e.at > now else now - e.at) / 3600.0)
            # 新鲜度：12 小时内基本不衰减，之后按天缓慢衰减（记忆不会完全消失）
            freshness = 1.0 if age_h <= 12 else 1.0 / (1.0 + (age_h - 12) / 48.0)
            score = e.weight * freshness

            haystack = f"{e.text} {' '.join(e.tags)} {KIND_LABEL.get(e.kind, '')}".lower()
            hits = sum(1 for t in tokens if t in haystack)
            if tokens:
                score += hits * 3.0
                # 跟当前处境完全无关的琐事就别塞进上下文了（省 token）
                if hits == 0 and e.weight < 4:
                    continue
            if score < min_score:
                continue
            scored.append((score, e))

        scored.sort(key=lambda x: x[0], reverse=True)
        # 保持相关度顺序返回（不要再按时间重排）：
        # 调用方拿它拼 prompt，最相关的那条必须在最前面。
        return [e for _, e in scored[:limit]]

    def recent(self, limit: int = 8) -> list[MemoryEntry]:
        return sorted(self._entries, key=lambda e: e.at, reverse=True)[:limit]

    def stats(self) -> dict:
        by_kind: dict[str, int] = {}
        for e in self._entries:
            by_kind[e.kind] = by_kind.get(e.kind, 0) + 1
        return {"total": len(self._entries), "by_kind": by_kind}

    # ------------------------------------------------------------ 渲染

    def render_for_prompt(self, entries: list[MemoryEntry], *, now: float | None = None) -> str:
        """把记忆渲染成适合塞进 prompt 的几行文字。

        **保持传入顺序**，不要按时间重排。
        调用方（`recall`）已经按"相关度"排好了序，最相关的应该在最前面——
        早期这里按时间重排过一次，结果最相关的那条被挤到最后，
        LLM 看到的头一条反而是无关的记忆。
        """
        if not entries:
            return ""
        now = now or time.time()
        lines = []
        for e in entries:
            ago = _humanize_age(abs(now - e.at))
            label = KIND_LABEL.get(e.kind, "")
            prefix = f"{ago}前" if ago else "刚才"
            # **重复次数要显示出来**：失败 29 次和失败 1 次是两回事，
            # 前者说明这件事有系统性问题（该换做法了），后者只是运气不好。
            times = f"（发生过 {e.count} 次）" if e.count > 1 else ""
            lines.append(f"- {prefix}（{label}）{e.text}{times}")
        return "\n".join(lines)


# ---------------------------------------------------------------- 工具函数

_TOKEN_RE = re.compile(r"[a-zA-Z]{3,}|[\u4e00-\u9fff]{2,}")


def _tokenize(text: str) -> set[str]:
    """中英混合的粗分词：英文取 3 字母以上的词，中文取 2-gram。"""
    if not text:
        return set()
    tokens: set[str] = set()
    for m in _TOKEN_RE.finditer(text.lower()):
        s = m.group(0)
        if s.isascii():
            tokens.add(s)
        else:
            for i in range(len(s) - 1):
                tokens.add(s[i : i + 2])
    return tokens


def _humanize_age(seconds: float) -> str:
    if seconds < 90:
        return ""
    minutes = seconds / 60
    if minutes < 90:
        return f"{int(minutes)} 分钟"
    hours = minutes / 60
    if hours < 36:
        return f"{int(hours)} 小时"
    days = hours / 24
    if days < 30:
        return f"{int(days)} 天"
    return f"{int(days / 30)} 个月"
