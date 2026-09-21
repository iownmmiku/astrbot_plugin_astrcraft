#!/usr/bin/env python3
"""按 AstrBot 的真实方式加载插件，验证相对导入与工具注册。

AstrBot 的加载方式（摘自 core/star/star_manager.py）：
    module_str = "main"                     # 有 main.py 就用 main
    module = __import__(path, fromlist=[module_str])
其中 path 是**点分模块路径**，例如 `data.plugins.my_plugin`。

注意它 **不要求** 插件目录有 __init__.py —— Python 3.3+ 的命名空间包机制会让
"没有 __init__.py 的目录" 也能被当作包导入。但命名空间包有一个坑：
包名必须是合法标识符。目录名带连字符（例如 `astrbot-plugin-minecraft`）时，
`__import__("...astrbot-plugin-minecraft")` 会失败。

**仓库里的 plugin/ 目录名不是 AstrBot 里的最终名字**（那边要看 metadata.yaml 的 name）。
所以这里不直接导入 plugin/，而是搭一个与 AstrBot 一致的沙箱目录
`<sandbox>/data/plugins/<metadata.name>/`，再用同样的 `__import__` 方式加载——
这才是真正复现 AstrBot 行为的做法。

用法：
  $env:PYTHONPATH='D:\\AstrBot\\backend\\app'
  D:\\AstrBot\\backend\\python\\python.exe bot\\tools\\test_plugin_load.py
"""

from __future__ import annotations

import importlib
import inspect
import io
import os
import re
import sys
import traceback
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent.parent
PLUGIN_SRC = _REPO / "plugin"

# 目标：把 plugin 目录伪装成 AstrBot 的 data/plugins/<name> 结构
SANDBOX = _REPO / "bot" / ".playground"


def read_plugin_name() -> str:
    """从 metadata.yaml 读 AstrBot 里实际会用的插件名。

    不引入 yaml 依赖：只是一行 `name: xxx`，用正则足够，
    读不到就退回默认值（并在输出里说明）。
    """
    meta = PLUGIN_SRC / "metadata.yaml"
    if meta.exists():
        text = meta.read_text(encoding="utf-8")
        m = re.search(r"^name:\s*(\S+)\s*$", text, re.MULTILINE)
        if m:
            return m.group(1)
    return "astrbot_plugin_astrcraft"


def setup_sandbox(plugin_name: str) -> Path:
    """搭一个和 AstrBot 一样的目录结构：<sandbox>/data/plugins/<plugin_name>/"""
    plugins_root = SANDBOX / "data" / "plugins" / plugin_name
    plugins_root.mkdir(parents=True, exist_ok=True)
    for f in PLUGIN_SRC.glob("*.py"):
        (plugins_root / f.name).write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
    for name in ("_conf_schema.json", "metadata.yaml"):
        src = PLUGIN_SRC / name
        if src.exists():
            (plugins_root / name).write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    # 刻意保持"没有 __init__.py"，来验证命名空间包能不能正常用相对导入
    (SANDBOX / "data" / "__init__.py").touch()
    (SANDBOX / "data" / "plugins" / "__init__.py").touch()
    return plugins_root


