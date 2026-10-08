# Agent Note: 合约交易 Tier 2——杠杆/保证金语义与闸门（P7）

Status: implemented

## Problem

Tier 1（只读面：`form`/`assetClass`/`contract` 元数据、名册与行情分流）落地后，合约交易面仍有五处缺口，且都是「安全语义」而非「功能缺失」：

1. **杠杆/保证金模式未接线**：OKX 的 `tdMode` 永续写死 `cross`，`POST /api/v5/account/set-leverage` 没有调用点——逐仓（isolated）与杠杆调整在连接器里无法表达，用户只能在交易所网页手动设。
2. **张↔币换算的取整会向上跳档**：`normalizeSize` 用 `Math.floor(amount / step + 1e-9)`。商落在整数下方 1e-9 以内时（浮点表示误差的常见形态），加法把商推过整数，结果向下取整成 **多一张**——与「向下保守，绝不上取放大敞口」的注释相反。
3. **强平/保证金读数缺失**：`getPositions` 只回带价格与杠杆，`liqPx`/`mgnRatio`/`mgnMode`/`notionalUsd` 全部丢弃；`crypto-risk-checklist` 的「强平价与标记价距离」判据没有数据源，只能回到本地公式倒算（口径随保证金模式/账户级参数变化，倒算给出错误的安全感）。
4. **闸门只覆盖下单/撤单**：`base` 的 `ORDER_GATE_PATTERN` 只匹配 `<market>_(place|cancel)_order`。杠杆/保证金变更同样是改变交易所真实风险参数的实盘动作，却不进审批面——headless 部署下无人应答也无从拦截。
5. **Binance 的 `-SWAP` 下单语义含糊**：`SPOT_SYMBOL_PATTERN` 拒绝含连字符的输入，报的是 `invalid symbol`；调用方读不出「合约下单未实现，且绝不回落现货端点」这层语义。

文档与 skill 同期还写着「合约只读」（`crypto-risk-checklist` 第 6 条、`docs/current-state.md`），与代码事实不符。

## Decision

**契约（`@dshtrading/api`，唯一家）**：`Position` 增 `liquidationPrice?`/`marginRatio?`/`marginMode?`/`notionalUsd?`（全可选、交易所口径、缺席即不补算）；新增 `MarginMode = 'cross' | 'isolated'`、`SetLeverageRequest`/`LeverageSetting`、`OrderRequest.marginMode?`、`TradeService.setLeverage?`（可选方法，不实现的连接器缺席即 `TRADING_NOT_IMPLEMENTED`）。全部 additive，老实现零改动。

**OKX（`connector-okx`）**：

- `rest.ts` 抽出唯一换算实现 `coinsToContracts`/`contractsToCoins`：张数 = 币数 / `ctVal`，按 `lotSz` 向下取整；容差改为相对量级（`Number.EPSILON` 量级）并加一次硬性比较兜底（步进结果超过请求量就退一档），任何输入都不上取。`ctVal` 缺席即结构化拒绝，不按 1:1 猜乘数。
- `tdMode` 由 `OrderRequest.marginMode` 决定（缺省 `cross`）；现货订单传 `marginMode` → `TRADING_UNSUPPORTED_SYMBOL`（现货杠杆/逐仓是另一个未接线产品面，不静默回落 `cash`）。
- 新增 `OkxTradeService.setLeverage`（`POST /api/v5/account/set-leverage`，`instId/lever/mgnMode/posSide?/ccy?`）：与 `placeOrder` 共用同一套三态闸门（① `dryRun=false` 未获实盘授权 → `TRADING_LIVE_TRADING_DISABLED`；② 缺省/true → 本地回执不触网；③ 已授权 → 真实签名，`env=demo` 带 `x-simulated-trading: 1`）。仅永续可设；请求倍数超过交易所规格 `lever` → 结构化拒绝，**不静默截断**。
- 新增工具 `crypto_set_leverage`（dryRun 缺省 true；回执带 `note` 说明模拟路径不校验交易所上限），与 `crypto_place_order` 一同注册在 `tradingCryptoTrade` 面。
- `getPositions` 透传 `liqPx`/`mgnRatio`/`mgnMode`/`notionalUsd`；缺席即缺席。

**Binance（`connector-binance`）**：`-SWAP` 下单在参数校验第一步按 `instrumentFormOf` 显式报 `TRADING_UNSUPPORTED_SYMBOL`（消息点明合约下单未实现、绝不回落现货端点）；行情面维持 Tier 1 的 fapi 分流不变。

