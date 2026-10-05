'use strict';

// Dedicated local Paper fixture, actual client physics and production descent code.
const assert = require('node:assert/strict');
const mineflayer = require('../engine/node_modules/mineflayer');
const { Rcon } = require('./lib/rcon');
const { Config } = require('../engine/config');
const { Actions } = require('../engine/actions');
const { Navigator } = require('../engine/movement');
const { SkillContext } = require('../engine/skills/common');
const { digDownStaircase } = require('../engine/skills/mining');
const { vec3, delay } = require('../engine/util');

async function waitFor(check, description, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await delay(100);
  }
  assert.ok(check(), description);
}

(async () => {
  const rcon = Rcon.fromDir('.testserver', 25576);
  const username = 'AstrSafeDesc';
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25566, username, version: '1.20.1', auth: 'offline' });
  bot.loadPlugin(require('../engine/node_modules/mineflayer-pathfinder').pathfinder);
  let watchdog;
  // Fresh chunks prevent a previous lava fixture or a login chunk packet from
  // becoming the next run's starting state. Explicitly load before /fill.
  const x = 10000 + Math.floor(Math.random() * 500) * 32, z = x;
  let fixtureLoaded = false;
  try {
    await new Promise((resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error('spawn timeout')), 20000);
      bot.once('spawn', () => { clearTimeout(watchdog); resolve(); });
      bot.once('error', reject);
    });
    await rcon.command(`forceload add ${x - 16} ${z - 16} ${x + 16} ${z + 16}`);
    fixtureLoaded = true;
    await delay(1000);
    await rcon.commands([
      `gamemode creative ${username}`,
      `fill ${x - 5} 70 ${z - 5} ${x + 8} 73 ${z + 5} stone`,
      `fill ${x - 5} 74 ${z - 5} ${x + 8} 80 ${z + 5} air`,
      `tp ${username} ${x + 0.5} 74 ${z + 0.5}`, `clear ${username}`,
      `give ${username} stone_pickaxe 1`, `gamemode survival ${username}`,
    ]);
    await waitFor(() => bot.blockAt(vec3(x + 1, 72, z))?.name === 'stone' &&
      Math.abs(bot.entity.position.x - x - 0.5) < 0.2 &&
      Math.abs(bot.entity.position.y - 74) < 0.1 && bot.entity.onGround, 'stone fixture loaded and settled');
    const config = new Config();
    config.update({ humanize: false, spawnProtectionRadius: 0, allowDigInPath: false });
    const nav = new Navigator(bot, config);
    const actions = new Actions({ bot, config, navigator: nav });
    nav.attachActions(actions);
    const ctx = () => new SkillContext({ signal: new AbortController().signal, deadline: Date.now() + 45000 });
    assert.equal(bot.blockAt(vec3(x + 1, 72, z))?.name, 'stone', 'fixture loaded');
    const steps = [];
    const descended = await digDownStaircase({ actions, nav, ctx: ctx(), steps, layers: 3 });
    assert.equal(descended, true);
    await waitFor(() => bot.entity.onGround && Math.abs(bot.entity.position.y - 71) < 0.1,
      'actual descent settled on the third stair');
    assert.equal(Math.floor(bot.entity.position.y), 71);
    assert.equal(steps.length, 3);
    assert.equal(bot.blockAt(vec3(x, 73, z))?.name, 'stone', 'original support untouched');
    console.log(`PASS actual staircase descended 3 layers to y=${bot.entity.position.y.toFixed(2)}`);

    await rcon.commands([
      `gamemode creative ${username}`, `tp ${username} ${x + 0.5} 74 ${z + 0.5}`,
      `fill ${x - 5} 70 ${z - 5} ${x + 8} 73 ${z + 5} stone`,
      `fill ${x - 5} 72 ${z - 5} ${x + 8} 72 ${z + 5} lava`,
      `setblock ${x} 72 ${z} stone`, `gamemode survival ${username}`,
    ]);
    await waitFor(() => bot.blockAt(vec3(x + 1, 72, z))?.name === 'lava' &&
      Math.abs(bot.entity.position.x - x - 0.5) < 0.2 &&
      Math.abs(bot.entity.position.y - 74) < 0.1 && bot.entity.onGround, 'lava fixture loaded and settled');
    assert.equal(bot.blockAt(vec3(x + 1, 72, z))?.name, 'lava', 'hazard fixture loaded');
    assert.equal(await digDownStaircase({ actions, nav, ctx: ctx(), layers: 1 }), false);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      assert.equal(bot.blockAt(vec3(x + dx, 73, z + dz))?.name, 'stone');
    }
    assert.equal(Math.floor(bot.entity.position.y), 74);
    console.log('PASS actual lava below support rejected without removing any staircase floor');
  } finally {
    clearTimeout(watchdog);
    bot.quit();
    if (fixtureLoaded) {
      await rcon.command(`forceload remove ${x - 16} ${z - 16} ${x + 16} ${z + 16}`);
    }
    rcon.close();
  }
})().catch((err) => { console.error(err.stack || err); process.exitCode = 1; });
