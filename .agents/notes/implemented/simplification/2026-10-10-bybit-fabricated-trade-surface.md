# Agent Note: Bybit 伪账户读面改为失败关闭（保留占位服务与闸门）

Status: implemented

## Problem

Bybit 连接器把自己注册进路由交易面（`tradingTradeRegistry`），但它的账户读面返回编造值：硬编码 `USDT available/total = 100000`、恒空的持仓/挂单/成交、编造的 `status: new` 订单。这些值经 base 的账户工具与 GUI 桥到达模型与用户，而工具文案把它们声明为「交易所账户真值（live）」，并写明「可选方法缺席 ⇒ TRADING_NOT_IMPLEMENTED，不是零余额/无持仓」。触发条件是设置页把 crypto 的 provider（或 tradeProvider）切成 `bybit`。

## Decision

读面改为失败关闭，占位服务与闸门原样保留：

- `packages/connector-bybit/src/index.ts`：删可选方法 `getBalances`/`listOpenOrders`/`listTradeFills`（缺席即走消费方既有的 notImplementedError 路径）；必需方法 `getOrder`/`getPositions` 抛 `TradingServiceError(TRADING_NOT_IMPLEMENTED)`，文案分别写明「不可用 ≠ 订单不存在」「不可用 ≠ 没有持仓」；非契约方法 `getBalance`（转发硬编码常量）删除。
- `packages/connector-bybit/src/rest.ts`：删除硬编码 100000 的 `getBalance()`。
- 保留：数据面注册（含交易面注册）、`placeOrder`/`cancelOrder` 的本地模拟回执与三态闸门、服务键与类本身——占位服务的保留是[服务缝闸门](../../implemented/feature/2026-09-01-service-seam-order-gate.md)的既有裁决。
- `docs/guides/connectors-guide.md` 的 Bybit 行从「签名交易」改为「行情免密（账户/交易面未实现）」。

## Alternatives considered

- **连占位服务与注册一起删（接入手册的「仅行情」范式）**：与[服务缝闸门](../../implemented/feature/2026-09-01-service-seam-order-gate.md)第 6/7 条「占位连接器的 TradeService 同样可被 inject 直调，必须同矩阵过闸」相抵，落选。
- **保留读面、只加「模拟」文案**：模型面对的是工具返回值而不是文档，同形回执靠文案区分不可靠，落选。
- **补 Bybit v5 真实签名实现**：属新功能（签名、限频、错误映射、模拟盘头、实盘授权路径），超出简化范围，本记录不妨碍日后重接。

## Consequences

- `pnpm --filter @dshtrading/connector-bybit test`：6 个文件 36 例全绿，其中新增 `test/account-read-surface.test.ts` 5 例（可选方法缺席、必需方法拒绝、错误文案、dry-run 回执不回归），过 `pnpm test:audit` 棘轮。
- 模型/GUI 侧：crypto 路由到 bybit 时，`crypto_get_balances`/`crypto_get_positions`/`crypto_get_order` 与桥的 balances/positions 端点在 bybit 名下给出结构化 not-implemented，不再有 100000 或空数组冒充账户状态。工具名与数量不变。
- 仍然存在的邻接缺口（本记录范围外，另行裁决）：live 档（`dryRun=false` 且已获实盘授权）仍走本地 sim stub 回执；当前没有 Bybit 下单工具、GUI 桥强制 `dryRun=true`，可达面只有动态包 inject 直调。
