'use strict';
/**
 * 进程内 RCON 客户端（不需要 spawn 子进程）。
 *
 * 为什么不用 `execFileSync('node', ['tools/rcon.js', ...])`：
 * 沙箱环境下"捕获子进程输出"（stdin/stdout pipe）会被拒绝，报
 * `spawnSync ... EPERM`，而且这个错误在测试里看起来像"rcon 挂了"，
 * 极难归因——本次开发中它导致了多轮难以解释的失败。
 * 直接在进程内开 TCP 连接就没有这个问题，也更快。
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

/** Minecraft RCON 协议：长度(4) + 请求ID(4) + 类型(4) + 载荷 + \0\0 */
function packet(id, type, body) {
  const bodyBuf = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(4 + 4 + 4 + bodyBuf.length + 2);
  buf.writeInt32LE(4 + 4 + bodyBuf.length + 2, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeUInt8(0, 12 + bodyBuf.length);
  buf.writeUInt8(0, 13 + bodyBuf.length);
  return buf;
}

function parsePacket(buf) {
  const len = buf.readInt32LE(0);
  return {
    id: buf.readInt32LE(4),
    type: buf.readInt32LE(8),
    body: buf.toString('utf8', 12, 4 + len - 2),
  };
}

/** 从 server.properties 读 rcon 配置 */
function readRconConfig(dir) {
  const file = path.join(dir, 'server.properties');
  if (!fs.existsSync(file)) return {};
  const cfg = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)$/);
    if (m) cfg[m[1].trim()] = m[2].trim();
  }
  return cfg;
}

class Rcon {
  constructor({ host = '127.0.0.1', port, password }) {
    this.host = host;
    this.port = Number(port);
    this.password = password;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = null;
  }

  static fromDir(dir, portOverride = null) {
    const cfg = readRconConfig(dir);
    if (cfg['enable-rcon'] !== 'true') {
      throw new Error(`${dir} 未启用 rcon（server.properties 里 enable-rcon 不是 true）`);
    }
    return new Rcon({
      port: portOverride || Number(cfg['rcon.port'] || 25575),
      password: cfg['rcon.password'] || '',
    });
  }

  connect(timeoutMs = 8000) {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`连接 rcon ${this.host}:${this.port} 超时`));
      }, timeoutMs);
      sock.once('connect', () => {
        clearTimeout(timer);
        this.socket = sock;
        sock.on('data', (chunk) => this._onData(chunk));
        sock.on('error', () => {
          this.socket = null;
        });
        sock.on('close', () => {
          this.socket = null;
        });
        resolve();
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`连接 rcon 失败：${err.message}`));
      });
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readInt32LE(0);
      if (this.buffer.length < 4 + len) break;
      const pkt = parsePacket(this.buffer);
      this.buffer = this.buffer.subarray(4 + len);
      const waiter = this.pending;
      if (process.env.RCON_DEBUG) {
        console.error(
          `[rcon] 收到 id=${pkt.id} type=${pkt.type} len=${len} stage=${waiter ? waiter.stage : 'none'} body=${JSON.stringify(pkt.body).slice(0, 80)}`,
        );
      }
      if (!waiter) continue;

      if (waiter.stage === 'auth') {
        // 认证失败的标志是响应 id === -1。
        // 注意：**不能**用 type 判断认证响应——实测 Paper 成功时返回 id=1/type=2
        // （也就是"命令响应"类型），按标准文档判断 type===3 会永远等不到。
        if (pkt.id === -1) {
          this.pending = null;
          waiter.reject(new Error('rcon 认证失败：密码不对'));
          continue;
        }
        // 这里**不要**清空 this.pending：命令包写出去后响应可能在同一个 I/O 块里
        // 就返回，_onData 会被重入调用，那时 pending 已空就会把响应丢掉 → 指令超时。
        waiter.stage = 'command';
        waiter.socket.write(packet(waiter.id + 1, 2, waiter.cmd));
        continue;
      }

      // 命令响应可能分多个包返回，最后一个 type === 0 的包表示结束。
      // 必须累积内容再结算：早期实现"第一个包就 resolve"，导致多包响应的
      // 后半截（或整体）被丢弃，表现为某些指令莫名返回空字符串。
      if (typeof pkt.body === 'string' && pkt.body.length) {
        waiter.body += pkt.body;
      }
      if (pkt.type === 0) {
        this.pending = null;
        waiter.resolve(waiter.body);
      }
    }
  }

  /** 发一条指令 */
  async command(cmd, timeoutMs = 15000) {
    await this.connect();
    const id = this.nextId;
    this.nextId += 2;
    const sock = this.socket;
    if (!sock) throw new Error('rcon 连接不可用');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`rcon 指令超时：${cmd}`));
      }, timeoutMs);
      this.pending = {
        id,
        cmd,
        stage: 'auth',
        socket: sock,
        body: '',
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      // 认证包与随后的命令包都写到捕捉到的这个 socket 上：
      // 不要用 this.socket 二次取，_onData 里的写入可能发生在 close 事件把
      // this.socket 置空之后，那样命令包会被静默丢弃（表现为指令超时）。
      sock.write(packet(id, 3, this.password));
    });
  }

  /** 连发多条 */
  async commands(list) {
    const out = [];
    for (const c of list) {
      out.push(await this.command(c));
    }
    return out;
  }

  close() {
    if (this.socket) {
      try {
        this.socket.end();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }
}

module.exports = { Rcon, readRconConfig };
