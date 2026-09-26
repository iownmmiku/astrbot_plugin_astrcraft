'use strict';
/**
 * **挖矿之后能不能自己回到地面**（用户实测反馈："每次挖矿之后都没法自己回到地面"）。
 *
 * 这个测试只问一件事：**让她挖矿，挖完她在哪？**
 *   · 在地面（y 接近地表）→ ✅
 *   · 还在自己挖的竖井里 → ❌ 这就是用户报的问题
 */

const path = require('path');
const { spawn } = require('child_process');
const { Rcon } = require('./lib/rcon');
const { buildPlatform, assertBlockAt } = require('./lib/fixture');

const PORT = Number(process.env.MC_PORT || 25566);
const RCON_DIR = process.env.MC_RCON_DIR || path.join(__dirname, '..', '.testserver');

const child = spawn(process.execPath, [path.join(__dirname, '..', 'engine', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, MC_ENGINE_LOG_LEVEL: 'info' },
});
let buf = '';
let id = 1;
const pending = new Map();
const finished = [];
const logs = [];
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.method === 'notice') {
      const p = m.params || {};
      if (p.event === 'task.finished') finished.push(p.data || {});
      continue;
    }
    const q = pending.get(m.id);
    if (q) {
      pending.delete(m.id);
      if (m.error) q.reject(new Error(m.error.message));
      else q.resolve(m.result);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => logs.push(String(c)));

