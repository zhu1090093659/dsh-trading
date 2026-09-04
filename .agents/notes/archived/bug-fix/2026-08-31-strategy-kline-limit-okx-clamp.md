# Agent Note: 策略回测 K 线拉取上限对齐 OKX 300 根限制与 6 大范式回测验证

Archived: 2026-09-04
Status: implemented

## Problem

在策略板块点击「运行回测」时，OKX 市场报错：
```
策略计算异常: TRADING_EXCHANGE_ERROR: OKX klines: limit must be an integer within 1..300, got 500
```

根因分析：
1. OKX 公共 REST 端点 `/api/v5/market/candles` 单次请求硬上限为 300 条 K 线（`packages/connector-okx/src/rest.ts` 严格校验 `limit <= 300`）。
2. `StrategyView.tsx` 回测执行器中写死了 `fetchKlines(market, symbol, '1d', 500)`，请求了 500 根，触发了连接器的校验拒绝。

## Decision

1. 将 `StrategyView.tsx` 中 `fetchKlines` 的拉取数量由 500 根调整为 300 根：
   - 对齐 OKX 单次 300 根的上限约束（Binance 等其他交易所支持 1000 根，300 属于全交集兼容值）。
   - 300 根日 K 能够完全覆盖 6 大范式中回溯周期最长策略的需求（SMA200 需 200 根、12M 动量需 250 根）。
2. 在 `packages/strategies/test/paradigms.test.ts` 中构建了包含牛市、震荡、宽幅波段的 300 根时序数据集，对 6 大参考范式策略进行了全量回测覆盖测试：
   - 短线：唐奇安通道突破 (`donchian-breakout`)、RSI 极值均值回归 (`rsi-reversion`)
   - 波段：EMA 双均线趋势跟踪 (`ema-crossover`)、布林带下轨均值回归 (`bollinger-reversion`)
   - 长线：200 日均线牛熊择时基线 (`sma-baseline`)、12 个月动量择时 (`momentum-12m`)
3. 增加短历史样本（50 根）、空数据集等边缘场景测试，确保全部 6 种范式策略均能鲁棒执行且无未捕获异常。

## Alternatives considered

- **在连接器内部自动分批分页拉取 500 根**：增加网络往返延迟与分页拼接复杂度；300 根日 K 已经包含近 10 个月交易日数据，完全满足单标的交互式快速回测的场景定位。

## Consequences

- OKX 与全市场所有连接器均可在 300 根日 K 下顺畅执行回测。
- 全仓 66 个测试套件（482 个用例全部通过），重新打包并刷新 `trading-web` profile 验证通过。
