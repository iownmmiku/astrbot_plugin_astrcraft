"""真实模型自然世界生存评测；只连接显式指定的专用测试服。

生产 LifeLoop / ActionAgent / EngineClient，AstrBot 官方 provider 实际请求。
不改地形、时间、难度，不赠送物资。凭据仅从环境读取，不输出原始日志。
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import logging
import math
import os
import re
import sys
import tempfile
import time
import uuid
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths


def distribution(values):
    values = sorted(values)
    if not values:
        return {"samples": 0, "mean": None, "p95": None, "max": None}
    return {"samples": len(values), "mean": round(sum(values) / len(values), 3),
            "p95": round(values[max(0, math.ceil(len(values) * .95) - 1)], 3),
            "max": round(values[-1], 3)}


class SurvivalMetrics:
    """只保留数值摘要，不保存模型文本、聊天正文或错误正文。"""

    def __init__(self, *, poll_seconds=5, stationary_seconds=120):
        self.poll_seconds = poll_seconds
        self.stationary_seconds = stationary_seconds
        self.deaths = self.hurt_events = self.hungry_events = self.external_chat_events = 0
        self.manual_interventions = Counter()
        self.tasks = Counter()
        self.failures = Counter()
        self.repeated_failures = 0
        self._failure_streak = 0
        self._last_failed_skill = None
        self._terminal_ids = set()
        self._started_ids = set()
        self._last_finished = None
        self.task_gaps = []
        self.task_durations = []
        self.samples = self.read_errors = 0
        self.connected_seconds = self.hungry_seconds = self.starving_seconds = 0.0
        self.model_wait_seconds = 0.0
        self.minimum_food = self.minimum_health = None
        self.stationary_work_episodes = 0
        self._stationary_since = None
        self._stationary_reported = False
        self._previous = None
        self._first_daytime = None
        self.daylight_changed = False

    def task_submitted(self, task_id, at):
        if not task_id or task_id in self._started_ids:
            return
        self._started_ids.add(task_id)
        self.tasks["submitted"] += 1
        if self._last_finished is not None and at >= self._last_finished:
            self.task_gaps.append(at - self._last_finished)
            self._last_finished = None

    def task_finished(self, payload, at):
        if payload.get("kind") == "reflex":
            return
        task_id = payload.get("task_id") or payload.get("id")
        if not task_id or task_id in self._terminal_ids:
            return
        self._terminal_ids.add(task_id)
        status = payload.get("status")
        result = payload.get("result")
        if status == "done" and isinstance(result, dict) and result.get("ok") is False:
            status = "failed"
        if status not in ("done", "failed", "cancelled"):
            return
        self.tasks[status] += 1
        if payload.get("kind") == "skill":
            self._last_finished = at
        duration = payload.get("duration_ms")
        if isinstance(duration, (int, float)) and math.isfinite(duration) and duration >= 0:
            self.task_durations.append(duration / 1000)
        if status == "failed":
            # 固定技能 ID；不写用户指定的任务名或错误正文。
            skill = (payload.get("meta") or {}).get("skill") or "other"
            if not isinstance(skill, str) or not re.fullmatch(r"[a-z_]{1,40}", skill):
                skill = "other"
            self.failures[skill] += 1
            self._failure_streak = self._failure_streak + 1 if skill == self._last_failed_skill else 1
            self._last_failed_skill = skill
            if self._failure_streak >= 3:
                self.repeated_failures += 1
        else:
            self._failure_streak = 0
            self._last_failed_skill = None

    def sample(self, at, body, inventory, *, working=False, model_waiting=False):
        self.samples += 1
        connected = body.get("connected") is True and body.get("ready") is not False
        food, health, position = body.get("food"), body.get("health"), body.get("position")
        for value, field in ((food, "minimum_food"), (health, "minimum_health")):
            if connected and isinstance(value, (int, float)) and math.isfinite(value):
                old = getattr(self, field)
                setattr(self, field, min(old, value) if old is not None else value)
        daytime = body.get("time_of_day")
        if connected and isinstance(daytime, (int, float)):
            if self._first_daytime is None:
                self._first_daytime = daytime
            elif daytime != self._first_daytime:
                self.daylight_changed = True
        previous = self._previous
        dt = max(0, at - previous["at"]) if previous else 0
        # 断线和漏读不推断饥饿；取样间隔过长不按已观察覆盖时间计算。
        covered = previous and connected and previous["connected"] and dt <= self.poll_seconds * 2.5
        if covered:
            self.connected_seconds += dt
            if isinstance(previous["food"], (int, float)):
                self.hungry_seconds += dt if previous["food"] <= 6 else 0
                self.starving_seconds += dt if previous["food"] <= 0 else 0
            self.model_wait_seconds += dt if previous["model_waiting"] else 0
        stationary = False
        if covered and working and previous["working"] and isinstance(position, dict):
            old_pos = previous["position"]
            if isinstance(old_pos, dict):
                try:
                    distance = sum((float(position[k]) - float(old_pos[k])) ** 2 for k in ("x", "y", "z"))
                    stationary = distance < .25 and inventory == previous["inventory"]
                except (KeyError, ValueError, TypeError):
                    pass  # 不完整位置不作为卡住候选。
        if stationary:
            if self._stationary_since is None:
                self._stationary_since = previous["at"]
            if at - self._stationary_since >= self.stationary_seconds and not self._stationary_reported:
                self.stationary_work_episodes += 1
                self._stationary_reported = True
        else:
            self._stationary_since, self._stationary_reported = None, False
        self._previous = {"at": at, "connected": connected, "food": food,
                          "position": copy.deepcopy(position), "inventory": dict(inventory),
                          "working": working, "model_waiting": model_waiting}

    def summary(self):
        return {
            "deaths": self.deaths, "hurt_events": self.hurt_events, "hungry_events": self.hungry_events,
            "minimum_food": self.minimum_food, "minimum_health": self.minimum_health,
            "sample_count": self.samples, "read_errors": self.read_errors,
            "observed_connected_seconds": round(self.connected_seconds, 3),
            "hungry_seconds_food_le_6": round(self.hungry_seconds, 3),
            "starving_seconds_food_zero": round(self.starving_seconds, 3),
            "sampled_model_wait_seconds": round(self.model_wait_seconds, 3),
            "stationary_work_candidates": self.stationary_work_episodes,
            "stationary_threshold_seconds": self.stationary_seconds,
            "tasks": dict(self.tasks), "failures_by_skill": dict(self.failures),
            "repeated_failures_after_third": self.repeated_failures,
            "skill_handoff_seconds": distribution(self.task_gaps),
            "task_duration_seconds": distribution(self.task_durations),
            "external_chat_events": self.external_chat_events,
            "manual_interventions": dict(self.manual_interventions),
            "daylight_changed": self.daylight_changed,
        }


def model_environment():
    names = ("ASTRCRAFT_EVAL_ENDPOINT", "ASTRCRAFT_EVAL_MODEL", "ASTRCRAFT_EVAL_API_KEY")
    values = [os.environ.get(name, "").strip() for name in names]
    missing = [name for name, value in zip(names, values) if not value]
    return values, missing


class EvaluationLifecycle:
    """沿用生产身体事件；初次空背包核验前禁止启动自主或聊天动作。"""

    def __init__(self, host):
        self.host = host
        self.ready = self.closed = False
        self.pending_spawn = None
        self.body_revision = 0
        host.config["enable_life_loop"] = False
        host._emergency_stopped = True
        host.life.pause(reason="等待初始自然生存验证", max_seconds=0)
        host.engine.on_disconnected = host._on_engine_disconnected
        host.engine.on("bot.spawn", self.spawn)
        for event, handler in (
            ("bot.respawn", host._on_bot_respawn), ("bot.death", host._on_bot_death),
            ("bot.hurt", host._on_bot_hurt), ("bot.hungry", host._on_bot_hungry),
            ("tool.broken", host._on_tool_broken), ("bot.disconnect", host._on_bot_disconnect),
            ("bot.kicked", host._on_bot_kicked), ("bot.reconnecting", host._on_bot_reconnecting),
            ("bot.world_changed", host._on_bot_world_changed),
            ("bot.world_ready", host._on_bot_world_ready), ("chat", host._on_game_chat),
        ):
            host.engine.on(event, self.guarded(handler, body_event=event in (
                "bot.respawn", "bot.death", "bot.disconnect", "bot.kicked",
                "bot.world_changed", "bot.world_ready")))

    def guarded(self, handler, *, body_event=False):
        async def callback(data):
            if body_event:
                self.body_revision += 1
            if self.ready and not self.closed:
                await handler(data)
        return callback

    async def spawn(self, data):
        if self.closed:
            return
        self.body_revision += 1
        if not self.ready:
            self.pending_spawn = dict(data)
            return
        await self.host._on_bot_spawn(data)

    @staticmethod
    def verify_initial(initial, inventory):
        health = initial.get("health")
        if (initial.get("connected") is not True or initial.get("ready") is False
                or initial.get("gamemode") not in ("survival", 0)
                or not isinstance(health, (int, float)) or not math.isfinite(health) or health <= 0
                or inventory.get("items")):
            raise RuntimeError("fresh_survival_player_required")

    async def start_verified(self, initial, inventory):
        self.verify_initial(initial, inventory)
        if self.closed or self.pending_spawn is None:
            raise RuntimeError("initial_spawn_unavailable")
        spawn = self.pending_spawn
        revision = self.body_revision
        # 关闭循环且保持急停，先执行生产会话初始化和配置下发。
        await self.host._on_bot_spawn(spawn)
        # 配置 RPC 等待期间可能死亡或重连，释放急停前重新核验真实身体。
        current, inv = await asyncio.gather(
            self.host.engine.call("state.get", {"detail": "normal"}, timeout=8),
            self.host.engine.call("inventory.get", {}, timeout=8))
        self.verify_initial(current, inv)
        if self.closed or revision != self.body_revision:
            raise RuntimeError("body_changed_during_initial_verification")
        await self.host.engine.call("safety.resume", {})
        self.host._emergency_stopped = False
        self.host.config["enable_life_loop"] = True
        self.ready = True
        self.host.life.resume()
        self.host.life.start()
        self.host.life.wake(reason="自然世界真实模型生存评测开始")

    def close(self):
        self.closed = True
        self.host.engine.on_disconnected = None
        self.host.engine.off_all()


def build_host(context, scratch, args):
    """组装生产组件；不启动引擎、不连接服务器，便于离线验证接线。"""
    Plugin = _paths.plugin_module("main").MinecraftPlugin
    bridge = _paths.plugin_module("bridge_client")
    host = Plugin(context, {"server_host": args.test_host, "server_port": args.test_port,
                          "bot_username": "Eval" + uuid.uuid4().hex[:10],
                          "announce_task_done": False, "auto_connect": False})
    host._data_dir = Path(scratch)
    host.memory = _paths.plugin_module("memory").MemoryStore(Path(scratch))
    host.drives = _paths.plugin_module("drives").DriveSystem(Path(scratch))
    host.knowledge = _paths.plugin_module("knowledge").KnowledgeBase(Path(scratch))
    host.engine = bridge.EngineClient(bridge.EngineConfig(
        engine_dir=_paths.ENGINE_DIR, log_level="error", extra_env={"MC_DATA_DIR": str(scratch)}))
    host._bind_llm_tools()
    host.life = _paths.plugin_module("life").LifeLoop(
        engine_call=host._engine_call, memory=host.memory, drives=host.drives,
        brief_provider=host._get_brief, llm=host._llm,
        system_prompt_provider=host._system_prompt_for_mc, skill_catalog_provider=host._skill_catalog,
        on_share=host._share_to_world, on_activity=host._on_life_activity,
        state_provider=host._life_state_snapshot, is_connected=lambda: host.connected, decide_interval=20)
    host.life.bind_data_dir(Path(scratch))
    host.life.action_agent = _paths.plugin_module("action_agent").ActionAgent(host)
    host.life.perception = _paths.plugin_module("perception_agent").PerceptionAgent(host)
    host.life.knowledge = host.knowledge
    host.game_agent = _paths.plugin_module("game_agent").GameChatAgent(host)
    return host


async def run(args, model_values):
    # Provider 异常可能带请求正文/认证信息，整个独立评测进程禁止原始日志。
    logging.disable(logging.CRITICAL)
    _paths.require_astrbot("survival_eval")
    from astrbot.core.provider.sources.openai_source import ProviderOpenAIOfficial
    from astrbot.core.provider.func_tool_manager import FunctionToolManager
    from astrbot.core.star.register.star_handler import llm_tools
    from lib.rcon import Rcon

    Plugin = _paths.plugin_module("main").MinecraftPlugin
    tokens = _paths.plugin_module("tokens")
    tokens.reset()
    metrics = SurvivalMetrics(poll_seconds=args.poll_seconds, stationary_seconds=args.stationary_seconds)
    endpoint, model, api_key = model_values
    provider = None
    host = None
    started = time.monotonic()
    report = {"schema_version": 1, "status": "starting", "stage": "rules_verification", "requested_minutes": args.minutes,
              "real_model": True, "fixed_answers": False, "supplies_granted": False,
              "rules_modified": False, "manual_log_provided": bool(args.interventions),
              "interpretation": "stationary_work_candidates 为疑似停滞，不能单独认定卡住；Token 只统计已报告部分"}
    rcon = Rcon(args.test_host, args.rcon_port, os.environ["ASTRCRAFT_EVAL_RCON_PASSWORD"])
    try:
        # 全部只读；不尝试修正测试服规则，以免改变别人的世界。
        rules = {}
        for rule in ("doDaylightCycle", "naturalRegeneration", "doMobSpawning", "keepInventory"):
            reply = await asyncio.to_thread(rcon.command, "gamerule " + rule)
            match = re.search(r"\b(true|false)\s*$", reply)
            if not match:
                raise RuntimeError("rules_unverified")
            rules[rule] = match[1] == "true"
        reply = await asyncio.to_thread(rcon.command, "difficulty")
        match = re.search(r"\b(easy|normal|hard)\b", reply, re.I)
        if not match or not all(rules[k] for k in ("doDaylightCycle", "naturalRegeneration", "doMobSpawning")) or rules["keepInventory"]:
            raise RuntimeError("natural_survival_rules_required")
        report["rules"] = {**rules, "difficulty": match[1].lower()}
        report["stage"] = "provider_initialization"
        provider = ProviderOpenAIOfficial({
            "id": "astrcraft-eval", "type": "openai_chat_completion", "key": [api_key],
            "api_base": endpoint, "model": model, "timeout": args.model_timeout,
        }, {})
        inflight = 0
        real_chat = provider.text_chat

        async def safe_chat(**kwargs):
            nonlocal inflight
            inflight += 1
            try:
                return await real_chat(**kwargs)
            except Exception:
                raise RuntimeError("评测模型请求失败（原始详情已隐藏）") from None
            finally:
                inflight -= 1

        provider.text_chat = safe_chat

        async def get_provider(**kwargs):
            return provider

        async def llm_generate(**kwargs):
            kwargs.pop("chat_provider_id", None)
            return await provider.text_chat(**kwargs)

        manager = FunctionToolManager()
        # 复制 AstrBot 装饰器生成的真实 schema，绑定在独立插件实例上。
        manager.func_list = [copy.copy(tool) for tool in llm_tools.func_list
                             if (getattr(tool, "name", "").startswith("mc_")
                                 and getattr(getattr(tool, "handler", None), "__module__", "").startswith(_paths.PLUGIN_PACKAGE))]
        if not manager.func_list:
            raise RuntimeError("plugin_tools_unavailable")
        context = SimpleNamespace(get_using_provider_async=get_provider, llm_generate=llm_generate,
                                  provider_manager=SimpleNamespace(llm_tools=manager))
        report["stage"] = "runtime_initialization"
        with tempfile.TemporaryDirectory(prefix="astrcraft-real-survival-") as scratch:
            host = build_host(context, scratch, args)
            engine = host.engine
            lifecycle = EvaluationLifecycle(host)
            real_call = engine.call

            async def observed_call(method, params=None, **kwargs):
                at = time.monotonic()
                result = await real_call(method, params, **kwargs)
                if method == "skill.run" and isinstance(result, dict):
                    metrics.task_submitted(result.get("task_id"), at)
                return result

            engine.call = observed_call

            def finished(payload):
                metrics.task_finished(payload, time.monotonic())

            def counted(name):
                def callback(payload):
                    setattr(metrics, name, getattr(metrics, name) + 1)
                return callback

            engine.on("task.finished", finished)
            engine.on("task.finished", host._on_task_finished)
            for event, name in (("bot.death", "deaths"), ("bot.hurt", "hurt_events"), ("bot.hungry", "hungry_events")):
                engine.on(event, counted(name))
            engine.on("chat", lambda payload: setattr(metrics, "external_chat_events", metrics.external_chat_events +
                      int(bool(payload.get("sender") and payload.get("sender") != host._cfg("bot_username")))))
            try:
                report["stage"] = "connect"
                await engine.start()
                await engine.safety_stop()
                await engine.call("connect", {"host": args.test_host, "port": args.test_port,
                    "username": host._cfg("bot_username"), "version": args.mc_version,
                    "auth": "offline", "autoMode": True}, timeout=60)
                host.connected = True
                report["stage"] = "initial_body"
                initial = await engine.call("state.get", {"detail": "normal"})
                inventory = await engine.call("inventory.get")
                # 完全自主的生存任务由真实模型形成，没有预先安排的动作清单。
                await lifecycle.start_verified(initial, inventory)
                started = time.monotonic()
                deadline = started + args.minutes * 60
                intervention_lines = 0
                next_progress = started
                report["status"] = "running"
                report["stage"] = "survival"
                while time.monotonic() < deadline:
                    try:
                        body, inv, status = await asyncio.gather(
                            engine.call("state.get", {"detail": "normal"}, timeout=8),
                            engine.call("inventory.get", {}, timeout=8), engine.call("status", {}, timeout=8))
                        current = status.get("current_task") or {}
                        # 休息/睡眠不是移动卡住；长任务静止仅标记候选。
                        skill = (current.get("meta") or {}).get("skill")
                        working = bool(current) and skill not in ("sleep", "rest", "wait", "cook_food", "smelt")
                        metrics.sample(time.monotonic(), body, inv.get("items") or {}, working=working, model_waiting=inflight > 0)
                        host.connected = body.get("connected") is True
                    except Exception:
                        metrics.read_errors += 1
                    if args.interventions and args.interventions.exists():
                        lines = args.interventions.read_text(encoding="utf-8").splitlines()
                        for line in lines[intervention_lines:]:
                            try:
                                kind = json.loads(line).get("kind", "other")
                            except (ValueError, AttributeError):
                                kind = "invalid_record"
                            if kind not in ("command", "give", "teleport", "rescue", "pause", "other", "invalid_record"):
                                kind = "other"
                            metrics.manual_interventions[kind] += 1
                        intervention_lines = len(lines)
                    now = time.monotonic()
                    if now >= next_progress:
                        print(f"评测运行 {int((now - started) / 60)} 分钟；死亡 {metrics.deaths}；模型请求 {tokens.ledger().requests}", flush=True)
                        next_progress = now + 60
                    await asyncio.sleep(min(args.poll_seconds, max(0, deadline - time.monotonic())))
                report["status"] = "completed"
            except asyncio.CancelledError:
                report["status"] = "interrupted"
                metrics.manual_interventions["interrupt"] += 1
            except Exception as exc:
                report["status"] = "failed"
                report["error_type"] = type(exc).__name__
            finally:
                host._terminating = True
                host._manual_disconnect_requested = True
                # 截止后的急停只负责清理，不作为测量期间的任务取消/死亡。
                lifecycle.close()
                await host.life.stop()
                if engine.running:
                    try:
                        await engine.safety_stop()
                    except Exception:
                        pass  # 退出仍必须关闭子进程，日志正文不输出。
                background = list(host._background_tasks)
                for task in background:
                    task.cancel()
                if background:
                    await asyncio.gather(*background, return_exceptions=True)
                await engine.stop()
                if host._supervise_task:
                    host._supervise_task.cancel()
                    await asyncio.gather(host._supervise_task, return_exceptions=True)
    except asyncio.CancelledError:
        report["status"] = "interrupted"
    except Exception as exc:
        report["status"] = "failed"
        report["error_type"] = type(exc).__name__
    finally:
        rcon.close()
        if provider:
            try:
                await provider.terminate()
            except Exception:
                report["provider_cleanup_failed"] = True
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        report["survival"] = metrics.summary()
        report["model"] = tokens.ledger().snapshot()
        report["successful_model_requests"] = (report["model"]["calls"] - report["model"]["failed_calls"]
                                                - report["model"]["cancelled_calls"])
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        print(f"评测 {report['status']}；汇总已写入 {args.report}", flush=True)
    return 0 if report["status"] == "completed" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-host", help="仅连接此专用测试服务器，没有默认地址")
    parser.add_argument("--test-port", type=int, help="显式 Minecraft 测试服端口")
    parser.add_argument("--rcon-port", type=int, help="同一测试服 RCON 端口，只读验证生存规则")
    parser.add_argument("--mc-version", default="1.20.1")
    parser.add_argument("--minutes", type=float, default=60)
    parser.add_argument("--poll-seconds", type=float, default=5)
    parser.add_argument("--stationary-seconds", type=float, default=120)
    parser.add_argument("--model-timeout", type=float, default=120)
    parser.add_argument("--report", type=Path, default=_paths.REPO / ".testserver" / "real-survival.json")
    parser.add_argument("--interventions", type=Path, help="人工干预 JSONL，仅记录 kind，不收正文")
    args = parser.parse_args()
    values, missing = model_environment()
    if missing:
        print("SKIP：没有显式真实模型配置，未连接服务器、未进行生存实测；缺少 " + ", ".join(missing))
        return 0
    parsed = urlsplit(values[0])
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        parser.error("ASTRCRAFT_EVAL_ENDPOINT 必须是没有凭据/查询参数的 HTTP(S) API 基址")
    if not args.test_host or not args.test_port or not args.rcon_port:
        parser.error("真实评测必须显式提供 --test-host、--test-port、--rcon-port")
    if not os.environ.get("ASTRCRAFT_EVAL_RCON_PASSWORD"):
        print("SKIP：未提供 ASTRCRAFT_EVAL_RCON_PASSWORD，无法只读核验生存规则；未进行实测")
        return 0
    if not all(math.isfinite(value) and value > 0 for value in
               (args.minutes, args.poll_seconds, args.stationary_seconds, args.model_timeout)):
        parser.error("时间参数必须是有限正数")
    try:
        return asyncio.run(run(args, values))
    except KeyboardInterrupt:
        print("评测已中断并清理")
        return 1


if __name__ == "__main__":
    sys.exit(main())
