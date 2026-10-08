# 加密永续与 TradFi 永续支持（落地设计）

> 本文是 **crypto 市场形态维度（现货/永续）与 TradFi 永续支持** 的落地设计与卡拆分。
> 契约词汇的权威在 [symbol-vocabulary.md](../guides/symbol-vocabulary.md)，验收状态在
> [current-state.md](../current-state.md)；本文只拥有「怎么拆、改哪、怎么算成」。
> 2026-10-08 立项，owner 裁决：方案 A（crypto 市场内加形态维度），永续与 TradFi 一起做。

## 0. 结论与范围

现状核实（2026-10-08，源码 + 真实网络）：

| 能力 | 现状 |
|---|---|
| 标的搜索 | 只有现货名册：Binance `/api/v3/exchangeInfo`（SPOT）、OKX `instType=SPOT`；静态字典与种子自选全现货 |
| 行情 | 工具描述写死现货；OKX 底层能收 `BTCUSDT-SWAP` 但名册里没有；Bybit/CCXT 硬编码 `category=spot` 与 `api.binance.com/api/v3` |
| 合约数据 | 已有（衍生品面板），但只读指标，不是可交易合约 |
| 下单 | Binance 只支持现货；OKX 能下永续 |
| TradFi | 仓内零支持（除 spike 留档的 Binance 公告标题） |

真实网络实测（OKX 可达；Binance/Bybit 本机默认出口 451/403，换出口地区后可测，补测见 spikes/impl-crypto-perp-tradfi/EVIDENCE-reverify-2026-10-08.md）：

- OKX `instType=SWAP` 共 **500** 个，全部 `state=live`，按交易所自带 `instCategory` 分布：**1 = 加密 301 个、3 = 股票/ETF 190 个、4 = 大宗 9 个**（XAU/XAG/XCU/XPT/XPD/BZ/CL/NG/H100）。
- TradFi 永续的 ticker / candles / funding-rate 三端点均正常（实测 TSLA 376.25、XAU 4135.7、AAPL 337.93、US500 7781.7）。
- **命名陷阱（硬证据）**：`SPX-USDT-SWAP` 报价 **0.384**、`instCategory=1`；`US500-USDT-SWAP` 报价 **7781.7**、`instCategory=3`。符号字面 "SPX" 在 OKX 是迷因币 SPX6900，标普 500 叫 US500。**TradFi 归属只能取自交易所元数据，禁止按符号猜。**
- Binance/Bybit 在本机默认出口（美国节点）分别全量 451/403（地域）；2026-10-08 已换可达出口补测：**Binance USDT-M 924 行**（`contractType` PERPETUAL 703 / `TRADIFI_PERPETUAL` 217）、**Bybit 线性 893 行**（`symbolType` stock 202 / innovation 128 / ETF 54 / commodity 4 / forex 3），TradFi 归属全部取自交易所字段。

范围内：OKX 与 Binance 的加密永续 + TradFi 永续，只读行情与标的检索（Tier 1）；合约下单另立卡（Tier 2）。
范围外：jin10 的 `global` 市场（XAUUSD 现货贵金属/外汇/指数，与 OKX 的 `XAU-USDT-SWAP` 是两个不同产品，**不合并、不互相映射**）；交割合约、期权、COIN-M。

## 1. 契约设计（方案 A：crypto 市场内加形态维度）

`market` 保持 `crypto`，新增正交的形态轴与资产标签。**不是**新市场键，**不是**把 form 塞进符号串拆解。

### 1.1 规范符号（`symbol-vocabulary.md` 的既有预留形，落地）

| 形态 | 规范形 | 例 |
|---|---|---|
| 现货 | `BASEQUOTE` | `BTCUSDT` |
| 永续 | `BASEQUOTE-SWAP` | `BTCUSDT-SWAP`、`TSLAUSDT-SWAP` |

输出恒为规范形（延续既有输出纪律）。连接器在 REST 边界互译：

- Binance：我们只登记 USDⓈ-M（`fapi`），`BTCUSDT` 与 `BTCUSDT-SWAP` 同形 → 由 **form** 决定打 `/api/v3` 还是 `/fapi/v1`；GUI 可直接双击换成对偶形态，无需用户拼后缀。
- OKX：`X-SWAP` → `X-SWAP`（原生 `BTC-USDT-SWAP` 已支持）；TradFi 与加密同规则，不设特例。

