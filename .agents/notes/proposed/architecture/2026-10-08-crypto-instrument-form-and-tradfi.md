# Agent Note: crypto 市场形态维度（现货/永续）与 TradFi 永续支持

Status: proposed

## Problem

加密数据的消费面目前**只有现货**这一种产品形态，搜索与行情都取不到永续，TradFi 永续更是完全不可见：

- 标的检索 = 注册表 `listInstruments()` ∪ 内置静态字典（`packages/router/src/tools.ts`），而 Binance 只列 `/api/v3/exchangeInfo` 的 SPOT、OKX 只列 `instType=SPOT`（`packages/connector-binance/src/rest.ts:310`、`packages/connector-okx/src/rest.ts:836`），静态字典与种子自选同样全现货（`packages/router/src/catalog.ts`）。
- 行情工具描述写死现货（`packages/connector-binance/src/index.ts:511`）；Bybit 与 CCXT 连底层都硬编码 spot（`packages/connector-bybit/src/rest.ts:134`、`packages/connector-ccxt/src/rest.ts:115`）。
- 规范词汇文档把 `BASEQUOTE-SWAP` 标为「预留词汇：连接器未实现衍生品时报 `TRADING_UNSUPPORTED_SYMBOL`」（`docs/guides/symbol-vocabulary.md`），从 2026-08-31 挂到现在没有落地。
- 既有衍生品能力是**只读指标面板**（OI/资金费率/多空比），不是可交易合约；Binance 下单工具只认现货（`SPOT_SYMBOL_PATTERN`）。

2026-10-08 真实网络实测把「TradFi 永续」这条线坐实：OKX `instType=SWAP` 共 500 个并全部 `state=live`，其中 190 个是股票/ETF（TSLA/NVDA/AAPL/SPY/QQQ/US500/JP225/KR200…）、9 个是大宗（XAU/XAG/XCU/XPT/XPD/BZ/CL/NG/H100），ticker/candles/funding-rate 三端点均正常。同一批数据里出现一条**必须记下来的命名陷阱**：`SPX-USDT-SWAP` 报价 0.384（迷因币 SPX6900），真正的标普 500 是 `US500-USDT-SWAP`（7781.7）——按符号字面猜资产归属会直接标错。

## Proposal

owner 2026-10-08 裁决：**方案 A**（在 `crypto` 市场内加正交的形态维度，而不是新增市场键），**永续与 TradFi 一起做**，**先只读、后交易**。

设计、卡拆分与验收判据见 [docs/roadmap/crypto-perp-and-tradfi.md](../../../../docs/roadmap/crypto-perp-and-tradfi.md)（唯一事实之家）。要点：

1. **形态轴而非新市场键**：新增 `InstrumentForm = 'spot' | 'perp'` 与 `InstrumentAssetClass`，走 `listInstruments` 返回元素、`SymbolInfoWire`、`WatchlistInstrument`、client `Instrument` 四处 additive 扩展；**缺省 spot** ⇒ 已存自选、localStorage、iOS 冻结契约零迁移。
2. **符号后缀表达形态，不加参数**：`BTCUSDT` / `BTCUSDT-SWAP` 即形态载体，`getTicker/getKlines` 不新增 form 形参；`form` 只出现在名册/检索/wire 元数据。Binance 现货与永续同形，靠 form 决定打 `/api/v3` 还是 `/fapi/v1`。
3. **TradFi 归属只信交易所元数据**：OKX `instCategory`（1 加密 / 3 股票 / 4 大宗）、Binance `underlyingType`+`underlyingSubType`；取不到即留空，禁止按符号猜。`SPX` vs `US500` 是判据样本。
4. **现货语义不被污染**：不做合约的连接器必须显式拒绝 `-SWAP`，不得剥后缀后静默按现货语义取数。
5. **jin10 的 `global` 不并入**：`XAUUSD`（现货贵金属）与 `XAU-USDT-SWAP`（合约）是两个不同产品，各自独立、不互相映射。
6. 卡拆分 P1–P7（P1 api 契约 / P2 Binance+OKX / P3 Bybit+CCXT / P4 检索面 / P5 GUI / P6 Agent 与知识 / P7 合约交易 Tier 2），写入范围按包目录切分互不重叠。

## Context & Efficiency Impact

- **Token/Schema**：`listInstruments` 返回体每行最多增 4 个可选标量 + 一个 5 字段可选 `contract` 对象；500 个 swap 的全量名册走既有 30min 进程内缓存与 GUI 按需拉取，不进 Agent 上下文。`instruments_search` 只增一个可选 `type` 参数。
- **上下文面**：新增能力对模型可见的是「规范形后缀 `-SWAP`」这一条知识（进 Skill 与工具描述），不是新的工具族——工具数量零增长。
- **构建面**：改动集中在 crypto 相关 10 余包；P2/P3 并发，P4 与两者并行，P7 串行后置。

## Alternatives considered

- **新增 `crypto-perp` / `crypto-tradfi` 市场键**：落选——契约最"干净"，但要动 `MarketId`/`MARKET_IDS`/`ORDER_GATE_PATTERN`/路由默认值/桥/自选/种子/iOS 契约，跨 15+ 包的指纹扩散与一次产品扩充的收益不匹配；且 `form` 与 symbol 已经天然一对一带形态。
- **只加一个 `instrumentType` 参数、符号形不动**：落选——与既有「规范符号形」体系冲突（Binance 现货与永续同形，无参数无法区分），且 GUI 侧栏「一行一标的」模型装不下同符号的两形态。
- **把 TradFi 永续归入 jin10 的 `global` 市场**：落选——产品、结算币、交易所、风控语义都不同（`XAUUSD` 是现货报价，`XAU-USDT-SWAP` 是 USDT 本位合约）；并表会让「一个事实只有一个家」失效。
- **按符号字面推断 TradFi 资产类别**：落选并被实测证伪——`SPX` 指向迷因币 SPX6900。
- **先做合约交易、行情顺带**：落选——下单引入杠杆/保证金/强平语义，触交易安全闸门，必须先只读后交易、单独评审。
- **本轮把 Bybit/CCXT 一并改合约**：落选（推荐按 P3 二选一，Bybit 合约行情做、CCXT 保持现货并显式拒绝 `-SWAP`）——CCXT 的"统一接口"会掩盖各所 category 差异，收益低于维护成本。

## Verification & Gates

- 卡级判据与端到端判据见设计文档 §3（含 `SPX`/`US500` 反例、现货零回归、真实网络证据入 `spikes/`）。
- 静态门禁：`pnpm gates:all`、`pnpm test:audit`（新测试合规）、`pnpm coverage:check`（只升）、`patch-id-gate`（本轮预期无新 patch 行）；连接器另需真实网络原始响应证据。
- 结论必须绑 HEAD sha 现场复跑。

## Risks

- OKX `instCategory` **无公开文档**，语义由实测反推（1/3/4 三档，样本 500）；已用元数据契约测试固定样本，并按「不可推断即留空」fail-closed。语义若被上游改动，测试会红。
- Binance/Bybit 在本机默认出口（美国节点）分别全量 451/403（地域），但**不是端点不可用**：2026-10-08 换出口地区后已实测转正（Binance USDT-M 924 行、Bybit 线性 893 行，20 条判据全过，commit `25d18c7b`）。教训保留：不得据公告标题断言已支持，必须拿到真实响应。
- TradFi 合约 24/7 报价而对应股票有闭市时段，且属交易所合成产品；界面须明示，不能当作股票行情替代品（该文案位归 P5）。
- 上市/下架频繁（实测 2026 年大量新上线与下线）：名册必须走动态全集，静态字典只做冷启动。
