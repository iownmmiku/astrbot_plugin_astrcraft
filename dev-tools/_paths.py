"""dev-tools 的路径与导入辅助（所有 Python 脚本共用）。

## 为什么需要它

仓库的真实布局是：

    <repo>/                ← AstrBot 插件本体（main.py、life.py、advisor.py…）
    <repo>/engine/         ← Node 引擎（mineflayer）
    <repo>/dev-tools/      ← 本目录
    <repo>/docs/、<repo>/skills_docs/

而历史文档与历史脚本写的是 `<repo>/plugin/` + `<repo>/bot/`——
**那两个目录从来就不存在**。于是所有脚本都在做两件错事：

  1. 用 `Path(__file__).resolve().parents[2]` 当"仓库根"（实际多退了一层，
     解析成 `<repo 的上一级>`），再拼 `/ "plugin"` → 指向不存在的目录；
  2. 用 `from plugin.xxx import ...` 导入 → ModuleNotFoundError。

## 这个模块解决三件事

1. **仓库根只在这里解析一次**：默认 = 本文件所在目录的上一级，
   可用环境变量 `ASTRCRAFT_REPO` 覆盖（CI / 换机器时不用改代码）。
2. **把插件本体当"包"导入**（`life.py` 内部是 `from .advisor import ...` 这类
   相对导入，必须作为包的一部分加载才成立）。做法是注册一个**命名空间包**：
   一个 `__path__` 指向仓库根的模块对象——**不复制任何源码到临时目录**，
   也不要求目录名是合法标识符。
3. **AstrBot 运行时的定位**：只认环境变量 `ASTRBOT_APP`（指向 AstrBot 的
   `backend/app` 目录），**不写死本机绝对路径**。拿不到就如实报告"不可用"。

## 用法

    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from _paths import REPO, ENGINE_DIR, load_plugin, plugin_module, astrbot_available

    life = plugin_module("life")          # 等价于 import <pkg>.life
    if not astrbot_available():
        print("跳过：需要 AstrBot 运行时（设置 ASTRBOT_APP）")
"""

from __future__ import annotations

import importlib
import io
import os
import sys
import types
from pathlib import Path

__all__ = [
    "REPO",
    "ENGINE_DIR",
    "DEV_TOOLS",
    "DOCS_DIR",
    "SKILLS_DOCS",
    "PLUGIN_PACKAGE",
    "load_plugin",
    "plugin_module",
    "astrbot_available",
    "require_astrbot",
    "read_text",
    "plugin_py_files",
    "engine_js_files",
    "ensure_utf8_stdout",
]


_WRAPPED_MARK = "_astrcraft_utf8_wrapper"
# 换下来的旧 stream 要留住引用，别让它被回收（见下面的说明）。
_REPLACED_STREAMS: list = []


def _is_utf8(stream) -> bool:
    enc = str(getattr(stream, "encoding", "") or "").lower().replace("-", "").replace("_", "")
    return enc in ("utf8", "utf8mb4", "cp65001")


