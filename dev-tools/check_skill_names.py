#!/usr/bin/env python3
"""技能名一致性检查：Python 侧写死的技能名必须都在引擎注册表里。

## 它防的是什么

引擎里"会做什么"由 `engine/skills/index.js` 的 `SKILLS` 注册表定义，
而 Python 侧有**好几处把技能名写成字面量**：

  · `advisor.py` —— 生存顾问按阶段建议下一步做什么（`adv.skill = "mine_stone"`）
  · `life.py`    —— LLM 不可用时的兜底映射（`by_drive = {"explore": ("chop_tree", …)}`）

这些字面量会被**直接当技能名提交**给 `skill.run`：

  · `life.py` 的 `_fallback_decision()`  → `skill=advice.skill`
  · `life.py` 的 `_reconsider_if_looping()` 死循环兜底 → `skill=self._last_advice.skill`

写错一个名字的代价不是"报个错就完了"：

  1. 白烧**整整一轮模型往返**（几秒到几十秒，她站着不动）
  2. 记进 `_recent_failures` → 触发 `_should_back_off()` 的 **30 秒失败退避**
  3. 日志里只有一句「没有这个技能：xxx」，看不出是顾问写错了

**这个病真实发生过**：`advisor.py` 曾经建议 `craft(item="torch", count=8)`，
而当时 `SKILLS` 里**根本没有 `craft`**（只有 LLM 工具 `mc_craft`）。
后来补了真技能 `craft`，但"机制上的口子"还在——
所以这个检查器负责让**下一个**写错的名字在开发阶段就被抓住。

## 怎么抓

用 AST 找出 Python 侧**处于"技能位置"的字符串字面量**，而不是把所有字符串
都拿来比（那样 `oak_log`、`torch` 这些物品名会淹没结果）。识别的位置：

  · `X.skill = "名字"`（赋值）
  · `X.skill == / != "名字"`（比较）
  · `{"skill": "名字"}` / `skill="名字"`（字典键与关键字实参）
  · `return "名字", {...}`（顾问的 `_food_advice()` 就是这种元组返回）
  · `{"explore": ("名字", {...})}`（life.py 的 `by_drive` 映射）

## 用法

    py -3 dev-tools/check_skill_names.py
    py -3 dev-tools/check_skill_names.py --repo D:\\path\\to\\Astrcraft

退出码非 0 表示有技能名对不上。仓库根默认取本文件上一级，可用环境变量
`ASTRCRAFT_REPO` 覆盖。
"""

from __future__ import annotations

import argparse
import ast
import io
import re
import sys
from pathlib import Path

# Windows 控制台默认 GBK，直接 print ✅/❌ 会抛 UnicodeEncodeError。
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import ENGINE_DIR, REPO, read_text  # noqa: E402

# 扫描哪些 Python 文件（相对仓库根）
PY_SOURCES = ("advisor.py", "life.py")

# SKILLS 注册表里每条技能的写法是**恰好两格缩进**的 `名字: {`；
# `params:` / `run(` 这些字段缩进更深，不会误匹配。
SKILL_ENTRY_RE = re.compile(r"^  ([A-Za-z_][A-Za-z0-9_]*):\s*\{", re.MULTILINE)

# 至少要有这么多技能，否则说明**检查器自己没解析对**（而不是"代码很干净"）。
MIN_EXPECTED_SKILLS = 15
# 必须存在的几个技能（用来证明解析出来的确实是那张表）
SANITY_SKILLS = ("chop_tree", "mine_ores", "mine_stone", "make_tools")
# 一定不存在的名字：如果它被判为"存在"，说明提取逻辑退化成"什么都接受"
PROBE_NAME = "definitely_not_a_real_skill_xyz"


