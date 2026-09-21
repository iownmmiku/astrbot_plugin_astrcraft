"""AstrBot Minecraft 插件：让机器人以真实玩家身份进入 Minecraft 并自己游玩。

架构（与旧版最大的区别）：
  AstrBot 插件（本文件，Python）
        │  NDJSON / JSON-RPC
        ▼
  Node 引擎子进程（mineflayer + pathfinder）
        │
        ▼
  Minecraft 服务器

为什么这么分：AstrBot 生态在 Python，Minecraft 的真实物理/区块/寻路只有 mineflayer 做得好。
两边各用原生生态，中间用一层薄协议，代价最小。

这个文件负责：生命周期、引擎监管、指令、LLM 工具注册、事件到会话的转发。
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import json
import time
from pathlib import Path
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.star import Context, Star, register

from .bridge_client import EngineClient, EngineConfig, EngineError, EngineUnavailable
from .perception import format_brief, format_event, format_skill_result, format_state, format_task_status
from .goals import GoalManager
from .persona import MinecraftPersona
from .memory import MemoryStore
from .drives import DriveSystem
from .life import LifeLoop
from .datadir import resolve_data_dir
from .game_agent import GameChatAgent
from .perception_agent import PerceptionAgent
from .action_agent import ActionAgent
from .knowledge import KnowledgeBase
from .llm_tools_core import McPerceptionTools
from .llm_tools_skills import McSkillTools
from .llm_tools_life import McLifeTools

PLUGIN_NAME = "astrbot_plugin_astrcraft"
PLUGIN_VERSION = "1.0.0"

HELP_TEXT = """【Minecraft —— 她在里面过日子】
她自己
  /mc她在干嘛           她的日程、心思、最近做过什么
  /mc记忆 [关键词]      她的经历（挖到过什么、见过什么、跟谁聊过）
  /mc人格               看她现在的人格设定
  /mc人格 列表          有哪些人格可选
  /mc人格 <名字>        换一个（之后她在游戏里就是那个人）
  /mc人格 默认          恢复用 AstrBot 的默认人格

连接
  /mc状态              引擎与游戏连接状态
  /mc进服              让她进服
  /mc退服              断开游戏连接
  /mc急停              立刻停止所有动作

陪她玩
  /mc说 <内容>         让她在游戏里说一句话
  /mc订阅 /mc退订      把游戏内的动静转发到本会话
  /mc玩家              在线玩家

给她派活（也可以，但不是必须）
  /mc目标 <要做什么>   交代一件事，例如：/mc目标 挖 10 个铁矿
  /mc进度              查看目标进度
  /mc暂停 /mc继续      暂停或继续当前目标
  /mc放弃              放弃当前目标

其它
  /mc技能              她能做的事
  /mc看她              看她：观战窗口（浏览器里的第一视角）+ 她的背包 + 她在干什么
  /mc开观战            立刻打开观战窗口（不用重进服）
  /mc调试              排障信息
  /mc帮助              显示本帮助

