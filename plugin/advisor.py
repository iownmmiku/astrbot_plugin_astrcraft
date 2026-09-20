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
    "beef", "porkchop", "chicken", "mutton", "rabbit", "cod", "salmon", "potato",
)

# **生食**：有生食才谈得上"做饭"；一块生食都没有时该去**打猎**。
#
# 用户反馈"她似乎不会去进行打猎"——原因就在这里：
# 早期顾问在"没有食物"时一律建议 cook_food，而手上连一块生肉都没有时
# 做饭必然失败，于是她卡在"想做吃的 → 做不了 → 再想做吃的"的循环里，
# 从来不会想到去打一只牛。
RAW_FOODS = (
    "beef", "porkchop", "chicken", "mutton", "rabbit", "cod", "salmon",
    "tropical_fish", "potato", "kelp",
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

TOOL_TIERS = ("wooden", "stone", "iron", "golden", "diamond", "netherite")


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

    def render(self) -> str:
        """渲染成给 LLM 看的一小段文字。"""
        lines = [f"- 阶段：{self.stage_label or self.stage}"]
        if self.missing:
            lines.append(f"- 缺：{'、'.join(self.missing[:5])}")
        if self.skill:
            ps = ", ".join(f"{k}={v}" for k, v in (self.params or {}).items())
            lines.append(f"- 建议下一步：{self.skill}({ps})（{self.why}）")
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
    if pick == "wooden":
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
) -> Advice:
    """核心入口：给出现状评估与下一步建议。

    参数都是"真实状态"，不做任何猜测；缺失的字段用保守默认值。
    """
    inv = {k: int(v or 0) for k, v in (inventory or {}).items()}
    fails = recent_failures or {}
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
        if raw_food > 0:
            return "cook_food", {}, "有生食，先烤熟再吃"
        return "hunt", {"mob": HUNTABLE[0], "count": 2}, "什么吃的都没有，去打两只动物弄点肉"

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
        adv.params = {"tier": "wooden"}
        adv.why = "有木头了，先做一套木工具，才有办法挖石头"
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
            adv.params = {"tier": "stone"}
            adv.why = "有圆石了，做一套石制工具"
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
        bed = count_any(inv, ("white_bed", "red_bed", "blue_bed", "black_bed", "bed"))
        if bed == 0:
            adv.warnings.append("屋里还没有床——晚上能睡过去就安全多了（3 个羊毛 + 3 块木板）")
        if inv.get("chest", 0) == 0 and inv.get("trapped_chest", 0) == 0:
            adv.warnings.append("屋里还没有箱子，东西多了容易丢")

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