def load_skill_registry(engine_dir: Path) -> set[str]:
    """从 engine/skills/index.js 里取出 SKILLS 的键集合。"""
    src = read_text(engine_dir / "skills" / "index.js")
    if not src:
        raise SystemExit(f"❌ 读不到技能注册表：{engine_dir / 'skills' / 'index.js'}")
    marker = "const SKILLS = {"
    start = src.find(marker)
    if start < 0:
        raise SystemExit("❌ engine/skills/index.js 里找不到 `const SKILLS = {`（结构变了？）")
    end = src.find("\n};", start)
    if end < 0:
        raise SystemExit("❌ 找不到 SKILLS 对象的结束位置（结构变了？）")
    block = src[start:end]
    return set(SKILL_ENTRY_RE.findall(block))


def _const_str(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _is_skill_attr(node: ast.AST) -> bool:
    """`xxx.skill` 这种属性访问。"""
    return isinstance(node, ast.Attribute) and node.attr == "skill"


# 技能名的形状：ASCII 小写 + 下划线（注册表里的键全都是这个形状）。
# **只用在"含糊的位置"上**（见下面 dict 键那条规则），不用于赋值/比较等
# 明确位置——那些位置写什么名字都要报出来，包括写错成中文的。
SKILL_SHAPE_RE = re.compile(r"^[a-z][a-z0-9_]*$")


def _tuple_starts_with_skill(node: ast.AST) -> str | None:
    """识别"技能建议"形状的元组：第一个元素是技能名，**后面还有字典参数**。

    形如 `return "cook_food", {}, "有生食，先烤熟再吃"`（advisor 的 `_food_advice`）
    或 `("chop_tree", {"count": 4})`（life 的 `by_drive` 映射）。

    为什么要这个限定：`advisor.py` 的 `_stage_of()` 也返回二元组，
    但那是**阶段名**（`("bare", "一穷二白…")`），根本不是技能。
    判据"后面跟着一个 dict 参数"能干净地把两者分开——
    技能建议一定带参数表，阶段名不带。
    """
    if not isinstance(node, ast.Tuple) or len(node.elts) < 2:
        return None
    name = _const_str(node.elts[0])
    if not name:
        return None
    if not any(isinstance(e, ast.Dict) for e in node.elts[1:]):
        return None
    return name


def extract_skill_literals(path: Path) -> list[tuple[str, int]]:
    """抽出"处于技能位置"的字符串字面量，返回 [(名字, 行号)]。"""
    source = read_text(path)
    if not source:
        return []
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        raise SystemExit(f"❌ {path.name} 语法错误，无法解析：{exc}")

    found: list[tuple[str, int]] = []

    def add(node: ast.AST, value: str | None) -> None:
        if value:
            found.append((value, getattr(node, "lineno", 0)))

    for node in ast.walk(tree):
        # X.skill = "名字"
        if isinstance(node, ast.Assign):
            if any(_is_skill_attr(t) for t in node.targets):
                add(node.value, _const_str(node.value))

        # X.skill == / != "名字"（两个方向都认）
        elif isinstance(node, ast.Compare):
            operands = [node.left, *node.comparators]
            if any(_is_skill_attr(o) for o in operands):
                for o in operands:
                    add(o, _const_str(o))

        # {"skill": "名字"} —— **最含糊的位置**：
        # life.py 的 `_recent_outcomes` 里也有 `{"skill": "（想事情）", ...}`，
        # 那只是"这件事不是技能"的记录，不是要提交的技能名。
        # 所以这里要求名字符合技能名形状，避免把这类记录误报成坏技能。
        elif isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values):
                if _const_str(k) == "skill":
                    name = _const_str(v)
                    if name and SKILL_SHAPE_RE.match(name):
                        add(v, name)
            # {"explore": ("chop_tree", {...})} —— life.py 的 by_drive 映射
            for v in node.values:
                add(v, _tuple_starts_with_skill(v))

        # LifeDecision(skill="名字") / 其它关键字实参
        elif isinstance(node, ast.Call):
            for kw in node.keywords:
                if kw.arg == "skill":
                    add(kw.value, _const_str(kw.value))

        # return "名字", {...} —— advisor 的 _food_advice()
        elif isinstance(node, ast.Return):
            add(node.value, _tuple_starts_with_skill(node.value))

    return found


