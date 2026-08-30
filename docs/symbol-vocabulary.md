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
| crypto（衍生品，预留） | `BASEQUOTE-SWAP` | `BTCUSDT-SWAP` | 预留词汇：连接器未实现衍生品时报 `TRADING_UNSUPPORTED_SYMBOL` |
| us | 纯大写 ticker | `AAPL` | Yahoo/Stooq 原生形即规范形 |
| cn | `NNNNNN.SH` / `NNNNNN.SZ` | `600519.SH`、`000001.SZ` | 大陆通行写法；裸 6 位数字为宽容输入（按首位推断：6/9→SH，0/3→SZ；北交所 4/8 暂不支持） |
| hk | `NNNNN.HK`（5 位补零） | `00700.HK` | 裸 1-5 位数字为宽容输入（`700` → `00700.HK`） |

## 连接器互译现状

| 连接器 | 市场 | 原生形 | 互译 |
|---|---|---|---|
| binance | crypto | `BTCUSDT` | 恒等（原生即规范） |
| okx | crypto | `BTC-USDT` / `BTC-USDT-SWAP` | 规范形按已知 quote 后缀表（USDT/USDC/USD/EUR/BTC/ETH/OKB，最长匹配）拆 base/quote 加横杠；输出反向去横杠 |
| tencent | cn/hk | `sh600519` / `hk00700`（wire） | 规范形 `600519.SH`/`00700.HK` ↔ wire 前缀小写形；输出用请求时的 wire 前缀还原规范形 |
| yahoo | us | `AAPL` | 恒等 |
| stooq | us | `aapl.us` | 小写化 + 补 `.us` 后缀（既有行为，输出规范大写形） |

## 给新连接器（手册补充条款）

新交易所连接器必须：`toNative(symbol)` 接受规范形 + 原生形；输出 symbol 一律规范形；
quote 后缀表按本所实际增补（表是连接器私有实现，规范只管词汇形态）。
Agent 知识（kit 的 SKILL.md）教模型说规范形，不教交易所方言。
