# Agent Note: 盘口与分笔竖栏（issue #39）——契约双可选方法 + crypto 三家 + 腾讯沪深五档

Status: implemented

## Problem

issue #39 要求 QuoteStage 右侧盘口五档/十档深度与逐笔成交流水。当时
`MarketDataService` 契约没有任何盘口/逐笔方法，连接器零实现（#38 已证「数据源
具备能力」≠「仓内可用」），桥与 client 亦无通道；且各市场数据源能力差异大
（crypto 有公开 L2，腾讯沪深五档藏在报价行，腾讯 r_hk 档位全 0，美股面要凭证）。

## Decision

- **契约**：`MarketDataService` 新增两个可选方法（api 包新增 `Orderbook`/
  `OrderbookLevel`/`TradeTick` 类型）：
  - `getOrderbook?(symbol): Promise<Orderbook>`——bids 降序/asks 升序由实现保证；
  - `getRecentTrades?(symbol, limit?): Promise<TradeTick[]>`——**时间升序（旧→新）**，
    与 K 线序列同向（交易所原生多为新→旧，实现内反转）；`side` 为 taker 视角。
- **连接器实现**：
  - crypto 三家（binance `/api/v3/depth`+`/trades`；okx `/market/books`+`/market/trades`；
    bybit `/v5/market/orderbook`+`/recent-trade`，spot 类目）全量实现两个方法；
  - 腾讯 cn：`getOrderbook` 与 getTicker **同一报价行**解析五档（fields 9-28，
    手→股 ×100），零额外端点成本；
  - 腾讯 hk：结构性不支持（r_hk 行档位全 0，2026-08-31 实测）→ `getOrderbook`
    按 `TRADING_NOT_IMPLEMENTED` 显式拒绝（不是空盘口，语义可区分）；
  - 美股（stooq/yahoo 无盘口；alpaca/polygon/ibkr 需凭证）本轮不接。
- **桥**：`GET /orderbook`、`GET /trades?limit`（服务端封顶 100），未实现 →
  `TRADING_NOT_IMPLEMENTED` 业务错误（与 /fundamentals、/derivatives 同词汇）。
- **client**：QuoteStage 图表区改为 `chartRow`（图表列 + 右侧 232px 可折叠竖栏）；
  `OrderbookPane` 三段式——买卖力道比（∑bids/∑asks 档位量）、五/十档深度条
  （同基准宽度可比）、逐笔流水（倒序展示最新在上，方向着色）。竖栏开关跨会话
  记忆（localStorage），轮询 4s 且仅「竖栏开 + 图表页签」时拉取。

## Alternatives considered

- **WebSocket/SSE 推送**：落选——桥是无状态透传（铁律 #5），WS 订阅要服务端
  有状态会话与生命周期管理，本轮交付不了；轻量轮询是 issue 明示的许可路径。
- **逐笔也接腾讯沪深**：落选——行情行无逐笔字段，历史分笔端点未实证，留后续。
- **五档写死在 Ticker 契约**：落选——五档是结构化档位序列，塞进 Ticker 会把
  股票词汇泄漏进 crypto 契约；独立 Orderbook 类型跨市场同形。

## Consequences

- crypto 盘口/分笔全量可用；cn 盘中五档可用（盘后空档位→GUI 空态，2026-09-02
  15:24 实证 levels=[0,0]）；hk/未实现市场竖栏显示「未提供盘口」。
- **Bybit v5 盘口字段是缩写 `result.b`/`result.a`**（初版按全称解析失败，由
  spike 揭露修正）；后续动 Bybit 盘口以 spikes/impl-orderbook-ticks/EVIDENCE.md 为准。
- 轮询为 4s×(depth+trades) 两请求/所/标的：限频压力可测（binance depth 权重低、
  okx books 10次/2s、bybit v5 公共面宽松）；后续切 WS 时轮询路径整体退役。
