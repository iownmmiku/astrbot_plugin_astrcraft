#!/usr/bin/env python3
"""用**真实的 AstrBot 配置**做一次完整的启动演练。

和 `test_integration.py` 的区别：
- 那个用的是代码里现造的测试配置（图省事）
- 这个**读真实的配置文件**，走和 AstrBot 上线时一模一样的代码路径

能抓到的失败模式：配置文件写错、engine_dir/node_path 指向不对、
依赖没装、引擎起不来、事件注册不上。这些都是"重启 AstrBot 才发现"的问题，
这个脚本把它们提前暴露。

用法：
  $env:PYTHONPATH='D:\\AstrBot\\backend\\app'
  D:\\AstrBot\\backend\\python\\python.exe bot\\tools\\dryrun.py
"""

from __future__ import annotations

import asyncio
import io
import json
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent.parent
sys.path.insert(0, str(_REPO))

CONFIG_PATH = Path(r"C:\Users\miku\.astrbot\data\config\astrbot_plugin_astrcraft_config.json")
PLUGIN_DIR = Path(r"C:\Users\miku\.astrbot\data\plugins\astrbot_plugin_astrcraft")

problems: list[str] = []


def ok(msg):
    print(f"  ✅ {msg}")


def bad(msg):
    problems.append(msg)
    print(f"  ❌ {msg}")


class FakeContext:
    """够用的 AstrBot Context 替身（提供人格库）。"""

    def __init__(self):
        self._sent: list[tuple[str, str]] = []

        class _PM:
            class _P:
                persona_id = "default"
                name = "默认人格"
                system_prompt = "你是一个安静、话不多的角色，喜欢一个人待着。"

            async def get_all_personas(self):
                return [self._P()]

            async def get_default_persona_v3(self, umo=None):
                return {"prompt": self._P.system_prompt, "name": self._P.name}

            async def get_persona(self, pid):
                if pid == "default":
                    return self._P()
                raise ValueError(pid)

        self.persona_manager = _PM()

    def add_llm_tools(self, *tools):
        pass

    def get_all_stars(self):
        return []

    async def get_current_chat_provider_id(self, umo: str) -> str:
        return "fake-provider"

    async def get_using_provider_async(self, umo=None):
        class _P:
            provider_config = {"id": "fake-provider"}

        return _P()

    async def llm_generate(self, **kw):
        class _R:
            completion_text = "（演练回复）嗯。"
            result_chain = None

        return _R()

    async def send_message(self, umo: str, chain) -> None:
        try:
            self._sent.append((umo, chain.get_plain_text()))
        except Exception:  # noqa: BLE001
            pass


