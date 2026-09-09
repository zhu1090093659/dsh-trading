# Agent Note: 内存版记录 store 去重（strategies 包内；审计 ×6 主张按证据收缩范围）

Status: implemented

## Problem

只读审计 F6 主张「内存版记录 store 工厂 ×6 同体」。逐文件比对后证据只支持其中两处：strategies/custom.ts 的 createMemoryCustomStrategyStore 与 strategies/custom-screener.ts 的 createMemoryCustomScreenerStore 逐字节同体（仅类型名不同，13 行 Map CRUD）。其余四个被点名的并不同构：watchlist 三个内存 store 各带业务逻辑（归一化/种子回退/分组成员关系）；strategies builtin-tombstones 是 Set 形状；knowledge store-memory 接口不同（delete 而非 remove，另有 getByUrl）；indicators chart-activations 内存版 list 时做 sanitizeInstance。indicators/custom.ts 那一份确与 strategies 同体，但跨包共享 13 行泛型要付出新 API 面与类型间接层，收益在噪声内——只留包内去重。

## Decision

- strategies/src/memory-store.ts 新增 createMemoryRecordStore<T extends { id: string }>（list/get/save/remove，save 浅拷贝语义与原副本一致）。
- createMemoryCustomStrategyStore 与 createMemoryCustomScreenerStore 改为委托；导出签名不变（CustomStrategyStore.remove(id, archive?) 结构性兼容）。
- indicators/custom.ts 的第三份保留：跨包共享 13 行不值得新依赖面（与 F1 原子写不同——那里 25 行逻辑且漂移已实证）。

## Alternatives considered

- 泛型上收 dsh-home 统一六处：四个「同体」主张不成立（接口/形状不同），且为 13 行引入跨包泛型层得不偿失，否决。
- 连 knowledge 一起收敛（remove→delete 改名适配）：接口词汇不同构，适配器成本高于收益，否决。

## Consequences

- strategies 包内两份同体副本归一；142 用例全绿。
