"""进程内 RCON 客户端（Python 版，给测试脚本用）。

对应的 JS 版是 `bot/tools/lib/rcon.js`。两边踩过的坑一样，这里都处理了：

1. **认证成功的响应是 id=1/type=2**，不是标准文档说的 type=3。
   判失败要靠 `id == -1`，不能靠 type。
2. **认证后不能立刻清空 pending**：命令响应可能在同一个 I/O 块里就到达，
   那时如果 pending 已清空，响应会被丢弃 → 指令超时。
3. **响应可能分多个包**，要累积到 `type == 0` 的结束包再结算。
4. 登录响应里带的世界名/协议版本等信息用不上，忽略即可。

用法：
    from lib.rcon import Rcon
    r = Rcon.from_dir(".testserver", 25576)
    r.command("time set day")
    r.close()
"""

from __future__ import annotations

import re
import socket
import struct
import time
from pathlib import Path

_TYPE_AUTH = 3
_TYPE_COMMAND = 2


class RconError(RuntimeError):
    pass


class Rcon:
    def __init__(self, host: str, port: int, password: str, timeout: float = 10.0):
        self.host = host
        self.port = int(port)
        self.password = password
        self.timeout = timeout
        self._sock: socket.socket | None = None
        self._next_id = 1
        self._buf = b""

    # ---------------------------------------------------------------- 构造

    @staticmethod
    def read_config(server_dir: str | Path) -> dict:
        """从 server.properties 读 rcon 配置。"""
        cfg: dict[str, str] = {}
        path = Path(server_dir) / "server.properties"
        if not path.exists():
            return cfg
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"^\s*([^#=]+?)\s*=\s*(.*)$", line)
            if m:
                cfg[m.group(1).strip()] = m.group(2).strip()
        return cfg

    @classmethod
    def from_dir(cls, server_dir: str | Path, port: int | None = None) -> "Rcon":
        cfg = cls.read_config(server_dir)
        if cfg.get("enable-rcon") != "true":
            raise RconError(f"{server_dir} 没有启用 rcon（enable-rcon != true）")
        return cls(
            host="127.0.0.1",
            port=int(port or cfg.get("rcon.port") or 25575),
            password=cfg.get("rcon.password") or "",
        )

    # ---------------------------------------------------------------- 连接

    def connect(self) -> None:
        if self._sock is not None:
            return
        try:
            sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except OSError as exc:
            raise RconError(f"连接 rcon {self.host}:{self.port} 失败：{exc}") from exc
        sock.settimeout(self.timeout)
        self._sock = sock
        self._buf = b""

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    # ---------------------------------------------------------------- 协议

    @staticmethod
    def _pack(req_id: int, ptype: int, body: str) -> bytes:
        payload = body.encode("utf-8") + b"\x00\x00"
        return struct.pack("<iii", 4 + 4 + len(payload), req_id, ptype) + payload

    def _read_packet(self) -> tuple[int, int, str]:
        """读一个完整的包（长度前缀 + id + type + body）。"""
        assert self._sock is not None
        while len(self._buf) < 4:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise RconError("rcon 连接被关闭")
            self._buf += chunk
        (length,) = struct.unpack("<i", self._buf[:4])
        while len(self._buf) < 4 + length:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise RconError("rcon 连接被关闭")
            self._buf += chunk
        payload = self._buf[4 : 4 + length]
        self._buf = self._buf[4 + length :]
        req_id, ptype = struct.unpack("<ii", payload[:8])
        body = payload[8:-2].decode("utf-8", errors="replace")
        return req_id, ptype, body

    def command(self, cmd: str) -> str:
        """发一条指令，返回服务端的回执文本。"""
        self.connect()
        assert self._sock is not None
        req_id = self._next_id
        self._next_id += 2

        self._sock.sendall(self._pack(req_id, _TYPE_AUTH, self.password))
        # 认证响应：成功时 id == req_id（实测 type=2，不是文档里的 3）
        rid, _ptype, _body = self._read_packet()
        if rid == -1:
            raise RconError("rcon 认证失败：密码不对")

        self._sock.sendall(self._pack(req_id + 1, _TYPE_COMMAND, cmd))
        # 响应可能分多包，累积到 type == 0 的结束包
        parts: list[str] = []
        deadline = time.time() + self.timeout
        while True:
            if time.time() > deadline:
                raise RconError(f"rcon 指令超时：{cmd}")
            rid2, ptype2, body2 = self._read_packet()
            if body2:
                parts.append(body2)
            if ptype2 == 0:
                break
        return "".join(parts)

    def command_quiet(self, cmd: str) -> None:
        """发指令但忽略回执（场景准备用，失败也不中断）。"""
        try:
            self.command(cmd)
        except RconError:
            pass