说明：她使用离线账号，只能进入 online-mode=false 的服务器。
"""


def _cmd_rest(event: AstrMessageEvent) -> str:
    """取指令后的参数部分。"""
    raw = (event.message_str or "").strip().lstrip("/")
    parts = raw.split(None, 1)
    return parts[1].strip() if len(parts) > 1 else ""


@register(PLUGIN_NAME, "iownmmiku", "让 AstrBot 的机器人以真实玩家身份进入 Minecraft 并自主游玩", PLUGIN_VERSION)
class MinecraftPlugin(McPerceptionTools, McSkillTools, McLifeTools, Star):
    """插件主体。

    工具方法放在三个 mixin 里：
      - llm_tools_core   感知 / 移动 / 基础动作（"工人接口"）
      - llm_tools_skills 技能 / 长期目标 / 社交
      - llm_tools_life   人格 / 记忆 / 过日子（"朋友接口"）
    这里只保留生命周期、引擎监管、指令与事件转发，避免单文件膨胀到难以维护。
    """
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}

        self.engine: EngineClient | None = None
        self.goals: GoalManager | None = None
        self.connected = False
        self._engine_task: asyncio.Task | None = None
        self._subscribers: set[str] = set()
        self._event_buffer: list[dict] = []
        self._last_brief = ""
        self._last_brief_at = 0.0
        self._connect_lock = asyncio.Lock()
        # 上次尝试进服的时间（监管循环用它做冷却，防止连服抖动）
        self._last_connect_attempt = 0.0
        self._supervise_task: asyncio.Task | None = None

        # ---- 人格 / 记忆 / 过日子
        # 这三块让她"是某个人在玩"，而不是"一个执行任务的机器人"
        self.persona: MinecraftPersona | None = None
        self.memory: MemoryStore | None = None
        self.drives: DriveSystem | None = None
        self.life: LifeLoop | None = None
        self._data_dir: Path | None = None
        # 游戏内对话代理：让玩家在游戏里说的话能驱动动作（不只是聊天）
        self.game_agent: GameChatAgent | None = None
        # 游戏内回复串行锁：两个人同时跟她说话时，一次只处理一条。
        # 不然两个 LLM 调用并行，回话乱序，而且工具调用可能互相打架
        # （一个说"砍树"、一个说"停下"，两个任务抢同一个身体）。
        self._game_reply_lock = asyncio.Lock()
        # 上一次任务播报时间（链式任务只报一次，避免刷屏）
        self._last_task_announce = 0.0

    # ================================================================ 配置

    def _cfg(self, key: str, default=None):
        value = self.config.get(key)
        if value is None or value == "":
            return default
        return value

    def _engine_dir(self) -> Path:
        """定位 Node 引擎目录。

        查找顺序（第一个存在的胜出）：
          1. 配置里的 engine_dir（绝对路径，最可靠，推荐生产环境用）
          2. 插件目录下的 engine/ —— 把引擎打包进插件时用，随插件一起被复制
          3. 插件目录同级、上一级、上两级的 bot/ —— 开发时的仓库布局
        找不到就返回候选路径中最合理的一个，交由上层给出可操作的报错。
        """
        raw = self._cfg("engine_dir")
        if raw:
            p = Path(str(raw)).expanduser()
            if p.exists():
                return p
            logger.warning("配置的 engine_dir 不存在：%s，继续尝试自动探测", raw)

        plugin_dir = Path(__file__).resolve().parent
        candidates = [
            plugin_dir / "engine",           # 引擎随插件打包
            plugin_dir.parent / "bot",       # 仓库布局：<repo>/plugin 与 <repo>/bot
            plugin_dir.parent.parent / "bot",
            plugin_dir / "bot",
        ]
        for c in candidates:
            if (c / "index.js").exists():
                return c
        # 都不存在时返回首选候选，让上层报错里能给出具体路径
        return candidates[0]

    async def initialize(self):
        """插件加载：启动引擎、装配人格/记忆/过日子，并（按配置）自动进服。"""
        logger.info("Minecraft 插件 v%s 正在初始化", PLUGIN_VERSION)

        # 最先做：把工具方法绑定到本实例。这一步是**必需**的，原因见方法注释——
        # 不修的话所有工具在 AstrBot 里都会以"缺少 event 参数"失败。
        self._bind_llm_tools()

        # 数据目录：记忆、驱动水位、人格选择都存这里。
        # 用专门的多候选解析（见 datadir.py）：官方 API 靠 inspect 推断调用栈，
        # 在某些加载方式下会失败；而且目录位置一旦变化会**静默丢记忆**，
        # 所以优先复用"已经有数据"的那个目录。
        self._data_dir = resolve_data_dir(PLUGIN_NAME, Path(__file__).resolve().parent)
        self._data_dir.mkdir(parents=True, exist_ok=True)

        # ---- 人格：直接接 AstrBot 的人格库
        self.persona = MinecraftPersona(context=self.context, data_dir=self._data_dir, cfg=self._cfg)
        cur = await self.persona.resolve()
        logger.info("当前人格：%s（来源 %s）", cur.get("name"), cur.get("source"))

        # ---- 记忆与驱动
        self.memory = MemoryStore(self._data_dir)
        self.drives = DriveSystem(self._data_dir)
        # 人格会影响"她更容易想起哪类事"
        self.drives.apply_personality(cur.get("prompt") or "")

        cfg = EngineConfig(
            engine_dir=self._engine_dir(),
            node_path=str(self._cfg("node_path", "")),
            log_level=str(self._cfg("engine_log_level", "info")),
        )
        self.engine = EngineClient(cfg)
        self.engine.on_disconnected = self._on_engine_disconnected
        self.engine.on("bot.spawn", self._on_bot_spawn)
        self.engine.on("bot.death", self._on_bot_death)
        self.engine.on("bot.kicked", self._on_bot_kicked)
        self.engine.on("bot.disconnect", self._on_bot_disconnect)
        self.engine.on("bot.reconnecting", self._on_bot_reconnecting)
        self.engine.on("chat", self._on_game_chat)
        # 见闻事件 → 写进她的记忆，并（值得的话）主动分享
        self.engine.on("discovery.mob", self._on_discovery)
        self.engine.on("discovery.treasure", self._on_discovery)
        self.engine.on("discovery.milestone", self._on_discovery)
        # 技能任务完成 → 在游戏里吱一声（否则玩家只看到"已开始"，永远不知道结果）
        self.engine.on("task.finished", self._on_task_finished)
        # 有人走到她附近 → 主动打个招呼（真人不等人先开口）
        self.engine.on("player.nearby", self._on_player_nearby)

        self.goals = GoalManager(
            engine_call=self._engine_call,
            on_event=self._on_goal_event,
            llm_planner=self._llm_plan if self._cfg("enable_llm_planner", True) else None,
        )

        # ---- 过日子循环
        self.life = LifeLoop(
            engine_call=self._engine_call,
            memory=self.memory,
            drives=self.drives,
            brief_provider=self._get_brief,
            llm=self._llm,
            system_prompt_provider=self._system_prompt_for_mc,
            skill_catalog_provider=self._skill_catalog,
            on_share=self._share_to_world,
            on_activity=self._on_life_activity,
            is_connected=lambda: self.connected,
            state_provider=self._life_state_snapshot,
            decide_interval=float(self._cfg("life_decide_interval", 20) or 20),
            # 两次决策之间的最小间隔（"承诺机制"）：避免她被"任务完成"反复唤醒、
            # 每几秒改一次主意（那是"乱走乱挖"的主要来源）。0 = 关掉。
            min_decide_gap=float(self._cfg("life_min_decide_gap", 6) or 0),
            share_cooldown=float(self._cfg("life_share_cooldown", 600) or 600),
        )
        self.life.bind_data_dir(self._data_dir)
        # 决策阶段的"先查看再决定"：给她一套只读感知工具。
        # 拿不到工具（没 provider / 工具管理器不可用）会自动退回纯文本决策。
        try:
            self.life.perception = PerceptionAgent(self)
        except Exception as exc:  # noqa: BLE001
            logger.warning("感知代理初始化失败（决策将退回纯文本）：%s", exc)

        # 自主行动的"手"：带**完整工具集**的 ReAct 循环，让 LLM 直接驱动她做事。
        # 拿不到工具集会返回 False，过日子循环自动退回"挑技能"的旧路径。
        try:
            self.life.action_agent = ActionAgent(self)
        except Exception as exc:  # noqa: BLE001
            logger.warning("动作代理初始化失败（自主行动将退回挑技能）：%s", exc)

        # ---- 知识库：攻略（人写的）+ 教训（她自己从失败里提炼的）
        try:
            self.knowledge = KnowledgeBase(self._data_dir)
            self.life.knowledge = self.knowledge
            st = self.knowledge.stats()
            logger.info(
                "知识库就绪：%s 篇攻略、%s 条她自己总结的教训、%s 条世界笔记",
                st.get("docs"),
                st.get("lessons"),
                st.get("notes"),
            )
        except Exception as exc:  # noqa: BLE001
            self.knowledge = None
            logger.warning("知识库初始化失败（她将不会积累经验）：%s", exc)

        # ---- 游戏内对话代理：玩家在游戏里让她做事，她真的会去做
        self.game_agent = GameChatAgent(self)

        # 把引擎的输出转发到日志（引擎通道）
        if self._cfg("forward_engine_events", True):
            self.engine.on("*", self._on_any_engine_event)

        try:
            await self.engine.start()
        except EngineUnavailable as exc:
            logger.error("Minecraft 引擎启动失败：%s", exc)
            logger.error("请检查：1) 是否已安装 Node 依赖  2) engine_dir / node_path 配置是否正确")
            return

        if self._cfg("auto_connect", False):
            asyncio.create_task(self._auto_connect(), name="mc-auto-connect")
        # 引擎监管：崩了自动拉起（引擎进程是长期依赖，不能等用户手动重启）
        self._supervise_task = asyncio.create_task(self._supervise_loop(), name="mc-engine-supervise")

        # 兜底：即使 on_astrbot_loaded 钩子没触发（某些版本/加载路径下可能不触发），
        # 也要在稍后把工具绑定补上——initialize 执行时工具往往还没注册完。
        for delay in (5, 15, 40):
            asyncio.create_task(self._bind_tools_later(delay), name=f"mc-bind-init-{delay}")

    async def terminate(self):
        """插件卸载：停目标与过日子、落盘、断游戏、关引擎。"""
        logger.info("Minecraft 插件正在卸载")
        if self._supervise_task and not self._supervise_task.done():
            self._supervise_task.cancel()
        if self.goals:
            await self.goals.stop()
        if self.life:
            await self.life.stop()
        # 记忆与驱动状态落盘，下次启动她还能记得
        if self.memory:
            self.memory.save(force=True)
        if self.drives:
            self.drives.save()
        if self.engine:
            try:
                if self.engine.running and self.connected:
                    await self.engine.call("disconnect", {}, timeout=5.0)
            except Exception:  # noqa: BLE001
                pass
            await self.engine.stop()
        logger.info("Minecraft 插件已卸载")

    # ================================================================ 引擎监管

    async def _supervise_loop(self):
        """每 20 秒确认引擎还活着；不在就拉起并尝试恢复游戏连接。"""
        while True:
            try:
                await asyncio.sleep(20)
                if not self.engine:
                    return
                if self.engine.running and await self.engine.ping():
                    # 引擎存活：进一步确认游戏连接是否正常（防止引擎活着但游戏掉线后不重试）。
                    #
                    # **必须加冷却**：连接是需要几秒的过程，而 self.connected 在连接完成前一直是
                    # False。早期这里只看这个标记，于是在连接进行中又触发一次 _auto_connect，
                    # 新连接会把正在建立的连接踢掉 → 实测日志里出现连续 5 次"已进服"和
                    # 成对的"主动断开"（连服抖动）。现在同时要求"距上次尝试超过 25 秒"。
                    if self._cfg("auto_connect", False) and not self.connected:
                        now = time.time()
                        if now - self._last_connect_attempt >= 25:
                            try:
                                st = await self.engine.status()
                                if not st.get("connected"):
                                    await self._auto_connect(reason="监管发现游戏掉线，尝试恢复连接")
                            except Exception:  # noqa: BLE001
                                pass
                    # 顺手把心情推给引擎（情绪表达：动机水位 → 走路节奏）。
                    # 放在这里是因为它每 20 秒跑一次、而且必然在"引擎活着"时执行，
                    # 不用另开定时器。
                    try:
                        await self.push_mood()
                    except Exception as exc:  # noqa: BLE001
                        logger.debug("推送心情失败（不影响其它功能）：%s", exc)
                    continue
                if not self.engine.running:
                    logger.warning("检测到引擎未运行，正在重新拉起")
                    self.connected = False
                    try:
                        await self.engine.start()
                        if self._cfg("auto_connect", False):
                            await self._auto_connect(reason="引擎重启后恢复")
                    except Exception as exc:  # noqa: BLE001
                        logger.error("重新拉起引擎失败：%s", exc)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.error("引擎监管循环异常：%s", exc)

    async def _engine_call(self, method: str, params: dict | None = None, *, timeout: float = 30.0):
        """给 GoalManager 用的调用入口（引擎不可用时抛 EngineUnavailable）。"""
        if not self.engine:
            raise EngineUnavailable("引擎未初始化")
        return await self.engine.call(method, params, timeout=timeout)

    async def _ensure_engine(self) -> bool:
        if not self.engine:
            return False
        if self.engine.running:
            return True
        try:
            await self.engine.start()
            return True
        except Exception as exc:  # noqa: BLE001
            logger.error("启动引擎失败：%s", exc)
            return False

    # ================================================================ 连接

    @filter.on_astrbot_loaded()
    async def _on_astrbot_loaded(self, *args, **kwargs):
        """AstrBot 全部加载完成后再绑一次工具。

        **为什么需要这个钩子**：`initialize()` 在插件"启用"之前执行，
        那时本插件的工具还没注册进 `provider_manager.llm_tools`，
        所以 initialize 里的绑定扫到的是空列表、等于没绑。
        而 AstrBot 自己的绑定生命周期又不会处理定义在子模块里的工具
        （它按 `__module__ == 插件主模块` 过滤），于是 handler 一直未绑定，
        所有工具调用都会以 "missing 1 required positional argument: 'event'" 失败。

        这个钩子在加载完成时触发，那时工具一定已经注册好了。
        """
        self._bind_llm_tools()
        # 再延迟补几次：不同 AstrBot 版本的注册顺序可能有差异，
        # 多试几次成本极低（绑定是幂等的），但能避免"工具静默不可用"这种最坑的故障。
        for delay in (5, 15, 40):
            asyncio.create_task(self._bind_tools_later(delay), name=f"mc-bind-{delay}")

    async def _bind_tools_later(self, delay: float) -> None:
        await asyncio.sleep(delay)
        self._bind_llm_tools()

    def _bind_llm_tools(self) -> None:
        """把本插件的 LLM 工具绑定到插件实例上。

        **为什么必须自己动手**（这是"她什么都不能做"的根因，务必保留）：

        AstrBot 在加载插件时会做一次"绑定生命周期"，但它的匹配条件是
        `getattr(ft.handler, "__module__") == metadata.module_path`——
        只处理**定义在插件主模块里**的工具。而本插件的 39 个工具定义在
        `llm_tools_core.py` / `llm_tools_skills.py` / `llm_tools_life.py` 里，
        `__module__` 是 `astrbot_plugin_astrcraft.llm_tools_core`，**永远不等于**
        插件主模块路径，于是这些 handler 一直保持**未绑定的原始函数**状态。

        后果：AstrBot 执行工具时会 `handler(event, **kwargs)`，
        这个 event 被当成 `self` 传进去，于是抛
        `tool_mc_goto() missing 1 required positional argument: 'event'`——
        **所有工具（QQ 渠道和游戏内）全部失败**，她只会回话、不会做任何事。

        这里自己绑一遍，不依赖 AstrBot 的模块匹配规则；对已经是 partial 或
        已绑定的情况不动（幂等）。
        """
        try:
            context = getattr(self, "context", None)
            provider_manager = getattr(context, "provider_manager", None)
            manager = getattr(provider_manager, "llm_tools", None)
            if manager is None:
                logger.debug("拿不到工具管理器，跳过工具绑定")
                return

            fixed = []
            for tool in getattr(manager, "func_list", []) or []:
                name = getattr(tool, "name", "") or ""
                if not name.startswith("mc_"):
                    continue  # 只碰自己的工具
                handler = getattr(tool, "handler", None)
                if handler is None:
                    continue
                raw = handler.func if isinstance(handler, functools.partial) else handler
                try:
                    params = list(inspect.signature(raw).parameters)
                except (TypeError, ValueError):
                    continue
                if not params or params[0] not in ("self", "cls"):
                    continue  # 已经绑好了
                tool.handler = functools.partial(raw, self)
                fixed.append(name)

            if fixed:
                logger.info(
                    "已把 %s 个工具绑定到插件实例（AstrBot 的自动绑定不会处理"
                    "定义在子模块里的工具，不修则全部工具调用失败）：%s",
                    len(fixed),
                    "、".join(fixed[:5]) + ("…" if len(fixed) > 5 else ""),
                )
            else:
                logger.debug("工具绑定检查完成：无需修正")
        except Exception as exc:  # noqa: BLE001
            logger.error("工具绑定失败（工具调用可能全部不可用）：%s", exc)

    def _engine_settings_from_config(self) -> dict:
        """把插件配置里"引擎侧才生效"的项整理出来。

        这些配置在 **引擎** 里才起作用（安全白/黑名单在 actions.js 的
        `_assertNotProtected`，技能超时在 submitSkill）。不下发的话，
        用户在 WebUI 里改了会以为生效了——安全相关的静默失效尤其危险。
        """
        out: dict = {}

        whitelist = self._cfg("dig_whitelist", None)
        if isinstance(whitelist, list) and whitelist:
            out["digWhitelist"] = [str(x) for x in whitelist]

        blacklist = self._cfg("dig_blacklist", None)
        if isinstance(blacklist, list):
            # 空列表也是有效配置（表示"不额外禁止"），所以要显式下发
            out["digBlacklist"] = [str(x) for x in blacklist]

        radius = self._cfg("spawn_protection_radius", None)
        if radius is not None:
            try:
                out["spawnProtectionRadius"] = int(radius)
            except (TypeError, ValueError):
                logger.warning("spawn_protection_radius 不是整数，已忽略：%r", radius)

        # 自动行为开关（这些是引擎反射层用的，插件侧改完必须下发，
        # 否则用户在 WebUI 里关了也会"看起来没生效"）
        for cfg_key, engine_key in (
            ("auto_collect_drops", "autoCollectDrops"),
            ("auto_torch", "autoTorch"),
            ("auto_eat", "autoEat"),
            ("auto_defend", "autoDefend"),
            ("humanize", "humanize"),
            ("enable_viewer", "enableViewer"),
            ("viewer_first_person", "viewerFirstPerson"),
        ):
            val = self._cfg(cfg_key, None)
            if val is not None:
                out[engine_key] = bool(val)

        # 观战窗口的端口/渲染距离是数字，不能走上面那条 bool 通道
        for cfg_key, engine_key in (
            ("viewer_port", "viewerPort"),
            ("viewer_view_distance", "viewerViewDistance"),
        ):
            val = self._cfg(cfg_key, None)
            if val is not None:
                try:
                    out[engine_key] = int(val)
                except (TypeError, ValueError):
                    logger.warning("%s 不是整数，已忽略：%r", cfg_key, val)

        return out

    async def _push_engine_settings(self) -> None:
        """下发引擎侧配置，并记录结果（便于排障时确认"到底生效了没"）。"""
        if not self.engine or not self.engine.running:
            return
        settings = self._engine_settings_from_config()
        if not settings:
            return
        try:
            r = await self.engine.apply_engine_settings(settings)
            applied = (r or {}).get("applied") or {}
            logger.info("已下发引擎配置：%s", applied if applied else settings)
        except Exception as exc:  # noqa: BLE001
            logger.warning("下发引擎配置失败（安全设置可能未生效）：%s", exc)

    async def push_mood(self) -> None:
        """把她的**真实心情**推给引擎，接到走路节奏上（情绪表达）。

        原来引擎里的"悠闲/精神"是随机数，跟她此刻想干什么毫无关系。
        现在动机水位一下来，她走路的样子就跟着心情变：
        悠闲欲高 → 走得慢、常停下来看；着急（血量低 / 天要黑）→ 爱跑。
        """
        if not self.engine or not self.engine.running or not self.drives:
            return
        try:
            snap = self.drives.snapshot()
        except Exception:  # noqa: BLE001
            return
        # snapshot 的结构是 {top: "explore", levels: {explore: 0.0, ...}, bias: {}}
        levels = snap.get("levels") if isinstance(snap, dict) else None
        top = str(snap.get("top") or "") if isinstance(snap, dict) else ""
        if not isinstance(levels, dict) or not levels:
            return
        key = max(levels.items(), key=lambda kv: float(kv[1] or 0))[0]
        # 标签（"悠闲欲"/"探索欲"…）在 Drive 定义里
        label = key
        try:
            for d in getattr(self.drives, "drives", []) or []:
                if getattr(d, "key", None) == key:
                    label = getattr(d, "label", key)
                    break
        except Exception:  # noqa: BLE001
            pass
        mood = {
            "drive": key,
            "label": label,
            "intensity": round(float(levels.get(key) or 0), 2),
        }
        # 紧急情况直接调高 urgency：血量低或快天黑了
        try:
            brief = await self._get_brief(max_age=5.0)
        except Exception:  # noqa: BLE001
            brief = ""
        urgency = 0.0
        if "天黑" in brief or "血量只有" in brief or "饿" in brief:
            urgency = 0.9
        mood["urgency"] = urgency
        try:
            await self.engine.call("config.update", {"mood": mood}, timeout=10.0)
        except Exception as exc:  # noqa: BLE001
            logger.debug("推送心情失败（不影响其它功能）：%s", exc)

    async def _auto_connect(self, reason: str = "自动连接"):
        async with self._connect_lock:
            if self.connected:
                return
            # 记下尝试时间：监管循环靠它做冷却，避免"连接还没完成又发起一次"
            # 把正在建立的连接踢掉（实测会连服抖动：连续 5 次"已进服"+成对"主动断开"）。
            self._last_connect_attempt = time.time()
            try:
                host = str(self._cfg("server_host", "127.0.0.1"))
                port = int(self._cfg("server_port", 25565))
                username = str(self._cfg("bot_username", "AstrBot"))
                version = str(self._cfg("mc_version", "1.20.1"))
                auth = str(self._cfg("auth_method", "offline"))
                skill_timeout_s = self._cfg("skill_timeout_seconds", 300)
                try:
                    skill_timeout_ms = int(skill_timeout_s) * 1000
                except (TypeError, ValueError):
                    skill_timeout_ms = None
                    logger.warning("skill_timeout_seconds 不是数字，已用引擎默认值：%r", skill_timeout_s)

                logger.info("%s：连接 %s:%s（%s）", reason, host, port, version)
                await self.engine.connect_game(
                    host=host,
                    port=port,
                    username=username,
                    version=version,
                    auth=auth,
                    slow_mode=bool(self._cfg("slow_mode", False)),
                    auto_mode=bool(self._cfg("auto_mode", True)),
                    auto_eat=bool(self._cfg("auto_eat", True)),
                    auto_defend=bool(self._cfg("auto_defend", True)),
                    skill_timeout_ms=skill_timeout_ms,
                    extra=self._engine_settings_from_config(),
                )
                self.connected = True
                logger.info(
                    "连接成功（慢速模式=%s，自动进食=%s，自动反击=%s，技能超时=%s秒）",
                    bool(self._cfg("slow_mode", False)),
                    bool(self._cfg("auto_eat", True)),
                    bool(self._cfg("auto_defend", True)),
                    skill_timeout_s,
                )
            except EngineError as exc:
                logger.error("进服失败：%s", exc)
                await self._notify_subscribers(f"⚠️ Minecraft 机器人进服失败：{exc}")
            except Exception as exc:  # noqa: BLE001
                logger.error("进服异常：%s", exc)

    async def _do_disconnect(self) -> str:
        self.connected = False
        if not self.engine or not self.engine.running:
            return "引擎未运行"
        try:
            await self.engine.call("disconnect", {}, timeout=10.0)
            return "已断开游戏连接"
        except Exception as exc:  # noqa: BLE001
            return f"断线时出错（可能已经断开）：{exc}"

    # ================================================================ 事件

    def _remember(self, event: str, data: dict) -> None:
        self._event_buffer.append({"event": event, "data": data, "at": time.time()})
        if len(self._event_buffer) > 100:
            self._event_buffer.pop(0)

    async def _on_any_engine_event(self, payload: dict) -> None:
        event = payload.get("event", "")
        self._remember(event, payload.get("data") or {})

    async def _on_engine_disconnected(self, reason: str) -> None:
        self.connected = False
        logger.warning("引擎通道断开：%s", reason)

    async def _on_bot_spawn(self, data: dict) -> None:
        self.connected = True
        pos = data.get("position") or {}
        logger.info("机器人已进服：%s @ %s", data.get("username"), data.get("version"))

        # **每次进游戏都重新排一份计划**（用户要的"每一次进游戏也会生成一个任务"）。
        # 旧的计划是针对"上次那个处境"排的，进服后处境可能完全不同
        # （换了位置、身上东西没了、天黑了），接着旧计划干往往第一件事就不成立。
        if self.life:
            try:
                self.life.on_session_start()
            except Exception as exc:  # noqa: BLE001
                logger.debug("会话开始时清理计划失败：%s", exc)

        await self._notify_subscribers(
            f"✅ 机器人已进入 Minecraft（{data.get('username')}，{data.get('version')}）\n位置 ({pos.get('x')}, {pos.get('y')}, {pos.get('z')})"
        )

        # ---- 进服后装配"她的世界"
        # 0) 先把插件配置里"引擎侧才生效"的项下发（安全白/黑名单、技能超时等）
        await self._push_engine_settings()

        # 1) 把历史见闻灌回引擎，这样"第一次见到熊猫"的语义跨重启仍然成立
        if self.engine and self.memory:
            try:
                saved = await self._engine_call("memory.export_discoveries", {})
                recorded = self.memory.stats()
                logger.info(
                    "她的记忆：%s 条经历（%s）；引擎侧已知见闻：%s 种生物 / %s 种贵重物品",
                    recorded.get("total"),
                    "、".join(f"{k}×{v}" for k, v in (recorded.get("by_kind") or {}).items()) or "无",
                    len(saved.get("mobs") or []),
                    len(saved.get("items") or []),
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("读取见闻失败：%s", exc)

        # 2) 人格可能被改过，重新按人格调整动机倾向
        if self.drives and self.persona:
            try:
                cur = await self.persona.resolve()
                self.drives.apply_personality(cur.get("prompt") or "")
            except Exception as exc:  # noqa: BLE001
                logger.debug("按人格调整动机失败：%s", exc)

        # 3) 启动"过日子"循环
        if self.life and not self.life.running:
            if self._cfg("enable_life_loop", True):
                self.life.start()
                await self._notify_subscribers(
                    f"🌱 她开始自己过日子了（空闲时每 {int(self._cfg('life_decide_interval', 20) or 20)} 秒想一次自己在干嘛，任务一结束会立刻继续）"
                )
            else:
                logger.info("过日子循环已在配置中关闭（enable_life_loop=false）")

    async def _on_player_nearby(self, data: dict) -> None:
        """有人走到她附近 → 主动打个招呼（主动社交）。

        她原来只会被动回应：别人先说话她才答。真人不这样——有人走进视野，
        你会抬头看一眼，熟人还会先说一句。这个回调做的就是这件事。

        **措辞交给她自己**：这里只说"谁来了、离多近"，具体说什么由她的
        人格和当下心情决定（走 life.share_event 那条路，带冷却与限流）。
        """
        player = str(data.get("player") or "").strip()
        if not player:
            return
        dist = data.get("distance")
        who = f"{player}（{dist} 格外）" if dist is not None else player
        logger.info("注意到有人过来了：%s", who)
        if self.life:
            await self.life.share_event(
                kind="social",
                text=f"你注意到 {player} 走到你附近了（{dist} 格外）。抬头看了一眼",
                force=False,
            )
        await self._notify_subscribers(f"👀 她注意到有人过来：{who}")

    async def _on_bot_death(self, data: dict) -> None:
        pos = data.get("position") or {}
        place = f"({pos.get('x')}, {pos.get('y')}, {pos.get('z')})"
        await self._notify_subscribers(f"💀 机器人死了（位置 {place}），会自动重生")

        # 死亡是最难忘的经历之一：记下来，并用她的语气说一句
        if self.memory:
            await self._maybe_remember(
                "death",
                f"我在 {place} 死了",
                tags=["死亡"],
                context={"position": pos},
                dedupe_window=30,
            )
        if self.life:
            # 让决策层知道"我刚死在哪儿、东西掉在那儿了"——
            # 真人死后第一反应是回去捡，而 MC 里掉落物大约 5 分钟就消失。
            try:
                self.life.note_death(pos)
            except Exception as exc:  # noqa: BLE001
                logger.debug("记录死亡地点失败：%s", exc)
            asyncio.create_task(
                self.life.share_event(kind="death", text=f"我在 {place} 死了", force=True),
                name="mc-share-death",
            )

    async def _on_bot_kicked(self, data: dict) -> None:
        self.connected = False
        await self._notify_subscribers(f"🚫 机器人被服务器踢出：{data.get('reason')}")

    async def _on_bot_disconnect(self, data: dict) -> None:
        self.connected = False
        if data.get("manual"):
            return
        await self._notify_subscribers(f"🔌 机器人断线：{data.get('reason')}")

    async def _on_bot_reconnecting(self, data: dict) -> None:
        wait = int((data.get("wait_ms") or 0) / 1000)
        logger.info("引擎将在 %s 秒后重连（第 %s 次）", wait, data.get("attempt"))

    @staticmethod
    def _skill_name_from_task(task_name: str) -> str | None:
        """引擎的任务名是中文（"砍 2 根木头"、"挖石头"），失败记忆要按技能名归类。"""
        if not task_name:
            return None
        table = (
            ("砍", "chop_tree"),
            ("木头", "chop_tree"),
            ("工具", "make_tools"),
            ("石头", "mine_stone"),
            ("矿", "mine_ores"),
            ("熔炼", "smelt"),
            ("庇护所", "build_shelter"),
            ("小屋", "build_shelter"),
            ("存", "store_items"),
            ("食物", "cook_food"),
            ("补给", "supply"),
            ("收集", "collect"),
        )
        for key, skill in table:
            if key in task_name:
                return skill
        return None

    async def _life_state_snapshot(self) -> dict:
        """给「过日子」的生存顾问取真实状态（背包/血量/饥饿/是否夜晚/背包占用）。

        顾问据此判断她在哪个生存阶段、下一步该做什么。
        取不到就返回空 dict，顾问会用保守默认值，不会因此崩掉决策。
        """
        out: dict = {"has_shelter": bool(getattr(self.life, "_has_shelter", False))}
        if not self.engine or not self.engine.running or not self.connected:
            return out
        try:
            st = await self.engine.call("state.get", {"detail": "normal"}, timeout=8.0)
        except Exception as exc:  # noqa: BLE001
            logger.debug("取状态快照失败：%s", exc)
            return out
        if not isinstance(st, dict):
            return out
        out["health"] = st.get("health", 20)
        out["food"] = st.get("food", 20)
        # 白天/黑夜：Minecraft 一天 24000 tick，13000-23000 是夜晚
        tod = st.get("time_of_day")
        if isinstance(tod, (int, float)):
            out["is_night"] = 13000 <= int(tod) <= 23000
        inv_summary = st.get("inventory_summary") or {}
        if isinstance(inv_summary, dict):
            out["inventory_slots_used"] = int(inv_summary.get("used_slots") or 0)
        try:
            inv = await self.engine.call("inventory.get", {}, timeout=8.0)
            items = (inv or {}).get("items") if isinstance(inv, dict) else None
            if isinstance(items, dict):
                out["inventory"] = items
                if not out.get("inventory_slots_used"):
                    out["inventory_slots_used"] = len(items)
        except Exception as exc:  # noqa: BLE001
            logger.debug("取背包失败：%s", exc)
        return out

    async def _on_task_finished(self, data: dict) -> None:
        """技能任务结束 → 在游戏里播报结果，并恢复过日子循环。

        修的问题：玩家在游戏里说"砍树"，她回"好，我去了"（任务号 xxx），
        然后就没下文了——砍没砍完、砍到几个，玩家不问就永远不知道。
        这跟真人队友"我砍完了，给你"的体验差太远。

        只播报技能任务（kind=skill）：反射层的吃口饭、后退两步不值得说。
        """
        # 玩家指派的活干完了 → 她可以继续过自己的日子
        if self.life and self.life.paused:
            self.life.resume()
            logger.debug("任务结束，过日子循环已恢复")

        # **叫醒她**：手头的事做完了，立刻想下一步。
        # 没有这一步时，她要等满一个完整决策间隔（实测 190~200 秒）才会想下一件事，
        # 看起来就是"做完一件事就呆住了"。
        if self.life:
            try:
                self.life.wake(reason=f"{data.get('name') or '任务'} {data.get('status')}")
            except Exception as exc:  # noqa: BLE001
                logger.debug("唤醒过日子循环失败：%s", exc)

        # 把结果写进"失败记忆"：决策层要知道"这个技能刚失败过"，
        # 否则会出现实测过的死循环（同一个技能连失败几十次、持续一小时）。
        if self.life:
            try:
                task_name = str(data.get("name") or "")
                ok = data.get("status") == "done"
                # 把"砍 2 根木头""挖石头"这类中文任务名映射回技能名
                skill_name = self._skill_name_from_task(task_name)
                self.life.note_task_result(skill_name or task_name, ok, str(data.get("error") or ""))
            except Exception as exc:  # noqa: BLE001
                logger.debug("记录任务结果失败：%s", exc)

        if data.get("kind") != "skill":
            return
        status = data.get("status")
        if status == "cancelled":
            return  # 被叫停的不用播报（叫停的人知道自己做了什么）
        if not self._cfg("announce_task_done", True):
            return
        if not self.connected or not self.engine or not self.engine.running:
            return

        # 冷却：链式任务（比如做工具会连着做几件）只报一次，别刷屏
        now = time.time()
        if now - self._last_task_announce < 15:
            logger.debug("任务播报冷却中，跳过：%s %s", data.get("name"), status)
            return
        self._last_task_announce = now

        name = data.get("name") or "任务"
        error = data.get("error") or ""
        result = data.get("result")
        outcome = ""
        if isinstance(result, dict):
            bits = []
            for key in ("collected", "count", "crafted", "items", "summary"):
                if key in result and result[key] not in (None, "", 0, False):
                    bits.append(f"{key}={result[key]}")
            if bits:
                outcome = "（" + "，".join(bits[:4]) + "）"

        try:
            system = await self._system_prompt_for_mc()
            if status == "done":
                situation = f"你刚刚做完了「{name}」{outcome}。"
            else:
                situation = f"你刚才想做「{name}」，但是没做成：{error}。"
            prompt = (
                f"{situation}\n"
                "用你的人格在游戏里说一句（不超过 30 字），告诉大家这个结果。"
                "成功了可以带点成就感，失败了直说原因，不要道歉腔。只输出这句话本身。"
            )
            line = await self._llm(prompt, system)
            if not line:
                return
            line = line.strip().splitlines()[0][:120]
            if not line:
                return
            await self.engine.say(line)
            await self._notify_subscribers(f"📢 {line}")
            if self.memory:
                kind_cn = "完成" if status == "done" else "没能完成"
                await self._maybe_remember(
                    "trivial",
                    f"我{kind_cn}了「{name}」{outcome or (('：' + error) if error else '')}",
                    tags=[name],
                    weight=3,
                    dedupe_window=120,
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("任务播报失败：%s", exc)

    async def _on_game_chat(self, data: dict) -> None:
        sender = data.get("sender")
        message = data.get("message")
        if not sender or not message:
            return

        # 自己的话不处理——这条防线必须放在最前面。
        # 有些服务端/插件会把发言回显给本人，而唤醒词里恰恰包含她的名字，
        # 不过滤会出现"她自己说的话又触发了她自己回复"的自循环。
        bot_name = str(self._cfg("bot_username", "AstrBot"))
        if sender.strip().lower() == bot_name.lower():
            return

        await self._notify_subscribers(f"💬 [{sender}] {message}")

        # 社交也是经历：记下来（她是"认识这个人"的）
        if self.memory:
            await self._maybe_remember("social", f"{sender} 跟我说：{message}", tags=[sender], weight=3, dedupe_window=120)

        # 游戏内聊天是否触发 LLM 回复
        if not self._cfg("reply_in_game", True):
            return
        if not self._should_reply(message):
            return
        asyncio.create_task(self._reply_in_game(sender, message), name="mc-reply")

    def _should_reply(self, message: str) -> bool:
        text = (message or "").strip()
        if not text:
            return False
        wake = self._cfg("wake_words", []) or []
        if isinstance(wake, str):
            wake = [w for w in wake.split(",") if w]
        names = [str(w).strip() for w in wake if str(w).strip()]
        names.append(str(self._cfg("bot_username", "AstrBot")))
        low = text.lower()
        return any(n.lower() in low for n in names)

    async def _reply_in_game(self, sender: str, message: str) -> None:
        """在游戏内回应玩家。

        两条路径：
        1. **工具调用代理**（默认）：LLM 带着 mc_* 工具，玩家说"砍树"她真的去砍。
           这是修"什么都做不了"的关键——旧版这条路径只是 llm_generate 生成文字，
           LLM 根本拿不到工具，所以她"只会说不会做"。
        2. 纯文字回复（兜底）：LLM/工具管理器不可用时，退化为只回话不动手。
        """
        # 一次只处理一条。正在回上一条时新消息直接丢弃（记日志）——
        # 排队反而更糟：玩家连说三句，她隔十秒一句句回，像机器人而不是人。
        if self._game_reply_lock.locked():
            logger.debug("正在回复上一条，丢弃 %s 的消息：%s", sender, message[:30])
            return
        async with self._game_reply_lock:
            try:
                reply: str | None = None

                if self._cfg("in_game_actions", True) and self.game_agent:
                    try:
                        reply = await asyncio.wait_for(
                            self.game_agent.handle(sender, message),
                            timeout=float(self._cfg("in_game_llm_timeout", 120) or 120),
                        )
                    except asyncio.TimeoutError:
                        logger.warning("游戏内代理超时（%s：%s）", sender, message[:30])
                        reply = None
                    except Exception as exc:  # noqa: BLE001
                        logger.error("游戏内动作代理失败，退回纯文字：%s", exc)
                        reply = None

                if reply is None:
                    # 兜底：纯文字聊天
                    brief = await self._get_brief()
                    system = await self._system_prompt_for_mc()
                    memos = await self._my_memory(f"{message} {sender}", limit=4)

                    context_parts = [f"你在 Minecraft 服务器里游玩。\n当前状态：\n{brief}"]
                    if memos:
                        context_parts.append(f"你记得的事：\n{memos}")
                    context_parts.append(f"玩家 {sender} 对你说：{message}")
                    context_parts.append("用一句话回应（不超过 40 字），符合你的身份与当前处境。")

                    reply = await self._llm("\n\n".join(context_parts), system)

                if not reply:
                    return
                text = reply.strip().replace("\n", " ")[:200]
                if self.engine and self.engine.running:
                    await self.engine.say(text)
                    # 自己说过的话也算经历（下次她可能记得"我跟他聊过什么"）
                    if self.memory:
                        await self._maybe_remember("social", f"我跟 {sender} 说：{text}", tags=[sender], weight=2, dedupe_window=60)
            except Exception as exc:  # noqa: BLE001
                logger.error("游戏内回复失败：%s", exc)

    async def _resolve_provider_id(self, umo: str | None = None) -> str | None:
        """取要用的模型 Provider ID。

        AstrBot 的 `get_current_chat_provider_id(umo)` **必须**传一个真实的会话来源字符串，
        传 None 会取不到。所以没有会话上下文时（例如游戏内自主回话）改走
        `get_using_provider_async()` 拿默认聊天模型，再从它的 provider_config 里取 id。
        """
        if umo:
            try:
                pid = await self.context.get_current_chat_provider_id(umo=umo)
                if pid:
                    return pid
            except Exception as exc:  # noqa: BLE001
                logger.debug("取会话模型失败，回退默认模型：%s", exc)
        try:
            provider = await self.context.get_using_provider_async(umo=umo)
            if provider is not None:
                return (provider.provider_config or {}).get("id")
        except Exception as exc:  # noqa: BLE001
            logger.debug("取默认模型失败：%s", exc)
        return None

    async def _llm(self, prompt: str, system: str | None = None, umo: str | None = None) -> str | None:
        """调用 AstrBot 的 LLM。

        未配置 Provider 时返回 None 而不是抛异常——游戏流程不该因为模型没配就中断。
        """
        try:
            provider_id = await self._resolve_provider_id(umo)
            if not provider_id:
                logger.debug("没有可用的聊天 Provider，跳过 LLM 调用")
                return None
            resp = await self.context.llm_generate(
                chat_provider_id=provider_id,
                prompt=prompt,
                system_prompt=system,
            )
            text = getattr(resp, "completion_text", None)
            if text:
                return str(text).strip()
            # 兼容旧字段
            if hasattr(resp, "result_chain"):
                try:
                    return resp.result_chain.get_plain_text().strip()
                except Exception:  # noqa: BLE001
                    pass
            return None
        except Exception as exc:  # noqa: BLE001
            logger.error("调用 LLM 失败：%s", exc)
            return None

    async def _llm_plan(self, prompt: str, system: str) -> str | None:
        return await self._llm(prompt, system)

    # ================================================================ 人格 / 记忆 / 过日子

    async def _system_prompt_for_mc(self, *, extra: str | None = None) -> str:
        """给 MC 场景用的 system prompt：人格 + 游戏行为准则。"""
        if not self.persona:
            return extra or ""
        return await self.persona.build_system_prompt(extra=extra)

    async def _my_memory(self, query: str = "", limit: int = 5) -> str:
        """取与当前处境相关的记忆，渲染成几行文字（没记忆就返回空串）。"""
        if not self.memory:
            return ""
        try:
            entries = self.memory.recall(query, limit=limit)
            return self.memory.render_for_prompt(entries)
        except Exception as exc:  # noqa: BLE001
            logger.debug("检索记忆失败：%s", exc)
            return ""

    async def _skill_catalog(self) -> list[dict]:
        """给"过日子"决策用的技能清单（技能名 + 描述 + 默认参数）。"""
        if not self.engine or not self.engine.running:
            return []
        try:
            r = await self.engine.call("skill.list", {}, timeout=10.0)
        except Exception:  # noqa: BLE001
            return []
        out = []
        for item in (r or {}).get("skills", []) or []:
            # 形如 "chop_tree(count=8)：找树砍木材…"
            text = str(item)
            name = text.split("(", 1)[0].strip()
            desc = text.split("：", 1)[1].strip() if "：" in text else ""
            params = {}
            if "(" in text and ")" in text:
                inner = text[text.index("(") + 1 : text.index(")")]
                for pair in inner.split(","):
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        k = k.strip()
                        v = v.strip()
                        try:
                            params[k] = int(v)
                        except ValueError:
                            params[k] = v
            out.append({"skill": name, "description": desc, "params": params})
        return out

    async def _share_to_world(self, text: str) -> None:
        """她说了句话：发到游戏内，同时转给订阅的会话。"""
        text = (text or "").strip()
        if not text:
            return
        if self.connected and self.engine and self.engine.running:
            try:
                await self.engine.say(text)
            except Exception as exc:  # noqa: BLE001
                logger.debug("游戏内发言失败：%s", exc)
        await self._notify_subscribers(f"💭 {text}")

    async def _on_life_activity(self, decision) -> None:
        """她决定要做某件事时通知订阅者（让她"有自己的生活"被看见）。"""
        line = f"🎈 她决定：{decision.activity}"
        if decision.skill:
            line += f"（{decision.skill}）"
        await self._notify_subscribers(line)

    async def _maybe_remember(self, kind: str, text: str, **kw) -> None:
        """记一件事——受 `remember_experiences` 开关控制。

        这个开关以前是**写在配置里但没人读**的：用户关掉它，记忆照样在写。
        现在统一走这个入口，开关才真的有效。
        """
        if not self.memory:
            return
        if not self._cfg("remember_experiences", True):
            return
        self.memory.remember(kind, text, **kw)
        self.memory.save()

    async def _on_discovery(self, data: dict) -> None:
        """引擎报告"她发现了什么" → 记进记忆，值得就说出来。

        这是让她"有经历"的关键：客观事件（第一次见熊猫、挖到钻石、走了很远）
        由引擎负责识别，插件只负责记住并决定要不要分享。
        """
        if not self.memory:
            return
        name = data.get("name") or data.get("item") or ""
        kind = "discovery"
        text = ""
        share = False

        if "name" in data and "first_time" in data:
            hostile = data.get("hostile")
            text = f"第一次见到{name}" + ("（有点危险）" if hostile else "")
            kind = "discovery"
            share = bool(hostile) or name in {"panda", "fox", "axolotl", "allay", "sniffer", "camel", "parrot"}
        elif "item" in data:
            count = data.get("count") or 1
            text = f"第一次挖到 {name}×{count}"
            kind = "treasure"
            share = (data.get("weight") or 0) >= 7
        elif data.get("kind") == "travel":
            traveled = data.get("traveled")
            text = f"累计走了 {traveled} 格"
            kind = "milestone"
            share = True

        if not text:
            return

        await self._maybe_remember(
            kind,
            text,
            tags=[name],
            weight=data.get("weight"),
            context={"position": data.get("position"), "dimension": data.get("dimension")},
            dedupe_window=300,
        )
        logger.info("记住了一件事：%s", text)

        # 值得说的就说出来（她自己的语气，受冷却限制）
        if share and self.life:
            asyncio.create_task(self.life.share_event(kind=kind, text=text), name="mc-share")

    async def _on_goal_event(self, event: str, data: dict) -> None:
        """目标推进过程中给订阅者报进度（只报关键节点，避免刷屏）。"""
        if event == "goal.started":
            steps = " → ".join(data.get("steps", [])[:6])
            await self._notify_subscribers(f"🎯 开始目标「{data.get('goal')}」\n计划：{steps}")
        elif event == "goal.step":
            mark = "✅" if data.get("ok") else "❌"
            await self._notify_subscribers(f"{mark} {data.get('step')}：{data.get('summary')}")
        elif event == "goal.done":
            await self._notify_subscribers(f"🏁 目标完成「{data.get('goal')}」")
            # 指派的任务做完了 → 她回去过自己的日子
            if self.life:
                self.life.resume()
        elif event == "goal.failed":
            await self._notify_subscribers(
                f"⚠️ 目标受阻「{data.get('goal')}」\n卡在：{data.get('step')}\n原因：{data.get('reason')}"
            )
            if self.life:
                self.life.resume()

    # ================================================================ 会话推送

    async def _notify_subscribers(self, text: str) -> None:
        if not self._subscribers or not text:
            return
        for umo in list(self._subscribers):
            try:
                chain = MessageChain().message(text)
                await self.context.send_message(umo, chain)
            except Exception as exc:  # noqa: BLE001
                logger.debug("推送到 %s 失败：%s", umo, exc)

    # ================================================================ 状态读取（带缓存）

    async def _get_brief(self, *, max_age: float = 8.0) -> str:
        """带缓存的简报：LLM 工具可能在一次对话里连续调用，避免每次都去问引擎。"""
        now = time.time()
        if self._last_brief and now - self._last_brief_at < max_age:
            return self._last_brief
        if not self.engine or not self.engine.running:
            return "【引擎未运行】"
        try:
            goal = self.goals.progress_brief() if self.goals else None
            text = await self.engine.state_brief(goal)
            self._last_brief = text
            self._last_brief_at = now
            return text
        except EngineError as exc:
            return f"【读取状态失败：{exc}】"

    async def _get_state(self, detail: str = "normal") -> dict:
        if not self.engine or not self.engine.running:
            raise EngineUnavailable("引擎未运行")
        return await self.engine.state(detail)

    # ================================================================ 指令

    @filter.command("mc看她", alias={"看她", "mcview", "看她在干什么"})
    async def cmd_view(self, event: AstrMessageEvent):
        """看她（观战窗口 + 背包 + 她现在在干什么）——只读，不会操作她"""
        lines = ["👀 看她", ""]
        if not self.engine or not self.engine.running:
            lines.append("❌ 引擎没在运行——她根本没启动")
            yield event.plain_result("\n".join(lines))
            return
        if not self.connected:
            lines.append("❌ 她不在服务器里（先 mc进服）")
            yield event.plain_result("\n".join(lines))
            return

        # 1) 观战窗口（浏览器里她的第一视角）
        try:
            v = await self.engine.call("viewer.status", {}, timeout=10.0)
        except Exception as exc:  # noqa: BLE001
            v = {"running": False, "error": str(exc)}
        if v.get("running"):
            lines.append("🖥️ **观战窗口已开**")
            lines.append(f"   浏览器打开：{v.get('url')}")
            lines.append(
                f"   视角：{'第一视角（她的眼睛）' if v.get('first_person') else '俯视'}"
                f"｜渲染 {v.get('view_distance')} 区块｜已开 {v.get('uptime_seconds')} 秒"
            )
            lines.append("   （只能看，不能操作她）")
        else:
            lines.append("🖥️ 观战窗口没开。开启方式二选一：")
            lines.append("   ① 在插件配置里把 **enable_viewer** 打开，然后 `mc退服` + `mc进服`")
            lines.append("   ② 直接发 `mc开观战` 立刻打开（不用重进服）")

        # 2) 她现在的状态 + 背包
        try:
            st = await self.engine.state("normal")
        except Exception as exc:  # noqa: BLE001
            st = None
            lines.append(f"⚠️ 取不到状态：{exc}")
        if st:
            pos = st.get("block_position") or {}
            lines.append("")
            lines.append(
                f"📍 ({pos.get('x')}, {pos.get('y')}, {pos.get('z')}) ｜ "
                f"❤️ {st.get('health')}/{st.get('max_health')} ｜ 🍗 {st.get('food')}"
            )
            held = st.get("held_item")
            lines.append(f"✋ 手上：{held.get('name') if isinstance(held, dict) else (held or '空手')}")
            inv = st.get("inventory") or st.get("inventory_summary")
            if isinstance(inv, dict) and inv:
                items = "、".join(f"{k}×{v}" for k, v in list(inv.items())[:24])
                lines.append(f"🎒 背包（{len(inv)} 种）：{items}")
            elif isinstance(inv, list) and inv:
                items = "、".join(
                    f"{i.get('name')}×{i.get('count')}" for i in inv[:24] if isinstance(i, dict)
                )
                lines.append(f"🎒 背包（{len(inv)} 种）：{items}")
            else:
                lines.append("🎒 背包：空")

        # 3) 她现在在干什么
        if self.life:
            try:
                lines.append("")
                lines.append(self.life.describe())
            except Exception:  # noqa: BLE001
                pass

        # 4) 如果你有 Java 版客户端：更真实的看法
        lines.append("")
        lines.append("💡 想看**真·第一视角**（真游戏画面）：用你自己的 Java 版客户端进这个服，然后")
        lines.append("   `/gamemode spectator` → `/spectate 她的名字`，就能贴在她身上看她玩")
        lines.append("   （注意：需要 Java 版；基岩版连不上 Java 服）")
        yield event.plain_result("\n".join(lines))

    @filter.command("mc开观战", alias={"开观战", "mcviewstart"})
    async def cmd_view_start(self, event: AstrMessageEvent):
        """立刻打开观战窗口（浏览器里她的第一视角）"""
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        if not self.connected:
            yield event.plain_result("她还没进服——先 mc进服，再开观战")
            return
        try:
            v = await self.engine.call("viewer.start", {}, timeout=30.0)
        except Exception as exc:  # noqa: BLE001
            yield event.plain_result(f"开观战失败：{exc}")
            return
        if not v.get("running"):
            yield event.plain_result(f"没开成：{v}")
            return
        yield event.plain_result(
            f"🖥️ 观战窗口已开：**{v.get('url')}**\n"
            f"浏览器打开它就能以她的第一视角看她（只能看，不能操作）\n"
            f"视角：{'第一视角' if v.get('first_person') else '俯视'}｜渲染 {v.get('view_distance')} 区块"
        )

    @filter.command("mc帮助", alias={"mchelp", "mc"})
    async def cmd_help(self, event: AstrMessageEvent):
        """Minecraft 机器人帮助"""
        yield event.plain_result(HELP_TEXT)

    @filter.command("mc诊断", alias={"诊断", "mc她怎么了", "mcdiag"})
    async def cmd_diagnose(self, event: AstrMessageEvent):
        """她为什么不动 / 卡在哪 / 在等什么——排查问题先看这个"""
        lines = ["🔍 诊断（她为什么不动、卡在哪）", ""]

        # 1) 结论放最前面：这是"为什么不动"的直接答案
        if not self.engine or not self.engine.running:
            lines.append("❌ 引擎没在运行——她根本没启动")
        elif not self.connected:
            lines.append("❌ 她不在服务器里（没连接）——检查服务器是否开着、地址端口对不对")
        else:
            try:
                d = await self.engine.call("status.diagnose", {}, timeout=10.0)
            except Exception as exc:  # noqa: BLE001
                d = None
                lines.append(f"⚠️ 取不到引擎诊断（引擎可能正被阻塞）：{exc}")
            if d:
                lines.append(f"结论：{d.get('verdict')}")
                lines.append("")
                pos = d.get("position") or {}
                lines.append(
                    f"位置 ({pos.get('x')}, {pos.get('y')}, {pos.get('z')}) ｜ "
                    f"血量 {d.get('health')} ｜ 饱食 {d.get('food')}"
                )
                cur = d.get("current_task")
                lines.append(f"手上在做：{cur.get('name') if isinstance(cur, dict) else (cur or '（空闲）')}")
                lines.append(f"排着：{d.get('queued')} 个")
                lag = d.get("last_lag")
                if lag:
                    lines.append(
                        f"最近一次引擎阻塞：{lag.get('seconds')} 秒前（{lag.get('what')}）"
                        if isinstance(lag, dict)
                        else ""
                    )
                rx = d.get("reflexes") or {}
                lines.append(
                    "本能活动："
                    f"挖困 {rx.get('last_unstuck_seconds_ago')}s 前"
                    f"（退避 {rx.get('unstuck_give_up_for')}s）｜"
                    f"火把 {rx.get('last_torch_seconds_ago')}s ｜"
                    f"捡东西 {rx.get('last_collect_seconds_ago')}s ｜"
                    f"MLG {rx.get('last_mlg_seconds_ago')}s"
                )
                recent = d.get("recent_tasks") or []
                if recent:
                    lines.append("")
                    lines.append("【最近做完的事】")
                    for h in recent[-6:]:
                        mark = "✅" if h.get("status") == "done" else "❌"
                        lines.append(
                            f"  {mark} {h.get('name')}（{h.get('seconds')}s）"
                            + (f" — {h.get('error')}" if h.get("error") else "")
                        )

        # 2) 过日子循环的状态（她"想不想动"）
        if self.life:
            lines.append("")
            lines.append("【过日子循环】")
            lines.append(self.life.describe())
            todos = self.life.render_todos()
            if todos:
                lines.append(todos)
            fails = self.life.failure_summary() if hasattr(self.life, "failure_summary") else ""
            if fails:
                lines.append(fails)

        # 3) 知识库（她学到了什么）
        kb = getattr(self, "knowledge", None)
        if kb:
            st = kb.stats()
            lines.append("")
            lines.append(
                f"【知识库】攻略 {st.get('docs')} 篇 ｜ 她自己总结的教训 {st.get('lessons')} 条 ｜ 笔记 {st.get('notes')} 条"
            )
            for les in kb.lessons(limit=3):
                lines.append(f"  · {les.get('text')}")

        yield event.plain_result("\n".join([ln for ln in lines if ln is not None]))

    @filter.command("mc她在干嘛", alias={"她在干嘛", "mc她在干什么"})
    async def cmd_whats_she_doing(self, event: AstrMessageEvent):
        """她现在的日程、心思与最近做过的事"""
        lines = []
        if self.life:
            lines.append(self.life.describe())
        if self.drives:
            lines.append("")
            lines.append("【她现在的心思】")
            lines.append(self.drives.describe_all())
        if self.connected:
            try:
                lines.append("")
                lines.append("【当前状态】")
                lines.append(await self._get_brief(max_age=3.0))
            except Exception:  # noqa: BLE001
                pass
        if not lines:
            lines.append("过日子系统没启用（检查配置 enable_life_loop）")
        yield event.plain_result("\n".join(lines))

    @filter.command("mc记忆", alias={"她的记忆"})
    async def cmd_memory(self, event: AstrMessageEvent):
        """她的经历"""
        if not self.memory:
            yield event.plain_result("记忆系统未启用")
            return
        about = _cmd_rest(event)
        entries = self.memory.recall(about, limit=8) if about else self.memory.recent(8)
        stats = self.memory.stats()
        if not entries:
            yield event.plain_result(f"她还没有什么经历（共 {stats['total']} 条记忆）")
            return
        kinds = "、".join(f"{k}×{v}" for k, v in (stats.get("by_kind") or {}).items())
        yield event.plain_result(
            f"她记得这些（共 {stats['total']} 条：{kinds}）：\n{self.memory.render_for_prompt(entries)}"
        )

    @filter.command("mc人格", alias={"她的人格"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cmd_persona(self, event: AstrMessageEvent):
        """查看/切换她在 MC 里的人格"""
        if not self.persona:
            yield event.plain_result("人格系统未启用")
            return
        arg = _cmd_rest(event)

        if not arg:
            cur = await self.persona.resolve(event.unified_msg_origin)
            text = await self.persona.current_display()
            preview = (cur.get("prompt") or "").strip()
            lines = [text]
            if preview:
                lines.append("")
                lines.append(f"设定节选：{preview[:200]}")
            lines.append("")
            lines.append("用法：/mc人格 列表 ｜ /mc人格 <名字> ｜ /mc人格 默认")
            yield event.plain_result("\n".join(lines))
            return

        if arg in ("列表", "list", "ls"):
            personas = await self.persona.list_personas()
            if not personas:
                yield event.plain_result("AstrBot 里还没有配置人格")
                return
            lines = ["可用人格："]
            for p in personas:
                lines.append(f"· {p['name']}")
            lines.append("")
            lines.append("用 /mc人格 <名字> 切换")
            yield event.plain_result("\n".join(lines))
            return

        result = await self.persona.set_persona(arg)
        # 换人格后立即按新人格调整动机倾向
        if self.drives:
            cur = await self.persona.resolve(event.unified_msg_origin)
            self.drives.apply_personality(cur.get("prompt") or "")
        yield event.plain_result(result)

    @filter.command("mc心情", alias={"她的心情"})
    async def cmd_mood(self, event: AstrMessageEvent):
        """她当前最想做什么"""
        if not self.drives:
            yield event.plain_result("驱动力系统未启用")
            return
        s = self.drives.suggest_activity()
        yield event.plain_result(
            f"{s['label']}（强度 {s['level']}）：{s['voice']}\n可能去做：{s['activity']}\n\n"
            f"{self.drives.describe_all()}"
        )

    @filter.command("mc状态", alias={"mcstatus"})
    async def cmd_status(self, event: AstrMessageEvent):
        """引擎与游戏连接状态"""
        if not await self._ensure_engine():
            yield event.plain_result("❌ 引擎未运行，且尝试启动失败。请检查插件配置中的 engine_dir 与 node_path。")
            return
        try:
            status = await self.engine.status()
        except Exception as exc:  # noqa: BLE001
            yield event.plain_result(f"❌ 读取引擎状态失败：{exc}")
            return

        lines = ["【Minecraft 机器人状态】"]
        lines.append(f"引擎：运行中（v{self.engine.engine_info.get('version', '?')}）")
        cfg = status.get("config") or {}
        target = f"{cfg.get('host')}:{cfg.get('port')}"
        if status.get("connected"):
            pos = status.get("position") or {}
            lines.append(f"游戏：已连接 {target}（{cfg.get('version')}）")
            lines.append(f"账号：{cfg.get('username')} | 生命 {status.get('health')} | 饱食 {status.get('food')}")
            lines.append(f"位置：({pos.get('x')}, {pos.get('y')}, {pos.get('z')})")
        else:
            lines.append(f"游戏：未连接（目标 {target}）")
        cur = status.get("current_task")
        if cur:
            lines.append(f"当前动作：{cur.get('name')} {cur.get('detail') or ''}（{int((cur.get('elapsed_ms') or 0) / 1000)} 秒）")
        if status.get("queued"):
            lines.append(f"排队中：{status.get('queued')} 个")
        stats = status.get("stats") or {}
        lines.append(
            f"统计：完成 {stats.get('completed', 0)} / 失败 {stats.get('failed', 0)} / 取消 {stats.get('cancelled', 0)}"
        )
        if self.goals and self.goals.active:
            lines.append("")
            lines.append(self.goals.describe())
        if self.life and self.life.current:
            lines.append("")
            lines.append(f"她自己在做：{self.life.current.activity}")
        yield event.plain_result("\n".join(lines))

    @filter.command("mc进服", alias={"mcconnect"})
    async def cmd_connect(self, event: AstrMessageEvent):
        """让机器人进服"""
        if not await self._ensure_engine():
            yield event.plain_result("❌ 引擎未启动，请先检查配置")
            return
        if self.connected:
            yield event.plain_result("机器人已经在服里了")
            return
        yield event.plain_result("正在让机器人进服，请稍候…")
        await self._auto_connect(reason="手动进服")

    @filter.command("mc退服", alias={"mcdisconnect"})
    async def cmd_disconnect(self, event: AstrMessageEvent):
        """断开游戏连接"""
        result = await self._do_disconnect()
        yield event.plain_result(result)

    @filter.command("mc急停", alias={"mcstop"})
    async def cmd_stop(self, event: AstrMessageEvent):
        """立刻停止所有动作"""
        if not self.engine or not self.engine.running:
            yield event.plain_result("引擎未运行")
            return
        try:
            r = await self.engine.safety_stop()
            if self.goals:
                await self.goals.pause()
            cancelled = r.get("cancelled") or []
            yield event.plain_result(f"🛑 已急停，取消了 {len(cancelled)} 个任务。自主目标也已暂停（/mc继续 可恢复）")
        except Exception as exc:  # noqa: BLE001
            yield event.plain_result(f"急停失败：{exc}")

    @filter.command("mc目标", alias={"mcgoal"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cmd_goal(self, event: AstrMessageEvent):
        """设定或查看长期目标"""
        arg = _cmd_rest(event)
        if not self.goals:
            yield event.plain_result("目标系统未初始化")
            return
        if not arg:
            yield event.plain_result(self.goals.describe())
            return
        if not self.connected:
            yield event.plain_result("机器人还没进服，先用 /mc进服")
            return
        # 你派活了 → 先让她停下自己正在做的事，避免"你让她挖矿、她还在那边发呆"
        if self.life:
            self.life.pause()
            try:
                await self._engine_call("task.cancel", {})
            except Exception:  # noqa: BLE001
                pass
        try:
            msg = await self.goals.start(arg)
            yield event.plain_result(f"🎯 {msg}")
        except Exception as exc:  # noqa: BLE001
            yield event.plain_result(f"❌ {exc}")

    @filter.command("mc进度", alias={"mcprogress"})
    async def cmd_progress(self, event: AstrMessageEvent):
        """查看目标进度"""
        if not self.goals:
            yield event.plain_result("目标系统未初始化")
            return
        text = self.goals.describe()
        if self.engine and self.engine.running:
            try:
                status = await self.engine.task_status()
                cur = status.get("current")
                if cur:
                    text += f"\n\n当前动作：{cur.get('name')}（{cur.get('detail') or ''}）"
            except Exception:  # noqa: BLE001
                pass
        yield event.plain_result(text)

    @filter.command("mc暂停", alias={"mcpause"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cmd_pause(self, event: AstrMessageEvent):
        """暂停当前目标"""
        yield event.plain_result(await self.goals.pause() if self.goals else "目标系统未初始化")

    @filter.command("mc继续", alias={"mcresume"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cmd_resume(self, event: AstrMessageEvent):
        """继续当前目标"""
        yield event.plain_result(await self.goals.resume() if self.goals else "目标系统未初始化")

    @filter.command("mc放弃", alias={"mcabandon"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cmd_abandon(self, event: AstrMessageEvent):
        """放弃当前目标"""
        msg = await self.goals.abandon() if self.goals else "目标系统未初始化"
        # 任务结束了 → 让她继续过自己的日子
        if self.life:
            self.life.resume()
        yield event.plain_result(msg)

    @filter.command("mc订阅", alias={"mcsubscribe"})
    async def cmd_subscribe(self, event: AstrMessageEvent):
        """把游戏内聊天转发到本会话"""
        self._subscribers.add(event.unified_msg_origin)
        yield event.plain_result("✅ 已订阅：游戏内的聊天和机器人动态会转发到这里（/mc退订 取消）")

    @filter.command("mc退订", alias={"mcunsubscribe"})
    async def cmd_unsubscribe(self, event: AstrMessageEvent):
        """取消转发"""
        self._subscribers.discard(event.unified_msg_origin)
        yield event.plain_result("已退订")

    @filter.command("mc说", alias={"mcsay"})
    async def cmd_say(self, event: AstrMessageEvent):
        """让机器人在游戏内发言"""
        text = _cmd_rest(event)
        if not text:
            yield event.plain_result("用法：/mc说 <内容>")
            return
        if not self.connected:
            yield event.plain_result("机器人还没进服")
            return
        try:
            await self.engine.say(text)
            yield event.plain_result(f"已让机器人说：{text}")
        except EngineError as exc:
            yield event.plain_result(f"发送失败：{exc}")

    @filter.command("mc玩家", alias={"mcplayers"})
    async def cmd_players(self, event: AstrMessageEvent):
        """在线玩家"""
        if not self.connected:
            yield event.plain_result("机器人还没进服")
            return
        try:
            r = await self.engine.call("players.list", {})
        except EngineError as exc:
            yield event.plain_result(f"读取失败：{exc}")
            return
        rows = []
        for p in r.get("players", []):
            mark = "（我）" if p.get("self") else ""
            dist = f" 距 {p['distance']} 格" if p.get("distance") is not None else ""
            rows.append(f"{p.get('username')}{mark}{dist}")
        yield event.plain_result("在线玩家：\n" + ("\n".join(rows) if rows else "（只有我自己）"))

    @filter.command("mc技能", alias={"mcskills"})
    async def cmd_skills(self, event: AstrMessageEvent):
        """列出机器人会做的技能"""
        if not await self._ensure_engine():
            yield event.plain_result("引擎未运行")
            return
        try:
            r = await self.engine.call("skill.list", {})
        except EngineError as exc:
            yield event.plain_result(f"读取失败：{exc}")
            return
        lines = ["机器人会做的事："]
        for item in r.get("skills", []):
            lines.append(f"· {item}")
        yield event.plain_result("\n".join(lines))

    @filter.command("mc调试", alias={"mcdebug"})
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cmd_debug(self, event: AstrMessageEvent):
        """排障：最近事件与任务"""
        lines = ["【调试信息】"]
        lines.append(f"引擎运行中：{bool(self.engine and self.engine.running)}")
        lines.append(f"游戏已连接：{self.connected}")
        try:
            if self.engine and self.engine.running:
                brief = await self.engine.state_brief()
                lines.append("简报：\n" + brief)
                status = await self.engine.status()
                lines.append(f"队列：{json.dumps(status.get('queue'), ensure_ascii=False)}")
                hist = status.get("history") or []
                if hist:
                    lines.append("最近任务：")
                    for h in hist[-5:]:
                        lines.append(f"  {h.get('name')} → {h.get('status')} {h.get('error') or ''}")
        except Exception as exc:  # noqa: BLE001
            lines.append(f"读取引擎状态失败：{exc}")
        events = self._event_buffer[-8:]
        if events:
            lines.append("最近事件：")
            for e in events:
                lines.append(f"  [{time.strftime('%H:%M:%S', time.localtime(e['at']))}] {e['event']}")
        yield event.plain_result("\n".join(lines))
