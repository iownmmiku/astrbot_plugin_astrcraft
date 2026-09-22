# 安装与部署

## 架构回顾

```
AstrBot（Python 插件）  ──NDJSON/JSON-RPC──▶  Node 引擎子进程  ──▶  Minecraft 服务器
   仓库根目录（*.py）                            engine/              Paper / Vanilla
```

两半都必须装好：Python 侧是 AstrBot 插件，Node 侧是游戏引擎。

> **目录说明**：仓库根目录**就是**插件本体（`main.py` / `life.py` / `advisor.py` /
> `llm_tools_*.py` / `_conf_schema.json` / `metadata.yaml` / `skills_docs/`），
> 引擎在 `engine/`，开发工具与测试在 `dev-tools/`。
> 早期文档写的 `plugin/` 与 `bot/` 两个子目录**从来就不存在**，照着做会直接装不上。

---

## 1. 前置要求

| 组件 | 版本 | 说明 |
|---|---|---|
| AstrBot | >= 4.17, < 5 | 插件 API 依赖 `@filter.llm_tool` 与 `context.llm_generate` |
| Node.js | >= 18（推荐 20/22/24） | 引擎运行环境。**必须能被 AstrBot 进程找到**，找不到就在配置里填绝对路径 |
| Java | >= 17 | 只有需要跑本地 Minecraft 服务端时才需要；连接别人的服务器不需要 |
| Minecraft 服务端 | 原版 / Paper / Spigot | **不支持 Forge/Fabric 模组服**（原因见 LIMITS.md） |

---

## 2. 安装 Node 引擎

```powershell
cd <项目目录>\engine

# 关键：npm 的默认缓存目录可能被系统策略拒绝写入，
# 这时必须把缓存指到一个你有权限的目录（下面用项目内的 _npm_cache）
npm install --cache "..\_npm_cache" --no-audit --no-fund
```

装完确认这三个包在 `engine\node_modules` 下：

```
mineflayer@4.39.0
minecraft-data@3.116.0
mineflayer-pathfinder@2.4.5
```

**验证引擎能独立启动**（不依赖 AstrBot）：

```powershell
node dev-tools\smoke.js
```

应该看到 `通过 N 项，失败 0 项`。如果这里就失败，先解决引擎问题，不要往下走。

---

## 3. 安装 AstrBot 插件

把仓库根目录里的文件复制到 AstrBot 插件目录下的一个新文件夹里：

```powershell
$dst = "$env:USERPROFILE\.astrbot\data\plugins\astrbot_plugin_astrcraft"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item *.py, _conf_schema.json, metadata.yaml $dst -Force
Copy-Item skills_docs $dst -Recurse -Force
```

然后在 AstrBot WebUI → 插件管理 → 找到「Minecraft 机器人（真实客户端）」→ 启用。

> **为什么叫 `astrbot_plugin_astrcraft` 而不是别的名字**：
> AstrBot 用**目录名**生成插件配置文件名（`<目录名>_config.json`）与数据目录。
> 如果你机器上还留着早期那版纯 Python 协议插件（特征是含有 `bot_client.py`），
> 两者同名会**互相覆盖配置**。用一个新名字可以让新旧两版干净共存——旧的那版留着不用即可。

### 如果插件不在项目目录内

`main.py` 按下面的顺序找引擎目录：

1. 配置里的 `engine_dir`（绝对路径）
2. 插件目录下的 `engine/` —— **开发时的仓库布局走的就是这一条**
   （仓库根目录就是插件目录，所以 `<repo>/engine` 直接命中）
3. 旧布局兜底：插件目录的**同级 / 上一级 / 上两级 / 自身**下的 `bot/`
   （历史遗留，只有在你还保留着早期 `bot/` 目录时才会命中）

所以最简单可靠的做法是：**在插件配置里把 `engine_dir` 填成引擎目录的绝对路径**，
例如 `D:\工作台\Astrcraft\engine`。这样无论插件被复制到哪里都能找到引擎。

---

## 4. 配置

AstrBot WebUI → 插件管理 → Minecraft 机器人 → 配置。

### 连接别人的服务器（最常见）

