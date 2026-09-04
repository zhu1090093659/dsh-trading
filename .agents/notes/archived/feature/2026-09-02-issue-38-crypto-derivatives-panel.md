# Agent Note: 衍生品指标面板（issue #38）——契约可选方法 + 三家连接器 + 桥透传

Status: implemented

## Problem

issue #38 要求在 GUI 呈现加密衍生品微观数据（持仓量/资金费率/多空比），但当时
`DerivativesData` 类型与 kit-crypto 的 agent 工具（`crypto_get_derivatives`）虽已存在，
**连接器、桥、client 三层完全没有接**：GUI 面板没有任何数据通道；issue 声称的
「binance/okx/bybit 均具备该数据面」实测只有端点存在，仓内实现为零。

## Decision

- **契约**：`MarketDataService` 新增可选 `getDerivatives?(symbol): Promise<DerivativesData>`
  （api 包；类型沿用既有 `DerivativesData`，零新增词汇）。可选语义与 `getFundamentals`
  同款：现货/股票数据源不实现，消费方降级不报错。输出 `symbol` 一律规范 SWAP 形。
- **三家连接器实现**（公共无凭证端点）：
  - okx：`/api/v5/public/open-interest`（oi/oiCcy/oiUsd）+ 既有 funding-rate +
    rubik `long-short-account-ratio` / `taker-volume`；现货输入经 `toOkxSwapInstId`
    升到对应永续（GUI 选 BTCUSDT 也能看合约指标）。
  - binance：fapi 公共面（`openInterest` / `fundingRate` / `futures/data` 多空比族），
    `BinanceRestClient` 增加 fapi base（`#request` 参数化 base）。
  - bybit：`/v5/market/tickers?category=linear`（单端点带 fundingRate+OI+OI value）+
    `/v5/market/account-ratio`（buyRatio/sellRatio → 多空比）。
  - 聚合纪律三家一致：子查询逐项 try/catch，单项失败降级该字段为 undefined（面板
    缺格隐藏），全部失败才抛结构化错误（桥层转 ok:false）。
- **桥**：`TradingBridge.derivatives` + `GET /derivatives`（client-ui-trading 桥），
  未实现 → `TRADING_NOT_IMPLEMENTED` 业务错误（HTTP 200 + ok:false）。
- **client**：`DerivativesPane` 快照卡片条（持仓量/持仓价值/资金费率/多空人数比/
  大户多空比/主动买卖比），挂 QuoteStage 图表页签下方、仅 `market==='crypto'` 且
  拿到数据时渲染；30s 轮询（一次刷新=2~5 个上游调用，对齐 K 线 resync 节奏）。
- **真实网络证据**：spikes/impl-crypto-derivatives/——构建产物直连三家端点 11 项
  子查询全过；桥→服务→交易所 e2e（binance/okx/bybit）HTTP 200 + ok:true。

## Alternatives considered

- **复用 kit-crypto 的 `fetchCryptoDerivatives`**：落选——kit 是 agent 工具包，
  连接器依赖 kit 方向倒置；且 okx/bybit 词汇不同，泛化反而复杂。binance 端点词汇
  与 kit 实现保持一致（同 URL 同参数）。
- **历史序列副图（OI/资金费率画进 TvChart 子图）**：本轮不做——需三家各补历史端点
  （binance openInterestHist 等）且 `DerivativesData` 是快照形状；先交付快照面板，
  序列化留后续任务。
- **爆仓统计**：不实现——三家公共 REST 均无（Binance 仅 WS `!forceOrder@arr`），
  契约亦无该字段；与 EVIDENCE.md 注记一致。

## Consequences

- GUI crypto 行情图下方常驻衍生品快照条；切非 crypto 市场自动消失，面板不抛错。
- rubik 端点返回**时间序列数组行**（非对象行）——实现与单测 fixture 均按实证修正
  （初版解析失败由 spike 揭露），后续动 OKX rubik 相关代码以
  spikes/impl-crypto-derivatives/EVIDENCE.md 为准。
- 多空比跨所口径不一（账户比 vs 大户持仓比），面板分格呈现不做对齐。
- `getDerivatives` 为可选契约成员：新增现货/第三方连接器不实现也不破坏编译与运行。
