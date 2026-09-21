'use strict';
/**
 * 引擎层直测：follow / chop_tree / move.to 在真实服务端上是否工作。
 * 排查"进游戏后什么都做不了"时，先把引擎层和插件层分开验证。
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
    this.notices = [];
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
        if (m.method === 'notice') {
          this.notices.push(m.params);
          continue;
        }
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
          else p.resolve(m.result);
        }
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', () => {});
  }
  call(method, params = {}, t = 60000) {
    const id = this.id++;
    return new Promise((res, rej) => {
      const tm = setTimeout(() => rej(new Error('timeout ' + method)), t);
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

async function waitTask(c, taskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await c.call('task.status', { task_id: taskId });
    if (['done', 'failed', 'cancelled'].includes(st.status)) return st;
    await sleep(1500);
  }
  return { status: 'timeout' };
}

(async () => {
  const rcon = Rcon.fromDir('.testserver', 25576);
  const c = new C();

  console.log('=== 引擎层直测 ===\n');
  await c.call('connect', { host: '127.0.0.1', port: PORT, version: '1.20.1', username: 'AstrBotEng' }, 60000);
  await sleep(4000);

  const st = await c.call('status');
  if (st.connected) ok(`进服成功，位置 ${JSON.stringify(st.position)}`);
  else {
    bad('没连上');
    process.exit(1);
  }

  // ---- 1. move.to（基础寻路）
  console.log('\n[1] move.to 走到 12 格外');
  const p0 = st.position;
  const r1 = await c.call('move.to', { x: Math.round(p0.x) + 12, z: Math.round(p0.z) + 8, timeout_ms: 45000 });
  const t1 = await waitTask(c, r1.task_id, 50000);
  const st1 = await c.call('state.get', { detail: 'brief' });
  const moved = Math.hypot(st1.position.x - p0.x, st1.position.z - p0.z);
  if (t1.status === 'done' && moved >= 10) ok(`寻路成功：${t1.status}，移动 ${moved.toFixed(1)} 格`);
  else bad(`寻路失败：${t1.status} err=${t1.error || ''}，移动 ${moved.toFixed(1)} 格`);

  // ---- 2. move.follow（跟随）
  console.log('\n[2] move.follow 跟随一个玩家');
  // 用 rcon 召唤一个"玩家"不可能（只能 summon 实体），所以用假玩家名测试错误路径，
  // 再用 move.follow 跟随后立刻取消，验证接口存在且能下任务
  try {
    const rf = await c.call('move.follow', { target: '不存在的玩家xyz' });
    if (rf.task_id) {
      ok(`move.follow 接口可用（返回任务号 ${rf.task_id}）`);
      const tf = await waitTask(c, rf.task_id, 20000);
      // 找不到目标是预期的失败，但必须是"如实失败"而不是接口缺失
      if (tf.status === 'failed' && tf.error) {
        ok(`找不到目标时如实报错：${tf.error.slice(0, 60)}`);
      } else if (tf.status === 'done' || tf.status === 'cancelled') {
        ok(`任务结束状态 ${tf.status}（合理）`);
      } else {
        bad(`跟随任务状态异常：${JSON.stringify(tf)}`);
      }
    } else {
      bad(`move.follow 没返回任务号：${JSON.stringify(rf)}`);
    }
  } catch (e) {
    bad(`move.follow 调用异常：${e.message}`);
  }

  // ---- 3. chop_tree（砍树）
  console.log('\n[3] chop_tree 砍 2 棵树（先种两棵）');
  const st2 = await c.call('state.get', { detail: 'brief' });
  const bp = st2.block_position;
  await rcon.command(`setblock ${bp.x + 4} ${bp.y - 1} ${bp.z + 4} minecraft:oak_sapling`);
  await rcon.command(`setblock ${bp.x + 8} ${bp.y - 1} ${bp.z + 6} minecraft:oak_sapling`);
  // 平地没有骨粉催熟的简单办法，直接放原木柱模拟树干
  for (let y = 0; y < 4; y++) {
    await rcon.command(`setblock ${bp.x + 4} ${bp.y + y} ${bp.z + 4} minecraft:oak_log`);
    await rcon.command(`setblock ${bp.x + 8} ${bp.y + y} ${bp.z + 6} minecraft:oak_log`);
  }
  await sleep(1000);
  const invBefore = (await c.call('inventory.get')).items;
  const rc = await c.call('skill.run', { skill: 'chop_tree', params: { count: 2 } });
  if (rc.task_id) {
    const tc = await waitTask(c, rc.task_id, 120000);
    const invAfter = (await c.call('inventory.get')).items;
    const logs = (invAfter.oak_log || 0) - (invBefore.oak_log || 0);
    if (tc.status === 'done' && logs >= 2) {
      ok(`砍树成功：${tc.status}，实际获得 oak_log×${logs}`);
    } else {
      bad(`砍树失败：${tc.status} err=${(tc.error || '').slice(0, 80)}，获得 oak_log×${logs}`);
    }
  } else {
    bad(`chop_tree 没返回任务号：${JSON.stringify(rc)}`);
  }

  // ---- 4. 急停
  console.log('\n[4] safety.stop');
  const rs = await c.call('safety.stop', {});
  if (rs && rs.ok !== false) ok('急停接口正常');
  else bad(`急停异常：${JSON.stringify(rs)}`);

  rcon.close();
  await c.call('disconnect').catch(() => {});
  await sleep(500);
  c.kill();

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
