#!/usr/bin/env python3
"""配置默认值一致性检查：schema / 引擎 / 文档 三方必须说同一件事。

## 它防的是什么

同一份"默认值"在这个仓库里有**三个副本**：

  1. `_conf_schema.json` —— 公开配置的真源（WebUI 上用户看到的那一份）
  2. `engine/config.js` 的 `DEFAULTS` —— 引擎侧真正生效的那一份
  3. `docs/*.md` —— 文档里声明的数值

只要没人盯着，这三份一定会漂。**已经漂过两次**：

  · `spawn_protection_radius`：schema 是 16、`engine/config.js` 是 0
    → "单独跑引擎调试"和"通过插件跑"的保护行为完全不同
  · `pathThinkTimeoutMs`：`movement.js` 的注释写着"搜索预算 4000 → **1800 毫秒**"，
    而 `DEFAULTS` 是 4000 —— 因为那行写的是
    `Number(config.get('pathThinkTimeoutMs')) || 1800`，
    **DEFAULTS 永远提供值，`||` 右边永远不可达**。
    于是"这次修复"实际上一天都没生效过，而且没有任何东西会报错。

第二类（不可达的 `||` 兜底）是最阴的：注释说 A、代码是 B，
两边都"看起来对"。所以这个脚本除了比数值，还会**扫描所有
`config.get('X') || …` 的写法**并直接判错——`config.get` 的返回值一定存在
（DEFAULTS 兜底），想要 null 保护请用 `??`。

## 还检查什么（C4）

**默认挖掘白名单必须覆盖内置技能真正会挖的方块。**
默认白名单漏掉全部矿石时，"挖铁矿"在默认配置下 100% 被
`actions.js` 的 `_assertNotProtected` 拒绝，而报错又被技能层吞成
"附近没有找到iron"——模型完全看不出真正的原因。
所以这里从引擎源码里**解析出技能真正会挖的方块清单**再逐项比对，
而不是抄一份写死的列表（抄的那份自己也会漂）。

## 用法

    py -3 dev-tools/test_config_parity.py

退出码非 0 表示三方不一致。仓库根默认取本文件上一级，
可用环境变量 `ASTRCRAFT_REPO` 覆盖。
"""

from __future__ import annotations

import argparse
import io
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Windows 控制台默认 GBK，直接 print ✅/❌ 会抛 UnicodeEncodeError。
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import ENGINE_DIR, REPO, read_text  # noqa: E402

# ---------------------------------------------------------------- 键映射表
#
# (_conf_schema.json 的键, engine/config.js 的 DEFAULTS 键)
#
# 只列**语义确实相同**的键：插件侧是 snake_case、引擎侧是 camelCase。
# 插件独有的项（life_decide_interval 之类）不在这里——它们在引擎里没有对应物。
KEY_PAIRS: tuple[tuple[str, str], ...] = (
    ("server_host", "host"),
    ("server_port", "port"),
    ("bot_username", "username"),
    ("auth_method", "auth"),
    ("mc_version", "version"),
    ("slow_mode", "slowMode"),
    ("auto_mode", "autoMode"),
    ("auto_eat", "autoEat"),
    ("auto_defend", "autoDefend"),
    ("auto_collect_drops", "autoCollectDrops"),
    ("auto_torch", "autoTorch"),
    ("humanize", "humanize"),
    ("enable_viewer", "enableViewer"),
    ("viewer_port", "viewerPort"),
    ("viewer_first_person", "viewerFirstPerson"),
    ("viewer_view_distance", "viewerViewDistance"),
    ("spawn_protection_radius", "spawnProtectionRadius"),
    ("dig_whitelist", "digWhitelist"),
    ("dig_blacklist", "digBlacklist"),
    ("path_think_timeout_ms", "pathThinkTimeoutMs"),
)

# 单位不同的键：(schema 键, engine 键, 换算系数)
UNIT_PAIRS: tuple[tuple[str, str, int], ...] = (
    # 插件侧以"秒"为单位暴露给用户，引擎侧是毫秒
    ("skill_timeout_seconds", "skillTimeoutMs", 1000),
)

