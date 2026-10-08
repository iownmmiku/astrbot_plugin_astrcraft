'use strict';
// Bounded local Paper field. Production Actions/Mineflayer perform the
// harvest and plant packets; RCON prepares only the isolated test terrain.
const assert = require('node:assert/strict');
const mineflayer = require('../engine/node_modules/mineflayer');
const { Rcon } = require('./lib/rcon');
const { Config } = require('../engine/config');
const { Actions } = require('../engine/actions');
const { Navigator } = require('../engine/movement');
const { SkillContext, isUnderground } = require('../engine/skills/common');
const { inspectReturnSafety } = require('../engine/skills/mining_return');
const wood = require('../engine/skills/wood');
const gathering = require('../engine/skills/gathering');
const { vec3, delay } = require('../engine/util');
async function waitFor(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await delay(100); }
  assert.ok(check(), label);
}
(async () => {
  const rcon = Rcon.fromDir('.testserver', 25576), username = 'AstrCropTest';
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username, version: '1.20.1', auth: 'offline' });
  bot.loadPlugin(require('../engine/node_modules/mineflayer-pathfinder').pathfinder);
  const x = 20000 + Math.floor(Math.random() * 100) * 64, z = x;
  let loaded = false, watchdog;
  try {
    await new Promise((resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error('spawn timeout')), 20000);
      bot.once('spawn', () => { clearTimeout(watchdog); resolve(); }); bot.once('error', reject);
    });
    await rcon.command(`forceload add ${x - 24} ${z - 24} ${x + 24} ${z + 24}`); loaded = true;
    await delay(700);
    await rcon.commands([
      `gamemode creative ${username}`,
      `fill ${x - 24} 72 ${z - 24} ${x + 24} 73 ${z + 24} stone`,
      `fill ${x - 24} 74 ${z - 24} ${x + 24} 85 ${z + 24} air`,
      `tp ${username} ${x + 0.5} 74 ${z + 0.5}`, `clear ${username}`, `gamemode survival ${username}`,
    ]);
    await waitFor(() => bot.entity.onGround && Math.abs(bot.entity.position.y - 74) < .1 &&
      bot.blockAt(vec3(x + 20, 73, z))?.name === 'stone', 'loaded level field');
    const config = new Config();
    config.update({ humanize: false, spawnProtectionRadius: 0, allowDigInPath: false });
    for (const crop of Object.values(wood.CROPS)) assert.ok(config.get('digWhitelist').includes(crop.block), 'default whitelist permits crop harvesting');
    const nav = new Navigator(bot, config), actions = new Actions({ bot, config, navigator: nav });
    nav.attachActions(actions);
    const ctx = () => new SkillContext({ signal: new AbortController().signal, deadline: Date.now() + 30000 });
    for (const [item, crop] of Object.entries(wood.CROPS)) {
      await rcon.commands([`gamemode creative ${username}`, `tp ${username} ${x + .5} 74 ${z + .5}`,
        `clear ${username}`, `give ${username} ${crop.seed} 1`,
        `setblock ${x + 2} 73 ${z} farmland[moisture=7]`,
        `setblock ${x + 2} 74 ${z} ${crop.block}[age=0]`, `gamemode survival ${username}`]);
      await waitFor(() => bot.blockAt(vec3(x + 2, 74, z))?.name === crop.block &&
        Number(bot.blockAt(vec3(x + 2, 74, z)).getProperties().age) < crop.age && bot.entity.onGround,
        `${item} immature plant loaded`);
      const young = await wood.harvestCrops({ actions, nav, ctx: ctx(), itemName: item,
        count: actions.countItem(item) + 1, maxAttempts: 1, allowSearch: false });
      assert.equal(young.ok, false);
      assert.equal(bot.blockAt(vec3(x + 2, 74, z)).name, crop.block);
      console.log(`PASS actual ${item} age=0 preserved`);
      await rcon.command(`setblock ${x + 2} 74 ${z} ${crop.block}[age=${crop.age}]`);
      await waitFor(() => Number(bot.blockAt(vec3(x + 2, 74, z))?.getProperties().age) === crop.age, 'mature block update');
      const result = await gathering.collect({ actions, nav, ctx: ctx(), item,
        count: actions.countItem(item) + 1, maxAttempts: 1 });
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.replant_ok, true);
      const actual = bot.blockAt(vec3(x + 2, 74, z));
      assert.equal(actual.name, crop.block); assert.ok(actual.getProperties().age < crop.age);
      console.log(`PASS actual ${item} harvest and verified replant; inventory=${actions.countItem(item)} age=${actual.getProperties().age}`);
      await rcon.command(`setblock ${x + 2} 74 ${z} air`);
    }
    await rcon.commands([`gamemode creative ${username}`, `tp ${username} ${x + .5} 74 ${z + .5}`,
      `setblock ${x + 2} 73 ${z} stone`, `gamemode survival ${username}`]);
    await waitFor(() => bot.entity.onGround && Math.abs(bot.entity.position.y - 74) < .1, 'surface reset');
    assert.equal(inspectReturnSafety(bot).safe, true); console.log('PASS actual flat surface safe');
    for (const [dx, dz] of [[12, 0], [-12, 0], [0, 12], [0, -12]]) {
      await rcon.commands([`fill ${x + dx} 74 ${z + dz} ${x + dx} 80 ${z + dz} oak_log`,
        `setblock ${x + dx} 81 ${z + dz} oak_leaves[persistent=true]`]);
    }
    await waitFor(() => bot.blockAt(vec3(x + 12, 81, z))?.name === 'oak_leaves', 'tree columns loaded');
    assert.equal(isUnderground(bot), false); assert.equal(inspectReturnSafety(bot).safe, true);
    console.log('PASS actual four surrounding trees do not invent a pit');
    await rcon.command(`fill ${x + 12} 74 ${z - 5} ${x + 20} 78 ${z + 5} stone`);
    await waitFor(() => bot.blockAt(vec3(x + 12, 78, z))?.name === 'stone', 'slope loaded');
    assert.equal(isUnderground(bot), false); console.log('PASS actual single hillside stays aboveground');
    await rcon.commands([`fill ${x - 22} 74 ${z - 22} ${x + 22} 81 ${z + 22} air`,
      `fill ${x + 12} 74 ${z - 20} ${x + 20} 78 ${z + 20} stone`,
      `fill ${x - 20} 74 ${z + 12} ${x + 20} 78 ${z + 20} stone`,
      `fill ${x - 20} 74 ${z - 20} ${x + 20} 78 ${z - 12} stone`]);
    await waitFor(() => bot.blockAt(vec3(x, 78, z - 12))?.name === 'stone' &&
      bot.blockAt(vec3(x - 12, 74, z))?.name === 'air', 'open three-sided valley loaded');
    assert.equal(isUnderground(bot), false); assert.equal(inspectReturnSafety(bot).safe, true);
    console.log('PASS actual open three-sided valley has a safe level exit');
    await rcon.commands([`fill ${x - 22} 74 ${z - 22} ${x + 22} 78 ${z + 22} stone`,
      `fill ${x - 8} 74 ${z - 8} ${x + 8} 78 ${z + 8} air`]);
    await waitFor(() => bot.blockAt(vec3(x - 12, 78, z))?.name === 'stone', 'wide rim loaded');
    assert.equal(isUnderground(bot), true); assert.equal(inspectReturnSafety(bot).safe, false);
    console.log('PASS actual wide open pit remains underground');
    await rcon.command(`fill ${x - 22} 74 ${z - 22} ${x + 22} 78 ${z + 22} air`);
    await rcon.command(`fill ${x - 4} 76 ${z - 4} ${x + 4} 77 ${z + 4} stone`);
    await waitFor(() => bot.blockAt(vec3(x, 76, z))?.name === 'stone', 'roof loaded');
    assert.equal(isUnderground(bot), true); console.log('PASS actual ceiling protection remains');
  } finally {
    clearTimeout(watchdog); bot.quit();
    if (loaded) await rcon.command(`forceload remove ${x - 24} ${z - 24} ${x + 24} ${z + 24}`);
    rcon.close();
  }
})().catch((err) => { console.error(err.stack || err); process.exitCode = 1; });
