# 任务 G 真实网络验证证据 —— Yahoo Finance v8 chart API（us 数据面切换）

- 时间：2026-08-29T10:13–10:14Z（本机出口，真实网络，非 mock）
- 探针：`yahoo-probe.mjs`（`node yahoo-probe.mjs AAPL`），原始输出 `probe-output.txt`
- 端点：`GET https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=<i>&range=<r>`，请求头 `User-Agent: Mozilla/5.0` + `accept: application/json`
- 共 3 次真实请求：
  1. ticker 语义：`interval=1d&range=5d` → `ticker-AAPL.json`（meta 完整：currency/regularMarketPrice/regularMarketTime/exchangeTimezoneName/regularMarketDayHigh/Low + 4 根日 K）
  2. 日 K：`interval=1d&range=1mo` → `klines-AAPL-1d.json`（22 根）
  3. 时 K：`interval=60m&range=5d` → `klines-AAPL-60m.json`（36 根）

## 与收盘价的交叉一致性说明

市场状态：抓取时为周六（美股休市），最近已收盘交易日 = 周五 2026-08-28（`meta.regularMarketTime` = 2026-08-28T20:00:01Z = 16:00:01 ET 官方收盘）。

| 对照 | 值 | 与 meta.regularMarketPrice（319.7）相对差 | 结论 |
| --- | --- | --- | --- |
| 同响应（1d/5d 请求）60m 序列最后收盘（klines-AAPL-60m.json 末根，time 2026-08-28T20:00Z） | 319.70001220703125 | ≈1e-7（float32 存储精度） | **一致**：实时 meta 价 = 当日收盘价 |
| 跨请求（1mo range 日 K 序列末根，time 2026-08-27T13:30Z） | 314.5799865722656 | 1.60% | **非矛盾**：Yahoo 日线汇总滞后——周五日 K 在周六早晨仍未并入日线序列（1d/5d 与 1d/1mo 两个响应同样缺周五） |

即：**同响应内** meta.regularMarketPrice 与最新 60m 收盘互相印证（319.7 = 周五收盘）；日 K 序列滞后一个交易日是 Yahoo 非官方 API 的数据 vintage 行为，不是价格矛盾（周五盘中路径 314.58→…→319.70 在 60m 序列完整可见）。另做 sanity：regularMarketDayHigh 322.37 ≥ 319.7 ≥ regularMarketDayLow 315.45。

## 对连接器设计的直接影响

- `getTicker`：单请求 `1d/5d`，价格/时间取 `meta.regularMarketPrice/regularMarketTime`（权威实时面）；volume 取最新日 K 量——日线滞后时可能差一个交易日，工具描述已向模型明示。
- `getKlines`：timestamp[] + indicators.quote[0] 对齐数组，null 行丢弃；closeTime = openTime + interval 名义时长 − 1。
- 错误映射：429→TRADING_RATE_LIMITED；`chart.error`/非 JSON/非 2xx→TRADING_EXCHANGE_ERROR；空 result→TRADING_UNSUPPORTED_SYMBOL。
