"""与 Node 引擎子进程通信的 NDJSON / JSON-RPC 客户端。

设计要点：
- 引擎是一个长期运行的子进程，stdout 是纯协议流，stderr 是日志（会被转发到 AstrBot 日志）
- 引擎崩溃/被 kill 后要能自动拉起，并且把"断线"这件事告诉上层去更新状态
- 所有调用都带超时：绝不出现"插件卡死等引擎回应"
- 事件（引擎主动推的通知）通过回调分发给插件
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from astrbot.api import logger

# 引擎自定义错误码（必须与 bot/rpc.js 保持一致）
ERR_GAME = 1000          # 游戏内动作失败，message 可直接展示
ERR_NOT_CONNECTED = 1001  # 机器人没进服
ERR_BUSY = 1002           # 队列忙 / 被抢占
ERR_CANCELLED = 1003      # 任务被取消
ERR_TIMEOUT = 1004        # 动作超时

# 这些错误属于"机器人没进服"这一类，交给上层去决定要不要自动重连
CONNECT_ERRORS = {ERR_NOT_CONNECTED}


class EngineError(RuntimeError):
    """引擎返回的业务错误。message 已经是给人和 LLM 看的中文了。"""

    def __init__(self, message: str, code: int = ERR_GAME, data: dict | None = None):
        super().__init__(message)
        self.code = code
        self.data = data or {}

    @property
    def is_not_connected(self) -> bool:
        return self.code in CONNECT_ERRORS

    @property
    def is_cancelled(self) -> bool:
        return self.code == ERR_CANCELLED

    @property
    def is_timeout(self) -> bool:
        return self.code == ERR_TIMEOUT


class EngineUnavailable(EngineError):
    """引擎进程本身不可用（没启动、已崩溃、通道关闭）。"""

    def __init__(self, message: str):
        super().__init__(message, code=ERR_NOT_CONNECTED)


@dataclass
class EngineConfig:
    """引擎启动参数。node_path 为空时自动探测。"""

    engine_dir: Path
    node_path: str = ""
    log_level: str = "info"
    config_path: Path | None = None
    extra_env: dict[str, str] = field(default_factory=dict)

    def resolve_node(self) -> str:
        """定位 node 可执行文件。

        顺序有意为之：**先找独立安装的 Node，最后才用别的程序自带的**。
        原因：DSH Desktop / 各种 GUI 工装自带的 node 只存在于它们自己的目录里，
        用户卸载或重装那个程序之后路径就失效了，而 AstrBot 会在毫无预兆的情况下起不来。
        独立安装的 Node（Program Files）才是稳定依赖。
        """
        if self.node_path:
            candidate = Path(self.node_path)
            if candidate.exists():
                return str(candidate)
            logger.warning("配置的 node_path 不存在，回退到自动探测：%s", self.node_path)

        # 1) 正常安装在 PATH 上的
        found = shutil.which("node")
        if found:
            return found

        guesses = [
            # 2) 各平台的标准安装位置
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "nodejs" / "node.exe",
            Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "nodejs" / "node.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "nodejs" / "node.exe",
            Path("/usr/local/bin/node"),
            Path("/usr/bin/node"),
            # 3) 最后才考虑工装自带的（脆弱，仅作兜底）
            Path(os.environ.get("APPDATA", "")) / "dsh-desktop" / "harness" / ".desktop-bin" / "node.exe",
        ]
        for guess in guesses:
            if guess.exists():
                return str(guess)

        # 4) 实在没有 .exe，退而接受 .CMD/.cmd（Windows 上的批处理包装器）。
        #    实测 Python 3.12 的 create_subprocess_exec 能执行 .CMD，但不是所有版本都行，
        #    所以放在最后，并且明确告诉用户"建议换成 node.exe"。
        cmd_candidates = [
            Path(os.environ.get("APPDATA", "")) / "dsh-desktop" / "harness" / ".desktop-bin" / "node.CMD",
            Path(os.environ.get("APPDATA", "")) / "dsh-desktop" / "harness" / ".desktop-bin" / "node.cmd",
        ]
        for guess in cmd_candidates:
            if guess.exists():
                logger.warning(
                    "只找到批处理包装器 %s；建议安装独立 Node 并在插件配置里填 node_path，"
                    "避免依赖其它程序自带的运行时",
                    guess,
                )
                return str(guess)

        raise EngineUnavailable(
            "找不到 node 可执行文件。请安装 Node.js 18+，"
            "或在插件配置里填入 node_path（例如 C:\\Program Files\\nodejs\\node.exe）"
        )


class EngineClient:
    """按 NDJSON 与引擎对话的异步客户端。"""

    def __init__(self, config: EngineConfig):
        self._cfg = config
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self._next_id = 1
        self._lock = asyncio.Lock()
        self._closing = False
        self._engine_info: dict[str, Any] = {}
        self._last_stderr: list[str] = []

        # 事件回调：event_name -> [callbacks]
        self._handlers: dict[str, list[Callable[[dict], Awaitable[None] | None]]] = {}
        # 断线/上线回调
        self.on_disconnected: Callable[[str], Awaitable[None] | None] | None = None
        self.on_ready: Callable[[dict], Awaitable[None] | None] | None = None

    # ------------------------------------------------------------ 生命周期

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    @property
    def engine_info(self) -> dict[str, Any]:
        return dict(self._engine_info)

    async def start(self) -> dict[str, Any]:
        """启动引擎进程并等待 engine.ready。幂等：已在跑就直接返回。"""
        async with self._lock:
            if self.running:
                return self._engine_info

            entry = self._cfg.engine_dir / "index.js"
            if not entry.exists():
                raise EngineUnavailable(f"引擎入口不存在：{entry}（检查插件配置里的 engine_dir）")
            node_modules = self._cfg.engine_dir / "node_modules" / "mineflayer"
            if not node_modules.exists():
                raise EngineUnavailable(
                    f"引擎依赖缺失：{node_modules} 不存在。请在 {self._cfg.engine_dir} 下执行 "
                    f'npm install --cache "<工作台内目录>"'
                )

            node = self._cfg.resolve_node()
            env = dict(os.environ)
            env["MC_ENGINE_LOG_LEVEL"] = self._cfg.log_level
            if self._cfg.config_path:
                env["MC_ENGINE_CONFIG"] = str(self._cfg.config_path)
            env.update(self._cfg.extra_env)

            logger.info("启动 Minecraft 引擎：%s %s", node, entry)
            self._closing = False
            self._proc = await asyncio.create_subprocess_exec(
                node,
                str(entry),
                cwd=str(self._cfg.engine_dir),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            self._reader_task = asyncio.create_task(self._read_loop(), name="mc-engine-reader")
            self._stderr_task = asyncio.create_task(self._drain_stderr(), name="mc-engine-stderr")

        # 等 engine.ready（引擎启动后会立刻推一条）
        ready = await self._wait_ready(timeout=15.0)
        if ready is None:
            tail = "\n".join(self._last_stderr[-10:])
            await self.stop()
            raise EngineUnavailable(f"引擎启动后没有就绪响应，stderr 末尾：\n{tail}")
        self._engine_info = ready
        logger.info(
            "Minecraft 引擎就绪：v%s，%s 个技能",
            ready.get("version"),
            len(ready.get("skills", [])),
        )
        if self.on_ready:
            _fire(self.on_ready(ready))
        return ready

    async def _wait_ready(self, timeout: float) -> dict | None:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if self._engine_info:
                return self._engine_info
            if not self.running:
                return None
            await asyncio.sleep(0.1)
        return self._engine_info or None

    async def stop(self, *, kill_after: float = 3.0) -> None:
        """优雅关闭：关 stdin 让引擎自己退出，超时再 kill。"""
        self._closing = True
        proc = self._proc
        self._proc = None
        for task in (self._reader_task, self._stderr_task):
            if task and not task.done():
                task.cancel()
        self._reader_task = None
        self._stderr_task = None
        self._fail_pending("引擎已关闭")

        if proc is None:
            return
        with contextlib.suppress(Exception):
            if proc.stdin and not proc.stdin.is_closing():
                proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), timeout=kill_after)
        except asyncio.TimeoutError:
            logger.warning("引擎未在 %.1f 秒内退出，强制结束", kill_after)
            with contextlib.suppress(Exception):
                proc.kill()
            with contextlib.suppress(Exception):
                await proc.wait()

    # ------------------------------------------------------------ 读取循环

    async def _read_loop(self) -> None:
        assert self._proc and self._proc.stdout
        stream = self._proc.stdout
        buf = b""
        try:
            while True:
                chunk = await stream.read(65536)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    self._handle_line(line)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.error("引擎输出读取异常：%s", exc)
        finally:
            # 进程结束（无论正常还是崩溃）
            reason = "引擎进程已退出"
            if self._proc is not None:
                code = self._proc.returncode
                reason = f"引擎进程退出（code={code}）"
            self._fail_pending(reason)
            if not self._closing and self.on_disconnected:
                _fire(self.on_disconnected(reason))

    def _handle_line(self, line: bytes) -> None:
        try:
            msg = json.loads(line.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            # 协议被污染是严重问题（比如引擎里有人误用 stdout），必须显式报出来
            logger.error("引擎输出不是合法 JSON（协议流被污染）：%s", line[:300])
            return
        if not isinstance(msg, dict):
            return

        if msg.get("method") == "notice":
            params = msg.get("params") or {}
            event = params.get("event")
            data = params.get("data") or {}
            if event == "engine.ready":
                self._engine_info = data
            self._dispatch_event(event, data)
            return

        msg_id = msg.get("id")
        if msg_id is None:
            return
        fut = self._pending.pop(msg_id, None)
        if fut is None or fut.done():
            return
        if msg.get("error"):
            err = msg["error"]
            fut.set_exception(EngineError(err.get("message", "引擎返回未知错误"), err.get("code", ERR_GAME), err.get("data")))
        else:
            fut.set_result(msg.get("result"))

    async def _drain_stderr(self) -> None:
        assert self._proc and self._proc.stderr
        stream = self._proc.stderr
        buf = b""
        try:
            while True:
                chunk = await stream.read(8192)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    text = line.decode("utf-8", errors="replace").rstrip()
                    if not text:
                        continue
                    self._last_stderr.append(text)
                    if len(self._last_stderr) > 60:
                        self._last_stderr.pop(0)
                    # 引擎日志转发到 AstrBot 日志，前缀区分
                    if "ERROR" in text or "WARN" in text:
                        logger.warning("[MC引擎] %s", text)
                    else:
                        logger.debug("[MC引擎] %s", text)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            pass

    def _fail_pending(self, reason: str) -> None:
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(EngineUnavailable(reason))
        self._pending.clear()

    # ------------------------------------------------------------ 事件

    def on(self, event: str, callback: Callable[[dict], Awaitable[None] | None]) -> None:
        self._handlers.setdefault(event, []).append(callback)

    def off_all(self) -> None:
        self._handlers.clear()

    def _dispatch_event(self, event: str | None, data: dict) -> None:
        if not event:
            return
        for cb in self._handlers.get(event, []):
            try:
                _fire(cb(data))
            except Exception as exc:  # noqa: BLE001
                logger.error("事件回调 %s 出错：%s", event, exc)
        # 通配订阅
        for cb in self._handlers.get("*", []):
            try:
                _fire(cb({"event": event, "data": data}))
            except Exception as exc:  # noqa: BLE001
                logger.error("通配事件回调出错：%s", exc)

    # ------------------------------------------------------------ 调用

    async def call(self, method: str, params: dict | None = None, *, timeout: float = 30.0) -> Any:
        """发一个 RPC 请求并等待结果。"""
        proc = self._proc
        if proc is None or proc.returncode is not None or proc.stdin is None:
            raise EngineUnavailable("引擎没有在运行（可能已崩溃或未启动）")

        msg_id = self._next_id
        self._next_id += 1
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut

        payload = json.dumps({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}}, ensure_ascii=False)
        try:
            proc.stdin.write((payload + "\n").encode("utf-8"))
            await proc.stdin.drain()
        except Exception as exc:  # noqa: BLE001
            self._pending.pop(msg_id, None)
            raise EngineUnavailable(f"向引擎写入失败：{exc}") from exc

        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(msg_id, None)
            raise EngineError(f"引擎响应超时（{timeout:.0f} 秒，调用 {method}）", code=ERR_TIMEOUT) from exc

    # ------------------------------------------------------------ 便捷方法

    async def ping(self, *, timeout: float = 5.0) -> bool:
        try:
            r = await self.call("ping", {}, timeout=timeout)
            return bool(r and r.get("pong"))
        except Exception:  # noqa: BLE001
            return False

    async def status(self, *, timeout: float = 10.0) -> dict:
        return await self.call("status", {}, timeout=timeout)

    async def state(self, detail: str = "normal", *, timeout: float = 10.0) -> dict:
        return await self.call("state.get", {"detail": detail}, timeout=timeout)

    async def state_brief(self, goal: str | None = None, *, timeout: float = 10.0) -> str:
        r = await self.call("state.brief", {"goal": goal} if goal else {}, timeout=timeout)
        return (r or {}).get("text", "")

    async def skills(self) -> list[str]:
        r = await self.call("skill.list", {}, timeout=10.0)
        return list((r or {}).get("names", []))

    async def run_skill(self, skill: str, params: dict | None = None, *, timeout: float = 15.0) -> dict:
        return await self.call("skill.run", {"skill": skill, "params": params or {}}, timeout=timeout)

    async def task_status(self, task_id: str | None = None, *, timeout: float = 10.0) -> dict:
        return await self.call("task.status", {"task_id": task_id} if task_id else {}, timeout=timeout)

    async def cancel_task(self, task_id: str | None = None, *, timeout: float = 10.0) -> dict:
        return await self.call("task.cancel", {"task_id": task_id} if task_id else {}, timeout=timeout)

    async def safety_stop(self, *, timeout: float = 15.0) -> dict:
        return await self.call("safety.stop", {}, timeout=timeout)

    async def say(self, message: str, *, timeout: float = 10.0) -> dict:
        return await self.call("chat.say", {"message": message}, timeout=timeout)

    async def apply_engine_settings(self, settings: dict, *, timeout: float = 10.0) -> dict:
        """把插件配置里的引擎参数下发给引擎。

        为什么需要这个接口：安全相关的配置（挖掘黑白名单、出生点保护半径）
        在**引擎侧**才真正生效（`actions.js` 的 `_assertNotProtected`）。
        如果只在插件配置里设、却没下发，用户会以为"我设了保护"，
        实际上机器人照挖不误——这是很危险的一类静默失效。
        """
        clean = {k: v for k, v in (settings or {}).items() if v is not None}
        if not clean:
            return {"ok": True, "applied": {}}
        return await self.call("config.update", clean, timeout=timeout)

    async def connect_game(
        self,
        *,
        host: str,
        port: int,
        username: str,
        version: str = "1.20.1",
        auth: str = "offline",
        slow_mode: bool = False,
        auto_mode: bool = True,
        auto_eat: bool = True,
        auto_defend: bool = True,
        skill_timeout_ms: int | None = None,
        extra: dict | None = None,
        timeout: float = 60.0,
    ) -> dict:
        params = {
            "host": host,
            "port": int(port),
            "username": username,
            "version": version,
            "auth": auth,
            "slowMode": bool(slow_mode),
            "autoMode": bool(auto_mode),
            "autoEat": bool(auto_eat),
            "autoDefend": bool(auto_defend),
        }
        if skill_timeout_ms:
            params["skillTimeoutMs"] = int(skill_timeout_ms)
        if extra:
            params.update(extra)
        return await self.call("connect", params, timeout=timeout)


def _fire(awaitable_or_value: Any) -> None:
    """回调可能是协程也可能是普通函数，统一处理并交给事件循环。"""
    if asyncio.iscoroutine(awaitable_or_value):
        task = asyncio.ensure_future(awaitable_or_value)

        def _log_exc(t: asyncio.Task) -> None:
            if t.cancelled():
                return
            exc = t.exception()
            if exc:
                logger.error("异步回调异常：%s", exc)

        task.add_done_callback(_log_exc)
