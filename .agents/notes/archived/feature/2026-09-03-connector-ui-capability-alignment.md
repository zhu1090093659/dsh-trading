# Agent Note: 连接器与 UI 功能全面贯通（多市场交易台 + 撤单闭环 + 盘口与基本面补全）

Archived: 2026-09-04
Status: implemented

## Problem

上一轮对全仓 19 个连接器与客户端 UI 功能进行全面审计后，发现以下断层问题：
1. **交易台市场割裂**：此前仅 OKX 注册了 tradingTradeRegistry，且 QuoteStage.tsx 硬编码了 market === 'crypto'，美股（Alpaca）、港股（Futu）、A 股（Qmt）等具备交易能力的连接器在 UI 交易台均无法使用（报 no trade service for market 或直接隐藏开关）。
2. **挂单无法撤单**：UI 交易台当前挂单表格缺少「撤单」操作；后端桥缺少 DELETE /trade/order 端点；调用链断裂。
3. **美股盘口深度缺失**：美股 connector-alpaca 原有行情服务未实现 getOrderbook，导致美股行情页面盘口栏处于降级不可用状态。
4. **基本面与商业连接器结合不足**：connector-finnhub 等商业美股数据源未暴露 getFundamentals 指标接口。

## Decision

1. **TradeService 契约与多市场注册表对齐**：
   - **Alpaca (美股)**：AlpacaTradeService 补齐 getBalances、getPositions、listOpenOrders、listTradeFills、getOrder；在 dataplane.ts 注册到 tradingTradeRegistry.register('us', 'alpaca', trade)。
   - **Bybit (加密)**：BybitTradeService 补齐只读与查询方法，规范化 cancelOrder 签名与闸门抛错；在 dataplane.ts 注册到 tradingTradeRegistry.register('crypto', 'bybit', trade)。
   - **Futu (港股)**：FutuTradeService 补齐契约方法；在 dataplane.ts 注册到 tradingTradeRegistry.register('hk', 'futu', trade)。
   - **MiniQMT (A股)**：QmtTradeService 补齐契约方法；在 dataplane.ts 注册到 tradingTradeRegistry.register('cn', 'qmt', trade)。
2. **UI 撤单全链路闭环（issue #40 演进）**：
   - **后端桥**：在 TradingBridge 增加 cancelOrderFromGui(market, orderId, symbol)；在 dispatchBridgeRequest 注册 DELETE /trade/order 端点（校验 market 与 id 参数）；
   - **前端 API**：在 api.ts 增加 cancelGuiOrder(market, orderId, symbol)；
   - **UI 交互**：在 TradeDesk.tsx 挂单表格增加操作列及撤单按钮，支持撤单中状态（cancelingId）与反馈提示；
   - **多语言**：在 contract.ts 与语言包字典增加 trade.action、trade.cancel、trade.canceling、trade.cancelSuccess、trade.cancelFailed。
3. **交易台多市场普适化**：
   - QuoteStage.tsx 移除了对 market === 'crypto' 的硬编码限制，交易台开关在全市场均可使用；
   - 下单方法 onSubmitGuiOrder 动态传递当前活跃市场 activeMarket；
   - 撤单成功与下单成功后均自动触发 refreshTradeDesk() 立即刷新持仓与挂单列表。
4. **美股盘口与基本面补齐**：
   - 在 connector-alpaca 的 AlpacaRestClient 与 AlpacaMarketDataService 中实现标准 getOrderbook 方法，消除盘口栏降级状态；
   - 在 connector-finnhub 中实现 getFundamentals，解析 PE、PB、PS、市值、52 周高低点并返回标准 StockFundamentals。

## Verification

- connector-alpaca: 构建通过，10 个单测全绿（含 orderbook 与标准化 balance 测试）；
- connector-bybit: 构建通过，15 个单测全绿（含 trade-gate 闸门全景测试）；
- connector-futu: 构建通过，7 个单测全绿；
- connector-finnhub: 构建通过，11 个单测全绿；
- connector-qmt: 构建通过，12 个单测全绿；
- client-ui-trading: 构建通过（含 client.js bundle），16 个测试套件 126 个单测全绿（含 DELETE /trade/order 测试）；
- **全工程门禁**：pnpm build 与 pnpm test 全量 102 个测试套件、735 个用例 100% 绿灯。
