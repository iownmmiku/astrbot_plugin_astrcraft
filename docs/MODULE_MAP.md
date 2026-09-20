# 代码地图

给要改这个项目的人（包括几个月后的自己）。

## 目录结构

```
mc-astrbot/
├─ bot/                        Node 引擎（真实游戏客户端）
│  ├─ index.js                 RPC 服务端：所有能力的入口，方法表在这里
│  ├─ bot.js                   mineflayer 实例装配、事件桥、反射层、重连
│  ├─ rpc.js                   NDJSON/JSON-RPC 实现 + 错误类型定义
│  ├─ config.js                配置与默认值、敌对生物判定
│  ├─ util.js                  日志、坐标、错误翻译、超时工具
│  ├─ log.js                   日志（强制走 stderr，日志脱敏）
│  ├─ state.js                 状态快照、差分事件、简 reporting、方块扫描
│  ├─ movement.js              pathfinder 封装：goTo / follow / 卡住检测
│  ├─ actions.js               原子动作：dig / place / craft / smelt / eat / attack / 容器
│  ├─ goals.js                 引擎侧任务队列（优先级 + 抢占 + 取消）
│  ├─ skills/                  技能层（"做成一件事"）
│  │  ├─ index.js              技能注册表 + 参数校验
│  │  ├─ common.js             技能上下文、进度上报、落地/下树冠、直接行走
│  │  ├─ wood.js               木材与工具链
│  │  ├─ mining.js             挖矿、向下挖阶梯、熔炼
│  │  ├─ building.js           庇护所建造
│  │  └─ gathering.js          通用收集、存货、食物、打猎
│  ├─ tools/                   测试与运维脚本
│  └─ node_modules/            引擎依赖
├─ plugin/                     AstrBot 插件（Python）
│  ├─ main.py                  生命周期、引擎监管、指令、事件转发
│  ├─ llm_tools_core.py        LLM 工具：感知 / 移动 / 基础动作
│  ├─ llm_tools_skills.py      LLM 工具：技能 / 目标 / 社交
│  ├─ llm_tools_life.py        LLM 工具：人格 / 记忆 / 过日子（"朋友接口"）
│  ├─ bridge_client.py         子进程管理 + NDJSON 客户端
│  ├─ perception.py            状态快照 → 给 LLM 的紧凑简报
│  ├─ goals.py                 长期目标 → 技能链 → 执行与重规划
│  ├─ persona.py               人格桥接：接 AstrBot 的 PersonaManager
│  ├─ memory.py                记忆层：经历存储 + 相关度检索
│  ├─ drives.py                驱动力：五个内在动机的水位竞争
│  ├─ life.py                  过日子循环：自己决定做什么 + 主动分享
│  ├─ game_agent.py            游戏内对话代理：玩家在游戏里说的话能真正驱动动作
│  ├─ datadir.py               数据目录多候选解析（优先复用已有数据）
│  ├─ metadata.yaml            插件清单
│  └─ _conf_schema.json        配置项定义
├─ config/bot.config.json      引擎独立运行时的配置（可选）
├─ docs/                       文档
├─ scripts/                    安装与开发脚本
└─ PLAN.md                     原始实施计划
```

## 数据流（一次"砍树"的完整路径）

```
用户在 QQ 说"去砍点木头"
  → AstrBot 路由到 LLM
  → LLM 调用工具 mc_chop_tree(count=8)          [plugin/llm_tools_skills.py]
  → 转发为 skill.run 请求                        [plugin/bridge_client.py]
  → 引擎 RPC 分发                                [bot/index.js]
  → 提交为任务，立刻返回 task_id                 [bot/goals.js]
  → 后台执行技能                                  [bot/skills/wood.js]
      ├─ settle() 确保不在树冠上                  [bot/skills/common.js]
      ├─ 找树 → goTo() 走过去                     [bot/movement.js]
      ├─ dig() 挖方块 + 自动选工具                [bot/actions.js]
      └─ collectDrops() 捡掉落物
  → 进度通过 notice 事件回推（"砍树 3/8"）         [bot/state.js → bot/index.js]
  → 任务结束后推送 task.finished
  → 插件更新状态缓存，LLM 下次查 mc_task_status 就能看到结果
```

## 加一个新技能（最常见的扩展）

四步：

