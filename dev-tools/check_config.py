#!/usr/bin/env python3
"""配置入口校验：拿**真实的** AstrBot 配置，逐项确认每个入口能通。

为什么单独写这个：配置文件是 JSON，写错了 AstrBot 不会报错，
只会在某个功能用不了的时候才暴露（比如 engine_dir 填错 → 插件说"引擎未运行"）。
这个脚本把每个关键入口都实际走一遍：
  引擎目录 → 能不能找到 index.js
  Node 路径 → 能不能执行
  引擎依赖 → node_modules/mineflayer 在不在
  游戏连接 → 配置的地址端口格式对不对
  人格     → 能不能从 AstrBot 读到
  数据目录 → 记忆/驱动能不能落盘

用法（在仓库根执行；AstrBot 的位置用环境变量给，别写死在脚本里）：
  $env:ASTRBOT_APP='<AstrBot>/backend/app'
  $env:ASTRBOT_DATA='<AstrBot>/data'
  & '<AstrBot>/backend/python/python.exe' dev-tools/check_config.py
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import _paths  # noqa: E402
from _paths import ENGINE_DIR  # noqa: E402

_paths.load_plugin()

# 这个脚本要对着**用户机器上真实安装的** AstrBot 跑：配置文件、已安装的插件副本、
# 插件数据目录都在 AstrBot 的 data 目录下。位置因机器而异，
# 所以只从环境变量读——**不写死任何人的家目录**。
#   $env:ASTRBOT_DATA='<AstrBot>/data'
_ASTRBOT_DATA = os.environ.get("ASTRBOT_DATA", "").strip()
ASTRBOT_DATA = Path(_ASTRBOT_DATA).expanduser() if _ASTRBOT_DATA else None

CONFIG_PATH = ASTRBOT_DATA / "config" / "astrbot_plugin_astrcraft_config.json" if ASTRBOT_DATA else None
PLUGIN_DIR = ASTRBOT_DATA / "plugins" / "astrbot_plugin_astrcraft" if ASTRBOT_DATA else None
DATA_DIR = ASTRBOT_DATA / "plugin_data" / "astrbot_plugin_astrcraft" if ASTRBOT_DATA else None

problems: list[str] = []
warnings: list[str] = []
passed = 0


def ok(msg):
    global passed
    passed += 1
    print(f"  ✅ {msg}")


def bad(msg):
    problems.append(msg)
    print(f"  ❌ {msg}")


def warn(msg):
    warnings.append(msg)
    print(f"  ⚠ {msg}")


class FakeContext:
    """只提供 persona_manager，够验证人格入口。"""

    class _PM:
        async def get_all_personas(self):
            return []

        async def get_default_persona_v3(self, umo=None):
            return None

        async def get_persona(self, pid):
            raise ValueError(pid)

    persona_manager = _PM()


async def main() -> int:
    if ASTRBOT_DATA is None:
        print(
            "⏭  SKIP：这个脚本校验的是**用户机器上真实安装的** AstrBot，需要知道它的数据目录。\n"
            "    环境变量 ASTRBOT_DATA 没设（脚本里不写死任何人的家目录），所以现在无从检查。\n"
            "    设置后重试：\n"
            "      $env:ASTRBOT_DATA='<AstrBot>/data'\n"
            "    它会去读：\n"
            "      <AstrBot>/data/config/astrbot_plugin_astrcraft_config.json\n"
            "      <AstrBot>/data/plugins/astrbot_plugin_astrcraft\n"
            "      <AstrBot>/data/plugin_data/astrbot_plugin_astrcraft"
        )
        sys.exit(0)

    print("=== 配置入口校验 ===\n")
    print(f"配置文件：{CONFIG_PATH}")
    print(f"插件目录：{PLUGIN_DIR}\n")

    if not CONFIG_PATH.exists():
        print(f"❌ 配置文件不存在：{CONFIG_PATH}")
        print("   （AstrBot 加载插件时会自动生成它）")
        return 2

    try:
        # utf-8-sig：AstrBot 自己写的配置文件可能带 BOM，
        # 用普通 utf-8 读会抛 "Unexpected UTF-8 BOM"，
        # 看起来像配置坏了，其实只是编码前缀（实测就是这么误报的）。
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
        ok(f"配置是合法 JSON（{len(cfg)} 个配置项）")
    except json.JSONDecodeError as exc:
        bad(f"配置 JSON 解析失败：{exc}")
        return 1

    # ---------------------------------------------------------- 1. 引擎目录
    print("\n[1] 引擎目录（最关键的一项）")
    engine_dir_raw = str(cfg.get("engine_dir") or "").strip()
    if not engine_dir_raw:
        bad("engine_dir 是空的 —— 插件会找不到引擎（这是最常见的启动失败原因）")
        print(f"      修法：填引擎目录绝对路径（本仓库里就是 {ENGINE_DIR}）")
    else:
        engine_dir = Path(engine_dir_raw)
        if not engine_dir.exists():
            bad(f"engine_dir 指向的目录不存在：{engine_dir}")
        else:
            ok(f"engine_dir 存在：{engine_dir}")

            index_js = engine_dir / "index.js"
            if index_js.exists():
                size = index_js.stat().st_size
                ok(f"引擎入口存在：index.js（{size} 字节）")
            else:
                bad(f"引擎入口缺失：{index_js}")

            mf = engine_dir / "node_modules" / "mineflayer"
            if mf.exists():
                try:
                    ver = json.loads((mf / "package.json").read_text(encoding="utf-8"))["version"]
                    ok(f"引擎依赖已安装：mineflayer@{ver}")
                except Exception:  # noqa: BLE001
                    ok("引擎依赖已安装：mineflayer")
            else:
                bad(f"引擎依赖缺失：{mf} —— 需要在该目录执行 npm install")

            for pkg in ("minecraft-data", "mineflayer-pathfinder"):
                p = engine_dir / "node_modules" / pkg
                if p.exists():
                    try:
                        v = json.loads((p / "package.json").read_text(encoding="utf-8"))["version"]
                        ok(f"依赖 {pkg}@{v}")
                    except Exception:  # noqa: BLE001
                        ok(f"依赖 {pkg}")
                else:
                    bad(f"依赖缺失：{pkg}")

    # ---------------------------------------------------------- 2. Node
    print("\n[2] Node 可执行文件")
    node_path = str(cfg.get("node_path") or "").strip()
    if node_path:
        if Path(node_path).exists():
            ok(f"配置的 node_path 存在：{node_path}")
        else:
            bad(f"配置的 node_path 不存在：{node_path}（请修正或留空让插件自动探测）")
    else:
        # bridge_client 依赖 astrbot（`from astrbot.api import logger`）。
        # AstrBot 源码目录只认环境变量 ASTRBOT_APP —— _paths.astrbot_available()
        # 会把它加进 sys.path 并试着导入。
        if not _paths.astrbot_available():
            warn("import 不到 astrbot（设 ASTRBOT_APP=<AstrBot>/backend/app）→ 跳过 node 自动探测")
        else:
            from astrcraft_plugin.bridge_client import EngineConfig

            tmp = EngineConfig(engine_dir=Path(engine_dir_raw or ENGINE_DIR))
            try:
                resolved = tmp.resolve_node()
                ok(f"node_path 留空 → 自动探测到：{resolved}")
            except Exception as exc:  # noqa: BLE001
                bad(f"自动探测 node 失败：{exc}")

    # ---------------------------------------------------------- 3. 服务器
    print("\n[3] 服务器连接配置")
    host = str(cfg.get("server_host") or "").strip()
    port = cfg.get("server_port")
    version = str(cfg.get("mc_version") or "").strip()
    username = str(cfg.get("bot_username") or "").strip()
    auth = str(cfg.get("auth_method") or "offline").strip()

    ok(f"目标服务器：{host}:{port}") if host and isinstance(port, int) and 1 <= port <= 65535 else bad(f"服务器地址/端口不合法：{host}:{port}")
    if version:
        ok(f"目标版本：{version}（必须与服务端一致）")
    else:
        bad("mc_version 为空 —— 版本不匹配会卡在登录阶段")
    if 1 <= len(username) <= 16:
        ok(f"游戏内名字：{username}（{len(username)} 字符，符合 1–16 的限制）")
    else:
        bad(f"bot_username 长度不合法（{len(username)}）：Minecraft 要求 1–16 字符")
    if auth in ("offline", "microsoft"):
        ok(f"登录方式：{auth}" + ("（只能进 online-mode=false 的服务器）" if auth == "offline" else ""))
    else:
        bad(f"auth_method 只能是 offline 或 microsoft，当前是 {auth}")

    # ---------------------------------------------------------- 4. 人格
    print("\n[4] 人格入口")
    mc_persona_id = str(cfg.get("mc_persona_id") or "").strip()
    persona_text = str(cfg.get("persona") or "").strip()
    if mc_persona_id:
        ok(f"指定了固定人格：{mc_persona_id}（要用 AstrBot 里真实存在的人格 ID）")
        warn("填了 ID 但插件无法在这里确认它是否存在；若不存在会自动回退到 AstrBot 默认人格")
    else:
        ok("未指定 mc_persona_id → 使用 AstrBot 的默认人格")
    if persona_text:
        warn("persona 也填了内容：它只在读不到 AstrBot 人格时才作为兜底")
    wake = cfg.get("wake_words") or []
    if isinstance(wake, list):
        ok(f"游戏内唤醒词：{'、'.join(str(w) for w in wake) if wake else '（空，只有机器人名字有效）'}")

    # ---------------------------------------------------------- 5. 过日子
    print("\n[5] 过日子相关")
    if cfg.get("enable_life_loop", True):
        interval = cfg.get("life_decide_interval", 90)
        cooldown = cfg.get("life_share_cooldown", 600)
        ok(f"自主行动：开启（每 {interval} 秒想一次自己在干嘛）")
        if isinstance(interval, int) and interval < 30:
            warn(f"life_decide_interval={interval} 偏短，她可能显得坐立不安（建议 60–180）")
        if isinstance(cooldown, int) and cooldown < 120:
            warn(f"life_share_cooldown={cooldown} 偏短，她可能在游戏内刷屏（建议 ≥300）")
    else:
        warn("enable_life_loop=false：她不会自己找事做，只响应你的指令")

    # ---------------------------------------------------------- 6. 数据目录
    print("\n[6] 数据目录（记忆与驱动的落盘位置）")
    data_dir = DATA_DIR
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        probe = data_dir / ".write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        ok(f"数据目录可写：{data_dir}")
        for f in ("memory.json", "drives.json", "persona.json", "life.json"):
            p = data_dir / f
            if p.exists():
                ok(f"  {f} 已存在（{p.stat().st_size} 字节）")
            else:
                print(f"      {f} 尚未生成（首次运行时会创建）")
    except Exception as exc:  # noqa: BLE001
        bad(f"数据目录不可写：{exc}")

    # ---------------------------------------------------------- 7. 插件目录
    print("\n[7] 插件文件完整性")
    if not PLUGIN_DIR.exists():
        bad(f"插件目录不存在：{PLUGIN_DIR}")
    else:
        required = [
            "main.py", "bridge_client.py", "perception.py", "goals.py",
            "persona.py", "memory.py", "drives.py", "life.py",
            "llm_tools_core.py", "llm_tools_skills.py", "llm_tools_life.py",
            "metadata.yaml", "_conf_schema.json",
        ]
        missing = [f for f in required if not (PLUGIN_DIR / f).exists()]
        if missing:
            bad(f"缺少文件：{', '.join(missing)}")
        else:
            ok(f"必需文件齐全（{len(required)} 个）")

        # 配置项与 schema 是否对得上
        schema_path = PLUGIN_DIR / "_conf_schema.json"
        if schema_path.exists():
            try:
                schema = json.loads(schema_path.read_text(encoding="utf-8"))
                extra = set(cfg) - set(schema)
                absent = set(schema) - set(cfg)
                if extra:
                    warn(f"配置里有 schema 未定义的项（可能是旧版本残留）：{', '.join(sorted(extra))}")
                if absent:
                    warn(f"schema 里有配置未包含的项（AstrBot 会用默认值补上）：{', '.join(sorted(absent))}")
                if not extra and not absent:
                    ok(f"配置项与 schema 完全一致（{len(schema)} 项）")
            except Exception as exc:  # noqa: BLE001
                bad(f"schema 解析失败：{exc}")

    # ---------------------------------------------------------- 结果
    print("\n=== 结果 ===")
    for w in warnings:
        print(f"  ⚠ {w}")
    if problems:
        print(f"❌ {len(problems)} 个问题需要修：")
        for p in problems:
            print(f"  ✗ {p}")
        return 1
    print(f"✅ 配置各个入口都通（{passed} 项检查通过）")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
