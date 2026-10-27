"""知识库测试：她会自己积累经验吗。

用户的要求是"做出一个类似于知识库的东西，让她会学着怎样做更好"。
这个测试把知识库的关键行为钉住：

  1. 攻略能读（人写的种子知识）
  2. 教训能存、能检索、**能去重**（同一个坑不该记十条）
  3. 世界笔记能追加
  4. 从失败里提炼教训的过滤（废话不该进库）
  5. 提示词里真的会出现她学到的经验
"""

from __future__ import annotations

import sys
import tempfile
import json
import os
from pathlib import Path
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT))

import _paths  # noqa: E402

# knowledge.py 顶层 import `astrbot.api` → 没有 AstrBot 运行时就大声 SKIP
_paths.require_astrbot("test_knowledge")

_paths.load_plugin()
from astrcraft_plugin.knowledge import KnowledgeBase, _similar  # noqa: E402

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


def main() -> None:
    print("=== 知识库 ===")
    tmp = Path(tempfile.mkdtemp())
    kb = KnowledgeBase(tmp)

    # 1) 攻略
    docs = kb.docs()
    check("能列出内置攻略", len(docs) >= 6, "、".join(docs))
    check("能读到攻略内容", "盖" in (kb.read_doc("building") or ""), "building.md")
    check("读不存在的攻略返回 None", kb.read_doc("nope") is None)

    # 2) 教训：存 / 去重 / 检索
    r1 = kb.add_lesson("挖石头前先确认手上有镐，没有就先做一把", tags=["mine_stone"])
    check("能记教训", "记住了" in r1, r1[:30])
    r2 = kb.add_lesson("挖石头前一定要先看看有没有镐", tags=["mine_stone"])
    check("同一个坑换了说法不会重复记", "很像" in r2, r2[:30])
    kb.add_lesson("合成木镐要先有工作台", tags=["craft"])
    kb.add_lesson("晚上出门要带火把", tags=["night"])
    check("不同主题的教训都能记下", len(kb.lessons()) == 3, f"{len(kb.lessons())} 条")
    check("太短的废话被拒", "太短" in kb.add_lesson("小心"), "")

    hit = kb.recall("我要去挖石头")
    check("按处境能检索到相关教训", "手上有镐" in hit, hit.replace("\n", " | ")[:60])
    check("检索会附上相关攻略名", "mc_load_skill" in hit, "")
    miss = kb.recall("怎么造火箭")
    check("无关的事检索不到（不乱塞）", "手上有镐" not in miss, miss[:40] or "（空）")

    # 3) 相似度分界（阈值 0.35 的依据）
    check(
        "相似度分界正确（不同 0.00 / 同义 0.71）",
        _similar("合成木镐要先有工作台", "挖石头前先确认手上有镐") < 0.2
        and _similar("晚上出门要带火把", "晚上出门记得带火把和剑") > 0.5,
    )

    # 4) 世界笔记
    check("能记世界笔记", "记下了" in kb.add_note("家在 (120, 64, -250)"), "")
    check("笔记能读回来", "(120, 64, -250)" in kb.notes(), "")

    # 5) 从失败提炼：过滤废话
    check("「无需记录」不入库", kb.parse_lesson("无需记录", skill="x") == "", "")
    check("「我失败了，下次小心」这种废话不入库", kb.parse_lesson("我失败了，下次要小心", skill="x") == "", "")
    good = kb.parse_lesson("挖铁矿前必须先用石镐，木镐挖不动", skill="mine_ores")
    check("有用的教训会入库", "记住了" in good, good[:30])

    # 6) 提示词里真的会带上她学到的
    prompt_block = kb.render_for_prompt("挖石头")
    check("经验会喂进提示词", "你从经验里学到的事" in prompt_block and "手上有镐" in prompt_block, "")
    empty_kb = KnowledgeBase(Path(tempfile.mkdtemp()))
    # 没有经验时**不该**用"经验"的标题（标错来源会让模型以为那是它自己的经验）。
    # 指向攻略是可以的——那本来就是知识库该做的事。
    empty_block = empty_kb.render_for_prompt("随便什么")
    check("没有经验时不冒充经验（标题如实）", "你从经验里学到的事" not in empty_block, empty_block[:40] or "（空）")

    # 7) 持久化
    kb2 = KnowledgeBase(tmp)
    check("重启后教训还在", len(kb2.lessons()) == 4, f"{len(kb2.lessons())} 条")

    # 存档可能被截断或混入单条坏数据；读取和后续保存不能毁掉其余经验。
    damaged_dir = Path(tempfile.mkdtemp())
    damaged_path = damaged_dir / "knowledge" / "lessons.json"
    damaged_path.parent.mkdir()
    valid = {"text": "iron mining requires a stone pickaxe", "tags": ["iron"], "used": 1}
    raw = json.dumps([valid, {**valid, "tags": [1]}, {**valid, "used": "broken"},
                      {**valid, "text": 123}, {**valid, "at": float("nan")},
                      {**valid, "used_at": "bad time"}, {**valid, "tags": ["\ud800"]}],
                     ensure_ascii=True).encode("utf-8")
    damaged_path.write_bytes(raw)
    recovered = KnowledgeBase(damaged_dir)
    check("单条坏教训不会污染有效记录", len(recovered.lessons()) == 1)
    try:
        recall_ok = "stone pickaxe" in recovered.recall("iron")
    except (TypeError, ValueError, AttributeError):
        recall_ok = False
    check("抢救后的教训可以正常召回", recall_ok)
    check("抢救前保留损坏原档", any(p.read_bytes() == raw for p in damaged_path.parent.glob("lessons.json.corrupt-*")))

    blocked_dir = Path(tempfile.mkdtemp())
    blocked_path = blocked_dir / "knowledge" / "lessons.json"
    blocked_path.parent.mkdir()
    blocked_path.write_bytes(raw)
    with patch.object(os, "replace", side_effect=OSError("cannot preserve corruption")):
        blocked = KnowledgeBase(blocked_dir)
    result = blocked.add_lesson("furnace fuel must be reserved before smelting")
    check("坏档留存失败时后续写入也不能覆盖原档", blocked_path.read_bytes() == raw and "记住了" not in result)

    with patch.object(Path, "read_bytes", side_effect=PermissionError("cannot read original")):
        unreadable = KnowledgeBase(blocked_dir)
    result = unreadable.add_lesson("torches must be prepared before night travel")
    check("原档读取受阻时禁止用空库覆盖", blocked_path.read_bytes() == raw and "记住了" not in result)

    corrupt_dir = Path(tempfile.mkdtemp())
    corrupt_path = corrupt_dir / "knowledge" / "lessons.json"
    corrupt_path.parent.mkdir()
    corrupt_raw = b'[{"text": "unfinished'
    corrupt_path.write_bytes(corrupt_raw)
    corrupt = KnowledgeBase(corrupt_dir)
    result = corrupt.add_lesson("digging stone requires an actual pickaxe")
    check("整档不可恢复时不以新记录覆盖坏档", corrupt_path.read_bytes() == corrupt_raw)
    check("无法保存时不会声称已经记住", "记住了" not in result)

    atomic_dir = Path(tempfile.mkdtemp())
    atomic = KnowledgeBase(atomic_dir)
    atomic.add_lesson("stone mining requires a pickaxe", tags=["stone"])
    atomic_path = atomic_dir / "knowledge" / "lessons.json"
    atomic_raw = atomic_path.read_bytes()
    with patch.object(os, "replace", side_effect=OSError("injected replacement failure")):
        result = atomic.add_lesson("cooking raw beef requires a furnace", tags=["beef"])
    check("替换失败保留原教训库", atomic_path.read_bytes() == atomic_raw)
    check("替换失败反馈未持久化", "记住了" not in result)
    check("替换失败清理临时文件", not list(atomic_path.parent.glob(".*.tmp")))

    with patch.object(os, "fsync", side_effect=OSError("injected flush failure")):
        result = atomic.add_lesson("wheat crafting needs three actual items", tags=["wheat"])
    check("刷盘失败保留原教训库", atomic_path.read_bytes() == atomic_raw and "记住了" not in result)

    unicode_dir = Path(tempfile.mkdtemp())
    unicode_kb = KnowledgeBase(unicode_dir)
    result = unicode_kb.add_lesson("unencodable lesson \ud800")
    check("无法编码的新教训不污染内存和后续保存", not unicode_kb.lessons() and "记住了" not in result)

    # 8) 上限与淘汰
    # 注意：这 140 条必须**真的各不相同**——第一版我写成"第 N 条很不一样的独特经验内容N号"，
    # 结果被去重逻辑（正确地）判成同一条，只剩 1 条，测试反而假失败。
    small = KnowledgeBase(Path(tempfile.mkdtemp()))
    topics = ["挖矿", "伐木", "盖房", "打猎", "战斗", "储存", "熔炼", "种地", "钓鱼", "睡觉",
              "火把", "箱子", "床", "工作台", "熔炉", "铁砧", "附魔", "药水", "船", "矿车"]
    acts = ["先看背包", "先确认工具", "先找平地", "先点火把", "先吃东西", "先躲起来",
            "记得带回来", "别在夜里做", "留够材料", "分两步做"]
    for i in range(140):
        small.add_lesson(f"{topics[i % len(topics)]}的时候{acts[(i // len(topics)) % len(acts)]}{i}次", tags=[topics[i % len(topics)]])
    check("教训数量有上限（不会无限膨胀）", len(small.lessons(limit=999)) <= 120, f"{len(small.lessons(limit=999))} 条")

    print("\n=== 结果 ===")
    if failed == 0:
        print(f"✅ 全部通过（{passed} 项断言）")
        sys.exit(0)
    print(f"❌ {failed} 项失败（{passed} 项通过）")
    sys.exit(1)


main()
