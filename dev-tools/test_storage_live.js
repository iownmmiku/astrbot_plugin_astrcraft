'use strict';

// Same-world furniture memory, production travel and server inventory transfers.
const assert = require('node:assert/strict');
const mineflayer = require('../engine/node_modules/mineflayer');
const { Rcon } = require('./lib/rcon');
const { Config } = require('../engine/config');
const { Actions } = require('../engine/actions');
const { Navigator } = require('../engine/movement');
const { StationMemory } = require('../engine/stations');
const { StateTracker } = require('../engine/state');
const skills = require('../engine/skills');
const { SkillContext } = require('../engine/skills/common');
const { storeItems } = require('../engine/skills/gathering');
const { vec3, delay, CancelledError } = require('../engine/util');

(async () => {
  const rcon = Rcon.fromDir('.testserver', Number(process.env.MC_RCON_PORT || 25576));
  const controller = new AbortController(), deadline = Date.now() + 100000;
  const abort = () => controller.abort();
  const watchdog = setTimeout(abort, 100000);
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const username = `AstrStor${Math.random().toString(36).slice(2, 7)}`;
  const x = 50000 + Math.floor(Math.random() * 100) * 80, z = x;
  const area = `${x - 8} ${z - 8} ${x + 72} ${z + 8}`;
  let bot, actions, nav, state, fixtureLoaded = false;
  const check = () => { if (controller.signal.aborted) throw new CancelledError('live storage fixture cancelled or timed out'); };
  const command = async (text) => { check(); const result = await rcon.command(text, 4000); check(); return result; };
  const waitFor = async (predicate, description, timeoutMs = 8000) => {
    const until = Math.min(deadline, Date.now() + timeoutMs);
    while (Date.now() < until) {
      check(); if (predicate()) return;
      await delay(100, { signal: controller.signal });
    }
    assert.ok(predicate(), description);
  };
  const position = (offset) => ({ x: x + offset, y: 74, z });
  const contents = async (pos) => {
    const container = await actions.openContainer({ ...pos, signal: controller.signal, reach: false });
    try { return container.describe().items; } finally { container.win.close(); }
  };
  try {
    bot = mineflayer.createBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT || 25566),
      username, version: '1.20.1', auth: 'offline' });
    bot.loadPlugin(require('../engine/node_modules/mineflayer-pathfinder').pathfinder);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('storage spawn timeout')), 15000);
      const finish = (error) => { clearTimeout(timer); bot.removeListener('spawn', spawned); bot.removeListener('error', failed);
        error ? reject(error) : resolve(); };
      const spawned = () => finish(), failed = (error) => finish(error);
      bot.once('spawn', spawned); bot.once('error', failed);
    });
    bot.on('error', (error) => { console.error(error.message); controller.abort(); });
    if (process.env.MC_STORAGE_DEBUG === '1') {
      bot._client.on('packet', (packet, meta) => {
        if (['open_window', 'close_window', 'window_items'].includes(meta.name)) {
          console.log('container incoming', meta.name, packet.windowId, packet.stateId);
        }
      });
      const write = bot._client.write;
      bot._client.write = function (name, packet) {
        if (['block_place', 'close_window'].includes(name)) console.log('container outgoing', name,
          packet.windowId ?? packet.location, 'held', bot.heldItem?.name, 'using', bot.usingHeldItem,
          'position', bot.entity.position.minus(vec3(x, 0, z)), 'sneak', bot.getControlState('sneak'));
        return write.call(this, name, packet);
      };
    }
    await command(`forceload add ${area}`); fixtureLoaded = true;
    await delay(1000, { signal: controller.signal });
    const setup = [
      `gamemode creative ${username}`,
      `fill ${x - 6} 73 ${z - 6} ${x + 66} 73 ${z + 6} stone`,
      `fill ${x - 6} 74 ${z - 6} ${x + 66} 80 ${z + 6} air`,
      `setblock ${x + 48} 74 ${z} chest`, `tp ${username} ${x + 0.5} 74 ${z + 0.5}`,
      `clear ${username}`, `give ${username} cobblestone 16`, `give ${username} coal 8`,
      `give ${username} bread 4`, `give ${username} stone_pickaxe 1`, `gamemode survival ${username}`,
    ];
    for (const text of setup) await command(text);
    const config = new Config(); config.update({ humanize: false, spawnProtectionRadius: 0,
      allowDigInPath: false, allowPlaceInPath: false });
    nav = new Navigator(bot, config); actions = new Actions({ bot, config, navigator: nav }); nav.attachActions(actions);
    const stations = new StationMemory();
    stations.bindScope(() => ({ server: `${bot._client.socket.remoteAddress}:${bot._client.socket.remotePort}`,
      dimension: bot.game.dimension }));
    actions.stations = stations;
    stations.remember('chest', position(48));
    await waitFor(() => bot.blockAt(vec3(x, 73, z))?.name === 'stone' && actions.countItem('cobblestone') === 16 &&
      Math.abs(bot.entity.position.x - x - 0.5) < 0.2 && bot.entity.onGround, 'actual empty start area, inventory and settled body');
    const findNearby = () => bot.findBlock({ matching: (b) => b && ['chest', 'barrel', 'trapped_chest'].includes(b.name), maxDistance: 32 });
    assert.equal(findNearby(), null, 'remembered chest starts outside actual 32-block search');
    const run = (params = {}) => storeItems({ actions, nav, ctx: new SkillContext({ signal: controller.signal, deadline }), ...params });
    const stored = await run();
    assert.equal(stored.ok, true, stored.reason);
    assert.deepEqual(stored.consumed, { cobblestone: 16 });
    assert.equal(actions.countItem('cobblestone'), 0);
    assert.equal(actions.countItem('coal'), 8); assert.equal(actions.countItem('bread'), 4);
    assert.equal(actions.countItem('stone_pickaxe'), 1);
    assert(bot.entity.position.distanceTo(vec3(x + 48.5, 74.5, z + 0.5)) <= 4, 'real body traveled to the remembered chest');
    assert.equal((await contents(position(48))).find((item) => item.name === 'cobblestone')?.count, 16);
    console.log('PASS actual remembered chest outside nearby search received 16 cobblestone; tools, food and fuel kept');

    await command(`gamemode creative ${username}`);
    await command(`setblock ${x + 48} 74 ${z} air`);
    const fullSlots = Array.from({ length: 27 }, (_, slot) => `{Slot:${slot}b,id:"minecraft:dirt",Count:64b}`).join(',');
    await command(`setblock ${x + 3} 74 ${z} chest{Items:[${fullSlots}]}`);
    await command(`setblock ${x + 55} 74 ${z} barrel`);
    stations.remember('barrel', position(55));
    await command(`tp ${username} ${x + 0.5} 74 ${z + 0.5}`);
    await command(`give ${username} cobblestone 12`);
    await command(`gamemode survival ${username}`);
    await waitFor(() => bot.blockAt(vec3(x + 3, 74, z))?.name === 'chest' && actions.countItem('cobblestone') === 12 &&
      Math.abs(bot.entity.position.x - x - 0.5) < 0.2 && bot.entity.onGround, 'actual full nearby chest and reset start');
    const second = await run({ items: ['cobblestone'] });
    assert.equal(second.ok, true, second.reason);
    assert.deepEqual(second.consumed, { cobblestone: 12 });
    assert.deepEqual(second.chest, position(55), 'full nearby chest did not block the known available barrel');
    assert.equal(actions.countItem('cobblestone'), 0);
    assert.equal((await contents(position(55))).find((item) => item.name === 'cobblestone')?.count, 12);
    assert.equal(stations.all().some((entry) => entry.kind === 'chest' && entry.x === x + 48), false,
      'removed chest memory cleared only after actually reaching its location');
    assert.equal(bot.blockAt(vec3(x + 30, 73, z)).name, 'stone', 'travel preserved actual support');
    console.log('PASS actual full nearby chest fell back to remembered barrel and removed only the verified missing chest record');

    const partialSlots = Array.from({ length: 26 }, (_, slot) => `{Slot:${slot}b,id:"minecraft:dirt",Count:64b}`).join(',');
    await command(`data merge block ${x + 55} 74 ${z} {Items:[${partialSlots},{Slot:26b,id:"minecraft:cobblestone",Count:60b}]}`);
    const partialBefore = await contents(position(55));
    assert.equal(partialBefore.length, 27, 'real partial fixture has no empty container slot');
    assert.equal(partialBefore.find((item) => item.name === 'cobblestone')?.count, 60,
      'actual container has precisely four free spaces before attempting storage');
    await command(`give ${username} cobblestone 12`);
    await waitFor(() => actions.countItem('cobblestone') === 12, 'actual stack to partly deposit');
    const partial = await run({ items: ['cobblestone'] });
    assert.equal(partial.ok, true, partial.reason);
    assert.deepEqual(partial.consumed, { cobblestone: 4 }, 'count only four items that actually fit, even if the library rejects the rest');
    await waitFor(() => actions.countItem('cobblestone') === 8, 'unstored remainder returned to real inventory');
    assert.equal((await contents(position(55))).find((item) => item.name === 'cobblestone')?.count, 64);
    console.log('PASS actual partial stack transfer reported four stored and eight remaining instead of inventing or discarding progress');

    // A full player inventory can still merge four bread into its existing stack.
    await command(`clear ${username}`);
    await command(`give ${username} bread 60`);
    await command(`give ${username} dirt 2240`);
    await command(`data merge block ${x + 55} 74 ${z} {Items:[{Slot:0b,id:"minecraft:bread",Count:12b}]}`);
    await waitFor(() => actions.countItem('bread') === 60 && actions.countItem('dirt') === 2240 &&
      bot.inventory.emptySlotCount() === 0, 'actual 36 occupied player slots with four bread stacking spaces');
    assert.equal((await contents(position(55))).find((item) => item.name === 'bread')?.count, 12);
    const take = (item, count) => actions.withdraw({ ...position(55), item, count, signal: controller.signal, reach: false });
    const merged = await take('bread', 8);
    assert.equal(merged.ok, true); assert.deepEqual(merged.taken, { bread: 4 }); assert.equal(merged.total, 4);
    await waitFor(() => actions.countItem('bread') === 64, 'server confirmed merging four bread into a full player inventory');
    assert.equal((await contents(position(55))).find((item) => item.name === 'bread')?.count, 8);
    console.log('PASS actual full player inventory merged four bread; requested eight reported only the actual four');

    const blocked = await take('bread', 1);
    assert.equal(blocked.ok, false); assert.deepEqual(blocked.taken, {}); assert.equal(blocked.total, 0);
    assert.equal(actions.countItem('bread'), 64);
    assert.equal((await contents(position(55))).find((item) => item.name === 'bread')?.count, 8);
    console.log('PASS actual full inventory without stacking space refused withdrawal without claiming progress');

    await command(`clear ${username}`);
    await waitFor(() => bot.inventory.items().length === 0, 'actual empty player inventory before ordinary withdrawal');
    const ordinary = await take('bread', 4);
    assert.equal(ordinary.ok, true); assert.deepEqual(ordinary.taken, { bread: 4 }); assert.equal(ordinary.total, 4);
    assert.equal(actions.countItem('bread'), 4);
    assert.equal((await contents(position(55))).find((item) => item.name === 'bread')?.count, 4);
    console.log('PASS actual ordinary withdrawal confirmed both player gain and container loss');

    await command(`clear ${username}`);
    await command(`data merge block ${x + 55} 74 ${z} {Items:[{Slot:0b,id:"minecraft:dark_oak_log",Count:8b},{Slot:1b,id:"minecraft:oak_log",Count:2b}]}`);
    await waitFor(() => bot.inventory.items().length === 0, 'actual empty inventory before exact wood withdrawal');
    const exactWood = await take('oak_log', 4);
    assert.deepEqual(exactWood.taken, { oak_log: 2 }); assert.equal(exactWood.total, 2);
    assert.equal(actions.countItem('dark_oak_log'), 0);
    assert.equal((await contents(position(55))).find((item) => item.name === 'dark_oak_log')?.count, 8);
    console.log('PASS actual oak request took only two oak logs and kept the eight dark oak logs');
    await assert.rejects(take('minecraft:oak_log', 1), /缺少.*oak_log/);
    assert.equal(actions.countItem('dark_oak_log'), 0);
    assert.equal((await contents(position(55))).find((item) => item.name === 'dark_oak_log')?.count, 8);
    console.log('PASS actual exhausted oak stock refused substitution with dark oak');

    await command(`clear ${username}`);
    const supplyStock = [['wheat', 12], ['cobblestone', 3], ['stick', 3], ['coal', 1]];
    const supplySlots = supplyStock.map(([item, count], slot) => `{Slot:${slot}b,id:"minecraft:${item}",Count:${count}b}`).join(',');
    await command(`data merge block ${x + 55} 74 ${z} {Items:[${supplySlots}]}`);
    await command(`setblock ${x + 56} 74 ${z + 1} crafting_table`);
    await waitFor(() => bot.inventory.items().length === 0 && bot.blockAt(vec3(x + 56, 74, z + 1))?.name === 'crafting_table',
      'real supplied barrel and nearby workstation');
    const actualStock = await contents(position(55));
    for (const [item, count] of supplyStock) assert.equal(actualStock.find((entry) => entry.name === item)?.count, count);
    for (const [item, count] of supplyStock) {
      const received = await take(item, count);
      assert.equal(received.ok, true); assert.deepEqual(received.taken, { [item]: count });
    }
    state = new StateTracker({ emit() {} }); state.attach(bot);
    const prepare = () => skills.get('food_chain').run({ actions, nav, state, config,
      ctx: new SkillContext({ signal: controller.signal, deadline }), params: {} });
    const prepared = await prepare();
    assert.equal(prepared.ok, true, prepared.reason);
    assert.deepEqual(prepared.produced, { bread: 4, stone_pickaxe: 1, torch: 4 });
    assert.equal(prepared.food_ready, 4); assert.equal(prepared.pickaxe_tier, 'stone'); assert.equal(prepared.torch_count, 4);
    assert.equal(actions.countItem('wooden_pickaxe'), 0, 'stocked cobblestone does not require first making a wooden pick');
    assert.equal(actions.countItem('stone_axe'), 0); assert.equal(actions.countItem('stone_sword'), 0);
    assert.equal((await contents(position(55))).length, 0, 'actual resources withdrawn from the barrel');
    const suppliesAfter = actions.inventoryMap();
    const alreadyPrepared = await prepare();
    assert.equal(alreadyPrepared.ok, true); assert.deepEqual(alreadyPrepared.produced, {});
    assert.deepEqual(actions.inventoryMap(), suppliesAfter, 'prepared supplies do not trigger more manufacturing');
    console.log('PASS actual withdrawal and native recipes produced four bread, only a stone pick and four torches; already prepared supplies reused');

    await command(`clear ${username} torch`);
    await waitFor(() => actions.countItem('torch') === 0, 'server confirmed missing torches with no coal left');
    const incomplete = await prepare();
    assert.equal(incomplete.ok, false); assert.deepEqual(incomplete.missing, ['torch']); assert.match(incomplete.reason, /燃料/);
    assert.equal(actions.countItem('bread'), 4); assert.equal(actions.countItem('stone_pickaxe'), 1);
    assert.deepEqual(incomplete.produced, {});
    console.log('PASS actual incomplete departure supplies preserved food and pick without falsely claiming readiness');
    console.log('全部通过（10 项真实存取物与补给场景）');
  } finally {
    controller.abort(); clearTimeout(watchdog);
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    if (actions) actions.stopCurrent(); else if (nav) nav.stop();
    if (state) state.detach();
    if (bot) bot.quit();
    try { if (fixtureLoaded) await rcon.command(`forceload remove ${area}`, 3000); }
    finally { rcon.close(); }
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
