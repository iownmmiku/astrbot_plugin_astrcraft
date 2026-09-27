# 真实感审计（思考时间 + 任务安排）

> 本文件是「更短思考 / 更真实安排」两轮改进的**证据台账**。
> 每条结论都标了出处（文件:行 / 测试名 / 实测数字）；**测不了的明确写「未验证」**。
> 最后修改：见 git log（commit「感知循环 3→2 轮…」「基线实测…」两轮）。

## 维度①：思考时间 = 轮数 × 每轮耗时（本地渲染不是成本）

### 实测基线（test_life 驱动 decide ×3，钩 astrbot logger 抓到）

```
决策上下文分层：system 1717 字（静态，可缓存）
               ｜ user 424~425 字（状态46 打算90 顾问89 记忆103 技能60 …）
               ｜ 装配 0~1 ms
```

- **结论 A：提示词瘦身不是杠杆** —— 才 ~2.1k 字、装配 1ms 内。
- **结论 B：`life_min_decide_gap=6` 已无处强制** —— 只剩赋值（`life.py:219`），
  主循环的 gap 等待已拆（`test_never_idle` 断言源码里没有 `gap = self._min_decide_gap`）。
- **结论 C：思考时间 = LLM 往返次数 × 10~30 秒/次**（`life.py` 注释自证；
  每次往返的 payload ≈ system 1717 + 工具表 13228（见 `audit_latency.py`）+ user ~424 字）。

### 往返次数账本（本轮压的就是它）

| 路径 | 上限 | 说明 |
|---|---|---|
| 计划续跑（W7，`life.py` 计划优先） | **0 次** | 有计划就直接执行、不调模型 |
| 感知 decide（无计划时） | **4 → 3 次** | `max_steps 3→2` + 尾部 1 次强制结语 |
| 行动 agent（首选路） | 6 次 | `MAX_STEPS==6` 被 `test_action_agent` 锁死，**不碰** |

守门测试：`dev-tools/test_perception_rounds.py`（4 项）——
默认上限=2 / 直答 1 次 / 查后作答 2 次 / 最坏 `max_steps+1=3`。

### 事件驱动（已存在，无需改）

- `task.finished → life.wake()`（`main.py:_on_task_finished`）→ 循环
  `wait_for(wake, timeout=decide_interval)` —— 任务结束**立刻**想下一件。
- `mc_plan_do` 计划在 decide 尾部 `parse_decision` 装填（`life.py` 待办计划字段注释）。

### 未验证（本环境无真实 LLM / 无 AstrBot 运行日志）

- 真实模型延迟（秒/次）、思考间隔中位数的端到端数值 —— **未验证**。
  结构性下限 = 唤醒(ms) + 0~3 次往返；真实值需带 LLM 的实测环境。

## 维度②：真人特征清单（逐条核对，绿测试 = 证据）

| 特征 | 机制 | 证据 |
|---|---|---|
| 有始有终 | 引擎抢占三闸：`minOccupancyMs=1500` / `preemptCooldownMs=2000` / `maxPreemptsPerTask=5`（`engine/goals.js:185-247`）+ 计划不改主意（计划优先）+ todo 清单划账 | `test_task_preempt`(23/0)、`test_agent_plan`(20/0) |
| 成串干活 | `static_rules` 明写：**3~5 步有序、依赖顺序（砍树→做工具）、"中间不会再来问你"**；follow-up 接力、inbox 合流 | `test_agent_plan`(20/0)、README L31 |
| 节奏感 | 驱动力 tick（`life.py:695`）、生存顾问拿饥饿/夜晚（`life.py:168`）、sleep 技能；执行靠 LLM 权衡（设计如此："决定权在你"） | `test_life_rhythm`(23/0)、`test_life`(33/0) |
| 动作间微停顿 | **动作内**微停顿充足（引擎各技能 `delay(200~300ms)`）；`humanize` = 平滑视角/闲时环顾/自然错误文案，可配置开关 | `test_humanize`(7/0) |

### 评估后**不做**的（带理由）

- **任务之间加人工微延迟**：与"更短思考"目标相悖 —— 用户抱怨的本来就是长间隔；
  计划路径已是毫秒级续跑，人为加 300ms 级停顿是倒退。
- **压缩工具表（13228 字）按需发送**：会打碎前缀缓存，收益依赖 provider 行为，
  无本地可验的收益 —— **未验证，暂不动**（`audit_latency.py` 已把它列为候选）。

## 审计产出的固定资产

- `dev-tools/audit_latency.py`：往返轮数/提示词/工具表的一站式账本（本来就有的工具，本轮复跑取数）。
- `decide()` 的「决策上下文分层…装配 N ms」**INFO 级**日志（原 debug 没人看得见）——
  以后任何"她怎么又在想"的问题，先看这一行。
