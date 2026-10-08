# 加密永续名册真值复验（可达环境补测，2026-10-08）

- 卡：`7c7b7e3d`（P2/P3 的「出口阻断」硬停）；母设计 [docs/roadmap/crypto-perp-and-tradfi.md](../../docs/roadmap/crypto-perp-and-tradfi.md)。
- 结论绑 commit：`25d18c7bbbc7191951b82fbc263b9deafe4d64e0`（代码 + 探针）；复验时刻 2026-10-08T12:42Z，出口 IP `188.253.121.148`（新加坡节点）。
- 复现：把出口切到可达地域后跑 `node_modules/.bin/tsx spikes/impl-crypto-perp-tradfi/run-reverify-probe.ts`（探针自带 20 条判据，不满足即退出码 1）。

## 0. 一句话

Binance USDT-M 与 Bybit 线性名册的真值已在**可达出口**取得并逐条复验：**20 条判据全过、探针退出码 0**（含 `crypto_get_ticker` 底层服务路径的真价）；
并因此发现并修好两处与真值不符的解析 —— Binance 原来会漏掉整批 **217 行 TradFi 永续**，
Bybit 原来把交易所自带的 `symbolType` 分类字段整个丢掉。
本机默认出口（美国节点 `216.195.208.136`）**仍然是 451/403**：阻断事实未变，变的是"本机另有一个可达出口"。

## 1. 默认出口的阻断事实（现场复跑）

| 端点 | 本机默认出口结果 | 原始响应 |
|---|---|---|
| `fapi.binance.com/fapi/v1/exchangeInfo` | HTTP **451** | [binance-geo-block.json](binance-geo-block.json) |
| `api.binance.com/api/v3/exchangeInfo` | HTTP **451** | 同上 |
| `api.bybit.com/v5/market/instruments-info?category=linear` | HTTP **403** | [bybit-egress-blocked-linear-instruments.json](bybit-egress-blocked-linear-instruments.json) / [.headers](bybit-egress-blocked-linear-instruments.headers) |

响应体：Binance `Service unavailable from a restricted location`；Bybit `The Amazon CloudFront distribution is configured to block access from your country`。

## 2. 可达出口的定位（本机 clash/mihomo 多地域节点）

方法：经 mihomo 控制器 unix socket（`/var/run/clash-verge-service/users/501/verge-mihomo.sock`，v1.19.32，TUN + mixed-port 7890）
把规则组 `Proxies` 的出口切到目标地域，再用 `curl -x http://127.0.0.1:7890` 探两个端点。
扫描结论与逐地域结果落档在 [reachable-egress-scan.json](reachable-egress-scan.json)：

| 出口 | IP | Binance `/fapi/v1/ping` | Bybit `instruments-info` |
|---|---|---|---|
| SG | 188.253.121.148 | 200 | 200 |
| JP | 212.87.194.60 | 200 | 200 |
| HK | 216.236.45.163 | 200 | 200 |
| TW | 185.220.236.133 | 200 | 200 |
| DE | 45.142.247.98 | 200 | 200 |
| KR | 158.247.222.153 | 200 | 200 |
| GB | 51.241.130.199 | 200 | 200 |
| **US（本机默认）** | 216.195.208.136 | **451** | **403** |

规则组在扫描前后都是 `US`：切换只覆盖抓取窗口（数十秒），结束后还原并用 `api.ipify.org` 复核（探针每次运行也都自带还原 trap）。
**这不是仓库配置的一部分**：出口地区是机器状态，本文件记录的是"当时用哪个出口取到的真值"。

## 3. 原始响应（字节保真；`spikes/** -text` 不做行尾转换）

| 文件 | HTTP | 大小 | 内容 |
|---|---|---|---|
| [binance-usdm-exchangeInfo.json](binance-usdm-exchangeInfo.json) | 200 | 1.12 MB | Binance USDT-M 名册全量，924 行 |
| [binance-spot-exchangeInfo-index.json](binance-spot-exchangeInfo-index.json) | 200 | 1 KB | 现货名册 17.7 MB 不落全量，只落计数/状态分布/样本 |
| [bybit-linear-instruments.json](bybit-linear-instruments.json) | 200 | 838 KB | Bybit 线性名册全量，893 行（单页，`nextPageCursor` 为空） |
| [bybit-spot-instruments.json](bybit-spot-instruments.json) | 200 | 286 KB | Bybit 现货名册全量，528 行 |
| [binance-usdm-ticker-BTCUSDT.json](binance-usdm-ticker-BTCUSDT.json) / [TSLAUSDT](binance-usdm-ticker-TSLAUSDT.json) | 200 | 376 B | 合约 24h 行情（真实价 82345.00 / 374.28） |
| [binance-usdm-klines-BTCUSDT.json](binance-usdm-klines-BTCUSDT.json) | 200 | 431 B | 合约 K 线 |
| [bybit-linear-ticker-BTCUSDT.json](bybit-linear-ticker-BTCUSDT.json) / [TSLAUSDT](bybit-linear-ticker-TSLAUSDT.json) | 200 | 880 / 841 B | 线性合约行情（`retCode:0`，真实价 82339.7 / 374.34） |
| [bybit-linear-kline-BTCUSDT.json](bybit-linear-kline-BTCUSDT.json) | 200 | 375 B | 线性合约 K 线 |
| [reverify-summary.json](reverify-summary.json) | — | 4 KB | 连接器解析 + 请求 URL 轨迹 + 出口 IP + HEAD sha + 20 条判据结果 |

