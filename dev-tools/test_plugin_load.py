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

**仓库根就是插件本体**（main.py、life.py、llm_tools_*.py 都在这里），
没有 `<repo>/plugin/` 那一层。所以这里直接把仓库根当成 AstrBot 里那个插件目录来加载：

  · **不复制任何源码**——复制到沙箱里测的是快照，不是真实代码；
  · 用 `data.plugins.<metadata.name>` 这条点分链 + `__import__(..., fromlist=["main"])`
    复刻 AstrBot 的加载路径，其中最后一节的 `__path__` 直接指向仓库根。

用法（在仓库根执行；AstrBot 的位置用环境变量给，别写死在脚本里）：
  $env:ASTRBOT_APP='<AstrBot>/backend/app'
  & '<AstrBot>/backend/python/python.exe' dev-tools/test_plugin_load.py
"""

from __future__ import annotations

import importlib
import inspect
import io
import re
import sys
import traceback
import types
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import _paths  # noqa: E402

# 插件源码目录 = 仓库根。**不再有 `<repo>/plugin/` 这一层，也不搭沙箱副本。**
PLUGIN_SRC = _paths.REPO


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


def register_namespace_chain(dotted: str, root: Path) -> None:
    """把 `dotted` 这条点分链注册成命名空间包，最后一节的 __path__ 指向 root。

    这就是 AstrBot 那边 `data/plugins/<name>/` 的形状——只是**不落盘、不复制源码**：
    中间几节（data、plugins）是空壳，只有最后一节真的指向插件源码目录。
    和 `_paths.load_plugin()` 做的是同一件事，这里额外保留了点分前缀，
    好让 `__import__` 走的是和 AstrBot 一模一样的名字。
    """
    parts = dotted.split(".")
    for i, _part in enumerate(parts):
        full = ".".join(parts[: i + 1])
        if full in sys.modules:
            continue
        mod = types.ModuleType(full)
        mod.__package__ = full
        # 只有最后一节需要 __path__；中间节给空列表，免得它们去别处找东西。
        mod.__path__ = [str(root)] if i == len(parts) - 1 else []  # type: ignore[attr-defined]
        sys.modules[full] = mod


def decorators_of(obj) -> str:
    """取一个函数的**装饰器块**（`def` 之前的那几行），取不到就返回空串。

    多行装饰器（`@filter.command(` + 续行 + `)`）会整块拿到，
    因为这里是从源码开头一直读到 `def` / `async def` 那一行为止。
    """
    try:
        src = inspect.getsource(obj)
    except (OSError, TypeError):
        return ""
    head: list[str] = []
    for line in src.splitlines():
        if line.lstrip().startswith(("def ", "async def ")):
            break
        head.append(line)
    return "\n".join(head)


def main() -> int:
    problems: list[str] = []
    warnings: list[str] = []

    print("=== 按 AstrBot 的方式加载插件 ===")
    print(f"插件源码目录（= 仓库根）：{PLUGIN_SRC}")

    if not (PLUGIN_SRC / "main.py").is_file():
        print(f"❌ 插件源码目录里没有 main.py：{PLUGIN_SRC}")
        return 1

    # main.py 一 import 就要 astrbot（astrbot.api / astrbot.api.event / astrbot.api.star），
    # 所以这个脚本整体都需要 AstrBot 运行时。拿不到就明确 SKIP 并退出 0，
    # **不能**假装加载成功了。
    _paths.require_astrbot("test_plugin_load")

    plugin_name = read_plugin_name()
    print(f"AstrBot 插件名（取自 metadata.yaml）：{plugin_name}")

    dotted = f"data.plugins.{plugin_name}"
    register_namespace_chain(dotted, PLUGIN_SRC)
    print(f"注册命名空间包：{dotted} → {PLUGIN_SRC}")
    print("（没有 __init__.py，也没有复制任何源码）\n")

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
            # **只看装饰器，不看函数体**：`_bind_llm_tools` / `initialize` 这类方法的
            # 源码里也出现 "llm_tool" 字样（它们负责绑定/说明），
            # 按函数体匹配会把它们误算成"注册的工具"（实测多算 4 个：66 vs 真实的 62）。
            deco = decorators_of(obj)
            if "llm_tool" in deco:
                tools.append(name)
            elif "filter.command(" in deco:
                commands.append(name)
        print(f"  ✅ LLM 工具 {len(tools)} 个：{', '.join(sorted(tools)[:6])}...")
        print(f"  ✅ 指令 {len(commands)} 个：{', '.join(sorted(commands)[:6])}...")
        if not tools:
            problems.append("没有注册到任何 LLM 工具")

    print("\n[5] 实例化插件（用假的 Context，只验证构造过程不炸）")
    if plugin_class is None:
        # 不能静默跳过：上面没定位到插件类，这一步**确实没跑**。
        print("  ⏭ 跳过：上一步没定位到插件类，没有可实例化的对象")
        warnings.append("第 [5] 步（实例化）被跳过：没定位到插件类")
    else:
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