def ensure_utf8_stdout() -> None:
    """把 stdout/stderr 换成 UTF-8，免得检查脚本自己因为编码挂掉。

    **这不是洁癖，是实测踩到的**：这些脚本到处打印 `✅` / `❌` / `⚠`，
    而 Windows 上 Python 在"输出被重定向"（`> out.txt`、被 CI 或父进程捕获）
    时会用**区域编码**（简体中文机器上是 GBK/cp936）来编码 stdout，
    于是第一行 `✅` 就抛
    `UnicodeEncodeError: 'gbk' codec can't encode character '\u2705'`——
    **测试在真正跑断言之前就崩了**，退出码非 0，看起来像"测试失败"，
    实际上只是打印不出来。这比失败更难排查。

    `check_plugin.py` 早就有这段（`io.TextIOWrapper(..., encoding="utf-8")`），
    但其它脚本都没有。放在这里是为了**一处生效**：dev-tools 的 Python 脚本
    都会 import 本模块，不用每个文件抄一遍。

    **必须是幂等的**。第一版没做这个检查，结果和某个脚本里自己那段包装叠加成
    "套了两层 TextIOWrapper"：里层的旧 wrapper 引用计数归零、`__del__` 把底层
    buffer 关掉，外层随后写任何东西都是
    `ValueError: I/O operation on closed file` + `lost sys.stderr`
    （实测在 test_life / test_game_agent 上炸过，退出码 1，看起来像测试失败）。
    所以：**已经是 UTF-8 就什么都不做**。
    """
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if getattr(stream, _WRAPPED_MARK, False):
            continue  # 已经是我们换过的
        if _is_utf8(stream):
            continue  # 已经是 UTF-8（或已被别人换过），再套一层就会炸
        buf = getattr(stream, "buffer", None)
        if buf is None:
            continue  # 没有 buffer（被嵌进别的宿主），别硬来
        if isinstance(buf, io.TextIOWrapper):
            # 别人已经套过一层了（有些脚本自己带 `io.TextIOWrapper(...)`）。
            # **再套一层就会炸**：里层 wrapper 被换掉后引用计数归零、
            # `__del__` 把底层 buffer 关掉，外层随后写什么都报
            # "I/O operation on closed file"。所以这里必须让路。
            continue
        try:
            stream.flush()
        except Exception:  # noqa: BLE001
            pass
        try:
            wrapper = io.TextIOWrapper(buf, encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - 换不了就照旧，不要因此让脚本挂掉
            continue
        setattr(wrapper, _WRAPPED_MARK, True)
        # 留住旧 stream 的引用：避免它在换掉之后立刻被回收
        _REPLACED_STREAMS.append(stream)
        setattr(sys, name, wrapper)


# 导入即生效（见上面的说明）。**故意做成副作用**：
# 让"忘了加这段"这件事不可能发生。
ensure_utf8_stdout()


def _resolve_repo() -> Path:
    """仓库根：默认 = dev-tools 的上一级；ASTRCRAFT_REPO 可覆盖。"""
    env = os.environ.get("ASTRCRAFT_REPO", "").strip()
    if env:
        p = Path(env).expanduser().resolve()
        if not p.is_dir():
            raise SystemExit(f"ASTRCRAFT_REPO 指向的目录不存在：{p}")
        return p
    return Path(__file__).resolve().parent.parent


REPO: Path = _resolve_repo()
DEV_TOOLS: Path = REPO / "dev-tools"
ENGINE_DIR: Path = REPO / "engine"
DOCS_DIR: Path = REPO / "docs"
SKILLS_DOCS: Path = REPO / "skills_docs"

# 插件包名。**不是** AstrBot 里的最终插件名（那个在 metadata.yaml 的 name），
# 只是本地导入用的稳定别名——用固定名字是为了让 `sys.modules` 里的键稳定、
# 不随仓库目录名变化。
PLUGIN_PACKAGE = "astrcraft_plugin"


def load_plugin(repo: Path | None = None, name: str = PLUGIN_PACKAGE) -> str:
    """把仓库根注册成一个可导入的包，返回包名。

    注册的是一个**命名空间包**：`__path__` 指向仓库根，`__file__` 为空，
    不会执行任何源码。之后 `importlib.import_module(f"{name}.life")` 就能
    正常加载 `life.py`，并且它内部的相对导入（`from .advisor import ...`）
    会解析成 `astrcraft_plugin.advisor`。

    **不复制源码**：任何"把生产代码拷到临时目录再测试"的做法都会让测试
    测到一份快照而不是真实代码，这里明确不做那件事。
    """
    root = Path(repo).resolve() if repo else REPO
    if not (root / "main.py").is_file():
        raise SystemExit(
            f"仓库根看起来不对：{root} 里没有 main.py。"
            f"用环境变量 ASTRCRAFT_REPO 指定正确的仓库根。"
        )
    if name in sys.modules:
        return name
    pkg = types.ModuleType(name)
    pkg.__path__ = [str(root)]  # type: ignore[attr-defined]
    pkg.__package__ = name
    sys.modules[name] = pkg
    return name


def plugin_module(sub: str, repo: Path | None = None):
    """导入插件里的某个子模块，例如 `plugin_module("life")`。

    等价于 `importlib.import_module("<包名>.life")`，但会先确保包已注册。
    """
    name = load_plugin(repo)
    return importlib.import_module(f"{name}.{sub}")


def astrbot_available() -> bool:
    """AstrBot 运行时可用吗（只看 ASTRBOT_APP 环境变量 + 能否 import）。"""
    app = os.environ.get("ASTRBOT_APP", "").strip()
    if app and Path(app).is_dir() and app not in sys.path:
        sys.path.insert(0, app)
    try:
        importlib.import_module("astrbot.api")
        return True
    except Exception:  # noqa: BLE001
        return False


def require_astrbot(what: str = "这个测试") -> None:
    """需要 AstrBot 运行时却拿不到时，**明确地说出来并以 0 退出**。

    为什么是 0 而不是 1：环境缺依赖不是"代码坏了"。但绝不能静默跳过——
    所以打一行醒目的 SKIP 说明缺什么、怎么补。
    """
    if astrbot_available():
        return
    print(
        f"⏭  SKIP：{what} 需要 AstrBot 运行时，但当前解释器 import 不到 astrbot。\n"
        f"    本机可用的做法（不写死在脚本里，用环境变量传）：\n"
        f"      $env:PYTHONPATH='<AstrBot>/backend/app'\n"
        f"      & '<AstrBot>/backend/python/python.exe' dev-tools/<脚本>.py\n"
        f"    或设置 ASTRBOT_APP=<AstrBot>/backend/app 后用任意解释器运行。"
    )
    sys.exit(0)


def read_text(path: Path) -> str:
    """读文本；读不到返回空串（检查脚本用它来"扫不到就报错"，而不是崩栈）。"""
    try:
        return Path(path).read_text(encoding="utf-8")
    except Exception:  # noqa: BLE001
        return ""


def plugin_py_files() -> list[Path]:
    """插件本体的 .py 文件（仓库根一级，不含 engine/ 与 dev-tools/）。"""
    return sorted(p for p in REPO.glob("*.py"))


def engine_js_files() -> list[Path]:
    """引擎的全部 .js 文件（含 skills/ 子目录）。"""
    return sorted(ENGINE_DIR.rglob("*.js"))
