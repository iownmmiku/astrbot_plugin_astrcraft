'use strict';
/**
 * 跟随的平滑度验证。
 *
 * 用户的原话是"**跟着我的时候是一顿一顿地动**"。
 * 根因：早期实现每 600ms 就 `pathfinder.setGoal(new GoalFollow(...), true)`，
 * 每次重设都会让 pathfinder 停下手上的移动、重算路径、再重新起步——
 * 走两步停一下，看着非常机械。
 *
 * 现在改成"持续朝目标走"（真人跟人的方式）。这个测试用**逐帧采样位置**来量化：
 *   1. 跟随过程中她应该**一直在动**（连续帧之间位置在变）
 *   2. 不该出现"停顿"（连续多帧位置几乎不变）
 *   3. 走近了应该停下（保持距离，不会撞上来）
 *   4. 目标走远了她应该跟上
 *
 * 用法：node tools/test_follow_smooth.js
 * 需要测试服在 25566 上运行。
 */

const { spawn } = require('child_process');
const path = require('path');
const { Rcon } = require('./lib/rcon');

const PORT = Number(process.env.MC_PORT || 25566);
const BOT = 'FollowBot' + Math.floor(Math.random() * 9000);
const WALKER = 'Walker' + Math.floor(Math.random() * 9000);

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

/** 高频采样她的位置 */
async function sample(ms) {
  const out = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await call('state.get', { detail: 'brief' });
    out.push({ t: Date.now() - t0, x: st.position.x, y: st.position.y, z: st.position.z });
    await sleep(60);
  }
  return out;
}

