# Feature Note: 接入美股 Alpaca 连接器与港股 Futu 连接器

- **日期**: 2026-08-31
- **类别**: Feature / Connector
- **状态**: Implemented

## 1. 背景与动机
在多市场交易框架下，美股此前仅有 Yahoo Finance 公共数据源（仅支持日线/周线/月线），港股此前仅有腾讯数据源（港股分钟线接口不可用）。
为了满足美股与港股的分钟级行情分析（5m/15m/30m/1h 等）以及真实的下单/模拟盘撮合能力，系统正式引入两个专业交易连接器：
1. **美股市场 (us)**: `@dsh-trading/connector-alpaca`（接入 Alpaca Market Data v2 IEX feed 及 Trading API v2，支持两值 API Key/Secret 鉴权与 Paper/Live 环境）。
2. **港股市场 (hk)**: `@dsh-trading/connector-futu`（接入 FutuOpenD 网关，支持 5m/15m/30m/60m 等全周期 K 线、Ticker 与港股交易，提供优雅的 ECONNREFUSED 网关离线引导）。

## 2. 架构设计与实现

### 2.1 美股 Alpaca 连接器 (`@dsh-trading/connector-alpaca`)
- **Rest 客户端 (`AlpacaRestClient`)**:
  - 行情面：`https://data.alpaca.markets/v2`，支持 `getTicker`（聚合最新成交与报价）、`getKlines`（`timeframe=5Min/15Min/1Hour/1Day` 等，自动计算 `closeTime`）、`listInstruments`（从 `/assets` 提取 active tradable 股票）。
  - 交易面：Paper (`paper-api.alpaca.markets/v2`) 与 Live (`api.alpaca.markets/v2`)，支持 `getBalance`、`placeOrder`、`cancelOrder`。
- **Cordis 插件与工具**:
  - 注册 `AlpacaMarketDataService` 与 `AlpacaTradeService`。
  - 暴露 `us_get_ticker`, `us_get_klines`, `us_place_order` 工具。
  - 铁律 #3 闸门安全保护：默认 `dryRun=true`，未开 `liveTrading` 时拦截实盘请求。

### 2.2 港股 Futu 连接器 (`@dsh-trading/connector-futu`)
- **Rest 客户端 (`FutuRestClient`)**:
  - 网关地址：默认 `http://127.0.0.1:11111`（支持配置 `gatewayUrl`）。
  - 港股符号转换：`00700.HK` / `00700` / `700` 自动归一化为规范形 `00700.HK`，请求网关时转为 `HK.00700`。
  - K 线周期映射：`1m(KL_1M), 5m(KL_5M), 15m(KL_15M), 30m(KL_30M), 1h(KL_60M), 1d(KL_DAY), 1w(KL_WEEK), 1M(KL_MONTH)`。
  - 容错机制：当本地未启动 FutuOpenD 网关时，捕获网络异常并抛出明确友好的错误提示。
- **Cordis 插件与工具**:
  - 注册 `FutuMarketDataService` 与 `FutuTradeService`。
  - 暴露 `hk_get_ticker`, `hk_get_klines`, `hk_place_order` 工具。

### 2.3 市场 Bundle 与 Preset 接线
- **`packages/us`**:
  - 添加 `@dsh-trading/connector-alpaca` 依赖；
  - `cordis.patch.yml` 增加 `dsh-trading-us-dataplane-alpaca`；
  - `us-trader/agent.cordis.yml` 增加 alpaca isolate group (`tradingUsMarketData`, `tradingUsTrade`)。
- **`packages/hk`**:
  - 添加 `@dsh-trading/connector-futu` 依赖；
  - `cordis.patch.yml` 增加 `dsh-trading-hk-dataplane-futu`；
  - `hk-trader/agent.cordis.yml` 增加 futu isolate group (`tradingHkMarketData`, `tradingHkTrade`)。

### 2.4 设置路由与 UI 周期开放
- **`packages/router`**: `PROVIDER_VOCABULARY` 补充 `'alpaca'`, `'futu'`。
- **`packages/client-ui-settings`**: `PROVIDER_LABELS` 增加 `alpaca: 'Alpaca'` 与 `futu: 'Futu (富途 OpenD)'`。
- **`packages/client-ui-trading`**: `MARKET_INTERVALS` 为 `us` 与 `hk` 全面开放 `['5m', '15m', '30m', '1h', '1d', '1w', '1M']` 选项。

## 3. 验证情况
- **单测覆盖**:
  - `@dsh-trading/connector-alpaca`: 9 tests passed.
  - `@dsh-trading/connector-futu`: 7 tests passed.
  - 全仓 21 个包构建成功，268 个单测全量通过（100% 绿线）。