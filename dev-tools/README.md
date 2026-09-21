# dev-tools

**这些脚本不参与运行**，只是开发时用来验证引擎行为的工具。
可以安全删除，删掉不影响插件和引擎。

## 为什么要单独放一个目录

它们原来混在 `engine/tools/` 里，容易被误认为"插件的一部分"，
也让仓库显得杂乱。引擎正式代码里 `console.log` 是 **0 处**——
协议流只走 stdout、日志只走 stderr，这些脚本里的输出不会污染协议。

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

## 分类

| 类型 | 文件 | 说明 |
|---|---|---|
| **回归** | `smoke.js` `engine_check.js` `minetest.js` `crafttest.js` | 主链路是否还通 |
| **专项** | `test_pathfinding.js` `test_unstuck.js` `test_follow_smooth.js` `test_blueprint.js` `test_stations.js` `test_humanize.js` | 单个能力的边界 |
| **真实环境** | `regress_real.js` | 连真实服务器，只连接/观察/走路/量阻塞，**不挖不放** |
| **探针** | `probe_*.js` `_*.js` | 排查问题时用的一次性脚本 |
| **Python 侧** | `check_plugin.py` `check_config.py` `check_await.py` `test_*.py` | 插件工具契约、配置入口、静态检查 |

## 两个值得注意的静态检查

- **`check_await.py`**：静态找出"被 await 的 async generator"和
  "async generator 里写 `return <值>`"。后者会直接 `SyntaxError` 让插件加载失败，
  但**语法检查能过、大部分测试也能过**——只有真正 import 才炸，所以必须静态拦。
- **`check_config.py`**：确认 `_conf_schema.json` 里每个配置项在代码里都真的被读了
  （防止"面板上有个开关，改了没用"）。
