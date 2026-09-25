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
    this.child = spawn(process.execPath, [path.join(__dirname, '..', 'engine', 'index.js')], {
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

  // spawnProtectionRadius: 0 —— 这个测试要在出生点附近挖方块；生产默认是 16（保护出生点），
  // 不显式关掉的话 dig 会被「出生点保护拦截」拒绝，测试会误报失败。
  await c.call('connect', { host: '127.0.0.1', port: PORT, version: '1.20.1', username: USER, spawnProtectionRadius: 0 }, 60000);
  await sleep(5000);

  // **先把她送到一片新区域**（这一轮加的）。
  //
  // 为什么必须：这个测试用的是**她的出生位置**，而她每次都出生在同一个世界出生点 ——
  // 那片地早就被历次测试挖光了。
  // 实测症状：连跑第 3 次报"一个圆石都没挖到（背包变化 {"dirt":2}）"——
  // **挖到的是泥土，说明那片已经没有石头了**。
  // 这和 test_pathfinding 的"六个场景共用一片地"、test_pit_escape 的固定坐标
  // 是同一个病：**测试之间没有隔离**。
  const AREA_X = 3000 + Math.floor(Math.random() * 6000);
  const AREA_Z = 3000 + Math.floor(Math.random() * 6000);
  await rcon.command(`forceload add ${AREA_X - 48} ${AREA_Z - 48} ${AREA_X + 48} ${AREA_Z + 32}`);
  await sleep(2000);
  // 铺一层石头地面（超平坦世界只有 4 层，下面直接是基岩，挖不到圆石）
  // **往上堆一个高台**，不是只铺 4 层。
  //
  // 踩过：第一版只铺 -64..-61（超平坦世界的 4 层），而 **-64 以下就是虚空**，
  // 挖不了更多 —— 于是测试**稳定地**报"只挖到圆石 ×6（目标 8）"，
  // 四次一模一样（稳定，但稳定地失败）。
  //
  // 堆到 -40 就有 25 层石头可挖。
  // **平台要够大**（这一轮从 33×33 扩到 81×81）。
  //
  // 踩过：原来是 ±16（33×33）—— 她盖房时走来走去，**掉下平台摔死**，
  // 于是 `build_shelter` 报 "建造被取消"、背包变成空的（死时掉落）。
  // 而**断言只看"庇护所建成没有"**，所以表现成"盖房超时/失败"，
  // 根因却是"她摔死了"—— 查了好几轮才看出来。
  //
  // 空中孤岛的边缘对她来说就是悬崖。要测"盖房"，就得先保证她**不会掉下去**。
  // **必须分片填** —— `/fill` 一次最多 32768 块。
  //
  // 踩过：81×81×25 = **164,025 块**，超了 5 倍 ——
  // 服务端**整条命令拒绝**（和之前那个 "out of this world" 是同一类：
  // **命令被拒 → 什么都不做 → 测出来的现象和"功能坏了"一模一样**）。
  // 实测症状：她站在**天然地面**上挖，背包变化是 `{"dirt":5}`（挖到泥土）。
  //
  // 每片按 x 切成 8 格宽：8×81×25 = 16,200 块 ✅ 在限制内。
  for (let fx = AREA_X - 40; fx <= AREA_X + 40; fx += 8) {
    await rcon.command(
      `fill ${fx} -64 ${AREA_Z - 40} ${Math.min(fx + 7, AREA_X + 40)} -40 ${AREA_Z + 40} minecraft:stone`,
    );
  }
  for (let fx = AREA_X - 40; fx <= AREA_X + 40; fx += 8) {
    await rcon.command(
      `fill ${fx} -39 ${AREA_Z - 40} ${Math.min(fx + 7, AREA_X + 40)} -20 ${AREA_Z + 40} minecraft:air`,
    );
  }
  // **底层铺基岩** —— 不然她能挖穿 -64 掉进虚空摔死。
  //
  // 踩过（和 `test_mine_return` 是同一个坑）：平台是 -64..-40 的石头，
  // 而**-64 以下就是虚空**。她拿到石镐之后往下挖，
  // 挖到 -64 再往下就是空气 → 掉出去 → **摔死**。
  // 表现是 `build_shelter` 报 "建造被取消"、**背包变成空的**（死时掉落）——
  // 看起来像"盖房失败"，根因却是"她摔死了"。
  for (let fx = AREA_X - 40; fx <= AREA_X + 40; fx += 8) {
    await rcon.command(
      `fill ${fx} -64 ${AREA_Z - 40} ${Math.min(fx + 7, AREA_X + 40)} -64 ${AREA_Z + 40} minecraft:bedrock`,
    );
  }
  await sleep(3000);
  await rcon.command(`tp ${USER} ${AREA_X + 0.5} -39 ${AREA_Z + 0.5}`);
  await sleep(2500);
  console.log(`  测试区域：(${AREA_X}, ${AREA_Z})`);

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
  // **补齐盖房要的材料**（这一轮加的）。
  //
  // 为什么：`build_shelter` 要**门**（6 块木板）和**火把**（要煤）。
  // 而测试区域是**纯石头平台**，**没有煤** —— 于是她到处找煤、直到超时。
  //
  // 实测：连跑时这一步**时好时坏** —— 有一次 3/3 全过，另一次就 timeout。
  // 那次能过是因为她碰巧在附近找到了什么。
  //
  // **这不是"放宽断言"**：断言仍然是"庇护所必须建成"。
  // 去掉的是一条**和测试目的无关的约束** ——
  // 这个测试要验的是"生存链（石头 → 石制工具 → 庇护所）能走通"，
  // 不是"她能不能在纯石头平台上找到煤"。
  await rcon.command(`give ${USER} oak_planks 16`);
  await rcon.command(`give ${USER} torch 8`);
  await rcon.command(`give ${USER} coal 8`);
  await sleep(1500);
  console.log('    （已补：木板 ×16、火把 ×8、煤 ×8 —— 盖房要用，纯石头平台上找不到）');
  const r3 = await c.call('skill.run', { skill: 'build_shelter', params: { size: 3 } });
  const t3 = await waitTask(c, r3.task_id, 420000);
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
  if (fail > 0 && c.logs && c.logs.length) {
    // **失败就把引擎 stderr 一起交出来**（原来 logs 收了但从不打印 ——
    // 红了之后引擎侧零线索。合成类失败的窗口/背包快照现在也走这里）
    const tail = c.logs
      .join('')
      .split('\n')
      .filter((l) => l.trim())
      .slice(-150);
    console.log(`--- 引擎日志（stderr 最近 ${tail.length} 行，失败现场）---`);
    for (const l of tail) console.log('  ' + l);
  }
  rcon.close();
  await c.call('disconnect').catch(() => {});
  await sleep(500);
  c.kill();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
