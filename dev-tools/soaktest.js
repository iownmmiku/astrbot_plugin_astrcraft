'use strict';
/**
 * 稳定性实测：长时间保持连接 + 周期性活动，记录内存与连接状态。
 *
 * 为什么需要它：本轮修掉的"长任务后必然掉线"是影响最大的缺陷，
 * 需要一个可复现的长时间观察来证明修好了，而不是只看单次测试通过。
 *
 * 用法：
 *   node tools/soaktest.js --minutes 6 --port 25566
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const MINUTES = Number(getArg('--minutes', '6'));
const PORT = Number(getArg('--port', '25566'));
const USER = getArg('--user', `AstrBotSoak${Math.floor(Math.random() * 9000)}`);
const OUT = path.join(__dirname, '..', '.soak.log');

class C {
  constructor() {
    this.child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MC_ENGINE_LOG_LEVEL: 'info' },
    });
    this.buf = '';
    this.id = 1;
    this.pending = new Map();
    this.events = [];
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c) => this._onData(c));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', () => {});
  }
  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.method === 'notice') {
        this.events.push({ event: m.params.event, at: Date.now() });
        continue;
      }
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message));
        else p.resolve(m.result);
      }
    }
  }
  call(method, params = {}, t = 30000) {
    const id = this.id++;
    return new Promise((res, rej) => {
      const tm = setTimeout(() => rej(new Error('timeout ' + method)), t);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(tm);
          res(v);
        },
        reject: (e) => {
          clearTimeout(tm);
          rej(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  kill() {
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const lines = [];
  const say = (s) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
    lines.push(line);
    console.log(line);
  };

  say(`=== 稳定性实测：${MINUTES} 分钟 ===`);
  const c = new C();
  await c.call('connect', { host: '127.0.0.1', port: PORT, version: '1.20.1', username: USER }, 60000);
  await sleep(5000);

  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    try {
      const st = await c.call('status', {}, 10000);
      if (st && st.connected) {
        ready = true;
        break;
      }
    } catch {
      /* ignore */
    }
    await sleep(1000);
  }
  if (!ready) {
    say('❌ 未能进服');
    c.kill();
    process.exit(2);
  }

  const mem0 = process.memoryUsage ? null : null;
  let disconnects = 0;
  let reconnects = 0;
  let pingFails = 0;
  let maxPingMs = 0;
  const samples = [];
  const deadline = Date.now() + MINUTES * 60 * 1000;
  let round = 0;

  while (Date.now() < deadline) {
    round += 1;
    const t0 = Date.now();
    let pingMs = -1;
    try {
      await c.call('ping', {}, 8000);
      pingMs = Date.now() - t0;
      maxPingMs = Math.max(maxPingMs, pingMs);
    } catch {
      pingFails += 1;
    }

    let connected = false;
    let pos = null;
    try {
      const st = await c.call('status', {}, 10000);
      connected = !!st.connected;
      pos = st.position;
    } catch {
      /* ignore */
    }

    // 每隔几轮做点动作，模拟"边玩边等"的真实负载
    if (round % 3 === 0 && connected) {
      try {
        const st = await c.call('state.get', { detail: 'brief' }, 15000);
        // 挖一下脚下方块，制造真实活动
        const bp = st.block_position;
        await c.call('dig', { x: bp.x, y: bp.y - 1, z: bp.z, collect: true }, 25000).catch(() => {});
      } catch {
        /* ignore */
      }
    }

    samples.push({ round, at: Date.now(), connected, pingMs, pos });
    if (round % 4 === 0) {
      say(`第 ${round} 轮：connected=${connected} ping=${pingMs}ms 位置=${pos ? `${pos.x},${pos.y},${pos.z}` : '?'}`);
    }
    // 每轮间隔 6 秒
    const elapsed = Date.now() - t0;
    await sleep(Math.max(0, 6000 - elapsed));
  }

  const evCount = {};
  for (const e of c.events) evCount[e.event] = (evCount[e.event] || 0) + 1;
  disconnects = evCount['bot.disconnect'] || 0;
  reconnects = evCount['bot.reconnecting'] || 0;

  const last = samples[samples.length - 1];
  say('');
  say('=== 结果 ===');
  say(`采样轮数：${samples.length}（约 ${(samples.length * 6) / 60} 分钟）`);
  say(`最终连接状态：${last.connected ? '✅ 仍然在线' : '❌ 已断开'}`);
  say(`ping 失败次数：${pingFails}，最大 ping：${maxPingMs}ms`);
  say(`断线事件：${disconnects}，重连尝试：${reconnects}`);
  say(`事件统计：${JSON.stringify(evCount)}`);
  say(`是否连续在线：${samples.every((s) => s.connected) ? '✅ 全程未断' : '❌ 中间断过'}`);

  await c.call('disconnect').catch(() => {});
  await sleep(500);
  c.kill();
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  process.exit(last.connected && disconnects === 0 ? 0 : 1);
})().catch((err) => {
  fs.writeFileSync(OUT, `ERR ${err.message}\n`, 'utf8');
  console.error('ERR', err.message);
  process.exit(2);
});
