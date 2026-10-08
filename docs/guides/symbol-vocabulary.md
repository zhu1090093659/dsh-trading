# 市场规范符号词汇（Market-Canonical Symbol Vocabulary）

> 2026-08-31 立规。动机：消费方（GUI 自选、Agent 工具参数、未来的工作流/回测）
> 此前直接说交易所原生方言——切换 provider（settings 路由/注册表热切换）后，
> 已存符号全部失效（实测：provider=okx 时自选里的 `BTCUSDT` 被 OKX 以
> `TRADING_UNSUPPORTED_SYMBOL` 拒）。交易平台形态下，用户的符号资产必须**与数据源
> 无关**。

## 三条规则

1. **消费方只说规范形**。GUI 自选、工具参数、存储（localStorage/未来的回测数据）
   一律用本文件定义的市场规范词汇。
2. **连接器在 REST 边界互译**。输入宽容：同时接受规范形与本交易所原生形（向后
   兼容 + 用户习惯），内部统一翻译为原生形发出请求；**输出一律规范形**
   （`Ticker.symbol` / `Order.symbol` / `Position.symbol`）——下游看到的永远是规范词汇。
3. **解析不了才报错**。`TRADING_UNSUPPORTED_SYMBOL` 只用于：任何已知词汇都解析不出、
   或产品形态不支持（如对只实现现货的连接器传 `-SWAP`）。「不是我家方言」不再是
   报错理由。

## 各市场规范形

| 市场 | 规范形 | 例 | 说明 |
|---|---|---|---|
| crypto（现货） | `BASEQUOTE` 大写无分隔 | `BTCUSDT`、`ETHBTC` | 加密圈多数派形（Binance/Coinbase/Kraken 同源）；选多数派降低用户认知成本 |
| crypto（永续） | `BASEQUOTE-SWAP` | `BTCUSDT-SWAP`、`TSLAUSDT-SWAP` | 2026-10-08 落地：形态轴 `form`（`spot`/`perp`，缺省 `spot`）与 `market=crypto` 正交，判据见下节「形态一致性」 |
| us | 纯大写 ticker | `AAPL` | Yahoo/Stooq 原生形即规范形 |
| cn | `NNNNNN.SH` / `NNNNNN.SZ` | `600519.SH`、`000001.SZ` | 大陆通行写法；裸 6 位数字为宽容输入（按首位推断：6/9→SH，0/3→SZ；北交所 4/8 暂不支持） |
| hk | `NNNNN.HK`（5 位补零） | `00700.HK` | 裸 1-5 位数字为宽容输入（`700` → `00700.HK`） |
| futures | `VARIANTNNNN.EXCHANGE`（品种大写 + 3-4 位年月 + 交易所后缀） | `RB2601.SHF`、`IF2612.CFE`、`IC2609.CFE` | 同花顺 thscode 形；后缀 SHF/INE=上期所/能源中心，DCE=大期所，CZC=郑商所，GFE=广期所，CFE=中金所；主力连续 `RB00.SHF` 由上游检索返回；中金所 8888 加权码（`IF8888.CFE` 等）上游目录登记但行情端点不供数，连接器列表/检索已剔除（2026-09-14） |
| global | 上游原生大写代码 | `XAUUSD`、`USOIL`、`USDJPY`、`SPX` | 金十数据原生形即规范形（现货贵金属/原油/铜、外汇、全球与 A 股指数共 97 个品种）；代码表经 `quote://codes` 动态全集注入，检索未命中时以原始大写形透传交上游裁决 |

## 形态一致性（现货 / 永续）

形态是 `market=crypto` 内与市场正交的一条轴（`form` 字段），**不是新市场键**，也不靠符号串拆解：

