#!/usr/bin/env python3
"""插件静态契约检查。

为什么需要这个：AstrBot 的 `@filter.llm_tool` **从 docstring 的 Args: 段生成参数 schema**，
不读函数签名。如果某个参数在 Args: 里漏写、类型写错、或者格式不符合
`参数名(类型): 描述`，框架生成的 schema 就会缺参数，LLM 传进来的值会被静默丢弃，
最后表现为"函数报了缺参数的错，但看代码明明有参数"——极难排查。

这个脚本在发布前跑一遍，把这类问题挡在运行时之前。

用法：
  D:\\AstrBot\\backend\\python\\python.exe tools/check_plugin.py
"""

from __future__ import annotations

import ast
import io
import json
import re
import sys
from pathlib import Path

# Windows 控制台默认 GBK，直接 print ✓/✗ 会抛 UnicodeEncodeError。
# 这里强制 stdout 用 UTF-8，避免检查脚本自己因为编码挂掉（很讽刺但不罕见）。
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# 找插件目录：脚本在 <repo>/bot/tools/ 下，插件在 <repo>/plugin/
_HERE = Path(__file__).resolve().parent
_CANDIDATES = [
    _HERE.parent.parent / "plugin",  # <repo>/bot/tools -> <repo>/plugin
    _HERE.parent / "plugin",
    _HERE / "plugin",
]
PLUGIN_DIR = next((p for p in _CANDIDATES if p.is_dir()), _CANDIDATES[0])

# 与 AstrBot 框架保持一致：格式为「参数名(类型): 描述」
ARG_LINE_RE = re.compile(r"^\s*(\w+)\s*\(\s*([\w\[\]]+)\s*\)\s*:\s*(.+)$")
VALID_TYPES = {"string", "number", "object", "boolean", "array"}

problems: list[str] = []
notes: list[str] = []
tool_count = 0
command_count = 0


def check_tool_arg_types(func_name: str, args: dict[str, tuple[str, str]]) -> None:
    for arg, (typ, _desc) in args.items():
        base = typ.split("[")[0]
        if base not in VALID_TYPES:
            problems.append(
                f"{func_name}: 参数 {arg} 的类型 '{typ}' 不合法。"
                f"只能是：{', '.join(sorted(VALID_TYPES))}（array 可写成 array[string]）"
            )


def check_file(path: Path) -> None:
    global tool_count, command_count
    source = path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        problems.append(f"{path.name}: 语法错误 {exc}")
        return

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        decorators = []
        for dec in node.decorator_list:
            if isinstance(dec, ast.Call):
                name = ""
                if isinstance(dec.func, ast.Attribute):
                    name = dec.func.attr
                elif isinstance(dec.func, ast.Name):
                    name = dec.func.id
                decorators.append((name, dec))
            elif isinstance(dec, ast.Attribute):
                decorators.append((dec.attr, None))

        is_tool = any(n == "llm_tool" for n, _ in decorators)
        is_cmd = any(n == "command" for n, _ in decorators)

        if not (is_tool or is_cmd):
            continue

        if is_tool:
            tool_count += 1
        if is_cmd:
            command_count += 1

        # 函数签名里的"真参数"（跳过 self 与 event）
        real_params = [a.arg for a in node.args.args if a.arg not in ("self", "event")]
        has_default = {}
        defaults = node.args.defaults or []
        for i, p in enumerate(real_params):
            # 对齐 defaults：默认值对齐到参数列表末尾
            offset = len(real_params) - len(defaults)
            has_default[p] = i >= offset

        doc = ast.get_docstring(node) or ""
        if not doc.strip():
            problems.append(f"{node.name}: 缺少 docstring（工具描述会为空，LLM 不知道怎么用）")
            continue

        # 解析 Args: 段
        args: dict[str, tuple[str, str]] = {}
        in_args = False
        for line in doc.splitlines():
            stripped = line.strip()
            if re.match(r"^Args\s*:\s*$", stripped):
                in_args = True
                continue
            if in_args:
                if re.match(r"^(Returns|Raises|Yields|Note|Example)\s*:", stripped):
                    in_args = False
                    continue
                m = ARG_LINE_RE.match(line)
                if m:
                    args[m.group(1)] = (m.group(2), m.group(3).strip())

        if is_tool and real_params and not args:
            problems.append(
                f"{node.name}: 有参数 {real_params} 但没有可解析的 Args: 段。"
                f"AstrBot 会生成空 schema，LLM 传的参数会被丢弃。"
            )

        # 签名与 Args 是否一致
        for p in real_params:
            if p not in args:
                problems.append(f"{node.name}: 参数 {p} 没有写在 Args: 里（LLM 无法填这个参数）")
        for a in args:
            if a not in real_params:
                problems.append(f"{node.name}: Args: 里的 {a} 在函数签名里不存在（拼写错误？）")
        check_tool_arg_types(node.name, args)

        # 默认值检查：有默认值的参数通常应在文档里说明留空行为
        for p, has_def in has_default.items():
            if has_def and p in args and "留空" not in args[p][1] and "默认" not in args[p][1]:
                notes.append(f"{node.name}: 参数 {p} 有默认值，但描述里没写默认行为（模型可能不知道可以不填）")

        # 工具描述长度：太短 LLM 用不好
        if is_tool:
            first_line = doc.strip().splitlines()[0]
            if len(first_line) < 12 and "。" not in first_line:
                notes.append(f"{node.name}: 工具描述偏短（{first_line!r}），建议写清楚什么时候用它")


def main() -> int:
    files = sorted(PLUGIN_DIR.glob("*.py"))
    if not files:
        print(f"❌ 没找到插件文件：{PLUGIN_DIR}")
        return 2

    for path in files:
        check_file(path)

    print("=== 插件契约检查 ===")
    print(f"目录：{PLUGIN_DIR}")
    print(f"扫描 {len(files)} 个文件，发现 LLM 工具 {tool_count} 个，指令 {command_count} 个\n")

    # 必需的模块与元数据
    required = ["main.py", "bridge_client.py", "perception.py", "goals.py", "_conf_schema.json", "metadata.yaml"]
    for name in required:
        p = PLUGIN_DIR / name
        if not p.exists():
            problems.append(f"缺少必需文件：{name}")

    schema_path = PLUGIN_DIR / "_conf_schema.json"
    if schema_path.exists():
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
            if not isinstance(schema, dict) or not schema:
                problems.append("_conf_schema.json 不是非空对象")
            else:
                notes.append(f"配置项 {len(schema)} 个：{', '.join(list(schema)[:6])}...")
        except json.JSONDecodeError as exc:
            problems.append(f"_conf_schema.json 解析失败：{exc}")

    if notes:
        print("提示：")
        for n in notes:
            print(f"  · {n}")
        print()

    if problems:
        print(f"❌ 发现 {len(problems)} 个问题：")
        for p in problems:
            print(f"  ✗ {p}")
        return 1

    print(f"✅ 检查通过：{tool_count} 个 LLM 工具的 docstring 与签名一致，{command_count} 个指令正常")
    return 0


if __name__ == "__main__":
    sys.exit(main())
