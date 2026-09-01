# Agent Note: 服务缝闸门——三态检查下推到 TradeService 实现（issue #29 / P0）

Status: implemented

## Problem

现皮下单三态检查（`evaluateOrderGate` + base `tools/pre-execute` 审批闸门）全部位于**工具层**。本仓即将开放 dsh-tool-cordis 动态包能力（P6，owner 2026-08-31 裁决 D5），其宿主半可以 inject `TradeService` 直调 `placeOrder/cancelOrder`，完全绕过工具层——实盘闸门存在结构性缺口。P6 开放前必须把闸门下推到服务缝（安全前置，无依赖）。

## Decision

1. **服务缝三态闸门**：所有持有 TradeService 的 connector（okx、alpaca、futu、ibkr、qmt、longbridge、tiger、bybit、ccxt、fmp、polygon、finnhub、tushare，共 13 个）在 `placeOrder` 实现内**第一步**执行与工具层同语义的三态检查：
   - ① reject（`dryRun=false` 请求实盘而 `liveTrading=false`）→ 抛结构化 `TradingServiceError('TRADING_LIVE_TRADING_DISABLED')`（api TradingError 词汇）；
   - ② simulate（dryRun 缺省/true，或 `config.dryRun` 强制）→ 本地模拟回执（`Order.dryRun=true`，不触网）；
   - ③ live（`dryRun=false` 且 `liveTrading=true`）→ 放行进入既有真实路径。
2. **撤单同门槛**：`cancelOrder` 第一步要求 `liveTrading=true && !config.dryRun`（与闸门 ③ 等价），否则结构化拒绝——撤单是会改变交易所真实状态的实盘动作，堵「经撤单接口绕过下单闸门影响真实订单」的旁路（此前 `liveTrading=false` 下撤单会真实触达交易所）。
3. **工具层不动**：`evaluateOrderGate`、base 审批闸门正则、工具文案全部保留（双保险）；okx 服务缝直接复用工具层同一个 `evaluateOrderGate` 函数（单点裁决），其余 connector 内联同语义判定（其工具层本无共享 gate 函数）。
4. **配置注入**：alpaca/ibkr/qmt/longbridge/tiger/bybit/ccxt/fmp/polygon/finnhub/tushare 的 TradeService 构造参数增加 `config: Config`（此前只有 okx/futu 持有 config），apply() 实例化同步传入。
5. **脚手架同步**：connector-template 的 TradeService 同步三态闸门，未来经 `scripts/new-connector.mjs` 生成的连接器继承该语义。
6. **binance 特例（如实记录）**：binance 没有 TradeService（实盘路径在工具内即 `TRADING_NOT_IMPLEMENTED`），不存在可被绕过的服务缝——fail-closed 由构造成立，工具层闸门已有测试覆盖（`place-order.test.ts` 三态矩阵），故不为其凭空造 service 类。
7. **占位连接器处置**：fmp/polygon/finnhub/tushare 的 rest 层虽是 sim stub，但其 TradeService 同样可被 inject 直调，按同矩阵过闸（issue「占位路径同样 fail-closed」的落实）；yahoo/stooq/tencent/eastmoney/akshare 无 TradeService，其工具 live 路径恒 NOT_IMPLEMENTED，维持现状。
8. **测试**：10 个 connector 各新增 `test/trade-gate.test.ts`（三态矩阵 + 撤单门槛 + 不触网断言，离线 stub fetch）；okx `trade.test.ts` 增服务缝直调用例，撤单幂等用例改用 `{dryRun:false, liveTrading:true}`（新门槛下撤单需显式解锁）。真实网络 dry-run 证据：`spikes/impl-service-seam-gate/`（okx 公共行情驱动富回执 + 服务缝拒绝实录）。

## Alternatives considered

- **共享 gate 辅助函数放 @dsh-trading/api**：api 是纯类型包（「本包不做运行时」是明文设计），拒绝。
- **放 base 再由 connector 依赖**：connector 是独立叶子插件，只依赖 api/indicators，为 3 行判定引入跨包依赖（还可能成环）不值得。
- **cancelOrder 仅拦 liveTrading 不拦 config.dryRun**：放弃——强制模拟配置下放行真实撤单，等于保留半个旁路；与闸门 ③ 语义（live 需 `liveTrading && !dryRun`）保持一致更可解释。
- **撤单在 liveTrading=false 时返回模拟成功回执**：放弃——「模拟撤单」语义为空（系统未放过实盘单），静默成功会掩盖调用方对真实订单的误解；结构化拒绝可读性更高。

## Consequences

- 绕过工具层的任何新消费面（动态包、未来 REST 面）默认拿不到实盘路径；P6 的硬前置成立。
- 行为变化：`liveTrading=false`（缺省）时撤单工具从「真实撤单」变为结构化拒绝——demo 场景需显式 `liveTrading=true`（env=demo 时仍打 OKX 模拟盘）。已有单测按新语义修正，无静默回归。
- 闸门逻辑在 13 个 connector 各有一份（okx 复用同一函数，其余内联同语义 3 行判定），延续本仓 per-connector 既有重复模式（`evaluateOrderGate`/`TradingServiceError` 本就 per-connector）；代价是语义修订需多文件同步，收益是 connector 保持零跨包耦合。
- 已知残余风险（设计文档 §5.4 如实记录，接受）：`liveTrading=true` 时动态包直调服务可绕过交互审批（服务层无 approval 上下文）——liveTrading 本身即用户显式授权声明；P6 skill 指南约束使用场景。
- tsc --noEmit 在部分 connector 存在**存量** exactOptionalPropertyTypes 报错（dataplane/rest 与脚手架 cancelOrder 签名），非本变更引入（CI 门禁为 build+test，未劣化）。
- 验证：`pnpm build` 全绿；`pnpm test` 549 通过（新增 65：okx 服务缝 5 + 10×connector 矩阵 60）；spike 证据见 `spikes/impl-service-seam-gate/NET-VERIFY.md`。
