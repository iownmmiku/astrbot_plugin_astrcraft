"""LLM 工具（三）：人格、记忆、过日子。

这组工具的存在意义是**改变 AstrBot 看待她的方式**：

- 前两组工具（`llm_tools_core` / `llm_tools_skills`）是"工人接口"：
  设定目标、执行任务、报告进度。
- 这一组是"朋友接口"：她现在在干嘛、她记得什么、她喜欢什么。
  有了这组工具，模型才不会把你说的每句话都翻译成一条工作指令。

换句话说：光有前两组，她在 AstrBot 眼里永远是个执行器；
加上这一组 + 人格注入，她才是一个"有自己生活、可以被拜访"的角色。
"""

from __future__ import annotations

from astrbot.api.event import AstrMessageEvent, MessageEventResult, filter

from .bridge_client import EngineError

FAST_TIMEOUT = 20.0


class McLifeTools:
    """她在干嘛、她记得什么、她的心情。"""

    # ============================================================ 她在干嘛

    @filter.llm_tool(name="mc_whats_she_doing")
    async def tool_whats_she_doing(self, event: AstrMessageEvent) -> MessageEventResult:
        """她（Minecraft 里的角色）现在在做什么、心情如何、最近做过什么。

        当用户问"她在干嘛/在玩什么/最近怎么样"时用这个。
        **不要**把用户随口一句"她在干嘛"当成任务去执行——先用这个看看她自己过着什么日子。
        """
        lines = []

        # 她自己的安排（过日子循环）
        if self.life:
            lines.append(self.life.describe())
        else:
            lines.append("（过日子系统未启用）")

        # 心情（驱动力水位）
        if self.drives:
            lines.append("")
            lines.append("【她现在的心思】")
            lines.append(self.drives.describe_all())

        # 生存状态
        if self.connected:
            try:
                brief = await self._get_brief(max_age=3.0)
                lines.append("")
                lines.append("【当前状态】")
                lines.append(brief)
            except Exception:  # noqa: BLE001
                pass
        else:
            lines.append("")
            lines.append("（她现在不在服务器里）")

        yield event.plain_result("\n".join(lines))

    @filter.llm_tool(name="mc_her_memories")
    async def tool_her_memories(
        self,
        event: AstrMessageEvent,
        about: str = "",
        count: int = 6,
    ) -> MessageEventResult:
        """她记得的事——她的经历、去过的地方、见过的东西、和谁聊过。

        适合回答"她记得上次那件事吗""她在游戏里有什么经历"。

        Args:
            about(string): 想找跟什么有关的记忆（留空则给最近发生的）
            count(number): 要几条，默认 6
        """
        if not self.memory:
            yield event.plain_result("记忆系统未启用")
            return

        n = max(1, min(20, int(count or 6)))
        if about:
            entries = self.memory.recall(about, limit=n)
        else:
            entries = self.memory.recent(n)

        if not entries:
            yield event.plain_result("她还没有什么特别的经历（记忆是空的）")
            return

        rendered = self.memory.render_for_prompt(entries)
        stats = self.memory.stats()
        yield event.plain_result(
            f"她记得这些（共 {stats['total']} 条经历）：\n{rendered}"
        )

    @filter.llm_tool(name="mc_her_persona")
    async def tool_her_persona(self, event: AstrMessageEvent) -> MessageEventResult:
        """她当前用的是哪个人格（在 MC 里的身份设定）。"""
        if not self.persona:
            yield event.plain_result("人格系统未启用")
            return
        cur = await self.persona.resolve(event.unified_msg_origin)
        text = await self.persona.current_display()
        preview = (cur.get("prompt") or "")[:300]
        lines = [text]
        if preview:
            lines.append("")
            lines.append(f"人格设定（节选）：\n{preview}")
        lines.append("")
        lines.append("提示：用户可以用 /mc人格 <名字> 切换，或 /mc人格 列表 看有哪些。")
        yield event.plain_result("\n".join(lines))

    @filter.llm_tool(name="mc_persona_list")
    async def tool_persona_list(self, event: AstrMessageEvent) -> MessageEventResult:
        """列出 AstrBot 里有哪几个人格可供她在 MC 中使用。"""
        if not self.persona:
            yield event.plain_result("人格系统未启用")
            return
        personas = await self.persona.list_personas()
        if not personas:
            yield event.plain_result("AstrBot 里还没有配置人格")
            return
        lines = ["可用人格："]
        for p in personas:
            lines.append(f"· {p['name']}（{p['id']}）")
        yield event.plain_result("\n".join(lines))

    # ============================================================ 她的心情

    @filter.llm_tool(name="mc_her_wish")
    async def tool_her_wish(self, event: AstrMessageEvent) -> MessageEventResult:
        """问她"现在想做什么"——按她当前最强烈的念头给出一个意愿。

        这和 mc_set_goal 完全不同：
        - `mc_her_wish` 是"她想干嘛"（她的意愿，你只是问问）
        - `mc_set_goal` 是"你让她干嘛"（你的指令，她会去做）

        用户说"她（自己）想干嘛"时用这个；说"让她去干嘛"时用 mc_set_goal。
        """
        if not self.drives:
            yield event.plain_result("驱动力系统未启用")
            return
        suggestion = self.drives.suggest_activity()
        lines = [
            f"她现在最想做的是：{suggestion['label']}（强度 {suggestion['level']}）",
            f"具体可能会去：{suggestion['activity']}",
            f"心情：{suggestion['voice']}",
            "",
            "（这是她自己的意愿。若用户想让她做别的事，用 mc_set_goal 直接指派。）",
        ]
        yield event.plain_result("\n".join(lines))

    # ============================================================ 访客礼仪

    @filter.llm_tool(name="mc_visit")
    async def tool_mc_visit(
        self,
        event: AstrMessageEvent,
        message: str = "",
    ) -> MessageEventResult:
        """以"拜访朋友"的方式跟她打个招呼，让她暂停手上的事、用她的人格回应你。

        适合用户说"我去看看她在干嘛""跟她说句话""让她别忙了陪我说会话"这类场景。
        和直接指派任务不同：这个只是打个招呼，不会改变她的日程。

        Args:
            message(string): 你想对她说的话。留空则只是一句"在忙什么呢"
        """
        if not self.connected:
            yield event.plain_result("她现在不在服务器里（机器人没进服）")
            return
        if self.life:
            await self.life.share_event(
                kind="social",
                text=f"有人来看你了：{message or '在忙什么呢？'}",
                force=True,
            )
        if message and self.engine and self.engine.running:
            try:
                await self.engine.say(message)
            except EngineError as exc:
                yield event.plain_result(f"没能把话带到：{exc}")
                return
        await self._notify_subscribers(f"👋 有人来拜访她：{message or '（只是看看）'}")
        yield event.plain_result("已经把话带给她了，她会在游戏里回你。")

    # ============================================================ 她的任务清单（todo）

    @filter.llm_tool(name="mc_todo_write")
    async def tool_todo_write(
        self,
        event: AstrMessageEvent,
        items: str = "",
    ) -> MessageEventResult:
        """给她写一份任务清单（她自己会照着做，重启也不丢）。

        什么时候用：用户给了**多步的活**（"盖个房子""搞一套铁装备"）时，
        先帮她拆成几步写进清单；她会一项项做，做完自己划掉。
        简单一句话的活（"砍棵树"）不用写清单。

        Args:
            items(string): 任务清单，**一行一项**，最多 12 项。例如：
                "挖 60 个圆石\\n做工作台和石镐\\n找个平地盖 5×5 小屋\\n放门和火把\\n做箱子存东西"
        """
        if not self.life:
            yield event.plain_result("过日子系统没启用，写不了清单")
            return
        lines = [ln.strip() for ln in str(items or "").splitlines() if ln.strip()]
        if not lines:
            yield event.plain_result("清单是空的——每行写一项要做的事")
            return
        rendered = self.life.write_todos(lines)
        await self._notify_subscribers(f"📋 给她写了 {len(lines)} 项任务清单")
        yield event.plain_result(f"清单已记下，她会照着做：\n{rendered}")

    @filter.llm_tool(name="mc_todo_read")
    async def tool_todo_read(self, event: AstrMessageEvent) -> MessageEventResult:
        """看她现在的任务清单（做到哪一步了、哪些还没做）。"""
        if not self.life:
            yield event.plain_result("过日子系统没启用")
            return
        rendered = self.life.render_todos()
        if not rendered:
            yield event.plain_result("她现在没有任务清单——她在按自己的想法过日子。")
            return
        yield event.plain_result(rendered)

    @filter.llm_tool(name="mc_todo_done")
    async def tool_todo_done(
        self,
        event: AstrMessageEvent,
        item: str = "",
    ) -> MessageEventResult:
        """把她清单里的某一项划掉（用户说"那个做完了/不用做了"时用）。

        Args:
            item(string): 第几项（填数字如 "2"）或项里的几个字（如 "盖房子"）
        """
        if not self.life:
            yield event.plain_result("过日子系统没启用")
            return
        result = self.life.mark_todo_done(item)
        yield event.plain_result(result)

    # ============================================================ 技能知识（Markdown）

    @filter.llm_tool(name="mc_load_skill")
    async def tool_load_skill(
        self,
        event: AstrMessageEvent,
        name: str = "",
    ) -> MessageEventResult:
        """读一篇"怎么做某件事"的攻略（Markdown 知识）。

        遇到**多步、容易出错**的事（盖房子、从零做工具、找吃的、下矿）时，
        先读对应的攻略再动手——里面写了顺序、常见失败和怎么补救。

        Args:
            name(string): 攻略名：building（盖房）/ tools（从零到石制工具）/
                food（吃饱肚子）/ mining（安全挖矿）。留空则列出全部。
        """
        from pathlib import Path

        root = Path(__file__).resolve().parent / "skills_docs"
        want = str(name or "").strip().lower().replace(".md", "")
        if not want:
            yield event.plain_result("可以读的攻略：" + "、".join(sorted(p.stem for p in root.glob("*.md"))))
            return
        path = root / f"{want}.md"
        if not path.exists():
            yield event.plain_result(
                f"没有「{want}」这篇。有的是：" + "、".join(sorted(p.stem for p in root.glob("*.md")))
            )
            return
        await self._notify_subscribers(f"📖 她读了攻略：{want}")
        yield event.plain_result(path.read_text(encoding="utf-8"))

    # ============================================================ 知识库（她会自己长大）

    @filter.llm_tool(name="mc_knowledge_search")
    async def tool_knowledge_search(
        self,
        event: AstrMessageEvent,
        query: str = "",
    ) -> MessageEventResult:
        """查她的知识库：攻略 + **她自己总结的经验** + 世界笔记。

        想知道"她有没有从之前的失败里学到东西""她记不记得家在哪"时用它。

        Args:
            query(string): 查什么（如 "挖矿"、"盖房"、"家在哪"）。留空则列出全部攻略名和最近的教训
        """
        kb = getattr(self, "knowledge", None)
        if kb is None:
            yield event.plain_result("知识库没启用")
            return
        q = str(query or "").strip()
        if not q:
            st = kb.stats()
            lines = [
                f"攻略 {st.get('docs')} 篇：{'、'.join(kb.docs())}",
                f"她自己总结的教训 {st.get('lessons')} 条：",
            ]
            for les in kb.lessons(limit=10):
                lines.append(f"  · {les.get('text')}")
            notes = kb.notes(limit=8)
            if notes:
                lines.append("世界笔记：")
                lines.append(notes)
            yield event.plain_result("\n".join(lines))
            return
        found = kb.recall(q, limit=6)
        yield event.plain_result(found or f"知识库里没有和「{q}」相关的东西。她可以自己总结一条（mc_knowledge_add）。")

    @filter.llm_tool(name="mc_knowledge_add")
    async def tool_knowledge_add(
        self,
        event: AstrMessageEvent,
        lesson: str = "",
        tags: str = "",
    ) -> MessageEventResult:
        """教她一条经验（会存进知识库，以后她自己会想起来用）。

        用户说"告诉她以后要…""提醒她别…"时用这个。
        写法要**可操作**：不是"别摔死"，而是"从高处跳下来前先看看高度，超过 3 格就垫方块"。

        Args:
            lesson(string): 那条经验，一句话
            tags(string): 标签，逗号分隔（如 "mine_stone,安全"），方便以后检索
        """
        kb = getattr(self, "knowledge", None)
        if kb is None:
            yield event.plain_result("知识库没启用")
            return
        tag_list = [t.strip() for t in str(tags or "").replace("，", ",").split(",") if t.strip()]
        result = kb.add_lesson(lesson, tags=tag_list, source="主人教的")
        await self._notify_subscribers(f"📚 你教了她一条经验：{str(lesson)[:40]}")
        yield event.plain_result(result)

    @filter.llm_tool(name="mc_knowledge_note")
    async def tool_knowledge_note(
        self,
        event: AstrMessageEvent,
        note: str = "",
    ) -> MessageEventResult:
        """让她记一条世界笔记（坐标、发现、约定）。

        比如"家在 (120,64,-250)""西边 200 格有片竹林"。

        Args:
            note(string): 要记的事
        """
        kb = getattr(self, "knowledge", None)
        if kb is None:
            yield event.plain_result("知识库没启用")
            return
        yield event.plain_result(kb.add_note(note))
