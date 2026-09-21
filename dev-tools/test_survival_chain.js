'use strict';
/**
 * 生存链验证：在**正常地形**（地表之下有石头）里，她能不能真的挖到圆石。
 *
 * 为什么必须单独验证这个：
 * 她自己的记忆里连续几十分钟都是同三条失败——
 *   「挖石头」连续多次没有进展
 *   「做工具」挖圆石失败：连续多次没有进展
 *   「建庇护所」材料凑不齐（需要圆石/泥土/木板…还要火把和门）
 * 根因是两个：
 *   1. mineSpecific 把"换个地方继续找"当成失败，连续 3 次就整体放弃
 *   2. relocate 每轮只往下挖 1 格，而地表到石头有 5~10 格
 * 结果整条生存链（石头 → 石制工具 → 庇护所）被一个点锁死。
 *
 * 这个脚本就是验证那两处修复：让她从地表往下挖，看能不能挖到圆石。
 */

const { spawn } = require('child_process');
const path = require('path');
const { Rcon } = require('./lib/rcon');

const PORT = 25566;

class C {
  constructor() {
    this.child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MC_ENGINE_LOG_LEVEL: 'info' },
    });
    this.buf = '';
    this.id = 1;
    this.pending = new Map();
    this.logs = [];
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c) => {
      this.buf += c;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.method === 'notice') continue;
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error.message));
          else p.resolve(m.result);
        }
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => this.logs.push(String(c)));
    this.logTail = (n = 12) =>
      this.logs
        .join('')
        .split('\n')
        .filter((l) => l.trim())
        .slice(-n)
        .map((l) => l.trim().slice(0, 140));
  }
  call(method, params = {}, t = 60000) {
    const id = this.id++;
    return new Promise((res, rej) => {
      const tm = setTimeout(() => rej(new Error('rpc-timeout ' + method)), t);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(tm);
          res(v);
        },
        reject: (e) => {
          clearTimeout(tm);
          rej(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
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
let pass = 0;
let fail = 0;
const ok = (m) => {
  pass++;
  console.log(`  ✅ ${m}`);
};
const bad = (m) => {
  fail++;
  console.log(`  ❌ ${m}`);
};

async function waitTask(c, id, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const st = await c.call('task.status', { task_id: id });
    if (['done', 'failed', 'cancelled'].includes(st.status)) return st;
    await sleep(2000);
  }
  return { status: 'timeout' };
}

(async () => {
  const rcon = Rcon.fromDir('.testserver', 25576);
  const c = new C();
  const USER = 'SurvBot' + Math.floor(Math.random() * 9000);
  console.log('=== 生存链验证（正常地形）===\n');

  await c.call('connect', { host: '127.0.0.1', port: PORT, version: '1.20.1', username: USER }, 60000);
  await sleep(5000);

  const st0 = await c.call('state.get', { detail: 'brief' });
  const bp = st0.block_position;
  console.log(`出生位置 (${bp.x}, ${bp.y}, ${bp.z})，脚下 ${st0.standing_on}`);

  // 现实准备：她本来就该先砍树做出木镐。这里直接给木镐，把验证聚焦在"挖石头"。
  await rcon.command(`give ${USER} wooden_pickaxe 1`);
  await rcon.command(`give ${USER} oak_log 8`);
  await sleep(2000);

  console.log('\n[1] 地表往下挖：mine_stone(want=8)');
  console.log('    （修复前这里必然失败：连续多次没有进展）');
  const inv0 = (await c.call('inventory.get')).items;
  const r1 = await c.call('skill.run', { skill: 'mine_stone', params: { count: 8 } });
  const before = Date.now();
  const t1 = await waitTask(c, r1.task_id, 240000);
  const inv1 = (await c.call('inventory.get')).items;
  const cobble = (inv1.cobblestone || 0) - (inv0.cobblestone || 0);
  const st1 = await c.call('state.get', { detail: 'brief' });

  console.log(`    任务 ${t1.status}（${((Date.now() - before) / 1000).toFixed(0)} 秒）${t1.error ? ' 错误：' + t1.error : ''}`);
  console.log(`    位置 (${bp.x}, ${bp.y}, ${bp.z}) → (${st1.block_position.x}, ${st1.block_position.y}, ${st1.block_position.z})`);
  // 报告完整背包变化，而不只是圆石——否则"挖到安山岩"会被误报成"什么都没挖到"
  const delta1 = {};
  for (const k of new Set([...Object.keys(inv0), ...Object.keys(inv1)])) {
    const d = (inv1[k] || 0) - (inv0[k] || 0);
    if (d !== 0) delta1[k] = d;
  }
  console.log('    背包变化:', JSON.stringify(delta1));
  if (t1.status !== 'done') {
    console.log('    引擎日志尾部:');
    for (const l of c.logTail(10)) console.log('      ' + l);
  }
  if (cobble >= 8) {
    ok(`挖到圆石 ×${cobble}（真的往下挖到石头了）`);
  } else if (cobble > 0) {
    bad(`只挖到圆石 ×${cobble}（目标 8）`);
  } else {
    bad(`一个圆石都没挖到：${t1.error || '无错误信息'}（背包变化 ${JSON.stringify(delta1)}）`);
  }
  const dropped = bp.y - st1.block_position.y;
  if (dropped >= 3) ok(`确实向下挖了 ${dropped} 格（修复前每轮只挖 1 格就放弃）`);
  else if (cobble > 0) console.log(`    （向下 ${dropped} 格，可能附近本来就有裸露石头）`);
  else bad(`没有向下挖掘（只下降 ${dropped} 格）`);

  console.log('\n[2] 用圆石做石制工具：make_tools(tier=stone)');
  const r2 = await c.call('skill.run', { skill: 'make_tools', params: { tier: 'stone', kinds: ['pickaxe', 'axe'] } });
  const t2 = await waitTask(c, r2.task_id, 240000);
  const inv2 = (await c.call('inventory.get')).items;
  console.log(`    任务 ${t2.status}${t2.error ? ' 错误：' + t2.error : ''}`);
  if (inv2.stone_pickaxe || inv2.stone_axe) {
    ok(`做出石制工具：${['stone_pickaxe', 'stone_axe'].filter((k) => inv2[k]).map((k) => `${k}×${inv2[k]}`).join('、')}`);
  } else {
    bad(`没做出石制工具（${t2.error || '无错误信息'}）`);
  }

  console.log('\n[3] 盖一个带门的小屋：build_shelter(size=3)');
  const r3 = await c.call('skill.run', { skill: 'build_shelter', params: { size: 3 } });
  const t3 = await waitTask(c, r3.task_id, 300000);
  console.log(`    任务 ${t3.status}${t3.error ? ' 错误：' + t3.error : ''}`);
  if (t3.status === 'done') {
    ok('庇护所建成');
  } else {
    bad(`庇护所未建成：${t3.error || t3.status}`);
  }

  console.log('\n=== 最终背包 ===');
  const invF = (await c.call('inventory.get')).items;
  console.log('  ' + JSON.stringify(invF));

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  rcon.close();
  await c.call('disconnect').catch(() => {});
  await sleep(500);
  c.kill();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
