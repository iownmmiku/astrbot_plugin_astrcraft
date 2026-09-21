'use strict';
/**
 * 寻路压力测试：把"走路"会遇到的典型地形逐个摆出来，看哪些过不去。
 *
 * 为什么要这么测：用户反馈"寻路机制也有问题"，但"有问题"太笼统。
 * 寻路的失败模式有好几种（绕不过障碍、爬不上台阶、卡在角落、掉进坑里出不来），
 * 必须逐个场景量化，才知道到底坏在哪一环。
 *
 * 用法：node tools/test_pathfinding.js
 */

const { spawn } = require('child_process');
const path = require('path');
const { Rcon } = require('./lib/rcon');

const PORT = Number(process.env.MC_PORT || 25566);
const USER = 'Path' + Math.floor(Math.random() * 9000);

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
const call = (m, p = {}, t = 90000) =>
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

/** 起一个 move.to 任务并等它结束 */
async function walkTo(x, z, ms = 60000) {
  const r = await call('move.to', { x, z, timeout_ms: ms }, 30000);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(1200);
    const st = await call('task.status', { task_id: r.task_id });
    if (['done', 'failed', 'cancelled'].includes(st.status)) {
      return { status: st.status, error: st.error || '', elapsed: Date.now() - t0 };
    }
  }
  await call('task.cancel', { task_id: r.task_id }).catch(() => {});
  return { status: 'timeout', error: '等超时', elapsed: Date.now() - t0 };
}

