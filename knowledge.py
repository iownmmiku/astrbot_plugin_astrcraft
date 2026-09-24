"""她的知识库：**会自己长大的经验**。

## 三层知识

| 层 | 来源 | 存哪 | 谁写 |
|---|---|---|---|
| **攻略** | 人写的（`plugin/skills_docs/*.md`） | 仓库（只读） | 我 / 用户 |
| **教训** | 她从失败和成功里提炼的 | `data/knowledge/lessons.json` | **她自己** |
| **笔记** | 世界里的坐标与发现 | `data/knowledge/notes.md` | **她自己** |

## 为什么要做这个

前面几轮暴露的核心问题是：**她不会从错误里学到东西**。
同样的失败（"缺 oak_planks"、"需要工作台"、"被自己封在洞里"）会反复发生，
每一轮都当成全新情况处理——因为她的经验只存在"记忆流水账"里（`MemoryStore`
记的是"发生了什么"），**没有提炼成"下次该怎么做"**。

技能可以是 Markdown（人写知识）；这里再往前一步：
**知识由她自己在实践中长出来**，攻略只是种子。

## 学习回路

    任务失败 → 把"做了什么 + 报错 + 当时状态"交给模型 → 让它写一条**可复用的教训**
    → 存进 lessons.json（带标签）→ 下次遇到同类事情时按标签检索出来喂回去

关键约束（都是为了让这套东西真的有用）：
- **教训必须可操作**：不是"我失败了"，而是"挖石头前先确认手上有镐"。
- **去重**：同一件事不重复记（相似度高的直接跳过）。
- **有上限**：只留最近且最常被用到的（不然会无限膨胀、反而污染提示词）。
- **可检索**：按标签（技能名/物品名）+ 关键词打分，只把最相关的几条喂进去。
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

from astrbot.api import logger

# 教训最多留这么多条（超了就按"最近用过"淘汰）
MAX_LESSONS = 120
# 每条教训最多这么长（长了就不像"一句话经验"，而且会占满提示词）
MAX_LESSON_CHARS = 220
# 每次喂回提示词最多几条
RECALL_LIMIT = 5

# 中文里没有空格，所以关键词要按"字/词"切；英文按单词切。
# 这是刻意不做向量检索的：不引依赖、不联网、结果可解释（能说清"为什么想起这条"）。
_WORD_RE = re.compile(r"[a-zA-Z_]{3,}|[\u4e00-\u9fff]{2,}")


def _keywords(text: str) -> set[str]:
    """把一段话切成关键词（英文单词 + 中文二字以上片段）。"""
    out: set[str] = set()
    for m in _WORD_RE.findall(str(text or "").lower()):
        if m.isascii():
            out.add(m)
        else:
            # 中文按 2 字滑窗切，既能匹配"工作台"也能匹配"合成台"里的"成台"
            for i in range(len(m) - 1):
                out.add(m[i : i + 2])
    return out


def _similar(a: str, b: str) -> float:
    """两个句子的相似度。

    取「Jaccard」和「包含度」里的较大值：
    中文短句的共同关键词往往只占一小部分，纯 Jaccard 会把
    "挖石头前先确认手上有镐" 和 "挖石头前一定要先看看有没有镐"
    判成不相似（实测 0.21），于是同一个坑被记成两条。
    包含度（交集 / 较短那句）能抓住"一句话基本被另一句覆盖"的情形。
    """
    ka, kb = _keywords(a), _keywords(b)
    if not ka or not kb:
        return 0.0
    inter = len(ka & kb)
    jaccard = inter / len(ka | kb)
    containment = inter / min(len(ka), len(kb))
    return max(jaccard, containment)


class KnowledgeBase:
    """攻略（只读）+ 教训与笔记（可读写）。"""

    def __init__(self, data_dir: Path | None = None, docs_dir: Path | None = None):
        self._data_dir = Path(data_dir) if data_dir else None
        self._docs_dir = Path(docs_dir) if docs_dir else Path(__file__).resolve().parent / "skills_docs"
        self._lessons: list[dict] = []
        self._load()

    # ------------------------------------------------------------ 持久化

    @property
    def _lessons_path(self) -> Path | None:
        return (self._data_dir / "knowledge" / "lessons.json") if self._data_dir else None

    @property
    def _notes_path(self) -> Path | None:
        return (self._data_dir / "knowledge" / "notes.md") if self._data_dir else None

    def _load(self) -> None:
        path = self._lessons_path
        if not path or not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception as exc:  # noqa: BLE001
            logger.info("读取教训库失败：%s", exc)
            return
        if isinstance(data, list):
            self._lessons = [d for d in data if isinstance(d, dict) and d.get("text")]
            logger.info("她记得 %d 条自己总结的教训", len(self._lessons))

    def _save(self) -> None:
        path = self._lessons_path
        if not path:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(self._lessons[-MAX_LESSONS:], ensure_ascii=False, indent=1),
                encoding="utf-8",
            )
        except Exception as exc:  # noqa: BLE001
            logger.info("保存教训库失败：%s", exc)

    # ------------------------------------------------------------ 攻略（人写的）

    def docs(self) -> list[str]:
        if not self._docs_dir.exists():
            return []
        return sorted(p.stem for p in self._docs_dir.glob("*.md"))

    def read_doc(self, name: str) -> str | None:
        want = str(name or "").strip().lower().replace(".md", "")
        path = self._docs_dir / f"{want}.md"
        if not path.exists():
            return None
        try:
            return path.read_text(encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            logger.info("读攻略 %s 失败：%s", want, exc)
            return None

    # ------------------------------------------------------------ 教训（她自己写的）

    def add_lesson(self, text: str, tags: list[str] | None = None, source: str = "") -> str:
        """记下一条教训。返回给模型看的结果（写没写成、为什么）。"""
        body = " ".join(str(text or "").split()).strip()
        if len(body) < 6:
            return "教训太短了，写清楚「什么情况下该怎么做」才有用"
        if len(body) > MAX_LESSON_CHARS:
            body = body[:MAX_LESSON_CHARS] + "…"
        # 去重：和已有教训太像就不再记（否则同一个坑会记十条）。
        # 阈值 0.35 是实测出来的分界：
        #   不同主题 0.00 ｜ 同一个坑换了说法 0.38 ｜ 明显同义 0.71
        for old in self._lessons:
            if _similar(old.get("text", ""), body) >= 0.35:
                old["used_at"] = time.time()
                self._save()
                return f"这条和已有的很像，就不重复记了：{old['text'][:40]}…"
        entry = {
            "text": body,
            "tags": [str(t).strip() for t in (tags or []) if str(t).strip()][:6],
            "source": str(source or "")[:60],
            "at": time.time(),
            "used": 0,
            "used_at": 0.0,
        }
        self._lessons.append(entry)
        # 超上限就淘汰"最久没用过"的那些（而不是简单丢最早的）
        if len(self._lessons) > MAX_LESSONS:
            self._lessons.sort(key=lambda d: d.get("used_at") or d.get("at") or 0, reverse=True)
            dropped = self._lessons[MAX_LESSONS:]
            self._lessons = self._lessons[:MAX_LESSONS]
            logger.info("教训库满了，淘汰 %d 条最久没用的", len(dropped))
        self._save()
        logger.info("她学到一条教训：%s", body[:60])
        return f"记住了：{body}"

    def lessons(self, limit: int = 20) -> list[dict]:
        return list(self._lessons[-limit:])

    def clear_lessons(self) -> int:
        n = len(self._lessons)
        self._lessons = []
        self._save()
        return n

    # ------------------------------------------------------------ 笔记（坐标/发现）

    def add_note(self, text: str) -> str:
        body = " ".join(str(text or "").split()).strip()
        if not body:
            return "笔记是空的"
        path = self._notes_path
        if not path:
            return "没有可写的数据目录"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%m-%d %H:%M")
            with path.open("a", encoding="utf-8") as fh:
                fh.write(f"- [{stamp}] {body}\n")
            return f"记下了：{body}"
        except Exception as exc:  # noqa: BLE001
            logger.info("写笔记失败：%s", exc)
            return f"写不进去：{exc}"

    def notes(self, limit: int = 30) -> str:
        path = self._notes_path
        if not path or not path.exists():
            return ""
        try:
            lines = [ln.strip() for ln in path.read_text(encoding="utf-8-sig").splitlines() if ln.strip()]
        except Exception:  # noqa: BLE001
            return ""
        return "\n".join(lines[-limit:])

    # ------------------------------------------------------------ 检索

    def recall(self, query: str, limit: int = RECALL_LIMIT) -> str:
        """按相关性取知识：攻略命中就附攻略名，教训按打分排序。

        返回一段可直接塞进提示词的文本（没命中就返回空串）。
        """
        q = _keywords(query)
        parts: list[str] = []

        # 1) 教训：按"标签命中 + 关键词重合"打分
        scored = []
        for les in self._lessons:
            text = les.get("text", "")
            score = len(q & _keywords(text)) * 2.0
            for tag in les.get("tags") or []:
                if tag.lower() in (query or "").lower() or _keywords(tag) & q:
                    score += 3.0
            if score > 0:
                scored.append((score, les))
        scored.sort(key=lambda t: -t[0])
        if scored:
            for _, les in scored[:limit]:
                les["used"] = int(les.get("used") or 0) + 1
                les["used_at"] = time.time()
                parts.append(f"· {les.get('text')}")
            self._save()

        # 2) 攻略：命中关键词就提示"可以读哪篇"
        hits = []
        for name in self.docs():
            doc = self.read_doc(name) or ""
            if q & _keywords(doc):
                hits.append(name)
        if hits:
            parts.append("（相关攻略：" + "、".join(f"mc_load_skill({h})" for h in hits[:3]) + "）")

        # 3) 世界笔记
        notes = self.notes(limit=8)
        if notes and q:
            note_lines = [ln for ln in notes.splitlines() if q & _keywords(ln)]
            if note_lines:
                parts.append("【你记过的相关事】\n" + "\n".join(note_lines[:4]))

        return "\n".join(parts)

    def render_for_prompt(self, query: str = "", limit: int = RECALL_LIMIT) -> str:
        """喂进提示词的知识块（带标题，方便模型分辨来源）。"""
        body = self.recall(query, limit) if query else ""
        if not body:
            # 没有相关命中时，给"最常用的几条"兜底——她的经验不该因为检索没命中就消失
            top = sorted(self._lessons, key=lambda d: -(d.get("used") or 0))[:3]
            if not top:
                return ""
            body = "\n".join(f"· {d.get('text')}" for d in top)
        # 标题要如实：只有真的带上了"经验"才用经验的标题，
        # 否则只是指向攻略——标错来源会让模型以为那是它自己的经验。
        has_lesson = any(ln.startswith("· ") for ln in body.splitlines())
        header = "【你从经验里学到的事】" if has_lesson else "【可能有用的攻略】"
        return f"{header}\n{body}"

    def stats(self) -> dict:
        return {
            "docs": len(self.docs()),
            "lessons": len(self._lessons),
            "notes": len(self.notes(limit=999).splitlines()) if self.notes(limit=999) else 0,
        }

    # ------------------------------------------------------------ 学习回路

    def build_lesson_prompt(self, *, skill: str, error: str, context: str = "") -> str:
        """拼一段"请把这次失败提炼成教训"的提示词。

        刻意要求**可操作**：模型很容易写成"我失败了，下次要小心"这种废话，
        那种教训存下来只会污染提示词。所以这里把格式钉死。
        """
        return f"""你刚刚做「{skill}」失败了。

【报错原文】
{error[:400]}

【当时的处境】
{context[:400] or '（没有更多信息）'}

请把这次失败提炼成**一条以后能用的经验**，要求：
- 一句话，不超过 60 字，**必须可操作**（写清"什么情况下该怎么做"）
- 不要写"我失败了""下次要小心"这类没有信息量的话
- 如果这个失败是环境造成的偶然（比如网络断了），就回答：无需记录

只回答那条经验本身，不要解释、不要加引号。如果不需要记录，就回答：无需记录"""

    def parse_lesson(self, raw: str | None, *, skill: str, source: str = "") -> str:
        """把模型写的教训收进库里（顺手过滤废话）。"""
        text = " ".join(str(raw or "").split()).strip().strip("「」\"'。")
        if not text or "无需记录" in text or len(text) < 8:
            return ""
        # 过滤"没有信息量"的句式（这些是最常见的偷懒回答）
        useless = ("我失败了", "下次小心", "要小心", "失败了", "注意安全")
        if len(text) < 20 and any(u in text for u in useless):
            return ""
        return self.add_lesson(text, tags=[skill], source=source)