| 配置项 | 填什么 |
|---|---|
| `server_host` | 服务器地址 |
| `server_port` | 端口（默认 25565） |
| `mc_version` | **必须与服务端一致**，例如 `1.20.1`（不自动探测，填错会卡在登录阶段） |
| `bot_username` | 机器人游戏内名字（1–16 字符，离线账号可随意取） |
| `auth_method` | `offline` |
| `auto_connect` | `true`（插件加载后自动进服） |
| `engine_dir` | 引擎目录绝对路径（仅当插件与引擎不在一起时） |

> **服务端要求**：`online-mode=false`。正版验证开启的服务器需要改 `auth_method=microsoft`
> 并额外配置 `prismarine-auth`，见文末。
>
> 1.19+ 的服务端还需要 `enforce-secure-profile=false`，否则离线账号会因聊天签名问题被踢。

### 本地自建服务器

先手动准备一个 Paper 服务端（或复用已有的），把 `server_host` 指向 `127.0.0.1`。
本插件**不负责**下载和启动服务端——那属于服务器运维，不属于"让机器人像玩家一样游玩"。

---

## 5. 验证清单

按顺序做，每步都要真的通过再往下：

1. `node dev-tools\smoke.js` → 通道与错误处理全绿
2. `node dev-tools\smoke.js --connect`（需要服务器在跑）→ 进服、寻路、挖掘全绿
3. AstrBot 里 `/mc状态` → 显示"引擎：运行中"与"游戏：已连接"
4. AstrBot 里 `/mc订阅`，然后游戏里说句话 → QQ/TG 收到转发
5. AstrBot 里让 LLM 调用 `mc_status` → 返回真实位置与背包
6. AstrBot 里 `/mc目标 砍 8 根木头` → 机器人真的去砍树，`/mc进度` 能看到逐步推进

---

## 6. 排障

| 现象 | 原因与处理 |
|---|---|
| `/mc状态` 显示"引擎未运行" | 先看 AstrBot 日志里的报错。多半是 `engine_dir` 不对或没装 Node 依赖 |
| 报"找不到 node 可执行文件" | 在插件配置里填 `node_path`，例如 `C:\Program Files\nodejs\node.exe` |
| 进服后立刻被踢，提示需要正版验证 | 服务端 `online-mode=true`。改服务端或改用 `auth_method=microsoft` |
| 进服报"协议版本不匹配" | `mc_version` 与服务端不一致 |
| 机器人原地不动、寻路总是失败 | 看 AstrBot 日志里的具体原因。常见是出生在树上/水里（引擎会自己下树）、或被完全封死 |
| 在树冠/屋顶上卡住 | 引擎会主动破叶子下到地面；如果一直失败会在日志里写"下降 N 格后仍未到地面" |
| 挖了方块但背包没东西 | 检查该方块是否需要特定工具（石头要镐）。工具不够时引擎会明确说"需要一把镐" |
| 被反作弊踢 | 打开 `slow_mode`：移动降速、关闭跑酷，动作更保守 |
| 机器人被人打了不还手 | `auto_defend` 是否开启；默认开 |
| 机器人乱挖别人的建筑 | 配置 `dig_blacklist`（禁止挖的方块）与 `spawn_protection_radius`（出生点保护半径） |
| LLM 不调用工具 | 确认 AstrBot 里的模型支持 function calling；插件已把工具注册到全局，任何会话都能调用 |

排障时最有用的一条指令是 `/mc调试`：它会打印引擎状态、当前任务队列、最近任务与最近事件。

---

## 7. 正版账号登录（可选，未默认启用）

离线账号只能进 `online-mode=false` 的服务器。要进正版服需要：

1. `engine` 目录里额外安装认证库：
   ```powershell
   npm install prismarine-auth --cache "..\_npm_cache"
   ```
2. 在 `engine/config/bot.config.json` 里加：
   ```json
   {
     "auth": "microsoft",
     "profilesFolder": "config/auth-cache",
     "microsoftEmail": "你的邮箱"
   }
   ```
3. 插件配置里 `auth_method` 改成 `microsoft`。
4. 首次启动时终端会要求访问一个设备码登录链接，登录一次即可，凭据会缓存在
   `engine/config/auth-cache`。**该目录含登录凭据，不要提交到版本库。**

> 注意：这条路径没有在本次交付里做过端到端验证，属于"按官方文档配置可用"的状态。