### 1.2 wire 与契约字段（新增，非破坏）

```ts
// @dshtrading/api
export type InstrumentForm = 'spot' | 'perp'          // 形态轴；缺省 = spot（老数据零迁移）
export type InstrumentAssetClass = 'crypto' | 'equity' | 'commodity' | 'index'  // 标签，仅展示与检索

export interface InstrumentRef {                        // 检索结果的最小元数据
  symbol: string
  name?: string
  form?: InstrumentForm
  assetClass?: InstrumentAssetClass
  /** 合约专有（仅 form=perp 有值）：交易所元数据原样透传，不本地推断。 */
  contract?: {
    multiplier?: number      // OKX ctVal / Binance contractSize
    tickSize?: number
    lotSize?: number
    maxLeverage?: number
    settleCcy?: string
  }
}
```

`MarketDataService.listInstruments` 的返回元素类型从 `{symbol,name?}` 放宽为 `InstrumentRef`（additive；现有 10 个实现里只改 crypto 四个，其余不动仍合法）。

同理扩 `WatchlistInstrument`（`packages/watchlist/src/index.ts`）与 `Instrument`（client types）、`SymbolInfoWire`（bot-api bridge）。**缺省 spot** ⇒ 已存自选、localStorage、iOS 契约零迁移。

### 1.3 三条硬不变量

1. **form 与 symbol 必须一致**：`form=spot` 而符号带 `-SWAP`（或反之）⇒ 连接器报 `TRADING_UNSUPPORTED_SYMBOL`，不静默纠正。
2. **TradFi 归属只信交易所元数据**（OKX `instCategory` / Binance `underlyingType`+`underlyingSubType`）；全额取不到时 `assetClass` 留空而不是猜。`SPX` 事故为判据样本。
3. **现货语义不得被合约语汇污染**：Bybit/CCXT 本轮若不做合约，必须维持「现货」行为并把 form 缺省为 spot，不允许 "顺手全改 linear"。

## 2. 分层与卡拆分

7 张卡：P1–P6 为 Tier 1（只读），P7 为 Tier 2（合约交易，单独立项、单独评审）。写入范围按包切分，彼此不重叠（除 P4 依赖 P1 的类型）。

| 卡 | 主题 | 写入范围（advisory） | 阻塞于 |
|---|---|---|---|
| P1 | api 契约：`form` / `assetClass` / `contract` + 规范文档 | `packages/api/src/index.ts`、`docs/guides/symbol-vocabulary.md`、`.agents/notes/**` | — |
| P2 | Binance + OKX：名册汇入永续、元数据透传、行情按 form 分流 | `packages/connector-binance/**`、`packages/connector-okx/**` | P1 |
| P3 | Bybit + CCXT：合约行情或显式保持现货 | `packages/connector-bybit/**`、`packages/connector-ccxt/**` | P1 |
| P4 | 检索面：静态字典、`instruments_search`、`/symbols` 的 form | `packages/router/**`、`packages/bot-api/src/bridge.ts` | P1 |
| P5 | GUI：侧栏形态、搜索、种子、文案 | `packages/client-ui-trading/**`、`packages/watchlist/**`、`packages/client-ui-settings/**` | P1,P4 |
| P6 | Agent 面与知识：工具描述规范形、风险清单、衍生品路由收口 | `packages/kit-crypto/**` | P1 |
| P7 | 合约交易（Tier 2）：下单/杠杆/保证金语义与闸门 | `packages/connector-okx/**`、`packages/connector-binance/**`、`packages/base/**` | P2,P3 |

P2 与 P3 包目录不重叠 → 可并发。P4 只依赖 P1 的类型定义 → 可与 P2/P3 并发，验收时用 P2/P3 的产物做端到端。P7 与 P2/P3 触碰同一批文件 → **必须串行且等 P2/P3 合并后**。

### P1 · api 契约与规范（地基，最小）

