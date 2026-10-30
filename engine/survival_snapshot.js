'use strict';

// One synchronous observation: inventory, body and home describe the same turn.
function survivalSnapshot(engine, homes = []) {
  const started = performance.now();
  const snapshot = engine.state.snapshot('normal');
  snapshot.observed_at = Date.now() / 1000;
  snapshot.lifecycle_id = engine._bodyLifecycle;
  if (!snapshot.connected || !snapshot.ready || engine._bodyTransition) {
    return { connected: false, ready: false, observed_at: snapshot.observed_at,
      lifecycle_id: snapshot.lifecycle_id };
  }
  snapshot.inventory_items = engine.actions.inventoryMap();
  snapshot.inventory_slots = (engine.bot.inventory?.slots || []).flatMap((item, slot) => item ? [{
    slot, name: item.name, count: item.count,
    durability_pct: item.maxDurability ? Math.round((1 - (item.durabilityUsed || 0) / item.maxDurability) * 100) : null,
  }] : []);
  const dimension = String(snapshot.dimension || '').replace(/^minecraft:/, '');
  const candidates = (Array.isArray(homes) ? homes : []).slice(-8).filter(home =>
    home && home.server === snapshot.server && String(home.dimension).replace(/^minecraft:/, '') === dimension &&
    Number.isFinite(home.verified_at || 0));
  candidates.sort((a, b) => (b.verified_at || 0) - (a.verified_at || 0));
  if (candidates.length) {
    snapshot.home = candidates[0];
    try {
      snapshot.home_status = require('./skills/building').inspectHome({ actions: engine.actions,
        state: engine.state, config: engine.config, home: snapshot.home });
    } catch (error) {
      // Damaged optional home metadata must not hide current health or supplies.
      snapshot.home_status = { condition: 'unknown', safe: false, loaded: false, reason: String(error.message || error) };
    }
    try {
      snapshot.farm_status = require('./skills/farming').inspectFarm({ actions: engine.actions,
        home: snapshot.home, farm: snapshot.home.farm || null, config: engine.config });
    } catch (error) {
      snapshot.farm_status = { condition: 'unknown', loaded: false, can_start: false,
        needs_work: false, reason: String(error.message || error) };
    }
  }
  snapshot.observation_ms = Math.max(0, performance.now() - started);
  return snapshot;
}

module.exports = { survivalSnapshot };
