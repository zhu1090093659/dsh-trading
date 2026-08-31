# Agent Note: 内置技术指标插件 MA / EMA 扩展支持最多 6 个周期

Status: implemented

## Problem

此前 `@dsh-trading/indicators` 与 `@dsh-trading/client-ui-indicators` 内置的趋势指标周期偏少：
- `MA`：仅预设 3 周期（5/10/20）
- `EMA`：仅预设 2 周期（12/26）

主流证券与行情终端（如富途牛牛、TradingView）普遍支持 6 条均线，以便兼顾超短线（5/10）、中线（20/30/60）与中长线（120/250）。

## Decision

1. **参数规格与默认值**：
   - `MA`：`n1` ~ `n6`（`周期1` ~ `周期6`），默认 `5, 10, 20, 30, 60, 120`，取值 `0 ~ 250`。
   - `EMA`：`n1` ~ `n6`（`周期1` ~ `周期6`），默认 `5, 10, 20, 30, 60, 120`，取值 `0 ~ 250`。
2. **0 周期隐藏机制**：
   - `compute(bars, params)` 中过滤 `period <= 0` 的项，用户将周期设为 0 时对应均线自动隐藏不画，兼顾极简看图（如只要 2~3 条均线）与全量看图需求。
3. **视觉调色板对齐（富途 6 均线风格）**：
   - 维护 `MA_COLORS` 与 `EMA_COLORS`，提供 6 种高对比度色（黄 `#e6b800`、蓝 `#4a90e2`、紫 `#c05fd8`、绿 `#2ba471`、橙 `#f97316`、青 `#0ea5e9`）以及兜底调色板 `FALLBACK_PALETTE`。
4. **图表状态与 Agent 工具协同**：
   - `chart-state` 默认激活 6 周期 MA 实例。
   - `<market>_get_indicators` 工具默认全算输出序列数同步扩展至 22 条（MA 6 + EMA 6 + BOLL 3 + MACD 3 + RSI 1 + KDJ 3）。

## Consequences

- 满足用户与交易员对丰富均线系统的需求，同时允许设 0 隐藏。
- 自动化测试用例（`registry.test.ts`、`tool.test.ts`、`chart-state.test.ts`）全绿；全仓库 19 包 `pnpm build` 与 58 测试套件（420 tests）全部通过。