- api 加 `InstrumentForm` / `InstrumentAssetClass` / `InstrumentRef`；`listInstruments` 返回类型放宽（additive）。
- `symbol-vocabulary.md`：把「crypto（衍生品，预留）」行改为已落地，写明输出规范形与 form 一致性判据；补一行「TradFi 永续与 jin10 global 是两个产品」。
- 新建/更新 Agent Note（见第 5 节）。

### P2 · Binance + OKX 数据面

- **名册**：Binance `listInstruments` 改为现货 ∪ `/fapi/v1/exchangeInfo`（`contractType` ∈ {`PERPETUAL`, `TRADIFI_PERPETUAL`} 且 `status=TRADING`；实测 TradFi 永续用后者，只认前者会整批漏掉），输出 `BTCUSDT`（spot）+ `BTCUSDT-SWAP`（perp），`assetClass` 取自 `underlyingType`/`underlyingSubType`（实测字面含 HK_EQUITY/KR_EQUITY/CN_EQUITY/PREMARKET；FX 无枚举成员 ⇒ 留空）。OKX 改为 `instType=SPOT` ∪ `instType=SWAP`，`assetClass` 由 `instCategory`（1→crypto、3→equity、4→commodity）映射，`contract` 取 `ctVal/tickSz/lotSz/lever/settleCcy`。
- **行情**：`getTicker`/`getKlines` 按 form 选 base（Binance 现货 `api.binance.com` / 合约 `fapi.binance.com`；`/fapi/v1/ticker/24hr`、`/fapi/v1/klines`）；OKX 走既有 `instId` 互译即可。
- **form 传递**：`MarketDataService` 现有方法签名是 `(symbol, ...)`，而 `-SWAP` 后缀本身已能表达 form ⇒ **不新增 form 参数**，由符号后缀裁决；`form` 只出现在名册/检索/wire 元数据里。这条要写进 Note 以免后人再加一层参数。
- **降级纪律**：合约端点失败（地域 451、符号不存在）报结构化错误，绝不回落现货报价伪装成合约价。
- Binance 侧的可达环境原始响应已留档（`spikes/impl-crypto-perp-tradfi/binance-usdm-exchangeInfo.json` + EVIDENCE-reverify-2026-10-08.md），该硬停解除；残留契约决策：`FX`/`forex` 标的的 `assetClass` 现留空，加 `fx` 成员属 P1。

### P3 · Bybit + CCXT

- 二选一并在卡内写明：**做**（Bybit `category=linear` 的 ticker/kline/instruments；CCXT 用其统一接口但保持最小改动）或 **不做**（`normalizeCryptoSymbol` 剥掉 `-SWAP` 后仍走 spot 的行为要改成**显式拒绝**而不是静默打成现货语义）。
- 推荐：Bybit 合约**行情**做（成本低、覆盖面大），CCXT 本轮保持现货并把 `-SWAP` 显式报不支持。
- 判据：`crypto_get_ticker symbol=TSLAUSDT-SWAP` 在 Bybit 路由下要么给真合约价、要么明确报不支持，**不允许返回现货价**。

### P4 · 检索面

- `router/catalog.ts`：`CatalogEntry` 加 `form`/`assetClass`；crypto 静态字典补永续条目（与现货成对，如 `BTCUSDT`+`BTCUSDT-SWAP`），并补 TradFi 代表条目（`TSLAUSDT-SWAP` 等）作为**冷启动加速**，真实全集靠 P2 名册。
- `router/tools.ts`：`instruments_search` 加可选 `type: 'spot'|'perp'`；响应带 `form`/`assetClass`；提示词写明规范形与后缀。
- `bridge.ts /symbols`：`SymbolInfoWire` 透传 `form`/`assetClass`；30min 缓存键维持按 market（名册已含两形态，不需要新键）。
- 排序：同查询命中过多时，**优先 exact-match 与 crypto 资产类别**，避免 500 个 swap 把结果截断到全是 TradFi。

### P5 · GUI

- 侧栏搜索/添加：表单加形态切换（或结果自带形态徽标），`searchSymbols`/`searchAllMarkets` 支持 form 过滤；添加后自选行带形态。
- 种子（`watchlist/src/seeds.ts`）保持现货不变，新增的是"可检索到的永续"，不改默认首屏。
- 文案（`client-ui-trading/locales.ts`）：`spot`/`perp`/`TradFi` 的中英词条；K 线页面在 TradFi 合约上要有「标的为交易所合成合约、非股票本身」的说明位。
- 现货路径零回归：现货行的渲染、下单面板、指标页签行为必须与今天逐像素等价。

