'use strict';

const budgets = require('./survival_budget.json');
const TIERS = ['golden', 'wooden', 'stone', 'iron', 'diamond', 'netherite'];
const TOOL = /_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots)$/;
const FOOD = ['cooked_beef', 'cooked_porkchop', 'golden_carrot', 'cooked_mutton', 'cooked_salmon',
  'bread', 'baked_potato', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'pumpkin_pie',
  'apple', 'carrot', 'beetroot', 'melon_slice', 'sweet_berries', 'glow_berries', 'cookie', 'dried_kelp',
  'rabbit_stew', 'mushroom_stew', 'beetroot_soup'];
function budgetFor(profile = 'nearby') { return { ...(budgets[profile] || budgets.nearby) }; }

function storageBudget(inventory, profile = 'nearby') {
  const budget = budgetFor(profile), keep = {};
  const allocate = (names, quantity) => {
    for (const name of names) {
      const n = Math.min(Math.max(0, inventory[name] || 0), quantity);
      if (n) keep[name] = Math.max(keep[name] || 0, n);
      quantity -= n;
    }
  };
  allocate(FOOD, budget.food_target);
  allocate(['coal', 'charcoal', 'dried_kelp_block', 'blaze_rod'], budget.fuel_keep);
  allocate(['cobblestone', 'cobbled_deepslate', 'blackstone', 'dirt'], budget.block_keep);
  allocate(['wheat'], 12);
  for (const name of ['wheat_seeds', 'beetroot_seeds']) allocate([name], 8);
  for (const name of ['carrot', 'potato']) keep[name] = Math.min(inventory[name] || 0, Math.max(4, keep[name] || 0));
  allocate(['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'kelp'], 8);
  allocate(['torch', 'soul_torch'], budget.torch_target);
  allocate(['stick'], 8);
  allocate(['iron_ingot', 'raw_iron', 'iron_ore', 'deepslate_iron_ore'], 16);
  for (const name of Object.keys(inventory)) {
    if (TOOL.test(name)) continue; // Select individual durable tools after opening the actual window.
    if (/_(bed|door|bucket)$/.test(name) || ['bucket', 'crafting_table', 'furnace', 'shield', 'bow', 'crossbow',
      'trident', 'mace', 'elytra', 'flint_and_steel', 'shears', 'fishing_rod', 'compass', 'recovery_compass'].includes(name)) allocate([name], 1);
    if (['golden_apple', 'enchanted_golden_apple', 'totem_of_undying'].includes(name)) keep[name] = inventory[name];
  }
  allocate(['arrow', 'spectral_arrow', 'tipped_arrow'], 32);
  return keep;
}

function preferredTools(items) {
  const selected = new Map();
  const remaining = (item) => item.maxDurability ? item.maxDurability - (item.durabilityUsed || 0) : 100;
  const score = (item) => (remaining(item) <= 8 ? -100 : 0) + 10 * TIERS.indexOf(item.name.split('_')[0]);
  for (const item of items) {
    const kind = item.name.match(TOOL)?.[1];
    if (!kind || remaining(item) <= 0) continue;
    const prior = selected.get(kind);
    if (!prior || score(item) > score(prior) || score(item) === score(prior) && remaining(item) > remaining(prior)) selected.set(kind, item);
  }
  return [...selected.values()];
}

module.exports = { budgetFor, storageBudget, preferredTools, TOOL, FOOD };