(async () => {
  const rcon = Rcon.fromDir('.testserver', 25576);
  console.log('=== 跟随平滑度验证 ===\n');

  // 目标必须是一个**真实玩家**（和用户的场景一致）。
  // 早期我用 RCON summon 的猪 + 自定义名当目标——但 mineflayer 不把自定义名
  // 暴露成 entity.name，所以"跟随 walker"根本找不到目标，测试因此假失败。
  const mineflayer = require('mineflayer');
  const walker = mineflayer.createBot({
    host: '127.0.0.1',
    port: PORT,
    version: '1.20.1',
    username: WALKER,
    auth: 'offline',
    hideErrors: true,
  });
  await new Promise((resolve, reject) => {
    walker.once('spawn', resolve);
    walker.once('error', reject);
    setTimeout(() => reject(new Error('walker 进服超时')), 30000);
  });
  console.log(`  假玩家 ${WALKER} 已进服`);

  // 铺一小块平地，避免地形干扰平滑度测量
  await rcon.command('fill -20 -61 -20 40 -61 20 minecraft:grass_block replace air').catch(() => {});
  await rcon.command('fill -20 -60 -20 40 -55 20 minecraft:air replace').catch(() => {});

  await call('connect', { host: '127.0.0.1', port: PORT, version: '1.20.1', username: BOT }, 60000);
  await sleep(5000);
  await rcon.command(`tp ${BOT} 0 -60 0`);
  await rcon.command(`tp ${WALKER} 4 -60 0`);
  await sleep(1500);

  const st0 = await call('state.get', { detail: 'brief' });
  console.log(`她的位置 (${st0.block_position.x}, ${st0.block_position.y}, ${st0.block_position.z})，${WALKER} 在 4 格外`);

  console.log('\n[1] 起一个跟随任务，让假玩家持续走 6 秒，采样她的位置');
  const r = await call('move.follow', { target: WALKER, distance: 3 }, 30000);
  console.log(`    任务号 ${r.task_id}`);
  await sleep(800);

  // 让假玩家持续往前走（不是瞬移——瞬移测不出平滑度）
  walker.setControlState('forward', true);
  const s1 = await sample(6000);
  walker.setControlState('forward', false);

  // 逐帧位移
  const deltas = [];
  for (let i = 1; i < s1.length; i += 1) {
    deltas.push(Math.hypot(s1[i].x - s1[i - 1].x, s1[i].z - s1[i - 1].z));
  }
  const moving = deltas.filter((d) => d > 0.02).length;
  const still = deltas.filter((d) => d <= 0.02).length;
  console.log(`    采样 ${deltas.length} 帧：移动 ${moving} 帧，静止 ${still} 帧`);
  const sorted = deltas.slice().sort((a, b) => a - b);
  console.log(`    单帧位移 最大 ${Math.max(...deltas).toFixed(3)} 格，中位 ${sorted[Math.floor(sorted.length / 2)].toFixed(3)} 格`);

  // 最长的"连续静止"长度——这就是"一顿一顿"的量化指标
  let maxStillRun = 0;
  let run = 0;
  for (const d of deltas) {
    if (d <= 0.02) {
      run += 1;
      maxStillRun = Math.max(maxStillRun, run);
    } else {
      run = 0;
    }
  }
  console.log(`    最长连续静止 ${maxStillRun} 帧（约 ${(maxStillRun * 0.06).toFixed(2)} 秒）`);

  // 判定标准说明：
  // 允许一段静止——她追上目标后会停下等，目标拉开再跟上，
  // 真人跟着你走也是这样（不是"一顿一顿"，而是"跟上了就停"）。
  // 真正要排除的是**旧实现那种"几乎不动 / 每 600ms 停一次"**：
  // 旧实现实测是 0/87 帧在动。
  if (moving >= deltas.length * 0.6 && maxStillRun <= 22) {
    ok('跟随是连续的（大部分帧都在动，停下只是追上后的等待）', `移动 ${moving}/${deltas.length} 帧，最长静止 ${maxStillRun} 帧`);
  } else {
    bad('跟随仍有明显停顿', `移动 ${moving}/${deltas.length} 帧，最长静止 ${maxStillRun} 帧`);
  }

  // 单帧位移不该有大跳（大跳说明是"停下再冲"，不是连续走）
  const bigJumps = deltas.filter((d) => d > 0.8).length;
  if (bigJumps <= 1) {
    ok('没有"停下再猛冲"的跳变', `最大 ${Math.max(...deltas).toFixed(3)} 格`);
  } else {
    bad('存在位移跳变（一顿一顿的特征）', `${bigJumps} 帧超过 0.8 格`);
  }

  console.log('\n[2] 目标走远，她应该跟上');
  await rcon.command(`tp ${WALKER} 14 -60 0`);
  await sleep(6000);
  const st2 = await call('state.get', { detail: 'brief' });
  const d2 = Math.hypot(st2.position.x - 14, st2.position.z - 0);
  console.log(`    她距目标 ${d2.toFixed(1)} 格`);
  if (d2 < 9) {
    ok('目标走远后她跟上来了', `距目标 ${d2.toFixed(1)} 格`);
  } else {
    bad('目标走远后她没跟上', `仍距 ${d2.toFixed(1)} 格`);
  }

  console.log('\n[3] 贴近后应该站住（不撞上来、不抖动）');
  await rcon.command(`tp ${WALKER} ${Math.round(st2.position.x) + 2} -60 ${Math.round(st2.position.z)}`);
  await sleep(3000);
  const s3 = await sample(3000);
  const near = [];
  for (let i = 1; i < s3.length; i += 1) {
    near.push(Math.hypot(s3[i].x - s3[i - 1].x, s3[i].z - s3[i - 1].z));
  }
  const jitter = near.filter((d) => d > 0.2).length;
  const st3 = await call('state.get', { detail: 'brief' });
  const d3 = Math.hypot(st3.position.x - (Math.round(st2.position.x) + 2), st3.position.z - Math.round(st2.position.z));
  console.log(`    距目标 ${d3.toFixed(1)} 格，3 秒内抖动帧 ${jitter}`);
  if (jitter <= 4) {
    ok('贴近后基本站住（没有在临界距离上抖）', `抖动 ${jitter} 帧`);
  } else {
    bad('贴近后仍在抖', `${jitter} 帧位移 > 0.2 格`);
  }

  console.log('\n[4] 停止跟随');
  await call('task.cancel', { task_id: r.task_id }).catch(() => {});
  await sleep(1500);
  const s4 = await sample(2000);
  let afterMove = 0;
  for (let i = 1; i < s4.length; i += 1) {
    if (Math.hypot(s4[i].x - s4[i - 1].x, s4[i].z - s4[i - 1].z) > 0.05) afterMove += 1;
  }
  if (afterMove === 0) {
    ok('叫停后真的停住了', '');
  } else {
    bad('叫停后还在动', `${afterMove} 帧在动`);
  }

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  try {
    walker.quit();
  } catch {
    /* ignore */
  }
  rcon.close();
  await call('disconnect').catch(() => {});
  await sleep(300);
  child.kill();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  child.kill();
  process.exit(1);
});
