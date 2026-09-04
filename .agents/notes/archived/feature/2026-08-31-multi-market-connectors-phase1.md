# Agent Note: 全市场多连接器矩阵 Phase 1 交付 (Eastmoney, FMP, Finnhub, Longbridge, Bybit)

- **日期**: 2026-08-31
- **类型**: feature
- **状态**: implemented
Archived: 2026-09-04

## 变更背景与目标
用户要求为 A 股、美股、港股、加密货币全市场提供丰富的连接器选择（覆盖商业付费源与免密公共量化 API），并在 UI/路由配置层允许用户自主切换。

## 本次实施内容
1. **A 股**:
   - 交付 `@dsh-trading/connector-eastmoney`：支持东财全周期分钟 K 线（1m/5m/15m/30m/1h/1d/1w/1M）与五档快照、标的联想。
   - 接入 `@dsh-trading/cn` bundle 与 `cn-trader` preset。
2. **美股**:
   - 交付 `@dsh-trading/connector-fmp`：对接 Financial Modeling Prep，支持全周期分钟 K 线、实时报价与深度 Profile/基本面分析。
   - 交付 `@dsh-trading/connector-finnhub`：对接 Finnhub，支持全周期 Candles、实时 Quote 与公司市场新闻分析。
   - 接入 `@dsh-trading/us` bundle 与 `us-trader` preset。
3. **港股**:
   - 交付 `@dsh-trading/connector-longbridge`：对接长桥云端 OpenAPI，支持港股 1m~1M 分钟 K 线与实时快照、下单交易通道。
   - 接入 `@dsh-trading/hk` bundle 与 `hk-trader` preset。
4. **加密货币**:
   - 交付 `@dsh-trading/connector-bybit`：对接 Bybit API v5，支持现货/衍生品 1m~1M 分钟 K 线与实时 Ticker。
   - 接入 `@dsh-trading/crypto` bundle 与 `crypto-trader` preset。
5. **路由与设置 UI**:
   - 扩展 `@dsh-trading/router` 的 `PROVIDER_VOCABULARY`（收敛 12 大交易所词汇）。
   - 扩展 `@dsh-trading/client-ui-settings` 的 `PROVIDER_LABELS`，前端设置面板可直接选配 12 种数据源。

## 验证结论
- 全仓 26 个包构建 100% 成功 (`pnpm -r build`)。
- 全仓 291 个单元测试全部绿线通过 (`pnpm -r test`)。
