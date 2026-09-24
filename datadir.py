"""数据目录解析：记忆、驱动力水位、人格选择存在哪里。

为什么单独拎出来做（而不是直接 `StarTools.get_data_dir()`）：

1. **它靠 inspect 推断调用栈**（plugin_name 不传时用 `inspect.getmodule` 找调用者）。
   在某些加载方式下会抛 RuntimeError——实测通过命名空间包导入时就会失败，
   于是回退到插件目录下，**记忆就存到了不该在的地方**。
2. **位置一旦变化就会"丢记忆"**：用户升级插件、换部署方式都可能让目录变了，
   而记忆丢失是静默的——她只是突然不记得以前的事了，没有任何报错。

所以这里的策略是：**按优先级列出所有候选目录，谁已经有我们的数据就用谁**，
都没有就挑第一个**可写**的。这样无论部署方式怎么变，历史数据都能被找到。
"""

from __future__ import annotations

import json
from pathlib import Path

from astrbot.api import logger

# 这些文件是我们自己写的，用来判断"这个候选目录里有没有她的历史数据"
MARKER_FILES = ("memory.json", "drives.json", "persona.json", "life.json")


def _derive_from_plugin_location(plugin_dir: Path, plugin_name: str) -> Path | None:
    """从插件自身安装位置推导数据目录。

    这是**最可靠**的一条路：插件装在 `<data>/plugins/<插件名>`，
    那数据目录就是 `<data>/plugin_data/<插件名>`——由安装事实决定，不依赖任何环境变量。

    为什么不靠 AstrBot 的路径工具：`get_astrbot_root()` 在没有 ASTRBOT_ROOT
    且非打包桌面运行时，**直接返回当前工作目录**（`os.getcwd()`）。
    插件被导入时 cwd 可能是任何地方，于是算出来的路径会跑到项目目录里去，
    表现是"记忆存到了莫名其妙的位置"。
    """
    try:
        plugin_dir = Path(plugin_dir).resolve()
        if plugin_dir.parent.name != "plugins":
            return None
        data_root = plugin_dir.parent.parent
        # 快速校验：这个 data 根目录下应该还有 config / plugins 这些兄弟目录
        if not (data_root / "plugins").is_dir():
            return None
        return data_root / "plugin_data" / plugin_name
    except Exception:  # noqa: BLE001
        return None


def candidate_dirs(plugin_name: str, plugin_dir: Path) -> list[Path]:
    """按优先级列出可能的数据目录。

    顺序说明（可靠性从高到低）：
      1. **从插件安装位置推导** —— 由安装事实决定，不依赖环境变量与工作目录
      2. AstrBot 官方 API `StarTools.get_data_dir()`
      3. `get_astrbot_data_path()` —— 注意它依赖 cwd，只作兜底
      4. `~/.astrbot/data/plugin_data/<插件名>` —— 桌面版默认布局
      5. 插件目录下的 data/ —— 最后兜底（能跑，但升级插件时会丢）
    """
    out: list[Path] = []

    # 1) 从插件位置推导（最可靠）
    derived = _derive_from_plugin_location(plugin_dir, plugin_name)
    if derived is not None:
        out.append(derived)

    # 2) 官方 API
    try:
        from astrbot.core.star.star_tools import StarTools

        out.append(Path(StarTools.get_data_dir(plugin_name)))
    except Exception as exc:  # noqa: BLE001
        logger.debug("StarTools.get_data_dir 不可用：%s", exc)

    # 3) AstrBot 的路径工具（依赖 cwd，只作兜底）
    try:
        from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

        out.append(Path(get_astrbot_plugin_data_path()) / plugin_name)
    except Exception as exc:  # noqa: BLE001
        try:
            from astrbot.core.utils.astrbot_path import get_astrbot_data_path

            out.append(Path(get_astrbot_data_path()) / "plugin_data" / plugin_name)
        except Exception as exc2:  # noqa: BLE001
            logger.debug("AstrBot 路径工具不可用：%s / %s", exc, exc2)

    # 4) 桌面版常见布局
    try:
        out.append(Path.home() / ".astrbot" / "data" / "plugin_data" / plugin_name)
    except Exception:  # noqa: BLE001
        pass

    # 5) 兜底：插件目录下
    out.append(Path(plugin_dir) / "data")

    # 去重（保持顺序）
    seen: set[str] = set()
    uniq: list[Path] = []
    for p in out:
        key = str(p).lower()
        if key in seen:
            continue
        seen.add(key)
        uniq.append(p)
    return uniq


def _has_existing_data(path: Path) -> bool:
    """这个目录里已经有她的数据了吗？"""
    try:
        if not path.is_dir():
            return False
        for name in MARKER_FILES:
            p = path / name
            if p.is_file() and p.stat().st_size > 0:
                return True
    # **探测**：失败就是「不可写/不存在」，用返回值表达，不是异常
    except Exception:  # noqa: BLE001
        pass
    return False


def resolve_data_dir(plugin_name: str, plugin_dir: Path) -> Path:
    """挑一个合适的数据目录，并把选择结果记下来供下次复用。"""
    candidates = candidate_dirs(plugin_name, Path(plugin_dir))

    # 1) 优先复用"已经有数据"的目录，避免升级/换部署方式后丢记忆
    existing = [c for c in candidates if _has_existing_data(c)]
    if existing:
        chosen = existing[0]
        if len(existing) > 1:
            logger.warning(
                "发现多处历史数据，将使用 %s（其余：%s）。如需合并请手动处理",
                chosen,
                "、".join(str(p) for p in existing[1:]),
            )
        logger.info("沿用已有数据目录：%s", chosen)
        _remember_choice(plugin_name, plugin_dir, chosen)
        return chosen

    # 2) 没有历史数据 → 挑第一个能写进去的
    for c in candidates:
        try:
            c.mkdir(parents=True, exist_ok=True)
            probe = c / ".write_probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
            logger.info("数据目录：%s", c)
            _remember_choice(plugin_name, plugin_dir, c)
            return c
        except Exception as exc:  # noqa: BLE001
            logger.debug("候选数据目录不可写 %s：%s", c, exc)

    # 3) 全都不行：返回兜底并明确告警（静默失败会让人以为"记忆功能没生效"）
    fallback = Path(plugin_dir) / "data"
    logger.error(
        "所有候选数据目录都不可写，将使用 %s（记忆可能无法持久化）。候选列表：%s",
        fallback,
        "、".join(str(p) for p in candidates),
    )
    return fallback


def _remember_choice(plugin_name: str, plugin_dir: Path, chosen: Path) -> None:
    """把选择写进插件目录，下次启动优先用它（也方便用户排查"数据在哪"）。

    注意：这里只做提示，不改变上面"优先复用已有数据"的逻辑——
    否则一旦用户手动挪了数据，记录反而会把插件引到空目录上。
    """
    try:
        note = Path(plugin_dir) / "data_location.json"
        note.write_text(
            json.dumps(
                {"plugin": plugin_name, "data_dir": str(chosen)},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("记录数据目录位置失败（不影响运行）：%s", exc)