1. **后缀即形态**：带 `-SWAP` 为永续，不带为现货。行情方法（`getTicker`/`getKlines`/…）不新增 form 形参——符号本身就是形态载体；`form` 只出现在名册、检索结果与 wire 元数据里（`InstrumentRef`/`SymbolInfoWire`/`WatchlistInstrument`）。Binance 现货与永续在交易所侧同形（都叫 `BTCUSDT`），由名册的 `form` 决定打 `/api/v3` 还是 `/fapi/v1`。
2. **form 与符号必须一致**：`form=perp` ⟺ 符号带 `-SWAP`。不一致（`form=spot` 配 `BTCUSDT-SWAP`，或反之）由连接器报 `TRADING_UNSUPPORTED_SYMBOL`，**不静默纠正**。
3. **判据只有一份实现**：`SWAP_SYMBOL_SUFFIX` 与 `instrumentFormOf(symbol)` 由 `@dshtrading/api` 提供；连接器与检索面复用它，不各写一份后缀匹配。
4. **不做合约的连接器显式拒绝**：剥掉 `-SWAP` 后按现货语义取数（返回现货价）是禁止行为；未实现合约的路径必须报 `TRADING_UNSUPPORTED_SYMBOL`。
5. **TradFi 永续与 jin10 `global` 是两个产品**：`XAU-USDT-SWAP`（USDT 本位永续合约，交易所合成产品）与 `XAUUSD`（金十 `global` 市场的现货贵金属报价）各自独立，**不合并、不互相映射**。
6. **资产归属只信交易所元数据**：`assetClass` 取自 OKX `instCategory`、Binance `underlyingType`+`underlyingSubType`；取不到即留空，禁止按符号字面猜（`SPX-USDT-SWAP` 是迷因币 SPX6900，标普 500 是 `US500-USDT-SWAP`）。

## 连接器互译现状

| 连接器 | 市场 | 原生形 | 互译 |
|---|---|---|---|
| binance | crypto | `BTCUSDT` | 恒等（原生即规范） |
| okx | crypto | `BTC-USDT` / `BTC-USDT-SWAP` | 规范形按已知 quote 后缀表（USDT/USDC/USD/EUR/BTC/ETH/OKB，最长匹配）拆 base/quote 加横杠；输出反向去横杠 |
| tencent | cn/hk | `sh600519` / `hk00700`（wire） | 规范形 `600519.SH`/`00700.HK` ↔ wire 前缀小写形；输出用请求时的 wire 前缀还原规范形 |
| yahoo | us | `AAPL` | 恒等 |
| stooq | us | `aapl.us` | 小写化 + 补 `.us` 后缀（既有行为，输出规范大写形） |
| futu | hk | `HK.00700` | 规范形 `00700.HK` / 裸 1-5 位数字 / 原生形 `HK.00700` 互译（wire 恒 `HK.` + 5 位补零） |
| hithink | futures | `RB2601.SHF` | 近恒等：大写去空白透传（带/不带后缀均交上游裁决，品种→交易所映射不做本地硬编码，检索/代码表返回即规范形） |
| hithink | cn | `600519.SH` | `normalizeThsCode`：裸 6 位按首位推断 SH/SZ/BJ，`sh600519` 前缀形互译 |
| futu | us | `US.AAPL` | 规范形纯大写 ticker（接受 `US.AAPL` / `AAPL.US` / 类别股 `BRK.B`）↔ wire `US.AAPL` |
| jin10 | global | `XAUUSD` | 恒等（原生大写即规范形）；输入 trim + 大写化，未登记代码交 `get_quote` 裁决（未知品种报 `TRADING_UNSUPPORTED_SYMBOL`） |
| xysz | cn | `600519.SH`（AmazingData code+market 形即规范形） | 近恒等：接受规范形 / 裸 6 位 / `sh600519` 前缀形；输出恒为规范形。裸 6 位按首位推断 SH/SZ/BJ（6/9→SH，0/2/3→SZ，4/8→BJ）；港股与加密形态显式拒绝（fail-closed） |

## 给新连接器（手册补充条款）

新交易所连接器必须：`toNative(symbol)` 接受规范形 + 原生形；输出 symbol 一律规范形；
quote 后缀表按本所实际增补（表是连接器私有实现，规范只管词汇形态）。
Agent 知识（kit 的 SKILL.md）教模型说规范形，不教交易所方言。
