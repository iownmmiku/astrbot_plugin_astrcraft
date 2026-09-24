"""LLM 工具（一）：感知、移动、基础动作。

工具设计的核心原则（这几条决定了 LLM 会不会"犯蠢"）：

1. **快动作阻塞、慢动作异步**
   看状态、合成、装备这类一两秒的事直接返回结果；移动、挖矿、建造这类几十秒到几分钟的
   必须立刻返回 task_id，让模型能继续对话而不是干等。

2. **失败要说人话 + 给下一步**
   工具的返回值会进 LLM 上下文。写"操作失败"模型只能重试；写"目标上方是水无法站立，
   建议换 (x,z)"模型就能自己换策略。

3. **别让模型算坐标**
   暴露 mc_goto(玩家名) / mc_chop_tree() 这种意图级工具，而不是逼它拼坐标。
   坐标级工具保留，但描述里明确说"不知道坐标就用意图级工具"。
"""

from __future__ import annotations

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageEventResult, filter

from .bridge_client import EngineError

# 快速动作的超时（秒）。超过这个时间的动作必须走异步，否则会卡住整轮对话。
FAST_TIMEOUT = 20.0


class McPerceptionTools:
    """感知与移动工具。"""

    # ============================================================ 感知

    @filter.llm_tool(name="mc_status")
    async def tool_mc_status(self, event: AstrMessageEvent) -> MessageEventResult:
        """查看 Minecraft 机器人的当前状态：位置、血量、饱食度、手持、背包、附近实体、正在做什么。

        在回答任何与"机器人在哪 / 在干嘛 / 还好吗"有关的问题前，先调用这个工具。
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行，无法获取状态")
            return
        try:
            brief = await self._get_brief(max_age=3.0)
            goal = self.goals.describe() if self.goals and self.goals.active else None
            task = None
            try:
                st = await self.engine.task_status()
                cur = st.get("current")
                if cur:
                    task = f"{cur.get('name')}（{cur.get('detail') or ''}）"
            # **有意吞掉**：这里的失败不影响调用方要的结果
            except EngineError:
                pass
            parts = [brief]
            if task:
                parts.append(f"正在执行：{task}")
            if goal:
                parts.append(goal)
            yield event.plain_result("\n".join(parts))
        except EngineError as exc:
            yield event.plain_result(f"读取状态失败：{exc}")

    @filter.llm_tool(name="mc_inventory")
    async def tool_mc_inventory(self, event: AstrMessageEvent) -> MessageEventResult:
        """查看 Minecraft 机器人的背包明细（每样物品的名字与数量）。

        想知道"有没有木头/镐子/食物"时用这个，比 mc_status 更详细。
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            inv = await self.engine.call("inventory.get", {}, timeout=FAST_TIMEOUT)
        except EngineError as exc:
            yield event.plain_result(f"读取背包失败：{exc}")
            return
        items = inv.get("items") or {}
        held = inv.get("held")
        lines = []
        if held:
            lines.append(f"手持：{held.get('name')}×{held.get('count')}")
        if items:
            lines.append("背包：" + "、".join(f"{k}×{v}" for k, v in sorted(items.items(), key=lambda x: -x[1])))
        else:
            lines.append("背包是空的")
        yield event.plain_result("\n".join(lines))

    @filter.llm_tool(name="mc_scan")
    async def tool_mc_scan(
        self,
        event: AstrMessageEvent,
        target: str,
        radius: int = 16,
    ) -> MessageEventResult:
        """扫描机器人附近有哪些方块或生物。

        用于回答"附近有没有树/铁矿/牛"这类问题，拿到的坐标可以喂给 mc_goto 或 mc_mine。

        Args:
            target(string): 要找的东西，方块名（如 oak_log、iron_ore、crafting_table）或生物名（如 cow、zombie）。中文也行（木头、铁矿、牛、僵尸）
            radius(number): 扫描半径（格），默认 16，**最大 16**（再大一次要读几万个格子，会把引擎卡住几秒——她整个人就停住了）
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            names = _translate_scan_target(target)
            r = await self.engine.call(
                "block.scan",
                {"names": names, "radius": max(1, min(16, int(radius))), "limit": 20},
                timeout=FAST_TIMEOUT,
            )
        except EngineError as exc:
            yield event.plain_result(f"扫描失败：{exc}")
            return
        blocks = r.get("blocks") or []
        if not blocks:
            hint = (
                "这一带只看了最近的格子（范围太大没扫完），换个方向或走近点再扫。"
                if r.get("truncated")
                else "可以先用 mc_status 看看周围环境，或者走到别处再扫。"
            )
            yield event.plain_result(f"半径 {radius} 格内没找到 {target}。{hint}")
            return
        lines = [f"找到 {r.get('count')} 个 {target}（最多显示 10 个）："]
        for b in blocks[:10]:
            lines.append(f"  {b.get('name')} @ ({b.get('x')}, {b.get('y')}, {b.get('z')}) 距 {b.get('distance')} 格")
        yield event.plain_result("\n".join(lines))

    @filter.llm_tool(name="mc_plan_route")
    async def tool_mc_plan_route(
        self,
        event: AstrMessageEvent,
        x: int,
        z: int,
    ) -> MessageEventResult:
        """走之前先看看路上挡着什么——**不改动世界**的路线计划。

        走路默认不挖方块，所以走不通时别硬试：先用这个看"要挖哪几格、要不要垫脚"，
        再决定值不值得动世界（要挖就用 mc_mine 逐格挖）。
        长距离赶路、目标在墙后/坑里/山上时特别有用。

        Args:
            x(number): 目标的 X 坐标
            z(number): 目标的 Z 坐标
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            r = await self.engine.call(
                "route.plan",
                {"x": int(x), "z": int(z)},
                timeout=FAST_TIMEOUT,
            )
        except EngineError as exc:
            yield event.plain_result(f"规划路线失败：{exc}")
            return
        lines = [
            f"从 ({r.get('from', {}).get('x')}, {r.get('from', {}).get('y')}, {r.get('from', {}).get('z')}) "
            f"到 ({x}, {z})，直线距离 {r.get('distance')} 格。",
            str(r.get("verdict") or ""),
        ]
        for seg in r.get("obstacles") or []:
            digs = "、".join(f"{d.get('name')}×{d.get('count')}" for d in seg.get("dig") or []) or "（不用挖）"
            places = "、".join(f"{p.get('name')}×{p.get('count')}" for p in seg.get("place") or [])
            lines.append(
                f"  第 {seg.get('from')}~{seg.get('to')} 格（约 x={seg.get('at', {}).get('x')}, z={seg.get('at', {}).get('z')}）：要挖 {digs}"
                + (f"，要垫 {places}" if places else "")
            )
        lines.append("（这份计划没有改动任何方块。真要挖就用 mc_mine。）")
        yield event.plain_result("\n".join(lines))

    @filter.llm_tool(name="mc_inspect_block")
    async def tool_mc_inspect_block(
        self,
        event: AstrMessageEvent,
        x: int,
        y: int,
        z: int,
    ) -> MessageEventResult:
        """看某一格到底是什么方块（是什么、能不能挖、要不要工具）。

        "这里挖得动吗""这块是不是铁矿"这类问题用它——比盲挖省事得多。

        Args:
            x(number): 方块的 X 坐标
            y(number): 方块的 Y 坐标
            z(number): 方块的 Z 坐标
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            r = await self.engine.call(
                "block.at",
                {"x": int(x), "y": int(y), "z": int(z)},
                timeout=FAST_TIMEOUT,
            )
        except EngineError as exc:
            yield event.plain_result(f"查看失败：{exc}")
            return
        if not r or not r.get("name"):
            yield event.plain_result(f"({x}, {y}, {z}) 读不到方块（可能是空气，或者区块还没加载）")
            return
        lines = [f"({x}, {y}, {z}) 是 {r.get('name')}"]
        lines.append(f"  能挖：{'是' if r.get('diggable') else '否（太硬或挖不动）'}")
        if r.get("light") is not None:
            lines.append(f"  光照：{r.get('light')}")
        if r.get("bounding_box"):
            lines.append(f"  形状：{r.get('bounding_box')}（block=实心挡住路，empty=能穿过）")
        yield event.plain_result("\n".join(lines))

    @filter.llm_tool(name="mc_scan_entities")
    async def tool_mc_scan_entities(
        self,
        event: AstrMessageEvent,
        radius: int = 24,
        hostile_only: bool = False,
    ) -> MessageEventResult:
        """扫附近的生物/实体（打猎、躲怪、看有没有别人）。

        想打猎就找 cow/pig/sheep/chicken；想知道安不安全就看有没有 zombie/creeper。

        Args:
            radius(number): 扫描半径（格），默认 24，最大 64
            hostile_only(boolean): 只看敌对生物（判断安不安全时用）
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            r = await self.engine.call(
                "entity.scan",
                {
                    "radius": max(1, min(64, int(radius))),
                    "limit": 20,
                    "hostile_only": bool(hostile_only),
                },
                timeout=FAST_TIMEOUT,
            )
        except EngineError as exc:
            yield event.plain_result(f"扫描失败：{exc}")
            return
        ents = r.get("entities") or []
        if not ents:
            yield event.plain_result(f"半径 {radius} 格内没有{'敌对' if hostile_only else ''}生物。")
            return
        lines = [f"附近有 {len(ents)} 个{'敌对' if hostile_only else ''}生物："]
        for e in ents[:12]:
            tag = "⚠️" if e.get("hostile") else "  "
            lines.append(
                f"  {tag} {e.get('name')} 距 {e.get('distance')} 格 @ ({e.get('x')}, {e.get('y')}, {e.get('z')})"
                + (f" 血量 {e.get('health')}" if e.get("health") is not None else "")
            )
        yield event.plain_result("\n".join(lines))

    @filter.llm_tool(name="mc_check_danger")
    async def tool_mc_check_danger(
        self,
        event: AstrMessageEvent,
        radius: int = 8,
    ) -> MessageEventResult:
        """**动手之前先看这里危不危险**：附近有没有岩浆、深水、悬崖。

        什么时候用：走到陌生地形、准备往下挖、准备在崖边干活之前。
        真人在这种地方都会先看一眼再动——掉进岩浆会把身上东西全烧掉，
        从悬崖掉下去可能直接摔死。

        Args:
            radius(number): 扫描半径（格），默认 8，最大 16
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            d = await self.engine.call(
                "danger.scan", {"radius": max(2, min(16, int(radius)))}, timeout=FAST_TIMEOUT
            )
        except EngineError as exc:
            yield event.plain_result(f"扫描失败：{exc}")
            return
        if not d.get("ok"):
            yield event.plain_result(f"扫不了：{d.get('reason')}")
            return
        lines = [f"【危险扫描（半径 {d.get('radius')} 格）】", str(d.get("verdict"))]
        for lv in (d.get("lava") or [])[:3]:
            lines.append(f"  🔥 岩浆 ({lv.get('x')}, {lv.get('y')}, {lv.get('z')}) 距 {lv.get('distance')} 格")
        for c in (d.get("cliffs") or [])[:3]:
            lines.append(f"  ⚠️ 悬崖：往 ({c.get('x')}, {c.get('z')}) 方向会掉 {c.get('drop')} 格")
        if d.get("safe"):
            lines.append("  可以放心活动。")
        yield event.plain_result("\n".join(lines))

    @filter.llm_tool(name="mc_world_info")
    async def tool_mc_world_info(self, event: AstrMessageEvent) -> MessageEventResult:
        """看世界的情况：现在几点、天黑了没有、在哪个维度、天气。

        决定"还能不能出门干活""要不要赶紧回屋"之前先看这个。
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            st = await self.engine.call("state.get", {"detail": "brief"}, timeout=FAST_TIMEOUT)
        except EngineError as exc:
            yield event.plain_result(f"读取失败：{exc}")
            return
        lines = []
        tod = st.get("time_of_day")
        if tod is not None:
            hours = (float(tod) / 1000.0 + 6) % 24  # MC 的 0 tick = 早上 6 点
            lines.append(f"游戏内时间：{int(hours):02d}:{int((hours % 1) * 60):02d}")
        if st.get("is_night") is not None:
            lines.append("天黑了" if st.get("is_night") else "天还亮着")
        if st.get("dimension"):
            lines.append(f"维度：{st.get('dimension')}")
        if st.get("weather"):
            lines.append(f"天气：{st.get('weather')}")
        if st.get("light") is not None:
            lines.append(f"光照：{st.get('light')}（低于 8 就会刷怪）")
        yield event.plain_result("\n".join(lines) or "读不到世界信息")

    @filter.llm_tool(name="mc_take_items")
    async def tool_mc_take_items(
        self,
        event: AstrMessageEvent,
        item: str,
        count: int = 1,
    ) -> MessageEventResult:
        """从附近的箱子里取东西（先走到箱子旁边，或者箱子就在手边）。

        需要材料但存在箱子里时用它——别重新去挖一遍。

        Args:
            item(string): 要取的物品名，如 cobblestone、iron_ingot、bread
            count(number): 取几个，默认 1
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            r = await self.engine.call(
                "container.withdraw",
                {"item": item, "count": max(1, int(count))},
                timeout=60.0,
            )
        except EngineError as exc:
            yield event.plain_result(f"取东西失败：{exc}")
            return
        if r.get("ok"):
            yield event.plain_result(f"从箱子里取了 {item}×{r.get('taken') or count}")
        else:
            yield event.plain_result(f"没取到：{r.get('reason') or '附近可能没有箱子，或者箱子里没有这个'}")


    # ============================================================ 移动

    @filter.llm_tool(name="mc_goto")
    async def tool_mc_goto(
        self,
        event: AstrMessageEvent,
        player: str = "",
        x: float = 0,
        z: float = 0,
    ) -> MessageEventResult:
        """让机器人走到某个玩家身边，或走到指定坐标。

        两种用法（选一种）：
        - 走到玩家身边：只填 player（如"张三"）
        - 走到坐标：填 x 和 z（不知道高度没关系，机器人会自己找落脚点）

        注意：若玩家想要机器人**一直跟着走**，请调用 mc_follow 工具，而不是 mc_goto。

        Args:
            player(string): 要走到谁身边（玩家名）。留空表示用坐标
            x(number): 目标 X 坐标
            z(number): 目标 Z 坐标
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        if not self.connected:
            yield event.plain_result("机器人还没进服，先让它进服再移动")
            return
        try:
            target_p = player.strip() or getattr(event, "_sender", "")
            if target_p and (x == 0 and z == 0):
                r = await self.engine.call("move.follow", {"target": target_p}, timeout=FAST_TIMEOUT)
            else:
                r = await self.engine.call(
                    "move.to", {"x": float(x), "z": float(z), "timeout_ms": 60000}, timeout=FAST_TIMEOUT
                )
        except EngineError as exc:
            yield event.plain_result(f"移动指令没能下达：{exc}。可以先用 mc_status 确认机器人是否在服里。")
            return
        what = f"前往 {target_p} 身边" if target_p and (x == 0 and z == 0) else f"前往 ({x}, {z})"
        yield event.plain_result(
            f"已让机器人{what}，任务号 {r.get('task_id')}。这是长动作，可以用 mc_task_status 查进度。"
        )

    @filter.llm_tool(name="mc_follow")
    async def tool_mc_follow(
        self,
        event: AstrMessageEvent,
        player: str = "",
        distance: int = 3,
    ) -> MessageEventResult:
        """让机器人持续跟随玩家（玩家去哪她跟去哪）。

        当用户说"跟着我"、"跟我来"、"跟随我"、"跟在我身边"、"走慢点跟着"时必须调用这个工具。
        机器人会跟在玩家身边指定的距离内，玩家走动时机器人会自动同步移动，
        直到被叫停（mc_move_stop）或遇到严重危险。

        Args:
            player(string): 要跟随的玩家名。如果在游戏内说话且未指明其他人，留空即可（会自动跟随说话的人）
            distance(number): 跟随保持的距离（格数），默认 3
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        if not self.connected:
            yield event.plain_result("机器人还没进服，先让它进服再跟随")
            return

        target_player = player.strip()
        if not target_player:
            sender = getattr(event, "_sender", None)
            if sender:
                target_player = str(sender)

        if not target_player:
            yield event.plain_result("请指定要跟随谁（例如：mc_follow(player='玩家名')）")
            return

        try:
            r = await self.engine.call("move.follow", {"target": target_player, "distance": int(distance or 3)}, timeout=FAST_TIMEOUT)
        except EngineError as exc:
            yield event.plain_result(f"跟随指令没能下达：{exc}")
            return

        yield event.plain_result(
            f"已开始跟随 {target_player}（保持约 {distance} 格距离），任务号 {r.get('task_id')}。随时可以用 mc_move_stop 叫停。"
        )

    @filter.llm_tool(name="mc_look")
    async def tool_mc_look(
        self,
        event: AstrMessageEvent,
        x: float = 0,
        y: float = 0,
        z: float = 0,
    ) -> MessageEventResult:
        """让机器人看向某个坐标。

        Args:
            x(number): 目标 X 坐标
            y(number): 目标 Y 坐标
            z(number): 目标 Z 坐标
        """
        if not await self._ensure_engine() or not self.connected:
            yield event.plain_result("机器人未进服")
            return
        try:
            await self.engine.call("move.look", {"x": float(x), "y": float(y), "z": float(z)}, timeout=FAST_TIMEOUT)
            yield event.plain_result(f"机器人现在看向 ({x}, {y}, {z})")
        except EngineError as exc:
            yield event.plain_result(f"转向失败：{exc}")

    @filter.llm_tool(name="mc_move_stop")
    async def tool_mc_move_stop(self, event: AstrMessageEvent) -> MessageEventResult:
        """让机器人立刻停下（停止移动与跟随后面的所有动作）。

        当机器人卡住、走错方向、或者你改主意了，用这个。
        """
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            await self.engine.call("move.stop", {}, timeout=FAST_TIMEOUT)
            yield event.plain_result("已让机器人停下")
        except EngineError as exc:
            yield event.plain_result(f"停止失败：{exc}")

    # ============================================================ 基础动作（快）

    @filter.llm_tool(name="mc_mine")
    async def tool_mc_mine(
        self,
        event: AstrMessageEvent,
        x: float,
        y: float,
        z: float,
    ) -> MessageEventResult:
        """挖掉指定坐标的方块（会自动选合适的工具、走近、捡起掉落物）。

        需要知道坐标时先用 mc_scan 找。如果要挖一堆同类方块（比如 10 个铁矿），
        用 mc_mine_ores 更省事。

        Args:
            x(number): 方块 X 坐标
            y(number): 方块 Y 坐标
            z(number): 方块 Z 坐标
        """
        if not await self._ensure_engine() or not self.connected:
            yield event.plain_result("机器人未进服")
            return
        try:
            r = await self.engine.call(
                "dig",
                {"x": int(x), "y": int(y), "z": int(z), "collect": True, "reach": True},
                timeout=45.0,
            )
            got = r.get("collected") or {}
            got_text = "、".join(f"{k}×{v}" for k, v in got.items()) or "没有掉落物"
            note = r.get("note")
            text = f"挖掉了 {r.get('block')}（用 {r.get('tool_used')}），获得：{got_text}"
            if note:
                text += f"\n注意：{note}"
            yield event.plain_result(text)
        except EngineError as exc:
            yield event.plain_result(str(exc))

    @filter.llm_tool(name="mc_place")
    async def tool_mc_place(
        self,
        event: AstrMessageEvent,
        x: float,
        y: float,
        z: float,
        item: str = "",
    ) -> MessageEventResult:
        """在指定位置放置一个方块。

        Args:
            x(number): 目标 X 坐标
            y(number): 目标 Y 坐标
            z(number): 目标 Z 坐标
            item(string): 要放的方块名（如 cobblestone）。留空则用手上或背包里第一个能放的方块
        """
        if not await self._ensure_engine() or not self.connected:
            yield event.plain_result("机器人未进服")
            return
        try:
            params = {"x": int(x), "y": int(y), "z": int(z), "reach": True}
            if item:
                params["item"] = item
            r = await self.engine.call("place", params, timeout=45.0)
            yield event.plain_result(f"在 ({x}, {y}, {z}) 放置了 {r.get('placed')}" + (f"\n注意：{r.get('note')}" if r.get("note") else ""))
        except EngineError as exc:
            yield event.plain_result(str(exc))

    @filter.llm_tool(name="mc_craft")
    async def tool_mc_craft(
        self,
        event: AstrMessageEvent,
        item: str,
        count: int = 1,
    ) -> MessageEventResult:
        """合成物品（自动处理工作台与中间产物，例如原木不够会告诉你先砍树）。

        常用配方名：oak_planks(木板) stick(木棍) crafting_table(工作台) wooden_pickaxe(木镐)
        stone_pickaxe(石镐) iron_pickaxe(铁镐) wooden_sword(木剑) chest(箱子) furnace(熔炉)
        torch(火把) bucket(桶) oak_door(门)

        Args:
            item(string): 要合成的物品英文名（如 stone_pickaxe）
            count(number): 合成几份，默认 1
        """
        if not await self._ensure_engine() or not self.connected:
            yield event.plain_result("机器人未进服")
            return
        try:
            r = await self.engine.call("craft", {"item": item, "count": int(count)}, timeout=FAST_TIMEOUT + 10)
            delta = r.get("delta") or {}
            used = "、".join(f"{k}×{-v}" for k, v in delta.items() if v < 0)
            text = f"合成 {r.get('item')}×{r.get('produced')} 成功"
            if used:
                text += f"，消耗 {used}"
            if r.get("used_table"):
                text += "（用到了工作台）"
            if r.get("note"):
                text += f"\n注意：{r.get('note')}"
            yield event.plain_result(text)
        except EngineError as exc:
            yield event.plain_result(str(exc))

    @filter.llm_tool(name="mc_equip")
    async def tool_mc_equip(
        self,
        event: AstrMessageEvent,
        item: str,
        destination: str = "auto",
    ) -> MessageEventResult:
        """装备物品（拿在手上或穿在身上，自动判断该装到哪个部位）。

        Args:
            item(string): 物品英文名（如 stone_pickaxe、iron_chestplate）
            destination(string): 装备位置：auto(自动) / hand(手上) / head / torso / legs / feet
        """
        if not await self._ensure_engine() or not self.connected:
            yield event.plain_result("机器人未进服")
            return
        try:
            r = await self.engine.call("equip", {"item": item, "destination": destination}, timeout=FAST_TIMEOUT)
            yield event.plain_result(f"已装备 {r.get('equipped')} 到 {r.get('destination')}")
        except EngineError as exc:
            yield event.plain_result(str(exc))

    @filter.llm_tool(name="mc_eat")
    async def tool_mc_eat(
        self,
        event: AstrMessageEvent,
        item: str = "",
    ) -> MessageEventResult:
        """让机器人吃东西恢复饱食度和血量。

        Args:
            item(string): 指定吃什么（如 cooked_beef）。留空则自动挑最好的食物
        """
        if not await self._ensure_engine() or not self.connected:
            yield event.plain_result("机器人未进服")
            return
        try:
            params = {"item": item} if item else {}
            r = await self.engine.call("eat", params, timeout=FAST_TIMEOUT)
            if r.get("note"):
                yield event.plain_result(r["note"])
            else:
                yield event.plain_result(
                    f"吃了 {r.get('ate')}，饱食度 {r.get('food_before')} → {r.get('food_after')}，血量 {r.get('health_after')}"
                )
        except EngineError as exc:
            yield event.plain_result(str(exc))

    @filter.llm_tool(name="mc_attack")
    async def tool_mc_attack(
        self,
        event: AstrMessageEvent,
        target: str,
    ) -> MessageEventResult:
        """攻击附近的生物（会自动装备武器、追上去打，血量太低会撤退）。

        Args:
            target(string): 目标生物名（如 zombie、cow、skeleton）
        """
        if not await self._ensure_engine() or not self.connected:
            yield event.plain_result("机器人未进服")
            return
        try:
            r = await self.engine.call("attack", {"target": target}, timeout=90.0)
            if r.get("killed"):
                yield event.plain_result(f"打死了 {r.get('target')}（攻击 {r.get('attacks')} 次）")
            else:
                yield event.plain_result(f"没能打死 {r.get('target')}：{r.get('reason')}（攻击 {r.get('attacks')} 次）")
        except EngineError as exc:
            yield event.plain_result(str(exc))

    @filter.llm_tool(name="mc_drop")
    async def tool_mc_drop(
        self,
        event: AstrMessageEvent,
        item: str,
        count: int = 1,
    ) -> MessageEventResult:
        """把物品丢在地上（给别的玩家或者清背包）。

        Args:
            item(string): 物品英文名
            count(number): 丢几个，默认 1
        """
        if not await self._ensure_engine() or not self.connected:
            yield event.plain_result("机器人未进服")
            return
        try:
            r = await self.engine.call("drop", {"item": item, "count": int(count)}, timeout=FAST_TIMEOUT)
            yield event.plain_result(f"丢掉了 {r.get('dropped')}×{r.get('count')}")
        except EngineError as exc:
            yield event.plain_result(str(exc))

    @filter.llm_tool(name="mc_chest")
    async def tool_mc_chest(
        self,
        event: AstrMessageEvent,
        action: str,
        item: str = "",
        count: int = 1,
        x: float = 0,
        y: float = 0,
        z: float = 0,
    ) -> MessageEventResult:
        """操作箱子：看看里面有什么、存取物品。

        Args:
            action(string): 动作：list(查看) / put(存入) / take(取出)
            item(string): 物品英文名。put 时留空表示全存；take 时留空表示随便取
            count(number): 数量（take 用）
            x(number): 箱子 X 坐标（留空则自动找最近的箱子）
            y(number): 箱子 Y 坐标
            z(number): 箱子 Z 坐标
        """
        if not await self._ensure_engine() or not self.connected:
            yield event.plain_result("机器人未进服")
            return
        try:
            box = None
            if not (x or y or z):
                found = await self.engine.call("block.scan", {"names": ["chest", "barrel"], "radius": 24, "limit": 1}, timeout=FAST_TIMEOUT)
                blocks = found.get("blocks") or []
                if not blocks:
                    yield event.plain_result("附近 24 格内没有箱子。可以先用 mc_store_items 让它造一个。")
                    return
                box = blocks[0]
            else:
                box = {"x": int(x), "y": int(y), "z": int(z)}

            if action == "list":
                r = await self.engine.call("container.open", box, timeout=FAST_TIMEOUT + 10)
                items = r.get("items") or []
                if not items:
                    yield event.plain_result("箱子是空的")
                else:
                    yield event.plain_result("箱子里有：" + "、".join(f"{i['name']}×{i['count']}" for i in items))
            elif action == "put":
                r = await self.engine.call(
                    "container.deposit",
                    {**box, "items": [item] if item else None, "reach": True},
                    timeout=60.0,
                )
                stored = r.get("stored") or {}
                yield event.plain_result(
                    f"存了 {r.get('total')} 个物品进箱子：" + ("、".join(f"{k}×{v}" for k, v in stored.items()) or "无")
                )
            elif action == "take":
                r = await self.engine.call(
                    "container.withdraw",
                    {**box, "item": item or None, "count": int(count), "reach": True},
                    timeout=60.0,
                )
                taken = r.get("taken") or {}
                yield event.plain_result(
                    f"从箱子取出：" + ("、".join(f"{k}×{v}" for k, v in taken.items()) or "无")
                )
            else:
                yield event.plain_result(f"不认识的 action：{action}。可用：list / put / take")
        except EngineError as exc:
            yield event.plain_result(str(exc))


# 中文/口语 → 方块或生物英文名。LLM 说中文时也能用。
_TARGET_ALIASES = {
    "木头": ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log"],
    "原木": ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log"],
    "树": ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log"],
    "煤矿": ["coal_ore", "deepslate_coal_ore"],
    "铁矿": ["iron_ore", "deepslate_iron_ore"],
    "金矿": ["gold_ore", "deepslate_gold_ore", "nether_gold_ore"],
    "钻石": ["diamond_ore", "deepslate_diamond_ore"],
    "红石": ["redstone_ore", "deepslate_redstone_ore"],
    "青金石": ["lapis_ore", "deepslate_lapis_ore"],
    "绿宝石": ["emerald_ore", "deepslate_emerald_ore"],
    "铜矿": ["copper_ore", "deepslate_copper_ore"],
    "石头": ["stone", "cobblestone", "deepslate", "andesite", "granite", "diorite"],
    "圆石": ["stone", "cobblestone", "deepslate"],
    "工作台": ["crafting_table"],
    "熔炉": ["furnace", "blast_furnace"],
    "箱子": ["chest", "barrel", "trapped_chest"],
    "牛": ["cow"],
    "猪": ["pig"],
    "鸡": ["chicken"],
    "羊": ["sheep"],
    "僵尸": ["zombie", "husk", "drowned"],
    "骷髅": ["skeleton", "stray"],
    "苦力怕": ["creeper"],
    "蜘蛛": ["spider", "cave_spider"],
    "水": ["water"],
    "岩浆": ["lava"],
}


def _translate_scan_target(target: str) -> list[str]:
    """把用户/模型给的目标翻译成方块名列表。"""
    text = (target or "").strip()
    if not text:
        return []
    if text in _TARGET_ALIASES:
        return _TARGET_ALIASES[text]
    for key, names in _TARGET_ALIASES.items():
        if key in text:
            return names
    # 英文/直接给方块名：支持逗号分隔
    parts = [p.strip() for p in text.replace("，", ",").split(",") if p.strip()]
    return parts or [text]
