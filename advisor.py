"""生存顾问：根据**真实状态**给出"下一步该干什么"。

## 为什么需要它

实测：她在真实服务器上连续几十分钟重复同三条失败——
「挖石头」「做工具」「建庇护所」轮着来，每次都失败，从不改变策略
（她自己的记忆文件里 106 条任务结果几乎全是这三条的失败）。

根因不是技能坏了，而是**决策层没有"生存进度"这个概念**：
LLM 只看到一段状态简报，它不知道

- "我现在连木镐都没有，应该先砍树"（前置依赖）
- "这个技能我刚试过三次都失败了，该换个做法"（失败记忆）
- "天要黑了而我还没有能过夜的地方"（时序压力）

真玩家脑子里有一张清单，这里就把它写成规则。规则**不替代 LLM**，
而是把这张清单摆到 LLM 面前（它负责具体怎么玩），
同时在 LLM 不可用或明显在死循环时作为兜底。
"""

from __future__ import annotations

from dataclasses import dataclass, field
import time

# ---------------------------------------------------------------- 物品分类

WOOD_NAMES = (
    "oak_log", "birch_log", "spruce_log", "jungle_log",
    "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log",
    "pale_oak_log", "crimson_stem", "warped_stem",
)

PICKAXES = (
    "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe",
    "golden_pickaxe", "diamond_pickaxe", "netherite_pickaxe",
)
AXES = (
    "wooden_axe", "stone_axe", "iron_axe",
    "golden_axe", "diamond_axe", "netherite_axe",
)

# 能做工具的圆石类材料（MC 里石制工具只认这三种）
STONE_MATERIALS = ("cobblestone", "cobbled_deepslate", "blackstone")

FOODS = (
    "bread", "apple", "cooked_beef", "cooked_porkchop", "cooked_chicken",
    "cooked_mutton", "cooked_rabbit", "cooked_cod", "cooked_salmon",
    "baked_potato", "golden_apple", "carrot", "melon_slice", "sweet_berries",
    "golden_carrot", "enchanted_golden_apple", "rabbit_stew", "mushroom_stew",
    "beetroot_soup", "pumpkin_pie", "cookie", "glow_berries", "dried_kelp", "beetroot",
)

# **生食**：有生食才谈得上"做饭"；一块生食都没有时该去**打猎**。
#
# 用户反馈"她似乎不会去进行打猎"——原因就在这里：
# 早期顾问在"没有食物"时一律建议 cook_food，而手上连一块生肉都没有时
# 做饭必然失败，于是她卡在"想做吃的 → 做不了 → 再想做吃的"的循环里，
# 从来不会想到去打一只牛。
RAW_FOODS = (
    "beef", "porkchop", "chicken", "mutton", "rabbit", "cod", "salmon",
    "potato", "kelp",
)

# 能猎到肉的动物（按"好打又肉多"排序）
HUNTABLE = ("cow", "pig", "sheep", "chicken", "rabbit")

# 建材（能盖房子的方块）
BUILD_BLOCKS = (
    "cobblestone", "cobbled_deepslate", "blackstone", "stone", "dirt",
    "oak_planks", "birch_planks", "spruce_planks", "jungle_planks",
    "acacia_planks", "dark_oak_planks", "andesite", "diorite", "granite",
    "sandstone", "oak_log", "birch_log", "spruce_log",
)

# 按采矿能力排序；金镐不能采铁矿，不能把它当成铁镐的升级。
TOOL_TIERS = ("golden", "wooden", "stone", "iron", "diamond", "netherite")


