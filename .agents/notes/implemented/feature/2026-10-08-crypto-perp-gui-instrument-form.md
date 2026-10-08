# Agent Note: 加密永续与 TradFi 的 GUI 形态面（P5）——自选行形态、搜索形态过滤、种子不变、合成合约文案

Status: implemented

## Problem

P1–P4 已把形态轴落进契约与数据面：`form`（spot/perp）/ `assetClass` 在 [@dshtrading/api](../../../../packages/api/src/index.ts)（唯一判据 `instrumentFormOf` / `SWAP_SYMBOL_SUFFIX`），连接器名册汇入永续与 TradFi 元数据，检索面 `instruments_search type=` 与桥 `/symbols` 透传这两列。但**浏览器面仍只认「现货」一种形态**：

- 客户端 `fetchSymbols` 的类型只声明 `{ symbol, name? }`，桥已经送到的 `form`/`assetClass` 在客户端边界被丢掉——联想条目看不出哪一行是永续；
- 左栏与「自选管理」只能搜到并添加看不出形态的条目，添加后的自选行也不带形态，用户无法区分 `BTCUSDT` 与 `BTCUSDT-SWAP`；
- 中栏图表对 **TradFi 合成合约**（`TSLAUSDT-SWAP` 等）没有任何提示，容易被读成标的股票本身的行情（合约 24/7 报价，股票有闭市时段）；
- 种子自选（默认首屏）若被顺手改成永续，会改变所有用户的默认首屏——与「种子保持现货」的裁决冲突。

## Decision

- **形态的读侧判据只有一个**：新模块 [instrument-meta.ts](../../../../packages/client-ui-trading/src/client/instrument-meta.ts) 提供 `rowForm`（自选行/选中标的**只认符号后缀**，显式 `form` 不参与，杜绝展示漂移）、`entryForm`（检索条目**显式值优先**，缺省回落符号判据，与 router 的 `catalogFormOf` 同款）、`resolveAssetClass`、`isTradFiPerp`、`formBadgeKey`、`entryMeta`。它只产出 locale 键，文案家在 locales.ts。
- **资产类别绝不按符号猜**：`resolveAssetClass` 取显式元数据，缺省时才在**合并字典**（静态冷启动 ∪ 交易所名册）里按符号查，查不到即 `undefined`（未知按未知渲染，不声称 TradFi）。`SPX`（OKX 上是迷因币 SPX6900，标普 500 是 `US500`）是判据反例。
- **wire 全程保真，缺省即现货**：客户端 `SymbolInfo`/`HostWatchlistRow` 带回 `form`/`assetClass`；`WatchlistInstrument`（`@dshtrading/watchlist`，新增 `@dshtrading/api` 类型依赖）与客户端 `Instrument` 各加两个可选字段，内存/文件 store、`normalizeWatchlistRow`、host 桥的 `/watchlists`（POST/PUT/import）、`/selection`（GET/PUT）与客户端 host-sync 全部保真；桥侧用 `Record<联合, true>` 穷举表放行（联合增删字面量即编译失败），未知字面量整键丢弃。
- **现货不落多余键**：`entryMeta` 只在形态为 `perp` 时落 `form`，资产类别有值才落——现货行的落库形状与从前逐字段相同（「现货路径零回归」从数据面开始成立）。
- **左栏搜索有形态过滤**：目标市场为 crypto 时，添加表单出现形态过滤按钮（全部→现货→永续循环），过滤同时作用于本地字典（`searchSymbols`/`searchAllMarkets` 的 `form` 形参）与上游 `/symbols?query=` 在线联想（按 `entryForm` 二次过滤）；其它市场不出现该控件。
- **徽标只在永续上**：自选行/联想条目/自选管理表按 `formBadgeKey` 挂标——加密永续「永续」、股票/大宗/指数合约分别「股票合约/大宗合约/指数合约」；**现货不挂标**，因此现货行渲染保持不变。
- **TradFi 明示位落在图表页签**：选中标的判定为 TradFi 永续时，报价页在统计栏上方渲染 `[data-dshtrading-tradfi-notice]`，文案为「交易所合成合约 / 非股票本身；合约 24/7 报价，标的股票有闭市时段」（zh/en 双份）。
- **种子保持现货**：`WATCHLIST_SEEDS` 一字未改（14 行全现货），并新增判据测试按 `instrumentFormOf` 复核，任何人改种子都会被红灯挡住。

## Alternatives considered

- **只挂徽标、不做过滤**：落选——500 个永续会让 `TSLA` 这类查询的结果被同名前缀淹没，徽标解决「看得出」，过滤解决「找得到」。
- **在客户端存下 `form` 并以其为展示依据**：落选——`form` 与符号一旦不一致就会出现「符号是 `-SWAP`、界面显示现货」的静默漂移；展示层一律以符号后缀裁决，显式值只在检索条目面优先。
- **按符号字面推断资产类别**（如把 `US500` 判成指数、`SPX` 也判指数）：落选并被实测证伪（`SPX` 是迷因币）；OKX `instCategory` 只给到「股票/ETF」一档，界面因此按交易所元数据原样显示。
- **把种子自选换成永续行**：落选——默认首屏是所有用户的第一屏，改它等于把一次功能扩充变成一次存量视图变更。
- **新增 `crypto-perp` 市场键**：落选（设计阶段已否决，见 [设计 note](../../proposed/architecture/2026-10-08-crypto-instrument-form-and-tradfi.md)）——形态与符号已天然一一对应，新市场键要动 `MarketId`/路由/桥/自选/iOS 冻结契约。
- **过滤控件对所有市场常显**：落选——us/cn/hk 没有永续，常显一个必然筛空的控件只会误导。

## Consequences

- 左栏与自选管理都能搜到并添加 `TSLAUSDT-SWAP`，行上带「股票合约」徽标；中栏选中后报价页出现合成合约明示位。形态不再是只有 Agent 面才看得见的事实。
- 现货路径的行为由既有测试 + 新增判据共同钉住：`instrument-meta` 单测断言现货行不挂标、`entryMeta` 现货不落键；左栏/自选管理/报价页的 jsdom 冒烟覆盖永续徽标、形态过滤与明示位的正反两面。
- 资产的形态事实仍只有一个家（符号后缀 + `instrumentFormOf`），资产类别事实只有一个家（交易所元数据：静态冷启动字典 ∪ 动态名册），本变更没有新增第二份词汇表。
- **验收证据（绑 commit `d7b5a227`）**：在隔离 home（复制 profile + 覆盖本仓构建产物，**未触碰用户运行实例与 `~/.dsh-trading`**）实测 OKX 路由下 `/symbols?query=TSLA` 返回 `TSLAUSDT-SWAP`（`form=perp`、`assetClass=equity`）、ticker 374.1 与 3 根日 K 有数；headless Chrome 驱动 10 条交互断言全过（形态过滤循环 全部→现货→永续、现货行零徽标、加入永续后现货行稳定结构签名不变、TradFi 明示位、全程无异常）。截图与报告：`.local/acceptance/crypto-perp-gui-2026-10-08/`（本机证据，不入库）。
- **已知边界**：P7（Tier 2 合约交易）未落地前，界面只做只读展示与检索，不放行任何合约下单路径；资产类别取不到时界面按「永续（未知归属）」显示，不假装知道是股票还是大宗。
- 设计与卡拆分见 [crypto-perp-and-tradfi.md](../../../../docs/roadmap/crypto-perp-and-tradfi.md)（P5）；词汇权威见 [symbol-vocabulary.md](../../../../docs/guides/symbol-vocabulary.md)。
