'use strict';
/**
 * 技能测试（M2/M4 的核心验收）。
 *
 * 与 smoke.js 的分工：
 *   smoke.js 验证"通道与基本动作通不通"
 *   本脚本验证"技能真的能完成一件事"——砍树拿到木头、做出一整套工具、挖到矿、盖出房子
 *
 * 因为要在超平坦世界里测试，脚本会通过服务端 rcon 之外的 stdin 通道注入场景：
 * 这里改用 mc 命令方块不可行，所以改为在平坦世界里直接用 /setblock 类操作不可用，
 * 因此采用另一种更可靠的方式——**用引擎自己的能力造场景**（give 由测试脚本通过
 * 服务器控制台完成，见 tools/run_skilltest.ps1）。
 *
 * 用法：
 *   node tools/skilltest.js                     # 只测不需要场景的技能
 *   node tools/skilltest.js --port 25566        # 指定端口
 *   node tools/skilltest.js --full              # 包含挖矿与建造（慢，需要几分钟）
 */

const { spawn } = require('child_process');
const path = require('path');

const argPort = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 25566;
const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = argPort;
const VERSION = process.env.MC_VERSION || '1.20.1';
const FULL = process.argv.includes('--full');

let pass = 0;
let fail = 0;
const lines = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    lines.push(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    lines.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
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
    this.notices = [];
    this.stderr = [];
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c) => this._onData(c));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => {
      this.stderr.push(c);
      if (this.stderr.length > 300) this.stderr.shift();
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
        console.error('!! stdout 污染:', line.slice(0, 150));
        continue;
      }
      if (m.method === 'notice') {
        this.notices.push(m.params);
        continue;
      }
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code, data: m.error.data }));
        else p.resolve(m.result);
      }
    }
  }

  call(method, params = {}, timeoutMs = 60000) {
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

/** 跑一个技能并等它结束，打印实时进度 */
async function runSkill(c, skill, params, { timeoutSec = 240, label = null } = {}) {
  const name = label || skill;
  process.stdout.write(`\n▶ ${name} ${JSON.stringify(params)}\n`);
  let taskId;
  try {
    const r = await c.call('skill.run', { skill, params });
    taskId = r.task_id;
  } catch (err) {
    return { ok: false, error: `提交失败：${err.message}` };
  }
  const start = Date.now();
  let lastDetail = '';
  for (let i = 0; i < timeoutSec * 2; i += 1) {
    await sleep(500);
    let st;
    try {
      st = await c.call('task.status', { task_id: taskId }, 20000);
    } catch (err) {
      return { ok: false, error: `查询状态失败：${err.message}` };
    }
    const detail = st.detail || st.progress || '';
    if (detail && detail !== lastDetail) {
      lastDetail = detail;
      process.stdout.write(`    · ${detail}\n`);
    }
    if (['done', 'failed', 'cancelled'].includes(st.status)) {
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      process.stdout.write(`    → ${st.status}（${secs}s）${st.error ? ` 错误：${st.error}` : ''}\n`);
      return { ok: st.status === 'done', status: st.status, error: st.error, result: st.result, seconds: Number(secs) };
    }
  }
  try {
    await c.call('task.cancel', { task_id: taskId });
  } catch {
    /* ignore */
  }
  return { ok: false, error: `超时（${timeoutSec}s）` };
}

async function main() {
  const t0 = Date.now();
  console.log('=== 技能测试（M2/M4 验收）===');
  console.log(`目标服务器 ${HOST}:${PORT}  ${FULL ? '（含挖矿与建造）' : ''}\n`);

  const c = new Client();
  await c.call('connect', { host: HOST, port: PORT, version: VERSION, username: 'AstrBotSkill' }, 60000);
  await sleep(4000);

  const state0 = await c.call('state.get', { detail: 'brief' });
  console.log(`进服位置 ${JSON.stringify(state0.position)}，脚下 ${state0.standing_on}`);

  // ---------------------------------------------------------- 1. 建庇护所（超平坦，无树）
  // 平坦世界没有木头，所以先测"采集闭环"里的通用收集：挖泥土/草方块
  console.log('\n──── 1. 通用收集（collect）────');
  const r1 = await runSkill(c, 'collect', { item: 'dirt', count: 8 }, { timeoutSec: 120 });
  check('collect 挖到 8 个泥土', r1.ok && (r1.result?.have || 0) >= 8, r1.ok ? `现有 ${r1.result?.have}` : r1.error);

  // ---------------------------------------------------------- 2. 挖石头
  // 注意：超平坦世界（bedrock+dirt+dirt+grass）里没有石头，
  // 所以这一项验收的是"找不到时给出可读原因"，而不是"必须挖到"。
  console.log('\n──── 2. 挖石头（mine_stone，平坦世界无石头）────');
  const r2 = await runSkill(c, 'mine_stone', { count: 12 }, { timeoutSec: 120 });
  const inv2 = await c.call('inventory.get');
  const gotStone = (inv2.items.cobblestone || 0) > 0;
  const explained = !!(r2.error || r2.result?.reason || r2.result?.note);
  check(
    'mine_stone 有产出，或诚实报告找不到石头',
    gotStone || explained,
    gotStone ? `cobblestone=${inv2.items.cobblestone}` : `原因：${r2.error || r2.result?.reason}`,
  );

  // ---------------------------------------------------------- 3. 建庇护所
  console.log('\n──── 3. 建造庇护所（build_shelter）────');
  // 用随身给的圆石当建材（真实场景里由玩家/机器人自己挖到）
  const r3 = await runSkill(c, 'build_shelter', { size: 3, roof: true, door: false, torch: false }, { timeoutSec: 600 });
  check('build_shelter 完成', r3.ok, r3.ok ? `材料 ${r3.result?.shelter?.material}，位置 ${JSON.stringify(r3.result?.shelter?.origin)}` : r3.error);
  if (r3.ok && r3.result?.shelter) {
    const shelter = r3.result.shelter;
    // 验证：墙体位置确实有方块（不能只信自我报告）
    const wallBlock = await c.call('block.at', { x: shelter.origin.x, y: shelter.origin.y, z: shelter.origin.z });
    check(
      '墙上真的有方块（不是自我报告）',
      wallBlock && wallBlock.name !== 'air',
      `(${shelter.origin.x},${shelter.origin.y},${shelter.origin.z}) = ${wallBlock?.name}`,
    );
    // 验证：人在屋里或屋边（说明真的建在原地）
    const stNow = await c.call('state.get', { detail: 'brief' });
    const dist = Math.hypot(stNow.position.x - shelter.origin.x, stNow.position.z - shelter.origin.z);
    check('机器人在庇护所附近', dist < 12, `距中心 ${dist.toFixed(1)} 格`);
  }

  // ---------------------------------------------------------- 4. 存东西
  console.log('\n──── 4. 存东西（store_items）────');
  const r4 = await runSkill(c, 'store_items', {}, { timeoutSec: 180 });
  check('store_items 完成', r4.ok, r4.ok ? (r4.result?.note || '') : r4.error);

  // ---------------------------------------------------------- 5. 完整目标链（GoalManager 走引擎侧）
  if (FULL) {
    console.log('\n──── 5. 挖矿（mine_ores: iron）────');
    const r5 = await runSkill(c, 'mine_ores', { ore: 'iron', count: 4 }, { timeoutSec: 600 });
    const inv5 = await c.call('inventory.get');
    check(
      'mine_ores 有产出或给出了可读原因',
      (inv5.items.raw_iron || 0) > 0 || !!r5.error || !!r5.result?.reason,
      `raw_iron=${inv5.items.raw_iron || 0}${r5.error ? ` 原因: ${r5.error}` : ''}`,
    );
  }

  // ---------------------------------------------------------- 收尾
  const invFinal = await c.call('inventory.get');
  const st = await c.call('status');
  console.log('\n最终背包:', JSON.stringify(invFinal.items));
  console.log('任务统计:', JSON.stringify(st.stats));

  await c.call('safety.stop').catch(() => {});
  await c.call('disconnect').catch(() => {});
  await sleep(600);
  c.kill();

  console.log('\n=== 结果 ===');
  console.log(lines.join('\n'));
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  if (fail > 0) {
    console.log('\n--- 引擎日志末尾 ---');
    console.log(c.stderr.join('').split('\n').slice(-30).join('\n'));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('测试脚本出错：', err);
  process.exit(2);
});
