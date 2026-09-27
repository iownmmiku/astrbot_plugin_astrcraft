#!/usr/bin/env python3
"""测试：感知循环的**往返次数上限**（「更短思考」目标的守门测试）。

    python dev-tools/test_perception_rounds.py

## 为什么要有它

感知循环每轮 = **一次模型往返（10~30 秒，见 life.py 的基线注释）**，
尾部还有 1 次强制结语 —— 轮数直接乘以单轮耗时就是「她站着想」的时长。
`max_steps` 从 3 调到 2 没有任何既有测试守着（已 grep），**必须补一个**：
否则以后有人改回去、或者尾部再加调用，没人会发现。

## 判据（只认这些，不猜）

  1. 默认 `max_steps == 2`（构造即断言）
  2. 模型第一轮就给答案 → **provider 只被调 1 次**
  3. 模型第一轮调工具、第二轮给答案 → **2 次**，工具结果进了上下文
  4. 模型每轮都想调工具（最坏情况）→ **至多 3 次**（2 轮循环 + 1 次尾部结语）
     —— 超过就是上限失守

用法（仓库根执行；AstrBot 位置用环境变量，别写死在脚本里）：
  $env:ASTRBOT_APP='<AstrBot>/backend/app'
  & '<AstrBot>/backend/python/python.exe' dev-tools/test_perception_rounds.py
"""

from __future__ import annotations

import asyncio
import io
import sys
from pathlib import Path

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import _paths  # noqa: E402

_paths.require_astrbot("test_perception_rounds")
_paths.load_plugin()

from astrcraft_plugin.perception_agent import PerceptionAgent  # noqa: E402

passed = 0
failed = 0


def ok(msg: str, cond: bool, detail: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✅ {msg}" + (f" —— {detail}" if detail else ""))
    else:
        failed += 1
        print(f"  ❌ {msg}" + (f" —— {detail}" if detail else ""))


class FakeResp:
    """provider.text_chat 的返回形状（只带 decide 用到的字段）。"""

    def __init__(self, names: list[str] | None = None, text: str | None = None):
        self.tools_call_name = list(names or [])
        self.tools_call_args = [{} for _ in self.tools_call_name]
        self.tools_call_ids = [f"c{i}" for i in range(len(self.tools_call_name))]
        self.completion_text = text or ""

    def to_openai_tool_calls_model(self):
        return [
            {"id": i, "type": "function", "function": {"name": n, "arguments": "{}"}}
            for i, n in zip(self.tools_call_ids, self.tools_call_name)
        ]


class FakeProvider:
    """按脚本顺序吐响应，并统计被调用次数（= 模型往返次数）。"""

    def __init__(self, script: list[FakeResp]):
        self.script = script
        self.calls = 0

    async def text_chat(self, **_kw):
        i = min(self.calls, len(self.script) - 1)
        self.calls += 1
        return self.script[i]


class FakePlugin:
    def __init__(self, provider):
        class _Ctx:
            async def get_using_provider_async(self):
                return provider

        self.context = _Ctx()


async def run() -> None:
    # 1) 默认轮数上限
    p = FakeProvider([FakeResp(text="{}")])
    agent = PerceptionAgent(FakePlugin(p))
    ok("默认 max_steps == 2", agent.max_steps == 2, f"max_steps={agent.max_steps}")

    # 影子补丁：工具集与工具执行（decide 只把 toolset 透传给 provider）
    agent._toolset = lambda: {"fake": "toolset"}  # type: ignore[method-assign]

    async def fake_execute(name, args, event):  # noqa: ANN001, ANN002, ANN001
        return f"结果:{name}"

    agent._execute = fake_execute  # type: ignore[method-assign]

    # 2) 第一轮直接作答 → 1 次往返
    p = FakeProvider([FakeResp(text='{"skill":"x"}')])
    a1 = PerceptionAgent(FakePlugin(p))
    a1._toolset = lambda: {"fake": "toolset"}  # type: ignore[method-assign]
    a1._execute = fake_execute  # type: ignore[method-assign]
    text, used = await a1.decide(prompt="p", system="s")
    ok(
        "模型直接作答 → 只调 1 次",
        p.calls == 1 and text == '{"skill":"x"}' and used == [],
        f"calls={p.calls}",
    )

    # 3) 查看一轮后作答 → 2 次往返，工具进了 used
    p = FakeProvider(
        [FakeResp(names=["mc_inventory"]), FakeResp(text='{"skill":"y"}')]
    )
    a2 = PerceptionAgent(FakePlugin(p))
    a2._toolset = lambda: {"fake": "toolset"}  # type: ignore[method-assign]
    a2._execute = fake_execute  # type: ignore[method-assign]
    text2, used2 = await a2.decide(prompt="p", system="s")
    ok(
        "查 1 次后作答 → 恰好 2 次",
        p.calls == 2 and text2 == '{"skill":"y"}' and used2 == ["mc_inventory"],
        f"calls={p.calls} used={used2}",
    )

    # 4) 最坏情况：每轮都想调工具 → 上限 = max_steps 轮 + 1 次尾部结语
    p = FakeProvider(
        [FakeResp(names=["mc_status"]), FakeResp(names=["mc_status"]), FakeResp(text="FINAL")]
    )
    a3 = PerceptionAgent(FakePlugin(p))
    a3._toolset = lambda: {"fake": "toolset"}  # type: ignore[method-assign]
    a3._execute = fake_execute  # type: ignore[method-assign]
    text3, used3 = await a3.decide(prompt="p", system="s")
    cap = a3.max_steps + 1  # 2 轮循环 + 尾部强制结语
    ok(
        "每轮都想查（最坏）→ 至多 max_steps+1 = 3 次",
        p.calls <= cap and p.calls == 3 and text3 == "FINAL",
        f"calls={p.calls} cap={cap}",
    )


asyncio.run(run())

print(f"\n通过 {passed} 项，失败 {failed} 项")
sys.exit(1 if failed else 0)
