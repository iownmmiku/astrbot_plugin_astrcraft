'use strict';
/**
 * 真实环境回归：**在用户自己的服务器上跑**，而不是我的超平坦测试服。
 *
 * ## 为什么必须做这一步
 *
 * 前面所有测试都在我的超平坦测试世界里跑：地面平整、没有树、没有峡谷、
 * 没有玩家建筑。而用户的服务器是正常地形——这一点反复咬过我：
 *   - "隔着墙挖"只在真实地形里出现
 *   - "被自己封在洞里"只在真实挖矿里出现
 *   - 寻路在陡峭地形上的表现完全不同
 *
 * ## 这个脚本只读不写
 *
 * 只连接、观察、走路、量阻塞——**不挖方块、不放方块**，避免动到用户的世界。
 * 用户名带 `Regress` 前缀，跑完立刻断开。
 *
 * 用法：node tools/regress_real.js [端口]
 */

const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.argv[2] || process.env.MC_REAL_PORT || 25565);
const USER = 'Regress' + Math.floor(Math.random() * 9000);

let pass = 0;
let fail = 0;
const ok = (m, d = '') => {
  pass += 1;
  console.log(`  ✅ ${m}${d ? ` — ${d}` : ''}`);
};
const bad = (m, d = '') => {
  fail += 1;
  console.log(`  ❌ ${m}${d ? ` — ${d}` : ''}`);
};

const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MC_ENGINE_LOG_LEVEL: 'info' },
});
let buf = '';
let id = 1;
const pending = new Map();
const logs = [];
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!l) continue;
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      continue;
    }
    if (m.method === 'notice') continue;
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => logs.push(String(c)));
const call = (m, p = {}, t = 120000) =>
  new Promise((res, rej) => {
    const i = id++;
    const tm = setTimeout(() => rej(new Error('timeout ' + m)), t);
    pending.set(i, {
      resolve: (v) => {
        clearTimeout(tm);
        res(v);
      },
      reject: (e) => {
        clearTimeout(tm);
        rej(e);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method: m, params: p }) + '\n');
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 量一次操作的耗时与期间的事件循环阻塞 */
async function probe(label, fn) {
  const mark = logs.join('').length;
  const t0 = Date.now();
  let err = '';
  try {
    await fn();
  } catch (e) {
    err = e.message.slice(0, 60);
  }
  await sleep(500);
  const chunk = logs.join('').slice(mark);
  const blocks = [...chunk.matchAll(/阻塞约 ([\d.]+) 秒/g)].map((m) => Number(m[1]));
  const worst = blocks.length ? Math.max(...blocks) : 0;
  console.log(`    ${label.padEnd(26)} ${String(Date.now() - t0).padStart(6)}ms  阻塞${blocks.length}次 最长${worst.toFixed(1)}s ${err ? '| ' + err : ''}`);
  return { ms: Date.now() - t0, blocks: blocks.length, worst };
}

(async () => {
  console.log(`=== 真实环境回归（你的服务器 127.0.0.1:${PORT}）===\n`);
  try {
    await call('connect', { host: '127.0.0.1', port: PORT, version: '1.20.1', username: USER }, 60000);
  } catch (e) {
    console.log(`  ❌ 连不上你的服务器：${e.message}`);
    console.log('     （服务器没开？或者版本不是 1.20.1？）');
    child.kill();
    process.exit(1);
  }
  await sleep(6000);

  const st = await call('state.get', { detail: 'brief' });
  const p = st.block_position;
  console.log(`  进服成功：位置 (${p.x}, ${p.y}, ${p.z})，血量 ${st.health}，饱食 ${st.food}`);
  console.log(`  环境：光照 ${st.light}｜脚下 ${st.standing_on || '?'}｜维度 ${st.dimension || '?'}`);
  ok('能连上你的服务器并读到状态');

  console.log('\n[1] 只读操作（不该有任何阻塞）');
  const r1 = await probe('state.get brief', () => call('state.get', { detail: 'brief' }));
  const r2 = await probe('inventory.get', () => call('inventory.get'));
  const r3 = await probe('entity.scan', () => call('entity.scan', { radius: 24, limit: 20 }));
  const r4 = await probe('status.diagnose', () => call('status.diagnose'));
  const readWorst = Math.max(r1.worst, r2.worst, r3.worst, r4.worst);
  if (readWorst < 1.5) ok('只读操作不阻塞引擎', `最长 ${readWorst.toFixed(1)}s`);
  else bad('只读操作仍在阻塞', `最长 ${readWorst.toFixed(1)}s`);

  console.log('\n[2] 扫描（真实地形里的树/石头密度完全不同）');
  const s1 = await probe('scan oak_log r16', () => call('block.scan', { names: ['oak_log'], radius: 16, limit: 20 }));
  const s2 = await probe('scan stone r16', () => call('block.scan', { names: ['stone'], radius: 16, limit: 20 }));
  const s3 = await probe('scan diamond r16(可能没有)', () => call('block.scan', { names: ['diamond_ore'], radius: 16, limit: 20 }));
  const scanWorst = Math.max(s1.worst, s2.worst, s3.worst);
  if (scanWorst < 2.5) ok('扫描不会把引擎卡住', `最长 ${scanWorst.toFixed(1)}s`);
  else bad('扫描仍在卡引擎', `最长 ${scanWorst.toFixed(1)}s`);

  console.log('\n[3] 真实地形寻路（测试服是超平坦，这里才是真的）');
  const route = await call('route.plan', { x: p.x + 40, z: p.z }, 30000);
  console.log(`    路线计划：${String(route.verdict).slice(0, 90)}`);
  const m1 = await probe('move.to 走 20 格', async () => {
    const r = await call('move.to', { x: p.x + 20, z: p.z, timeout_ms: 45000 });
    for (let i = 0; i < 35; i += 1) {
      await sleep(1300);
      const t = await call('task.status', { task_id: r.task_id });
      if (['done', 'failed', 'cancelled'].includes(t.status)) {
        console.log(`      结果：${t.status} ${(t.error || '').slice(0, 70)}`);
        return;
      }
    }
  });
  const after = await call('state.get', { detail: 'brief' });
  const moved = Math.hypot(after.position.x - p.x, after.position.z - p.z);
  console.log(`    实际移动 ${moved.toFixed(1)} 格`);
  if (moved >= 8) ok('在真实地形里能走起来', `移动了 ${moved.toFixed(1)} 格`);
  else bad('真实地形里走不动', `只移动 ${moved.toFixed(1)} 格`);
  if (m1.worst < 2.5) ok('走路时引擎不被卡住', `最长 ${m1.worst.toFixed(1)}s`);
  else bad('走路时引擎被卡住', `最长 ${m1.worst.toFixed(1)}s`);

  console.log('\n[4] 诊断视图在你的环境里是否可用');
  const d = await call('status.diagnose', {}, 20000);
  ok('诊断视图可用', `结论：${String(d.verdict).slice(0, 60)}`);

  const totalBlocks = logs.join('').split('\n').filter((l) => /阻塞约/.test(l)).length;
  console.log(`\n=== 全程事件循环阻塞：${totalBlocks} 次 ===`);
  if (totalBlocks === 0) ok('整个回归过程零阻塞');
  else bad(`过程中有 ${totalBlocks} 次阻塞`);

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  await call('disconnect').catch(() => {});
  await sleep(400);
  child.kill();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  child.kill();
  process.exit(1);
});
