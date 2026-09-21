"""ActionAgent 的行为测试（T4：技能承担多步）。

钉住的是**"提交长任务就结束这一轮"在代码里真的生效**——
这条规则原来只写在提示词里，模型不听话时会把步数预算烧在等待和查询上，
用户看到的就是"一堆无意义的动作、忙半天什么都没做成"。

同时也钉住两件事，它们都是实际踩过的坑：
  1. 判据要匹配**中文的"任务号"**。我第一版写成 `"task_id" in out`，
     而技能工具返回的文案里只有"任务号"、没有字面 task_id →
     这个提前结束**永远不会触发**（写了等于没写）。
  2. 提示词里引用的工具名必须真实存在。我上一版让模型调
     `mc_skill_run(skill="chop_tree")`，而 58 个工具里**根本没有这个工具** →
     模型只能退回用 mc_craft 一步步硬拼。
"""

import sys
import asyncio
import re
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from plugin.action_agent import ActionAgent, MAX_STEPS  # noqa: E402

passed = 0
failed = 0


def ok(msg, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✅ {msg}{' — ' + detail if detail else ''}")
    else:
        failed += 1
        print(f"  ❌ {msg}{' — ' + detail if detail else ''}")


class _Resp:
    def __init__(self, names, args):
        self.tools_call_name = names
        self.tools_call_args = args
        self.tools_call_ids = [f"c{i}" for i in range(len(names))]
        self.completion_text = ""

    def to_openai_tool_calls_model(self):
        return []


class _Provider:
    """第一轮提交一个技能工具；之后每被调用一次就记一笔（说明没提前停）。"""

    def __init__(self, first_names, first_args):
        self.calls = 0
        self.first_names = first_names
        self.first_args = first_args

    async def text_chat(self, **kw):
        self.calls += 1
        if self.calls == 1:
            return _Resp(self.first_names, self.first_args)
        return _Resp(["mc_inventory"], [{}])


class _Ctx:
    async def get_using_provider_async(self):
        return None


class _Plugin:
    def __init__(self, provider):
        self._provider = provider
        self.context = _Ctx()

    async def get_provider(self):
        return self._provider


def build(provider, execute):
    """绕开 __init__，直接拼一个能跑 act() 的 agent。"""
    a = ActionAgent.__new__(ActionAgent)
    a.max_steps = MAX_STEPS
    a.plugin = _Plugin(provider)
    a._toolset = lambda: "FAKE"
    a._execute = execute
    return a


def run(agent):
    # act() 里会 await plugin.context.get_using_provider_async()；
    # 这里把 provider 直接塞进去
    async def fake_get():
        return agent.plugin._provider

    agent.plugin.context.get_using_provider_async = fake_get
    return asyncio.run(agent.act(prompt="测试", system="测试"))


print("=== 常量 ===")
ok("步数上限调回了 6", MAX_STEPS == 6, f"MAX_STEPS={MAX_STEPS}")

print("\n=== 提交长任务 → 立刻结束这一轮 ===")
calls = []


async def ex_skill(name, args, event):
    calls.append(name)
    return "已让机器人开始「砍树」，任务号 t123。\n这会持续一段时间——**你这一轮就到此为止**"


prov = _Provider(["mc_chop_tree"], [{"count": 8}])
text, used = run(build(prov, ex_skill))
ok("只调了 1 次工具就停", used == ["mc_chop_tree"], f"used={used}")
ok("模型只被调用 1 次（没有第二轮）", prov.calls == 1, f"模型调用 {prov.calls} 次")
ok("返回了收尾说明", text is not None and "交代" in str(text), f"text={text}")

print("\n=== 只读工具不会提前结束（该继续就继续）===")
calls2 = []


async def ex_read(name, args, event):
    calls2.append(name)
    return "位置 (0, 64, 0) ｜ 血量 20/20"


prov2 = _Provider(["mc_status"], [{}])
text2, used2 = run(build(prov2, ex_read))
ok("只读工具后继续跑（模型被调用多次）", prov2.calls > 1, f"模型调用 {prov2.calls} 次")
ok("步数没有超过上限", len(used2) <= MAX_STEPS, f"调了 {len(used2)} 次")

print("\n=== 判据必须匹配中文「任务号」 ===")
src = pathlib.Path(__file__).resolve().parents[2] / "plugin" / "action_agent.py"
t = src.read_text(encoding="utf-8")
ok(
    "提前结束的判据里含中文「任务号」",
    '"任务号" in str(out)' in t,
    "技能工具返回的文案里是「任务号 xxx」，没有字面 task_id",
)
ok(
    "英文 task_id 也一起判（两种写法都覆盖）",
    '"task_id" in str(out)' in t,
)

print("\n=== 提示词里引用的工具必须真实存在 ===")
names = set()
for p in (pathlib.Path(__file__).resolve().parents[2] / "plugin").glob("llm_tools_*.py"):
    names |= set(re.findall(r'@filter\.llm_tool\(name="(mc_[a-z_]+)"', p.read_text(encoding="utf-8")))
# EXCLUDED_TOOLS 是**故意**不暴露给 agent 的管理类工具（改配置/重启/暂停人生…），
# 它们出现在文件里是正确的，不算"幻影工具"。
ex_block = t.split("EXCLUDED_TOOLS = (")[1].split(")")[0]
excluded = set(re.findall(r'"(mc_[a-z_]+)"', ex_block))
mentioned = set(re.findall(r"\bmc_[a-z_]+\b", t))
phantom = mentioned - names - excluded
ok(
    "提示词里没有引用不存在的工具",
    not phantom,
    f"可疑: {sorted(phantom)}" if phantom else f"全部存在（另有 {len(excluded)} 个是故意排除的管理工具）",
)
ok(
    "特别地：不再引用 mc_skill_run（它不存在）",
    "mc_skill_run" not in t,
    "已改成真实工具名 mc_chop_tree / mc_make_tools…",
)

print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
sys.exit(1 if failed else 0)
