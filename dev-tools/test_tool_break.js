'use strict';
/**
 * 工具损坏检测的测试（W4，见 docs/PLAN_v2.md）。
 *
 * **为什么要自己盯**：实测确认 **mineflayer 没有 `itemBreak` 事件**——
 * 我第一版猜了这个名字，结果镐子确实坏了、背包里没了，但事件一次都没发出来。
 * 所以改成在反射层里两拍比较：上一拍拿着快坏的工具、这一拍它不见了、
 * 而且背包里也确实没有了 → 判定损坏。
 *
 * 这个测试直接测那段逻辑（不依赖真的把镐子挖坏——那在游戏里很难稳定复现，
 * 我试了两次都没把耐久刚好用光）。
 *
 * 要钉住的边界：
 *   1. 快坏的工具消失 + 背包里没了 → 报损坏
 *   2. **换手不算损坏**（工具还在背包里）
 *   3. **耐久还多的时候消失不算**（可能是收起来了）
 *   4. 拿不到耐久信息时**宁可漏报不误报**
 */

const path = require('path');
const { McEngine } = require(path.join(__dirname, '..', 'engine', 'bot.js'));

let pass = 0;
let fail = 0;
const ok = (m, c, d = '') => {
  if (c) {
    pass += 1;
    console.log(`  ✅ ${m}${d ? ` — ${d}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${m}${d ? ` — ${d}` : ''}`);
  }
};

/** 造一个够用的引擎：只带 _toolBreakTick 需要的东西 */
function makeEngine({ heldItem = null, bag = {} } = {}) {
  const e = Object.create(McEngine.prototype);
  e.bot = { entity: { position: { x: 0, y: 64, z: 0 } }, heldItem };
  e.actions = { countItem: (name) => bag[name] || 0 };
  e._emitted = [];
  e._emit = (name, payload) => e._emitted.push({ name, payload });
  e._pos = () => ({ x: 0, y: 64, z: 0 });
  e._lastHeldTool = null;
  return e;
}

/** 造一个"手上拿着某工具"的对象 */
const tool = (name, left, max = 1561) => ({
  name,
  durabilityUsed: max - left,
  maxDurability: max,
});

console.log('=== 快坏的工具消失 + 背包里没了 → 报损坏 ===');
{
  const e = makeEngine({ heldItem: tool('diamond_pickaxe', 1), bag: { diamond_pickaxe: 1 } });
  e._toolBreakTick(); // 第一拍：记下"拿着快坏的镐子"
  ok('第一拍不发事件（还不知道会不会坏）', e._emitted.length === 0, `发了 ${e._emitted.length} 条`);
  // 第二拍：镐子没了，背包里也没了
  e.bot.heldItem = null;
  e.actions.countItem = () => 0;
  e._toolBreakTick();
  const ev = e._emitted.find((x) => x.name === 'tool.broken');
  ok('第二拍报了 tool.broken', !!ev, JSON.stringify(e._emitted.map((x) => x.name)));
  ok('事件里带了工具名', ev && ev.payload && ev.payload.item === 'diamond_pickaxe', ev ? String(ev.payload.item) : '');
}

console.log('\n=== 换手不算损坏（工具还在背包里）===');
{
  const e = makeEngine({ heldItem: tool('iron_pickaxe', 1), bag: { iron_pickaxe: 1 } });
  e._toolBreakTick();
  // 换成别的（镐子还在背包里）
  e.bot.heldItem = tool('diamond_sword', 1500);
  e._toolBreakTick();
  ok(
    '不报损坏（它只是被换下去了）',
    !e._emitted.some((x) => x.name === 'tool.broken'),
    '只看"手上没了"会把换手误判成损坏',
  );
}

console.log('\n=== 耐久还多的时候消失不算（可能是收起来了）===');
{
  const e = makeEngine({ heldItem: tool('iron_pickaxe', 900), bag: { iron_pickaxe: 1 } });
  e._toolBreakTick();
  e.bot.heldItem = null;
  e.actions.countItem = () => 0;
  e._toolBreakTick();
  ok(
    '不报损坏（耐久还多，不像"用坏了"）',
    !e._emitted.some((x) => x.name === 'tool.broken'),
    '上一拍剩 900 点耐久，不该判定为损坏',
  );
}

console.log('\n=== 拿不到耐久信息时宁可漏报不误报 ===');
{
  const e = makeEngine({
    heldItem: { name: 'stone_pickaxe' }, // 没有 durabilityUsed / maxDurability
    bag: { stone_pickaxe: 1 },
  });
  e._toolBreakTick();
  e.bot.heldItem = null;
  e.actions.countItem = () => 0;
  e._toolBreakTick();
  ok(
    '不报损坏（不知道耐久就不猜）',
    !e._emitted.some((x) => x.name === 'tool.broken'),
    '漏报比误报好：误报会让她以为工具坏了去重做',
  );
}

console.log('\n=== 一直拿着没坏就不报 ===');
{
  const e = makeEngine({ heldItem: tool('iron_pickaxe', 2), bag: { iron_pickaxe: 1 } });
  for (let i = 0; i < 5; i += 1) e._toolBreakTick();
  ok('连着 5 拍都不报', e._emitted.length === 0, `发了 ${e._emitted.length} 条`);
}

console.log('\n=== 没有 bot 时不炸 ===');
{
  const e = Object.create(McEngine.prototype);
  e.bot = null;
  e._lastHeldTool = null;
  let threw = false;
  try {
    e._toolBreakTick();
  } catch (err) {
    threw = true;
  }
  ok('bot 为 null 不抛异常', !threw);
}

console.log('\n=== 反射层确实调了它（源码断言）===');
{
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'bot.js'), 'utf8');
  ok('反射层里调了 _toolBreakTick', /this\._toolBreakTick\(\)/.test(src));
  ok(
    '注释里写明了 mineflayer 没有 itemBreak（免得以后有人又去猜）',
    /mineflayer 没有 itemBreak/.test(src),
  );
}

// Exercise real action selection with the installed Minecraft registry. The I/O
// fixture deliberately leaves the held item unchanged when equipment fails.
const assert = require('node:assert/strict');
const { Actions, NoToolError, ProtectedBlockError } = require('../engine/actions');
const { vec3, CancelledError } = require('../engine/util');
const data = require('../engine/node_modules/minecraft-data')('1.20.1');
const actionTests = [];
const actionTest = (name, run) => actionTests.push({ name, run });
const inventoryTool = (name, slot, used = 0) => ({ ...data.itemsByName[name],
  type: data.itemsByName[name].id, name, slot, count: 1, durabilityUsed: used });
const bread = () => ({ ...data.itemsByName.bread, type: data.itemsByName.bread.id, slot: 36, count: 1 });

function actionFixture({ name = 'iron_ore', items = [], held = items[0], equipError = null,
  lookHook = null } = {}) {
  let removed = false, digs = 0, equips = 0;
  const position = vec3(1, 1, 0);
  const block = { ...data.blocksByName[name], name, position, diggable: name !== 'bedrock' };
  const bot = {
    registry: data, entity: { position: vec3(0.5, 1, 0.5), onGround: true }, heldItem: held,
    inventory: { items: () => items },
    blockAt: () => removed ? { ...data.blocksByName.air, name: 'air', position } : block,
    canDigBlock: () => true,
    async equip(item) { equips++; if (equipError) throw equipError; bot.heldItem = item; },
    async unequip() { bot.heldItem = null; },
    async lookAt() { if (lookHook) await lookHook(bot); },
    async dig() { digs++; removed = true; },
    stopDigging() {},
  };
  const config = { get: (key) => ({ humanize: false, spawnProtectionRadius: 0,
    digBlacklist: [], digWhitelist: [] })[key] };
  const actions = new Actions({ bot, config, navigator: { stop() {} } });
  return { bot, block, actions, get digs() { return digs; }, get equips() { return equips; },
    dig: () => actions.dig({ x: 1, y: 1, z: 0, collect: false }) };
}

actionTest('failed equipment cannot mine iron with the unrelated held axe', async () => {
  const wrong = inventoryTool('diamond_axe', 36), valid = inventoryTool('stone_pickaxe', 10);
  const f = actionFixture({ items: [wrong, valid], equipError: new Error('server refused equipment') });
  await assert.rejects(f.dig(), NoToolError);
  assert.equal(f.digs, 0);
});
actionTest('failed upgrade may keep mining with the valid held stone pickaxe', async () => {
  const held = inventoryTool('stone_pickaxe', 36), upgrade = inventoryTool('iron_pickaxe', 10);
  const f = actionFixture({ items: [held, upgrade], equipError: new Error('server refused equipment') });
  const result = await f.dig();
  assert.equal(result.cleared, true); assert.equal(result.tool_used, 'stone_pickaxe');
  assert.equal(f.digs, 1);
});
actionTest('golden pickaxe cannot harvest iron ore', async () => {
  const f = actionFixture({ items: [inventoryTool('golden_pickaxe', 36)] });
  await assert.rejects(f.dig(), NoToolError); assert.equal(f.digs, 0);
});
actionTest('golden pickaxe can still harvest stone without a pointless upgrade', async () => {
  const f = actionFixture({ name: 'stone', items: [inventoryTool('golden_pickaxe', 36)] });
  assert.equal((await f.dig()).tool_used, 'golden_pickaxe');
  assert.equal(f.equips, 0); assert.equal(f.digs, 1);
});
actionTest('tool removed while turning is rechecked before the destructive action', async () => {
  const f = actionFixture({ items: [inventoryTool('stone_pickaxe', 36)],
    lookHook: (bot) => { bot.heldItem = bread(); } });
  await assert.rejects(f.dig(), NoToolError); assert.equal(f.digs, 0);
});
actionTest('turning cancellation cannot continue into block destruction', async () => {
  const f = actionFixture({ items: [inventoryTool('stone_pickaxe', 36)],
    lookHook: () => { throw new CancelledError('turning operation cancelled'); } });
  await assert.rejects(f.dig(), CancelledError); assert.equal(f.digs, 0);
});
actionTest('ordinary turning failure still permits a correctly equipped harvest', async () => {
  const f = actionFixture({ items: [inventoryTool('stone_pickaxe', 36)],
    lookHook: () => { throw new Error('temporary view lock'); } });
  assert.equal((await f.dig()).cleared, true); assert.equal(f.digs, 1);
});
actionTest('equipment cancellation is propagated without retries', async () => {
  const f = actionFixture({ items: [inventoryTool('stone_pickaxe', 36)],
    equipError: new CancelledError('old equipment operation cancelled') });
  await assert.rejects(f.actions.holdItem({ item: 'stone_pickaxe' }), CancelledError);
  assert.equal(f.equips, 1);
});
actionTest('a last-point wooden axe is usable when it is the only suitable tool', async () => {
  const axe = inventoryTool('wooden_axe', 10, data.itemsByName.wooden_axe.maxDurability - 1);
  const held = bread(), f = actionFixture({ name: 'spruce_log', items: [held, axe] });
  await f.actions.equipBestToolFor(f.block);
  assert.equal(f.bot.heldItem, axe);
});
actionTest('a fully exhausted inventory tool does not count as a harvest tool', () => {
  const broken = inventoryTool('stone_pickaxe', 10, data.itemsByName.stone_pickaxe.maxDurability);
  const f = actionFixture({ items: [bread(), broken] });
  assert.equal(f.actions._hasToolFor(f.block), false);
});
actionTest('block harvest metadata remains authoritative if a registry lookup is unavailable', () => {
  const f = actionFixture({ items: [inventoryTool('golden_pickaxe', 36)] });
  f.bot.registry = {};
  assert.equal(f.actions._hasToolFor(f.block), false);
});
actionTest('bedrock rejection performs no equipment or destructive action', async () => {
  const f = actionFixture({ name: 'bedrock', items: [inventoryTool('diamond_pickaxe', 36)] });
  await assert.rejects(f.dig(), ProtectedBlockError);
  assert.equal(f.equips, 0); assert.equal(f.digs, 0);
});

(async () => {
  console.log('\n=== 工具装备与真实采掘条件 ===');
  for (const { name, run } of actionTests) {
    try { await run(); ok(name, true); }
    catch (err) { ok(name, false, err.message); }
  }
  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exitCode = fail > 0 ? 1 : 0;
})().catch((err) => { console.error(err); process.exitCode = 1; });
