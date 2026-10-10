# Agent Note: knowledge_delete 引用清理改批量落盘（消除 F+1 次整表事务）

Status: implemented

## Problem

`knowledge_delete`（`packages/knowledge/src/tool.ts`）先扫全表找出引用目标卡的卡片（防 `related` 悬空），再**逐张 `store.save`**。文件版 store 的每次 `save` 都是一次整表事务——`transactStore` 走跨进程排他锁 + 锁内重新读盘 + 全表序列化 + 原子写（`packages/dsh-home/src/store-transaction.ts`）。引用方有 F 张时，一次删除放大成 **F+1 次整表落盘**。

measure-first 实测（`spikes/bench-knowledge-delete-fanout.mts`，真实 `node:fs` + 真事务，9 轮取中位）：

| 引用方 F | 库规模 | 落盘次数 | 实测 |
|---|---|---|---|
| 0 | 11 | 1 | 0.4ms |
| 40 | 51 | 41 | 17.7ms |
| 120 | 131 | 121 | 64.6ms |

随 F 线性、且每次都要重写整表（表越大每次越贵），是二维放大。

## Decision

`KnowledgeCardStore` 增可选能力 `saveMany?(cards)`；`knowledge_delete` 在能力存在时一次批量写，缺席则逐张 `save` 降级。

- 文件版（`knowledge-fs.ts`）：一次 `commit` 内循环 `set`，只锁一次、只序列化落盘一次；空数组不写（`SKIP_WRITE` 语义沿用）。
- 内存版（`store-memory.ts`）：循环 `set`，语义与逐张一致。
- 工具侧：`store.list()` 只读一次（原本就读一次），把待清理卡先收集成数组再一次性提交，**不再在遍历中多次写**。

**契约边界**：`saveMany` 是**可选**方法而非必需——第三方/轻量实现不实现也照常工作（降级路径逐字保留），正确性两版一致，只差落盘次数。

## Alternatives considered

- **让 `saveMany` 成为必需方法**：会强制所有外部实现补一个方法（含测试里的契约包装），为一个性能优化扩大契约面；可选能力 + 降级已足够，否决。
- **Loop 内并发 `save`**：这些写落在同一个文件的跨进程锁上，并发只会互相排队，且打乱「锁内新鲜读盘」的顺序假设，否决。
- **给 store 加 `transaction(fn)` 通用事务缝**：能力更大但要调用方在锁内组装状态，把事务边界泄露给工具层；`saveMany` 只暴露「批量写」这一件事，否决。
- **留着逐张写**：库随策展增长，删除一张被广泛引用的卡片会明显卡顿，且每次都是整表重写，否决。

## Consequences

- 实测（`spikes/bench-knowledge-delete-fanout.mts`，真实文件 store，9 轮中位）：F=40 **17.7ms → 0.9ms（19.7×）**、整表落盘 41 → 2 次；F=120 **64.6ms → 1.1ms（58.7×）**、121 → 2 次；F=0 不变（0.4 → 0.4ms，仍 1 次）。改善量随库增长而放大（消除的是二维放大）。
- 测试：`test/delete-batch-write.test.ts` 3 例（真实文件 store + 契约化计数包装，无 mock 无 sleep）——40 张引用方时恰 2 次落盘、无批量通道时降级 41 次且结果一致、两条通道最终库逐值相同（`updatedAt` 除外）。负对照：把工具侧还原为逐张 `save` 后，「一次批量」与「两通道等价」两例当场失败，降级路径那例照旧通过。
- 包级 `knowledge` 45 例全绿，`bot-api` 171 例全绿（bridge 用 `createMemoryKnowledgeCardStore`，已同步实现 `saveMany`）。
- 限制：真实主库（`~/.dsh-trading/knowledge/cards.json`）未取用测量——夹具按已入库的卡结构生成固定输入，规模（11/51/131 卡）取自盘上表形状而非内容；未验证真实库的引用密度，只验证了「每引用方一次落盘」这一因果。
- 同源但未做：`knowledge_ingest` 仍单张 `save`（本就是一张，无放大）；`custom-fs.ts` / `chart-activations-fs.ts` 等 store 无删除扇出，不受影响。
