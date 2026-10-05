'use strict';

// Local Paper fixture: production navigation, actions, world inspection and skill.
const assert = require('node:assert/strict');
const mineflayer = require('../engine/node_modules/mineflayer');
const { Rcon } = require('./lib/rcon');
const { Config } = require('../engine/config');
const { Actions } = require('../engine/actions');
const { Navigator } = require('../engine/movement');
const { StateTracker } = require('../engine/state');
const { SkillContext } = require('../engine/skills/common');
const skills = require('../engine/skills');
const { StationMemory } = require('../engine/stations');
const { inspectHome, returnHome } = require('../engine/skills/building');
const { vec3, delay, CancelledError } = require('../engine/util');

(async () => {
  const rcon = Rcon.fromDir('.testserver', Number(process.env.MC_RCON_PORT || 25576));
  const controller = new AbortController();
  const deadline = Date.now() + 90000;
  const username = `AstrHome${Math.random().toString(36).slice(2, 7)}`;
  const x = 30000 + Math.floor(Math.random() * 500) * 32, z = -x;
  const area = `${x - 16} ${z - 16} ${x + 16} ${z + 16}`;
  let fixtureLoaded = false, bot, actions, nav, state;
  let originalTime = null, originalSleepingPercentage = null;
  const abort = () => controller.abort();
  const watchdog = setTimeout(abort, 90000);
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const check = () => {
    if (controller.signal.aborted) throw new CancelledError('live home fixture cancelled or exceeded 90 seconds');
  };
  const command = async (text) => { check(); const result = await rcon.command(text, 4000); check(); return result; };
  const waitFor = async (predicate, description, timeoutMs = 8000) => {
    const until = Math.min(deadline, Date.now() + timeoutMs);
    while (Date.now() < until) {
      check();
      if (predicate()) return;
      await delay(100, { signal: controller.signal });
    }
    check();
    assert.ok(predicate(), description);
  };
  try {
    bot = mineflayer.createBot({ host: '127.0.0.1', port: Number(process.env.MC_PORT || 25566),
      username, version: '1.20.1', auth: 'offline' });
    bot.loadPlugin(require('../engine/node_modules/mineflayer-pathfinder').pathfinder);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('live home spawn timeout')), 15000);
      const finish = (error) => { clearTimeout(timeout); bot.removeListener('error', failed);
        bot.removeListener('spawn', spawned); error ? reject(error) : resolve(); };
      const failed = (error) => finish(error);
      const spawned = () => finish();
      bot.once('spawn', spawned); bot.once('error', failed);
    });
    bot.on('error', (error) => { console.error(`live home client error: ${error.message}`); controller.abort(); });
    await command(`forceload add ${area}`);
    fixtureLoaded = true;
    await delay(1000, { signal: controller.signal });
    const setup = [
      `gamemode creative ${username}`,
      `fill ${x - 6} 70 ${z - 14} ${x + 10} 73 ${z + 10} stone`,
      `fill ${x - 6} 74 ${z - 14} ${x + 10} 80 ${z + 10} air`,
      `fill ${x} 74 ${z} ${x + 4} 76 ${z + 4} cobblestone`,
      `fill ${x + 1} 74 ${z + 1} ${x + 3} 75 ${z + 3} air`,
      `setblock ${x + 2} 73 ${z + 2} glowstone`,
      `setblock ${x + 2} 74 ${z} oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]`,
      `setblock ${x + 2} 75 ${z} oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]`,
      `setblock ${x + 1} 74 ${z + 1} chest`,
      `tp ${username} ${x + 2.5} 74 ${z - 3.5}`,
      `clear ${username}`, `gamemode survival ${username}`,
    ];
    for (const text of setup) await command(text);
    const doorAt = () => bot.blockAt(vec3(x + 2, 74, z));
    await waitFor(() => doorAt()?.name === 'oak_door' && doorAt().getProperties().open === false &&
      bot.blockAt(vec3(x + 2, 76, z + 2))?.name === 'cobblestone' &&
      Math.abs(bot.entity.position.x - x - 2.5) < 0.2 && Math.abs(bot.entity.position.z - z + 3.5) < 0.2 &&
      Math.abs(bot.entity.position.y - 74) < 0.1 && bot.entity.onGround, 'actual closed house and outside position loaded');
    const config = new Config();
    config.update({ humanize: false, spawnProtectionRadius: 0, allowDigInPath: false, allowPlaceInPath: false });
    nav = new Navigator(bot, config);
    if (process.env.MC_HOME_DEBUG === '1') {
      const originalGoTo = nav.goTo;
      nav.goTo = async (target) => {
        console.log('home navigation start', target.x - x, target.y, target.z - z, bot.entity.position.minus(vec3(x, 0, z)));
        try { return await originalGoTo(target); }
        finally { console.log('home navigation end', bot.entity.position.minus(vec3(x, 0, z)),
          doorAt()?.getProperties(), bot.blockAt(vec3(x + 2, 75, z))?.getProperties()); }
      };
    }
    actions = new Actions({ bot, config, navigator: nav }); nav.attachActions(actions);
    actions.stations = new StationMemory();
    actions.stations.bindScope(() => ({ server: `${bot._client.socket.remoteAddress}:${bot._client.socket.remotePort}`,
      dimension: bot.game.dimension }));
    state = new StateTracker({ emit() {} }); state.attach(bot);
    const home = { server: `${bot._client.socket.remoteAddress}:${bot._client.socket.remotePort}`,
      dimension: String(bot.game.dimension).replace(/^minecraft:/, ''), origin: { x, y: 74, z },
      size: 5, inner: 3, wall_height: 2, door_position: { x: x + 2, y: 74, z }, complete: true, has_roof: true };
    const inspect = (record = home) => inspectHome({ actions, state, config, home: record });
    const run = (record = home, sleep = false) => returnHome({ actions, nav, state, config, home: record, sleep,
      timeoutMs: 20000, ctx: new SkillContext({ signal: controller.signal, deadline }) });
    assert.equal(inspect().condition, 'intact');
    assert.equal(inspect().safe, false, 'owning a house cannot shelter the body outside');
    let openedDuringEntry = false;
    const observeDoor = (_before, after) => {
      if (after?.position.equals(vec3(x + 2, 74, z)) && after.name === 'oak_door' && after.getProperties().open) openedDuringEntry = true;
    };
    bot.on('blockUpdate', observeDoor);
    const entered = await run();
    bot.removeListener('blockUpdate', observeDoor);
    assert.equal(entered.ok, true, entered.reason);
    assert.equal(entered.home_status.inside, true);
    assert.equal(entered.home_status.safe, true);
    assert.equal(doorAt().getProperties().open, false, 'actual server door closed behind the body');
    assert.equal(openedDuringEntry, true, 'real navigation opened the initially closed door');
    assert.equal(bot.blockAt(vec3(x, 74, z + 2)).name, 'cobblestone', 'navigation preserved the wall');
    console.log('PASS actual return_home entered through its wooden door, closed it and verified safe');

    // A remembered container inside a closed house needs the real door route.
    await command(`tp ${username} ${x + 2.5} 74 ${z - 10.5}`);
    for (const [item, count] of [['cobblestone', 16], ['coal', 8], ['bread', 4], ['stone_pickaxe', 1]]) {
      await command(`give ${username} ${item} ${count}`);
    }
    await waitFor(() => Math.abs(bot.entity.position.z - z + 10.5) < 0.2 && bot.entity.onGround &&
      actions.countItem('cobblestone') === 16 && doorAt().getProperties().open === false, 'real supplies outside closed home');
    const warehouse = await skills.get('store_items').run({ actions, nav, state, config,
      ctx: new SkillContext({ signal: controller.signal, deadline }), params: { home, resume_work: true } });
    assert.equal(warehouse.ok, true, warehouse.reason);
    assert.deepEqual(warehouse.consumed, { cobblestone: 16 });
    assert.equal(actions.countItem('cobblestone'), 0);
    assert.equal(actions.countItem('coal'), 8); assert.equal(actions.countItem('bread'), 4);
    assert.equal(actions.countItem('stone_pickaxe'), 1);
    assert.equal(inspect().inside, false, 'automatic work resumption actually left the house');
    assert.equal(warehouse.home_status.inside, false);
    assert.equal(warehouse.home_status.safe, false, 'outside body does not claim indoor shelter');
    assert.equal(warehouse.resumed_work, true);
    assert.equal(doorAt().getProperties().open, false, 'door closed again after actual exit');
    assert.equal(bot.blockAt(vec3(x + 2, 75, z)).getProperties().open, false, 'upper half also closed after exit');
    const chestData = await command(`data get block ${x + 1} 74 ${z + 1} Items`);
    assert.match(chestData, /minecraft:cobblestone/); assert.match(chestData, /Count: 16b/);
    console.log('PASS actual home storage entered the closed house, verified storage, left through the door and closed it for work');

    // Execute the next production collection step outside, with a small quarry
    // whose two cells are verified by the client rather than assumed from RCON.
    await command(`setblock ${x + 8} 74 ${z - 3} stone`);
    await command(`setblock ${x + 9} 74 ${z - 3} stone`);
    await waitFor(() => bot.blockAt(vec3(x + 8, 74, z - 3))?.name === 'stone' &&
      bot.blockAt(vec3(x + 9, 74, z - 3))?.name === 'stone', 'actual quarry cells');
    await nav.goTo({ x: x + 7.5, y: 74, z: z - 3.5, range: 0.5, signal: controller.signal,
      segmented: false, timeoutMs: 10000 });
    const continued = await skills.get('mine_stone').run({ actions, nav, state, config,
      ctx: new SkillContext({ signal: controller.signal, deadline }), params: { count: 2, radius: 8 } });
    assert.equal(continued.ok, true, continued.reason);
    assert(actions.countItem('cobblestone') >= 2, 'next real skill acquired new stone after home storage');
    assert.equal(inspect().condition, 'intact', 'continued work preserved the base structure');
    console.log('PASS actual next mining skill acquired new cobblestone outside without damaging the closed house');

    const reentered = await run();
    assert.equal(reentered.ok, true, reentered.reason);

    // Change time only in this owned, otherwise empty fixture server, restoring
    // both global values even when a production action fails.
    assert.match(await command('list'), /There are 1 of a max/, 'night fixture must be the only connected player');
    const numberAtEnd = (reply) => {
      const match = String(reply).match(/(\d+)\s*$/);
      assert.ok(match, `numeric server reply expected: ${reply}`);
      return Number(match[1]);
    };
    originalTime = numberAtEnd(await command('time query daytime'));
    originalSleepingPercentage = numberAtEnd(await command('gamerule playersSleepingPercentage'));
    await command(`setblock ${x + 3} 74 ${z + 2} white_bed[facing=south,part=foot,occupied=false]`);
    await command(`setblock ${x + 3} 74 ${z + 3} white_bed[facing=south,part=head,occupied=false]`);
    await waitFor(() => bot.blockAt(vec3(x + 3, 74, z + 2))?.name === 'white_bed' &&
      bot.blockAt(vec3(x + 3, 74, z + 3))?.getProperties().part === 'head', 'both real bed halves loaded');
    let sleepEvents = 0, wakeEvents = 0;
    bot.on('sleep', () => { sleepEvents += 1; });
    bot.on('wake', () => { wakeEvents += 1; });
    await command('gamerule playersSleepingPercentage 100');
    await command('time set 13000');
    await waitFor(() => bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458, 'actual nighttime packet');
    const rested = await run(home, true);
    assert.equal(rested.ok, true, rested.reason);
    assert.equal(rested.slept, true, rested.note);
    await waitFor(() => !bot.isSleeping && bot.time.timeOfDay < 12541 && bot.entity.onGround,
      'actual sleep completed at daytime and the body settled');
    assert.equal(sleepEvents, 1, 'server confirmed entering sleep exactly once');
    assert.equal(wakeEvents, 1, 'server confirmed waking');
    assert.equal(inspect().safe, true, 'actual safe home remains intact after waking');
    assert.equal(doorAt().getProperties().open, false);
    console.log('PASS actual return_home slept in its own bed, woke at dawn and rechecked shelter safety');

    // A percentage above 100 prevents the single player from skipping night.
    // Verify that the server accepted it before testing sleep cancellation.
    await command('gamerule playersSleepingPercentage 101');
    assert.equal(numberAtEnd(await command('gamerule playersSleepingPercentage')), 101);
    await command('time set 13000');
    await waitFor(() => bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458, 'second actual nighttime packet');
    const interruptedSleep = new AbortController();
    const rejected = assert.rejects(actions.sleepInBed({ signal: interruptedSleep.signal, timeoutMs: 5000,
      bed_position: inspect().furniture.bed_position }), CancelledError);
    await waitFor(() => bot.isSleeping, 'server confirmed second sleep');
    interruptedSleep.abort();
    await rejected;
    await waitFor(() => !bot.isSleeping, 'cancelled sleep actually woke the body', 3000);
    assert(bot.time.timeOfDay >= 12541 && bot.time.timeOfDay <= 23458, 'cancellation did not falsely skip the night');
    assert.equal(inspect().safe, true);
    console.log('PASS actual sleep cancellation woke the sleeping body and preserved the nighttime state');

    await command(`setblock ${x + 2} 76 ${z + 2} air`);
    await waitFor(() => bot.blockAt(vec3(x + 2, 76, z + 2))?.name === 'air', 'roof damage received by the real client');
    const damaged = await run();
    assert.equal(damaged.ok, false);
    assert.equal(damaged.home_status.condition, 'missing');
    assert.equal(damaged.home_status.safe, false);
    console.log('PASS actual removed roof cell rejected as unsafe despite already being inside');

    const unknown = { ...home, origin: { x: x + 4096, y: 74, z }, door_position: null };
    assert.equal(bot.blockAt(vec3(unknown.origin.x, 74, z)), null, 'unknown fixture truly outside client chunk cache');
    assert.equal(inspect(unknown).condition, 'unknown');
    assert.equal(inspect(unknown).safe, false);
    assert.equal((await run(unknown)).ok, false, 'unknown and distant home cannot falsely report arrival');
    const before = bot.entity.position.clone();
    const other = await run({ ...home, dimension: home.dimension === 'overworld' ? 'the_nether' : 'overworld' });
    assert.equal(other.ok, false);
    assert.equal(other.home_status.condition, 'other_world');
    assert(bot.entity.position.distanceTo(before) < 0.2, 'other-world record did not start traveling');
    console.log('PASS actual unloaded coordinates remain unknown and other-world records cannot claim safe arrival');
    console.log('全部通过（7 项真实基地场景）');
  } finally {
    controller.abort(); clearTimeout(watchdog);
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    if (actions) actions.stopCurrent(); else if (nav) nav.stop();
    if (state) state.detach();
    if (bot) bot.quit();
    try {
      if (originalSleepingPercentage !== null) await rcon.command(`gamerule playersSleepingPercentage ${originalSleepingPercentage}`, 3000);
      if (originalTime !== null) await rcon.command(`time set ${originalTime}`, 3000);
      if (fixtureLoaded) await rcon.command(`forceload remove ${area}`, 3000);
    }
    finally { rcon.close(); }
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
