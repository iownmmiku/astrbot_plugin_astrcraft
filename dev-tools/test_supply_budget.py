"""Task reserves, bounded growth and persisted farm ownership."""
import copy
import unittest
from test_life_recovery import make_loop, L
from astrcraft_plugin.advisor import advise
from astrcraft_plugin.supply_budget import budget_for, work_profile

HOME = {'server': 'test:25565', 'dimension': 'overworld', 'origin': {'x': 0, 'y': 64, 'z': 0},
        'size': 5, 'wall_height': 3, 'complete': True, 'has_roof': True, 'condition': 'intact'}
STATUS = {'condition': 'intact', 'loaded': True, 'safe': True, 'distance': 2, 'furniture': {'chest': True}}


class BudgetTests(unittest.IsolatedAsyncioTestCase):
    def test_one_meal_is_not_enough_for_mining_but_emergency_food_is_not_consumed_as_reserve(self):
        for inv in ({'iron_pickaxe': 1, 'bread': 1}, {'iron_pickaxe': 1, 'golden_apple': 8}):
            a = advise(inv, food=20, health=20, home=HOME, home_status=STATUS,
                       next_work={'skill': 'mine_ores', 'params': {'ore': 'iron'}})
            self.assertEqual(a.skill, 'resupply_food')
            self.assertEqual(a.params['count'], 8)
            self.assertEqual(a.priority, 'survival')

    def test_budget_profiles_and_ready_materials(self):
        self.assertEqual(work_profile('mine_ores'), 'mining')
        self.assertEqual(work_profile('chop_tree'), 'nearby')
        self.assertEqual(work_profile('collect', {'allow_search': False}), 'nearby')
        self.assertEqual(work_profile('explore_nearby'), 'travel')
        a = advise({'iron_pickaxe': 1, 'bread': 8, 'coal': 4, 'stick': 4}, next_work={'skill': 'mine_ores'})
        self.assertEqual((a.skill, a.params), ('craft', {'item': 'torch', 'count': 16}))
        self.assertEqual(budget_for('mining')['food_target'], 8)

    def test_emergency_and_bootstrap_precede_trip_reserves(self):
        bare = advise({}, next_work={'skill': 'chop_tree'})
        self.assertEqual(bare.skill, 'chop_tree')
        hungry = advise({'iron_pickaxe': 1, 'bread': 1}, food=4, next_work={'skill': 'mine_ores'})
        self.assertEqual(hungry.skill, 'eat')
        hurt = advise({'iron_pickaxe': 1, 'bread': 8}, food=20, health=5, next_work={'skill': 'mine_ores'})
        self.assertEqual(hurt.skill, 'recover')

    def test_iron_target_is_finite_and_reopens_after_consumption(self):
        inv = {'iron_pickaxe': 1, 'iron_ingot': 16, 'bread': 8, 'torch': 16}
        a = advise(inv, has_shelter=True, home=HOME, home_status=STATUS)
        self.assertEqual(a.skill, 'explore_nearby')
        self.assertLessEqual(a.params['radius'], 32)
        inv['iron_ingot'] = 13
        a = advise(inv, has_shelter=True, home=HOME, home_status=STATUS)
        self.assertEqual((a.skill, a.params['count']), ('mine_ores', 3))

    def test_farm_uses_observed_work_not_unripe_field_or_unknown_chunks(self):
        inv = {'iron_pickaxe': 1, 'iron_ingot': 16, 'bread': 8, 'torch': 16}
        for available in (False, True):
            a = advise(inv, has_shelter=True, home=HOME, home_status=STATUS,
                       farm_status={'can_start': available, 'needs_work': available})
            self.assertEqual(a.skill, 'tend_farm' if available else 'explore_nearby')

    async def test_work_boundary_inserts_food_but_preserves_original_mining(self):
        loop, _ = make_loop()
        state = {'health': 20, 'food': 20, 'inventory': {'iron_pickaxe': 1, 'bread': 1},
                 'server': 'test:25565', 'dimension': 'overworld', 'is_night': False,
                 'home': HOME, 'home_status': {**STATUS, 'safe': False}, 'inventory_slots_used': 2}
        async def snapshot(): return copy.deepcopy(state)
        loop._state_provider = snapshot
        original = {'skill': 'mine_ores', 'params': {'ore': 'iron', 'count': 3}, 'why': 'continue'}
        loop._set_plan([original])
        result = await loop._survival_step()
        self.assertEqual(result['skill'], 'resupply_food')
        self.assertEqual(loop._plan, [original])
        state['inventory']['bread'] = 8
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._plan, [original])

    def test_farm_record_cannot_cross_world_or_overwrite_home_blocks(self):
        loop, _ = make_loop()
        loop.remember_home(HOME)
        farm = {'kind': 'wheat', 'server': HOME['server'], 'dimension': HOME['dimension'],
                'home_origin': HOME['origin'], 'plots': [{'x': 8, 'y': 63, 'z': 2}]}
        self.assertTrue(loop.note_home_farm(HOME, farm))
        for changed in ({'dimension': 'the_nether'}, {'plots': [{'x': 2, 'y': 63, 'z': 2}]},
                        {'plots': [{'x': 1000, 'y': 63, 'z': 2}]}, {'plots': farm['plots'] * 9}):
            self.assertFalse(loop.note_home_farm(HOME, {**farm, **changed}))
        self.assertEqual(loop.home_for_world(HOME)['farm'], farm)
        edge = {**farm, 'dimension': 'minecraft:overworld', 'plots': [{'x': 26, 'y': 66, 'z': 2}]}
        self.assertTrue(loop.note_home_farm(HOME, edge), 'match the native horizontal radius and vertical allowance')
        self.assertFalse(loop.note_home_farm(HOME, {**farm, 'plots': [{'x': 8, 'y': 59, 'z': 2}]}))
        self.assertFalse(loop.note_home_farm(HOME, {**farm, 'plots': [{'x': 5, 'y': 63, 'z': 2}]}), 'keep the home walkway clear')


if __name__ == '__main__': unittest.main(verbosity=2)
