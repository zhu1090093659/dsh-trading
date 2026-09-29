# Agent Note: 自选合并视图——行情数据对 Agent 透明

Status: implemented

## Problem

owner 2026-09-02 实测暴露「行情插件数据对 Agent 不透明」缺口（附截图：会话里用户问"看一下苹果的行情"，agent 翻文档、读别的仓库的适配器源码，最后答"苹果不在自选里(美股只跟踪 GOOGL/MSFT/PURR)"——而用户左栏明明看着苹果）：

**自选行 agent 不可见**：GUI 左栏的展示行 = 用户定制行 ∪ 市场种子行（`rowsFor` 回落），但种子表只活在 client-ui-trading `store.ts`，host 侧 `watchlist_list` 只读用户定制行（`~/.dsh/watchlists.json` 实况：只有 HYPEUSDT）。用户眼里的"自选"与 agent 眼里的"自选"是两个集合；工具描述里"falls back to client-side seed display"一句对 agent 只是不可展开的注释。`watchlist_select` 的名称解析（自选行带展示名）也因此漏种子行——agent 从 list 看到行、select 却拿不到名。

同一实测还提出过「把当前行情上下文一键投递给 Agent」的入口；该入口及其快照组装、composer 填入通道已于 2026-09-29 整体下线（见 [composer 填入入口下线](../simplification/2026-09-29-remove-composer-fill-entries.md)），本记录只保留自选合并视图部分。

## Decision

1. **种子表上收为共享单源**（新 `@dsh-trading/watchlist/src/seeds.ts`）：`WATCHLIST_SEEDS` + `effectiveWatchlistRows`（定制行优先、未定制回落种子，与客户端 `rowsFor` 同构）+ `watchlistRowSource`；client `store.ts` 的 `DEFAULT_WATCHLISTS` 改为再导出（client bundle 把纯数据模块内联，tsdown alwaysBundle 路径，实测 `贵州茅台` 在产物中）。
2. **`watchlist_list` 输出合并视图**：`watchlists` = 各市场有效展示行（与 GUI 左栏一致），新增 `sources[market] = 'custom' | 'seed'`；描述改写为权威口径——"this list IS what the user sees"，指示 agent 在用户提到任何标的（名称或代码）时**先调本工具**，并标注展示名↔代码映射（苹果 → AAPL / us）。
3. **`watchlist_select` 名称解析走合并视图**（`effectiveWatchlistRows` 查找），种子行同样复用展示名，与 list 契约闭环。

## Alternatives considered

- **客户端首启把种子行写进 host store（升级迁移同款）**：会违背 issue #32/P3 的既定裁决「种子不进 host」——种子是展示回退不是用户数据，写进去后 remove/customize 语义全部变形，多端（重置 localStorage 的浏览器）行为漂移；合并视图在读取侧闭环，零写入。
- **`watchlist_add` 时自动补全市场种子**：方向反了——用户加一行不该拉进来 14 行噪音，agent 侧重复度更高。

## Consequences

- agent 与 GUI 的"自选"语义从此同源：种子表改动只碰 `seeds.ts` 一处；`watchlist_list` 输出多了 `sources` 字段（旧消费者无——该工具输出仅 LLM 阅读）。
- **验证记录**：pnpm build / test 全绿；trading-web profile 副本 client-ui-trading 经硬链接原地直达（inode 一致），watchlist 副本分叉已 `ln` 重建硬链接。
