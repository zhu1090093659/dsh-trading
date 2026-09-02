# Issue #38 spike：crypto 衍生品数据面验证证据

- 母任务：issue #38（加密货币衍生品微观数据副图）；实现 PR 挂 #42（epic）。
- 抓取时间：`fetch-timestamp.txt`（2026-09-02，UTC）；出口：macOS 本出口。
- 验证方法：**用已构建的连接器 REST 客户端（lib 产物）直连真实端点**——既留原始
  响应，也证明实现内的解析逻辑（非仅端点可达）：
  - `run-derivatives-probe.mjs` → `parsed-probe.json`（三家 11 项子查询，全部 OK）；
  - `run-bridge-e2e-probe.mjs` → `bridge-e2e-probe.json`（真实服务 → TradingBridge →
    `GET /dshtrading/api/derivatives` dispatch 全链路，binance/okx/bybit 均
    HTTP 200 + ok:true + 规范 SWAP 输出）。

## 实测结论总表（本出口，2026-09-02）

| 交易所 | 端点 | 形状要点 | 解析 | 证据 |
|---|---|---|---|---|
| Binance fapi | `GET /fapi/v1/openInterest` | `{openInterest, time}`（base 币数） | ✅ | `binance-fapi-openInterest.json` |
| Binance fapi | `GET /fapi/v1/fundingRate?limit=1` | `[{fundingRate, fundingTime}]`（小数） | ✅ | `parsed-probe.json` |
| Binance fapi | `GET /futures/data/globalLongShortAccountRatio` / `topLongShortPositionRatio` / `takerlongshortRatio`（period=1h&limit=1） | `[{longShortRatio}]` / `[{buySellRatio}]` 对象行 | ✅ | `binance-fapi-global-ls.json` + probe |
| OKX | `GET /api/v5/public/open-interest?instType=SWAP` | `{oi(张), oiCcy(币), oiUsd(USD), ts}` | ✅ | `okx-open-interest.json` |
| OKX | `GET /api/v5/public/funding-rate` | `{fundingRate, nextFundingRate, …}` | ✅ | probe |
| OKX rubik | `GET /api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H` | **时间序列行 `[ts, ratio]`（字符串，新→旧）**，非对象行 | ✅（首次实现按对象行解析失败，据本证据改为数组行取最新） | `okx-rubik-ls.json` |
| OKX rubik | `GET /api/v5/rubik/stat/taker-volume?ccy=BTC&instType=CONTRACTS` | **时间序列行 `[ts, buyVol, sellVol]`（新→旧）** | ✅（同上修正） | `okx-rubik-taker.json` |
| Bybit v5 | `GET /v5/market/tickers?category=linear` | 单端点同时带 `fundingRate` / `openInterest`(币) / `openInterestValue`(USD) | ✅ | `bybit-linear-tickers.json` |
| Bybit v5 | `GET /v5/market/account-ratio?category=linear&period=1h` | `[{buyRatio, sellRatio}]`（账户占比）→ 多空比 = buy/sell | ✅ | `bybit-account-ratio.json` |

## 实现期修正（以真实响应为准）

1. **OKX rubik 两个端点不是对象行**：初版按 `data[0].ratio` / `data[0].buyVol` 解析，
   真实响应是 `data: [["1788328800000","1.31"], …]` 时间序列。已改为数组行取最新
   （`rest.ts` 内注明以本 spike 为依据），对应单测 fixture 同步改为数组行。

## 范围注记

- **爆仓统计（issue #38 的「24h 爆仓金额」）未实现**：Binance 强平流仅 WS
  （`!forceOrder@arr`），OKX/Bybit 公共 REST 均无现成端点；契约
  `DerivativesData`（api 包既有类型）本就未定义爆仓字段。留作后续 WS 任务。
- 多空比口径各家不同：Binance global=账户比、top=大户持仓比；OKX rubik=账户比
  （无公开大户持仓比）；Bybit account-ratio=账户比。GUI 按字段各自呈现，不做跨所对齐。
- 证据文件仅作 spike 落库（铁律 #5：工具实现不缓存不再分发，公共统计按需拉取）。
