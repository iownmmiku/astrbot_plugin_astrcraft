'use strict';
/**
 * 验证"被方块卡住"的自救。
 *
 * 场景来自真实故障：她在自己挖的矿洞里被方块封住——
 * 脚下那层是 2 格通道、**头顶那层却全是实心**。
 * 于是任何寻路都失败，日志里她连着一小时喊"路被堵死了走不过去"，
 * 所有需要走动的技能（做工具要走到工作台、砍树要走到树）全部失败。
 *
 * 这个测试把她真的埋进石头里，看反射层会不会自己挖出来。
 */

const { spawn } = require('child_process');
const path = require('path');
const { Rcon } = require('./lib/rcon');

const PORT = Number(process.env.MC_PORT || 25566);
const USER = 'Stuck' + Math.floor(Math.random() * 9000);

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

(async () => {
  const rcon = Rcon.fromDir('.testserver', 25576);
  console.log('=== 被方块卡住的自救验证 ===\n');
  await call('connect', { host: '127.0.0.1', port: PORT, version: '1.20.1', username: USER }, 60000);
  await sleep(5000);
  await call('config.update', { autoUnstuck: true, autoCollectDrops: false, autoTorch: false });

  const st = await call('state.get', { detail: 'brief' });
  const p = st.block_position;
  console.log(`她的位置 (${p.x}, ${p.y}, ${p.z})`);

  // ---- 场景 A：头顶被封住（真实故障的形态）
  // **用泥土而不是石头**：她被困时往往身上什么都没有（死了掉光 / 镐子用坏），
  // 石头徒手挖不动，而真人这时是"先用手刨开软的那面"。
  // 用泥土才能验证"优先挖得动的方块"这个设计。
  console.log('\n[A] 把头顶那一格填成泥土（模拟"挖矿把自己封在洞里"）');
  // **测试要验证自己的场景真的造出来了**——前面踩过太多次"场景没生效、
  // 结果把测试失败误判成功能坏了"（最典型的是 /fill 在区块没加载时静默无效）。
  await call('debug.resetUnstuck'); // 清掉上一次留下的节流窗口
  await rcon.command(`setblock ${p.x} ${p.y + 1} ${p.z} minecraft:dirt`);
  await rcon.command(`setblock ${p.x} ${p.y} ${p.z} minecraft:dirt`);
  await sleep(1000);
  const setupA = await call('block.at', { x: p.x, y: p.y + 1, z: p.z });
  if (!setupA || setupA.name !== 'dirt') {
    console.log(`    ⚠️ 场景没造出来（头顶那格是 ${setupA ? setupA.name : '读不到'}）——测试结论不可信`);
  }

  const before = await call('state.get', { detail: 'brief' });
  console.log(`    填好后她的 y = ${before.block_position.y}`);

  // **等"完全脱身"（脚和头都是空气），而不是只等头顶。**
  // 原来只等头顶通了就进入场景 B，而她可能还卡在脚那格 →
  // B 重新读到的坐标是歪的 → B 的判定跟着歪。这就是偶发 2/3 的来源之一。
  console.log('    等她自救（最多 40 秒，要等到脚和头都通）…');
  let freed = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    const b1 = await call('block.at', { x: p.x, y: p.y + 1, z: p.z });
    const b2 = await call('block.at', { x: p.x, y: p.y, z: p.z });
    if (b1 && b1.name === 'air' && b2 && b2.name === 'air') {
      freed = true;
      console.log(`    第 ${i + 1} 秒：脚和头都通了`);
      break;
    }
  }
  if (freed) {
    ok('头顶被堵住时自己挖开了', '反射层 autoUnstuck 生效');
  } else {
    bad('头顶被堵住时没有自救', '仍被埋着');
  }

  const seg = logs.join('').split('\n').filter((l) => l.trim() && /卡住|挖开/.test(l)).slice(-4);
  for (const l of seg) console.log('      ' + l.trim().slice(0, 130));

  // ---- 场景 B：完全埋住（脚+头都封死）
  console.log('\n[B] 把脚和头两格都填成泥土（完全埋住）');
  const st2 = await call('state.get', { detail: 'brief' });
  const q = st2.block_position;
  await call('debug.resetUnstuck'); // 清掉场景 A 留下的节流窗口（这是偶发的另一个来源）
  await rcon.command(`setblock ${q.x} ${q.y} ${q.z} minecraft:dirt`);
  await rcon.command(`setblock ${q.x} ${q.y + 1} ${q.z} minecraft:dirt`);
  await sleep(1000);
  // 同样先验证场景真的造出来了
  const setupB = await call('block.at', { x: q.x, y: q.y, z: q.z });
  if (!setupB || setupB.name !== 'dirt') {
    console.log(`    ⚠️ 场景没造出来（脚那格是 ${setupB ? setupB.name : '读不到'}）——测试结论不可信`);
  }
  let freed2 = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    const b1 = await call('block.at', { x: q.x, y: q.y + 1, z: q.z });
    const b2 = await call('block.at', { x: q.x, y: q.y, z: q.z });
    if (b1 && b1.name === 'air' && b2 && b2.name === 'air') {
      freed2 = true;
      console.log(`    第 ${i + 1} 秒：脚和头都通了`);
      break;
    }
  }
  if (freed2) {
    ok('完全被埋住时也能自己挖出来', '');
  } else {
    bad('完全被埋住时没能自救', '');
  }

  // ---- 场景 C：确认她之后还能正常走动（自救不能把引擎搞坏）
  console.log('\n[C] 自救之后还能正常寻路吗');
  const st3 = await call('state.get', { detail: 'brief' });
  const r = await call('move.to', { x: st3.block_position.x + 6, z: st3.block_position.z + 6, timeout_ms: 40000 });
  let done = false;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1500);
    const t = await call('task.status', { task_id: r.task_id });
    if (t.status === 'done') {
      done = true;
      break;
    }
    if (['failed', 'cancelled'].includes(t.status)) {
      console.log(`    任务 ${t.status}：${t.error || ''}`);
      break;
    }
  }
  if (done) {
    ok('自救后仍能正常寻路', '');
  } else {
    bad('自救后寻路失败（可能被自救逻辑搞坏了）', '');
  }

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  rcon.close();
  await call('disconnect').catch(() => {});
  await sleep(300);
  child.kill();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  console.log(logs.join('').split('\n').filter((l) => l.trim()).slice(-12).join('\n'));
  child.kill();
  process.exit(1);
});
