# dev-tools

> 路径与导入约定见 [../docs/REPO.md](../docs/REPO.md)。

## **先看这个：一条命令跑全部检查**

```bash
python dev-tools/run_all.py            # 不需要服务器（约 3 分钟）
python dev-tools/run_all.py --full     # 连需要测试服的也跑
python dev-tools/run_all.py --only life
python dev-tools/run_all.py -v         # 看完整输出
```

它**自己知道**哪些脚本需要服务器（扫内容判定，不写死清单 —— 所以新增脚本不用改它），
并且会**明确打出"跳过了什么"**和**"哪些是已知偶发红"**。
失败、超时和启动错误都会使检查返回非零；偶发记录只提供背景，不把失败当成通过。

下面那些分类说明是给"想知道细节"的人看的；**日常只要跑上面这一条**。


**这些脚本不参与运行**，只是开发时用来验证引擎行为的工具。
可以安全删除，删掉不影响插件和引擎。

## 为什么要单独放一个目录

它们原来混在引擎目录里，容易被误认为"插件的一部分"，
也让仓库显得杂乱。引擎正式代码里 `console.log` 是 **0 处**——
协议流只走 stdout、日志只走 stderr，这些脚本里的输出不会污染协议。

## 路径与导入约定（**改脚本前先读这条**）

仓库的真实布局是：仓库根目录**就是**插件本体（`main.py` / `life.py` / …），
引擎在 `engine/`，脚本在 `dev-tools/`。
早期文档和脚本假设的是 `plugin/`（Python）+ `bot/`（引擎）两个子目录，
**那两个目录从来不存在**——所以：

- **Python 脚本**不要自己拼 `parents[2] / "plugin"`，也不要 `from plugin.x import`。
  统一用同目录的 `_paths.py`：

  ```python
  import sys
  from pathlib import Path
  sys.path.insert(0, str(Path(__file__).resolve().parent))
  from _paths import REPO, ENGINE_DIR, plugin_module, require_astrbot

  life = plugin_module("life")          # 等价于 import <pkg>.life（相对导入也能用）
  src = (REPO / "life.py").read_text(encoding="utf-8")   # 静态断言读源码
  ```

  `_paths.py` 用**命名空间包**加载插件（`__path__` 指向仓库根），
  **不复制任何源码**——"拷一份到临时目录再测"测的是快照，不是真实代码。
  仓库根可以用环境变量 `ASTRCRAFT_REPO` 覆盖。
  需要 AstrBot 运行时的脚本调 `require_astrbot("测试名")`：拿不到就打印
  一行明确的 SKIP 并以 0 退出（**环境缺失不是代码坏了，但绝不能静默跳过**）。

- **JS 脚本**里引擎入口是 `path.join(__dirname, '..', 'engine', 'index.js')`，
  引擎模块是 `require('../engine/stations')` 这种形式。

## 怎么用

大部分需要一台测试服务器（默认 `127.0.0.1:25566`，RCON `25576`）：

```bash
node dev-tools/smoke.js --connect       # 冒烟：29 项
node dev-tools/engine_check.js          # 引擎直测：6 项
node dev-tools/test_pathfinding.js      # 寻路压力：6 场景
node dev-tools/test_blueprint.js        # 蓝图图纸校验：23 项
node dev-tools/test_stations.js         # 工作站记忆：10 项
node dev-tools/regress_real.js 25565    # 在真实服务器上跑（只读不写）
```

### 自主行动与控制恢复回归

```bash
python dev-tools/test_life_recovery.py    # 模型重试、计划衔接、旧会话回复失效
python dev-tools/test_plugin_control.py   # 急停、退服、目标所有权、状态缓存和死亡
python dev-tools/test_tool_contracts.py    # AstrBot 工具注册与 JSON 多步计划参数
node dev-tools/test_engine_control.js     # 真队列与动作层：取消、反射、合成和移动
node dev-tools/test_window_cancel.js      # 实际 mineflayer 窗口取消后不污染新窗口
node dev-tools/test_building_completion.js # 完整结构验收、缺料、取材和换建材
```

真实游戏测试使用项目 `.testserver` 的 Paper 1.20.1，Minecraft 端口 `25566`、RCON `25576`。
以下脚本会准备测试地形并操作测试机器人，请在专用测试服运行：

