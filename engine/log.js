'use strict';
/**
 * 日志：一律写 stderr。
 *
 * 为什么单独一个文件：stdout 是 NDJSON 协议通道，任何一行多余的输出
 * （包括 mineflayer 内部的 console.log）都会让插件侧解析失败。
 * 所以这里同时劫持 console.log/info/warn，把误用引到 stderr，避免整条链路被一行日志毁掉。
 *
 * 日志会脱敏：服务器地址、账号名在日志里做掩码，方便把日志直接贴给别人看。
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const levelName = (process.env.MC_ENGINE_LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[levelName] ?? LEVELS.info;

const secrets = new Set();

/** 注册需要在日志中掩码的敏感串（账号名、服务器地址） */
function addSecret(value) {
  if (value && String(value).length >= 3) secrets.add(String(value));
}

function mask(text) {
  let out = String(text);
  for (const s of secrets) {
    out = out.split(s).join(s.length <= 3 ? '***' : `${s.slice(0, 2)}***${s.slice(-1)}`);
  }
  return out;
}

function emit(level, args) {
  if (LEVELS[level] > threshold) return;
  const time = new Date().toISOString().slice(11, 23);
  const parts = args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) {
      try {
        return JSON.stringify(a);
      } catch {
        return '[无法序列化的对象]';
      }
    }
    return String(a);
  });
  try {
    process.stderr.write(`[${time}] ${level.toUpperCase().padEnd(5)} ${mask(parts.join(' '))}\n`);
  } catch {
    /* stderr 已关闭时静默，不能让日志把进程弄崩 */
  }
}

const logger = {
  error: (...a) => emit('error', a),
  warn: (...a) => emit('warn', a),
  info: (...a) => emit('info', a),
  debug: (...a) => emit('debug', a),
  addSecret,
  mask,
};

// 把 console 的胡乱输出重定向到 stderr，保护 stdout 协议流
for (const method of ['log', 'info', 'warn', 'error', 'trace']) {
  console[method] = (...a) => emit(method === 'trace' ? 'debug' : method, a);
}

module.exports = logger;
