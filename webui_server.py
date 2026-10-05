"""Optional, authenticated dashboard; HTTP threads never touch the bot directly.

All snapshots and controls run on AstrBot's asyncio loop. The frontend uses
the standard library server and local assets, so installation needs no build.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import hmac
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(message)


class WebUI:
    ACTIONS = {"connect", "disconnect", "stop", "resume", "pause", "abandon", "goal", "say", "viewer"}
    ASSETS = {"/": ("index.html", "text/html; charset=utf-8"),
              "/app.css": ("app.css", "text/css; charset=utf-8"),
              "/app.js": ("app.js", "text/javascript; charset=utf-8"),
              "/favicon.svg": ("favicon.svg", "image/svg+xml")}

    def __init__(self, plugin, *, host: str, port: int, token: str, version: str):
        if not token.strip() or len(token.encode("utf-8")) > 512:
            raise ValueError("WebUI 访问令牌不能为空且不能超过 512 字节")
        if any(not 33 <= ord(char) <= 126 for char in token.strip()):
            raise ValueError("WebUI 访问令牌请使用英文字母、数字或 ASCII 符号，不含空格")
        self.plugin = plugin
        self.host, self.port, self.token, self.version = host, port, token.strip(), version
        self.loop = asyncio.get_running_loop()
        self.server = None
        self.thread = None
        self.closing = False
        self.jobs: dict[str, dict] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self._snapshot_lock = asyncio.Lock()
        self._cached = None
        self._cached_at = 0.0

    @staticmethod
    def load_token(data_dir: Path, configured: str = "") -> str:
        if configured.strip():
            return configured.strip()
        path = data_dir / "webui_token.txt"
        if path.exists():
            token = path.read_text(encoding="utf-8").strip()
            if token:
                return token
        token = secrets.token_urlsafe(32)
        # Never store this credential in the source tree or print it in logs.
        with path.open("w", encoding="utf-8") as output:
            output.write(token + "\n")
        path.chmod(0o600)
        return token

    @property
    def url(self) -> str:
        host = "127.0.0.1" if self.host == "0.0.0.0" else self.host
        return f"http://{host}:{self.port}"

    def start(self) -> None:
        owner = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "Astrcraft"
            sys_version = ""

            def setup(self):
                super().setup()
                self.connection.settimeout(10)

            def log_message(self, *_args):
                pass  # Request paths and credentials must not appear in access logs.

            def reply(self, status, body, content_type="application/json; charset=utf-8"):
                if not isinstance(body, bytes):
                    body = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    # The browser closed its request; no bot action is lost or
                    # replayed just because the HTTP response cannot be written.
                    pass

            def authorized(self):
                value = self.headers.get("Authorization", "")
                return hmac.compare_digest(value.encode("utf-8"), ("Bearer " + owner.token).encode("utf-8"))

            def same_origin(self):
                # No cross-origin API and no accepting browser mutation requests
                # from another page, even if it somehow obtains the bearer token.
                origin = self.headers.get("Origin")
                if origin:
                    parsed = urlsplit(origin)
                    if (parsed.scheme not in {"http", "https"} or parsed.netloc != self.headers.get("Host", "")
                            or parsed.path or parsed.query or parsed.fragment or parsed.username):
                        return False
                return self.headers.get("Sec-Fetch-Site") not in {"cross-site", "same-site"}

            def dispatch(self, coroutine):
                if owner.closing:
                    coroutine.close()
                    raise ApiError(503, "控制台正在关闭")
                future = asyncio.run_coroutine_threadsafe(coroutine, owner.loop)
                try:
                    return future.result(timeout=12)
                except concurrent.futures.TimeoutError:
                    future.cancel()
                    raise ApiError(504, "读取超时，请稍后重试") from None

            def do_GET(self):
                try:
                    path = urlsplit(self.path).path
                    if path in owner.ASSETS:
                        name, mime = owner.ASSETS[path]
                        self.reply(200, (Path(__file__).parent / "webui" / name).read_bytes(), mime)
                    elif path == "/api/state":
                        if not self.authorized():
                            raise ApiError(401, "请使用有效的访问令牌登录")
                        self.reply(200, self.dispatch(owner.snapshot()))
                    else:
                        raise ApiError(404, "页面不存在")
                except ApiError as exc:
                    self.reply(exc.status, {"error": str(exc)})
                except Exception:
                    self.reply(500, {"error": "控制台读取失败，请查看 AstrBot 日志"})

            def do_POST(self):
                try:
                    if urlsplit(self.path).path != "/api/action":
                        raise ApiError(404, "接口不存在")
                    if not self.authorized():
                        raise ApiError(401, "请使用有效的访问令牌登录")
                    if not self.same_origin():
                        raise ApiError(403, "只允许从控制台页面执行操作")
                    if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                        raise ApiError(415, "请求必须使用 JSON")
                    if self.headers.get("Transfer-Encoding"):
                        raise ApiError(400, "不支持分块请求")
                    try:
                        size = int(self.headers.get("Content-Length", "0"))
                    except ValueError:
                        raise ApiError(400, "请求长度无效") from None
                    if not 0 < size <= 4096:
                        raise ApiError(413, "请求内容为空或过长")
                    try:
                        body = json.loads(self.rfile.read(size))
                    except (ValueError, UnicodeError):
                        raise ApiError(400, "JSON 格式无效") from None
                    if not isinstance(body, dict):
                        raise ApiError(400, "请求必须是对象")
                    self.reply(202, self.dispatch(owner.submit(body)))
                except ApiError as exc:
                    self.reply(exc.status, {"error": str(exc)})
                except Exception:
                    self.reply(500, {"error": "控制台操作失败，请查看 AstrBot 日志"})

        class Server(ThreadingHTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        self.server = Server((self.host, self.port), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.1},
                                       name="astrcraft-webui", daemon=True)
        self.thread.start()

    async def close(self):
        self.closing = True
        for task in self.tasks.values():
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        if self.server:
            await asyncio.to_thread(self.server.shutdown)
            self.server.server_close()
        if self.thread:
            await asyncio.to_thread(self.thread.join, 2)

    async def snapshot(self):
        async with self._snapshot_lock:
            if self._cached is None or time.monotonic() - self._cached_at >= 1:
                self._cached = await self._read_engine()
                self._cached_at = time.monotonic()
            # Plugin state is inexpensive and always read fresh, including stop
            # and command receipts while the engine snapshot is cached.
            p, life, goals = self.plugin, self.plugin.life, self.plugin.goals
            plan = goals.plan if goals else None
            current = life.current if life else None
            return {**self._cached,
                    "version": self.version, "sampled_at": time.time(),
                    "plugin": {"connected": p.connected, "emergency_stopped": p._emergency_stopped,
                               "manual_disconnect": p._manual_disconnect_requested,
                               "server": f"{p._cfg('server_host', '127.0.0.1')}:{p._cfg('server_port', 25565)}",
                               "username": p._cfg("bot_username", "AstrBot")},
                    "life": {"running": life.running, "paused": life.paused,
                             "hold": life.current_hold().value, "hold_reason": life.hold_explain(),
                             "intention": life._intention, "activity": current.activity if current else "",
                             "reason": current.reason if current else "", "summary": life.describe(),
                             "plan": [{"skill": step.get("skill"), "why": step.get("why", "")} for step in life._plan],
                             "recent": life._recent_outcomes[-8:]} if life else None,
                    "goal": {"status": goals.status, "title": plan.goal if plan else "",
                             "index": goals.step_index, "error": goals.last_error,
                             "steps": [{"skill": step.skill, "label": step.describe()} for step in plan.steps] if plan else [],
                             "log": goals.log[-10:]} if goals else None,
                    "events": p._event_buffer[-40:],
                    "jobs": list(self.jobs.values())[-20:]}

    async def _read_engine(self):
        engine = self.plugin.engine
        result = {"engine_running": bool(engine and engine.running), "state": None, "engine": None,
                  "viewer": None, "errors": [], "observed_at": time.time()}
        if not result["engine_running"]:
            result["errors"].append("引擎未运行，可检查 Node.js 与依赖后点击进服重试")
            return result
        values = await asyncio.gather(engine.call("status", {}, timeout=5),
                                      engine.call("state.get", {"detail": "full"}, timeout=5),
                                      engine.call("viewer.status", {}, timeout=5), return_exceptions=True)
        for key, value in zip(("engine", "state", "viewer"), values):
            if isinstance(value, Exception):
                result["errors"].append(f"{key} 读取失败：{value}")
            else:
                result[key] = value
        return result

    async def submit(self, body):
        if self.closing or getattr(self.plugin, "_terminating", False):
            raise ApiError(503, "插件正在卸载")
        action = body.get("action")
        if not isinstance(action, str) or action not in self.ACTIONS:
            raise ApiError(400, "未知操作")
        text = body.get("text", "")
        limit = 250 if action == "say" else 500
        if not isinstance(text, str) or len(text) > limit:
            raise ApiError(400, f"文本最多 {limit} 字符")
        text = text.strip()
        if action in {"goal", "say"} and not text:
            raise ApiError(400, "请填写内容")
        busy = [(key, task) for key, task in self.tasks.items() if not task.done()]
        urgent = action in {"stop", "disconnect"}
        if busy and (not urgent or any(self.jobs[key]["action"] in {"stop", "disconnect"} for key, _ in busy)):
            raise ApiError(409, "上一项控制操作还在执行；急停和退服可中断普通操作")
        if urgent:
            if action == "stop":
                self.plugin._emergency_stopped = True
                if self.plugin.life:
                    self.plugin.life.pause(reason="急停", max_seconds=0)
            else:
                self.plugin._manual_disconnect_requested = True
            for _, task in busy:
                task.cancel()
        job_id = secrets.token_hex(8)
        self.jobs[job_id] = {"id": job_id, "action": action, "status": "running", "at": time.time(), "message": "操作已接收"}
        self.tasks[job_id] = asyncio.create_task(self._run(job_id, text), name=f"mc-webui-{action}")
        for key in list(self.jobs)[:-30]:
            if self.tasks[key].done():
                self.tasks.pop(key)
                self.jobs.pop(key)
        return dict(self.jobs[job_id])

    async def _run(self, job_id, text):
        job = self.jobs[job_id]
        try:
            message = await asyncio.wait_for(self._act(job["action"], text), timeout=120)
            job.update(status="done", message=message)
        except asyncio.CancelledError:
            job.update(status="cancelled", message="操作被急停、退服或插件卸载中断")
            raise
        except Exception as exc:
            job.update(status="failed", message=str(exc) or "操作超时")
        finally:
            job["finished_at"] = time.time()
            self._cached_at = 0

    async def _act(self, action, text):
        p = self.plugin
        if action == "stop":
            result = await p._emergency_stop()
            return f"已急停，取消 {len(result.get('cancelled', []))} 个动作"
        if action == "disconnect":
            message = await p._do_disconnect()
            if message.startswith("断线时出错"):
                raise ValueError(message)
            return message
        if action == "connect":
            p._manual_disconnect_requested = False
            if not await p._ensure_engine():
                raise ValueError("引擎启动失败，请查看 AstrBot 日志并检查 Node.js 依赖")
            await p._auto_connect(reason="WebUI 进服")
            if not p.connected:
                raise ValueError("未能进入服务器，请查看 AstrBot 日志和服务器配置")
            return "已进入服务器"
        if action == "resume":
            return await p._resume_play()
        if action == "pause":
            return await p._pause_play()
        if action == "abandon":
            return await p._abandon_goal()
        if not p.connected or not p.engine or not p.engine.running:
            raise ValueError("机器人尚未进入服务器")
        if action == "goal":
            if not p.goals:
                raise ValueError("目标系统未初始化")
            return await p._start_player_goal(text)
        if action == "say":
            await p.engine.say(text)
            return "消息已发送到游戏"
        if action == "viewer":
            await p.engine.call("viewer.start", {}, timeout=30)
            return "观战服务已启动，可点击观战入口"
        raise ValueError("未知操作")
