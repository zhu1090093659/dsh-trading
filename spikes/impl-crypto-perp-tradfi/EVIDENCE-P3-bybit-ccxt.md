# P3 spike：Bybit 合约行情 + CCXT 显式现货（证据）

- 母任务：`docs/roadmap/crypto-perp-and-tradfi.md` P3（卡 ee77ee36）。
- 抓取时间：2026-10-08T10:07Z；出口 216.195.208.136（直连与 `-x http://127.0.0.1:7890` 同一出口 IP）。
- 方法：curl 原始响应落盘 + 连接器 lib 构建 + fetch 注入单测（URL 断言）。

## 1. 硬停：Bybit 出口被地域阻断（本轮真实网络验证不可达）

| 主机 | 端点 | 结果 | 证据 |
|---|---|---|---|
| api.bybit.com | `/v5/market/tickers?category=linear&symbol=BTCUSDT` | HTTP 403 | `bybit-egress-blocked-linear-ticker-BTCUSDT.headers/.json` |
| api.bybit.com | `/v5/market/tickers?category=spot&symbol=BTCUSDT` | HTTP 403 | `bybit-egress-blocked-spot-ticker-BTCUSDT.headers/.json` |
| api.bybit.com | `/v5/market/tickers?category=linear&symbol=TSLAUSDT` | HTTP 403 | `bybit-egress-blocked-linear-ticker-TSLAUSDT.headers/.json` |
| api.bybit.com | `/v5/market/instruments-info?category=linear&limit=5` | HTTP 403 | `bybit-egress-blocked-linear-instruments.headers/.json` |
| api.bytick.com / api-demo.bybit.com / api.bybit.nl | 同端点 | HTTP 403 | 同批探测（响应体：`The Amazon CloudFront distribution is configured to block access from your country`） |
| api.bybit.com（经 `-x http://127.0.0.1:7890`） | 同端点 | HTTP 403 | 代理出口 IP 与直连相同（216.195.208.136），换不掉地域 |

**结论**：本出口对 Bybit 全量 403 ⇒ P3 的「Bybit 合约 ticker 真实值」在本机**无法复现**，
与 Binance `api.binance.com`/`fapi.binance.com` 全量 451 同类（设计 §4 风险表的处置纪律：
不得按公告标题或旧证据断言已支持）。

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
  `listInstruments` 现货∪线性永续并集 + 游标翻页 + contract 透传 + assetClass 留空。
- CCXT：`-SWAP` 入参对 ticker（binance/bybit）与 kline 断言抛
  `TRADING_UNSUPPORTED_SYMBOL` 且**零请求**；现货路径仍打 `api.binance.com/api/v3` 与
  `api.bybit.com/v5/market/tickers?category=spot`。

## 4. 未验证（blocked，待可达环境补测）

- Bybit linear/spot 端点的真实报价（收尾判据 `crypto_get_ticker symbol=TSLAUSDT-SWAP` 真合约价）。
- Bybit `instruments-info` 的真实行字段：`contractType`/`status` 词汇、
  `contractSize` 是否存在、`lotSizeFilter.qtyStep`/`priceFilter.tickSize`/`leverageFilter.maxLeverage` 命名。
  实现对缺失字段一律缺省（`contract` 全缺则不下发），拿到真实响应后须复核。
- Bybit 是否上架 TradFi 永续（决定 assetClass 是否可能从交易所元数据获得）——本轮一律留空。