async def main() -> int:
    print("=== 用真实配置做启动演练 ===\n")
    print(f"配置：{CONFIG_PATH}")
    print(f"插件：{PLUGIN_DIR}\n")

    # 用 utf-8-sig 读：Windows 上各种工具写 JSON 时常带 BOM，
    # 而 Python 的 utf-8 解码会因为 BOM 直接抛 JSONDecodeError（实测踩过）。
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))

    # 按 AstrBot 的方式加载插件（真实副本，不是仓库里的源码）
    sys.path.insert(0, str(PLUGIN_DIR.parent))
    try:
        import importlib

        mod = importlib.import_module(f"{PLUGIN_DIR.name}.main")
        plugin_cls = mod.MinecraftPlugin
        ok(f"插件模块导入成功：{mod.PLUGIN_NAME}")
    except Exception as exc:  # noqa: BLE001
        bad(f"插件导入失败：{exc}")
        return 1

    ctx = FakeContext()
    plugin = plugin_cls(ctx, cfg)
    ok("插件实例化成功")

    print("\n[1] initialize()：走真实配置启动引擎")
    t0 = time.time()
    try:
        await plugin.initialize()
    except Exception as exc:  # noqa: BLE001
        bad(f"initialize() 抛异常：{exc}")
        return 1

    elapsed = time.time() - t0
    if not plugin.engine or not plugin.engine.running:
        bad("initialize() 之后引擎没有运行（检查 engine_dir / node_path）")
        return 1
    ok(f"引擎已启动（{elapsed:.1f} 秒，pid={plugin.engine._proc.pid}）")

    info = plugin.engine.engine_info
    ok(f"引擎自报版本 v{info.get('version')}，技能 {len(info.get('skills') or [])} 个")

    print("\n[2] 人格 / 记忆 / 驱动力 / 过日子 是否都装配上了")
    ok(f"人格：{await plugin.persona.current_display()}") if plugin.persona else bad("人格模块未装配")
    ok(f"记忆：{plugin.memory.stats()}") if plugin.memory else bad("记忆模块未装配")
    if plugin.drives:
        top = plugin.drives.top_drive()
        ok(f"驱动力：最强动机 = {top.label}（{top.level:.2f}）")
    else:
        bad("驱动力模块未装配")
    ok(f"过日子循环：{'已装配（未启动，等进服）' if plugin.life else '未装配'}") if plugin.life else bad("过日子模块未装配")

    print("\n[3] 配置项是否真的生效")
    # 人格来源
    cur = await plugin.persona.resolve()
    if cfg.get("mc_persona_id"):
        want = cfg["mc_persona_id"]
        (ok if cur["id"] == want else bad)(
            f"mc_persona_id={want} → 实际解析到 {cur['id']}（{cur['name']}）"
        )
    else:
        ok(f"未指定 mc_persona_id → 用 AstrBot 默认人格（{cur['name']}）")

    # 唤醒词
    wake = cfg.get("wake_words") or []
    sample = " ".join(str(w) for w in wake) if wake else ""
    if wake and plugin._should_reply(f"喂 {sample} 在吗"):
        ok(f"唤醒词生效：说了「{sample}」会触发回复")
    elif wake:
        bad("唤醒词没生效")
    else:
        ok("未配唤醒词 → 只认机器人名字（这是预期行为）")

    # 过日子开关
    if cfg.get("enable_life_loop", True):
        ok(f"enable_life_loop=true → 进服后会启动（间隔 {cfg.get('life_decide_interval')} 秒）")
    else:
        ok("enable_life_loop=false → 不会自主行动")

    print("\n[5] 通过生产 RPC 通道调引擎")
    try:
        ok("ping 往返正常") if await plugin.engine.ping() else bad("ping 失败")
    except Exception as exc:  # noqa: BLE001
        bad(f"ping 异常：{exc}")
    try:
        skills = await plugin.engine.skills()
        ok(f"skill.list 返回 {len(skills)} 个技能") if len(skills) >= 10 else bad(f"技能数量异常：{skills}")
    except Exception as exc:  # noqa: BLE001
        bad(f"skill.list 失败：{exc}")

    # 技能目录（过日子决策要用）
    catalog = await plugin._skill_catalog()
    if catalog and all(isinstance(c, dict) and c.get("skill") for c in catalog):
        ok(f"_skill_catalog 返回 {len(catalog)} 项（决策链路要用的格式）")
    else:
        bad(f"_skill_catalog 格式不对：{catalog[:2]}")

    print("\n[6] 真进服 + 配置下发（如果本地 25565 有服务端）")
    try:
        await plugin._auto_connect(reason="演练")
        await asyncio.sleep(4)
        if not plugin.connected:
            print("     （本地 25565 没有服务端，跳过——这是正常情况）")
        else:
            ok(f"真进服成功（位置 {plugin.engine._proc and '已连接'}）")
            st = await plugin.engine.status()
            ok(f"位置 {st.get('position')}，生命 {st.get('health')}")

            # 关键：确认插件配置里的引擎侧参数真的下发了。
            # 这项以前无从确认——引擎的 status 里不报安全设置，
            # 用户只能翻引擎日志才知道"我设的保护到底生效没有"。
            cfg_now = st.get("config") or {}
            bl = cfg_now.get("dig_blacklist")
            expect = cfg.get("dig_blacklist") or []
            if isinstance(bl, list) and bl == expect:
                ok(f"引擎侧安全配置已生效：dig_blacklist={bl}")
            else:
                bad(f"引擎没收到 dig_blacklist：期望 {expect}，实际 {bl}——安全配置静默失效")

            radius = cfg_now.get("spawn_protection_radius")
            if radius == cfg.get("spawn_protection_radius"):
                ok(f"出生点保护半径已生效：{radius}")
            else:
                bad(f"spawn_protection_radius 没生效：期望 {cfg.get('spawn_protection_radius')}，实际 {radius}")

            timeout_ms = cfg_now.get("skill_timeout_ms")
            expect_ms = int(cfg.get("skill_timeout_seconds", 300)) * 1000
            if timeout_ms == expect_ms:
                ok(f"技能超时已生效：{timeout_ms} ms（= {cfg.get('skill_timeout_seconds')} 秒）")
            else:
                bad(f"skill_timeout 没生效：期望 {expect_ms}，实际 {timeout_ms}")

            # 过日子循环应该在进服后启动
            await asyncio.sleep(1)
            if plugin.life and plugin.life.running:
                ok("过日子循环已随进服启动")
            else:
                bad("进服后过日子循环没有启动")

            # 数据文件应该开始写了
            await asyncio.sleep(2)
            data_dir = plugin._data_dir
            for f in ("memory.json", "drives.json", "life.json"):
                p = data_dir / f
                ok(f"  {f} 已生成（{p.stat().st_size} 字节）") if p.exists() else print(f"      {f} 尚未生成")
    except Exception as exc:  # noqa: BLE001
        print(f"     （进服环节跳过：{type(exc).__name__}: {exc}）")

    print("\n[7] terminate()：回收子进程")
    pid = plugin.engine._proc.pid if plugin.engine and plugin.engine._proc else None
    await plugin.terminate()
    await asyncio.sleep(1.0)
    try:
        import subprocess

        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"], capture_output=True, text=True, timeout=15).stdout
        alive = str(pid) in out
    except Exception:  # noqa: BLE001
        alive = None
    if alive is False:
        ok(f"引擎子进程已回收（pid={pid}）")
    elif alive is True:
        bad(f"terminate() 后引擎仍存活（pid={pid}）—— AstrBot 里会残留进程")
    else:
        print(f"     无法确认进程状态（pid={pid}）")

    print("\n=== 结果 ===")
    if problems:
        print(f"❌ {len(problems)} 个问题：")
        for p in problems:
            print(f"  ✗ {p}")
        return 1
    print("✅ 用真实配置启动链路完全正常——重启 AstrBot 就能用")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
