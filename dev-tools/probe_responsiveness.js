'use strict';
/**
 * 引擎响应性探针：长任务运行时，其它 RPC 还能不能及时响应。
 *
 * 为什么专门测这个：实测在砍树/挖矿这类长任务跑起来后，
 * `safety.stop`（急停）和 `dig` 会 15~45 秒不响应。
 * 对用户来说这是"她在干活时你既问不到状态、也喊不停她"，
 * 属于体验上的硬伤。这里用数据定位：是事件循环被卡住，还是某个调用本身慢。
 */

const { spawn } = require('child_process');
const path = require('path');
const { Rcon } = require('./lib/rcon');

const PORT = 25566;

class C {
  constructor() {
    this.child = spawn(process.execPath, [path.join(__dirname, '..', 'engine', 'index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MC_ENGINE_LOG_LEVEL: 'warn' },
    });
    this.buf = '';
    this.id = 1;
    this.pending = new Map();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c) => {
      this.buf += c;
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
        if (m.method === 'notice') continue;
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error.message));
          else p.resolve(m.result);
        }
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => { const s=String(c); if (/阻塞|阻塞约/.test(s)) console.log('    [引擎] ' + s.trim()); });
  }
  call(method, params = {}, t = 60000) {
    const id = this.id++;
    return new Promise((res, rej) => {
      const tm = setTimeout(() => rej(new Error('rpc-timeout')), t);
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

async function timed(c, method, params = {}, t = 60000) {
  const t0 = Date.now();
  try {
    await c.call(method, params, t);
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.message };
  }
}

(async () => {
  const rcon = Rcon.fromDir('.testserver', 25576);
  const c = new C();
  // spawnProtectionRadius: 0 —— 这个测试要在出生点附近挖方块；生产默认是 16（保护出生点），
  // 不显式关掉的话 dig 会被「出生点保护拦截」拒绝，测试会误报失败。
  await c.call('connect', { host: '127.0.0.1', port: PORT, version: '1.20.1', username: 'AstrBotResp', spawnProtectionRadius: 0 }, 60000);
  await sleep(4000);

  console.log('=== 空闲时的响应延迟（基线）===');
  for (const m of ['ping', 'status', 'task.list', 'inventory.get', 'state.get']) {
    const r = await timed(c, m, {}, 20000);
    console.log(`  ${m.padEnd(16)} ${r.ok ? r.ms + 'ms' : '✗ ' + r.ms + 'ms ' + r.err}`);
  }

  // 给点材料让它有活干，并造一片"找不到目标的森林"让它持续找
  const me = 'AstrBotResp';
  await rcon.command(`give ${me} oak_log 8`);
  await rcon.command(`give ${me} cobblestone 16`);
  await sleep(1500);

  console.log('\n=== 起一个长任务（找不到目标的砍树，会持续寻路）===');
  const r = await c.call('skill.run', { skill: 'chop_tree', params: { count: 8 } });
  console.log('  任务号:', r.task_id);
  await sleep(3000); // 让它真正跑起来

  console.log('\n=== 长任务运行中的响应延迟 ===');
  for (let i = 0; i < 6; i++) {
    const results = [];
    for (const m of ['ping', 'status', 'task.list']) {
      const rr = await timed(c, m, {}, 30000);
      results.push(`${m}=${rr.ok ? rr.ms + 'ms' : '✗' + rr.ms + 'ms'}`);
    }
    console.log(`  第 ${i + 1} 轮: ${results.join('  ')}`);
    await sleep(2000);
  }

  console.log('\n=== 关键：急停能不能及时生效 ===');
  const stop = await timed(c, 'safety.stop', {}, 30000);
  console.log(`  safety.stop: ${stop.ok ? stop.ms + 'ms ✅' : '✗ ' + stop.ms + 'ms ' + stop.err}`);
  await sleep(2000);
  const after = await timed(c, 'task.list', {}, 20000);
  console.log(`  急停后的 task.list: ${after.ok ? after.ms + 'ms' : '✗ ' + after.ms + 'ms'}`);

  console.log('\n=== 急停后是否真的停了 ===');
  const st = await c.call('task.list', {}, 20000);
  console.log('  current:', st.current ? st.current.name : '无', '| queued:', (st.queued || []).length);

  rcon.close();
  await c.call('disconnect').catch(() => {});
  await sleep(500);
  c.kill();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
