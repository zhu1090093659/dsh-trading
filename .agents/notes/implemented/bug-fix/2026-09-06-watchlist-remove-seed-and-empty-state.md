# Agent Note: 自选股默认种子标的去除与清空状态保持修复

Status: implemented

## Problem

用户反馈在交易界面中“默认自选的股票都不能去除”。经排查，由于自选股机制采用“用户定制行优先、未定制回落默认种子”设计，存在以下三层缺陷共同导致该问题：

1. **未定制状态下直接删除默认标的失败**：
   - 在 `packages/watchlist/src/file-store.ts` 与 `src/index.ts` 中，`remove(market, symbol)` 仅通过 `map[market] ?? []` 读取数据。在未定制状态下该值为 `undefined`，导致从空数组中查找待删除标的，必然匹配失败并直接返回 `false`，不落盘、不发射变更通知。
   - 客户端 `packages/client-ui-trading/src/client/host-watchlist-sync.ts` 接管的 `watchlists.remove` 依赖 host 响应 `ok === true`，因而捕获到失败后直接中止本地更新；客户端 `store.ts` 自身同样基于 `current[targetMarket] ?? []` 过滤，两端均无法从未定制的种子中删除。

2. **展示层将“空数组”误判为“未定制”，强行复活默认种子**：
   - `packages/watchlist/src/seeds.ts` 的 `effectiveWatchlistRows` 与客户端 `store.ts` 的 `rowsFor` 此前使用 `if (rows !== undefined && rows.length > 0) return rows`。
   - 当用户将某个市场的所有股票删光（变为 `[]`）时，由于 `rows.length === 0`，逻辑错误判定为“未定制”，强行回退并返回默认种子列表，导致默认股票反复复活，自选列表永远无法清空。

3. **客户端与 Host 同步时丢失空列表状态**：
   - 客户端 `host-watchlist-sync.ts` 的 `toLocalWatchlists` 在 `!Array.isArray(rows) || rows.length === 0` 时直接 `continue`，把 host 端已清空的空数组过滤掉了，造成本地状态缺键再次回退种子。

## Decision

- **明确已定制语义（含空数组）**：
  - `Array.isArray(map[market])` 判定为已定制（`custom`）。即使数组为空 `[]`，也以用户的定制意图为准，展示空列表（“暂无自选标的”），不再回退种子。
  - 仅当 `map[market] === undefined`（键缺失）时才判定为未定制（`seed`），回落各市场默认种子行 `WATCHLIST_SEEDS[market]`。
- **未定制状态下的 remove 基准回落**：
  - 当市场尚未定制（`map[market] === undefined`）时，`remove(market, symbol)` 以 `WATCHLIST_SEEDS[market]` 为基底进行过滤。若匹配中并删除了标的，则将剩余标的物化为该市场的定制列表并写盘持久化，返回 `true` 并广播事件；若种子中亦无该标的，返回 `false`。
  - 客户端本地 `store.ts` 的 `remove` 保持同构：未定制时基于 `DEFAULT_WATCHLISTS[targetMarket]` 过滤并持久化。
- **端到端空数组保留**：
  - `toLocalWatchlists` 保留 `Array.isArray(rows)` 的空数组映射；`isHostWatchlists` 基于 `Object.keys(value).length > 0` 识别 host 记录；`bridge.ts` 的 `importWatchlists` 幂等保护同步采用 key 数量检查。

## Verification

- **单测覆盖**：
  - `@dshtrading/watchlist`（`test/watchlist.test.ts`）：新增未定制状态直接删除默认标的（`AAPL` $\rightarrow$ 物化剩余 3 只股票并转为 `custom`）、连续删光 cn 市场后展示空列表 `[]` 且不复活种子、文件持久化 store 空文件直接删除的单测（共 13 例全绿）。
  - `@dshtrading/client-ui-trading`（`test/store.test.ts` / `test/host-watchlist-sync.test.ts`）：新增本地 store 种子删除/清空单测、host 空数组定制同步单测（全量测试全绿）。
- **回归与构建**：
  - `pnpm build` 全量通过。
  - `pnpm test` 132 个测试套件 1063 个测试全量通过（0 失败）。
