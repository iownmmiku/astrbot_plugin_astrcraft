# AstrBot 接入 Minecraft —— 实施计划

> 目标：让 AstrBot 驱动的 Bot 以**真实游戏客户端**身份进入 Minecraft，具备原版玩家应有的移动、挖掘、合成、背包、战斗、进食、建造能力，并由 LLM 做高层决策、人格化聊天与长期目标推进。

## 1. 结论先行：为什么要换引擎

工作台已有 `astrbot_minecraft_project/astrbot_plugin_minecraft`（v0.3.0，约 6000 行纯 Python，
自研 `mcproto` 协议栈，仅支持 MC 1.20.1 / protocol 763）。它的架构从头就决定了它**不可能**像正常玩家，
实测代码证据如下：

| 现象 | 代码位置 | 后果 |
|---|---|---|
| 无物理模拟，靠"小步挪 + 服务器橡皮筋"移动 | `bot_client.py` `_move_direct()`：每包 0.22 格、`asyncio.sleep(MOVE_TICK)` | 服务器每次都要把玩家拉回，移动像幻灯片，反作弊易误判 |
| "跳跃"是按 0.42/0.33/0.26 三个包抬高 Y | `bot_client.py` `jump()` | 不是原版跳跃曲线，无重力、无落地判定 |
| 无区块数据，A\* 实际退化成直线 | `pathfinding.py`：`is_walkable()` 恒 `True`、`get_height()` 恒 `None` | 遇墙必卡，"绕过障碍物"是文档里的说法，不是行为 |
| 挖掘是固定 `sleep(0.15)` 后直接发 `DIG_FINISH` | `bot_client.py` `mine()` | 创造模式可秒破，**生存模式会被服务器拒绝或直接掉回** |
| 背包/合成/战斗/进食只有零散桩代码 | `bot_client.py` `craft_item()` / `eat_food()` / `attack_entity()` | 无法完成"砍树→做工作台→做木镐→挖矿"这条最基本的生存链 |
| 仅适配 1.20.1 | `PROTOCOL_VERSION = 763` | 换服务端版本就要重写协议表 |

**结论：协议层直接放弃，换成 `mineflayer`。** 它已经解决了上面全部问题：真实物理（`prismarine-physics`）、
区块解析、背包与容器、合成配方、实体追踪、成熟的 A\* 寻路（`mineflayer-pathfinder`），
并且跟随社区持续支持到 1.21.x。

已验证的本机环境（本次实测，非推测）：

- Node.js `v24.9.0`（`C:\Users\miku\AppData\Roaming\dsh-desktop\harness\.desktop-bin\node.cmd`）
- npm `11.16.0`；**默认缓存目录被沙箱拒绝写入**，必须 `--cache` 指到工作台内（已用 `D:\工作台\_npm_probe_cache` 实测通过）
- Java `25.0.2 LTS`（BellSoft Liberica，Paper 服务端够用）
- 可拉取版本：`mineflayer@4.39.0`、`minecraft-data@3.116.0`、`mineflayer-pathfinder@2.4.5`
- AstrBot 已装：`D:\AstrBot`（Desktop），数据目录 `C:\Users\miku\.astrbot`，插件目录 `data\plugins`
- 目标插件接口要求：`astrbot_version: ">=4.17,<5"`

## 2. 总体架构：双进程，职责分离

**核心决策：Minecraft 引擎跑在 Node 子进程，AstrBot 插件留在 Python。**

理由：AstrBot 是 Python 生态，`Star` 插件、`@filter.llm_tool`、Provider 调用都在 Python 侧；
而 mineflayer 只有 Node 实现。硬凑一边都会付出巨大代价。用进程边界换来两边都用原生生态，
代价只是一层薄协议——这层协议恰好也是未来换引擎（如 Java mod）时的替换点。