### P6 · Agent 面与知识

- `kit-crypto` 工具描述改为教规范形（`BTCUSDT-SWAP`）。
- **收口既有债**：`crypto_get_derivatives` 的数据源硬编码 Binance Futures（源码里自认：「与 crypto_get_derivatives 的硬编码 Binance 数据源不一致（审计既存项）」）⇒ 改为 registry-first，与 `crypto_get_derivatives_history` 同源。
- 资产知识随包分发（Skill）：`crypto-risk-checklist` 补 TradFi 合约条目（股票合约在现货闭市时仍报价、隔夜/跳空风险、交易所合成产品的对手方风险）；`crypto-instrument-analysis` 第零步补形态定位规则（`-SWAP` = 永续、TradFi 合约 ≠ 股票本身）。

### P7 · 合约交易（Tier 2，单独立项）

不做则在 Tier 1 完成后明确「合约只读」。要做须覆盖：杠杆与保证金模式（OKX `tdMode` 已按 instType 分流，但杠杆设置端点 `set-leverage` 未接线）、张↔币换算（`ctVal`，源码已实现部分）、强平与追保语义、合约仓位进 `getPositions`、额度/mandate 判据（现货口径 `leverage=1` 会永不命中，需合约口径）、以及 `futures-risk-checklist` 与 `crypto-risk-checklist` 的归属划分。**触碰交易安全语义，需单独评审 + 人签署**。

**已落地（2026-10-08，本仓）**：

- OKX：`crypto_place_order` 永续下单按 `marginMode` 分 `tdMode`（缺省 `cross`，`isolated` 需先设杠杆）；`quantity` 恒为 base 币数，`rest.ts` 的 `coinsToContracts`/`contractsToCoins` 是张↔币换算的唯一实现（`ctVal` + `lotSz` **向下**取整，浮点容差不得上取）；`crypto_set_leverage` 接线 `POST /api/v5/account/set-leverage`（超交易所上限即拒绝、不静默截断）；`getPositions` 回带 `liquidationPrice`/`marginRatio`/`marginMode`/`notionalUsd`（交易所口径，缺席不本地补算）。
- 闸门：杠杆/保证金变更与下单同门槛（服务缝三态 + 工具层 + base `LIVE_ACTION_GATE_PATTERN` 审批；headless ask=deny）；dry-run 仍是缺省，实盘仍需人工签署授权。Binance 路由下 `-SWAP` 下单显式 `TRADING_UNSUPPORTED_SYMBOL`，不回落现货端点。
- 知识归属：`crypto-risk-checklist` 拥有加密/TradFi 永续（含杠杆与保证金模式、强平口径），`futures-risk-checklist` 只管国内期货，两份清单各有归属表。
- **未落地（跨仓）**：额度/mandate 的合约口径判定（`leverage=1` 现货口径永不命中）在私有卫星仓 `dsh-trading-bot` 的 tradectl，本仓只提供交易所侧语义与读数；本仓不接线该面。
- 判据：`packages/connector-okx/test/contract-trading.test.ts`（换算向量/闸门矩阵/tdMode 分流/持仓字段）、`packages/base/test/live-action-gate.test.ts`、`packages/connector-binance/test/place-order.test.ts`（`-SWAP` 拒绝）。

## 3. 验收判据

### 3.1 卡级

