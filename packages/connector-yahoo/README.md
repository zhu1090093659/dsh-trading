# @dsh-trading/connector-yahoo

dsh-trading us 切片市场连接器：经 **Yahoo Finance v8 chart API**（`query1.finance.yahoo.com/v8/finance/chart/...`）实现 `@dsh-trading/api` 的 `MarketDataService` 契约（ctx 键 `tradingUsMarketData`），并提供 `us_get_ticker` / `us_get_klines` / `us_place_order` 三工具（下单三段闸门与 connector-stooq/binance 同构）。

## 数据源状态：已实证（2026-08-29）

本出口（开发机）实测可用：`interval=1d&range=5d` 返回完整 `meta` + `timestamp[]` + `indicators.quote[0]` 序列；需 `User-Agent: Mozilla/5.0` 头。ticker + klines 真实请求证据与交叉一致性分析见 `spikes/impl-us-yahoo/`（probe-output.txt / ticker-AAPL.json / klines-AAPL-1d.json / klines-AAPL-60m.json / EVIDENCE.md）。

已知局限（工具描述同步向模型说明）：

- **非官方 API**：无 key、无 SLA、无稳定性承诺；主机为 query1/query2 双活备用。
- **日线汇总滞后**：最新已收盘交易日的日 K 可能延后补齐（实证：周五收盘后周六早晨日线序列仍缺周五，但 60m 序列完整且收盘价与 `meta.regularMarketPrice` 一致到 float32 精度）。`getTicker` 的价格/时间取 meta（权威实时面），volume 取最新日 K 量、可能滞后一个交易日。
- 1m 线历史上限约 7 天（Yahoo 端约束）。

## 合规记录（README 铁律 #5）

Yahoo Finance 的 v8 chart API 为**非官方接口**：个人使用属灰色但被普遍使用的边界。本仓按现状如实记录：

- 无凭证、无 key；仅拉取公开行情，**本仓不缓存、不批量抓取、不再次分发**任何行情数据；
- 使用边界以 [Yahoo Terms of Use](https://legal.yahoo.com/terms-of-use/) 与其数据提供方条款为准；
- 若 Yahoo 收紧该接口（风控/鉴权），本连接器会如实报 `TRADING_*` 错误，不做伪装或挑战求解。

## 前任数据源

us 切片原用 connector-stooq；Stooq 自本出口被反爬拒止（挑战页 + Access denied，证据 `spikes/impl-us/REPORT.md`），无成功实证，于任务 G 切换至 Yahoo。connector-stooq 代码保留（其他出口可能可用），状态见其 README。
