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
import math
import os
import re
import tempfile
import time
from dataclasses import dataclass, field, asdict
from decimal import Decimal, InvalidOperation
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

# **合并同类条目时最多留几条原始证据**（W5）。
# 留证据是为了不让坐标/数字在合并时消失；但也不能无限涨——
# 一条"走不到某处"的教训攒 50 个坐标，喂给模型反而是噪音。
MAX_EVIDENCE = 5


def _finite_number(value: Any, name: str) -> float:
    """接受旧存档的数字字符串，但不让布尔值/NaN/无穷大进入排序和计数。"""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f"{name} 必须是有限数字")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{name} 必须是有限数字")
    return number


def _world_key(context: dict | None) -> tuple[str | None, str | None]:
    """未知归属也有自己的键，不能把旧的无归属记录归到某个已知世界。"""
    context = context or {}
    world = (context.get("server"), context.get("dimension"))
    if any(value is not None and not isinstance(value, str) for value in world):
        raise ValueError("server/dimension 必须是字符串或未知归属")
    return world


def normalize_text(text: str) -> str:
    """把一句话归一化成"同类型的事长什么样"，用于判重。

    去掉数字、括号里的细节、空白——这样
    「挖矿失败：走到 (12, -58, 40) 被挡住了」和
    「挖矿失败：走到 (99, -12, 7) 被挡住了」会被认成同一件事。

    **注意：这个函数只用来"判重"，不要用它来存文本。**
    踩过（W5）：合并同类条目时保留了第一条的 `text`，而判重会把数字抹掉，
    于是第二个坐标永久丢失、而且没人会发现。现在每次的原始文本都进
    `MemoryEntry.evidence`，判重只负责"要不要合并"。
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
    # ---- W5：记忆是"累积的账"（见 docs/PLAN_v2.md）----
    #
    # **为什么加这两个字段**：原来合并同类条目时只保留第一条的 `text`，
    # 而判重用的 `normalize_text` 会把数字换成 N、把括号内容删掉——
    # 于是「走不到 (12, -58, 40)」和「走不到 (99, -12, 7)」被认成同一件事，
    # 合并之后**第二个坐标永久丢失**，而且没人会发现。
    #
    # 这正是 numen 的 Compactor 警告过的那件事（它的原话）：
    #   "每压缩一轮，三轮前记下的坐标与教训就少一点，而且没人会发现。
    #    摘要是累积的账，只能增补与推进，不能反复转述。"
    #
    # 所以：`first_seen` 记**第一次**见到它的时间（合并时绝不被覆盖），
    # `evidence` 记**每一次的原始文本**（保留坐标/数字），只增不改。
    first_seen: float = 0.0
    evidence: list[str] = field(default_factory=list)

    def __post_init__(self):
        if not self.weight:
            self.weight = KIND_WEIGHT.get(self.kind, 2)
        if not self.first_seen:
            self.first_seen = self.at
        if not self.evidence and self.text:
            self.evidence = [self.text]

    def to_json(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_json(d: dict) -> "MemoryEntry":
        if not isinstance(d, dict):
            raise ValueError("记忆条目必须是对象")
        # JSON 转义也能带入孤立代理字符；校验必须覆盖实际保存用的 UTF-8 编码。
        json.dumps(d, ensure_ascii=False, allow_nan=False).encode("utf-8")
        kind, text = d.get("kind", "trivial"), d.get("text", "")
        if not isinstance(kind, str) or not isinstance(text, str):
            raise ValueError("kind/text 必须是字符串")
        at = _finite_number(d.get("at", time.time()), "at")
        weight = _finite_number(d.get("weight", 1), "weight")
        if weight < 0:
            raise ValueError("weight 不能为负数")
        raw_count = d.get("count") if d.get("count") is not None else 1
        if isinstance(raw_count, bool) or not isinstance(raw_count, (int, float, str)):
            raise ValueError("count 必须是正整数")
        try:
            count = Decimal(raw_count)
        except InvalidOperation as exc:
            raise ValueError("count 必须是正整数") from exc
        # 旧版把空计数和 0 回落为 1；保留这项迁移行为。
        if not count.is_finite() or count < 0 or count != count.to_integral_value():
            raise ValueError("count 必须是正整数")
        count = int(count) or 1  # 大整数及整数字符串不能经过 float 后丢精度。
        tags = d.get("tags") if d.get("tags") is not None else []
        evidence = d.get("evidence") if d.get("evidence") is not None else []
        for name, value in (("tags", tags), ("evidence", evidence)):
            if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                raise ValueError(f"{name} 必须是字符串列表")
        context = d.get("context") if d.get("context") is not None else {}
        if not isinstance(context, dict):
            raise ValueError("context 必须是对象")
        _world_key(context)
        # 保留 JSON 快照，避免调用方以后修改嵌套位置时改掉已有记忆的上下文。
        context = json.loads(json.dumps(context, ensure_ascii=False, allow_nan=False))
        first_seen = d.get("first_seen", at)
        first_seen = _finite_number(first_seen if first_seen is not None else 0, "first_seen")
        return MemoryEntry(
            kind=kind,
            text=text,
            at=at,
            weight=weight,
            tags=list(tags),
            context=dict(context),
            count=count,
            # 老文件没有这两个字段 → 回落成"就是这一条"（不丢已有信息）
            first_seen=first_seen,
            evidence=list(evidence),
        )


class MemoryStore:
    """她的经历记录。落盘为 JSON，随插件数据目录保存。"""

    def __init__(self, data_dir: Path, *, max_entries: int = MAX_ENTRIES):
        self._dir = Path(data_dir)
        self._path = self._dir / "memory.json"
        self._backup_path = self._dir / "memory.json.bak"
        self._max = max_entries
        self._entries: list[MemoryEntry] = []
        self._dirty = False
        self._write_protected = False
        self._preserved_corrupt: dict[Path, bytes] = {}
        self._load()

    # ------------------------------------------------------------ 持久化

    @staticmethod
    def _decode(raw: bytes) -> tuple[list[MemoryEntry], list[int]]:
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
            raise ValueError("记忆存档必须包含 entries 列表")
        json.dumps({key: value for key, value in data.items() if key != "entries"}, allow_nan=False)
        entries: list[MemoryEntry] = []
        invalid: list[int] = []
        for index, item in enumerate(data["entries"]):
            try:
                entries.append(MemoryEntry.from_json(item))
            except (TypeError, ValueError, OverflowError, RecursionError):
                invalid.append(index)
        return entries, invalid

    @staticmethod
    def _atomic_write(path: Path, raw: bytes) -> None:
        """只替换完整且已刷盘的同目录临时文件，绝不截断已有存档。"""
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        try:
            stream = os.fdopen(fd, "wb")
            fd = None
            with stream:
                if stream.write(raw) != len(raw):
                    raise OSError("记忆临时文件写入不完整")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if fd is not None:
                os.close(fd)
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                # 临时路径已经不存在，无需再次清理；原档替换结果不受影响。
                pass

    def _preserve_corrupt(self, path: Path, raw: bytes) -> bool:
        if self._preserved_corrupt.get(path) == raw:
            return True
        try:
            preserved = path.with_name(f"{path.name}.corrupt-{time.time_ns()}")
            self._atomic_write(preserved, raw)
            self._preserved_corrupt[path] = raw
            logger.warning("记忆坏档已保留：%s", preserved)
            return True
        except Exception as exc:  # noqa: BLE001
            self._write_protected = True
            logger.warning("无法保留记忆坏档，已启用写保护：%s", exc)
            return False

    def _read_file(self, path: Path) -> tuple[bytes | None, list[MemoryEntry], bool]:
        """返回原始内容、可救回条目及整档是否有效；不可读文件一律写保护。"""
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return None, [], False
        except Exception as exc:  # noqa: BLE001
            self._write_protected = True
            logger.warning("无法读取记忆存档，已启用写保护：%s", exc)
            return None, [], False
        try:
            entries, invalid = self._decode(raw)
            if not invalid:
                return raw, entries, True
            logger.warning("记忆存档有 %s 条无效记录，保留其余 %s 条", len(invalid), len(entries))
        except (UnicodeError, TypeError, ValueError, OverflowError, RecursionError) as exc:
            entries = []
            logger.warning("记忆存档格式损坏：%s", exc)
        self._preserve_corrupt(path, raw)
        return raw, entries, False

    def _load(self) -> None:
        raw, entries, valid = self._read_file(self._path)
        if not valid and not entries:
            backup_raw, backup_entries, backup_valid = self._read_file(self._backup_path)
            if backup_valid:
                entries = backup_entries
                self._dirty = True
                logger.warning("已从有效备份恢复 Minecraft 记忆")
            elif raw is not None or backup_raw is not None or self._write_protected:
                # 整库恢复失败，即使坏档已隔离，也不能拿空库或新记录覆盖原档。
                self._write_protected = True
                logger.warning("没有有效记忆备份，已启用写保护（强制保存也不会覆盖）")
        elif not valid:
            self._dirty = True
        self._entries = self._consolidate(entries)
        if len(self._entries) != len(entries):
            self._dirty = True
        logger.info("已载入 %s 条 Minecraft 记忆", len(self._entries))

    def save(self, *, force: bool = False) -> None:
        if not self._dirty and not force:
            return
        if self._write_protected:
            logger.warning("记忆存档处于写保护，未覆盖原档或备份")
            return
        self._dirty = True
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            # 只保留权重最高的若干条 + 最近的若干条，避免文件无限增长
            kept = self._prune()
            payload = {
                "version": 1,
                "saved_at": time.time(),
                "entries": [e.to_json() for e in kept],
            }
            raw = json.dumps(payload, ensure_ascii=False, indent=1, allow_nan=False).encode("utf-8")
            _, invalid = self._decode(raw)
            if invalid:
                raise ValueError("内存中的记忆含无效记录，未写入")
            old_raw, old_entries, old_valid = self._read_file(self._path)
            _, _, backup_valid = self._read_file(self._backup_path)
            if old_raw is not None and not old_valid and not old_entries and not backup_valid:
                self._write_protected = True
            if self._write_protected:
                logger.warning("记忆存档无法安全保存，已启用写保护")
                return
            # 备份只来自完整有效的主档；坏主档永远不能替换好备份。
            if old_valid:
                self._atomic_write(self._backup_path, old_raw)
            elif not backup_valid:
                # 首次保存也留下一个经验证的完整版本。
                self._atomic_write(self._backup_path, raw)
            self._atomic_write(self._path, raw)
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
        """把同 kind + 同归一化文本的条目合成一条——**只增补，不重述**（W5）。

        合并时**必须只增不改**。原来这里有两个丢信息的地方：

          1. `first.at = max(first.at, e.at)` —— 把"第一次见到它"的时间
             覆盖成最近一次，于是"这件事最早是什么时候开始的"没了。
             现在 `first_seen` 单独存，**合并时绝不动它**。
          2. 只保留第一条的 `text`，而判重会把数字换成 N、把括号删掉 ——
             于是「走不到 (12,-58,40)」和「走不到 (99,-12,7)」合并后
             **第二个坐标永久丢失**。现在每次的原始文本都进 `evidence`。

        能这么改的前提是"**记忆条目本身不是摘要**"：它就是一条条原始记录，
        合并只是把重复的收拢、把证据留住，不是把它转述成更短的话。
        """
        by_key: dict[tuple[str, str, str | None, str | None], MemoryEntry] = {}
        out: list[MemoryEntry] = []
        for e in entries:
            key = (e.kind, normalize_text(e.text), *_world_key(e.context))
            first = by_key.get(key)
            if first is None:
                by_key[key] = e
                out.append(e)
                continue
            # 合并：次数累加、时间取最近、权重取最大（重要的事不该被稀释）
            first.count += e.count
            first.at = max(first.at, e.at)
            first.weight = max(first.weight, e.weight)
            # **首见时间只往早取，绝不往晚覆盖**（原来这里丢的就是它）
            if e.first_seen:
                first.first_seen = (
                    min(first.first_seen, e.first_seen) if first.first_seen else e.first_seen
                )
            # **证据只增不减**：把这一条的原始文本也留下（坐标就靠它活着）
            for text in e.evidence or ([e.text] if e.text else []):
                if text and text not in first.evidence:
                    first.evidence.append(text)
            # 证据不能无限涨：留最近 MAX_EVIDENCE 条
            if len(first.evidence) > MAX_EVIDENCE:
                first.evidence = first.evidence[-MAX_EVIDENCE:]
            # 代表文本及其上下文来自同一次经历；不能借用另一坐标的 context。
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
        try:
            entry = MemoryEntry.from_json({
                "kind": kind,
                "text": text,
                "at": now,
                "weight": weight if weight is not None else KIND_WEIGHT.get(kind, 2),
                "tags": [str(t) for t in (tags or [])],
                "context": context,
            })
        except (TypeError, ValueError, OverflowError, RecursionError) as exc:
            logger.warning("忽略无法持久化的记忆：%s", exc)
            return None
        context = entry.context
        world = _world_key(context)
        # 第一层：时间窗内**同 kind** 且完全相同的，直接丢。
        # （要比 kind：同一句话可能既是"死亡"又是"意外"，那是两件事，
        #   实测不加这一条会把不同类型的事件互相吃掉）
        for e in reversed(self._entries[-20:]):
            if (
                e.kind == kind and e.text == text and _world_key(e.context) == world
                and now - e.at < dedupe_window
            ):
                return None

        # 第二层：归一化后相同 → 合并进已有条目（不新增）
        norm = normalize_text(text)
        if norm:
            for e in reversed(self._entries):
                if e.kind != kind:
                    continue
                if _world_key(e.context) != world:
                    continue
                if normalize_text(e.text) != norm:
                    continue
                e.count += 1
                e.at = now
                # **把这一次的原始文本留成证据**（W5）。
                #
                # 这里是**实际会跑**的那条合并路径（写入时判重）——
                # 我第一版只改了 `_consolidate`（加载时合并），于是
                # "第二个坐标还在吗" 的断言立刻挂了：真正丢信息的是这里。
                # 判重会把数字抹掉，所以判重用的 key 不能当内容用，
                # 每次的原文必须单独存一份。
                if text and text not in e.evidence:
                    e.evidence.append(text)
                if len(e.evidence) > MAX_EVIDENCE:
                    e.evidence = e.evidence[-MAX_EVIDENCE:]
                # 首见时间绝不被覆盖（它是"这件事从什么时候开始的"）
                if not e.first_seen:
                    e.first_seen = now
                # 反复发生的事会"变重"，但设上限避免一条噪音压过一切
                e.weight = min(9.0, max(e.weight, float(weight) if weight is not None else e.weight) + 0.15)
                # 保留代表 text 对应的 context；本次原文仍增补到 evidence。
                self._dirty = True
                return e

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
        relevant_only: bool = False,
        context: dict | None = None,
    ) -> list[MemoryEntry]:
        """按"跟当前处境的相关度"取几条记忆。

        打分 = 重要度 × 新鲜度衰减 × 关键词命中加成。
        关键词命中用简单分词：中文按 2-gram、英文按单词，够用且不引依赖。

        @param min_score 低于这个分数的直接丢掉（用于"只要真正相关的"）
        """
        now = now or time.time()
        kind_set = set(kinds) if kinds else None
        tokens = _tokenize(query)
        if relevant_only and not tokens:
            return []

        scored: list[tuple[float, MemoryEntry]] = []
        for e in self._entries:
            if kind_set and e.kind not in kind_set:
                continue
            if context and any(
                context.get(key) is not None and e.context.get(key) is not None
                and str(context[key]) != str(e.context[key])
                for key in ("server", "dimension")
            ):
                continue
            age_h = max(0.0, (e.at - now if e.at > now else now - e.at) / 3600.0)
            # 新鲜度：12 小时内基本不衰减，之后按天缓慢衰减（记忆不会完全消失）
            freshness = 1.0 if age_h <= 12 else 1.0 / (1.0 + (age_h - 12) / 48.0)
            score = e.weight * freshness

            haystack = f"{e.text} {' '.join(e.tags)} {KIND_LABEL.get(e.kind, '')}".lower()
            hits = sum(1 for t in tokens if t in haystack)
            if relevant_only and hits == 0:
                continue
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
            line = f"- {prefix}（{label}）{e.text}{times}"
            # **多次发生时把"第一次是什么时候"和具体证据一起给出来**（W5）。
            # 只给"最近一次"是不够的：她说"这件事发生过 5 次"，
            # 但不知道从什么时候开始、也不知道每次具体在哪——
            # 而具体坐标恰恰是判重时被抹掉的东西。
            if e.count > 1:
                if e.first_seen and e.first_seen < e.at - 60:
                    first_ago = _humanize_age(abs(now - e.first_seen))
                    if first_ago:
                        line += f"，最早在 {first_ago}前"
                extra = [t for t in (e.evidence or []) if t and t != e.text]
                if extra:
                    # 只举 2 条，且截断——证据是给模型看的线索，不是全文
                    samples = "；".join(t[:80] for t in extra[:2])
                    line += f"\n    具体几次：{samples}"
            lines.append(line)
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
