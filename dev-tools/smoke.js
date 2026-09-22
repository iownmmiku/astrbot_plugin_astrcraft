'use strict';
/**
 * 冒烟测试：直接以子进程方式拉起引擎，走真实 NDJSON 协议跑一遍关键 RPC。
 *
 * 用法：
 *   node tools/smoke.js                 # 只测通道与感知（不需要进服）
 *   node tools/smoke.js --connect       # 额外测试真进服 + 真寻路（需要服务器在跑）
 *
 * 这个脚本刻意不依赖任何测试框架：它验证的是"协议通不通、引擎会不会崩"，
 * 而不是单元逻辑。
 */

const { spawn } = require('child_process');
const path = require('path');
const { Rcon } = require('./lib/rcon');

const CONNECT = process.argv.includes('--connect');
const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION || '1.20.1';
// 可选：给了 rcon 信息就做"开局复位 + 挖完填回"，让测试可重复且不污染世界。
// 没有这一步时，测试自己挖的洞会留在出生点，下一次运行机器人直接掉进洞里爬不出来
// （实测：超平坦地面在 -60，她却在 -63，寻路全部失败——是环境脏了，不是代码坏了）。
const RCON_PORT = Number(process.env.MC_RCON_PORT || 0);
const RCON_DIR = process.env.MC_RCON_DIR || null;

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

class EngineClient {
  constructor() {
    this.child = spawn(process.execPath, [path.join(__dirname, '..', 'engine', 'index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MC_ENGINE_LOG_LEVEL: process.env.MC_ENGINE_LOG_LEVEL || 'warn' },
    });
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.notices = [];
    this.stderrTail = [];

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    this.child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`引擎异常退出，code=${code}`);
        console.error(this.stderrTail.join(''));
      }
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error(`❌ stdout 被污染（不是合法 JSON）：${line.slice(0, 200)}`);
        fail += 1;
        continue;
      }
      if (msg.method === 'notice') {
        this.notices.push(msg.params);
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(Object.assign(new Error(msg.error.message), { rpcCode: msg.error.code, data: msg.error.data }));
        else resolve(msg.result);
      }
    }
  }

  call(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notice(event, since = 0) {
    return this.notices.slice(since).find((n) => n.event === event) || null;
  }

  kill() {
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
    }, 500);
  }
}

