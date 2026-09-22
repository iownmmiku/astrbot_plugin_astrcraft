#!/usr/bin/env python3
"""**模型必须看得见全部技能**（P1）的回归测试。

## 它钉住的是什么

`life.py` 的决策提示词原来用 `skills[:12]` 渲染技能清单，而引擎有 21 个技能——
**9 个技能模型根本看不到**：`cook_food / hunt / food_chain / blueprint /
sleep / interact / shoot / shield / craft`。

后果不是"少了个选项"，而是**它不知道自己会**：不会想到"照图纸盖房子""打猎"
"射箭""举盾""单件合成"，只能靠 advisor 恰好建议、或者主动调 `mc_skills` 去查。
这与整个设计目标——"它知道的 = 它能做的"——直接矛盾。

## 这个测试测的是**真链路**，不是复制品

    引擎注册表 describeAll()  →  main.MinecraftPlugin._skill_catalog()  →  life.render_skill_catalog()

三段都是真代码：
  · 第一段用 `node` 加载真的 `engine/skills/index.js`（它不需要 node_modules）
  · 第二段直接调真的解析器（用一个只带 `engine` 的假 self，绕开 AstrBot 运行时）
  · 第三段直接调真的渲染函数

**没有复制任何源码**，也没有把真实清单抄一份进测试（抄的那份自己也会漂）。

用法：
    $env:PYTHONPATH='<AstrBot>/backend/app'
    & '<AstrBot>/backend/python/python.exe' dev-tools/test_skill_visibility.py
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _paths  # noqa: E402

_paths.require_astrbot("test_skill_visibility")
_paths.load_plugin()

from astrcraft_plugin.life import render_skill_catalog  # noqa: E402
from astrcraft_plugin.main import MinecraftPlugin  # noqa: E402

passed = 0
failed = 0


def ok(msg: str, cond: bool, detail: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✅ {msg}" + (f" — {detail}" if detail else ""))
    else:
        failed += 1
        print(f"  ❌ {msg}" + (f" — {detail}" if detail else ""))


def engine_skill_list() -> list[str]:
    """用 node 取引擎注册表的真实 describeAll() 输出（不需要 node_modules）。"""
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        print("⏭  SKIP：PATH 里找不到 node，无法读取引擎注册表。")
        sys.exit(0)
    script = (
        "const S=require(process.argv[1]);"
        "process.stdout.write(JSON.stringify(S.describeAll()));"
    )
    proc = subprocess.run(
        [node, "-e", script, str(_paths.ENGINE_DIR / "skills" / "index.js")],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        print(f"❌ 加载引擎注册表失败（exit={proc.returncode}）：\n{proc.stderr[-600:]}")
        sys.exit(2)
    return json.loads(proc.stdout)


class _FakeEngine:
    """只提供 `_skill_catalog` 真正用到的那两样东西。"""

    def __init__(self, skills: list[str]):
        self.running = True
        self._skills = skills

    async def call(self, method, params=None, timeout=None):  # noqa: ANN001
        assert method == "skill.list", f"意外的调用：{method}"
        return {"skills": self._skills}


class _FakePlugin:
    def __init__(self, skills: list[str]):
        self.engine = _FakeEngine(skills)


def main() -> int:
    print("=== P1：模型必须看得见全部技能 ===\n")

    raw = engine_skill_list()
    print(f"引擎注册表（describeAll）共 {len(raw)} 项：")
    print(f"  {raw[0]}")
    print(f"  …")

    # ---- ① 真的解析器（main.py 的 _skill_catalog）----
    parsed = asyncio.run(MinecraftPlugin._skill_catalog(_FakePlugin(raw)))
    names_from_parser = [p["skill"] for p in parsed]
    print(f"\n解析出 {len(parsed)} 个技能：{', '.join(names_from_parser)}")

    ok("解析器没有丢掉任何技能", len(parsed) == len(raw), f"{len(parsed)} / {len(raw)}")
    ok(
        "解析器拿到的名字都是合法标识符（不是整行文本）",
        all(n and " " not in n and "(" not in n for n in names_from_parser),
        f"样例：{names_from_parser[:3]}",
    )

    # ---- ② 真的渲染函数（life.py 的 render_skill_catalog）----
    text = render_skill_catalog(parsed)
    print(f"\n渲染结果 {len(text)} 字符、{len(text.splitlines())} 行")

    missing = [n for n in names_from_parser if f"- {n}(" not in text and f"- {n}：" not in text]
    ok(
        "**每一个技能名都出现在渲染结果里**（这正是 P1 的核心断言）",
        not missing,
        f"看不到的：{missing}" if missing else f"{len(names_from_parser)} 个全部可见",
    )

    # 特别点名那几个原来被截断掉的
    previously_hidden = [
        "cook_food", "hunt", "food_chain", "blueprint",
        "sleep", "interact", "shoot", "shield", "craft",
    ]
    still_hidden = [n for n in previously_hidden if n not in names_from_parser]
    ok(
        "原来被截断的 9 个技能现在都在清单里",
        not still_hidden,
        f"仍缺失：{still_hidden}" if still_hidden else "cook_food/hunt/food_chain/blueprint/sleep/interact/shoot/shield/craft",
    )
    for n in previously_hidden:
        if n in names_from_parser:
            visible = f"- {n}(" in text or f"- {n}：" in text
            if not visible:
                ok(f"「{n}」在渲染结果里可见", False)
    ok("逐个确认那 9 个都在渲染文本里可见", all(
        (f"- {n}(" in text or f"- {n}：" in text) for n in previously_hidden if n in names_from_parser
    ))

    # ---- ③ 防回归：渲染函数的**代码**里不许再有切片 ----
    #
    # 用 AST 而不是搜字符串：函数自己的 docstring 里就写着"这里原来是
    # `skills[:12]`"（解释为什么要改），搜文本会把它误判成还在截断。
    import ast  # noqa: PLC0415

    life_src = (_paths.REPO / "life.py").read_text(encoding="utf-8")
    tree = ast.parse(life_src)
    target = next(
        (n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "render_skill_catalog"),
        None,
    )
    ok("life.py 里有 render_skill_catalog（结构没被改掉）", target is not None)
    if target is not None:
        slices = [
            n
            for n in ast.walk(target)
            if isinstance(n, ast.Subscript) and isinstance(n.slice, ast.Slice)
        ]
        ok(
            "渲染函数体内没有任何切片（不会再把清单截断）",
            not slices,
            f"发现 {len(slices)} 处切片" if slices else "全量遍历",
        )
        # 而且要真的遍历了传入的清单
        ok(
            "渲染函数体里确实遍历了参数 skills",
            any(isinstance(n, ast.For) for n in ast.walk(target)),
        )

    # ---- ④ 渲染器对"字符串列表"这种形状也要能处理 ----
    str_form = render_skill_catalog(raw)
    ok(
        "字符串列表形状也能渲染（不再抛 KeyError）",
        str_form.count("\n") + 1 == len(raw),
        f"{str_form.count(chr(10)) + 1} 行 / {len(raw)} 项",
    )

    # ---- ⑤ 代价可见（不是断言，是留个数字）----
    first12 = render_skill_catalog(parsed[:12])
    print(
        f"\n代价：前 12 项 {len(first12)} 字符 → 全部 {len(parsed)} 项 {len(text)} 字符"
        f"（+{len(text) - len(first12)}）。这段进的是 **system 段（可缓存）**，"
        f"不在每轮都变的 user 段里。"
    )

    print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
