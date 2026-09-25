'use strict';
/**
 * **从坑里出来**：三种真实情况各测一遍（用户反馈"还是不能从坑里面垫出来"）。
 *
 * 为什么要分三种：能不能出来**完全取决于她身上有什么**——
 *   · 有方块 → 可以垫脚上升（pave up）
 *   · 有镐   → 可以挖台阶（climb_out）
 *   · 什么都没有 → **谁也出不来**，这时正确的行为是**如实说"我出不去"**，
 *     而不是反复试同一个不可能的办法
 *
 * 之前我只测过"给她石头镐 + 32 个圆石"那一种，所以"能出来"这个结论
 * 覆盖不到用户实际遇到的情况。
 */

const path = require('path');
const { spawn } = require('child_process');
// **注意路径**：rcon 在 `tools/lib/rcon.js`（不是 bot/lib/）——
// 第一版我写成 `path.join(__dirname, '..', 'lib', 'rcon')`，直接 MODULE_NOT_FOUND。
const { Rcon } = require('./lib/rcon');

const PORT = Number(process.env.MC_PORT || 25566);
const RCON_DIR = process.env.MC_RCON_DIR || path.join(__dirname, '..', '.testserver');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'engine', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MC_ENGINE_LOG_LEVEL: process.env.MC_ENGINE_LOG_LEVEL || 'warn' },
});
let buf = '';
let id = 1;
const pending = new Map();
const finished = [];
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.method === 'notice') {
      const p = m.params || {};
      if (p.event === 'task.finished') finished.push(p.data || {});
      continue;
    }
    const q = pending.get(m.id);
    if (q) {
      pending.delete(m.id);
      if (m.error) q.reject(new Error(m.error.message));
      else q.resolve(m.result);
    }
  }
});
child.stderr.setEncoding('utf8');
// **引擎日志走 stderr**（stdout 是 JSON-RPC 协议）。
// 原来这里是一句 `on('data', () => {})` —— **日志被读出来直接扔掉**，
// 于是测试红了之后**引擎侧零线索**，只能靠猜（这次为查一个回归浪费了好几轮）。
// 改成环形保留最近 300 行，**失败时随结果一起打印**。
const engineLog = [];
child.stderr.on('data', (c) => {
  for (const l of c.split('\n')) {
    if (!l.trim()) continue;
    engineLog.push(l);
    if (engineLog.length > 300) engineLog.shift();
  }
});