1. **写实现** —— 在 `bot/skills/` 下新建文件或在已有文件里加函数。
   签名统一为 `async function mySkill({ actions, nav, state, ctx, params })`。
   - `actions`：原子动作（挖/放/合成/吃/攻击/容器）
   - `nav`：寻路（goTo / follow / stop）
   - `state`：状态查询（nearbyEntities / scanBlocks / findNearestBlock）
   - `ctx`：取消信号、进度上报 `ctx.progress()`、`ctx.checkAborted()`
   - 返回值统一走 `skillResult(ok, { steps, produced, note, reason })`

2. **注册** —— 在 `bot/skills/index.js` 的 `SKILLS` 里加一项，写好 `label` 与 `description`
   （这两个字段会进 LLM 的工具描述与 `mc_skills` 输出）。

3. **暴露给 LLM（可选）** —— 在 `plugin/llm_tools_skills.py` 加一个
   `@filter.llm_tool(name="mc_xxx")` 方法。
   **`Args:` 段的格式必须严格正确**，否则参数会被静默丢弃：
   ```
   Args:
       count(number): 要几个，默认 8
   ```
   改完跑 `python bot/tools/check_plugin.py` 验证。

4. **测试** —— 在 `bot/tools/skilltest.js` 里加一项，跑真服务器验证。

## 约定与陷阱（都是踩过的）

### 坐标必须用 `vec3()`
mineflayer 内部调用 `Vec3` 的方法（`.floored()` / `.offset()`）。
传普通 `{x, y, z}` 会抛 `pos.floored is not a function`，而且**得很晚才暴露**。
所有方块查询走 `blockAt(bot, x, y, z)` helper，它内部会构造 Vec3。

### 兜底 catch 必须留痕
`try { ... } catch { return null }` 会把"代码坏了"伪装成"这里没有东西"。
曾经有个 `blockAt` 因为批量替换变成无限递归，被 catch 吞掉后表现为
"脚下永远是未知方块"，查了很久。现在这类 catch 一律带 `log.debug`。

### 不要在 `setGoal` 后把 `goal_updated` 当成功
pathfinder 设置目标后会立刻触发一次 `goal_updated`。
如果把它当"到达"，任务会在出发前就报成功——**假成功比报错危险得多**。
结束条件只认：`goal_reached` / 超时 / 卡住 / 取消。

### 长时间动作一律异步
任何可能超过两秒的动作都要走 `submitAction` / `skill.run`，立刻返回 `task_id`。
同步阻塞会让 LLM 对话卡住，体验立刻崩坏。

### 掉落物不能按方块名猜
挖草方块掉的是泥土、挖矿石掉的是粗矿。
判断"有没有捡到"只能看背包差分（`diffInventory`），不能拿方块名去对。

### 失败信息要能指导下一步
错误信息最终会进 LLM 上下文。写"操作失败"模型只能重试；
写"目标上方是水无法站立，建议换位置"模型就会换策略。
新加的错误处理请沿用 `describeFailure()` / `humanizeError()` 的风格。

### stdout 是协议流
引擎进程的 stdout 只能出现 NDJSON。任何 `console.log` 都会污染协议。
`log.js` 已经劫持了 console，新代码用 `log.info/debug/warn/error`。

### 背包槽位布局（**踩过大坑**）
`bot.inventory.slots` 的真实布局：

```
0–4    合成栏
5–8    护甲（头/胸/腿/脚）
9–35   主背包
36–44  快捷栏      ← inv.hotbarStart = 36
45     副手
```

曾经误以为是"0–8 快捷栏、36–44 护甲"，于是把快捷栏物品全过滤掉了——
**`inventory_summary` 一直缺东西，而且只在拿到物品后才看得出来**，
所有既有测试都没发现（它们查的是 `inventory.get`，走另一条路径）。
现在一律用 `inv.inventoryStart / inventoryEnd / hotbarStart` 判断，别再硬编码。

### 合成与窗口状态（**最难缠的一类坑，务必先读这条**）

mineflayer 的合成不是"告诉服务端我要做什么"，而是**手动点击格子 + 本地伪造产出**：

```js
window.updateSlot(0, new Item(recipe.result...))  // 本地"假设"产出格里有目标物品
await bot.putAway(0)                              // 把产出格 shift-click 进背包
```

它**信任自己的本地模型，而不是服务端算出来的结果**。而 1.17+ 服务端
**只在它认为客户端窗口状态过期时才回应点击——被忽略的点击没有任何回报**。
两者一叠加，症状就是"合成成功返回、背包里却没有东西"。

踩过的具体形态与对策：

