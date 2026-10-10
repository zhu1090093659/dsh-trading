# Agent Note: 台账批量盯市的分块并发（消除同一市场内的串行往返）

Status: implemented

## Problem

`refreshM2mPrices`（`packages/client-ui-trading/src/client/holdings-store.ts`）是用户打开右侧「资产」面板时的价格刷新路径（挂载即 tick，随后每 30s 一拍，`HoldingsPanel.tsx` 驱动）。它按市场分组后**在同一市场内逐块串行 `await`**：每个块一次 `GET /dshtrading/api/tickers`，桥侧 `MAX_SYMBOLS = 32` 封顶。

持仓数超过 32 时，一次盯市要等 `ceil(N/32)` 个串行 RTT。measure-first 实测（`spikes/bench-client-ui-tickers.mts`，固定 25ms 模拟 RTT，7 轮取中位）：

| 单市场持仓 | 块数 | 串行下界 | 实测 |
|---|---|---|---|
| 22（典型 4 市场共 88） | 4 | 100ms | 26.5ms（4 市场本来就并行，单市场 1 块） |
| 100（4 市场共 400） | 16 | 400ms | 105.1ms |

100 标的时 16 次往返只用了 105ms，说明瓶颈正是「同一市场内逐块串行」而不是桥或上游。

## Decision

同一市场内按 `TICKERS_MARKET_CONCURRENCY = 4` 上限**并行**取块：把该市场的块切成每批 4 个，批内 `Promise.all`，批间串行。每块保留自己的 `try/catch`，块级失败语义逐字不变（失败块缺席、其余块照常落表、整体不抛错）。

**为什么是 4 而不是无上限**：块是同一连接的顺序请求，无上限会在持仓很多时向桥突发；4 已把 100 标的压到 1 个 RTT 量级，再高收益边际而突发风险上升。上限是源码常量，不做环境变量覆盖。

## Alternatives considered

- **无上限 `Promise.all`**：持仓多时向桥突发（同连接顺序请求），否决。
- **把上限抬到 8/16**：实测已到 1 个 RTT 量级（105.1 → 26.9ms，接近 25ms 的单块地板），再抬收益边际；突发面变大，否决。
- **桥侧放宽 `MAX_SYMBOLS`**：改的是 node 半契约与上游配额纪律（铁律 #5 频率由客户端轮询节奏控制），且块数减少不等于往返减少，否决。
- **保持串行**：100 标的每拍多等约 3 个 RTT，属用户每次开面板的真实等待，否决。

## Consequences

- 实测（`spikes/bench-client-ui-tickers.mts`，固定 25ms 模拟 RTT，7 轮中位）：4 市场 × 100 标的（16 块）**105.1ms → 26.9ms（3.9×）**；在途块数峰值 4 → 16。22 标的（4 块，单市场 1 块）26.5 → 26.0ms，**不变**（典型情景本就不受此影响）。价格表键数两侧均为 400，逐值一致。
- 测试：`test/holdings-store-m2m-concurrency.test.ts` 4 例（真实 `Response` 桩、`setImmediate` 让出、无 mock 无 sleep）——单市场 3 块并发、9 块受上限约束（峰值恰为 4）、单块 500 时其余 352 键照常落表、空目标集清空且零请求。负对照：把实现还原为逐块串行后，「并发」两例当场失败，另两例（失败隔离/空集）照旧通过——阈值钉在因果上，不是把回归一起放过的宽阈值。
- 包级 `client-ui-trading` 314 例全绿；typecheck 棘轮 424 → 423。
- 限制：基准以固定 per-call 延迟模拟 RTT，未做真实网络往返对照；收益口径是「同一市场内的串行批次数」，与具体 RTT 近似线性，真实时延受出口与上游限速影响。abort/cancel 未做（原实现也没有）。
- 相邻但未做：`MarketSidebar` 的迷你走势（`fetchKlines`）仍逐标的打 K 线端点，且已按标的自带串行语义（粒度降级），属另一路径、需独立实测。
