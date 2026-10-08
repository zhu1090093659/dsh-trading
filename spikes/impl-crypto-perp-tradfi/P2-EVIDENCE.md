# P2 证据：Binance + OKX 名册汇入永续与 TradFi 元数据（2026-10-08）

卡：P2 数据面（父卡 P1），来源 [docs/roadmap/crypto-perp-and-tradfi.md](../../docs/roadmap/crypto-perp-and-tradfi.md)。
写入范围：`packages/connector-binance/**`、`packages/connector-okx/**`（本目录为证据留档）。

## 1. 复现命令

```bash
node_modules/.bin/tsx spikes/impl-crypto-perp-tradfi/run-p2-roster-probe.ts
```

探针只读公共端点，直接调用两个连接器的**真实源码**（`OkxRestClient.listInstruments` /
`BinanceRestClient.listInstruments` / `getTicker`），原始响应落档在本目录。

## 2. OKX：可达，名册与 TradFi 元数据全部实测

`GET https://openapi.okx.com/api/v5/public/instruments`（HTTP 200）：

| 事实 | 实测值（2026-10-08） |
|---|---|
| SPOT 名册 | 1144 个，越 `state=live` |
| SWAP 名册 | 500 个，全部 `state=live` |
| SWAP instCategory 分布 | 1=加密 301、3=股票/ETF 190、4=大宗 9 |
| SPOT instCategory 分布 | 1=1013、3=127、4=4（SPOT 也带该字段，映射同一条规则） |
| 连接器名册总数 | 1644（1144 spot + 500 perp） |
| 形态↔符号一致性扫描 | 全部 1644 条 `symbol.endsWith('-SWAP') === (form === 'perp')` 为真 |

连接器解析后的代表条目（`contract` 为交易所元数据原样透传）：

| 规范符号 | form | assetClass | contract |
|---|---|---|---|
| `BTCUSDT` | spot | crypto | — |
| `BTCUSDT-SWAP` | perp | crypto | ctVal 0.01 / tick 0.1 / lot 0.01 / lever 100 / USDT |
| `TSLAUSDT-SWAP` | perp | equity | ctVal 1 / tick 0.01 / lot 0.01 / lever 25 / USDT |
| `XAUUSDT-SWAP` | perp | commodity | ctVal 0.001 / tick 0.1 / lot 1 / lever 100 / USDT |
| `US500USDT-SWAP` | perp | equity | ctVal 1 / tick 0.1 / lot 0.001 / lever 20 / USDT |

### 命名陷阱反例（硬证据，进夹具）

| 符号 | instCategory | 连接器 assetClass | 事实 |
|---|---|---|---|
| `SPX-USDT-SWAP` | 1 | **crypto** | 交易所侧是迷因币 SPX6900，**不是**标普 500 |
| `US500-USDT-SWAP` | 3 | equity | 标普 500 合约叫 US500 |

归属只取自交易所 `instCategory`；两种符号都**没有**被判成 `index`（`assetClass='index'` 在 OKX 数据面不会产生）。
单测固定样本：`packages/connector-okx/test/public-market-data.test.ts`（«SPX 永续是加密资产而不是指数»）。

原始响应：

- [okx-instruments-SWAP.json](okx-instruments-SWAP.json) —— SWAP 全量原始响应（500 行，含 instCategory/ctVal/lever/settleCcy）。
- [okx-instruments-SPOT-category-index.json](okx-instruments-SPOT-category-index.json) —— SPOT 原始响应 1.2MB 未全量落库，只落分类索引与样本；重跑探针可再取全量。

## 3. Binance：本机全量 HTTP 451，半边保持 blocked

四个端点（现货 + USDT-M 合约，名册与行情）全部 451，原始响应体见
[binance-geo-block.json](binance-geo-block.json)：

| 端点 | HTTP |
|---|---|
| `api.binance.com/api/v3/exchangeInfo` | 451 |
| `fapi.binance.com/fapi/v1/exchangeInfo` | 451 |
| `api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT` | 451 |
| `fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT` | 451 |

连接器在 451 下的行为（实测，不是推断）：

- `listInstruments()` → 结构化 `TRADING_EXCHANGE_ERROR`（`Binance /fapi/v1/exchangeInfo: 451 code=0 Service unavailable…`），**不返回半份名册**。
- `getTicker('BTCUSDT-SWAP')` → 结构化 `TRADING_EXCHANGE_ERROR`，请求全部落在 `/fapi/v1/`，**不回落现货报价**。

**结论（硬停）**：Binance 半边的代码路径与单测已落地（现货 ∪ 合约名册、form 分流、assetClass 映射），
但**没有任何真实网络原始响应**——按卡的要求，Binance 半边在拿到可达环境响应前保持 **blocked**，
不得据公告标题断言已支持。以下取值因此标注为**待验**：

- `underlyingType`/underlyingSubType 的具体字面（`COIN`/STOCK/EQUITY/INDEX/COMMODITY` 映射表）；
- `contractSize`、`filters[PRICE_FILTER].tickSize`、`filters[LOT_SIZE].stepSize`、`marginAsset` 的字段形状。

兜底纪律：映射表未登记的取值一律 `assetClass` **留空**（不按符号猜），因此待验风险的上限是
「漏标」而非「错标」。

## 4. 与卡级验收判据的对应

| 判据 | 证据 |
|---|---|
| 名册含 `BTCUSDT-SWAP` 且 `form=perp` | §2 表 + `connector-binance/test/market-data.test.ts` / `connector-okx/test/public-market-data.test.ts` |
| `TSLAUSDT-SWAP` 的 `assetClass=equity` | §2 实测（探针输出） |
| `SPXUSDT-SWAP` 不得被判为指数 | §2 反例 + 单测 «SPX 永续是加密资产而不是指数» |
| `getTicker` 对 spot/perp 分别打到 `/api/v3` 与 `/fapi/v1` | `connector-binance/test/market-data.test.ts`「形态分流」四条（fetch 注入断言完整 URL） |
| 真实网络证据入 `spikes/` | 本目录 |