(async () => {
  const rcon = Rcon.fromDir('.testserver', 25576);
  console.log('=== 寻路压力测试 ===\n');

  await call('connect', { host: '127.0.0.1', port: PORT, version: '1.20.1', username: USER }, 60000);
  await sleep(5000);

  // 铺一片干净的超平坦场地：y=-61 是地面，y=-60 起是空气
  const GX = 0;
  const GZ = 0;
  await rcon.command(`fill ${GX - 40} -61 ${GZ - 40} ${GX + 40} -61 ${GZ + 40} minecraft:grass_block replace air`);
  await rcon.command(`fill ${GX - 40} -60 ${GZ - 40} ${GX + 40} -55 ${GZ + 40} minecraft:air replace`);
  await sleep(1200);

  // ---- 场景 1：平地直走 20 格
  console.log('[1] 平地直走 20 格');
  await rcon.command(`tp ${USER} ${GX} -60 ${GZ}`);
  await sleep(1200);
  let r = await walkTo(GX + 20, GZ, 40000);
  let st = await call('state.get', { detail: 'brief' });
  let d = Math.hypot(st.position.x - (GX + 20), st.position.z - GZ);
  if (r.status === 'done' && d <= 3) ok('平地直走', `${r.elapsed}ms，距目标 ${d.toFixed(1)} 格`);
  else bad('平地直走失败', `${r.status} ${r.error} 距目标 ${d.toFixed(1)} 格`);

  // ---- 场景 2：绕墙（3 格高、8 格宽，正前方 6 格处）
  console.log('\n[2] 绕过一堵 3 格高的墙');
  await rcon.command(`tp ${USER} ${GX} -60 ${GZ}`);
  await rcon.command(
    `fill ${GX + 5} -60 ${GZ - 6} ${GX + 5} -58 ${GZ + 6} minecraft:stone replace air`,
  );
  await sleep(1200);
  r = await walkTo(GX + 12, GZ, 60000);
  st = await call('state.get', { detail: 'brief' });
  d = Math.hypot(st.position.x - (GX + 12), st.position.z - GZ);
  if (r.status === 'done' && d <= 3) ok('绕墙成功', `${r.elapsed}ms，距目标 ${d.toFixed(1)} 格`);
  else bad('绕墙失败', `${r.status} ${r.error} 距目标 ${d.toFixed(1)} 格`);
  await rcon.command(`fill ${GX + 5} -60 ${GZ - 6} ${GX + 5} -58 ${GZ + 6} minecraft:air replace`);

  // ---- 场景 3：上 1 格台阶
  console.log('\n[3] 上 1 格台阶');
  await rcon.command(`tp ${USER} ${GX} -60 ${GZ}`);
  await rcon.command(`fill ${GX + 6} -61 ${GZ - 8} ${GX + 20} -60 ${GZ + 8} minecraft:stone replace air`);
  await sleep(1200);
  r = await walkTo(GX + 14, GZ, 40000);
  st = await call('state.get', { detail: 'brief' });
  d = Math.hypot(st.position.x - (GX + 14), st.position.z - GZ);
  if (r.status === 'done' && d <= 3) ok('上 1 格台阶', `${r.elapsed}ms，y=${st.position.y}`);
  else bad('上 1 格台阶失败', `${r.status} ${r.error} 距目标 ${d.toFixed(1)} 格，y=${st.position.y}`);
  await rcon.command(`fill ${GX + 6} -61 ${GZ - 8} ${GX + 20} -60 ${GZ + 8} minecraft:air replace`);

  // ---- 场景 4：穿过树林（树叶当障碍时能不能过去）
  console.log('\n[4] 穿过一片树叶（软植被应可蹭过）');
  await rcon.command(`tp ${USER} ${GX} -60 ${GZ}`);
  await rcon.command(`fill ${GX + 4} -60 ${GZ - 3} ${GX + 8} -58 ${GZ + 3} minecraft:oak_leaves replace air`);
  await rcon.command(`fill ${GX + 4} -61 ${GZ - 3} ${GX + 8} -61 ${GZ + 3} minecraft:grass_block replace air`);
  await sleep(1200);
  r = await walkTo(GX + 14, GZ, 60000);
  st = await call('state.get', { detail: 'brief' });
  d = Math.hypot(st.position.x - (GX + 14), st.position.z - GZ);
  if (r.status === 'done' && d <= 4.5) ok('穿过树叶', `${r.elapsed}ms，距目标 ${d.toFixed(1)} 格`);
  else bad('穿不过树叶', `${r.status} ${r.error} 距目标 ${d.toFixed(1)} 格`);
  await rcon.command(`fill ${GX + 4} -60 ${GZ - 3} ${GX + 8} -58 ${GZ + 3} minecraft:air replace`);

  // ---- 场景 5：从 3 格深的坑里出来（真人跳不出去，必须挖台阶）
  console.log('\n[5] 从 3 格深的坑里爬出来');
  // **搭建而不是"挖坑"**：超平坦世界的基岩在 -64，往下挖会挖穿到虚空
  // （实测踩过两次：她掉到 y=-105 一直在坠落）。
  // 正确做法是在实心地面上**往上堆**一块台地，再从台地里挖一个坑。
  const PX = GX - 25;
  const PZ = GZ;
  // 台地用**泥土**：她身上没有镐时挖不动石头（这是正确的 MC 规则，
  // 真人在石坑里没工具也出不来），所以"能不能自己爬出来"必须用徒手可挖的方块来测。
  // **注意不要写 `replace air`**：那只会替换空气，之前测试留下的石头会保留下来，
  // 于是"泥土坑"实际上是石坑，场景又不成立了（实测踩过这个坑）。
  await rcon.command(`fill ${PX - 8} -63 ${PZ - 8} ${PX + 20} -60 ${PZ + 8} minecraft:dirt`);
  await sleep(1500);
  await rcon.command(`fill ${PX} -60 ${PZ} ${PX} -62 ${PZ} minecraft:air replace`); // 3 格深的坑
  await sleep(1500);
  await rcon.command(`tp ${USER} ${PX} -62 ${PZ}`);
  await sleep(1800);
  const st5a = await call('state.get', { detail: 'brief' });
  console.log(`    她掉进坑里，y=${st5a.position.y.toFixed(0)}（台地表面 y=-59）`);
  r = await walkTo(PX + 10, PZ, 90000);
  st = await call('state.get', { detail: 'brief' });
  d = Math.hypot(st.position.x - (PX + 10), st.position.z - PZ);
  // 断言要按**新架构**来：走路默认不改世界，所以"自己挖出去"不再是要的行为。
  // 正确的行为是：**如实失败，并说清楚要挖开哪几格**（参考实现 说的"带价签的候选路线"），
  // 由 LLM 决定要不要真的动世界。
  const priceTag = /挡路的?大概?是|要过去得先挖开/.test(r.error || '');
  if (r.status === 'failed' && priceTag) {
    ok('走不到时如实失败并给出"要挖哪几格"（不改世界，交 LLM 决定）', (r.error || '').slice(0, 70));
  } else if (r.status === 'done' && d <= 4) {
    ok('自己走到了（没挖世界也算到）', `距目标 ${d.toFixed(1)} 格`);
  } else {
    bad('走不到时的报错没有给出可行动信息', `${r.status} ${(r.error || '').slice(0, 80)}`);
  }

  // ---- 场景 6：目标在墙后（视线被挡）
  console.log('\n[6] 目标就在墙后 1 格');
  await rcon.command(`tp ${USER} ${GX} -60 ${GZ}`);
  await rcon.command(`fill ${GX + 2} -60 ${GZ - 4} ${GX + 2} -58 ${GZ + 4} minecraft:stone replace air`);
  await sleep(1200);
  r = await walkTo(GX + 3, GZ, 30000);
  st = await call('state.get', { detail: 'brief' });
  d = Math.hypot(st.position.x - (GX + 3), st.position.z - GZ);
  if (r.status === 'done' && d <= 3) ok('绕过贴身的墙', `${r.elapsed}ms`);
  else bad('贴身墙过不去', `${r.status} ${r.error} 距目标 ${d.toFixed(1)} 格`);
  await rcon.command(`fill ${GX + 2} -60 ${GZ - 4} ${GX + 2} -58 ${GZ + 4} minecraft:air replace`);

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
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