@dataclass
class Advice:
    """顾问的结论。"""

    stage: str = "未知"
    stage_label: str = ""
    missing: list[str] = field(default_factory=list)
    skill: str | None = None
    params: dict = field(default_factory=dict)
    why: str = ""
    warnings: list[str] = field(default_factory=list)
    # 该建议的"强硬程度"：hard=True 表示前置条件缺失，不该去做别的事
    hard: bool = False
    # survival 可以在连续计划的步骤边界插入；progress 交给模型安排。
    priority: str = "progress"

    def render(self) -> str:
        """渲染成给 LLM 看的一小段文字。"""
        lines = [f"- 阶段：{self.stage_label or self.stage}"]
        if self.missing:
            lines.append(f"- 缺：{'、'.join(self.missing[:5])}")
        if self.skill:
            ps = ", ".join(f"{k}={v}" for k, v in (self.params or {}).items())
            lines.append(f"- 建议下一步：{self.skill}({ps})（{self.why}）")
        if self.priority == "survival":
            lines.append("- 当前先处理生存需求，恢复后再继续原来的目标")
        for w in self.warnings[:3]:
            lines.append(f"- 注意：{w}")
        return "\n".join(lines)


# ---------------------------------------------------------------- 状态判定


def count_any(inv: dict, names) -> int:
    return sum(int(inv.get(n, 0) or 0) for n in names)


def best_tool_tier(inv: dict, kinds) -> str | None:
    """背包里最好的某种工具的材质等级。"""
    best = None
    for name, cnt in (inv or {}).items():
        if not cnt:
            continue
        for kind in kinds:
            if name.endswith(f"_{kind}"):
                tier = name[: -len(f"_{kind}")]
                if tier in TOOL_TIERS:
                    if best is None or TOOL_TIERS.index(tier) > TOOL_TIERS.index(best):
                        best = tier
    return best


def _stage_of(inv: dict, has_shelter: bool) -> tuple[str, str]:
    """判断她处在生存的哪个阶段。"""
    wood = count_any(inv, WOOD_NAMES)
    pick = best_tool_tier(inv, ("pickaxe",))
    stone = count_any(inv, STONE_MATERIALS)

    if pick in ("iron", "diamond", "netherite") and has_shelter:
        return "settled", "定居期（铁器 + 有住处）"
    if pick in ("stone", "iron", "diamond", "netherite"):
        return ("stone_age", "石器时代（有石镐）") if not has_shelter else ("stone_age", "石器时代（有石镐 + 住处）")
    if pick in ("wooden", "golden"):
        return "wooden_age", "木器时代（只有木镐，该换石头了）"
    if wood >= 3:
        return "have_wood", "有木头但还没工具"
    return "bare", "一穷二白（没木头也没工具）"


