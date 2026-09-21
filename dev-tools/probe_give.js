'use strict';
/**
 * 诊断：为什么 give 的物品不在背包里，以及 mine_stone 为什么被取消。
 * 带完整引擎日志（stderr）输出。
 */

const { spawn } = require('child_process');
const path = require('path');
const { Rcon } = require('./lib/rcon');

const USER = 'Diag' + Math.floor(Math.random() * 9000);

const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MC_ENGINE_LOG_LEVEL: 'debug' },
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

(async () => {
  // 用法：node tools/probe_give.js [技能名] [JSON参数]
  // 注意：PowerShell 会吃掉 JSON 里的双引号，所以参数尽量留空用技能默认值，
  // 或者用 --% 停止解析（例：node --% tools/probe_give.js mine_stone {"count":8}）
  const skill = process.argv[2] || 'mine_stone';
  let params = {};
  if (process.argv[3]) {
    try {
      params = JSON.parse(process.argv[3]);
    } catch {
      console.log(`参数不是合法 JSON（${process.argv[3]}），改用技能默认值`);
    }
  }
  if (skill === 'mine_stone' && !Object.keys(params).length) params = { count: 4 };
  const rcon = Rcon.fromDir('.testserver', 25576);
  console.log('连接 rcon 测试:', (await rcon.command('list')).trim());

  await call('connect', { host: '127.0.0.1', port: 25566, version: '1.20.1', username: USER }, 60000);
  await sleep(6000);

  console.log(`\n[1] give 到 ${USER} 之前，背包:`, JSON.stringify((await call('inventory.get')).items));
  await rcon.command(`give ${USER} wooden_pickaxe 1`);
  await rcon.command(`give ${USER} stone_pickaxe 1`);
  await rcon.command(`give ${USER} oak_log 16`);
  await rcon.command(`give ${USER} cobblestone 64`);
  await rcon.command(`give ${USER} oak_door 1`);
  await rcon.command(`give ${USER} torch 8`);
  await sleep(3000);
  console.log('  give 之后，背包:', JSON.stringify((await call('inventory.get')).items));

  console.log(`\n[2] 现在起 ${skill}(${JSON.stringify(params)})，并观察引擎日志`);
  const mark = logs.length;
  const r = await call('skill.run', { skill, params });
  console.log('  任务号:', r.task_id);
  for (let i = 0; i < 100; i++) {
    await sleep(3000);
    let st;
    try {
      st = await call('task.status', { task_id: r.task_id });
    } catch (err) {
      console.log(`  [${(i + 1) * 3}s] ❌ 查询失败：${err.message}（引擎可能已断线）`);
      break;
    }
    if (i % 3 === 0) console.log(`  [${(i + 1) * 3}s] ${st.status} ${st.progress || ''}`);
    if (['done', 'failed', 'cancelled'].includes(st.status)) {
      console.log(`  → 结束: ${st.status} ${st.error || ''}`);
      break;
    }
  }

  console.log('\n=== 这段期间的引擎日志（末尾 30 行）===');
  const seg = logs.join('').split('\n').filter((l) => l.trim()).slice(-30);
  for (const l of seg) console.log('  ' + l.trim().slice(0, 150));

  try {
    console.log('\n最终背包:', JSON.stringify((await call('inventory.get')).items));
    const st = await call('state.get', { detail: 'brief' });
    console.log('最终位置:', JSON.stringify(st.block_position), '脚下:', st.standing_on);
  } catch (err) {
    console.log('最终状态读取失败：', err.message);
  }

  rcon.close();
  await call('disconnect').catch(() => {});
  await sleep(300);
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  console.log(logs.join('').split('\n').filter((l) => l.trim()).slice(-30).join('\n'));
  child.kill();
  process.exit(1);
});