```
┌──────────────────────────── AstrBot 进程 (Python) ────────────────────────────┐
│  main.py            插件入口 / 配置 / 生命周期                                 │
│  llm_tools.py       @filter.llm_tool 注册表（约 26 个工具）                    │
│  commands.py        /mc 指令簇（起服/进服/状态/目标/急停）                      │
│  perception.py      结构化状态 → 紧凑自然语言简报（token 预算控制）             │
│  planner.py         目标 → 技能链；失败重规划；人格化措辞                       │
│  bridge_client.py   NDJSON over stdio 的 JSON-RPC 客户端（含超时/重连）        │
│  chat_bridge.py     游戏内聊天 ↔ AstrBot 会话双向桥                             │
│  server_manager.py  本地 Paper 服务端下载/起停（从旧插件移植）                  │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │ NDJSON：每行一个 JSON（请求 / 响应 / 事件）
                                    │ 插件→引擎：JSON-RPC 2.0 请求
                                    │ 引擎→插件：事件通知（notice）+ 主动请求（request）
┌───────────────────────────────────┴─────────────── Node 子进程（MC 引擎）─────┐
│  index.js           进程骨架、NDJSON 读写、RPC 分发                            │
│  bot.js             mineflayer 实例、进服/重连、事件总线                       │
│  state.js           状态快照 + 差分事件（血量/位置/背包/实体）                 │
│  actions.js         原子动作封装（move/dig/place/craft/equip/attack/use…）     │
│  skills/            复合技能：chop_tree / make_tools / mine_ores / shelter …    │
│  skills/* 统一接口：precheck() / step() / isDone() / abort()                   │
│  goals.js           引擎侧动作队列（优先级 + 抢占 + 取消）                     │
│  config.js          地址、账号、版本、路径、安全白名单                         │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 协议（NDJSON，一行一个 JSON）

插件 → 引擎的 RPC 方法：

| 分类 | 方法 |
|---|---|
| 连接 | `connect` `disconnect` `status` `version` |
| 感知 | `state.get` `block.scan` `entity.scan` `inventory.get` |
| 动作 | `move.to` `move.follow` `move.stop` `dig` `place` `craft` `smelt` `equip` `attack` `use` `look` `drop` |
| 交互 | `container.open` `container.deposit` `container.withdraw` `player.use` `villager.trade` |
| 技能 | `skill.run`（返回 task_id）、`task.status`、`task.cancel` |
| 社交 | `chat.say` |
| 事件 | `events.subscribe` |

引擎 → 插件的事件通知：`bot.spawn` `bot.death` `bot.hurt` `bot.kicked` `bot.disconnect`
`chat`（玩家发言）`chat.whisper` `entity.near` `task.finished`

**关键设计：`task_id` 异步模型。** 任何可能超过 2 秒的动作都不阻塞 RPC：
`skill.run` 立刻返回 `task_id`，插件侧可以查询或取消。这是把旧插件里
"异步队列 + action_id"的思路保留下来、但放到更正确的位置。

### 2.2 感知层：把世界讲给 LLM

`state.get(detail="normal")` 返回结构化 JSON；`perception.py` 再把它压成一段简报：

```
位置 (128, 64, -340) 主世界 | 生命 20/20 | 饱食 18/20 | 无负面效果
手持 铁镐 | 主手耐久 40% | 护甲 铁胸甲/铁靴
背包 32 格已用 11 | 原木×12 圆石×48 铁锭×3 煤炭×16 熟牛排×4
脚下 草方块 | 光照 12 | 时间 白天 (tick 3200)
附近 16 格：僵尸 ×2 距离 9/14 | 牛 ×3 距离 6-11 | 玩家 张三 距离 22
目标 挖 10 个铁矿 | 进度 4/10 | 当前动作 正在走向 (133,60,-352)
```

**Token 预算控制**（这是最容易翻车的地方）：

- 简报硬上限约 800 字符；`block.scan` 只列白名单物品（矿物/原木/工作台/熔炉/箱子），半径默认 16 格
- **事件驱动，不做全量轮询**：只在"状态有意义地变了"时推送（位置变化 >8 格、血量变、背包变、实体进入/离开 16 格）
- 高频事件合并：`entity.near` 100ms 去抖，避免刷屏烧 token
- 空闲时心跳降频到 30 秒，有活跃任务时 3 秒

### 2.3 LLM 工具设计：给"意图"，不给"坐标"

旧插件最大的体验问题是让 LLM 直接吐坐标（`mc_move(100, 200)`），LLM 既不知道那里有什么，
也不知道怎么走。新工具分层，**鼓励高层、允许底层**：

感知层（3）
`mc_status` `mc_inventory` `mc_scan`（找附近指定方块/实体）

动作层（9）
`mc_goto`（走/跟过去，返回 task_id）· `mc_mine_block` · `mc_place_block` · `mc_craft`
`mc_smelt` · `mc_equip` · `mc_attack` · `mc_eat` · `mc_drop`
`mc_use_block`（箱子/门/按钮）· `mc_use_on_player`（给东西/交易）· `mc_say` · `mc_stop`

技能层（8，真正"像玩家"的部分）
`mc_chop_tree(n)` · `mc_make_tools(tier)` · `mc_mine_ores(ore,count)` · `mc_collect(item,count)`
`mc_smelt_ores` · `mc_build_shelter` · `mc_store_items` · `mc_cook_food`

自主层（7）
`mc_set_goal(text)`（自然语言长期目标）· `mc_goal_status` · `mc_goal_pause` · `mc_goal_resume`
`mc_skill_status(task_id)` · `mc_cancel(task_id)` · `mc_auto_mode(on/off)`（是否允许自主行动）

**防"智障循环"的三条硬规矩：**

1. 长动作返回 `task_id`，工具描述明确写"立刻返回，用 `mc_skill_status` 查进度"，绝不让 LLM 空等
2. `mc_do(goal)` 高阶入口：LLM 说"去弄点木头"，由 `planner.py` 翻译成技能链，**LLM 不需要自己拆解到方块级**
3. 失败必带原因与当前处境（"去 (133,60,-352) 失败：目标上方是水，无法站立"），让 LLM 能换策略而不是重复同一调用

### 2.4 自主性：三层驱动 + 统一抢占

| 层 | 触发 | 是否经 LLM | 例子 |
|---|---|---|---|
| 反射层 | 毫秒级威胁 | **否**，纯本地规则 | 低血量后撤、溺水浮起、着火找水、被岩浆逼近、吃饱不再吃 |
| 生存层 | 5 秒循环 | 是（低频） | 目标进展评估、失败后重规划、夜间找庇护所、工具坏了重做 |
| 社交层 | 收到聊天/@ | 是（带人格） | 用人格回话、被要求帮忙时接受或婉拒、报告自己正在干什么 |

三层共享**单一优先级动作队列**，高优先级可抢占低优先级（反射层最高）。
被抢占的任务回到队列头而不是被丢弃——这点旧插件的 `action_queue.py` 已经做对了，直接沿用思路。

### 2.5 安全与边界（必须写进代码，不能只写文档）

- 离线（非正版）账号，**仅能进 `online-mode=false` 的服务器**；正版服需另做 Microsoft 账号认证（见 §8）
- `online-mode=false` 的服务器必须开启 `enforce-secure-profile=false`，否则 1.19+ 会因签名问题踢人
- 工具**默认白名单制**，不下发 `dig` 类指令给受保护方块（领地插件覆盖时直接返回"无权限"，不重试）
- 反作弊（NCP/Grim/Vulcan）可能因 bot 的移动模式误判 → 支持 `--slow-mode`（降速 + 更保守的寻路）
- 紧急停止：`/mc急停` 一个指令切断所有动作 + 停止自主层，且 LLM 工具侧同步失效
- 权限：只有 AstrBot `ADMIN` 能改目标/开关自主模式；普通会话成员只能查询和聊天

## 3. 目录结构

```
D:\工作台\mc-astrbot\
├─ PLAN.md                     ← 本文件
├─ README.md                   部署与使用
├─ plugin\                     AstrBot 插件（Python）
│  ├─ metadata.yaml            astrbot_version: ">=4.17,<5"
│  ├─ _conf_schema.json        配置项定义（AstrBot 只读这个文件）
│  ├─ main.py                  入口 / 生命周期 / 指令
│  ├─ llm_tools.py             LLM 工具注册
│  ├─ perception.py            状态 → 简报
│  ├─ planner.py               目标 → 技能链
│  ├─ bridge_client.py         NDJSON RPC 客户端
│  ├─ chat_bridge.py           聊天双向桥
│  ├─ server_manager.py        本地 Paper 起停
│  └─ requirements.txt
├─ bot\                        MC 引擎（Node）
│  ├─ package.json             mineflayer 4.39.0 / minecraft-data 3.116.0 / mineflayer-pathfinder 2.4.5
│  ├─ index.js  bot.js  state.js  actions.js  goals.js  config.js
│  ├─ skills\                  chop_tree.js / make_tools.js / mine_ores.js / shelter.js / smelt.js / store.js
│  └─ tools\                   离线测试用假引擎（不连真实服务端）
├─ config\
│  └─ bot.config.json          地址 / 账号 / 版本 / 安全白名单
├─ scripts\
│  ├─ install.ps1              装依赖（复用工作台内 npm cache）
│  ├─ dev.ps1                  同时起引擎与 AstrBot 并跟踪日志
│  └─ probe_engine.ps1         冒烟测试：进本地 Paper，报位置
└─ docs\
   ├─ ACCEPTANCE.md            验收清单（§7 的可勾选版）
   └─ LIMITS.md                能力对照表：哪些真能像玩家、哪些不能
