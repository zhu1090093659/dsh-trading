# Agent Note: Bybit 伪账户读面改为失败关闭（保留占位服务与闸门）

Status: proposed

## Problem

Bybit 连接器把自己注册进**路由交易面**（`tradingTradeRegistry`）。占位服务与模拟下单是[服务缝闸门](../../implemented/feature/2026-09-01-service-seam-order-gate.md)刻意保留的设计，问题不在注册本身，而在**读面返回编造值**：这些值经 base 的账户工具与 GUI 桥到达模型与用户，工具文案却把它们声明为交易所账户真值。

注册与触发路径：

- `packages/connector-bybit/src/dataplane.ts:43-48` 把 `BybitTradeService` 注册为 `crypto/bybit`；`packages/crypto/cordis.patch.yml:32-35` 默认 `enabled: true`。
- `packages/router/src/index.ts:230` `activeTradeProvider = tradeProvider ?? provider`：把 crypto 的 provider（或 tradeProvider）设为 `bybit` 是设置页的正常操作。

编造读面（无任何「模拟/未知」标记，与真值同形）：

- `packages/connector-bybit/src/rest.ts:546-548` `getBalance()` 硬编码 `USDT available/total = 100000`。
- `packages/connector-bybit/src/index.ts:209-220` `getBalance`/`getBalances` 把该值包成账户余额（catch 分支返回空数组）。
- `packages/connector-bybit/src/index.ts:261-284` `getOrder()` 编造 `status: new`、`quantity: 0` 的订单；`getPositions()`/`listOpenOrders()`/`listTradeFills()` 恒返回空数组。

消费面（为什么它不是内部死码）：

- `packages/base/src/market-tools.ts:310/332/359/392/411` 注册 `<market>_get_positions|_get_orders|_get_fills|_get_balance|_get_order`，把注册面里那个服务的结果原样返回；同文件 `:60-72` 的 `notImplementedError` 与 `:307-308` 的 `accountNote` 写明「账户真值（live）」与「可选方法缺席即 TRADING_NOT_IMPLEMENTED，不是零余额/无持仓」。
- `packages/bot-api/src/bridge.ts:839`（positions）与 `:844-847`（balances）走同一注册面，GUI 的资产/委托页签同源。

契约面：必需方法 `getOrder`/`getPositions`（`packages/api/src/index.ts:723-724`）不能靠「缺席」降级，必须自己拒绝；可选方法 `getBalances`/`listOpenOrders`/`listTradeFills`（`:729/:735/:740`）缺席即由消费方 `notImplementedError` 拒绝。同仓正面对照：`packages/connector-yahoo/src/index.ts:295-301` 对「实盘执行未实现」直接抛 `TradingServiceError(TRADING_NOT_IMPLEMENTED)`。

## Proposal

只改读面，不动服务缝与闸门：

1. 删可选方法 `getBalances`/`listOpenOrders`/`listTradeFills`（`index.ts:213-220`、`:278-284`）与只为它们存在的 `rest.ts:546-548` 假余额；base 侧按既有「可选方法缺席」路径拒绝，文案已就位。
2. 必需方法改为显式拒绝：`index.ts:261-272` 的 `getOrder` 与 `:274-276` 的 `getPositions` 抛 `TradingServiceError(TRADING_NOT_IMPLEMENTED)`，与 yahoo 先例同形，不再返回编造订单或空数组。
3. `index.ts:209-211` 的 `getBalance` 同样拒绝（它现在转发硬编码常量）。
4. 保留：注册面（`dataplane.ts:43-48`）、模拟下单与撤单（`index.ts:222-259`）、三态闸门、服务键与类本身——占位服务的保留是既有裁决，本记录不改它。
5. 文档对齐：`docs/guides/connectors-guide.md:58` 的 Bybit 行仍写「签名交易」，与实现不符，改为「行情免密；账户/交易面按 TRADING_NOT_IMPLEMENTED 拒绝」。

## Context & Efficiency Impact

- 消失的维护面：约 25 行伪读方法与它们的 REST 常量，以及「Bybit 账户面到底是不是真的」这个每轮复核。
- 工具面与上下文零变化：不新增也不删除工具名；crypto 的只读账户工具族不变，只是 bybit 路由下从编造值变成结构化拒绝。
- 语义收益：模型不会再读到 100000 USDT 的「账户真值」，也不会把空数组当成「没有持仓」。

## Alternatives considered

- **连占位服务与注册一起删（按接入手册的「仅行情」范式）**：更彻底，但与[服务缝闸门](../../implemented/feature/2026-09-01-service-seam-order-gate.md)第 6/7 条「占位连接器的 TradeService 同样可被 inject 直调，必须同矩阵过闸」相抵；那是有意的安全设计，不应因本次清理推翻。落选。
- **保留读面、只加「模拟」文案**：模型面对的是工具返回值而不是文档；同形回执靠文案区分不可靠。落选。
- **补 Bybit v5 真实签名实现**：能力方向正确但属新功能（签名、限频、错误映射、模拟盘头、实盘授权路径都要实现与实测），超出简化范围；本记录不妨碍日后重接。
- **只改 GUI 桥过滤**：工具面仍暴露同一注册面，问题只修一半。落选。

## Verification & Gates

- `pnpm --filter @dshtrading/connector-bybit test`：先取现状基线；改语义需同步调整用例并过 `pnpm test:audit`（新写用例走 BDD 命名、零 mock）。
- 新增判据：crypto 路由到 bybit 时，`crypto_get_balances`、`crypto_get_positions`、`crypto_get_order` 与桥 `GET /dshtrading/api/trade/balances` 必须给出 not-implemented 语义，且不得出现 `100000` 或用空数组冒充账户状态。
- `pnpm gates:all`（14 条）绑 HEAD sha 现场复跑；`pnpm repo-boundary:check`、`pnpm live-trading:check` 不受影响（未新增实盘路径）。

## Risks

- GUI 交易抽屉在 bybit 路由下从「显示 100000」变为「显示不可用」；属能力修正而非回归，需按 ui-screenshot-verify 留截图作为验收证据。
- **本记录范围外的邻接缺口（另行裁决，不在本次实现内）**：live 分支（`index.ts:222-249`）在获得实盘授权且 `dryRun=false` 时仍走 `rest.ts:550-563` 的本地 sim stub 并回报「已成交」。当前没有 Bybit 下单工具、GUI 桥强制 `dryRun=true`（`packages/bot-api/src/bridge.ts:222`），可达面只有动态包 inject 直调；是否把占位服务的 live 档也改成 NOT_IMPLEMENTED，属「占位连接器 live 语义」的独立决定。
