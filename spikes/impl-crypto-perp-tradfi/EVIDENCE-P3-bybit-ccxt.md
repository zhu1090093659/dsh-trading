# P3 spike：Bybit 合约行情 + CCXT 显式现货（证据）

- 母任务：`docs/roadmap/crypto-perp-and-tradfi.md` P3（卡 ee77ee36）。
- 抓取时间：2026-10-08T10:07Z；出口 216.195.208.136（直连与 `-x http://127.0.0.1:7890` 同一出口 IP）。
- 方法：curl 原始响应落盘 + 连接器 lib 构建 + fetch 注入单测（URL 断言）。

## 1. 本机出口被地域阻断（可达出口已补测转正）

| 主机 | 端点 | 结果 | 证据 |
|---|---|---|---|
| api.bybit.com | `/v5/market/tickers?category=linear&symbol=BTCUSDT` | HTTP 403 | `bybit-egress-blocked-linear-ticker-BTCUSDT.headers/.json` |
| api.bybit.com | `/v5/market/tickers?category=spot&symbol=BTCUSDT` | HTTP 403 | `bybit-egress-blocked-spot-ticker-BTCUSDT.headers/.json` |
| api.bybit.com | `/v5/market/tickers?category=linear&symbol=TSLAUSDT` | HTTP 403 | `bybit-egress-blocked-linear-ticker-TSLAUSDT.headers/.json` |
| api.bybit.com | `/v5/market/instruments-info?category=linear&limit=5` | HTTP 403 | `bybit-egress-blocked-linear-instruments.headers/.json` |
| api.bytick.com / api-demo.bybit.com / api.bybit.nl | 同端点 | HTTP 403 | 同批探测（响应体：`The Amazon CloudFront distribution is configured to block access from your country`） |
| api.bybit.com（经 `-x http://127.0.0.1:7890`） | 同端点 | HTTP 403 | 代理出口 IP 与直连相同（216.195.208.136），换不掉地域 |

**本机默认出口（美国节点）对 Bybit 全量 403**，与 Binance `api.binance.com`/`fapi.binance.com` 全量 451 同类，
原因都是出口地区（响应体自证：CloudFront 按国家拦截）。**换出口地区即可达**：2026-10-08 用同一台机器的 clash/mihomo
地域节点（SG/JP/HK/TW/DE/KR/GB 逐个实测，表见 [reachable-egress-scan.json](reachable-egress-scan.json)）对 Bybit 与 Binance 全部 200，
真实响应与连接器复验见 [EVIDENCE-reverify-2026-10-08.md](EVIDENCE-reverify-2026-10-08.md)（commit `25d18c7b`，20 条判据全过）。

## 2. 可达期既有证据（形状依据，非本轮实测）

- `spikes/impl-crypto-derivatives/bybit-linear-tickers.json`（2026-09-02T06:16:47Z）：
  `GET /v5/market/tickers?category=linear&symbol=BTCUSDT` 回 `retCode:0`，行内含
  `lastPrice/prevPrice24h/price24hPcnt/volume24h/markPrice/indexPrice/openInterest/fundingRate`。
  本轮实现的 linear 分流沿用该行形状（与 spot 同字段名）。

## 3. 本轮已验证（可复现命令）

```
pnpm --filter @dshtrading/connector-bybit --filter @dshtrading/connector-ccxt build
pnpm --filter @dshtrading/connector-bybit --filter @dshtrading/connector-ccxt test
```

- Bybit：`-SWAP` 入参对 ticker/kline/orderbook/recent-trade 断言请求 URL 为 `category=linear`
  且不含 `category=spot`（未登记路由的 fetch 注入缝直接失败）；现货形仍打 `category=spot`；
  `listInstruments` 现货∪线性永续并集 + 游标翻页 + contract 透传 + assetClass 由 `symbolType` 字面量裁决
  （stock/ETF/xstocks→equity、commodity→commodity、innovation/adventure→crypto；空串与 forex/mstocks 留空）。
- CCXT：`-SWAP` 入参对 ticker（binance/bybit）与 kline 断言抛
  `TRADING_UNSUPPORTED_SYMBOL` 且**零请求**；现货路径仍打 `api.binance.com/api/v3` 与
  `api.bybit.com/v5/market/tickers?category=spot`。

## 4. 补测结论（2026-10-08 可达出口，commit `25d18c7b`）

- **真实报价已拿到**：`crypto_get_ticker` 底层 `getTicker('TSLAUSDT-SWAP')` → `retCode:0`、
  `category=linear`（URL 轨迹全程无 `category=spot`），真实价 374.34 / 374.21（两次运行）；
  `BTCUSDT-SWAP` 82339.7。原始响应 [bybit-linear-ticker-TSLAUSDT.json](bybit-linear-ticker-TSLAUSDT.json) /
  [bybit-linear-instruments.json](bybit-linear-instruments.json)。
- **真实行字段已逐条复核**：`contractType` = LinearPerpetual 853 / LinearFutures 40，`status` 全 `Trading`；
  `contractSize` **893 行里 0 行携带**（实现按缺省处理是对的）；`lotSizeFilter.qtyStep` / `priceFilter.tickSize` /
  `leverageFilter.maxLeverage` 三项 893/893 行齐全（`contract` 因此有 tickSize/lotSize/maxLeverage/settleCcy）。
- **Bybit 确实上架 TradFi 永续，且交易所自带分类字段 `symbolType`**（原判断"不携带资产类别字段"有误）：
  线性 `stock` 202 / `ETF` 54 / `commodity` 4 / `forex` 3；现货 `xstocks` 11（代币化股票）。
  `assetClass` 已改为由该字段裁决；空串（无分类）与 forex/mstocks 仍留空（枚举无外汇成员）。
- 仍未闭合：`forex` 类标的（EURUSDUSDT-SWAP 等 3 个）与 Binance `FX` 无枚举成员，要不要加 `fx` 属契约层决定。
