#!/usr/bin/env python3
"""静态排查：找出"被 await 的 async generator"这类运行时才会炸的 bug。

为什么需要这种检查：`await` 一个 async generator 只会在**运行到那一行时**才抛
`object async_generator can't be used in 'await' expression`。
工具注册、签名检查、加载测试全都发现不了——实测它让全部 10 个技能工具瘫痪，
而且被更早的另一个错误掩盖了很久。

用法：python dev-tools/check_await.py
"""

from __future__ import annotations

import ast
import io
import sys
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import REPO  # noqa: E402

# 仓库根**就是**插件本体（main.py / life.py / llm_tools_*.py 都在这里）。
PLUGIN = REPO

problems: list[str] = []


def is_async_gen(node: ast.AST) -> bool:
    """async def 里含 yield → 是 async generator（返回的是异步生成器，不能 await）。"""
    if not isinstance(node, (ast.AsyncFunctionDef,)):
        return False
    for child in ast.walk(node):
        if isinstance(child, (ast.Yield, ast.YieldFrom)):
            return True
    return False


def scan(path: Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    # 先收集本文件里所有 async generator 函数名
    async_gens: set[str] = set()
    for node in ast.walk(tree):
        if is_async_gen(node):
            async_gens.add(node.name)
    if not async_gens:
        return

    # **反向错误：async generator 里写 `return <值>`**。
    # 实测踩过：工具函数里有 yield（错误分支里 yield 了提示），
    # 末尾却写 `return await self._submit_skill(...)`，
    # 直接 SyntaxError: 'return' with value in async generator —— 插件整个加载失败。
    # 这种错在写的时候完全看不出来（语法检查通过、测试也过了），
    # 只有真正 import 才炸，所以必须静态拦住。
    for node in ast.walk(tree):
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        if not is_async_gen(node):
            continue
        for child in ast.walk(node):
            if isinstance(child, ast.Return) and child.value is not None:
                problems.append(
                    f"{path.name}:{child.lineno}  {node.name}() 里写了 `return <值>`，"
                    f"但它含 yield（是 async generator）→ 会 SyntaxError。"
                    f"改成 `yield <值>`"
                )

    # 再找 await 它们的地方
    for node in ast.walk(tree):
        if isinstance(node, ast.Await):
            target = node.value
            name = None
            if isinstance(target, ast.Call):
                f = target.func
                if isinstance(f, ast.Attribute):
                    name = f.attr
                elif isinstance(f, ast.Name):
                    name = f.id
            if name and name in async_gens:
                problems.append(
                    f"{path.name}:{node.lineno}  await self.{name}(...) —— "
                    f"但 {name} 是 async generator（含 yield），不能 await"
                )
        # 也要查 async for 用在了普通协程上（反向错误）——这里只报前者


def main() -> int:
    print("=== 静态排查：被 await 的 async generator ===\n")
    files = sorted(PLUGIN.glob("*.py"))
    for f in files:
        scan(f)

    if problems:
        print("发现问题：")
        for p in problems:
            print(f"  ❌ {p}")
        return 1

    # 顺便列出所有 async generator，便于人工确认用法
    print("所有 async generator（这些函数返回异步生成器，不能被 await）：")
    for f in files:
        tree = ast.parse(f.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if is_async_gen(node):
                print(f"  · {f.name}: {node.name}()")
    print('\n✅ 没有发现「await async generator」的写法')
    return 0


if __name__ == "__main__":
    sys.exit(main())