# ---------------------------------------------------------------- 文档断言
#
# (文档路径, 正则（必须有一个捕获组 = 文档里声明的数值）, 这个数值应该等于什么)
#
# 语义：**文档里找不到这条声明也算失败**——因为"文档不再声明默认值"
# 和"文档声明了错的默认值"对读者是同一种伤害。
DOC_ASSERTIONS: tuple[tuple[str, str, str], ...] = (
    ("docs/LIMITS.md", r"`spawn_protection_radius`\s*\*\*默认\s*(\d+)\*\*", "schema:spawn_protection_radius"),
    ("docs/LIMITS.md", r"`dig_whitelist`\s*\*\*默认\s*(\d+)\s*项\*\*", "schema:len(dig_whitelist)"),
    ("docs/LIMITS.md", r"`path_think_timeout_ms`\s*默认\s*\*\*(\d+)\*\*", "schema:path_think_timeout_ms"),
    ("docs/MODULE_MAP.md", r"`pathThinkTimeoutMs`（搜索预算，\*\*默认\s*(\d+)\s*毫秒\*\*", "engine:pathThinkTimeoutMs"),
    ("docs/MODULE_MAP.md", r"`pathTimeoutMs`（允许走多久，默认\s*(\d+)\s*秒）", "engine_ms_to_s:pathTimeoutMs"),
)

# ---------------------------------------------------------------- 工具


def load_schema(repo: Path) -> dict:
    path = repo / "_conf_schema.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"❌ 找不到 {path}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"❌ {path.name} 解析失败：{exc}")
    if not isinstance(data, dict) or not data:
        raise SystemExit("❌ _conf_schema.json 不是非空对象")
    return data


