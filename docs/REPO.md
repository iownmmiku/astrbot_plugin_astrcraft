# 仓库约定：**只有这一个真源**

## 结论

**`Astrcraft`（本仓库）是唯一的真源。** 所有改动只在这里做。

历史上还有一个"开发仓库"（布局是 `bot/` + `plugin/`，而这里是 `engine/` + 根目录 `.py`），
**它已经退休了** —— 见下面的证据。

---

## 为什么合并（而不是继续同步）

两个仓库**布局不同**，靠人肉 `Copy-Item` 映射同步：
`bot/` → `engine/`、`plugin/` → 根目录。

这个做法在**一次会话里出了三次事故**：

**① 覆盖了未提交的改动**
   一次 `Copy-Item movement.js` 把对方未提交的 `pathThinkTimeoutMs` 改动盖掉了。
   靠**事先存的补丁**才救回来 —— 那次是运气好。

**② 覆盖了路径适配**
   `check_capabilities.py` 在两个仓库里的路径定义不同（`plugin/` vs 根目录）。
   直接拷过去之后，它报「**一个工具都没扫到——检查器自己坏了**」。

**③ 过期副本导致误判**
   `test_bid.js` 在两处各有一份、一处改了另一处不知道。
   结果**同一个测试在两个仓库里一个红一个绿** ——
   我据此判断"对方的 `goals.js` 打破了抢占"，**查了一整轮才发现是过期副本**。

**共同点**：这三件事**都不报错、不崩溃**，只是在某个时刻让你的改动
**静默消失**，或者让你**基于错误的前提调试**。

> 其他工程问题会让人**变慢**；只有这个问题会让人**丢东西**。

---

## 证据：为什么说开发仓库已经落后

比对两个仓库的 73 个对应文件：

```
✅ 完全一致:      33
⚠️  内容不同:      40
❌ 公开仓库里没有:  0
```

那 40 个不同的，**没有一个**是"开发仓库更新"——
它们要么是**路径适配差异**（`engine/` vs `bot/`），
要么是**只在公开仓库里做过的改动**（另一轮对话的引擎改动、
以及后续所有修复）。

**也就是说：公开仓库是超集。** 开发仓库里的东西，这里都有。

---

## 那开发仓库怎么办

**没有删。** 它还在 `D:\工作台\mc-astrbot`，里面的 `node_modules` 和
`.testserver` 还在被测试用（通过目录联接）。

**建议**：
1. **别再往里写代码** —— 改了这里就够了
2. 等确认一段时间没问题之后，再决定要不要把它变成这里的一个 clone
   （`git clone Astrcraft mc-astrbot`），或者直接删掉
3. **在删掉之前，别再做"同步"这个动作** —— 那正是出事故的来源

---

## 测试环境怎么接（不用拷代码）

公开仓库里跑测试需要两样东西，都可以用**目录联接**指过去，**不用拷代码**：

```cmd
:: 测试服（server.jar 和世界数据）
mklink /J "Astrcraft\.testserver" "D:\工作台\mc-astrbot\bot\.testserver"

:: 引擎依赖（770 MB，不用重下）
mklink /J "Astrcraft\engine\node_modules" "D:\工作台\mc-astrbot\bot\node_modules"

:: 根目录的（少数测试从根 require mineflayer）
mklink /J "Astrcraft\node_modules" "D:\工作台\mc-astrbot\bot\node_modules"
```

> **注意**：`dev-tools` 里的测试用的是**相对路径** `.testserver`，
> 所以必须**从仓库根跑**（`node dev-tools/xxx.js`），从 `dev-tools/` 里跑会找不到。

---

## 路径与导入约定（改脚本前先读）

这个仓库的布局是：

```
Astrcraft/                 ← 仓库根**就是插件本体**
├── *.py                   ← 插件（AstrBot 直接读根目录）
├── skills_docs/*.md
├── engine/                ← Node 引擎
│   ├── *.js
│   ├── skills/*.js
│   └── node_modules/      ← 自己 npm install
└── dev-tools/             ← 检查器与测试
    ├── _paths.py          ← **统一在这里解析路径**
    └── run_all.py         ← 一条命令跑全部检查
```

**Python 脚本**：用 `dev-tools/_paths.py` 拿路径，别自己拼 `parents[N]`：

```python
import _paths
_paths.load_plugin()                       # 加载插件包（life.py 用的是相对导入）
life = _paths.plugin_module("life")        # 拿 life 模块
src = _paths.REPO / "life.py"              # 静态读源码
```

**JS 脚本**：从仓库根跑，`require` 用 `path.join(__dirname, '..', 'engine', 'xxx')`。

---

## 一句话

**这个文件存在的意义是：让"该改哪里"不再是一个需要判断的问题。**
只有一个仓库，就没有"同步"这个动作，也就没有那三类事故。
