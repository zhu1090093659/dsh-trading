# Agent Note: 动态市场大盘指数与交易时段状态栏（替换硬编码 Mock 数据）

Status: implemented

## Problem

行情中栏（QuoteStage）底部的富途式市场状态栏此前硬编码了静态的 Mock 数据（恒指 25350.05 -0.92%、恒科 4546.83 -1.27%、上证 2842.21 +0.48%）以及固定不变的“交易中”文案，无法反映真实的大盘走势以及对应市场的真实交易时段（开市/盘中/午休/盘前/盘后/已收盘）。

## Decision

1. **大盘指数定义与动态切换（MARKET_INDICES）**：
   - 随当前激活标的所在市场动态切换展示对应的 3 大核心指数：
     - **A 股 (`cn`)**：上证指数 (`sh000001`)、深证成指 (`sz399001`)、创业板指 (`sz399006`)
     - **港股 (`hk`)**：恒生指数 (`HSI`)、恒生科技 (`HSTECH`)、国企指数 (`HSCEI`)
     - **美股 (`us`)**：标普500 (`^GSPC`)、纳斯达克 (`^IXIC`)、道琼斯 (`^DJI`)
     - **加密 (`crypto`)**：BTC (`BTCUSDT`)、ETH (`ETHUSDT`)、SOL (`SOLUSDT`)
   - 行情拉取：通过既有同源行情桥 `/dshtrading/api/tickers?market=...&symbols=...` 批量轮询最新价格与涨跌幅，动态渲染红涨绿跌。

2. **连接器指数支持与字段对齐**：
   - `connector-tencent`：放宽 `HK_SYMBOL_PATTERN` 与 `normalizeHkSymbol`，原生支持 `HSI`、`HSTECH`、`HSCEI` 等指数代码；
   - `connector-yahoo`：在 `getTicker` 返回中附带 `prevClose`（来自 `result.meta.chartPreviousClose`）与 `changePercent`（来自 `result.meta.regularMarketChangePercent`）；
   - `connector-binance`：在 `getTicker` 返回中附带 `prevClose` 与 `changePercent`。

3. **市场交易时段状态计算（getMarketSessionStatus）**：
   - 时区感知与交易规则判定：
     - `crypto`：7×24 持续交易（`status.trading`，绿灯）；
     - `cn`（Asia/Shanghai）：09:15-09:30 集合竞价（黄），09:30-11:30 早盘交易（绿），11:30-13:00 午间休市（黄），13:00-15:00 午盘交易（绿），其余/周末 已收盘（灰）；
     - `hk`（Asia/Hong_Kong）：09:00-09:30 开盘竞价（黄），09:30-12:00 早市（绿），12:00-13:00 午休（黄），13:00-16:00 午市（绿），16:00-16:10 收市竞价（黄），其余/周末 已收盘（灰）；
     - `us`（America/New_York）：04:00-09:30 盘前（黄），09:30-16:00 盘中交易（绿），16:00-20:00 盘后（黄），其余/周末 已收盘（灰）。
   - 国际化文案：新增 `status.midday`（午间休市）、`status.preMarket`（盘前）、`status.afterHours`（盘后）、`status.auction`（集合竞价）。

## Consequences

- 彻底移除 `QuoteStage.tsx` 中的所有静态 Mock 指数与固定交易中文案。
- 底部状态栏支持多市场大盘真实行情与动态交易时段指示灯。
- 全仓 59 个测试文件、426 个测试用例 100% 通过；全量 packages 编译通过。