**审批闸门（`@dshtrading/base`）**：模式改名为 `LIVE_ACTION_GATE_PATTERN`——「一切会改变交易所真实风险参数的实盘动作」，当前集合 = `<market>_(place|cancel)_order` + `crypto_set_leverage`；`ORDER_GATE_PATTERN`/`isOrderGateTool`/`decideOrderGate` 保留为同实现的旧名别名（消费方兼容），判定逻辑改名为 `decideLiveActionGate`。新增同类动作必须加进模式，不得让实盘动作绕过审批面。

**知识归属**：`crypto-risk-checklist` 拥有加密/TradFi 永续（新增「杠杆与保证金模式」节与「清单归属」表，第 6/7 条改为下单接线与强平口径）；`futures-risk-checklist` 新增归属节，明确国内期货与交易所合成永续互不映射。

**不在本仓**：额度/mandate 的合约口径（现货 `leverage=1` 永不命中）在私有卫星仓 `dsh-trading-bot` 的 tradectl，本仓只提供交易所侧语义与读数，不接线该面。

## Alternatives considered

- **把 `setLeverage` 做成独立 connector 服务键（而非 `TradeService` 可选方法）**：放弃——多一个服务键就多一处闸门与装配面；可选方法缺席即 `TRADING_NOT_IMPLEMENTED`，与 `getBalances`/`listOpenOrders` 同款降级语义，收益相同。
- **请求杠杆超过上限时静默截断到最大值**：放弃——调用方以为「50x 已生效」而实际是 5x，是与「不猜不补位」相冲突的静默改写；结构化拒绝并给出上限数字更可解释。
- **dry-run 路径也去交易所校验上限**：放弃——第 ② 档的全部价值是「不发任何请求」；代价是模拟回执不校验上限，用回执 `note` 明说这一点。
- **本地公式推算强平价**：放弃——强平口径依赖保证金模式、账户级保证金与维持保证金率，倒算会给出看起来精确的错误读数；只透传交易所字段，缺席即未知。
- **Binance 直接实现 USDⓈ-M 签名下单**：放弃（本轮）——Binance 连接器没有签名/凭证/授权面，新造一整条实盘路径远超本卡范围，且与「无实现即显式拒绝、不回落」的既有纪律冲突更小；先给结构化拒绝，真要开通另立卡。
- **保持 `ORDER_GATE_PATTERN` 原名并悄悄扩正则**：放弃——名字会与「只覆盖下单」的既有认知冲突；改名 + 旧名别名既保鲜又不破坏消费方。

## Consequences

- 合约交易在本仓自洽：下单（含保证金模式）、杠杆设置、强平/保证金读数、审批闸门、风险清单各就各位；dry-run 仍是缺省，实盘仍需人工签署授权 + 审批（headless ask=deny）。
- 张↔币换算只有一个实现（`rest.ts`），且「只向下取整」有回归样本（`0.299999999999` 币 ÷ `ctVal=0.1` 必须得 2 张；旧实现得 3 张）。
- 闸门集合扩容是**加动作必须改模式**的纪律入口；漏加一个实盘动作就等于漏一条审批路径。
- 剩余风险（接受）：`isolated` 与双向持仓模式的 `posSide` 由调用方提供，连接器不查询账户持仓模式；交易所参数错误会以 `TRADING_EXCHANGE_ERROR` 原样返回。
- 跨仓缺口（如实记录）：额度/mandate 判定仍在卫星仓，合约口径落地前，本仓的「能下单」不等于自动交易平面会放行。
- 验证：`packages/connector-okx/test/contract-trading.test.ts`（18 例：换算向量、`setLeverage` 三态矩阵、超限拒绝、`tdMode` 分流、持仓字段）、`packages/base/test/live-action-gate.test.ts`（6 例）、`packages/connector-binance/test/place-order.test.ts`（`-SWAP` 拒绝 1 例）、`packages/connector-okx/test/activation.test.ts`（工具名册 10 个）。`pnpm test:audit` 无新增测试债；仓库门禁 `pnpm gates:all` 在提交 `551901d9` 的干净工作区现场复跑 ⇒ **14 通过 / 0 失败**（含 build、`-r test`、覆盖率棘轮、typecheck 棘轮、docs-link）。
