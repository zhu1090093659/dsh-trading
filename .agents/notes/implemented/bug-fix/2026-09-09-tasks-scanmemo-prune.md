# Agent Note: TasksRunner 扫描备忘对账清理（删任务残留键防泄漏）

Status: implemented

## Problem

TasksRunner.scanMemos（每会话最新已扫事件序号，无终局匹配时避免重复翻历史页）只在 inspect 自己的三条出口删除（会话消失/快照命中/翻页命中）。任务在执行途中被删除（或经非侦查路径结算）后，poll 不再对该会话调 inspect，备忘键永久残留——随被删任务数单调增长（perf 审计 LOW 项）。

## Decision

- runner 新增 pruneScanMemos(activeSessionIds)：清掉不在未结算名册里的备忘键。
- service.poll 每轮末尾用当轮 openExecutions 的 sessionId 集合对账一次（名册先取一次快照供循环与对账共用；对账保守保留陈旧 id——已结算执行的备忘本就由 inspect 出口删除）。
- 选「每轮对账」而非「挂每个删除路径」：删除/结算入口不止一处（apply delete、ledger 压实等），对账自愈不依赖枚举全部入口。

## Alternatives considered

- 在 ledger.deleteTask 等每个删除点回调 runner.forget(sessionId)：入口枚举易漏，否决。

## Consequences

- 单测 test/tasks-runner.test.ts：page 调用计数探针证明备忘命中（不重复翻页）与 prune 后重新翻页；370 用例全绿。