def load_engine_defaults(engine_dir: Path) -> dict:
    """用 node 加载 engine/config.js 并取回 DEFAULTS（**唯一可靠的读法**）。

    为什么不正则解析：那是个真实的 JS 对象字面量（带注释、模板串、函数调用），
    正则一定会漏或者错。而 `config.js` 只依赖 `./log`，不需要 node_modules。
    """
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        raise SystemExit(
            "❌ PATH 里找不到 node，无法读取 engine/config.js 的 DEFAULTS。\n"
            "   （不用正则硬解 JS 对象是刻意的：那样解析出来的默认值不可信，"
            "而「不可信的检查器」比没有检查器更糟。）"
        )
    script = (
        "const c=require(process.argv[1]);"
        "process.stdout.write(JSON.stringify(c.DEFAULTS));"
    )
    proc = subprocess.run(
        [node, "-e", script, str(engine_dir / "config.js")],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        raise SystemExit(
            f"❌ 加载 engine/config.js 失败（exit={proc.returncode}）：\n{proc.stderr[-800:]}"
        )
    return json.loads(proc.stdout)


def js_array(src: str, name: str) -> list[str]:
    """从 JS 源码里取一个字符串数组常量，例如 `const LOG_NAMES = [...]`。"""
    m = re.search(rf"const\s+{re.escape(name)}\s*=\s*\[(.*?)\]\s*;", src, re.S)
    if not m:
        return []
    return re.findall(r"'([^']+)'|\"([^\"]+)\"", m.group(1)) and [
        a or b for a, b in re.findall(r"'([^']+)'|\"([^\"]+)\"", m.group(1))
    ]


def engine_mined_blocks(engine_dir: Path) -> dict[str, list[str]]:
    """从引擎源码解析出"技能真正会挖的方块"，按来源分组。"""
    mining = read_text(engine_dir / "skills" / "mining.js")
    wood = read_text(engine_dir / "skills" / "wood.js")
    gathering = read_text(engine_dir / "skills" / "gathering.js")

    out: dict[str, list[str]] = {}

    # ORES 表里每个矿石的 blocks 数组
    start = mining.find("const ORES = {")
    end = mining.find("\n};", start) if start >= 0 else -1
    ore_blocks: list[str] = []
    if start >= 0 and end > start:
        for chunk in re.findall(r"blocks:\s*\[([^\]]*)\]", mining[start:end]):
            ore_blocks += [a or b for a, b in re.findall(r"'([^']+)'|\"([^\"]+)\"", chunk)]
    out["mining.js ORES（mine_ores 会挖的矿石）"] = sorted(set(ore_blocks))

    out["mining.js STONE_BLOCKS（mine_stone 第一阶段）"] = sorted(set(js_array(mining, "STONE_BLOCKS")))
    out["mining.js STONE_VARIANTS（mine_stone 第二阶段）"] = sorted(set(js_array(mining, "STONE_VARIANTS")))
    out["wood.js LOG_NAMES（chop_tree 会砍的原木）"] = sorted(set(js_array(wood, "LOG_NAMES")))

    # gathering.js 的苹果来源（会挖树叶）
    m = re.search(r"apple:\s*\[([^\]]*)\]", gathering)
    if m:
        out["gathering.js apple（collect apple 会挖的树叶）"] = sorted(
            {a or b for a, b in re.findall(r"'([^']+)'|\"([^\"]+)\"", m.group(1))}
        )
    return out


def check_unreachable_fallbacks(engine_dir: Path) -> list[str]:
    """扫描 `config.get('X') || …`：DEFAULTS 一定提供值，所以右边是死代码。

    这是 A5 那次修复失效的根因形态，必须机器拦住。
    """
    problems: list[str] = []
    pattern = re.compile(r"config\.get\(\s*'([A-Za-z0-9_]+)'\s*\)\s*\|\|")
    for path in sorted(engine_dir.rglob("*.js")):
        if "node_modules" in path.parts:
            continue
        src = read_text(path)
        for i, line in enumerate(src.splitlines(), start=1):
            m = pattern.search(line)
            if m:
                problems.append(
                    f"{path.relative_to(engine_dir.parent)}:{i} "
                    f"`config.get('{m.group(1)}') || …` —— 不可达兜底（请改用 `??`）"
                )
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description="配置默认值一致性检查")
    ap.add_argument("--repo", default=None, help="仓库根目录（默认取本文件上一级 / ASTRCRAFT_REPO）")
    args = ap.parse_args()

    repo = Path(args.repo).resolve() if args.repo else REPO
    engine_dir = repo / "engine"

    print("=== 配置默认值一致性检查 ===")
    print(f"仓库根：{repo}\n")

    schema = load_schema(repo)
    defaults = load_engine_defaults(engine_dir)
    failures: list[str] = []
    warnings: list[str] = []

    # ---------------------------------------------------------- ① schema ↔ engine
    print("① _conf_schema.json ↔ engine/config.js DEFAULTS")
    checked = 0
    for skey, ekey in KEY_PAIRS:
        if skey not in schema:
            failures.append(f"schema 里缺少配置项 {skey}")
            print(f"  ❌ schema 里没有 {skey}")
            continue
        if ekey not in defaults:
            failures.append(f"engine DEFAULTS 里缺少 {ekey}")
            print(f"  ❌ engine DEFAULTS 里没有 {ekey}")
            continue
        sval = schema[skey].get("default")
        eval_ = defaults[ekey]
        checked += 1
        if isinstance(sval, list) and isinstance(eval_, list):
            # 列表：**逐项 + 顺序**都要一致（顺序不影响语义，但一致才看得住漂移）
            if sval != eval_:
                only_s = [x for x in sval if x not in eval_]
                only_e = [x for x in eval_ if x not in sval]
                failures.append(
                    f"{skey} 与 {ekey} 不一致：schema {len(sval)} 项 / engine {len(eval_)} 项"
                    + (f"；只在 schema 里：{only_s}" if only_s else "")
                    + (f"；只在 engine 里：{only_e}" if only_e else "")
                    + ("；顺序不同" if not only_s and not only_e else "")
                )
                print(f"  ❌ {skey} ≠ {ekey}（schema {len(sval)} 项 / engine {len(eval_)} 项）")
            else:
                print(f"  ✅ {skey} = {ekey}（{len(sval)} 项，逐项一致）")
        elif sval != eval_:
            failures.append(f"{skey}={sval!r} 与 {ekey}={eval_!r} 不一致")
            print(f"  ❌ {skey}={sval!r} ≠ {ekey}={eval_!r}")
        else:
            print(f"  ✅ {skey} = {ekey} = {sval!r}")

    for skey, ekey, factor in UNIT_PAIRS:
        sval = schema.get(skey, {}).get("default")
        eval_ = defaults.get(ekey)
        checked += 1
        if sval is None or eval_ is None:
            failures.append(f"{skey}/{ekey} 缺一方的默认值")
            print(f"  ❌ {skey} 或 {ekey} 没有默认值")
        elif int(sval) * factor != int(eval_):
            failures.append(f"{skey}={sval} × {factor} ≠ {ekey}={eval_}")
            print(f"  ❌ {skey}={sval} 秒 ≠ {ekey}={eval_} 毫秒")
        else:
            print(f"  ✅ {skey}={sval} 秒 = {ekey}={eval_} 毫秒")

    # ---------------------------------------------------------- ② 不可达兜底
    print("\n② 引擎里不许有不可达的 `config.get('X') || …`（A5 的根因形态）")
    bad_fallbacks = check_unreachable_fallbacks(engine_dir)
    if bad_fallbacks:
        for b in bad_fallbacks:
            print(f"  ❌ {b}")
            failures.append(b)
    else:
        print("  ✅ 没有发现不可达兜底（想要 null 保护请用 `??`）")

    # ---------------------------------------------------------- ③ 文档声明
    print("\n③ 文档里声明的默认值必须与代码一致")
    for doc, pattern, expect in DOC_ASSERTIONS:
        text = read_text(repo / doc)
        if not text:
            failures.append(f"读不到 {doc}")
            print(f"  ❌ 读不到 {doc}")
            continue
        m = re.search(pattern, text)
        if not m:
            failures.append(f"{doc} 里找不到这条默认值声明：{pattern}")
            print(f"  ❌ {doc} 里找不到这条声明（{expect}）——文档不再说明默认值也算失败")
            continue
        got = int(m.group(1))
        kind, _, key = expect.partition(":")
        if kind == "schema":
            if key.startswith("len("):
                want = len(schema[key[4:-1]].get("default") or [])
            else:
                want = schema[key].get("default")
        elif kind == "engine":
            want = defaults[key]
        elif kind == "engine_ms_to_s":
            want = int(defaults[key]) // 1000
        else:  # pragma: no cover - 表写错了
            failures.append(f"DOC_ASSERTIONS 里有个不认识的期望类型：{expect}")
            continue
        if got != want:
            failures.append(f"{doc} 声明 {got}，代码是 {want}（{expect}）")
            print(f"  ❌ {doc}：文档说 {got}，代码是 {want}")
        else:
            print(f"  ✅ {doc}：{got} = {want}")

    # ---------------------------------------------------------- ④ C4 白名单覆盖
    print("\n④ 默认挖掘白名单必须覆盖内置技能真正会挖的方块（C4）")
    whitelist = set(schema.get("dig_whitelist", {}).get("default") or [])
    if not whitelist:
        print("  ⚠ 默认白名单是空的——那意味着'不限制'，与'覆盖'是两回事；")
        print("    如果这是有意的，请让 docs/LIMITS.md 明确写清'默认空 = 不限制'。")
        warnings.append("默认白名单为空")
    groups = engine_mined_blocks(engine_dir)
    if not groups.get("mining.js ORES（mine_ores 会挖的矿石）"):
        failures.append("解析不出 mining.js 的 ORES 表——检查器自己坏了")
        print("  ❌ 解析不出 ORES 表（检查器坏了，而不是代码干净）")
    for label, blocks in groups.items():
        if not blocks:
            warnings.append(f"{label} 解析为空（可能改了结构，请人工确认）")
            print(f"  ⚠ {label}：解析为空，跳过")
            continue
        missing = [b for b in blocks if b not in whitelist]
        if missing:
            failures.append(f"{label} 里有 {len(missing)} 种方块不在默认白名单：{missing}")
            print(f"  ❌ {label}：{len(missing)} 种不在默认白名单里 → {missing}")
        else:
            print(f"  ✅ {label}：{len(blocks)} 种全部覆盖")

    # ---------------------------------------------------------- 结果
    print("\n=== 结果 ===")
    for w in warnings:
        print(f"  ⚠ {w}")
    if failures:
        print(f"❌ {len(failures)} 个问题（共比对 {checked} 组默认值）：")
        for f in failures:
            print(f"  ✗ {f}")
        print("\n  修法：以 _conf_schema.json 为公开配置真源，把 engine/config.js 与文档改到一致。")
        return 1
    print(f"✅ 通过：{checked} 组默认值三方一致，白名单覆盖完整，没有不可达兜底")
    return 0


if __name__ == "__main__":
    sys.exit(main())
