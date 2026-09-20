'use strict';
/**
 * 诊断脚本：进服后把"脚下到底有什么"挖出来看。
 * 专门用来定位"脚下方块未知 / 寻路立刻失败"这类问题，不做断言，只打印事实。
 */

const { spawn } = require('child_process');
const path = require('path');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MC_ENGINE_LOG_LEVEL: 'debug' },
});

let buf = '';
let nextId = 1;
const pending = new Map();
const notices = [];
const stderrLines = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('!! stdout 非 JSON:', line.slice(0, 200));
      continue;
    }
    if (msg.method === 'notice') {
      notices.push(msg.params);
      continue;
    }
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => {
  stderrLines.push(c);
  if (stderrLines.length > 200) stderrLines.shift();
});

function call(method, params = {}, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(t);
        reject(e);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('=== 诊断：地形与寻路 ===\n');
  await call('connect', { host: '127.0.0.1', port: 25565, version: '1.20.1', username: 'AstrBotDiag' }, 45000);
  console.log('已进服，等 6 秒让区块加载...');
  await sleep(6000);

  const st = await call('state.get', { detail: 'normal' });
  console.log('\n--- 快照关键字段 ---');
  console.log('position      :', JSON.stringify(st.position));
  console.log('block_position:', JSON.stringify(st.block_position));
  console.log('standing_on   :', JSON.stringify(st.standing_on), '   <-- 关键');
  console.log('feet_block    :', JSON.stringify(st.feet_block));
  console.log('dimension     :', st.dimension);
  console.log('gamemode      :', st.gamemode, 'on_ground:', st.on_ground);
  console.log('light         :', st.light);

  const bp = st.block_position;
  console.log('\n--- 逐格探测（以脚下方为中心向下） ---');
  for (let dy = 2; dy >= -4; dy -= 1) {
    try {
      const b = await call('block.at', { x: bp.x, y: bp.y + dy, z: bp.z });
      console.log(`  y=${bp.y + dy} (dy=${dy}):`, JSON.stringify(b));
    } catch (err) {
      console.log(`  y=${bp.y + dy}: 调用失败 ${err.message}`);
    }
  }

  console.log('\n--- 周围扫描（引擎的关注方块表） ---');
  const scan = await call('block.scan', { radius: 6 });
  console.log('  找到', scan.count, '个关注方块:', JSON.stringify(scan.blocks.slice(0, 8)));

  console.log('\n--- 显式挖一下脚下的地面（不依赖 block.scan） ---');
  const tx = bp.x;
  const tz = bp.z;
  const ty = bp.y - 1;
  try {
    const r = await call('dig', { x: tx, y: ty, z: tz, collect: true }, 20000);
    console.log('  dig 结果:', JSON.stringify(r));
  } catch (err) {
    console.log('  dig 失败:', err.message, 'code=', err.code);
  }

  console.log('\n--- 寻路 20 格 ---');
  try {
    const r = await call('move.to', { x: tx + 20, z: tz + 8, timeout_ms: 60000 });
    console.log('  已提交 task_id =', r.task_id);
    for (let i = 0; i < 40; i += 1) {
      await sleep(1000);
      const ts = await call('task.status', { task_id: r.task_id });
      if (i % 3 === 0 || ['done', 'failed', 'cancelled'].includes(ts.status)) {
        console.log(`  [${i + 1}s] status=${ts.status} detail=${ts.detail || ts.progress || ''} err=${ts.error || ''}`);
      }
      if (['done', 'failed', 'cancelled'].includes(ts.status)) {
        console.log('  最终:', JSON.stringify({ status: ts.status, error: ts.error, result: ts.result }));
        break;
      }
    }
  } catch (err) {
    console.log('  move.to 提交失败:', err.message);
  }

  await sleep(1500);
  const st2 = await call('state.get', { detail: 'brief' });
  console.log('\n移动后位置:', JSON.stringify(st2.position));

  console.log('\n--- 引擎 stderr 末尾 40 行 ---');
  console.log(stderrLines.join('').split('\n').slice(-40).join('\n'));

  try {
    await call('disconnect');
  } catch {
    /* ignore */
  }
  await sleep(500);
  child.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('诊断脚本出错：', err);
  console.log('\n--- 引擎 stderr ---\n' + stderrLines.join('').split('\n').slice(-40).join('\n'));
  child.kill();
  process.exit(1);
});