## 4. 上游真值（2026-10-08 实测）

### 4.1 Binance USDT-M（`contractType/status/underlyingType` 全量分布）

| 字段 | 实测分布 |
|---|---|
| `contractType` | PERPETUAL **703** / `TRADIFI_PERPETUAL` **217** / CURRENT_QUARTER 2 / NEXT_QUARTER 2 |
| `status` | TRADING 789 / SETTLING 134 / PENDING_TRADING 1 |
| `underlyingType` | COIN 704 / EQUITY 179 / HK_EQUITY 15 / COMMODITY 8 / KR_EQUITY 8 / PREMARKET 4 / INDEX 3 / CN_EQUITY 2 / FX 1 |
| `underlyingSubType` | 加密 `["PoW","Crypto"]` 之类；TradFi `["TradFi"]`；Pre-IPO `["Pre-IPO","TradFi"]`；加密指数 `["Index","Crypto"]` |
| `contractSize` | **924 行里 0 行携带**（USDT-M 没有该字段）⇒ `contract.multiplier` 只能缺省，不能补 1 |
| `filters` | PRICE_FILTER / LOT_SIZE / MARKET_LOT_SIZE / MAX_NUM_ORDERS / MIN_NOTIONAL / PERCENT_PRICE 各 924 行 |
| `marginAsset` | USDT 879 / USDC 39 / USD1 3 / U 2 / BTC 1 |

代表行（**TradFi 归属只取自这些交易所字段**）：

| symbol | contractType | underlyingType | underlyingSubType | 连接器 assetClass |
|---|---|---|---|---|
| `BTCUSDT` | PERPETUAL | COIN | ["PoW","Crypto"] | crypto |
| `TSLAUSDT` | TRADIFI_PERPETUAL | EQUITY | ["TradFi"] | equity |
| `TENCENTUSDT` / `SAMSUNGUSDT` / `CXMTUSDT` | TRADIFI_PERPETUAL | HK_EQUITY / KR_EQUITY / CN_EQUITY | ["TradFi"] | equity |
| `XAUUSDT` / `CLUSDT` | TRADIFI_PERPETUAL | COMMODITY | ["TradFi"] | commodity |
| `OPENAIUSDT` | TRADIFI_PERPETUAL | PREMARKET | ["Pre-IPO","TradFi"] | equity |
| `USDBRLUSDT` | TRADIFI_PERPETUAL | FX | ["TradFi"] | **留空**（枚举无外汇成员） |
| `SPXUSDT` | PERPETUAL | COIN | ["Meme","Crypto"] | **crypto**（SPX6900 迷因币，不是标普 500） |
| `BTCDOMUSDT` / `ALLUSDT` | PERPETUAL | INDEX | ["Index","Crypto"] | index |
| `DEFIUSDT` | PERPETUAL | INDEX | ["Index"] | 被 `status=SETTLING` 排除 |

### 4.2 Bybit（线性 893 行 + 现货 528 行）

| 字段 | 实测分布 |
|---|---|
| 线性 `contractType` | LinearPerpetual **853** / LinearFutures 40；`status` 全为 Trading |
| 线性 `symbolType` | 空串 502 / `stock` 202 / `innovation` 128 / `ETF` 54 / `commodity` 4 / `forex` 3 |
| 现货 `symbolType` | 空串 514 / `xstocks` 11（NVDAXUSDT、AAPLXUSDT 等代币化股票）/ `adventure` 3 |
| `contractSize` | 线性 893 行里 **0 行携带**（与 Binance 同） |
| `lotSizeFilter.qtyStep` / `priceFilter.tickSize` / `leverageFilter.maxLeverage` | 893 / 893 / 893 行齐全（`contract` 三项因此都有值） |
| `settleCoin` | USDT 825 / USDC 68 |

代表行：`BTCUSDT`（空串，tick 0.1 / qty 0.001 / 杠杆 150）、`TSLAUSDT`（`stock`，tick 0.01 / qty 0.01 / 杠杆 100，`fullName`=Tesla、`underlyingTicker`=TSLA、`marketRegion`=US）、`XAUUSDT`（`commodity`）、`EURUSDUSDT`（`forex`，留空）、`SPXUSDT`（空串，迷因币）。