| 症状 | 真因 | 对策 |
|---|---|---|
| 背包里出现莫名的 `oak_button`、工具消失 | 玩家自带的 **2×2 合成格是持久的**，关窗不清空。残留 1 块木板时服务端算出的产物是按钮，本地却以为在做镐子 | 每次合成前 `_clearCraftingGrid`（槽位 1–4） |
| 首次合成"没有产出"，重试就好 | 本地 stateId 落后，点击被静默忽略 | 用官方 `_syncWindow` 复位；**顺序必须是 同步 → 清格 → 再同步 → 合成**（清理本身也点击，会推进 stateId） |
| "任务完成"但背包里还没有 | 产出先落在窗口产出格/网格，稍后才回背包 | 合成后主动关窗 + 收敛等待 |
| 材料需求被放大几倍 | `need = 单批消耗 × 件数`，而 stick 一批出 4 个 | 按批数算 `ceil(件数 / 每批产出)` |

### 心跳不能干扰窗口事务

`_keepAliveTick` **只在真正空闲时**发（无任务、无打开的容器），且用裸 look 包。
早期用 `bot.look(yaw,pitch,force=true)` 无条件发送：它会改动本地实体状态，
插进容器窗口事务中间会扰动点击确认，导致合成随机失败（实测对照 3/5 vs 5/5）。
长时间静默（如等熔炼 43 秒）靠**客户端超时 180 秒**兜底，心跳并非必需。

### 性能：同步扫描会"冻结"整个引擎（**最容易忽视的一类问题**）

Node 是单线程的。任何同步耗时循环都会让引擎在这段时间里**收不到也回不了任何 RPC**——
用户感受到的是"她在干活时问不到状态、急停也没反应"，而不是"有点慢"。

实测踩过的坑与规律：

| 反模式 | 代价 | 正确做法 |
|---|---|---|
| 手写三重循环 + 逐格 `bot.blockAt` | 半径 48、17 层 → 16 万次调用 → **阻塞 20~28 秒** | 用 `bot.findBlocks({ matching: <方块ID数组> })`（能按 section 调色板跳过整段），或**由近到远扫描 + 提前退出** |
| 传**函数型** matcher 给 `findBlock` | 无法按调色板预筛，每段都要遍历 4096 格 | 传**方块 ID 数组**（`mcData.blocksByName[name].id`） |
| 把"整体超时"当成"单次搜索预算" | `thinkTimeout` 误设 30 秒 → A\* 搜索期间事件循环被占满 30 秒 | 两个配置分开：`pathThinkTimeoutMs`（搜索预算，默认 4 秒）与 `pathTimeoutMs`（允许走多久） |
| 算了没人用的数据 | `snapshot().block_scan` 无人消费，却每次快照烧 2.3 秒 | 先确认消费方再算；需要时走按需 RPC |

**排查手段**：`bot.js` 里有个 250ms 的循环延迟监控，阻塞超过 1.5 秒会告警
并附上"当时在跑的任务名"。定位这类问题**先看这条日志**，不要靠猜。
工具：`node tools/probe_responsiveness.js` 可复现并量化（长任务运行中逐轮测 RPC 延迟）。

### 错误翻译不要"猜"

`util.js` 的 `humanizeError` 曾经写成 `includes('timeout')` → 一切超时都被报成
"寻路超时"，还附带"拆成几段短距离移动"的建议。于是合成超时被当成寻路问题，
排查方向被彻底带偏。**判定条件必须限定在该错误真正的语义范围内**（例如寻路超时
要求消息里同时出现 `path`）。同理，别用 `includes('craft')` 去匹配窗口错误——
物品名 `crafting_table` 本身就含 `craft`。

### RCON 客户端（测试用）
`tools/lib/rcon.js` 是**进程内**实现，三个坑（都是实测出来的）：
1. 认证成功的响应是 `id=1/type=2`，**不是**标准文档说的 `type=3`；要按 `id === -1` 判失败
2. 认证后**不能立刻清空 pending**：命令响应可能在同一个 I/O 块里重入到达，会被当成无主响应丢掉
3. 响应可能分多包，要累积到 `type === 0` 的结束包再结算

不要用 `execFileSync` 拉 `tools/rcon.js` 子进程：受限环境下"捕获子进程输出"会被拒（EPERM），
报错看起来像 rcon 坏了，极难归因。

### 世界生成（超平坦）
1.20.1 上手写 `generator-settings` 的 JSON **不可靠**，会生成"基岩层与空气层混杂"的坏地形
（现象：机器人站在基岩上、寻路原地失败）。正确做法是只用 `level-type=flat` 的默认经典超平坦。


