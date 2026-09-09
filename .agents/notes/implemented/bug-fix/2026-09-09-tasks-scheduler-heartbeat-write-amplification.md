# Agent Note: 定时任务调度器空转心跳的落盘/SSE 写放大收敛

Status: implemented

## Problem

宿主稳态空转成本：`TradingTasksService.tick` 每 30s 无条件 `ledger.updateScheduler({lastTickAt})`（`packages/client-ui-trading/src/tasks/service.ts:190`），账本 `commit` 对整文档做 JSON 深克隆 + `JSON.stringify` + `writeFileSync`/`fsyncSync`/`renameSync`/`chmodSync` 同步落盘（`ledger.ts:366-387`），随后监听器扇出 `emit('tasks')` → SSE 帧推给每个已连接标签页 → 每页 refetch 全量快照。即使零任务到期，该链路每 30s 完整跑一遍（每天 2880 次 fsync + N 标签页 refetch 风暴），持续宿主整个生命周期。实证核查：客户端没有任何 UI 消费 `scheduler.lastTickAt`（client/ 下 .tsx 无 scheduler 引用），心跳的落盘与广播是纯浪费。

## Decision

`TasksLedger.updateScheduler` 增加心跳快路径：patch 只刷新 `lastTickAt`（`error === undefined`）且当前无错误态时，直接在内存文档上更新快照字段并返回——不克隆、不落盘、不递增 revision、不广播。错误的出现（tick 失败写 error）与清除（出错后首个成功 tick）仍走完整 `mutate`：可见状态变化必须落盘 + 广播，UI 需要据此提示调度器故障/恢复。

语义保持不变：`snapshot()` 读内存文档，`lastTickAt` 对 REST 轮询始终新鲜可见；下一次真实 commit（任务增删改、执行开合、对账）会把内存中的最新心跳值顺带落盘；重启后读到的是最近一次真实 commit 时刻顺带持久化的心跳，考虑到无消费者，该精度损失无观测者。

## Alternatives considered

- **心跳降频落盘（如 5min）**：仍保留稳态 fsync 与 SSE 风暴（只是变稀），且引入「降频参数」新决策点；在零消费者的前提下没有理由保留任何周期性落盘，否决。
- **只去广播、保留落盘**：fsync 事件-loop 阻塞仍在，且为无人读的字段付磁盘磨损，否决。
- **连内存字段也删掉**：`lastTickAt` 是 `TasksSchedulerSnapshot` 协议字段（浏览器只读面），删字段是公共契约变更，超出本修复范围，否决。

## Consequences

- 行为变化（仅一处）：空转 tick 不再产生 `tasks` SSE 事件与账本 revision 递增；任务板依赖真实变更事件与挂载时 fetch 刷新（`ScheduledTasksPanel` 原有路径），无依赖 30s 周期 refetch 的消费者。
- 测试：`tasks-ledger.test.ts` 新增两例——心跳不落盘不广播（revision/文件内容/监听器计数三重断言）+ 错误出现/清除走完整 commit；包级 365 用例全绿（基线 363）。
- 收益量化口径：稳态下每 30s 一次的整文档 fsync + 每标签页全量快照 refetch 归零（按计数消除，非时延测量；单次 fsync 约 1-20ms 事件-loop 阻塞）。
- 剩余风险：若有外部脚本依赖账本文件 mtime 的 30s 搏动作活性探针会失效——仓内无此用法（grep 无消费者）。
