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

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
