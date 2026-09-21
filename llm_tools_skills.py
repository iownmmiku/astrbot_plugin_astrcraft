"""LLM 工具（二）：技能层、长期目标、社交。

技能工具是"像玩家一样游玩"的关键：
LLM 不需要知道"砍树要先找树、做木镐要 3 木板 2 木棍、挖铁要石镐"这些细节，
它只要说 mc_chop_tree(8) 或 mc_make_tools("stone")，剩下的由引擎里的技能实现。

所有技能都是**长动作**：立刻返回 task_id，用 mc_task_status 查进度。
这是刻意的设计——让模型能一边等一边跟人聊天，而不是卡在那里。
"""

from __future__ import annotations

from astrbot.api.event import AstrMessageEvent, MessageEventResult, filter

from .bridge_client import EngineError

FAST_TIMEOUT = 20.0


class McSkillTools:
    """技能、目标与社交工具。"""

    # ============================================================ 技能（长动作）

    @filter.llm_tool(name="mc_chop_tree")
    async def tool_mc_chop_tree(
        self,
        event: AstrMessageEvent,
        count: int = 8,
    ) -> MessageEventResult:
        """让机器人去砍树获取原木（会自己找树、走过去、砍完整棵树、捡起掉落物）。

        Args:
            count(number): 要拿到几根原木，默认 8
        """
        return await self._submit_skill(event, "chop_tree", {"count": int(count)}, f"砍 {count} 根木头")

    @filter.llm_tool(name="mc_make_tools")
    async def tool_mc_make_tools(
        self,
        event: AstrMessageEvent,
        tier: str = "stone",
    ) -> MessageEventResult:
        """让机器人做一整套工具（镐/斧/剑/锹）。

        它会自己处理整条依赖链：没有木头就去砍树，没有圆石就去挖，没有工作台就做一个放下来。

        Args:
            tier(string): 工具等级：wooden(木) / stone(石) / iron(铁) / diamond(钻石)，默认 stone
        """
        return await self._submit_skill(event, "make_tools", {"tier": tier}, f"做一套{tier}工具")

    @filter.llm_tool(name="mc_mine_ores")
    async def tool_mc_mine_ores(
        self,
        event: AstrMessageEvent,
        ore: str = "iron",
        count: int = 8,
    ) -> MessageEventResult:
        """让机器人去挖矿。

        它会自己判断工具够不够（不够会先做工具）、找不到矿会往下挖阶梯、遇到岩浆绕开。

        Args:
            ore(string): 矿种：coal / iron / copper / gold / redstone / lapis / diamond / emerald / quartz，默认 iron
            count(number): 要挖几个，默认 8
        """
        return await self._submit_skill(event, "mine_ores", {"ore": ore, "count": int(count)}, f"挖 {count} 个{ore}")

    @filter.llm_tool(name="mc_collect")
    async def tool_mc_collect(
        self,
        event: AstrMessageEvent,
        item: str,
        count: int = 1,
    ) -> MessageEventResult:
        """让机器人去弄到指定物品（通用收集，自动决定砍树/挖矿/合成/熔炼/打猎）。

        例如 item=cobblestone 会去挖石头，item=stick 会先砍树再做木棍，item=cooked_beef 会打牛再烤。

        Args:
            item(string): 物品英文名（如 oak_log、cobblestone、iron_ingot、cooked_beef）
            count(number): 要几个，默认 1
        """
        return await self._submit_skill(event, "collect", {"item": item, "count": int(count)}, f"收集 {item}×{count}")

    @filter.llm_tool(name="mc_smelt")
    async def tool_mc_smelt(
        self,
        event: AstrMessageEvent,
        item: str = "",
        count: int = 0,
    ) -> MessageEventResult:
        """让机器人熔炼东西（自动补熔炉、自动找燃料）。

        Args:
            item(string): 要熔炼的原料（如 raw_iron、sand、porkchop）。留空则把背包里所有能烧的都烧一遍
            count(number): 数量，留空或 0 表示全部
        """
        params = {}
        if item:
            params["item"] = item
        if count:
            params["count"] = int(count)
        return await self._submit_skill(event, "smelt", params, f"熔炼 {item or '背包里的原料'}")

    @filter.llm_tool(name="mc_build_shelter")
    async def tool_mc_build_shelter(
        self,
        event: AstrMessageEvent,
        size: int = 3,
    ) -> MessageEventResult:
        """让机器人盖一个能过夜的庇护所（有墙、有屋顶、有门、有火把，材料不够会自己去挖）。

        Args:
            size(number): 内部空间边长（3 表示 3×3 的内部），默认 3
        """
        return await self._submit_skill(event, "build_shelter", {"size": int(size)}, f"盖 {size}×{size} 的庇护所")

    @filter.llm_tool(name="mc_sleep")
    async def tool_mc_sleep(
        self,
        event: AstrMessageEvent,
        timeout_seconds: int = 120,
    ) -> MessageEventResult:
        """**睡一觉**：找一张床睡到天亮（跳过整个夜晚 + 设重生点）。

        什么时候用：天黑了、附近有床。睡过去比摸黑干活安全得多。
        如果附近有怪、或者天还亮着，她会**如实告诉你原因**（原版规则不让睡）。

        Args:
            timeout_seconds(number): 最多等多久醒来，默认 120 秒
        """
        return await self._submit_skill(
            event, "sleep", {"timeout_seconds": int(timeout_seconds)}, "找张床睡到天亮"
        )

    @filter.llm_tool(name="mc_interact")
    async def tool_mc_interact(
        self,
        event: AstrMessageEvent,
        target: str = "sheep",
        item: str = "",
    ) -> MessageEventResult:
        """**和动物互动**：剪羊毛、喂食、挤奶。

        常用组合：
        - 剪羊毛：`target="sheep"`，`item="shears"`（羊毛是做床的材料）
        - 挤奶：`target="cow"`，`item="bucket"`
        - 喂食（繁殖/回血）：`target="cow"`，`item="wheat"`

        Args:
            target(string): 动物名，如 sheep / cow / pig / chicken
            item(string): 手上要拿的东西（留空则空手）
        """
        params = {"target": str(target).strip() or "sheep"}
        if item:
            params["item"] = str(item).strip()
        return await self._submit_skill(event, "interact", params, f"对 {target} 用 {item or '手'}")

    @filter.llm_tool(name="mc_blueprint")
    async def tool_mc_blueprint(
        self,
        event: AstrMessageEvent,
        preset: str = "",
        spec_json: str = "",
        use_here: bool = True,
        x: int = 0,
        y: int = 0,
        z: int = 0,
    ) -> MessageEventResult:
        """**照图纸盖房子**——想盖出有窗、有屋檐、有隔断的房子就用这个。

        两种用法：
        1. **用内置图纸**（快）：`preset` 填 `hut`（石基小屋）/ `lodge`（长屋）/ `tower`（瞭望塔）
        2. **自己画图纸**（自由）：`spec_json` 填一份图纸 JSON，格式见攻略 `mc_load_skill("blueprint")`

        图纸格式（写起来像画画）：
        {"name":"小屋","size":[5,4,5],
         "palette":{"S":"cobblestone","P":"oak_planks","G":"glass","D":"oak_door","T":"torch",".":null},
         "layers":[["SSSSS","S...S","S...S","S...S","SSSSS"],
                   ["S...S",".....",".....",".....","S...S"],
                   ["SPGPS","P...P","P.D.P","P...P","SPGPS"],
                   ["PPPPP","PPPPP","PPPPP","PPPPP","PPPPP"]]}

        `layers[0]` 是最底下一层；每个字符串是一行（z 方向），每个字符是一格（x 方向）。
        **材料不够会在开工前就告诉你**，不会盖到一半停住。

        Args:
            preset(string): 内置图纸名：hut / lodge / tower（与 spec_json 二选一）
            spec_json(string): 自己画的图纸（JSON 字符串）
            use_here(boolean): 以她当前位置为起点（默认 True）
            x(number): 起点 X（use_here=False 时用）
            y(number): 起点 Y（图纸最底层的高度）
            z(number): 起点 Z
        """
        import json as _json

        if preset:
            params = {"preset": str(preset).strip()}
            name = str(preset).strip()
        elif spec_json:
            try:
                spec = _json.loads(spec_json)
            except Exception as exc:  # noqa: BLE001
                yield event.plain_result(
                    f'图纸不是合法的 JSON：{exc}\n可以先用 mc_load_skill("blueprint") 看格式。'
                )
                return
            params = {"spec": spec}
            name = (spec or {}).get("name") or "图纸"
        else:
            yield event.plain_result(
                "要盖什么？给 preset（hut / lodge / tower），或者用 spec_json 自己画一张图纸。"
            )
            return
        if not use_here:
            params.update({"x": int(x), "y": int(y), "z": int(z)})
        # **这个函数里有 yield（上面那两条错误分支），所以它是 async generator，
        # 不能写 `return await ...`**（会报 "'return' with value in async generator"）。
        # 必须把结果 yield 出去。
        yield await self._submit_skill(event, "blueprint", params, f"照图纸建造「{name}」")

    @filter.llm_tool(name="mc_store_items")
    async def tool_mc_store_items(self, event: AstrMessageEvent) -> MessageEventResult:
        """让机器人把背包里的东西存进箱子（附近没有箱子就自己做一个放下来）。"""
        return await self._submit_skill(event, "store_items", {}, "把物资存进箱子")

    @filter.llm_tool(name="mc_cook_food")
    async def tool_mc_cook_food(
        self,
        event: AstrMessageEvent,
        count: int = 4,
    ) -> MessageEventResult:
        """让机器人准备食物（打猎 + 烤熟）。

        Args:
            count(number): 想准备几份熟食，默认 4
        """
        return await self._submit_skill(event, "cook_food", {"count": int(count)}, f"准备 {count} 份食物")

    @filter.llm_tool(name="mc_mine_stone")
    async def tool_mc_mine_stone(
        self,
        event: AstrMessageEvent,
        count: int = 20,
    ) -> MessageEventResult:
        """让机器人挖圆石（建筑和石制工具的基础材料）。

        Args:
            count(number): 要几个圆石，默认 20
        """
        return await self._submit_skill(event, "mine_stone", {"count": int(count)}, f"挖 {count} 个圆石")

    @filter.llm_tool(name="mc_supply")
    async def tool_mc_supply(self, event: AstrMessageEvent) -> MessageEventResult:
        """让机器人做一次生存补给：准备食物 + 补齐工具 + 做火把。适合出远门前用。"""
        return await self._submit_skill(event, "food_chain", {}, "做一次生存补给")

    # ============================================================ 任务查询

    @filter.llm_tool(name="mc_task_status")
    async def tool_mc_task_status(
        self,
        event: AstrMessageEvent,
        task_id: str = "",
    ) -> MessageEventResult:
        """查询机器人正在做什么、做到哪一步了。

        每次用技能类工具（mc_chop_tree 等）或长动作（mc_goto）之后，都用这个查结果。
        也可以不填 task_id 查"当前所有任务"。

        Args:
            task_id(string): 任务号。留空则显示当前正在执行与排队的任务
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            if task_id:
                r = await self.engine.task_status(task_id)
            else:
                r = await self.engine.task_status()
        except EngineError as exc:
            yield event.plain_result(str(exc))
            return

        from .perception import format_task_status

        if task_id:
            yield event.plain_result(format_task_status(r))
            return

        lines = []
        cur = r.get("current")
        if cur:
            lines.append(f"正在执行：{cur.get('name')}（{cur.get('detail') or '执行中'}，已 {int((cur.get('elapsed_ms') or 0) / 1000)} 秒）")
        else:
            lines.append("当前空闲，没有正在执行的动作")
        queued = r.get("queued") or []
        if queued:
            lines.append("排队中：" + "、".join(q.get("name", "?") for q in queued))
        hist = r.get("history") or []
        if hist:
            recent = hist[-3:]
            lines.append("最近完成：")
            for h in recent:
                mark = {"done": "✅", "failed": "❌", "cancelled": "⏹"}.get(h.get("status"), "·")
                lines.append(f"  {mark} {h.get('name')}{f'（{h.get('error')}）' if h.get('error') else ''}")
        if self.goals and self.goals.active:
            lines.append("")
            lines.append(self.goals.describe())
        yield event.plain_result("\n".join(lines))

    @filter.llm_tool(name="mc_task_cancel")
    async def tool_mc_task_cancel(
        self,
        event: AstrMessageEvent,
        task_id: str = "",
    ) -> MessageEventResult:
        """取消机器人正在做的事。

        Args:
            task_id(string): 要取消的任务号。留空表示取消全部（等于急停，机器人会立刻停下）
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            if task_id:
                r = await self.engine.cancel_task(task_id)
                yield event.plain_result(r.get("note") or "已请求取消该任务")
            else:
                r = await self.engine.safety_stop()
                yield event.plain_result(f"已让机器人停下，取消了 {len(r.get('cancelled') or [])} 个任务")
        except EngineError as exc:
            yield event.plain_result(str(exc))

    # ============================================================ 长期目标

    @filter.llm_tool(name="mc_set_goal")
    async def tool_mc_set_goal(
        self,
        event: AstrMessageEvent,
        goal: str,
    ) -> MessageEventResult:
        """给机器人设定一个**长期目标**，它会自主规划步骤并一步步推进，失败会重试、会换策略。

        适合"挖 10 个铁矿""盖个房子""自己去生存"这类需要多步完成的事。
        单个动作（挖一个方块、走一段路）用 mc_goto / mc_mine 就行，不要用这个。

        Args:
            goal(string): 目标描述，例如：挖 10 个铁矿 / 做一套石制工具 / 盖一个庇护所 / 自己去生存
        """
        if not self.goals:
            yield event.plain_result("目标系统未初始化")
            return
        if not self.connected:
            yield event.plain_result("机器人还没进服，先等它进服再设定目标")
            return
        try:
            msg = await self.goals.start(goal)
            yield event.plain_result(f"🎯 {msg}\n可以用 mc_goal_status 查进度。")
        except Exception as exc:  # noqa: BLE001
            yield event.plain_result(f"没法定下这个目标：{exc}")

    @filter.llm_tool(name="mc_goal_status")
    async def tool_mc_goal_status(self, event: AstrMessageEvent) -> MessageEventResult:
        """查看机器人长期目标的进度（做到第几步、卡在哪、最近几步的结果）。"""
        if not self.goals:
            yield event.plain_result("目标系统未初始化")
            return
        yield event.plain_result(self.goals.describe())

    @filter.llm_tool(name="mc_goal_pause")
    async def tool_mc_goal_pause(self, event: AstrMessageEvent) -> MessageEventResult:
        """暂停机器人的长期目标（当前动作也会停）。"""
        if not self.goals:
            yield event.plain_result("目标系统未初始化")
            return
        yield event.plain_result(await self.goals.pause())

    @filter.llm_tool(name="mc_goal_resume")
    async def tool_mc_goal_resume(self, event: AstrMessageEvent) -> MessageEventResult:
        """继续被暂停的长期目标。"""
        if not self.goals:
            yield event.plain_result("目标系统未初始化")
            return
        yield event.plain_result(await self.goals.resume())

    # ============================================================ 社交

    @filter.llm_tool(name="mc_say")
    async def tool_mc_say(
        self,
        event: AstrMessageEvent,
        message: str,
    ) -> MessageEventResult:
        """让机器人在 Minecraft 游戏内说一句话（服务器里的其他玩家能看到）。

        Args:
            message(string): 要说的内容
        """
        if not await self._ensure_engine() or not self.connected:
            yield event.plain_result("机器人未进服")
            return
        try:
            await self.engine.say(message)
            yield event.plain_result(f"已在游戏内说：{message}")
        except EngineError as exc:
            yield event.plain_result(str(exc))

    @filter.llm_tool(name="mc_players")
    async def tool_mc_players(self, event: AstrMessageEvent) -> MessageEventResult:
        """查看当前在服务器里的玩家（谁在线、离机器人多远）。"""
        if not await self._ensure_engine() or not self.connected:
            yield event.plain_result("机器人未进服")
            return
        try:
            r = await self.engine.call("players.list", {}, timeout=FAST_TIMEOUT)
        except EngineError as exc:
            yield event.plain_result(str(exc))
            return
        rows = []
        for p in r.get("players", []):
            tag = "（机器人自己）" if p.get("self") else ""
            dist = f"，距机器人 {p['distance']} 格" if p.get("distance") is not None else ""
            rows.append(f"{p.get('username')}{tag}{dist}")
        yield event.plain_result("在线玩家：" + ("、".join(rows) if rows else "只有机器人自己"))

    @filter.llm_tool(name="mc_skills")
    async def tool_mc_skills(self, event: AstrMessageEvent) -> MessageEventResult:
        """列出机器人会做的所有技能（不确定它能干什么时先查这个）。"""
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            r = await self.engine.call("skill.list", {}, timeout=FAST_TIMEOUT)
        except EngineError as exc:
            yield event.plain_result(str(exc))
            return
        yield event.plain_result("机器人会做的事：\n" + "\n".join(f"· {s}" for s in r.get("skills", [])))

    # ============================================================ 内部

    async def _submit_skill(
        self,
        event: AstrMessageEvent,
        skill: str,
        params: dict,
        label: str,
    ) -> MessageEventResult:
        """技能提交的统一入口：负责前置检查与"下一步怎么办"的提示。

        **必须是普通协程，不能写成带 yield 的 async generator**：
        所有技能工具都是 `return await self._submit_skill(...)` 的写法，
        而 `await` 一个 async generator 会直接抛
        `object async_generator can't be used in 'await' expression`。

        实测这个错误让**全部 10 个技能工具**（砍树/收集/做工具/挖矿/熔炼/
        盖房/存物/做饭/挖石/补给）都无法执行——而且它只在运行到那一行时才炸，
        工具注册、签名检查、加载测试一律发现不了，是被更早的另一个错误掩盖了很久才暴露。
        所以这里用 return 而不是 yield，并且加了静态检查工具
        `bot/tools/check_await.py` 防止同类问题再次出现。
        """
        if not await self._ensure_engine():
            return event.plain_result("引擎未运行，无法执行。请检查插件配置里的 engine_dir / node_path。")
        if not self.connected:
            return event.plain_result("机器人还没进服，先让它进服再安排它干活。")
        try:
            r = await self.engine.run_skill(skill, params)
        except EngineError as exc:
            if exc.is_not_connected:
                return event.plain_result("机器人掉线了，正在重连，稍后再试。")
            return event.plain_result(f"没能开始「{label}」：{exc}")
        return event.plain_result(
            f"已让机器人开始「{label}」，任务号 {r.get('task_id')}。\n"
            f"这会持续一段时间，你可以用 mc_task_status 查进度，或先跟用户说一声再回来查。"
        )