### 改文件一律用文件工具，不要用 shell 重写
本次开发中 `actions.js` 被 PowerShell 重写时损坏：Windows PowerShell 5.1 的
`Get-Content`/`Set-Content` 默认按 **GBK** 解码 UTF-8 文件，中文变乱码后
连模板字符串的结束符都被吃掉，语法直接碎裂；而且这种损坏**不可无损还原**
（不可映射的字节已被替换）。后果是不得不用文件工具整份重写该模块。

结论：编辑源文件用 `read` / `edit` / `write` 文件工具；shell 只用来跑构建与测试。
确实需要脚本处理文本时，用能显式指定 UTF-8 的方式（Node `fs.readFileSync(f,'utf8')`
或 Python `encoding='utf-8'`），且脚本本身不要包含非 ASCII 字符。

## 测试脚本一览

| 脚本 | 作用 | 需要什么 |
|---|---|---|
| `bot/tools/smoke.js` | 通道、错误处理、真进服、真寻路、真挖掘 | 加 `--connect` 才需要服务器 |
| `bot/tools/crafttest.js` | 合成链：木板→木棍→工具（含 3×3 工作台路径） | 服务器 + rcon |
| `bot/tools/minetest.js` | 挖矿闭环：造矿脉→挖矿→熔炼→做铁镐 | 服务器 + rcon |
| `bot/tools/survivaltest.js` | 真实生存链：砍树 → 工具 → 挖矿 | 服务器 |
| `bot/tools/skilltest.js` | 各技能专项（收集、建造、存货） | 服务器 |
| `bot/tools/diagnose.js` | 地形与寻路诊断，不做断言只打印事实 | 服务器 |
| `bot/tools/rcon.js` | 命令行发服务端指令（造测试场景用） | 服务器（且开了 rcon） |
| `bot/tools/soaktest.js` | 稳定性实测：长时间保持连接 + 周期性活动，统计断线次数 | 服务器 |
| `bot/tools/lib/rcon.js` | **进程内** RCON 客户端（测试脚本用） | — |
| `bot/tools/reset_world.js` | 重置测试世界；`--full` 连服务端目录一起重建 | — |
| `bot/tools/fix_server_props.js` | 修正 `server.properties` 里被转义的设置 | — |
| `bot/tools/setup_testserver.js` | 写入测试服配置 | — |
| `bot/tools/check_plugin.py` | 插件静态契约检查（docstring / 签名 / 元数据） | 无 |
| `bot/tools/test_plugin_load.py` | 按 AstrBot 的方式加载插件（命名空间包 + 相对导入） | AstrBot 的 python 与 app 目录 |
| `bot/tools/test_integration.py` | 真的拉起引擎子进程并走 RPC（含进程回收验证） | AstrBot 的 python |

> **跑测试前先重置世界**：这些测试会真的挖穿地形，连跑几轮后世界满是坑洞，
> 机器人会掉进自己挖的洞里，表现为"寻路失败、挖矿找不到目标"——
> 看起来像引擎退化，其实只是环境脏了。本次开发中因此误判过一次回归。
>
> ```powershell
> node tools/reset_world.js        # 重置世界（保留服务端目录）
> node tools/reset_world.js --full # 连服务端目录一起重建（世界生成配置被改坏时用）
> ```

跑法（在 `bot` 目录下）：

```powershell
node tools/smoke.js
node tools/smoke.js --connect

# 插件相关需要 AstrBot 自带的解释器
$env:PYTHONPATH = 'D:\AstrBot\backend\app'
D:\AstrBot\backend\python\python.exe tools\check_plugin.py
D:\AstrBot\backend\python\python.exe tools\test_plugin_load.py
$env:MC_TEST_CONNECT='1'; D:\AstrBot\backend\python\python.exe tools\test_integration.py
```

或者一把梭：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1 -Connect -ServerPort 25565
```

## 本地测试环境

`bot/tools/` 下的脚本假定可以起一个自己的 Paper 服务端。
`.testserver/` 是一个超平坦测试世界（bedrock + 2×dirt + grass），
用于排除地形干扰、专门验证寻路与建造。

造场景用 RCON：

```powershell
node tools/rcon.js --port 25576 --dir .testserver "time set day"
node tools/rcon.js --port 25576 --dir .testserver --cmd "give AstrBotSkill cobblestone 64"
```

需要在 `server.properties` 里开：

```properties
enable-rcon=true
rcon.port=25576
rcon.password=<自定义>
```
