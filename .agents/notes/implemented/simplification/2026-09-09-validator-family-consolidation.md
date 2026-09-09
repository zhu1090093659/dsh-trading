# Agent Note: 用户源码校验器家族收敛（indicators 拥有编译与 vm 沙箱单一实现）

Status: implemented

## Problem

用户源码执行链在 indicators 与 strategies 间存在三处同体副本（只读审计 F3，逐行比对核实）：`compileStrategySource`（strategies/validate.ts:50-63）与 `compileComputeSource`（indicators/validate.ts:122-135）逐字节同体仅返回类型名不同；`strategies/validate-node.ts`（82 行）与 `indicators/validate-node.ts`（53 行）的 vm 沙箱 runner 机制相同；且已发生真实漂移——超时文案分裂为「指标试算/策略试算/选股器试算」三处硬编码，`nodeScreenerEvaluateRunner` 存在的原因就是复制出的 runner 改不了文案。

## Decision

- **编译单一来源**：strategies 的 `compileStrategySource` 变为 indicators `compileComputeSource` 的类型收窄别名（导出签名与全部调用点不变）。
- **vm 沙箱单一实现**：indicators/validate-node.ts 新增 `runSourceInVmSandbox(source, bars, params, timeoutMs, label)`（经 `@dshtrading/indicators/tool` 子路径导出）；indicators 的 `nodeVmComputeRunner` 与 strategies 的 `nodeStrategyComputeRunner`/`nodeScreenerEvaluateRunner` 全部变为薄封装，label 参数归位三个语境的超时文案（文案逐字不变）。
- **Worker 内第三副本**：`WORKER_TRIAL_SCRIPT` 是 blob Worker 字符串（无法 import，镜像在架构上不可避免），补注释标明单一事实来源是 `compileComputeSource`、形态嗅探正则改动必须同步。
- 依赖方向沿用既有的 strategies → indicators（strategies 本就 import createSampleBars/workerComputeRunner），不引入新方向。

## Alternatives considered

- **下沉到 base 或新共享包**：Kline 类型与校验语义天然属于 indicators，strategies 已有对 indicators 的依赖；新建包要同步全部 profile 的 pnpm overrides（复制手册坑清单实证成本），否决。
- **连 Worker 字符串也消除（构建期从函数源码生成）**：为消除一段架构性不可避免的镜像引入代码生成步骤，维护成本倒挂，否决（改以注释钉住同步点）。
- **统一三个超时文案为同一措辞**：文案语境化是刻意的（用户能分清是哪个入口超时），label 参数化已把机制收敛，措辞差异保留。

## Consequences

- 机制改动今后只改一处；调用点、导出签名、超时文案逐字不变。
- 测试：strategies 142 + indicators 69 用例全绿；全量 `pnpm -r test` 与 typecheck 棘轮见 PR 门禁记录。