```bash
python dev-tools/test_autonomy_live.py          # 固定 JSON 决策，真实自主执行链
python dev-tools/test_autonomy_live.py --agent  # 实际 ActionAgent + mc_plan_do 工具计划
python dev-tools/test_autonomy_live.py --agent --survival --supplies # 饱食度 0 自动补给后续做原计划；生鱼烹饪与存箱保留必需品
node dev-tools/test_survival_chain.js           # 采矿→石制工具→庇护所，验收 82 格结构
node dev-tools/test_survival_chain.js --step 3  # 独立建房，保留相同结构断言
node dev-tools/test_pit_escape.js               # 浅坑/零装备/深井共 6 项真实验收
node dev-tools/test_pit_escape.js --step 4      # 10 格深井爬升 + 独立无镐深井垫高
node dev-tools/crafttest.js --port 25566 --rcon-port 25576 --rcon-dir .testserver
```

自主测试的模型回复固定，验证一次规划后的执行、实物产出、衔接与急停恢复；
不代表实际模型已通过开放世界长期游玩测试。Python 脚本应使用安装 AstrBot 的解释器，
必要时将 `ASTRBOT_APP` 与 `PYTHONPATH` 指向 AstrBot 的应用目录。

脱困测试要求任务真实结束且实际站到井口；每个场景清空背包，独立准备地形。
设置 `MC_ENGINE_LOG_LEVEL=info`、`MC_TEST_VERBOSE=1` 可以在长测试期间连续输出引擎日志。

`test_integration.py` 默认验证插件加载、引擎通道和卸载；设置 `MC_TEST_CONNECT=1`、
`MC_TEST_PORT=25566` 启用真实进服。再设置 `MC_TEST_DEATH=1` 可在项目测试服杀死测试机器人，
验证重生解除死亡停牌、急停保持；插件数据使用临时目录隔离。

> 这些脚本需要 `engine/node_modules`（在 `engine/` 里执行过 `npm install`）。
> 没装依赖时凡是 `require('mineflayer')` 的脚本都会报 `Cannot find module`——
> 那是环境没装好，不是脚本坏了。

### 在出生点附近挖方块的测试

生产默认 `spawn_protection_radius = 16`（出生点半径内不做破坏性动作）。
冒烟/脱困这类**故意在脚下挖方块**的测试，`connect` 参数里显式带了
`spawnProtectionRadius: 0`——否则 `dig` 会被「出生点保护拦截」拒绝，
测试会误报失败。新增这类测试时请照做。

## 分类

| 类型 | 文件 | 说明 |
|---|---|---|
| **回归** | `smoke.js` `engine_check.js` `minetest.js` `crafttest.js` | 主链路是否还通 |
| **专项** | `test_pathfinding.js` `test_unstuck.js` `test_follow_smooth.js` `test_blueprint.js` `test_stations.js` `test_humanize.js` | 单个能力的边界 |
| **真实环境** | `regress_real.js` | 连真实服务器，只连接/观察/走路/量阻塞，**不挖不放** |
| **探针** | `probe_*.js` `_*.js` | 排查问题时用的一次性脚本 |
| **Python 侧** | `check_plugin.py` `check_config.py` `check_await.py` `test_*.py` | 插件工具契约、配置入口、静态检查 |
| **一致性检查** | `check_skill_names.py` `test_config_parity.py` `check_tool_prompts.py` | 见下 |

## 值得注意的静态检查

- **`check_await.py`**：静态找出"被 await 的 async generator"和
  "async generator 里写 `return <值>`"。后者会直接 `SyntaxError` 让插件加载失败，
  但**语法检查能过、大部分测试也能过**——只有真正 import 才炸，所以必须静态拦。
- **`check_config.py`**：确认 `_conf_schema.json` 里每个配置项在代码里都真的被读了
  （防止"面板上有个开关，改了没用"）。
- **`check_skill_names.py`**：`advisor.py` / `life.py` 里写死的技能名必须都在
  `engine/skills/index.js` 的 `SKILLS` 注册表里。这类"提示词/建议指向一个不存在的技能"
  已经出现过（advisor 曾经建议 `craft`，而当时注册表里没有它），
  代价是白烧一轮模型往返 + 记一笔失败 + 触发 30 秒退避。
- **`test_config_parity.py`**：`_conf_schema.json`（公开配置真源）、
  `engine/config.js` 的 `DEFAULTS`、以及文档里声明的默认值必须三方一致。
  这条防的是"注释/文档说 A、代码是 B"的漂移
  （`pathThinkTimeoutMs` 就漂过一次：注释写 1800、DEFAULTS 是 4000，
  因为 `|| 1800` 那个兜底永远不可达）。
- **`check_tool_prompts.py`**：提示词里提到的每个 `mc_*` 都必须**真实注册**，
  而且必须在该条路径的**工具集里真的可用**（`action_agent` 要过 `EXCLUDED_TOOLS`，
  决策路径要过 `PERCEPTION_TOOLS`）。防的是"提示词让她调一个她手上没有的工具"。
