'use strict';
/**
 * 挖矿闭环测试（M2 最后一块空白）。
 *
 * 验证链路：造矿脉 → 挖矿技能找到并挖出矿石 → 收集 → 熔炼成锭。
 * 这是生存中期的核心能力，之前只在"找不到矿时如实报告"上验证过。
 *
 * 场景准备用引擎的 debug.seed_ores（借创造模式放置方块），
 * 这样不必手工搭一个带矿脉的世界，测试可重复。
 *
 * 用法：
 *   node tools/minetest.js --port 25566 --rcon-port 25576 --rcon-dir .testserver
 */

const { spawn } = require('child_process');
const path = require('path');
const { Rcon } = require('./lib/rcon');

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const PORT = Number(getArg('--port', '25566'));
const RCON_PORT = Number(getArg('--rcon-port', '25576'));
const RCON_DIR = getArg('--rcon-dir', '.testserver');
const USER = getArg('--user', 'AstrBotMine');
const VERSION = '1.20.1';

let pass = 0;
let fail = 0;
const results = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    results.push(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/**
 * 发服务端指令（进程内 RCON）。
 * 不用 execFileSync 拉子进程：受限环境会因"捕获子进程输出"被拒而报 EPERM，
 * 表现像 rcon 坏了，极难归因。
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
      out.push(`> ${c}\n  FAIL: ${err.message}`);
    }
  }
  return out.join('\n');
}

class Client {
  constructor() {
    this.child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MC_ENGINE_LOG_LEVEL: 'debug' },
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
      if (this.stderr.length > 400) this.stderr.shift();
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
const T0 = Date.now();
const stage = (msg) => console.log(`    [${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`);
const inv = async (c) => (await c.call('inventory.get')).items || {};

/** 串行心跳：区分"引擎事件循环被阻塞"与"卡在动作层" */
function startHeartbeat(c) {
  const st = { beats: 0, blocked: false, stopped: false };
  (async () => {
    while (!st.stopped) {
      await sleep(1000);
      if (st.stopped) break;
      try {
        await c.call('ping', {}, 3000);
        st.beats += 1;
      } catch {
        st.blocked = true;
      }
    }
  })();
  return st;
}

async function runSkill(c, skill, params, timeoutSec = 300) {
  console.log(`\n▶ ${skill} ${JSON.stringify(params)}`);
  const hb = startHeartbeat(c);
  let taskId;
  try {
    const r = await c.call('skill.run', { skill, params }, 30000);
    taskId = r.task_id;
  } catch (err) {
    hb.stopped = true;
    return { ok: false, error: `提交失败：${err.message}` };
  }
  const start = Date.now();
  let last = '';
  let lastLog = 0;
  for (let i = 0; i < timeoutSec * 2; i += 1) {
    await sleep(500);
    let st;
    try {
      st = await c.call('task.status', { task_id: taskId }, 20000);
    } catch (err) {
      hb.stopped = true;
      return {
        ok: false,
        error: `状态查询失败：${err.message}（心跳 ${hb.beats} 次${hb.blocked ? '，曾被阻塞' : ''}）`,
      };
    }
    const d = st.detail || st.progress || '';
    const el = ((Date.now() - start) / 1000).toFixed(0);
    if ((d && d !== last) || Date.now() - lastLog > 15000) {
      last = d;
      lastLog = Date.now();
      console.log(`    [${el}s] ${d || '（无进度）'}｜心跳 ${hb.beats}${hb.blocked ? '（有阻塞）' : ''}`);
    }
    if (['done', 'failed', 'cancelled'].includes(st.status)) {
      hb.stopped = true;
      console.log(`    → ${st.status}（${((Date.now() - start) / 1000).toFixed(1)}s）${st.error ? ` 错误：${st.error}` : ''}`);
      return { ok: st.status === 'done', status: st.status, error: st.error, result: st.result };
    }
  }
  hb.stopped = true;
  await c.call('task.cancel', { task_id: taskId }).catch(() => {});
  return { ok: false, error: `超时（${timeoutSec}s）` };
}

async function main() {
  console.log('=== 挖矿闭环测试（M2）===\n');
  const c = new Client();
  global.__mcClient = c;

  await c.call('connect', { host: '127.0.0.1', port: PORT, version: VERSION, username: USER }, 60000);
  await sleep(4000);
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
    console.error('❌ 机器人未能进入服务器');
    c.kill();
    process.exit(2);
  }
  console.log(`机器人已就绪（${USER} @ ${PORT}）`);
  stage('环境准备');

  // 环境：白天、不刷怪、给一把石镐与燃料
  console.log(await rconAsync('time set day', 'gamerule doMobSpawning false', 'gamerule doDaylightCycle false', 'weather clear'));
  stage('rcon 完成');

  // 清空背包：脚本会在进服时用会话里残留的物品数量算目标，不清理会导致
  // "要挖 4 个、已经有 13 个"这种自相矛盾的目标，测试结论没意义。
  stage('清空背包');
  try {
    const dr = await c.call('debug.dropall', {}, 60000);
    stage(`丢出 ${dr.dropped} 件物品`);
  } catch (err) {
    stage(`清空背包失败（继续）：${err.message}`);
  }
  await sleep(1000);
  await rconAsync('kill @e[type=item]');
  await sleep(800);

  const invBefore = await inv(c);
  check('背包已清空（否则目标数量算不准）', Object.keys(invBefore).length === 0, JSON.stringify(invBefore));

  // 造矿脉：用 rcon 的 fill 直接把矿石铺进地下。
  // 为什么不用引擎的创造模式放方块：Paper 服务端对 creative 模式的物品同步要求较严，
  // setInventory+placeBlock 组合拿不到可靠结果（实测放了 0 个）。
  // 用 fill 更直接，而且机器人全程保持生存模式，测试更接近真实。
  stage('用 rcon 造矿脉');
  let stSeed = await c.call('state.get', { detail: 'brief' });
  let bp = stSeed.block_position;
  const oreCmds = [];
  // 先强制加载矿脉所在区块。
  // 不加这一步时 fill 会静默失败（服务端回 "That position is not loaded"），
  // 表现成"矿脉没铺上、挖矿技能当然找不到矿"——很容易误判成引擎的问题。
  oreCmds.push(`forceload add ${bp.x - 12} ${bp.z - 12} ${bp.x + 12} ${bp.z + 12}`);

  // 场景布局：在**同一水平面**上挖一条矿道，两侧放矿。
  // 为什么不做"往地下挖"：超平坦测试世界只有 4 层（基岩+泥土+草），
  // 往下一两格就是基岩或世界边界，机器人会卡在窄缝里走不出来
  // （实测出现"131 秒找不到矿"）。水平矿道既符合真实挖矿场景，也不受高度限制。
  const tunnelY = bp.y - 1; // bot 脚下的那一层
  // 一条 9 格长的通道（沿 +x 方向），保证有站立空间
  oreCmds.push(`fill ${bp.x - 1} ${tunnelY} ${bp.z} ${bp.x + 9} ${tunnelY} ${bp.z} minecraft:air`);
  oreCmds.push(`fill ${bp.x - 1} ${tunnelY + 1} ${bp.z} ${bp.x + 9} ${tunnelY + 1} ${bp.z} minecraft:air`);
  // 通道两侧（±1 z）铺铁矿
  oreCmds.push(`fill ${bp.x + 1} ${tunnelY} ${bp.z - 1} ${bp.x + 9} ${tunnelY} ${bp.z - 1} minecraft:iron_ore`);
  oreCmds.push(`fill ${bp.x + 1} ${tunnelY} ${bp.z + 1} ${bp.x + 9} ${tunnelY} ${bp.z + 1} minecraft:iron_ore`);
  // 通道尽头与再下面一层也放一些，保证够 4 个
  oreCmds.push(`fill ${bp.x + 10} ${tunnelY} ${bp.z - 1} ${bp.x + 10} ${tunnelY} ${bp.z + 1} minecraft:iron_ore`);
  oreCmds.push(`fill ${bp.x + 1} ${tunnelY + 1} ${bp.z - 1} ${bp.x + 5} ${tunnelY + 1} ${bp.z + 1} minecraft:iron_ore`);
  console.log(await rconAsync(...oreCmds));
  await sleep(1500);

  // 关键：确认在生存模式，否则挖掘没有掉落物，后面的验证全是假的
  const st1 = await c.call('state.get', { detail: 'brief' });
  check('处于生存模式（否则挖掘掉落验证无效）', st1.gamemode === 'survival', `gamemode=${st1.gamemode}`);

  // 直接确认矿脉真的在世界里。
  // 注意：必须用**刚才造矿时**的坐标，机器人可能已经移动过，
  // 用当前位置去验证会读到错的方块（之前的版本就因此误报"场景未就绪"）。
  // 矿脉与矿道同层，直接查那一层
  const oreCheck = await c.call('block.at', { x: bp.x + 3, y: tunnelY, z: bp.z - 1 });
  const oreCheck2 = await c.call('block.at', { x: bp.x + 3, y: tunnelY, z: bp.z + 1 });
  check(
    '矿脉场景已就绪（世界里的方块确认）',
    !!oreCheck && oreCheck.name === 'iron_ore',
    `(${bp.x + 3},${tunnelY},${bp.z - 1}) = ${oreCheck ? oreCheck.name : '未加载'}；(${bp.x + 3},${tunnelY},${bp.z + 1}) = ${oreCheck2 ? oreCheck2.name : '未加载'}`,
  );
  // 机器人不能离矿脉太远，否则挖矿要先走很久
  const nowPos = (await c.call('state.get', { detail: 'brief' })).block_position;
  const distToVein = Math.hypot(nowPos.x - bp.x, nowPos.z - bp.z);
  check('机器人仍在矿脉附近', distToVein < 12, `距矿脉中心 ${distToVein.toFixed(1)} 格`);

  // 给工具：挖铁矿需要石镐及以上；再给点原木。
  // 原木是必须的：铁镐是 3×3 配方，需要工作台，工作台要木板，木板要原木。
  // 不给原木的话 make_tools 会诚实地报"需要工作台，但既没有工作台也没有原木"——
  // 那个行为是对的（超平坦世界没有树可砍），但那不是这个测试要验证的路径。
  await rconAsync(
    `give ${USER} stone_pickaxe 1`,
    `give ${USER} coal 8`,
    `give ${USER} furnace 1`,
    `give ${USER} oak_log 6`,
  );
  await sleep(2500);
  const inv1 = await inv(c);
  check('已获得石镐（挖铁的必要工具）', (inv1.stone_pickaxe || 0) > 0, JSON.stringify(inv1));
  check('已获得燃料（熔炼用）', (inv1.coal || 0) > 0, `coal=${inv1.coal || 0}`);
  check('已获得原木（做工作台用）', (inv1.oak_log || 0) >= 4, `oak_log=${inv1.oak_log || 0}`);

  // ---- 1. 挖矿技能
  console.log('\n──── 1. 挖 4 个铁矿 ────');
  const before = (await inv(c)).raw_iron || 0;
  const r1 = await runSkill(c, 'mine_ores', { ore: 'iron', count: 4 }, 300);
  const inv2 = await inv(c);
  const gotIron = (inv2.raw_iron || 0) - before;
  check('挖到了铁矿（粗铁）', gotIron > 0, `粗铁 +${gotIron}（现有 ${inv2.raw_iron || 0}）`);
  check(
    '挖矿报告与实际一致',
    r1.ok === gotIron > 0 || (r1.ok && gotIron > 0),
    `报 ok=${r1.ok}${r1.ok ? '' : `（${r1.error || r1.result?.reason}）`}`,
  );

  // ---- 2. 熔炼技能
  if (gotIron > 0) {
    console.log('\n──── 2. 熔炼粗铁 → 铁锭 ────');
    const r2 = await runSkill(c, 'smelt', { item: 'raw_iron', count: gotIron }, 240);
    const inv3 = await inv(c);
    check('熔炼出铁锭', (inv3.iron_ingot || 0) > 0, `铁锭 ${inv3.iron_ingot || 0} 个`);
    check('熔炼报告与实际一致', r2.ok === (inv3.iron_ingot || 0) > 0, `报 ok=${r2.ok}${r2.ok ? '' : `（${r2.error || r2.result?.reason}）`}`);

    // ---- 3. 用铁锭做铁镐（完整中期闭环）
    if ((inv3.iron_ingot || 0) >= 3) {
      console.log('\n──── 3. 用铁锭做铁镐 ────');
      const r3 = await runSkill(c, 'make_tools', { tier: 'iron', kinds: ['pickaxe'] }, 240);
      const inv4 = await inv(c);
      check('做出了铁镐', (inv4.iron_pickaxe || 0) > 0, `iron_pickaxe=${inv4.iron_pickaxe || 0}`);
      check('做铁镐报告与实际一致', r3.ok === (inv4.iron_pickaxe || 0) > 0, `报 ok=${r3.ok}${r3.ok ? '' : `（${r3.error || r3.result?.reason}）`}`);
    } else {
      console.log('\n（铁锭不足 3 个，跳过铁镐制作）');
    }
  } else {
    console.log('\n（没挖到铁矿，跳过熔炼与铁镐）');
  }

  const finalInv = await inv(c);
  console.log('\n最终背包：', JSON.stringify(finalInv));

  await c.call('safety.stop').catch(() => {});
  await c.call('disconnect').catch(() => {});
  await sleep(600);
  c.kill();

  console.log('\n=== 结果 ===');
  console.log(results.join('\n'));
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项，耗时 ${((Date.now() - T0) / 1000).toFixed(1)} 秒`);
  if (fail > 0) {
    const lines = c.stderr.join('').split('\n').filter((l) => /WARN|ERROR|任务|挖|熔炼/.test(l));
    if (lines.length) {
      console.log('\n--- 引擎日志（关键行） ---');
      console.log(lines.slice(-20).join('\n'));
    }
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\n❌ 测试脚本出错：', err.message);
  if (global.__mcClient) {
    const lines = global.__mcClient.stderr.join('').split('\n').filter((l) => /WARN|ERROR/.test(l));
    if (lines.length) {
      console.error('\n--- 引擎日志（关键行） ---');
      console.error(lines.slice(-15).join('\n'));
    }
    global.__mcClient.kill();
  }
  // 服务端为什么断开：这是判断"被踢"还是"网络问题"的唯一可靠依据
  try {
    const seen = await rconAsync('list');
    console.error('\n--- 服务端响应 ---');
    console.error(seen.trim());
  } catch {
    /* ignore */
  }
  process.exit(2);
});