def main() -> int:
    ap = argparse.ArgumentParser(description="技能名一致性检查")
    ap.add_argument("--repo", default=None, help="仓库根目录（默认取本文件上一级 / ASTRCRAFT_REPO）")
    args = ap.parse_args()

    repo = Path(args.repo).resolve() if args.repo else REPO
    engine_dir = repo / "engine"

    print("=== 技能名一致性检查 ===")
    print(f"仓库根：{repo}")

    skills = load_skill_registry(engine_dir)

    # ---- 检查器自检（防止它退化成"永远通过"）----
    problems: list[str] = []
    if len(skills) < MIN_EXPECTED_SKILLS:
        print(f"❌ 只解析出 {len(skills)} 个技能（预期 >= {MIN_EXPECTED_SKILLS}）——检查器自己坏了")
        print(f"   解析结果：{sorted(skills)}")
        return 2
    missing_sanity = [s for s in SANITY_SKILLS if s not in skills]
    if missing_sanity:
        print(f"❌ 注册表里缺少这些基础技能：{missing_sanity}——检查器或注册表有问题")
        return 2
    if PROBE_NAME in skills:
        print("❌ 探针名字被判为存在——提取逻辑坏了（它接受一切）")
        return 2
    print(f"引擎注册表：{len(skills)} 个技能（{', '.join(sorted(skills))}）")
    print("检查器自检：解析数量、基础技能、探针均正常 ✅\n")

    # ---- 逐文件核对 ----
    total_literals = 0
    for name in PY_SOURCES:
        path = repo / name
        if not path.is_file():
            problems.append(f"{name} 不存在（仓库根不对？）")
            continue
        literals = extract_skill_literals(path)
        total_literals += len(literals)
        unknown = sorted({(v, ln) for v, ln in literals if v not in skills})
        print(f"{name}：找到 {len(literals)} 处技能名字面量")
        if unknown:
            for v, ln in unknown:
                print(f"  ❌ 第 {ln} 行：「{v}」不在引擎注册表里")
                problems.append(f"{name}:{ln} 的技能名「{v}」不存在")
        else:
            names = sorted({v for v, _ in literals})
            print(f"  ✅ 全部存在：{', '.join(names) if names else '（这个文件里没有技能名字面量）'}")

    # ---- 提取器有效性：必须真的抓到东西 ----
    if total_literals == 0:
        print("\n❌ 一处技能名字面量都没抓到——提取逻辑失效（而不是代码干净）")
        return 2

    # ---- 特别盯住 advisor.py：它的输出会被直接执行 ----
    print("\n=== 重点：advisor.py 的建议会被直接提交给 skill.run ===")
    adv_literals = extract_skill_literals(repo / "advisor.py")
    adv_names = sorted({v for v, _ in adv_literals})
    if not adv_names:
        print("❌ advisor.py 里一个技能名都没抓到——提取逻辑失效")
        return 2
    bad = [n for n in adv_names if n not in skills]
    if bad:
        print(f"  ❌ 顾问会建议这些不存在的技能：{bad}")
    else:
        print(f"  ✅ 顾问可能建议的技能全部真实存在：{', '.join(adv_names)}")

    print("\n=== 结果 ===")
    if problems:
        print(f"❌ {len(problems)} 个问题：")
        for p in problems:
            print(f"  ✗ {p}")
        print("\n  修法：要么在 engine/skills/index.js 的 SKILLS 里注册这个技能，")
        print("        要么把 Python 侧的名字改成注册表里已有的技能。")
        return 1
    print(f"✅ 通过：{total_literals} 处技能名字面量全部指向真实存在的技能")
    return 0


if __name__ == "__main__":
    sys.exit(main())
