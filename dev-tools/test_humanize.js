'use strict';
/**
 * 拟人化动作的验证：转头必须是**渐进的**，而不是瞬间跳过去。
 *
 * 为什么专门测这个：
 *   mineflayer 的 `bot.look(yaw, pitch, force)` **一次就把整个角度转完**，
 *   force 只影响"是否等服务器确认"，不会让它渐进旋转。
 *   所以"像人一样转头"必须自己插值——而这类表现层代码很容易在后续重构中被
 *   某个 `bot.look(..., true)` 悄悄绕过（我们代码里原本就有 6 处）。
 *   这个测试用"采样中间角度"的方式把它钉住。
 *
 * 用法：node tools/test_humanize.js
 * 需要测试服在 25566 上运行。
 */

const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.MC_PORT || 25566);
const USER = 'Human' + Math.floor(Math.random() * 9000);

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

const child = spawn(process.execPath, [path.join(__dirname, '..', 'engine', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MC_ENGINE_LOG_LEVEL: 'warn' },
});
let buf = '';
let id = 1;
const pending = new Map();
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
child.stderr.on('data', () => {});
const call = (m, p = {}, t = 60000) =>
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

/** 命令转到一个角度，同时高频采样 yaw，返回采样序列 */
async function turnAndSample(targetYawDeg) {
  const samples = [];
  const done = call('move.look', { yaw: (targetYawDeg * Math.PI) / 180, pitch: 0 });
  const t0 = Date.now();
  while (Date.now() - t0 < 700) {
    try {
      const st = await call('state.get', { detail: 'brief' });
      samples.push(st.yaw);
    } catch {
      /* ignore */
    }
    await sleep(18);
  }
  await done.catch(() => {});
  // 去掉重复值（同一角度被采样多次不算"渐进"）
  const uniq = [];
  for (const y of samples) {
    if (!uniq.length || Math.abs(y - uniq[uniq.length - 1]) > 0.5) uniq.push(y);
  }
  return uniq;
}

(async () => {
  console.log('=== 拟人化动作验证 ===\n');
  await call('connect', { host: '127.0.0.1', port: PORT, version: '1.20.1', username: USER }, 60000);
  await sleep(5000);

  // ---- 1. 开启拟人化：转 150°，应该能看到多个中间角度
  console.log('[1] 拟人化开启：转 150°');
  await call('config.update', { humanize: true });
  const yaw0 = (await call('state.get', { detail: 'brief' })).yaw;
  const smooth = await turnAndSample(yaw0 + 150);
  console.log(`    采样到的不同角度: ${smooth.length} 个 → ${smooth.map((y) => y.toFixed(0)).join('° → ')}°`);
  if (smooth.length >= 3) {
    ok('转头是渐进的（采到多个中间角度）', `${smooth.length} 个中间态`);
  } else {
    bad('转头是瞬间的（只采到 1-2 个角度）', `${smooth.length} 个`);
  }

  // ---- 2. 关闭拟人化：同样转 150°，应该几乎一步到位
  console.log('\n[2] 拟人化关闭：转 150°（对照组）');
  await call('config.update', { humanize: false });
  const yaw1 = (await call('state.get', { detail: 'brief' })).yaw;
  const instant = await turnAndSample(yaw1 + 150);
  console.log(`    采样到的不同角度: ${instant.length} 个`);
  if (instant.length <= smooth.length) {
    ok('关闭后确实更"硬"（中间态不多于开启时）', `${instant.length} vs ${smooth.length}`);
  } else {
    bad('关闭拟人化后反而更渐进（开关没生效？）', `${instant.length} vs ${smooth.length}`);
  }
  await call('config.update', { humanize: true });

  // ---- 3. 单元测试：步态与角度环绕（直接 require，不走 RPC）
  console.log('\n[3] 步态随机性（同一距离不该总是同一个决策）');
  const { Gait, WalkGaze, shortestAngle } = require('../engine/humanize');
  const gait = new Gait();
  const far = new Set();
  for (let i = 0; i < 300; i += 1) far.add(gait.shouldSprint(20));
  if (far.size === 2) {
    ok('远距离的冲刺决策有随机性（不是恒定值）', `出现过 ${[...far].join(' 和 ')}`);
  } else {
    bad('远距离的冲刺决策是恒定的', `只有 ${[...far].join(',')}`);
  }
  const near = new Set();
  for (let i = 0; i < 100; i += 1) near.add(gait.shouldSprint(2));
  if (near.size === 1 && near.has(false)) {
    ok('近距离从不冲刺（真人走近了会放慢）', '始终 false');
  } else {
    bad('近距离仍会冲刺', `出现 ${[...near].join(',')}`);
  }

  console.log('\n[4] 角度环绕与扫视幅度');
  const wrap = shortestAngle(3.0, -3.0); // 跨 ±π
  if (Math.abs(wrap) < Math.PI) {
    ok('转最短方向（不会绕一大圈）', `3.0 → -3.0 的差值 ${wrap.toFixed(2)} 弧度`);
  } else {
    bad('角度差没有取最短路径', `${wrap.toFixed(2)}`);
  }
  const gaze = new WalkGaze({ amplitude: 0.14 });
  const offsets = [];
  for (let i = 0; i < 5; i += 1) offsets.push(gaze.offset());
  if (offsets.every((o) => Math.abs(o) <= 0.15)) {
    ok('走路扫视幅度很小（不会把身体带偏）', `最大 ${Math.max(...offsets.map(Math.abs)).toFixed(3)} 弧度`);
  } else {
    bad('走路扫视幅度过大', `最大 ${Math.max(...offsets.map(Math.abs)).toFixed(3)}`);
  }

  // ---- 5. 配置开关可下发
  const upd = await call('config.update', { humanize: true });
  if (upd && upd.config && upd.config.humanize === true) {
    ok('humanize 配置项已注册且可下发', `humanize=${upd.config.humanize}`);
  } else {
    bad('humanize 配置项不可下发', JSON.stringify(upd && upd.config ? upd.config.humanize : upd));
  }

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  await call('disconnect').catch(() => {});
  await sleep(300);
  child.kill();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  child.kill();
  process.exit(1);
});
