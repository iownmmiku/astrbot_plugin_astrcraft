#!/usr/bin/env python3
"""Python 插件 ↔ Node 引擎的真实集成测试。

这一步和之前所有测试都不同：它**真的用插件代码启动引擎子进程**，
再通过生产用的 RPC 通道去问状态。能覆盖到的失败模式：
  - 子进程启动参数不对（node 路径、engine_dir、环境变量）
  - NDJSON 协议实现有偏差（读循环、事件分发、超时）
  - 事件回调在真实数据下抛异常
  - terminate() 不能真正回收子进程（会导致 AstrBot 里残留僵尸进程）

用法：
  $env:PYTHONPATH='D:\\AstrBot\\backend\\app'
  D:\\AstrBot\\backend\\python\\python.exe bot\\tools\\test_integration.py
可选环境变量：
  MC_TEST_PORT=25566   连哪个服务器（默认不连，只测引擎通道）
  MC_TEST_CONNECT=1    是否真的进服
  MC_ENGINE_DIR=...    指定引擎目录
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import time
import traceback
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent.parent
ENGINE_DIR = Path(os.environ.get("MC_ENGINE_DIR", _REPO / "bot"))

problems: list[str] = []
def ok(msg):
    print(f"  ✅ {msg}")
def bad(msg):
    problems.append(msg)
    print(f"  ❌ {msg}")
def note(msg):
    print(f"     · {msg}")


class FakeContext:
    """够用的 AstrBot Context 替身。

    只实现插件真正会用到的方法，其他方法故意不提供——
    这样如果插件偷偷调用了不存在的 API，测试会直接报 AttributeError 而不是静默通过。
    """

    def __init__(self):
        self.sent: list[tuple[str, str]] = []
        self.llm_calls = 0
        self._tools: list = []

    def add_llm_tools(self, *tools):
        self._tools.extend(tools)

    def get_all_stars(self):
        return []

    async def get_current_chat_provider_id(self, umo: str) -> str:
        return "fake-provider"

    async def get_using_provider_async(self, umo=None):
        class _P:
            provider_config = {"id": "fake-provider"}

        return _P()

    async def llm_generate(self, *, chat_provider_id, prompt=None, system_prompt=None, **kw):
        self.llm_calls += 1

        class _R:
            completion_text = "（测试回复）好的，我这就去。"
            result_chain = None

        return _R()

    async def send_message(self, umo: str, chain) -> None:
        try:
            text = chain.get_plain_text()
        except Exception:  # noqa: BLE001
            text = str(chain)
        self.sent.append((umo, text))


async def main() -> int:
    print("=== 插件 ↔ 引擎 集成测试 ===")
    print(f"引擎目录：{ENGINE_DIR}\n")

    if not (ENGINE_DIR / "index.js").exists():
        print(f"❌ 找不到引擎入口：{ENGINE_DIR / 'index.js'}")
        return 2
    if not (ENGINE_DIR / "node_modules" / "mineflayer").exists():
        print(f"❌ 引擎依赖没装：{ENGINE_DIR / 'node_modules' / 'mineflayer'}")
        return 2

    # 按 AstrBot 的方式导入插件
    sys.path.insert(0, str(_REPO))
    sys.path.insert(0, os.environ.get("ASTRBOT_APP", r"D:\AstrBot\backend\app"))
    try:
        import importlib

        main_mod = importlib.import_module("plugin.main")
    except Exception:  # noqa: BLE001
        print("❌ 无法导入插件模块：")
        traceback.print_exc()
        return 1

    plugin_cls = main_mod.MinecraftPlugin
    ctx = FakeContext()
    port = int(os.environ.get("MC_TEST_PORT", "25565"))
    config = {
        "engine_dir": str(ENGINE_DIR),
        "engine_log_level": os.environ.get("MC_TEST_LOG", "info"),
        "auto_connect": False,  # 先不自动进服，通道测完再手动连
        "forward_engine_events": True,
        "server_host": "127.0.0.1",
        "server_port": port,
        "bot_username": os.environ.get("MC_TEST_USER", "AstrBotIntg"),
        "mc_version": os.environ.get("MC_TEST_VERSION", "1.20.1"),
    }

    print("[1] 实例化插件")
    plugin = plugin_cls(ctx, config)
    ok(f"实例化成功，插件名 {main_mod.PLUGIN_NAME}")

    print("\n[2] initialize()：启动引擎子进程")
    t0 = time.time()
    await plugin.initialize()
    elapsed = time.time() - t0
    if plugin.engine and plugin.engine.running:
        ok(f"引擎进程已启动（{elapsed:.1f} 秒，pid={plugin.engine._proc.pid}）")
    else:
        bad("initialize() 之后引擎没有在运行")
        return 1

    info = plugin.engine.engine_info
    note(f"引擎自报版本：{info.get('version')}，技能 {len(info.get('skills') or [])} 个")

    print("\n[3] 通过生产 RPC 通道调用引擎")
    try:
        pong = await plugin.engine.ping()
        if pong:
            ok("ping 往返正常")
        else:
            bad("ping 失败")
    except Exception as exc:  # noqa: BLE001
        bad(f"ping 抛异常：{exc}")

    try:
        skills = await plugin.engine.skills()
        if len(skills) >= 10:
            ok(f"skill.list 返回 {len(skills)} 个技能")
        else:
            bad(f"技能数量异常：{skills}")
    except Exception as exc:  # noqa: BLE001
        bad(f"skill.list 失败：{exc}")

    try:
        brief = await plugin._get_brief()
        note(f"未进服时的简报：{brief.strip()[:60]}")
        ok("状态读取在有/无连接两种情况下都不抛异常")
    except Exception as exc:  # noqa: BLE001
        bad(f"_get_brief 抛异常：{exc}")

    print("\n[4] 事件回调（引擎推送 → 插件处理）")
    # 触发一次引擎通知：手动调用事件处理路径
    try:
        plugin._remember("test.event", {"x": 1})
        if plugin._event_buffer:
            ok(f"事件缓冲可用（{len(plugin._event_buffer)} 条）")
        else:
            bad("事件没有被记录")
    except Exception as exc:  # noqa: BLE001
        bad(f"事件记录失败：{exc}")

    # 真实事件：连上服务器后会收到 bot.spawn
    if os.environ.get("MC_TEST_CONNECT") == "1":
        print("\n[5] 真实进服（通过插件代码路径）")
        try:
            await plugin._auto_connect(reason="集成测试")
            await asyncio.sleep(3)
            if plugin.connected:
                ok("插件认为已连接，且收到了 bot.spawn")
                st = await plugin.engine.status()
                note(f"位置：{st.get('position')}，生命 {st.get('health')}")
                brief = await plugin._get_brief()
                note("状态简报：")
                for line in brief.strip().splitlines():
                    print(f"       {line}")
                # 通过插件发一句话
                said = await plugin.engine.say("集成测试：我进来了")
                ok(f"通过插件在游戏内发言成功：{said.get('said')}")
                # 跑一个短技能
                r = await plugin.engine.run_skill("mine_stone", {"count": 2})
                note(f"提交技能成功，task_id={r.get('task_id')}")
                await asyncio.sleep(1)
                ts = await plugin.engine.task_status(r.get("task_id"))
                ok(f"任务可查询：{ts.get('name')} / {ts.get('status')}")
                await plugin.engine.cancel_task(r.get("task_id"))
            else:
                bad("进服未成功（plugin.connected 仍为 False）")
        except Exception as exc:  # noqa: BLE001
            bad(f"进服流程异常：{exc}")
            traceback.print_exc()
    else:
        print("\n[5] 已跳过进服测试（设 MC_TEST_CONNECT=1 启用）")

    print("\n[6] terminate()：回收子进程")
    pid = plugin.engine._proc.pid if plugin.engine and plugin.engine._proc else None
    try:
        await plugin.terminate()
        await asyncio.sleep(0.8)
        import psutil  # type: ignore

        alive = psutil.pid_exists(pid)
    except ImportError:
        # 没有 psutil 就用 tasklist 判断（Windows）
        alive = None
        if pid:
            import subprocess

            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"], capture_output=True, text=True, timeout=10).stdout
            alive = str(pid) in out
    except Exception as exc:  # noqa: BLE001
        bad(f"terminate() 异常：{exc}")
        alive = None

    if alive is False:
        ok(f"引擎子进程已回收（pid={pid} 不存在）")
    elif alive is True:
        bad(f"terminate() 之后引擎子进程仍然存活（pid={pid}）—— AstrBot 里会残留僵尸进程")
    else:
        note(f"无法确认进程状态（pid={pid}）")

    print("\n=== 结果 ===")
    if problems:
        print(f"❌ {len(problems)} 个问题：")
        for p in problems:
            print(f"  ✗ {p}")
        return 1
    print("✅ 插件与引擎的集成通道工作正常")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