| 卡 | 判据（可复现） |
|---|---|
| P1 | `pnpm -r build` 通过；api 类型新字段有单测断言；`symbol-vocabulary.md` 的互译表含 `-SWAP` 行 |
| P2 | 连接器单测：名册含 `BTCUSDT-SWAP` 且 `form=perp`；`TSLAUSDT-SWAP` 的 `assetClass=equity`；`SPXUSDT-SWAP` **不得**被判为指数；`getTicker` 对 spot/perp 分别打到 `/api/v3` 与 `/fapi/v1`（fetch 注入断言 URL）；真实网络证据入 `spikes/` |
| P3 | Bybit 合约 ticker 真实值；CCXT 的 `-SWAP` 显式 `TRADING_UNSUPPORTED_SYMBOL`；无任何路径把 `-SWAP` 落到 spot 端点 |
| P4 | `instruments_search query=BTCUSDT-SWAP` 与 `query=TSLA` 命中含 form 的行（当前必空）；`query=BTC` 结果里现货与永续都能出现且不被截断吞掉 |
| P5 | 侧栏能搜到并加入 `TSLAUSDT-SWAP`，报价/K 线渲染正常（OKX 路由）；截图存 `.local/acceptance/`；现货页签回归截图对比 |
| P6 | `crypto_get_derivatives` 在 provider=okx 时打到 OKX（fetch 断言），Binance 路由下行为不变；两个 Skill 的 diff 只增合约条目 |
| P7 | 已落地：dry-run 默认（服务缝不触网断言）、liveTrading 关闭时结构化拒绝、张↔币换算向量（含「略低于整数张不上取」回归样本）、`marginMode=isolated` → `tdMode=isolated`、超上限杠杆拒绝；Binance `-SWAP` 下单结构化拒绝 |

### 3.2 端到端（Tier 1 完成）

1. `instruments_search`：`BTCUSDT-SWAP`、`TSLAUSDT-SWAP`、`XAUUSDT-SWAP` 均命中且带 `form`/`assetClass`。
2. GUI：OKX 路由下加入 `TSLAUSDT-SWAP` → 报价、K 线、衍生品面板全部有数。
3. TradFi 归属抽样 20 个对照交易所元数据，`assetClass` 零错标（含 `SPX`/`US500` 反例）。
4. 现货零回归：默认组合（provider=binance）下现货自选、图表、下单 dry-run 与改动前一致；`pnpm gates:all` 绿；结论绑 HEAD sha 现场复跑。

### 3.3 不做完成的定义

Tier 1 完成**不等于**能交易合约。卡 P7 未落地前，任何界面与工具描述都不允许暗示可下合约单。

## 4. 风险与开放项

| 风险 | 处置 |
|---|---|
| OKX `instCategory` 无公开文档，语义靠实测反推 | P2 内加**元数据契约测试**（固定样本对照），并把「不可推断时留空」写进代码；`SPX` vs `US500` 作反例样本入夹具 |
| Binance/Bybit 地域阻断 | 本机默认出口 451/403 属实；换出口地区可达，2026-10-08 已补测转正（原始响应入 spikes/）。教训保留：不得凭公告标题断言已支持，必须拿到真实响应 |
| TradFi 合约 24/7 报价而股票有闭市时段 | P5 在合约图表上明示「交易所合成合约」；不把它当作股票行情替代 |
| TradFi 上市/下架频繁（实测 2026 年大量新上线） | 名册走动态全集 + 缓存，静态字典只做冷启动；下架标的不落自选硬编码 |
| 与 jin10 `global` 市场撞名（XAU） | 两个市场各自独立，标签区分；不做跨市场映射 |
| `form` 字段扩散到 iOS 冻结契约 | 缺省 spot ⇒ 老契约零改动；iOS 侧是否需要新字段单列（本轮不改 iOS） |

## 5. 记录与门禁

- 新建 **proposed** Agent Note：`.agents/notes/proposed/architecture/2026-10-08-crypto-instrument-form-and-tradfi.md`（Problem / Proposal / Context & Efficiency Impact / Alternatives considered / Verification & Gates / Risks）。
- **原地更新 Owning Note**（不新建重复）：`.agents/notes/implemented/architecture/2026-08-31-market-canonical-symbol-vocabulary.md`——其 Consequences 明写「crypto 衍生品规范形 `BTCUSDT-SWAP` 预留；Binance 永续原生形与现货同形（BTCUSDT）的歧义留待首个衍生品数据面落地时裁决」，本设计正是那次裁决，落地时把事实改为现在时并指向本文。
- 门禁：`pnpm gates:all`；新增测试遵守 `test:audit`（BDD 命名、零 mock、零 sleep）；覆盖率用 `coverage:update` 只升。新增任何 patch 行须跑 `patch-id-gate --update`（本轮预期无新行；P7 若加行则需登记）。
- 分支：跨多包新功能，按 `feat/<issue>-<短名>` 开分支并 PR；docs/note 的前置改动可直落 main。
