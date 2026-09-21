'use strict';
/**
 * 真实生存链测试（M2 最终验收）。
 *
 * 场景：丛林服务器，机器人空手出生。
 * 验证：砍树拿到原木 → 合成木板/木棍/工作台 → 做出石制工具 → 挖到圆石。
 *
 * 这是"像正常玩家一样游玩"的最小完整闭环。全部由技能自主完成，
 * 中途需要自己下树冠、找树、挖方块、捡掉落物、处理合成依赖。
 *
 * 用法：node tools/survivaltest.js [--port 25565] [--tier stone]
 */

const { spawn } = require('child_process');
const path = require('path');

const argPort = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 25565;
const TIER = process.argv.includes('--tier') ? process.argv[process.argv.indexOf('--tier') + 1] : 'stone';
const VERSION = '1.20.1';

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

class Client {
  constructor() {
    this.child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MC_ENGINE_LOG_LEVEL: 'info' },
    });
    this.buf = '';
    this.id = 1;
    this.pending = new Map();
    this.stderr = [];
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c) => this._onData(c));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => {
      this.stderr.push(c);
      if (this.stderr.length > 200) this.stderr.shift();
    });
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
      if (m.method === 'notice') continue;
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
        else p.resolve(m.result);
      }
    }
  }

  call(method, params = {}, timeoutMs = 120000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
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

async function runSkill(c, skill, params, timeoutSec) {
  process.stdout.write(`\n▶ ${skill} ${JSON.stringify(params)}\n`);
  let taskId;
  try {
    const r = await c.call('skill.run', { skill, params });
    taskId = r.task_id;
  } catch (err) {
    return { ok: false, error: `提交失败：${err.message}` };
  }
  const start = Date.now();
  let last = '';
  for (let i = 0; i < timeoutSec * 2; i += 1) {
    await sleep(500);
    let st;
    try {
      st = await c.call('task.status', { task_id: taskId }, 20000);
    } catch (err) {
      return { ok: false, error: `状态查询失败：${err.message}` };
    }
    const d = st.detail || st.progress || '';
    if (d && d !== last) {
      last = d;
      process.stdout.write(`    · ${d}\n`);
    }
    if (['done', 'failed', 'cancelled'].includes(st.status)) {
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      process.stdout.write(`    → ${st.status}（${secs}s）${st.error ? ` 错误：${st.error}` : ''}\n`);
      return { ok: st.status === 'done', status: st.status, error: st.error, result: st.result, seconds: Number(secs) };
    }
  }
  await c.call('task.cancel', { task_id: taskId }).catch(() => {});
  return { ok: false, error: `超时（${timeoutSec}s）` };
}

async function inv(c) {
  const r = await c.call('inventory.get');
  return r.items || {};
}

async function main() {
  const t0 = Date.now();
  console.log('=== 真实生存链测试（M2 验收）===');
  console.log(`服务器 ${argPort}，目标工具等级：${TIER}\n`);

  const c = new Client();
  await c.call('connect', { host: '127.0.0.1', port: argPort, version: VERSION, username: 'AstrBotSurv' }, 60000);
  await sleep(5000);

  const st0 = await c.call('state.get', { detail: 'brief' });
  console.log(`出生点 ${JSON.stringify(st0.position)}，脚下 ${st0.standing_on}`);
  const inv0 = await inv(c);
  console.log(`初始背包：${JSON.stringify(inv0)}`);

  // ---- 1. 砍树
  console.log('\n──── 1. 砍树（chop_tree）────');
  const r1 = await runSkill(c, 'chop_tree', { count: 6 }, 300);
  const inv1 = await inv(c);
  const logs = Object.entries(inv1)
    .filter(([k]) => k.endsWith('_log') || k.endsWith('_stem'))
    .reduce((s, [, v]) => s + v, 0);
  check('砍到原木', logs > 0, `原木 ${logs} 根${r1.ok ? '' : `（技能报告：${r1.error || r1.result?.reason}）`}`);
  check('砍树如实报告结果', r1.ok || !!(r1.error || r1.result?.reason), r1.ok ? r1.result?.note || '成功' : r1.error || r1.result?.reason);

  // ---- 2. 做工具（依赖链：木板 → 木棍 → 工作台 → 工具）
  console.log(`\n──── 2. 做${TIER}工具（make_tools）────`);
  const r2 = await runSkill(c, 'make_tools', { tier: TIER }, 600);
  const inv2 = await inv(c);
  const pickaxes = Object.keys(inv2).filter((k) => k.endsWith('_pickaxe'));
  check(
    '做出镐子',
    pickaxes.length > 0,
    pickaxes.length ? pickaxes.join('、') : `没有镐（技能报告：${r2.error || r2.result?.reason}）`,
  );
  check(
    '做工具如实报告结果',
    r2.ok || !!(r2.error || r2.result?.reason),
    r2.ok ? r2.result?.note || '成功' : r2.error || r2.result?.reason,
  );

  // ---- 3. 用工具挖矿（验证工具有效性：有镐才能高效挖石头）
  console.log('\n──── 3. 挖石头（mine_stone）────');
  const r3 = await runSkill(c, 'mine_stone', { count: 10 }, 300);
  const inv3 = await inv(c);
  check(
    '挖到圆石',
    (inv3.cobblestone || 0) > 0,
    `圆石 ${inv3.cobblestone || 0} 个${r3.ok ? '' : `（技能报告：${r3.error || r3.result?.reason}）`}`,
  );

  // ---- 4. 统计
  const invFinal = await inv(c);
  const st = await c.call('status');
  console.log('\n最终背包：', JSON.stringify(invFinal));
  console.log('任务统计：', JSON.stringify(st.stats));

  await c.call('safety.stop').catch(() => {});
  await c.call('disconnect').catch(() => {});
  await sleep(600);
  c.kill();

  console.log('\n=== 结果 ===');
  console.log(results.join('\n'));
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  if (fail > 0) {
    console.log('\n--- 引擎日志末尾 ---');
    console.log(c.stderr.join('').split('\n').slice(-25).join('\n'));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('测试脚本出错：', err);
  process.exit(2);
});
