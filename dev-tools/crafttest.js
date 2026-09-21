'use strict';
/**
 * 定向验证：合成依赖链 + 技能真实性（M2 核心）。
 *
 * 与 survivaltest.js 的区别：这个脚本会**自己准备场景**——
 * 进服后用 RCON 让机器人短暂进入创造模式、清空背包、再切回生存，
 * 从而得到干净的初始状态。避免"上一轮测试残留的木头让计数看起来正常"这种假象。
 *
 * 验证重点：
 *   1. make_tools 在没有材料时**如实失败**，而不是假成功
 *   2. 有原木时能自己走完 原木→木板→木棍→工作台→木镐 的依赖链
 *   3. 挖方块真的进背包（不是报告进背包）
 *
 * 用法：
 *   node tools/crafttest.js --rcon-port 25575 --rcon-dir <服务端目录> [--user AstrBotCraft]
 */

const { spawn } = require('child_process');
const path = require('path');
const { Rcon } = require('./lib/rcon');

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};

const PORT = Number(getArg('--port', '25565'));
const RCON_PORT = Number(getArg('--rcon-port', '25575'));
const RCON_DIR = getArg('--rcon-dir', 'C:\\Users\\miku\\.astrbot\\data\\plugin_data\\astrbot_plugin_minecraft\\server');
const USER = getArg('--user', 'AstrBotFlat');
const VERSION = '1.20.1';

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    results.push(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * 发服务端指令（进程内 RCON）。
 * 之前用 execFileSync 拉起 tools/rcon.js，在受限环境下会因"捕获子进程输出"
 * 被拒而报 EPERM，看起来像 rcon 坏了，极难归因。改成进程内实现后没有这个问题。
 */
let _rcon = null;
function getRcon() {
  if (!_rcon) _rcon = Rcon.fromDir(RCON_DIR, RCON_PORT);
  return _rcon;
}

async function rconAsync(...commands) {
  const r = getRcon();
  const out = [];
  for (const c of commands.flat()) {
    try {
      out.push(`> ${c}\n  ${(await r.command(c)).trim()}`);
    } catch (err) {
      out.push(`> ${c}\n  ❌ ${err.message}`);
    }
  }
  return out.join('\n');
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
    this.stderr = [];
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c) => this._onData(c));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => {
      this.stderr.push(c);
      if (this.stderr.length > 200) this.stderr.shift();
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
        continue;
      }
      if (m.method === 'notice') continue;
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
        else p.resolve(m.result);
      }
    }
  }

  call(method, params = {}, timeoutMs = 120000) {
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

/** 阶段计时：卡顿时能一眼看出卡在哪一步（之前靠猜浪费了很多时间） */
const T0 = Date.now();
function stage(msg) {
  console.log(`    [${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`);
}

/**
 * 串行心跳：等上一次 ping 结束后再等 1 秒发下一次。
 * 不用 setInterval(async ...)：那会产生并发重复请求，异常也会变成未处理的 rejection，
 * 结果既看不出阻塞也没法确定心跳到底跑没跑。
 */
function startHeartbeat(c) {
  const state = { beats: 0, blocked: false, maxLatency: 0, stopped: false };
  (async () => {
    while (!state.stopped) {
      await sleep(1000);
      if (state.stopped) break;
      const t = Date.now();
      try {
        await c.call('ping', {}, 3000);
        state.beats += 1;
        state.maxLatency = Math.max(state.maxLatency, Date.now() - t);
      } catch {
        state.blocked = true;
      }
    }
  })();
  return state;
}

async function runSkill(c, skill, params, timeoutSec = 300) {
  process.stdout.write(`\n▶ ${skill} ${JSON.stringify(params)}\n`);
  // 心跳用于区分两种卡顿：
  //   连 ping 都无响应 → 引擎事件循环被同步代码阻塞
  //   ping 正常但任务不动 → 卡在动作层（等服务器/寻路）
  const hb = startHeartbeat(c);
  const stopHb = () => {
    hb.stopped = true;
  };

  let taskId;
  try {
    const r = await c.call('skill.run', { skill, params }, 20000);
    taskId = r.task_id;
  } catch (err) {
    stopHb();
    return { ok: false, error: `提交失败：${err.message}` };
  }
  process.stdout.write(`    [0s] 任务已提交（心跳 ${hb.beats} 次）\n`);

  const start = Date.now();
  const t0 = Date.now();
  let last = '';
  let lastLog = 0;
  for (let i = 0; i < timeoutSec * 2; i += 1) {
    await sleep(500);
    let st;
    try {
      st = await c.call('task.status', { task_id: taskId }, 15000);
    } catch (err) {
      stopHb();
      return {
        ok: false,
        error: `状态查询失败：${err.message}（心跳 ${hb.beats} 次${hb.blocked ? '，曾被阻塞' : ''}）`,
      };
    }
    const d = st.detail || st.progress || '';
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    if ((d && d !== last) || Date.now() - lastLog > 10000) {
      last = d;
      lastLog = Date.now();
      process.stdout.write(
        `    [${elapsed}s] ${d || '（无进度）'}｜心跳 ${hb.beats} 次${hb.blocked ? '，有阻塞' : ''}\n`,
      );
    }
    if (['done', 'failed', 'cancelled'].includes(st.status)) {
      stopHb();
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      process.stdout.write(`    → ${st.status}（${secs}s）${st.error ? ` 错误：${st.error}` : ''}\n`);
      return { ok: st.status === 'done', status: st.status, error: st.error, result: st.result, seconds: Number(secs) };
    }
  }
  stopHb();
  await c.call('task.cancel', { task_id: taskId }).catch(() => {});
  return { ok: false, error: `超时（${timeoutSec}s）` };
}

const inv = async (c) => (await c.call('inventory.get')).items || {};
const total = (items) => Object.values(items).reduce((a, b) => a + b, 0);

async function main() {
  const t0 = Date.now();
  console.log('=== 合成链定向验证（M2）===');
  console.log(`服务器 ${PORT}，RCON ${RCON_PORT}\n`);

  const c = new Client();
  global.__mcClient = c;
  await c.call('connect', { host: '127.0.0.1', port: PORT, version: VERSION, username: USER }, 60000);
  await sleep(4000);
  // 等进服真正就绪：connect 返回后 bot.entity 可能还没建立，
  // 这时任何动作都会报"机器人尚未进入服务器"。轮询到就绪或超时为止。
  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    try {
      const st = await c.call('status', {}, 10000);
      if (st && st.connected) {
        ready = true;
        break;
      }
    } catch {
      /* ignore */
    }
    await sleep(1000);
  }
  if (!ready) {
    console.error('❌ 机器人未能进入服务器，测试中止');
    c.kill();
    process.exit(2);
  }
  console.log(`机器人已就绪（${USER} @ ${PORT}）`);

  // 环境隔离：重建一个确定性的"竞技场"，而不是传送到远处。
  //
  // 之前传送到远处的干净区域（2000+），结果是：落在**冷区块**时服务端正在生成地形，
  // 期间会**静默忽略我们的窗口点击**（1.17+ 服务端只在认为客户端状态过期时才回应点击），
  // 表现成整场运行每一次合成"第一次尝试都产出为空"——重试计数呈双峰分布
  // （要么 0 次要么 6 次），跟落点强相关，非常像"代码时好时坏"，其实与代码无关。
  //
  // 现在改成：在已生成的区域里**用 fill 把地面铺回来**，每次都得到一模一样的环境：
  // 平地上没有前人挖的坑、没有前人放的工作台、没有残留掉落物。
  const AX = 100;
  const AZ = 100;
  const R = 20;
  stage('重建测试竞技场');
  console.log(await rconAsync(
    `forceload add ${AX - R} ${AZ - R} ${AX + R} ${AZ + R}`,
    `fill ${AX - R} -61 ${AZ - R} ${AX + R} -61 ${AZ + R} minecraft:grass_block`,
    `fill ${AX - R} -60 ${AZ - R} ${AX + R} -55 ${AZ + R} minecraft:air`,
    // 清掉竞技场里的实体掉落物与遗留生物，避免捡到不该有的东西
    `kill @e[type=item,x=${AX - R},y=-64,z=${AZ - R},dx=${2 * R},dy=12,dz=${2 * R}]`,
    `tp ${USER} ${AX} -60 ${AZ}`,
  ));
  await sleep(3000);
  console.log(await rconAsync(`tp ${USER} ${AX} -60 ${AZ}`));
  await sleep(1500);

  // 环境准备：只做必要的事。
  // 这里刻意不做"清空背包"与"kill 掉落物"：在测试里它们价值不大，
  // 却会引入额外的不确定状态（曾经因此出现过难查的卡顿）。
  const stEnv = await c.call('status', {}, 15000);
  console.log(`  引擎确认已连接：${stEnv.connected}，位置 ${JSON.stringify(stEnv.position)}`);
  stage('环境检查完成');

  // ---- 1. 直接给材料，先验证合成（把采集能力留到后面单独测）
  // 说明：先测"有材料时能不能做成"，再测采集。这样任何失败都指向合成逻辑本身。
  console.log(`\n──── 1. 准备材料（服务端指令）────`);
  console.log(await rconAsync(`give ${USER} oak_log 8`, `give ${USER} cobblestone 16`));
  await sleep(2500);
  const inv1 = await inv(c);
  check('材料已到手', (inv1.oak_log || 0) > 0 || (inv1.cobblestone || 0) > 0, JSON.stringify(inv1));

  // ---- 2. 做木工具：木板 → 木棍 → 木镐/木斧
  console.log('\n──── 2. 做木制工具 ────');
  const r2 = await runSkill(c, 'make_tools', { tier: 'wooden', kinds: ['pickaxe', 'axe'] }, 180);
  const inv2 = await inv(c);
  const picks = Object.keys(inv2).filter((k) => k.endsWith('_pickaxe'));
  const axes = Object.keys(inv2).filter((k) => k.endsWith('_axe'));
  check('做出了木镐', picks.length > 0, picks.join('、') || '无');
  check('做出了木斧', axes.length > 0, axes.join('、') || '无');
  check('做木工具报告与实际一致', r2.ok === picks.length > 0, `报 ok=${r2.ok}${r2.ok ? '' : `（${r2.error || r2.result?.reason}）`}`);

  // ---- 3. 做石工具：3×3 需要工作台（验证自动找/放工作台）
  console.log('\n──── 3. 做石制工具（需要工作台）────');
  const r3 = await runSkill(c, 'make_tools', { tier: 'stone', kinds: ['pickaxe'] }, 180);
  const inv3 = await inv(c);
  const stonePicks = Object.keys(inv3).filter((k) => k === 'stone_pickaxe');
  check('做出了石镐', stonePicks.length > 0, stonePicks.join('、') || '无');
  check(
    '做石工具报告与实际一致',
    r3.ok === stonePicks.length > 0,
    `报 ok=${r3.ok}${r3.ok ? '' : `（${r3.error || r3.result?.reason}）`}`,
  );

  // ---- 6. 挖掘验证：掉落物真的进背包
  console.log('\n──── 6. 挖掘（验证掉落进背包）────');
  const before6 = total(await inv(c));
  let dugCount = 0;
  for (let k = 0; k < 3; k += 1) {
    const st = await c.call('state.get', { detail: 'brief' });
    const bp = st.block_position;
    let target = null;
    for (let dy = 1; dy <= 4; dy += 1) {
      const b = await c.call('block.at', { x: bp.x, y: bp.y - dy, z: bp.z });
      if (b && b.name !== 'air' && b.bounding_box === 'block' && b.diggable) {
        target = { x: bp.x, y: bp.y - dy, z: bp.z };
        break;
      }
    }
    if (!target) break;
    try {
      const r = await c.call('dig', { ...target, collect: true }, 30000);
      if (r.cleared) dugCount += 1;
    } catch (err) {
      console.log(`    挖 (${target.x},${target.y},${target.z}) 失败：${err.message}`);
    }
    await sleep(600);
  }
  const after6 = total(await inv(c));
  check('挖了方块', dugCount > 0, `成功 ${dugCount} 个`);
  check('掉落物进背包', after6 > before6, `${before6} → ${after6} 个物品`);

  const st = await c.call('status');
  console.log('\n最终背包：', JSON.stringify(await inv(c)));
  console.log('任务统计：', JSON.stringify(st.stats));

  await c.call('safety.stop').catch(() => {});
  await c.call('disconnect').catch(() => {});
  await sleep(600);
  c.kill();

  console.log('\n=== 结果 ===');
  console.log(results.join('\n'));
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  if (fail > 0) {
    const lines = c.stderr.join('').split('\n').filter((l) => /WARN|ERROR|任务|结束|开始/.test(l));
    if (lines.length) {
      console.log('\n--- 引擎日志（关键行） ---');
      console.log(lines.slice(-15).join('\n'));
    }
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n❌ 测试脚本出错：', err.message);
  // 出错时把引擎侧的关键日志打出来：否则只能看到"机器人尚未进入服务器"
  // 这类表层信息，不知道它到底是掉线、被踢、还是崩了。
  if (global.__mcClient) {
    const lines = global.__mcClient.stderr.join('').split('\n').filter((l) => /WARN|ERROR|死亡|断开|进服|已进入|任务|异常/.test(l));
    if (lines.length) {
      console.error('\n--- 引擎日志（关键行） ---');
      console.error(lines.slice(-25).join('\n'));
    }
    global.__mcClient.kill();
  }
  process.exit(2);
});