def advise(
    inventory: dict | None,
    *,
    health: float = 20.0,
    food: int = 20,
    has_shelter: bool = False,
    recent_failures: dict | None = None,
    is_night: bool = False,
    inventory_slots_used: int = 0,
    nearby_entities: list | None = None,
    home: dict | None = None,
    home_status: dict | None = None,
) -> Advice:
    """核心入口：给出现状评估与下一步建议。

    参数都是"真实状态"，不做任何猜测；缺失的字段用保守默认值。
    """
    inv = {k: int(v or 0) for k, v in (inventory or {}).items()}
    fails = recent_failures or {}
    home_status = home_status or {}
    home_condition = home_status.get("condition") or (home.get("condition") if home else None)
    # Unloaded chunks cannot overturn a previously verified damaged structure.
    if home and home.get("condition") == "missing" and home_condition == "unknown":
        home_condition = "missing"
    owns_home = bool(home and home_condition not in ("missing", "other_world"))
    safe_home = bool(home_status.get("safe")) if home else has_shelter
    has_shelter = has_shelter or owns_home
    adv = Advice()

    wood = count_any(inv, WOOD_NAMES)
    planks = count_any(inv, tuple(n for n in inv if n.endswith("_planks")))
    pick = best_tool_tier(inv, ("pickaxe",))
    axe = best_tool_tier(inv, ("axe",))
    stone = count_any(inv, STONE_MATERIALS)
    food_items = count_any(inv, FOODS)
    raw_food = count_any(inv, RAW_FOODS)
    build_blocks = count_any(inv, BUILD_BLOCKS)
    torch = inv.get("torch", 0)

    adv.stage, adv.stage_label = _stage_of(inv, has_shelter)

    # ---- 危险优先级最高：血量/饥饿
    if health <= 6:
        adv.warnings.append(f"血量只有 {health:.0f}，别去挖矿或打架，先找地方躲起来")
    if food <= 6:
        if food_items > 0:
            adv.warnings.append("肚子很饿，先吃点东西")
        elif raw_food > 0:
            adv.warnings.append("肚子很饿，有生食但要先烤熟")
        else:
            adv.warnings.append("肚子很饿而且什么吃的都没有，得去打猎弄点肉")

    # ---- **没有食物时的建议要分情况**（这是"她不会打猎"的修复点）
    #
    # 早期一律建议 cook_food，可手上连一块生肉都没有时做饭必然失败，
    # 于是她卡在"想做吃的 → 做不了"的循环里，从来不会去打猎。
    def _food_advice() -> tuple[str, dict, str]:
        furniture = ((home.get("furnished") or {}) if home and home_condition == "unknown"
                     else home_status.get("furniture") or {})
        distance = home_status.get("distance")
        empty_at = home.get("food_stock_checked_at") if home else None
        recently_empty = (home and home.get("food_stock_empty") is True
                          and type(empty_at) in (int, float) and 0 <= time.time() - empty_at < 120)
        # A short verified route is useful when no ingredients are already in
        # hand. Inside the house, checking its shelves is cheaper than cooking.
        has_ingredients = inv.get("wheat", 0) >= 3 or raw_food > 0
        reach = 8 if food <= 4 or health <= 8 else 48
        if (owns_home and isinstance(furniture, dict) and furniture.get("chest") and not recently_empty
                and fails.get("resupply_food", 0) < 2
                and (safe_home or type(distance) in (int, float) and 0 <= distance <= reach)
                and (safe_home or not has_ingredients)):
            return "resupply_food", {"home": dict(home), "count": 4}, "先利用当前世界近处基地的普通食物储备，真实取到后在屋内吃饭恢复"
        if inv.get("wheat", 0) >= 3:
            return "cook_food", {"count": min(4, inv["wheat"] // 3)}, "已有小麦，补齐工作台后做面包，不必外出打猎"
        if raw_food > 0:
            return "cook_food", {"count": min(4, raw_food)}, "已有生食，先利用现成食材"
        animals = [e for e in (nearby_entities or []) if isinstance(e, dict)
                   and e.get("name") in HUNTABLE and not e.get("hostile")]
        if animals:
            animal = min(animals, key=lambda e: float(e.get("distance", 999)))
            return "hunt", {"mob": animal["name"], "count": 1}, "先猎取附近可见的动物，避免盲找牛"
        return "cook_food", {"count": 2}, "没有食物，先查找可用食材与动物，再补充两份食物"

    # ---- 按阶段给建议
    if adv.stage == "bare":
        adv.missing.append("木头")
        adv.skill = "chop_tree"
        adv.params = {"count": 4}
        adv.why = "身上什么都没有，先砍点木头——没有木头连工具都做不了"
        adv.hard = True

    elif adv.stage == "have_wood" and not (pick and axe):
        adv.missing.append("工具")
        adv.skill = "make_tools"
        adv.params = {"tier": "wooden", "kinds": ["pickaxe"]}
        adv.why = "先做木镐进入石器阶段，避免把木材耗在即将淘汰的整套木工具上"
        adv.hard = True

    elif adv.stage == "wooden_age":
        # 有木镐 → 下一步就是挖石头换石镐（石镐 131 耐久 vs 木镐 59）
        if stone < 3:
            adv.missing.append("圆石")
            adv.skill = "mine_stone"
            adv.params = {"count": 8}
            adv.why = "木镐不经用，先挖点圆石换成石镐"
            adv.hard = True
        else:
            adv.missing.append("石制工具")
            adv.skill = "make_tools"
            adv.params = {"tier": "stone", "kinds": ["pickaxe"]}
            adv.why = "先升级石镐，其他工具按实际需要补齐"
            adv.hard = True

    elif adv.stage == "stone_age":
        if not has_shelter:
            if build_blocks < 20:
                adv.missing.append("建材")
                adv.skill = "mine_stone"
                adv.params = {"count": 24}
                adv.why = "还没有能过夜的地方，先攒够盖房的石头"
                adv.hard = is_night  # 白天可以先去玩别的
            else:
                adv.missing.append("住处")
                adv.skill = "build_shelter"
                adv.params = {"size": 3}
                adv.why = "有材料了，盖个能过夜的小屋"
                adv.hard = is_night
        elif food_items == 0:
            adv.missing.append("食物")
            adv.skill, adv.params, adv.why = _food_advice()
        else:
            adv.missing.append("更好的工具（铁矿）")
            adv.skill = "mine_ores"
            adv.params = {"ore": "iron", "count": 6}
            adv.why = "基础都有了，去挖点铁矿升级工具"

    else:  # settled
        if food_items == 0:
            adv.missing.append("食物")
            adv.skill, adv.params, adv.why = _food_advice()
        elif inventory_slots_used >= 32:
            adv.missing.append("背包空间")
            adv.skill = "store_items"
            adv.params = {}
            adv.why = "背包快满了，先把东西存进箱子"
        elif torch == 0 and (inv.get("coal", 0) > 0 or inv.get("charcoal", 0) > 0):
            # **没火把就该做火把**：用户反馈"她不会在暗处放置火把"——
            # 引擎的自动插火把反射要求背包里有火把，而她从来没做过。
            adv.missing.append("火把")
            adv.skill = "craft"
            adv.params = {"item": "torch", "count": 8}
            adv.why = "手上有煤却没有火把，做点备用（进洞、过夜都用得上）"
        else:
            adv.skill = "mine_ores"
            adv.params = {"ore": "iron", "count": 8}
            adv.why = "日子稳了，攒点铁矿做更好的装备"

    # ---- 时序压力：天黑 + 没住处
    if is_night and not has_shelter and adv.skill != "build_shelter":
        adv.warnings.append("天已经黑了，没有住处很危险——优先找地方躲起来或赶紧盖房")

    # ---- 住处有了但没照明/没家具 → 提醒补齐（用户希望"建完房放箱子、床"）
    if has_shelter:
        if torch == 0 and (inv.get("coal", 0) > 0 or inv.get("charcoal", 0) > 0):
            adv.missing.append("屋里的火把")
            if adv.skill is None or adv.skill == "mine_ores":
                adv.skill = "craft"
                adv.params = {"item": "torch", "count": 8}
                adv.why = "屋里还没有火把，先做几个"
        # 放置后的家具不在背包里，不能据此断言屋里没有床或箱子。

    # 已拿到矿物就推进加工/升级，别反复挖同一种矿却一直不用。
    if adv.skill == "mine_ores" and adv.params.get("ore") == "iron":
        if pick not in ("iron", "diamond", "netherite") and inv.get("iron_ingot", 0) >= 3:
            adv.skill, adv.params = "make_tools", {"tier": "iron", "kinds": ["pickaxe"]}
            adv.why = "已有铁锭，先做铁镐再继续探索"
        elif inv.get("raw_iron", 0) > 0:
            adv.skill, adv.params = "smelt", {"item": "raw_iron", "count": min(8, inv["raw_iron"])}
            adv.why = "已有铁矿，先炼成可用的铁锭"

    # 生存优先级覆盖成长阶段；仅提醒不能阻止她饿着继续挖矿。
    needs_food = food <= 10 or (health <= 12 and food < 18)
    if needs_food:
        adv.priority, adv.hard = "survival", True
        adv.missing.insert(0, "恢复饱食度")
        if food_items > 0:
            adv.skill, adv.params = "eat", {"target_food": 20 if health <= 12 else 18}
            adv.why = "先吃饱，保证恢复生命和下一段行动的体力"
        elif food <= 4 and count_any(inv, ("beef", "porkchop", "mutton", "rabbit", "cod", "salmon", "tropical_fish", "carrot", "potato")):
            edible = next(n for n in ("beef", "porkchop", "mutton", "rabbit", "salmon", "cod", "tropical_fish", "potato") if inv.get(n, 0))
            adv.skill, adv.params = "eat", {"item": edible, "target_food": 12}
            adv.why = "已经接近挨饿，先吃不会附带中毒风险的现有生食，再准备熟食"
        else:
            adv.skill, adv.params, adv.why = _food_advice()
    elif health <= 8 and food >= 18:
        adv.priority, adv.hard = "survival", True
        adv.skill, adv.params = "recover", {"target_health": 12, "timeout_seconds": 20}
        adv.why = "已吃饱但血量危险，先在没有近身威胁的地方恢复，再继续工作"
    elif inventory_slots_used >= 32:
        adv.priority = "maintenance"
        adv.skill, adv.params = "store_items", {}
        adv.why = "先腾出背包空间，保留工具与食物，再继续采集"
        home_distance = home_status.get("distance")
        furniture = (home.get("furnished") or {}) if home and home_status.get("condition") == "unknown" else home_status.get("furniture") or {}
        if (owns_home and isinstance(furniture, dict) and furniture.get("chest")
                and type(home_distance) in (int, float) and 0 <= home_distance <= 128
                and fails.get("store_items", 0) < 2):
            adv.params["home"] = dict(home)
            adv.params["resume_work"] = True
            adv.why = "背包快满了，先回当前世界有箱子的基地，安全进屋关门后整理物资，再继续原任务"

    if is_night and not needs_food and not (health <= 8 and food >= 18):
        if home and safe_home and home_status.get("furniture", {}).get("bed") and str(home.get("dimension", "")).removeprefix("minecraft:") == "overworld":
            adv.skill, adv.params = "sleep", {"timeout_seconds": 60}
            bed_position = home_status.get("furniture", {}).get("bed_position")
            if bed_position:
                adv.params["bed_position"] = bed_position
            adv.why = "已经在验收完整的基地内，床仍在，先睡过夜晚"
            adv.priority, adv.hard = "survival", True
        elif home and safe_home:
            adv.skill, adv.params = "return_home", {"home": home, "sleep": False, "wait_seconds": 20}
            adv.why = "基地暂无床，先留在完整的屋里暂避夜晚，天亮、饥饿或有威胁时再调整"
            adv.priority, adv.hard = "survival", True
        elif not safe_home:
            if owns_home and fails.get("return_home", 0) < 2 and float(home_status.get("distance") or 0) <= 256:
                adv.skill, adv.params = "return_home", {"home": home, "sleep": True, "timeout_seconds": 60}
                adv.why = "天黑了，先回当前世界的基地，走近核验房屋再休息"
            else:
                adv.skill, adv.params = "build_shelter", {"size": 2}
                adv.why = "基地被拆、太远或暂时走不回去，先在附近建小型临时住处过夜"
            adv.priority, adv.hard = "survival", True
        if home and home_status.get("condition") == "unknown":
            adv.warnings.append("基地地形未加载，记得坐标但尚未确认安全；走近核验后再入住")

    # ---- 失败记忆：把"刚失败过"的事摆到明面上，并避免死循环
    if adv.skill and fails.get(adv.skill, 0) >= 2:
        adv.warnings.append(
            f"「{adv.skill}」你最近已经失败 {fails[adv.skill]} 次了，"
            "先看看缺什么前置条件（工具？材料？位置？），别硬重复同一个动作"
        )
    hard_fails = {k: v for k, v in fails.items() if v >= 3}
    if hard_fails:
        names = "、".join(f"{k}×{v}" for k, v in list(hard_fails.items())[:3])
        adv.warnings.append(f"这些做法反复失败过：{names}——换个思路，或先解决前置条件")

    # ---- 背包快满
    if inventory_slots_used >= 34:
        adv.warnings.append("背包快满了，挖到的东西可能装不下")

    return adv


def advise_for_prompt(advice: Advice) -> str:
    """把建议渲染成提示词片段。"""
    return "【你的生存现状】\n" + advice.render()