## 5. 连接器复验实跑（可达出口，退出码 0）

20 条判据全 PASS（名册/资产类别/端点分流/真实价/工具路径五组），关键数字：

- Binance 名册 **2160**（1375 spot + **785 perp**）；perp 的 assetClass：crypto 566 / equity 208 / commodity 8 / index 2 / 留空 1（`USDBRLUSDT-SWAP` 即 FX）。
  校验：785 = (PERPETUAL 568) + (TRADIFI 217)；equity 208 = EQUITY 179 + HK 15 + KR 8 + CN 2 + PREMARKET 4。
- Bybit 名册 **1381**（528 spot + **853 perp**）；perp 的 assetClass：留空 465 / crypto 128 / equity 256 / commodity 4。
  校验：853 = 空串 462 + innovation 128 + stock 202 + ETF 54 + commodity 4 + forex 3；equity 256 = stock 202 + ETF 54。
- 请求 URL 轨迹 9 条：永续 ticker 打 `https://fapi.binance.com/fapi/v1/ticker/24hr` + `/fapi/v1/ticker/bookTicker`（**不是** `api.binance.com/api/v3`）；
  Bybit `crypto_get_ticker` 的底层调用只打 `/v5/market/tickers?category=linear`，**全程无 `category=spot`**。
- 真实价：Binance `BTCUSDT-SWAP` 82345.00、`TSLAUSDT-SWAP` 374.28；Bybit `TSLAUSDT-SWAP` 374.34 / 374.21（两次运行）。
- `SPXUSDT-SWAP` 判为 **crypto**（交易所 COIN/Meme），`USDBRLUSDT-SWAP` 留空 —— 两个反例都在场。
- **工具路径**：`crypto_get_ticker` 的 `execute` 就是 `marketData.getTicker(symbol)`（`connector-{binance,bybit}/src/index.ts`），
  探针用与工具**同一个服务类**再走一遍真实网络：Bybit `TSLAUSDT-SWAP` 374.21、Binance `BTCUSDT-SWAP` 82345（两条 PASS）。
  工具注册层（cordis `ctx.tools`）未在探针里启动，这里的判据覆盖到服务方法这一层。

## 6. 因此改了两处（commit `25d18c7b`）

1. **Binance** `packages/connector-binance/src/rest.ts`：`contractType` 白名单加 `TRADIFI_PERPETUAL`（`BINANCE_PERPETUAL_CONTRACT_TYPES`）；
   `underlyingType` 映射表登记 HK_EQUITY / KR_EQUITY / CN_EQUITY / PREMARKET（FX 故意不登记，留空）。
   原来只认 `PERPETUAL`：**217 行 TradFi 永续整批进不了名册**（TSLAUSDT-SWAP 这种标的根本搜不到）。
2. **Bybit** `packages/connector-bybit/src/rest.ts`：新增 `bybitAssetClassOf(symbolType)`，现货与线性同一规则 ——
   stock/ETF/xstocks→equity、commodity→commodity、innovation/adventure→crypto；**空串（交易所没给分类）与 forex/mstocks 留空**，不推断。
   原来把 `symbolType` 整个丢掉：**263 行 Bybit TradFi 永续（stock 202 + ETF 54 + commodity 4 + forex 3）全部无类别**。

判据测试 3 条（`connector-binance/test/market-data.test.ts`、`connector-bybit/test/perp-market-data.test.ts`），断言用实测字面量：
TRADIFI_PERPETUAL + 各地区股票/Pre-IPO 归 equity、FX 留空、无 `contractSize` 时 `contract` 不出现 `multiplier`；
Bybit symbolType 五种取值各归其类、现货 xstocks 归 equity。
验证：`connector-binance` 6 files / **51 passed**；`connector-bybit` 5 files / **31 passed**；两包 `pnpm build` 通过。

## 7. 仍未闭合 / 待人决策

- **枚举缺口（契约层）**：Binance `FX`（USDBRLUSDT-SWAP）与 Bybit `forex`（EURUSDUSDT-SWAP 等 3 个）在 `InstrumentAssetClass`（crypto|equity|commodity|index）里没有成员 ⇒ 现在一律**留空**（漏标而非错标）。
  要不要加 `fx` 属 P1 契约决定，本连接器不擅自扩枚举。
- Bybit 官方枚举里还有现货 `mstocks`，本轮 528 行现货里未出现 ⇒ 未登记（不按文档猜）。
- Binance 现货名册原始响应 17.7 MB 未落全量（只落 [索引](binance-spot-exchangeInfo-index.json)）；要全量重跑探针。
- 可达出口依赖本机代理节点：真值本身是交易所的（TLS 直连真实域名、无 MITM），但"哪台机器能取到"取决于出口地区；换机器需重新找可达出口。
