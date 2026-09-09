# Agent Note: client-ui-trading 内 errorPayload 重复实现收敛

Status: implemented

## Problem

`bridge.ts:521` 导出 `errorPayload`，`index.ts:374` 的 `errorPayloadOf` 与之逐字节同体（Error → {code?, message} 提取 + TRADING_UNKNOWN 兜底），而 index.ts 本就从 ./bridge.ts 导入其他符号——同包内纯重复，无任何存在理由。

## Decision

index.ts 改用 `bridge.ts` 导出的 `errorPayload`，删除本地 `errorPayloadOf`（唯一调用点 index.ts:298 换名）。零行为变化。

## Alternatives considered

- **顺手收敛 client 组件内联的 err→message（审计 F5 后半）**：核实后只有 QuoteStage.tsx:437 与 OrderPanel.tsx:197 两处同形（api.ts:211 的兜底文案是 'Network request failed'，语义不同不算重复）。两处一行表达式跨两个组件文件，抽共享 helper 的导航成本大于收益，否决。
- **收敛 fmtPercent（trading format.ts）与 formatPercent（strategies StrategyView.tsx）的呈现分叉**：两者占位符（— vs --）与符号策略（恒带 + vs 可选）是不同面板的呈现约定，统一会改变用户可见渲染；无同步修改史证据。呈现一致性问题应交 owner 决策而非优化流顺手改，否决。
- **统一各 client-ui 包 modules.d.ts 的 CSS 声明漂移（Readonly 有无）**：纯类型层、零运行时影响，否决。

## Consequences

- 同包双实现消除；包级 369 用例 + tsdown 构建全绿。
