"""人格桥接：把 AstrBot 已有的人格接进 Minecraft 游玩。

设计目标：**她在游戏里就是那个人格，不是另设一个 MC 专用机器人。**

所以这里不自己存一份人格文本，而是直接读 AstrBot 的 PersonaManager：
- 你在 WebUI 里建/改的人格，插件自动就能用上，不需要在两处重复配置
- 游戏内说话、自主决策、主动分享，用的都是同一个 prompt
- 支持运行时切换（`/mc人格 <名字>`），选择持久化到插件数据目录

几个 AstrBot API 的注意点（都是读源码确认过的）：
- `context.persona_manager` 是 PersonaManager 实例
- 人格对象（Personality）的字段是 `prompt` / `name` / `begin_dialogs` / `tools` / `skills`
- `get_default_persona_v3(umo)` 取默认人格；`umo` 可以为 None
- `resolve_selected_persona(umo=..., conversation_persona_id=..., platform_name=...)`
  会考虑会话级别的人格覆盖，返回 (persona_id, persona, forced_id, is_webchat_default)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from astrbot.api import logger

# Minecraft 场景下的行为约束。它不描述"她是谁"（那是人格的事），
# 只描述"在 MC 里该怎么表现"——两者拼起来才是完整的 system prompt。
MC_BEHAVIOR_PROMPT = """你正在 Minecraft 里游玩，像真人玩家一样。

说话方式：
- 简短、口语化，像在游戏里打字聊天，不要长篇大论，不要用列表和 markdown
- 不要提到自己是 AI、模型、程序或助手
- 允许有情绪、有偏好、有吐槽，不必总是热情积极