```

## 4. 里程碑

每阶段都有"能观测到的成功标准"，避免自我感觉良好。旧 Python 版的问题就是文档写了 44 个单测
通过，但真实生存能力为零——**所以每个里程碑都以"真连服务器跑一遍"为验收，不以单测为验收**。

### M0 · 骨架与通道（预计 0.5–1 个工作会话）
交付：目录结构、依赖装好、NDJSON 协议 + 双端连通、`/mc状态` 能显示引擎在线。
验收：引擎能 spawn，`status` 往返正常，引擎崩溃时插件不卡死（超时 + 明确报错）。
风险：npm 缓存权限（已实测解法）；Node 路径在 AstrBot 进程里可能取不到 → 走配置项 `node_path`。

### M1 · 真进服 + 真移动（1 个会话）
交付：mineflayer 连本地 Paper 1.20.1，注入 `mineflayer-pathfinder`，`mc_goto` 可走向任意坐标。
验收（**关键**，与旧版的核心分野）：
- 走过 1 格台阶、绕过 2 格高的墙、不穿墙、不掉坑
- 走到 (x,z) 误差 < 1 格，中途被推挤后能自己找回路径
- 从 4 格高处跳下能正常落地而不是"浮空"
- 手动挖掉它脚下的方块，它会掉落而不是悬停
（旧版这四条全部不通过——这就是换引擎的意义）

### M2 · 生存闭环（1.5–2 个会话）
交付：`dig` / `place` / `craft` / `smelt` / `equip` / `eat` / `attack` + 背包与容器操作。
验收：从空手出生点开始，**全自动**完成这条链：
砍树 → 木板 → 工作台 → 木镐 → 挖石头 → 石镐 → 挖铁 → 熔炉 → 烧铁锭 → 铁镐
且过程中：挖掘耗时随工具正确变化、被怪打会反击或撤退、饿了会吃、工具坏了会重做。

### M3 · 感知与工具层（1 个会话）
交付：`state.js` 差分事件、`perception.py` 简报、约 26 个 LLM 工具注册、`mc_do` 高阶入口。
验收：在 QQ 群说「去帮我弄点木头回来」，Bot 真的去砍树并把原木放进箱子；
单次工具调用往返 < 100ms；连续 30 分钟对话不出现 token 爆炸（简报长度稳定在预算内）。

### M4 · 自主性与人格（1.5 个会话）
交付：三层驱动循环、`planner.py` 目标→技能链、失败重规划、人格化表达（复用旧插件 `persona.py` 思路）。
验收：给一句「我要在这里安家」，Bot 自主选点、砍树、造一个 3×3 有门有火把的庇护所并入住；
夜里会躲在里面而不是在野外被怪打死；被打断后会主动说明"刚才在忙什么"。

### M5 · 加固与交付（1 个会话）
交付：断线重连与死亡重生恢复、任务中断/取消清理、反作弊 `slow-mode`、`/mc急停`、
`ACCEPTANCE.md`、`LIMITS.md`、`README.md`、依赖锁定（`package-lock.json`）。
验收：手动 kill 引擎 → 插件自动重启并恢复目标；`/mc急停` 后所有动作在 1 秒内停止且 LLM 无法再驱动。

## 5. 关键技术风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 服务端版本与 mineflayer 支持版本不匹配 | 进不去服 | 配置项固定 `version`，不用自动探测；M1 先用 1.20.1 打通，再逐版本回归 |
| 寻路在大范围/复杂地形下超时或抖 | 卡死 | `Movements` 限制（禁止挖/放的可配置开关）、路径超时降级为分段 goto、连续失败 3 次上报给 LLM 换策略 |
| 服务器反作弊踢人 | 完全不可用 | `slow-mode`；优先在自建 Paper 上验证；`LIMITS.md` 明确写清不支持的反作弊环境 |
| 坐标换算错一格（MC 方块中心是 +0.5，pathfinder 目标也要 +0.5） | 挖不到/放不上 | 统一坐标工具函数，禁止裸算；这类 off-by-one 是旧插件最容易反复出错的地方 |
| LLM 反复调用同一失败动作 | 烧钱 + 卡住 | 工具层记录"同一动作同参数连续失败 ≥2 次"直接返回拒绝并附替代建议 |
| 抓包/日志里泄露账号与服务器地址 | 隐私 | 日志脱敏；`config/` 加 `.gitignore`；离线账号也当敏感信息处理 |

## 6. 从旧插件直接复用什么

不是全盘抛弃，以下模块的**思路**值得移植（实现要重写以适配新架构）：

- `action_queue.py` → 升级为 `goals.js` + 插件侧 task_id 双端队列模型
- `goal_system_v2.py` → `planner.py` 的目标状态机骨架
- `persona.py` → 人格提示词构建与 AstrBot Provider 人格读取（这部分与引擎无关，接近原样可用）
- `server_manager.py` → 本地 Paper 下载/起停/崩溃重启
- `launcher_api_client.py` → 启动器 API 联动（保留远程部署能力）
- `chat_bridge.py` → 聊天双向桥

其余（`bot_client.py` 的协议栈 2073 行、`pathfinding.py`）**确认废弃**。

## 7. 端到端验收清单

- [ ] Bot 进自建 Paper 1.20.1，在游戏内 `/list` 里是一个正常在线玩家
- [ ] 走、跳、上下台阶、绕障碍、跳过 1 格沟，动作观感与原版玩家一致
- [ ] 空手全自动完成「木头 → 石器 → 铁器」工具链
- [ ] 能用箱子存取物品，能熔炼，能装备护甲与工具
- [ ] 会主动进食、低血量撤退、夜晚回避危险
- [ ] 在 QQ 群用自然语言下达「去挖 10 个铁矿」并能自主完成
- [ ] 给一个长期目标后，被打断、失败、死亡后仍能继续推进
- [ ] 游戏内聊天能用人格接话，QQ 与游戏内消息双向互通
- [ ] `/mc急停` 立即生效；kill 引擎后能自愈
- [ ] 连续运行 2 小时无内存泄漏、无 token 爆炸

## 8. 明确不做 / 需要你另做决定的

- **正版（Microsoft 账号）登录**：mineflayer 需要 `prismarine-auth`，涉及设备码授权与账号安全。
  默认走离线账号。要接正版服请单独说，我会把它作为一个独立小阶段（含 token 缓存与失效重认证）。
- **Forge / Fabric 模组服**：本次不做。如需，需要另做协议握手与模组注册表适配评估。
- **视觉/截图理解**：不做。用结构化状态而不是图像，成本低得多也准得多。
- **多 Bot 协同、跨服迁移、红石精密操作**：不在一期范围。
- **旧插件去留**：按你的决定，"新建 mineflayer 版，旧版留着不用"。旧目录 `astrbot_minecraft_project`
  我一个字都不动；若哪天要清理，单独确认。
