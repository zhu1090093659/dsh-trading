# RiskGate：两套不相交的词汇与「标的级事件不得改 desk 档位」的可机检断言

日期：2026-10-01 · 阶段：P3 步骤 2 · 卡片：317a623f · 包：`@dshtrading/tradectl/risk-gate`

## 事实

- **两套不得相交的词汇**：价格侧 `alignment ∈ {aligned, unaligned, stale}`（这只标的的价格可不可信）、desk 侧 `level ∈ {normal, caution, reduce_only, halt}`（整个 desk 的档位）。`assertVocabulariesDisjoint()` 在启动/测试里直接求交集，写错词汇表立刻红。
- **合取判定**：`openRiskAllowedFor` = (`level ∈ {normal, caution}`) && (`alignment === aligned`)；另有淘汰窗口与 halt/reduce_only 的短路拒绝。
- **可机检断言（进 CI）**：`∀ 标的级事件 e：level_after(e) == level_before(e)` —— 落在两处：reducer 的 symbol 分支**根本不碰 level**，以及测试里穷举"所有标的级事件 × 所有 desk 档位"。同时反向断言"desk 级事件确实会改 level"，避免这条断言变成空转。
- **halt 自动不可达**：唯一能产出 halt 的事件是 `out-of-band-halt`；测试穷举所有自动事件，任何一步都不是 halt。
- **venue 能力即 halt 的前提**：`applyRiskEvent(..., { protectiveOrdersAtVenue: false })` 遇到带外 halt 请求时**降级为 reduce_only**、note 写明 `venue admission condition unmet`、并 `escalateToHuman: true`（§13 #25 的落点）。
- **自愈不闩锁 + 显式淘汰策略**：标的 stale 时只有它被拒，其它标的照常；`eliminationPolicy` 淘汰肇事标的（带 30 分钟期限）而 **desk 档位保持 normal** —— 单标的不得 DoS 整个 desk；到期后自动恢复。
- **升级到人**：`shouldEscalate` 在 reduce_only/halt 持续超过 10 分钟后为真（注入时钟）。

## 词汇合并（本轮顺手清掉的一处隐患）

P2 的 `degradation.ts` 里我自己定义了 `RiskMode = normal | reduce_only | halt`，而 P3 卡片要求的是 `alignment × level` 两套词汇。两套并行词汇迟早会出现"同一个词两个含义"的事故，所以本轮把 `RiskMode` 改成 `DeskLevel` 的**别名**（`import type { DeskLevel } from ./risk-gate.ts`）——一个事实只有一个家：desk 档位的定义在 risk-gate.ts。P2 的 15 例降级测试全部照旧通过（它们的断言只用到 normal/reduce_only/halt 三个值）。

## 测试（9 例新增，tradectl 累计 73 例全绿）

标的级事件 × desk 档位穷举的 level 不变断言（含反向非空转断言）、词汇交集为空、四档 × 三 alignment 的真值表、自动事件永不 halt、无 OCO 时 halt 降级 reduce_only 且标准入条件、edge kill 接线成 halt、标的恢复自愈、淘汰策略不牵连 desk 且到期恢复、阈值升级到人。纯函数 + 注入时钟，无 mock 无 sleep。

## 未验证项（如实标注）

- **淘汰策略的触发条件（"desk 预算/热度触顶"）由调用方判定**：本模块只提供 `eliminationPolicy` 这个动作，判定逻辑属后续步骤（触发与扇出）。
- **halt 是否可用取决于 venue 能力，而目标 venue 尚未核实**：代码已经两条路都实现（有保护 ⇒ halt；无保护 ⇒ reduce_only + 准入条件），但"我们的 venue 到底是哪一种"仍待人工确认。
- `caution` 档位的**具体判据**（什么时候该从 normal 进 caution）卡片未给，本轮只保证它是"允许开仓"的一档；判据属后续步骤。

## 被否决的方案

- **把标的级问题写进 desk level**：单标的行情抖动就能拉垮整个 desk（#24 明令禁止）。
- **淘汰 = 永久拉黑**：没有期限的淘汰会让一次瞬时故障变成永久损失；改 Token 期限 + 自动恢复。
- **保留两套风险词汇（RiskMode 与 DeskLevel）**：同一概念两个名字，迟早出现"改了一处漏一处"。