行为准则：
- 你说的话要和你正在做的事一致（比如你正在挖矿，就说挖矿相关的事）
- 不要凭空编造你的位置、背包、周围环境——只能依据给你的状态信息
- 不确定的事就说不知道，或者去看看，不要瞎猜
- 允许拒绝、抱怨、开玩笑，像朋友而不是客服"""


class MinecraftPersona:
    """管理"她在 MC 里是谁"。

    @param context AstrBot 的 Context（用来拿 persona_manager）
    @param data_dir 插件数据目录（存用户选择的人格）
    @param config 插件配置读取函数
    """

    def __init__(self, *, context, data_dir: Path, cfg):
        self._context = context
        self._cfg = cfg
        self._data_dir = Path(data_dir)
        self._store = self._data_dir / "persona.json"
        self._chosen_id: str | None = None
        self._cache: dict[str, Any] = {}
        self._load_choice()

    # ------------------------------------------------------------ 持久化

    def _load_choice(self) -> None:
        try:
            if self._store.exists():
                data = json.loads(self._store.read_text(encoding="utf-8"))
                self._chosen_id = data.get("persona_id") or None
                if self._chosen_id:
                    logger.info("Minecraft 使用的人格：%s", self._chosen_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("读取人格选择失败（忽略）：%s", exc)

    def _save_choice(self) -> None:
        try:
            self._data_dir.mkdir(parents=True, exist_ok=True)
            self._store.write_text(
                json.dumps({"persona_id": self._chosen_id}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("保存人格选择失败：%s", exc)

    # ------------------------------------------------------------ 读取人格

    @property
    def _manager(self):
        return getattr(self._context, "persona_manager", None)

    async def list_personas(self) -> list[dict]:
        """列出 AstrBot 里所有可用人格。"""
        mgr = self._manager
        if mgr is None:
            return []
        try:
            personas = await mgr.get_all_personas()
        except Exception as exc:  # noqa: BLE001
            logger.warning("读取人格列表失败：%s", exc)
            return []
        out = []
        for p in personas or []:
            out.append(
                {
                    "id": getattr(p, "persona_id", None) or getattr(p, "id", None),
                    "name": getattr(p, "name", None) or "（未命名）",
                    "prompt_preview": (getattr(p, "system_prompt", "") or "")[:60],
                }
            )
        return out

    async def resolve(self, umo: str | None = None) -> dict:
        """解析当前该用哪个人格。

        优先级：插件里手动指定的 > AstrBot 会话/默认人格 > 内置兜底。

        @return {"id","name","prompt","source"}
        """
        # 1) 插件里显式指定过（/mc人格 <名字>）
        if self._chosen_id:
            found = await self._fetch_by_id(self._chosen_id)
            if found:
                return found
            logger.warning("指定的人格 %s 不存在了，回退到 AstrBot 默认人格", self._chosen_id)

        # 2) 配置里指定了固定人格
        cfg_id = str(self._cfg("mc_persona_id", "") or "").strip()
        if cfg_id:
            found = await self._fetch_by_id(cfg_id)
            if found:
                return found

        # 3) AstrBot 的默认人格
        mgr = self._manager
        if mgr is not None:
            try:
                p = await mgr.get_default_persona_v3(umo)
                if p:
                    prompt = p.get("prompt") if isinstance(p, dict) else getattr(p, "system_prompt", "")
                    name = p.get("name") if isinstance(p, dict) else getattr(p, "name", "")
                    if prompt:
                        return {
                            "id": "__astrbot_default__",
                            "name": name or "AstrBot 默认人格",
                            "prompt": prompt,
                            "source": "astrbot_default",
                        }
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取 AstrBot 默认人格失败：%s", exc)

        # 4) 兜底：配置里的自定义描述
        custom = str(self._cfg("persona", "") or "").strip()
        if custom:
            return {"id": "__custom__", "name": "自定义描述", "prompt": custom, "source": "config"}

        return {"id": None, "name": "（未设置）", "prompt": "", "source": "none"}

    async def _fetch_by_id(self, persona_id: str) -> dict | None:
        mgr = self._manager
        if mgr is None:
            return None
        try:
            p = await mgr.get_persona(persona_id)
        except Exception:  # noqa: BLE001
            # get_persona 对不存在的 id 会抛 ValueError，这里当作"没找到"
            p = None
        if p is None:
            return None
        prompt = getattr(p, "system_prompt", "") or ""
        name = getattr(p, "name", "") or persona_id
        if not prompt:
            return None
        return {"id": persona_id, "name": name, "prompt": prompt, "source": "astrbot"}

    # ------------------------------------------------------------ 切换

    async def set_persona(self, name_or_id: str) -> str:
        """按名字或 ID 切换人格。返回可读的结果说明。"""
        target = str(name_or_id or "").strip()
        if not target:
            return "要切换成哪个人格？用法：/mc人格 <名字>"

        if target in ("默认", "default", "重置", "reset"):
            self._chosen_id = None
            self._save_choice()
            cur = await self.resolve()
            return f"已恢复使用 AstrBot 的默认人格（当前：{cur['name']}）"

        personas = await self.list_personas()
        if not personas:
            return "读不到 AstrBot 的人格列表（可能还没配置任何人格）"

        # 先精确匹配 id，再匹配名字（名字可能重复，取第一个）
        picked = next((p for p in personas if p["id"] == target), None)
        if not picked:
            picked = next((p for p in personas if p["name"] == target), None)
        if not picked:
            # 退一步做模糊匹配，方便手打
            picked = next((p for p in personas if target in (p["name"] or "")), None)
        if not picked:
            names = "、".join(p["name"] for p in personas[:15])
            return f"没有找到叫「{target}」的人格。可用的有：{names}"

        self._chosen_id = picked["id"]
        self._save_choice()
        return f"好，从现在起我在 MC 里就是「{picked['name']}」了"

    async def current_display(self) -> str:
        cur = await self.resolve()
        source_cn = {
            "astrbot": "来自 AstrBot 人格库",
            "astrbot_default": "AstrBot 默认人格",
            "config": "来自插件配置的自定义描述",
            "none": "未设置（用通用语气）",
        }.get(cur.get("source"), cur.get("source") or "")
        return f"当前人格：{cur['name']}（{source_cn}）"

    # ------------------------------------------------------------ 组装 system prompt

    async def build_system_prompt(self, *, extra: str | None = None, umo: str | None = None) -> str:
        """拼出给 LLM 的 system prompt：人格 + MC 行为准则 + 可选附加约束。"""
        cur = await self.resolve(umo)
        parts = []
        if cur.get("prompt"):
            parts.append(str(cur["prompt"]).strip())
        parts.append(MC_BEHAVIOR_PROMPT)
        if extra:
            parts.append(str(extra).strip())
        return "\n\n".join(parts)

    async def persona_name(self, umo: str | None = None) -> str:
        cur = await self.resolve(umo)
        return cur.get("name") or "机器人"