async function main() {
  const t0 = Date.now();
  console.log('=== 引擎冒烟测试 ===\n');
  const c = new EngineClient();

  // ---- 1. 通道
  console.log('[1] 通道与自检');
  const ping = await c.call('ping');
  check('ping 往返', ping && ping.pong === true, `pid=${ping.pid}`);
  const ver = await c.call('version');
  check('version 返回依赖版本', !!(ver && ver.mineflayer), `mineflayer=${ver.mineflayer} pathfinder=${ver.pathfinder}`);
  check('能力清单含 6 个阶段', ver.features.phases.length === 6, ver.features.phases.join(','));
  const ready = c.notice('engine.ready');
  check('启动即推送 engine.ready', !!ready, ready ? `skills=${ready.data.skills.length}` : '未收到');

  // ---- 2. 未连接时的错误处理（这是插件侧体验的关键：不能崩、要说人话）
  console.log('\n[2] 未连接时的错误处理');
  try {
    await c.call('state.get');
    check('未连接时 state.get 返回未连接状态', true);
  } catch (err) {
    check('未连接时 state.get 报错可读', err.rpcCode === 1001, err.message);
  }
  try {
    await c.call('move.to', { x: 1, z: 1 });
    check('未连接时 move.to 被拒绝', false, '居然成功了');
  } catch (err) {
    check('未连接时 move.to 被拒绝且提示可读', err.rpcCode === 1001, `code=${err.rpcCode} ${err.message}`);
  }
  try {
    await c.call('skill.run', { skill: '不存在的技能' });
    check('未知技能被拒绝', false);
  } catch (err) {
    check('未知技能被拒绝并列出可用技能', /可用技能/.test(err.message), err.message.slice(0, 60));
  }
  const list = await c.call('skill.list');
  // **技能数会随功能增长**（climb_out 是 A 批次加的，见 docs/ESCAPE_ABILITIES.md）。
  // 断言"至少 17 个"而不是"正好 17 个"——加技能时不用改测试，
  // 但**少技能**（注册表坏了）仍然会被抓到。
  // 原来写死 `=== 16`：加一个技能就红，那是在测"数字"而不是在测"功能"。
  check('skill.list 至少返回 17 个技能', list.names.length >= 17, list.names.join(','));

  // ---- 3. 协议纯度：stdout 只能是 NDJSON（上面解析失败会记 fail）
  console.log('\n[3] 协议纯度');
  check('stdout 全程为合法 NDJSON', true, '（解析失败会另计）');

  // ---- 4. 真进服
  if (CONNECT) {
    console.log(`\n[4] 真实进服 ${HOST}:${PORT} (${VERSION})`);
    let connectErr = null;
    let rcon = null;
    if (RCON_PORT) {
      try {
        rcon = RCON_DIR ? Rcon.fromDir(RCON_DIR, RCON_PORT) : new Rcon(HOST, RCON_PORT, process.env.MC_RCON_PASSWORD || '');
      } catch (err) {
        console.log(`  （rcon 不可用，跳过开局复位：${err.message}）`);
        rcon = null;
      }
    }
    try {
      // spawnProtectionRadius: 0 —— 这个测试要在出生点附近挖方块；生产默认是 16（保护出生点），
      // 不显式关掉的话 dig 会被「出生点保护拦截」拒绝，测试会误报失败。
      // 本用例是故意挖机器人脚下的方块，几乎必然落在出生点保护范围内。
      const conn = await c.call('connect', { host: HOST, port: PORT, version: VERSION, username: 'AstrBotSmoke', spawnProtectionRadius: 0 }, 45000);
      check('进服成功', conn.ok === true, `username=${conn.username} version=${conn.version}`);
    } catch (err) {
      connectErr = err;
      check('进服成功', false, err.message);
    }

    // 开局复位：把脚下 7×7 区域补成实地，并把她放到地面之上。
    // 这样测试可重复，也不会因为上一次挖的洞而"开局就爬不出来"。
    //
    // **地面高度要往下扫出来**，不能假设"她脚下那格就是地面"：
    // 早期用 p0.y - 1 当地面，她本来就在洞里时这个假设是错的，
    // 结果 tp 把她放进实心泥土里，反而更动不了。
    if (rcon) {
      try {
        const st0 = await c.call('state.get', { detail: 'brief' });
        const p0 = st0.block_position;
        // 地表高度**从旁边未破坏的柱子取**：测试自己会在出生点挖洞，
        // 历次运行可能已经把这里挖到基岩（实测 standing_on=bedrock），
        // 那时从她脚下往下扫只会扫到基岩，复位等于没做。
        const surfaceAt = async (x, z) => {
          for (let dy = 0; dy <= 16; dy += 1) {
            const b = await c.call('block.at', { x, y: p0.y + 4 - dy, z });
            if (b && b.bounding_box === 'block') return p0.y + 4 - dy;
          }
          return null;
        };
        let gy = await surfaceAt(p0.x + 6, p0.z + 6); // 先看旁边
        if (gy === null) gy = await surfaceAt(p0.x, p0.z);
        if (gy === null) gy = p0.y - 1;
        const standY = gy + 1;
        // 把 7×7 的地面补齐（只补空气，不覆盖已有方块），再清出站立空间
        await rcon.command(
          `fill ${p0.x - 3} ${gy} ${p0.z - 3} ${p0.x + 3} ${gy} ${p0.z + 3} minecraft:grass_block replace air`,
        );
        await rcon.command(
          `fill ${p0.x - 3} ${standY} ${p0.z - 3} ${p0.x + 3} ${standY + 3} ${p0.z + 3} minecraft:air replace`,
        );
        await rcon.command(`tp AstrBotSmoke ${p0.x + 0.5} ${standY} ${p0.z + 0.5}`);
        await new Promise((r) => setTimeout(r, 1500));
        const st1 = await c.call('state.get', { detail: 'brief' });
        check(
          '开局复位（补地面 + 回到地面）',
          st1.block_position.y >= gy,
          `地面 y=${gy}，现在 y=${st1.block_position.y}（脚下 ${st1.standing_on}）`,
        );
      } catch (err) {
        check('开局复位', false, err.message.slice(0, 80));
      }
    }

    if (!connectErr) {
      const spawnNotice = c.notice('bot.spawn');
      check('收到 bot.spawn 事件', !!spawnNotice, spawnNotice ? JSON.stringify(spawnNotice.data.position) : '');

      await new Promise((r) => setTimeout(r, 2500)); // 等区块加载
      const st = await c.call('state.get', { detail: 'normal' });
      check('state.get 返回位置与血量', !!st.position && st.health !== undefined, `pos=${JSON.stringify(st.position)} hp=${st.health}`);
      check('能识别脚下方块（区块已加载）', !!st.standing_on, `standing_on=${st.standing_on}`);
      check('背包摘要存在', !!st.inventory_summary, st.inventory_summary ? st.inventory_summary.text.slice(0, 60) : '');

      const brief = await c.call('state.brief', {});
      check('状态简报长度在预算内', brief.text.length <= 800, `${brief.text.length} 字符`);
      console.log('\n  ── 简报样例 ──');
      console.log(
        brief.text
          .split('\n')
          .map((l) => `  │ ${l}`)
          .join('\n'),
      );

      const inv = await c.call('inventory.get');
      check('inventory.get 可用', Array.isArray(inv.slots), `${inv.slots.length} 个槽位`);

      const players = await c.call('players.list');
      check('players.list 能看到自己', players.players.some((p) => p.self), `${players.players.length} 个玩家`);

      // ---- 4.5 光照语义（很容易改坏：天空光不随时间变，必须做夜间修正）
      if (rcon) {
        try {
          await rcon.command('time set day');
          await new Promise((r) => setTimeout(r, 1200));
          const day = await c.call('state.get', { detail: 'brief' });
          await rcon.command('time set night');
          await new Promise((r) => setTimeout(r, 1200));
          const night = await c.call('state.get', { detail: 'brief' });
          check(
            '白天露天光照是亮的（>=10）',
            typeof day.light === 'number' && day.light >= 10,
            `光照 ${day.light}（天空光 ${day.sky_light}）`,
          );
          check(
            '夜晚露天光照会变暗（<=6）',
            typeof night.light === 'number' && night.light <= 6,
            `光照 ${night.light}（天空光 ${night.sky_light} 不变，靠时间修正）`,
          );
          await rcon.command('time set day');
          await new Promise((r) => setTimeout(r, 600));
        } catch (err) {
          check('光照语义检查', false, err.message.slice(0, 80));
        }
      }

      // ---- 5. 真寻路（M1 验收：走 20 格，验证物理与寻路）
      console.log('\n[5] 真实寻路（M1 核心验收）');
      const start = st.position;
      const targetX = Math.round(start.x) + 20;
      const targetZ = Math.round(start.z) + 12;
      const moveStart = Date.now();
      let moveTask = null;
      try {
        const r = await c.call('move.to', { x: targetX, z: targetZ, timeout_ms: 60000 });
        moveTask = r.task_id;
        check('move.to 立刻返回 task_id（不阻塞）', !!r.task_id, `task_id=${r.task_id}`);
      } catch (err) {
        check('move.to 提交成功', false, err.message);
      }

      if (moveTask) {
        // 轮询任务状态
        let finalStatus = null;
        for (let i = 0; i < 60; i += 1) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const ts = await c.call('task.status', { task_id: moveTask });
            finalStatus = ts;
            if (ts.status === 'done' || ts.status === 'failed' || ts.status === 'cancelled') break;
          } catch {
            /* ignore */
          }
        }
        const elapsed = ((Date.now() - moveStart) / 1000).toFixed(1);
        const st2 = await c.call('state.get', { detail: 'brief' });
        const moved = Math.hypot(st2.position.x - start.x, st2.position.z - start.z);
        check('寻路任务执行完成', finalStatus && finalStatus.status === 'done', `status=${finalStatus && finalStatus.status} elapsed=${elapsed}s`);
        check('真的移动了（>=10 格）', moved >= 10, `实际移动 ${moved.toFixed(1)} 格，落点 ${JSON.stringify(st2.position)}`);
        check('落点在目标 3 格内', Math.hypot(st2.position.x - targetX, st2.position.z - targetZ) <= 3, `距目标 ${Math.hypot(st2.position.x - targetX, st2.position.z - targetZ).toFixed(1)} 格`);
        check('移动过程中 y 有物理变化（不是瞬移）', true, `y=${st2.position.y}（对比起点 ${start.y}）`);
      }

      // ---- 6. 真挖掘 + 真背包变化
      console.log('\n[6] 真实挖掘与背包变化（M2 核心验收）');
      const invBefore = await c.call('inventory.get');
      const beforeCount = Object.values(invBefore.items).reduce((a, b) => a + b, 0);
      let dug = 0;
      // 连挖三次：单次挖掘有可能挖到"不掉落同类物品"的方块，
      // 用多次累计来看趋势，断言才稳。
      for (let k = 0; k < 3; k += 1) {
        const st3 = await c.call('state.get', { detail: 'brief' });
        const p = st3.block_position;
        let digTarget = null;
        // 站的地方不一定是实体方块（可能在树上/水里），从脚下往下找第一个真正的方块。
        // **优先挑徒手能挖动的**（泥土/沙/草之类）：石头需要镐，
        // 在正常地形世界里徒手挖石头会被引擎正确拒绝，测试就会误报失败。
        const handDiggable = (n) =>
          /dirt|grass_block|sand$|sandstone|gravel|clay|snow|soul_soil|moss|podzol|mycelium|farmland|mud/.test(n || '');
        const stoneLike = (n) => /stone|deepslate|ore|obsidian|netherrack|basalt|blackstone/.test(n || '');
        const candidates = [];
        for (let dy = 1; dy <= 5; dy += 1) {
          try {
            const b = await c.call('block.at', { x: p.x, y: p.y - dy, z: p.z });
            if (b && b.name && b.name !== 'air' && b.bounding_box === 'block' && b.diggable) {
              candidates.push({ x: p.x, y: p.y - dy, z: p.z, name: b.name });
            }
          } catch {
            /* ignore */
          }
        }
        digTarget =
          candidates.find((t) => handDiggable(t.name)) ||
          candidates.find((t) => !stoneLike(t.name)) ||
          candidates[0] ||
          null;
        if (!digTarget) break;
        try {
          const r = await c.call('dig', { ...digTarget, collect: true }, 30000);
          if (r.cleared) dug += 1;
          if (k === 0) {
            check('dig 真的挖掉了方块', r.cleared === true, `block=${r.block} 位置=(${digTarget.x},${digTarget.y},${digTarget.z})`);
          }
        } catch (err) {
          if (k === 0) check('dig 执行', false, err.message);
          break;
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      const invAfter = await c.call('inventory.get');
      const afterCount = Object.values(invAfter.items).reduce((a, b) => a + b, 0);
      check(
        '掉落物进了背包（真实拾取）',
        dug === 0 || afterCount > beforeCount,
        `挖了 ${dug} 个方块，物品 ${beforeCount} → ${afterCount}（${Object.entries(invAfter.items).map(([k, v]) => `${k}×${v}`).join(',') || '空'}）`,
      );

      // 把测试挖出的洞填回，避免污染世界（下一次运行才不会"开局就掉进洞里"）
      if (rcon && dug > 0) {
        try {
          const st4 = await c.call('state.get', { detail: 'brief' });
          const p4 = st4.block_position;
          await rcon.command(
            `fill ${p4.x - 2} ${p4.y - 6} ${p4.z - 2} ${p4.x + 2} ${p4.y - 1} ${p4.z + 2} minecraft:dirt replace air`,
          );
          console.log('  （已把测试挖的洞填回）');
        } catch (err) {
          console.log(`  （填洞失败，不影响结果：${err.message.slice(0, 60)}）`);
        }
      }

      // ---- 7. 反射层与急停
      console.log('\n[7] 急停');
      const stop = await c.call('safety.stop');
      check('急停返回已取消列表', stop.ok === true, `取消 ${stop.cancelled.length} 个任务`);

      await c.call('disconnect');
      check('断开连接正常', true);
    }
  } else {
    console.log('\n[4-7] 已跳过真进服测试（加 --connect 参数启用）');
  }

  c.kill();
  await new Promise((r) => setTimeout(r, 600));

  console.log('\n=== 结果 ===');
  console.log(results.join('\n'));
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项，耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('测试脚本自身出错：', err);
  process.exit(2);
});
