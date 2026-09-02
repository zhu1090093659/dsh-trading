# Issue #39 spike：盘口与逐笔数据面验证证据

- 母任务：issue #39（实时盘口五档/十档 + 逐笔成交）；实现 PR 挂 #42（epic）。
- 抓取时间：`fetch-timestamp.txt`（2026-09-02，UTC）；出口：macOS 本出口。
- 验证方法：构建产物直连真实端点（`run-orderbook-probe.mjs` → `probe.json`）+
  桥端到端（`run-bridge-e2e-probe.mjs` → `bridge-e2e-probe.json`：真实服务 →
  TradingBridge → `GET /orderbook`、`GET /trades`）。

## 实测结论总表（本出口，2026-09-02）

| 市场/连接器 | 端点 | 形状要点 | 解析 | 证据 |
|---|---|---|---|---|
| binance | `GET /api/v3/depth?limit=20` | `{bids:[[p,q]],asks:[[p,q]]}`（bids 降序/asks 升序原生） | ✅ | probe.json（bid1/ask1 实价、20+20 档） |
| binance | `GET /api/v3/trades?limit=` | `[{id,price,qty,time,isBuyerMaker}]`（升序；isBuyerMaker=true→主动卖） | ✅ | probe.json + bridge-e2e |
| okx | `GET /api/v5/market/books?sz=20` | `data[0].bids/asks` 行 `[price,size,liqOrders,numOrders]`；`ts` | ✅ | probe.json |
| okx | `GET /api/v5/market/trades` | `[{tradeId,px,sz,side,ts}]`（新→旧→反转为契约升序） | ✅ | probe.json |
| bybit | `GET /v5/market/orderbook?category=spot` | **缩写字段 `result.b`/`result.a`**（非 bids/asks 全称）；行 `[price,size]` | ✅（首版按全称解析失败，据 `bybit-orderbook-raw.json` 修正） | bybit-orderbook-raw.json |
| bybit | `GET /v5/market/recent-trade?category=spot` | `result.list [{execId,price,size,side,time}]`（新→旧→反转） | ✅ | probe.json |
| 腾讯 cn | `GET qt.gtimg.cn/q=sh600519`（**与 getTicker 同一行**，零额外端点） | fields 9-28 = 买一~买五价量 / 卖一~卖五价量（量单位手） | ✅（解析由真实行夹具单测覆盖） | spikes/impl-cn-hk/r1-*.raw（2026-08-31 实测行含真实五档值） |
| 腾讯 hk | 同上 | **r_hk 行买卖档位全 0**（结构性无盘口）→ getOrderbook 按 TRADING_NOT_IMPLEMENTED 拒绝 | ✅ 按预期拒绝 | probe.json（`"code":"TRADING_NOT_IMPLEMENTED"`） |

## 实现期修正（以真实响应为准）

1. **Bybit v5 盘口字段缩写**：初版按 `result.bids/asks` 解析，真实响应是
   `result.b/result.a`（bybit-orderbook-raw.json）。已改并注明依据；单测 fixture 同步。

## 范围注记

- **逐笔成交只覆盖 crypto 三家**：腾讯沪深行情行没有公共逐笔端点（历史分笔另有
  未验证端点，留后续）；bridge `/trades` 对 cn/hk/us 返回 TRADING_NOT_IMPLEMENTED，
  GUI 流水段隐藏。
- **us 盘口未实现**：alpaca/polygon/ibkr 均需凭证或本地网关，本轮不接。
- **A股盘后五档为空**：sh600519 15:24 CST（收盘后）实测 levels=[0,0]——空档位
  返回空 bids/asks（HTTP 200 + ok:true），GUI 显示空态；盘中实时档由
  2026-08-31 r1-*.raw 原始行（1297.35~5~… 五档值齐全）佐证解析正确。
- 证据文件仅作 spike 落库（铁律 #5）。