def main() -> int:
    problems: list[str] = []
    warnings: list[str] = []

    print("=== 按 AstrBot 的方式加载插件 ===")
    print(f"源目录：{PLUGIN_SRC}")

    plugin_name = read_plugin_name()
    print(f"AstrBot 插件名（取自 metadata.yaml）：{plugin_name}")

    plugins_root = setup_sandbox(plugin_name)
    print(f"沙箱目录：{plugins_root}（故意不放 __init__.py）\n")

    # 与 AstrBot 一致：把 app 目录与"data 的父目录"放进 sys.path
    sys.path.insert(0, str(SANDBOX))
    app_dir = os.environ.get("ASTRBOT_APP", r"D:\AstrBot\backend\app")
    if Path(app_dir).is_dir():
        sys.path.insert(0, app_dir)

    dotted = f"data.plugins.{plugin_name}"

    print("[1] 模拟 AstrBot：__import__(path, fromlist=['main'])")
    try:
        module = __import__(dotted, fromlist=["main"])
        print(f"  ✅ 包导入成功：{module}")
    except Exception:  # noqa: BLE001
        print("  ❌ 包导入失败：")
        traceback.print_exc()
        return 1

    print("\n[2] 检查相对导入是否生效（插件内部用了 from .xxx import）")
    try:
        main_module = importlib.import_module(f"{dotted}.main")
        print(f"  ✅ main 模块：{main_module.__file__}")
    except Exception:  # noqa: BLE001
        print("  ❌ main 模块导入失败（相对导入可能不兼容 AstrBot 的加载方式）：")
        traceback.print_exc()
        print("\n  说明：插件内部使用了 `from .bridge_client import ...` 这类相对导入。")
        print("  如果 AstrBot 以非包方式加载插件，这些相对导入会失败。")
        return 1

    print("\n[3] 定位插件类并检查构造签名")
    plugin_class = None
    for name, obj in vars(main_module).items():
        if inspect.isclass(obj) and name.endswith("Plugin"):
            plugin_class = obj
    if plugin_class is None:
        problems.append("main.py 里找不到以 Plugin 结尾的类")
    else:
        print(f"  ✅ 插件类：{plugin_class.__name__}")
        print(f"     继承链：{' → '.join(c.__name__ for c in plugin_class.__mro__[:5])}")
        sig = inspect.signature(plugin_class.__init__)
        print(f"     __init__ 参数：{list(sig.parameters)}")
        if "context" not in sig.parameters:
            problems.append("__init__ 缺少 context 参数")
        if "config" not in sig.parameters:
            warnings.append("__init__ 没有 config 参数，插件配置无法注入")
        for method in ("initialize", "terminate"):
            if hasattr(plugin_class, method):
                print(f"     ✅ 有 {method}()")
            else:
                warnings.append(f"缺少 {method}()")

        print("\n[4] 统计注册的 LLM 工具与指令")
        tools, commands = [], []
        for name, obj in inspect.getmembers(plugin_class, predicate=inspect.isfunction):
            try:
                src = inspect.getsource(obj)
            except (OSError, TypeError):
                continue
            if "llm_tool" in src:
                tools.append(name)
            elif "filter.command(" in src:
                commands.append(name)
        print(f"  ✅ LLM 工具 {len(tools)} 个：{', '.join(sorted(tools)[:6])}...")
        print(f"  ✅ 指令 {len(commands)} 个：{', '.join(sorted(commands)[:6])}...")
        if not tools:
            problems.append("没有注册到任何 LLM 工具")

    print("\n[5] 实例化插件（用假的 Context，只验证构造过程不炸）")
    try:
        class _FakeContext:
            def __init__(self):
                self._tools = []

            def add_llm_tools(self, *args):
                self._tools.extend(args)

            def get_all_stars(self):
                return []

        fake = _FakeContext()
        inst = plugin_class(fake, {"server_host": "127.0.0.1", "server_port": 25565})
        print("  ✅ 实例化成功（__init__ 没有副作用崩溃）")
        print(f"     config 生效：server_port={inst.config.get('server_port')}")
        print(f"     _cfg 读取：bot_username={inst._cfg('bot_username', 'AstrBot')}")
        print(f"     引擎目录推断：{inst._engine_dir()}")
        if not inst._engine_dir().exists():
            warnings.append(f"引擎目录不存在：{inst._engine_dir()}（需在插件配置里填 engine_dir）")
    except Exception:  # noqa: BLE001
        print("  ❌ 实例化失败：")
        traceback.print_exc()
        problems.append("插件无法实例化")

    print("\n=== 结果 ===")
    for w in warnings:
        print(f"  ⚠ {w}")
    if problems:
        print(f"❌ {len(problems)} 个问题：")
        for p in problems:
            print(f"  ✗ {p}")
        return 1
    print("✅ 插件可以按 AstrBot 的方式成功加载")
    return 0


if __name__ == "__main__":
    sys.exit(main())