const call = (method, params = {}, t = 300000) =>
  new Promise((res, rej) => {
    const i = id++;
    const tm = setTimeout(() => rej(new Error('timeout ' + method)), t);
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
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const rcon = Rcon.fromDir(RCON_DIR, 25576);
  const USER = 'Mine' + Math.floor(Math.random() * 9000);
  const X = 500;
  await call('connect', { host: '127.0.0.1', port: PORT, version: '1.20.1', username: USER }, 60000);
  await sleep(6000);

  // **在世界高度范围内堆一个平台**（这一轮修对的）。
  //
  // 踩过的两个坑：
  //   ① 未加载区块里的 `/fill` **静默无效**
  //   ② **`y=-70` 超出世界高度** → 服务端直接回 "That position is out of this world!"，
  //      **整条命令被拒绝**、什么都不铺。实测她脚下读到天然 bedrock 就是这个原因。
  //      超平坦世界的最低建筑高度是 **-64**。
  //
  // 做法：把 -64..-50 铺成石头（她在 -49 站着，下面是 15 格可挖的石头），
  // 上面清空。
  // 平台/材料准备走**公共 fixture**（dev-tools/lib/fixture.js）——
  // 分片 fill、底层基岩、81×81 这些坑原来在测试里各写一份，
  // 现在实现和注释都只有一份（buildPlatform 内部自带 forceload）。
  await sleep(2000);
  await buildPlatform(rcon, { x: X, z: 0, half: 10, stoneTop: -50, clearTop: -30 });
  await sleep(2500);
  await rcon.command(`give ${USER} stone_pickaxe 1`);
  await sleep(1200);
  await rcon.command(`tp ${USER} ${X + 0.5} -49 0.5`);
  await sleep(2500);
  // **断言必须在 tp 之后** —— 踩过：放在 tp 前时 bot 还在出生点，
  // (X,-50,0) 的区块从没流进客户端 → `block.at` 永远"未加载" → 断言误炸。
  // （survival 的同款断言放在 tp 后，所以它是绿的 —— 抄的时候顺序抄错了。）
  await assertBlockAt(call, X, -50, 0, 'stone'); // 平台面必须是石头（不符直接炸）

  const st0 = await call('state.get', { detail: 'brief' });
  console.log(`=== 挖矿之后能不能回地面 ===`);
  console.log(`  起点：y=${st0.position.y.toFixed(1)}（平台面 y=-49），脚下 ${st0.standing_on}`);
  // **自检**：场景必须真的造出来了，否则后面测什么都不可信
  if (String(st0.standing_on) !== 'stone') {
    console.log(`  ⚠️ 场景没造对（脚下是 ${st0.standing_on}，应该是 stone）——结果不可信`);
  }

  // 让她挖 8 个圆石（会往下挖出竖井）
  const mark = finished.length;
  await call('skill.run', { skill: 'mine_stone', params: { want: 8 } }, 60000);
  // 600 → 960（300 → 480 秒）：和引擎 skillTimeoutMs 对齐 ——
  // 实测连续 5 次失败全是时钟（k29「技能执行超时」时她差 4 格到顶），
  // 预算要覆盖「挖矿 ~100 秒 + 极限竖井 11 格 × 15~20 秒」。
  // **位置断言没动**：她仍然必须真的爬回平台才算过。
  for (let i = 0; i < 960 && finished.length === mark; i += 1) await sleep(500);
  const f = finished[mark];
  const st1 = await call('state.get', { detail: 'brief' });
  const y = st1.position.y;
  console.log(`  任务：${f ? f.status : '?'}`);
  console.log(`  结果：${String((f && f.result && f.result.note) || (f && f.error) || '').slice(0, 140)}`);
  console.log(`  挖完她在：y=${y.toFixed(1)}（平台面 y=-49）`);
  // **把爬升相关的日志打出来**（这些原来用 log.debug，默认看不到）
  const tail = logs.join('');
  const hits = tail.split('\n').filter((l) => /垫脚|挖台阶|爬|阶梯|侧洞|竖井/.test(l));
  console.log(`  --- 爬升日志（${hits.length} 行）---`);
  for (const l of hits.slice(-10)) console.log(`    ${l.trim().slice(0, 130)}`);
  if (!hits.length) console.log('    （**一行都没有** → 爬升代码根本没跑到）');

  // **关键检查：挖到的圆石到底在不在背包里**（这一轮加的）。
  //
  // 为什么查这个：爬升失败时说"**没有方块可以垫脚**"，可她**刚挖了 20 个圆石**。
  // 要么是"挖到了但没进背包"（掉落物没捡起来），要么是读取的方式不对。
  // 这决定了该修哪一边 —— 是修"捡掉落物"还是修"找方块的判据"。
  const inv = await call('inventory.get').catch(() => null);
  // **`items` 可能是对象（按名字计数）也可能是数组** —— 两种都处理，
  // 第一版只按数组写，直接 `items.find is not a function` 崩了。
  const rawItems = (inv && inv.items) || {};
  const items = Array.isArray(rawItems)
    ? rawItems.map((it) => ({ name: String(it.name), count: Number(it.count) || 0 }))
    : Object.entries(rawItems).map(([name, count]) => ({ name, count: Number(count) || 0 }));
  const cobble = items.find((it) => String(it.name).includes('cobblestone'));
  console.log(`  背包里 ${items.length} 种东西：${items.slice(0, 8).map((i) => `${i.name}×${i.count}`).join('、') || '（空的）'}`);
  console.log(
    cobble
      ? `  ✅ 圆石在背包里：${cobble.name}×${cobble.count}`
      : `  ❌ **圆石不在背包里** —— "挖到 20 个"只是计数，东西没捡起来`,
  );
  // 再看她脚下和四周是什么（判断"侧面挖不动"合不合理）
  const bp = st1.block_position;
  console.log(`  她那一格 (${bp.x}, ${bp.y}, ${bp.z})，脚下 ${st1.standing_on}`);
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const b = await call('block.at', { x: bp.x + dx, y: bp.y, z: bp.z + dz }).catch(() => null);
    const b2 = await call('block.at', { x: bp.x + dx, y: bp.y + 1, z: bp.z + dz }).catch(() => null);
    console.log(`    旁边 (${dx},${dz})：脚=${b && b.name} 头=${b2 && b2.name}`);
  }

  let pass = 0;
  let fail = 0;
  // **判据只看她自己的 y**（别把"平台面 y=-49"那句话也匹配进去 ——
  // 我第一版用正则 `y=-4[89]` 去 grep 整行，结果 `y=-88.1（平台面 y=-49）`
  // 也被判成成功，测出来全是假的）。
  // **-50 也算出来了**：平台石头的顶面在 -50，所以"站在平台上"是 -49；
  // 站在 -50 意味着她站在 -51 那块上、人在一个 1 格深的凹里 —— 跳一下就上来，
  // 对"回到地面"这个目的来说**算成功**。第一版卡 -49.5 太严，把这种情况误判成失败。
  if (y >= -50.5 && y <= -45) {
    pass += 1;
    console.log(`  ✅ 挖完回到地面了（y=${y.toFixed(1)}）`);
  } else if (y < -60) {
    fail += 1;
    console.log(`  ❌ **掉下去了**（y=${y.toFixed(1)}，平台面 -49）—— 她没在往上爬，是在往下掉`);
  } else {
    fail += 1;
    console.log(`  ❌ **还在竖井里**（y=${y.toFixed(1)}，比平台低 ${(-49 - y).toFixed(0)} 格）—— 这就是用户报的问题`);
  }

  // 再看她有没有"意识到自己在下面"（结果里应该提到）
  const note = String((f && f.result && f.result.note) || '');
  if (/爬回地面|还在地下|爬上去/.test(note)) {
    pass += 1;
    console.log('  ✅ 结果里说明了"回地面"这件事');
  } else {
    fail += 1;
    console.log('  ⚠️ 结果里没提"回地面"（她自己和玩家都不知道她还在下面）');
  }

  rcon.close();
  await call('disconnect').catch(() => {});
  await sleep(500);
  child.kill();
  await sleep(1500);
  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.message);
  child.kill();
  process.exit(1);
});
