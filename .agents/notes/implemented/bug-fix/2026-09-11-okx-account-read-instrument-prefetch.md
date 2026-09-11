# Agent Note: OKX 只读账户面规格解析改并发预取（消除逐标的串行往返放大）

Status: implemented

## Problem

`getPositions` / `listOpenOrders` / `listTradeFills`（`packages/connector-okx/src/index.ts`）逐行 `await getInstrument(instId)` 解析 SWAP 的 `ctVal`。规格缓存（TTL 1h）只在命中后免网；冷缓存下每个不同 instId 都要一次 `GET /api/v5/public/instruments`，且逐行串行——N 个不同 SWAP 标的放大成 N 次串行上游往返。

该路径是用户首触：GUI 加密账户面板（桥 `/trade/positions|orders|fills`）与 G1 只读账户工具（`crypto_get_positions` 等，见 [agent-native 工具面](../feature/2026-09-08-agent-native-tool-surface.md)）都经它。measure-first 实测（`spikes/bench-user-paths.mts`，固定 25ms 模拟 RTT，5 轮中位数）：5 个不同标的 159.9ms / 6 次串行往返；20 个标的 556.1ms / 21 次。相邻本地纯计算对照同批实测低两到三个数量级（`knowledge_search` 300 卡 0.7ms、`aggregateHoldings` 300 持仓 0.15ms），故本条为本轮首要可优化项。

## Decision

`OkxTradeService` 新增：

- `instIdsOf(rows)`：从上游行集收集 `instId`；
- `prefetchInstruments(instIds)`：过滤并去重 SWAP 标的，按 `INSTRUMENT_PREFETCH_CONCURRENCY = 8` 分批 `Promise.all` 解析，返回「成功项」`Map<string, OkxInstrument>`（查不到的 instId 缺席）。

三个入口先预取、再逐行同步查表；`toCoins` 增可选 `instruments` 参数，传入时纯内存查表，未传时回退单条 `getInstrument`（保留给单笔查单等非批路径的既有语义）。**行为契约不变**：规格查不到仍保留张数原值（`prefetch` 缺席即回退，且不再逐行重试）；`instId → ctVal` 数值换算、输出规范形与字段全部照旧。

## Alternatives considered

- **一次拉全量 SWAP 名册（`getInstruments('SWAP')`）**：只需 1 次往返，但要下载整表并把全部条目灌进缓存，改动面与数据面都更大；按需预取已把典型账户压到 1 批，收益差不足以换复杂度，否决。
- **无上限 `Promise.all`**：标的数大时向公共面突发（官方限速 20 次/2s），改为 8 并发上限，否决无上限形态。
- **维持逐行 await、只依赖现有缓存**：成本恰在冷缓存首次打开（用户首屏），缓存不解决串行放大，否决。
- **失败路径用负缓存避免重试**：需要额外状态与缓存语义改动；改为「预取返回成功 Map、缺席即回退」已天然消除逐行重试，否决负缓存。

## Consequences

- 实测（`spikes/bench-user-paths.mts`，固定 25ms 模拟 RTT，5 轮取中位）：5 标的 159.9 → 52.8ms（3.0×）；20 标的 556.1 → 107.1ms（5.2×）；`listOpenOrders`/`listTradeFills` 同幅。上游调用总数不变（每个不同 instId 一次），串行批次由 N 降为 ceil(N/8)；收益仅在冷缓存首触，持久缓存命中后两版都无网络。
- 测试：`trade-desk.test.ts` 新增 2 例——3 个不同 SWAP 标的含重复行 → 规格请求恰 3 次（去重）；某标的规格查不到 → 该标的保留张数原值、同批其他照常换算、失败态只尝试 1 次不逐行重试。包级 90 用例全绿；typecheck 棘轮 481=481；`tsdown` 构建通过。
- 限制：基准以固定 per-call 延迟模拟 RTT，未做真实网络往返对照；收益口径是「串行往返次数」，与具体 RTT 近似线性，真实时延受出口与上游限速影响。
- 剩余项（本轮不做）：`client-ui-trading/src/client/holdings-store.ts` 的盯市分块在同一市场内仍逐块串行（`TICKERS_CHUNK = 32`），属另一路径、需独立实测与限速评估。