const call = (method, params = {}, t = 180000) =>
  new Promise((res, rej) => {
    const i = id++;
    const tm = setTimeout(() => rej(new Error('timeout ' + method)), t);
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
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (m, d) => {
  pass += 1;
  console.log(`  ✅ ${m}${d ? ` — ${d}` : ''}`);
};
const bad = (m, d) => {
  fail += 1;
  console.log(`  ❌ ${m}${d ? ` — ${d}` : ''}`);
};

/** 造一个 depth 格深的坑，把她放进去 */
async function makePit(rcon, user, X, depth) {
  const Z = 0;

  // **世界最低高度是 -64，不能往下挖穿它。**
  //
  // 踩过两次，都是"往下挖"：
  //   ① 第一版写死到 -64，depth=10 时挖穿了地板 → 她掉到 y=-88 的虚空
  //   ② 第二版改成 `-61 - depth - 6` → depth=10 时是 **-77，超出世界高度**，
  //      服务端直接回 "That position is out of this world!"，
  //      **整条 fill 被拒绝、一块地板都没铺** → 她掉到 y=-111
  //
  // 所以：**深坑要往上堆，不是往下挖。**
  // 从 -64（世界底）往上堆到 `-61 + depth`，她站在顶上，
  // 然后把脚下 depth 格挖空 —— 坑底永远是 -63，稳稳在世界里。
  const FLOOR = -63;                       // 坑底（世界最低是 -64，留一格）
  const SURFACE = FLOOR + depth;           // 坑口那一层（她站在它上面）
  const standY = FLOOR + 1;                // 她脚的位置
  const top = SURFACE;                     // 她脚下的支撑层

  // 从世界底往上堆到坑口
  await rcon.command(
    `fill ${X - 6} -64 ${Z - 6} ${X + 6} ${top} ${Z + 6} minecraft:stone`,
  );
  // 上面清空
  await rcon.command(
    `fill ${X - 6} ${top + 1} ${Z - 6} ${X + 6} ${top + 20} ${Z + 6} minecraft:air`,
  );
  await sleep(2500);
  // 在她那一格往下挖 depth 格（从坑口往下）
  await rcon.command(
    `fill ${X} ${standY} ${Z} ${X} ${top} ${Z} minecraft:air`,
  );
  await sleep(1500);
  await rcon.command(`tp ${user} ${X + 0.5} ${standY} ${Z + 0.5}`);
  await sleep(2500);
  return { X, Z, standY, surfaceY: SURFACE };
}

async function runSkill(skill, params, sec = 120) {
  const mark = finished.length;
  const r = await call('skill.run', { skill, params }, 60000).catch((e) => ({ err: e.message }));
  if (r.err) return { status: 'start-failed', error: r.err };
  for (let i = 0; i < sec * 2 && finished.length === mark; i += 1) await sleep(500);
  const f = finished[mark];
  return f ? { status: f.status, result: f.result || {}, error: f.error } : { status: 'no-finish' };
}

(async () => {
  const rcon = Rcon.fromDir(RCON_DIR, 25576);
  const USER = 'Pit' + Math.floor(Math.random() * 9000);
  // **每次运行换一块地**（这一轮加的）。
  //
  // 为什么必须：`stairUpOne` / `digStepUp` 会**在坑里留下方块**（那正是它们的作用）。
  // 于是第二次跑同一个坐标时，坑已经被填了一部分 ——
  // 测出来的就不是"能不能爬出来"，而是"在一个被填过的坑里能不能爬出来"。
  // 实测症状：单跑一个新坐标 100% 成功，而连跑时第 1 项会红。
  // 这和 `test_pathfinding` 那个"六个场景共用一片地"是同一个病。
  const BASE = 2000 + Math.floor(Math.random() * 4000);
  await call('connect', { host: '127.0.0.1', port: PORT, version: '1.20.1', username: USER }, 60000);
  await sleep(6000);  console.log('=== 从坑里出来（三种真实情况）===\n');

  // ---------- 情况 1：有方块（应该能垫出来）----------
  console.log('[1] 3 格深的坑 + 背包里有 32 个圆石（没有镐）');
  {
    const p = await makePit(rcon, USER, BASE + 0, 3);
    await rcon.command(`give ${USER} cobblestone 32`);
    await sleep(1500);
    await rcon.command(`tp ${USER} ${p.X + 0.5} ${p.standY} ${p.Z + 0.5}`);
    await sleep(2000);
    const before = await call('state.get', { detail: 'brief' });
    console.log(`    起点 y=${before.position.y.toFixed(1)}（地面 y=-60，坑深 3）`);
    const r = await runSkill('pave', { direction: 'up', count: 4 });
    const after = await call('state.get', { detail: 'brief' });
    const up = after.position.y - before.position.y;
    console.log(`    pave up → ${r.status} ｜ ${String(r.result.note || r.error || '').slice(0, 80)}`);
    if (up >= 2) ok('垫出来了', `y ${before.position.y.toFixed(0)} → ${after.position.y.toFixed(0)}（升了 ${up.toFixed(0)} 格）`);
    else bad('没能垫出来', `y ${before.position.y.toFixed(0)} → ${after.position.y.toFixed(0)}`);
  }

  // ---------- 情况 2：有镐（应该能挖出来）----------
  console.log('\n[2] 3 格深的坑 + 有石镐（泥土/石头壁可挖）');
  {
    const p = await makePit(rcon, USER, BASE + 60, 3);
    await rcon.command(`give ${USER} stone_pickaxe 1`);
    await sleep(1500);
    await rcon.command(`tp ${USER} ${p.X + 0.5} ${p.standY} ${p.Z + 0.5}`);
    await sleep(2000);
    const before = await call('state.get', { detail: 'brief' });
    console.log(`    起点 y=${before.position.y.toFixed(1)}`);
    const r = await runSkill('climb_out', { max_steps: 32 });
    const after = await call('state.get', { detail: 'brief' });
    const up = after.position.y - before.position.y;
    console.log(`    climb_out → ${r.status} ｜ ${String(r.result.note || r.error || '').slice(0, 80)}`);
    if (up >= 2) ok('挖出来了', `y ${before.position.y.toFixed(0)} → ${after.position.y.toFixed(0)}`);
    else bad('没能挖出来', `y ${before.position.y.toFixed(0)} → ${after.position.y.toFixed(0)}`);
  }

  // ---------- 情况 3：什么都没有（应该如实说"出不去"）----------
  console.log('\n[3] 3 格深的坑 + 什么都没有（没有方块也没有镐）');
  {
    const p = await makePit(rcon, USER, BASE + 120, 3);
    await rcon.command(`clear ${USER}`);
    await sleep(1500);
    await rcon.command(`tp ${USER} ${p.X + 0.5} ${p.standY} ${p.Z + 0.5}`);
    await sleep(2000);
    const before = await call('state.get', { detail: 'brief' });
    console.log(`    起点 y=${before.position.y.toFixed(1)}，背包 ${(before.inventory && before.inventory.items ? before.inventory.items.length : '?')} 种东西`);
    const r = await runSkill('pave', { direction: 'up', count: 3 }, 60);
    const after = await call('state.get', { detail: 'brief' });
    const note = String(r.result.note || r.error || '');
    console.log(`    pave up → ${r.status} ｜ ${note.slice(0, 90)}`);
    const saidNo = /没有能垫的方块|没有方块|垫高失败/.test(note);
    if (saidNo) ok('如实说了"没有方块可垫"（不是假装成功）', note.slice(0, 60));
    else bad('没有明确说清"出不去"的原因', note.slice(0, 80));
    // 再看 climb_out 在没镐时怎么说
    const r2 = await runSkill('climb_out', { max_steps: 16 }, 60);
    const note2 = String(r2.result.note || r2.error || '');
    console.log(`    climb_out → ${r2.status} ｜ ${note2.slice(0, 90)}`);
    const up2 = after.position.y - before.position.y;
    if (up2 < 1) ok('确实出不去（符合物理：没工具没方块）', `y 没变`);
    else bad('竟然出来了？那说明有别的路径，要重新理解', `升了 ${up2.toFixed(0)} 格`);
  }

  // ---------- 情况 4：**真实场景**——挖矿挖出来的深竖井 ----------
  //
  // 用户的原话："每次挖矿之后都没法自己回到地面，所以应该是有方块也有镐"
  //
  // 所以真正要测的是：**十几格深的 1x1 竖井 + 有镐 + 有圆石**（挖矿的产物）。
  // 前面那三条都太浅（3 格），盖不到这个情况。
  console.log('\n[4] 真实场景：10 格深的 1x1 竖井 + 有镐 + 有圆石（挖矿回来的样子）');
  {
    const p = await makePit(rcon, USER, BASE + 180, 10);
    await rcon.command(`give ${USER} stone_pickaxe 1`);
    await rcon.command(`give ${USER} cobblestone 32`);
    await sleep(1500);
    await rcon.command(`tp ${USER} ${p.X + 0.5} ${p.standY} ${p.Z + 0.5}`);
    await sleep(2000);
    const before = await call('state.get', { detail: 'brief' });
    console.log(`    起点 y=${before.position.y.toFixed(1)}（地面 y=-60，井深 10）`);
    // 先试 climb_out（她应该会用它）
    const r = await runSkill('climb_out', { max_steps: 40 }, 240);
    const after = await call('state.get', { detail: 'brief' });
    const up = after.position.y - before.position.y;
    console.log(`    climb_out → ${r.status} ｜ ${String(r.result.note || r.error || '').slice(0, 90)}`);
    if (after.position.y >= -60.5) {
      ok('从 10 格深的竖井里爬回地面了', `y ${before.position.y.toFixed(0)} → ${after.position.y.toFixed(0)}（升了 ${up.toFixed(0)} 格）`);
    } else {
      bad('没能从 10 格深的竖井里出来', `y ${before.position.y.toFixed(0)} → ${after.position.y.toFixed(0)}（只升了 ${up.toFixed(0)} 格）`);
    }
    // 再试 pave up（另一条路）
    if (after.position.y < -60.5) {
      const r2 = await runSkill('pave', { direction: 'up', count: 12 }, 240);
      const after2 = await call('state.get', { detail: 'brief' });
      console.log(`    pave up → ${r2.status} ｜ ${String(r2.result.note || r2.error || '').slice(0, 90)}`);
      if (after2.position.y >= -60.5) {
        ok('pave up 能从深井里垫上来', `y ${after.position.y.toFixed(0)} → ${after2.position.y.toFixed(0)}`);
      } else {
        bad('pave up 也出不来', `y ${after2.position.y.toFixed(0)}`);
      }
    }
  }

  rcon.close();
  await call('disconnect').catch(() => {});
  await sleep(500);
  child.kill();
  await sleep(1500);
  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  if (fail > 0 && engineLog.length) {
    // **失败了就把引擎日志一起交出来** —— 没有现场的失败只能靠猜
    console.log(`--- 引擎日志（stderr 最近 ${engineLog.length} 行，从这里查原因）---`);
    for (const l of engineLog.slice(-150)) console.log('  ' + l);
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  child.kill();
  process.exit(1);
});
