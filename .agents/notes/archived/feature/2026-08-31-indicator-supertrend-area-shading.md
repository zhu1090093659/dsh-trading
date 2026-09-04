# Agent Note: 超级趋势（SuperTrend）多空双色与 Area 阴影渐变填充

Archived: 2026-09-04
Status: implemented

## Problem

此前 `@dsh-trading/indicator-supertrend` 仅输出单条固定绿色（`#26a69a`）的 `line` 序列 `ST`：
1. **单色无趋势辨识**：无法直观区分多头（上升）支撑位与空头（下降）阻力位。
2. **缺乏阴影填充**：图表渲染层此前仅支持 `line` 与 `histogram`，缺少 `AreaSeries` 渐变填充，无法呈现 OKX / TradingView 标准的半透明背景阴影带。

## Decision

1. **IndicatorOutput 契约与校验器扩展**：
   - `IndicatorOutput.kind` 增加 `'area'`。
   - 新增 `topColor`、`bottomColor`、`invertFilledArea`、`lineWidth` 属性。
   - `validateCustomIndicator` 同步支持 `'area'` 类型的合法性断言。
2. **TvChart 图表渲染器升级**：
   - 引入 Lightweight Charts `AreaSeries`，在 `createSeries` 中根据 `output.kind === 'area'` 挂载 `AreaSeries` 并绑定对应渐变色与反转填充方向。
3. **SuperTrend UP / DN 双色分段输出**：
   - 多头状态（`trend === 1`）：输出 `UP`（`kind: 'area'`，线色 `#2ba471`，`invertFilledArea: true`，向上淡绿渐变填充），`DN` 为 `undefined`。
   - 空头状态（`trend === -1`）：输出 `DN`（`kind: 'area'`，线色 `#e64545`，`invertFilledArea: false`，向下淡红渐变填充），`UP` 为 `undefined`。
   - 顶部读数栏与图例仅在当前光标位置显示生效中的趋势方向与数值。

## Consequences

- SuperTrend 视觉呈现与 OKX / TradingView 完全对齐：多头绿线+淡绿阴影、空头红线+淡红阴影、趋势反转平滑切换。
- 全仓单测（`definition.test.ts`、`validate.test.ts`）与全量构建通过。
