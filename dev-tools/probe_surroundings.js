'use strict';
/** 打印机器人周围方块剖面，用来判断她到底被什么卡住。 */

const { spawn } = require('child_process');
const path = require('path');

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

const ABBR = {
  air: '·', cave_air: '·', grass_block: 'G', dirt: 'D', stone: 'S',
  oak_log: 'L', oak_leaves: 'l', water: 'W', sand: 's', sandstone: 'S',
  andesite: 'a', diorite: 'd', granite: 'g', gravel: 'v', bedrock: 'B',
  oak_planks: 'P', cobblestone: 'C', snow: 'n', ice: 'I',
};

(async () => {
  await call('connect', { host: '127.0.0.1', port: 25566, version: '1.20.1', username: 'Look' + Math.floor(Math.random() * 9000) });
  await sleep(6000);
  const st = await call('state.get', { detail: 'brief' });
  const p = st.block_position;
  console.log(`位置 (${p.x}, ${p.y}, ${p.z})  脚下: ${st.standing_on}  维度: ${st.dimension}`);

  // 每个高度画一张 11x11 的俯视图
  for (let dy = 3; dy >= -3; dy -= 1) {
    const y = p.y + dy;
    const rows = [];
    for (let dz = -5; dz <= 5; dz += 1) {
      let row = '';
      for (let dx = -5; dx <= 5; dx += 1) {
        const b = await call('block.at', { x: p.x + dx, y, z: p.z + dz });
        if (!b) {
          row += '?';
          continue;
        }
        const n = String(b.name).replace(/^minecraft:/, '');
        row += ABBR[n] || n[0].toUpperCase();
      }
      rows.push(row);
    }
    const mark = dy === 0 ? ' ← 她的脚' : dy === 2 ? ' ← 她的头' : '';
    console.log(`\ny=${y}${mark}`);
    for (const r of rows) console.log('   ' + r);
  }

  console.log('\n=== 附近可挖方块（半径 12）===');
  for (const n of ['stone', 'oak_log', 'dirt', 'andesite', 'sand']) {
    const r = await call('block.scan', { names: [n], radius: 12, limit: 3 });
    console.log(`  ${n}: ${r.count} 个 ${r.blocks && r.blocks[0] ? JSON.stringify(r.blocks[0]) : ''}`);
  }

  await call('disconnect').catch(() => {});
  await sleep(300);
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  child.kill();
  process.exit(1);
});
