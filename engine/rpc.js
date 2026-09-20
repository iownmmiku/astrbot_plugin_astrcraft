'use strict';
/**
 * NDJSON over stdio 的 JSON-RPC 2.0 实现（引擎侧）。
 *
 * 约定，务必遵守，否则会污染协议流：
 *   - stdout 只允许出现 NDJSON，一行一个完整 JSON 对象，不许多行缩进
 *   - 所有日志一律走 stderr
 *
 * 三种消息：
 *   请求      { jsonrpc:"2.0", id:1, method:"state.get", params:{} }
 *   响应      { jsonrpc:"2.0", id:1, result:{...} }  或  { ..., error:{code,message,data} }
 *   通知      { jsonrpc:"2.0", method:"notice", params:{ event:"bot.spawn", data:{...} } }
 *             （通知没有 id，也可以带 id 表示"引擎主动向插件发起的请求"）
 */

const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // 引擎自定义：把"业务失败"和"协议错误"分开，插件侧好处理
  GAME_ERROR: 1000, // 游戏内动作失败（可读原因在 message 里）
  NOT_CONNECTED: 1001, // 机器未进服
  BUSY: 1002, // 动作队列忙 / 被抢占
  CANCELLED: 1003, // 任务被取消
  TIMEOUT: 1004, // 动作超时
};

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** 业务层抛这个，会被转成 GAME_ERROR 而不是 INTERNAL_ERROR，日志里不打堆栈 */
class GameError extends RpcError {
  constructor(message, data) {
    super(JSON_RPC_ERRORS.GAME_ERROR, message, data);
    this.name = 'GameError';
  }
}

class NotConnectedError extends RpcError {
  constructor(message = '机器人尚未进入服务器') {
    super(JSON_RPC_ERRORS.NOT_CONNECTED, message);
    this.name = 'NotConnectedError';
  }
}

class TimeoutError extends RpcError {
  constructor(message = '动作超时') {
    super(JSON_RPC_ERRORS.TIMEOUT, message);
    this.name = 'TimeoutError';
  }
}

class CancelledError extends RpcError {
  constructor(message = '动作已取消') {
    super(JSON_RPC_ERRORS.CANCELLED, message);
    this.name = 'CancelledError';
  }
}

class RpcPeer {
  /**
   * @param {object} opts
   * @param {NodeJS.ReadableStream} opts.input   默认 process.stdin
   * @param {NodeJS.WritableStream} opts.output  默认 process.stdout
   * @param {(line:string)=>void} opts.onMalformed 收到坏行时的回调（打日志用）
   */
  constructor({ input = process.stdin, output = process.stdout, onMalformed = null } = {}) {
    this._input = input;
    this._output = output;
    this._onMalformed = onMalformed;
    this._handlers = new Map();
    this._nextId = 1;
    this._pending = new Map(); // 我们发出去的请求 id -> {resolve, reject, timer}
    this._buffer = '';
    this._closed = false;
    this._writeChain = Promise.resolve();
    this._onCloseHandlers = [];
  }

  /** 注册方法处理器：handler(params, ctx) => any | Promise<any> */
  handle(method, handler) {
    this._handlers.set(method, handler);
    return this;
  }

  onClose(fn) {
    this._onCloseHandlers.push(fn);
    return this;
  }

  start() {
    this._input.setEncoding('utf8');
    this._input.on('data', (chunk) => this._onData(chunk));
    this._input.on('end', () => this._close('stdin 关闭'));
    this._input.on('error', (err) => this._close(`stdin 错误: ${err.message}`));
    // stdin 被父进程直接关掉时（插件进程退出），这里也要能感知到
    process.on('SIGINT', () => this._close('收到 SIGINT'));
    process.on('SIGTERM', () => this._close('收到 SIGTERM'));
    return this;
  }

  _close(reason) {
    if (this._closed) return;
    this._closed = true;
    for (const fn of this._onCloseHandlers) {
      try {
        fn(reason);
      } catch {
        /* 关闭路径上的异常不能再抛出去 */
      }
    }
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new RpcError(JSON_RPC_ERRORS.INTERNAL_ERROR, `通道关闭：${reason}`));
    }
    this._pending.clear();
  }

  get closed() {
    return this._closed;
  }

  _onData(chunk) {
    this._buffer += chunk;
    // 单条消息上限保护：正常消息都是几 KB，超过 64MB 说明协议已经错乱了
    if (this._buffer.length > 64 * 1024 * 1024) {
      this._buffer = '';
      if (this._onMalformed) this._onMalformed('缓冲区超过 64MB，已丢弃（协议可能被日志污染）');
      return;
    }
    let idx;
    while ((idx = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, idx).replace(/\r$/, '');
      this._buffer = this._buffer.slice(idx + 1);
      if (!line.trim()) continue;
      this._dispatchLine(line);
    }
  }

  _dispatchLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      if (this._onMalformed) this._onMalformed(`无法解析的 JSON 行：${line.slice(0, 200)}`);
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    // 是响应（有 id 且没有 method）
    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const entry = this._pending.get(msg.id);
      if (!entry) return;
      this._pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new RpcError(msg.error.code ?? JSON_RPC_ERRORS.INTERNAL_ERROR, msg.error.message ?? '未知错误', msg.error.data));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // 是请求（有 method），没有 id 的当通知处理
    if (typeof msg.method === 'string') {
      const isNotification = msg.id === undefined || msg.id === null;
      const handler = this._handlers.get(msg.method);
      if (!handler) {
        if (!isNotification) {
          this._send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: JSON_RPC_ERRORS.METHOD_NOT_FOUND, message: `未知方法：${msg.method}` },
          });
        }
        return;
      }
      Promise.resolve()
        .then(() => handler(msg.params ?? {}, msg))
        .then((result) => {
          if (!isNotification) {
            this._send({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result });
          }
        })
        .catch((err) => {
          if (isNotification) return;
          this._send({ jsonrpc: '2.0', id: msg.id, error: this._toErrorObject(err) });
        });
    }
  }

  _toErrorObject(err) {
    if (err instanceof RpcError) {
      return { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) };
    }
    return {
      code: JSON_RPC_ERRORS.INTERNAL_ERROR,
      message: err && err.message ? err.message : String(err),
      data: { stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : undefined },
    };
  }

  /** 发通知：插件侧会以事件形式收到 */
  notify(event, data) {
    this._send({ jsonrpc: '2.0', method: 'notice', params: { event, data } });
  }

  /** 主动向插件发请求并等回复（引擎侧目前只在需要用户决策时用） */
  request(method, params = {}, { timeoutMs = 30000 } = {}) {
    const id = `e${this._nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new TimeoutError(`等待插件响应 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this._pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  _send(obj) {
    if (this._closed) return;
    let line;
    try {
      line = `${JSON.stringify(obj)}\n`;
    } catch (err) {
      // 循环引用等序列化失败不能把整个引擎带崩
      line = `${JSON.stringify({
        jsonrpc: '2.0',
        id: obj && obj.id !== undefined ? obj.id : null,
        error: { code: JSON_RPC_ERRORS.INTERNAL_ERROR, message: `响应序列化失败：${err.message}` },
      })}\n`;
    }
    // 串行化写入，避免多条消息交错
    this._writeChain = this._writeChain.then(
      () =>
        new Promise((resolve) => {
          this._output.write(line, () => resolve());
        }),
    );
  }
}

module.exports = {
  RpcPeer,
  RpcError,
  GameError,
  NotConnectedError,
  TimeoutError,
  CancelledError,
  JSON_RPC_ERRORS,
};
