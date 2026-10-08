# Agent Note: 加密永续数据面 P3 —— Bybit 合约行情与 CCXT 显式保持现货

Status: implemented

## Problem

P3 之前 Bybit 与 CCXT 的公共行情端点硬编码现货：Bybit 的 getTicker/getKlines/getOrderbook/getRecentTrades 全部写死 `category=spot`；CCXT 的 normalizeSymbol 先剥掉规范后缀 `-SWAP`，再拿同一个符号去打 `api.binance.com/api/v3`。两家的共同后果是**规范永续形入参被静默按现货取数**
（`crypto_get_ticker symbol=BTCUSDT-SWAP` 返回现货价且无提示）；Bybit 连名册都没有，永续在检索面完全不可见。

## Decision

- **Bybit 公共行情按规范后缀分流 category**：`-SWAP` → `linear`，否则 `spot`；覆盖 ticker / klines / orderbook / recent-trade，输出 symbol 恒为规范形。形态判据复用 `@dshtrading/api` 的 `instrumentFormOf`（唯一实现，见
  [symbol-vocabulary.md](../../../../docs/guides/symbol-vocabulary.md)「形态一致性」），连接器侧由 `parseCryptoSymbol` 集中产出 `{ base, form, canonical }`。
- **Bybit listInstruments = 现货 ∪ 线性永续**：只收 `status=Trading`（线性侧还要求 `contractType=LinearPerpetual`），按交易所 `nextPageCursor` 翻页取全集并带重复游标守卫；输出 `form` + `contract`（multiplier/tickSize/lotSize/maxLeverage/settleCcy，字段缺失即缺省）；规范形由交易所自带 symbol 派生，不用 baseCoin+quoteCoin 拼。
- **Bybit 的 assetClass 留空**：instruments-info 不携带资产类别字段，按「TradFi 归属只信交易所元数据、取不到即留空」处理，不按符号猜。
- **CCXT 保持现货**：normalizeSymbol 收到 `-SWAP` 直接抛 `TRADING_UNSUPPORTED_SYMBOL`，不再剥后缀后继续打现货端点；所有现货路径共用这一唯一入口。
- **Bybit ticker 未命中改用词汇表内的 `TRADING_UNSUPPORTED_SYMBOL`**（此前抛的 `TRADING_SYMBOL_NOT_FOUND` 不在 `TradingErrorCode` 里）。
- `normalizeCryptoSymbol` 退化为 `parseCryptoSymbol(...).base` 的薄封装，只服务衍生品端点（funding/OI/account-ratio）与模拟下单；注释写明任何可能收到 `-SWAP` 的行情路径必须走 `parseCryptoSymbol`。

## Alternatives considered

- **CCXT 也做合约**：落选（设计 Alternatives）——统一接口掩盖各所 category 差异，收益低于维护成本。
- **Bybit 名册给 assetClass='crypto'**：落选——交易所 `symbolType` 只对非标准类目（stock/ETF/xstocks/commodity/forex）有值，标准加密品种是空串；按品牌一律填 `crypto` 等于把 TradFi 行也涂成 crypto，与 SPX/US500 事故同类。
- **保留 normalizeCryptoSymbol 在现货路径、只在调用点加判断**：落选——判断会散落成多份 `endsWith('-SWAP')`，与「形态判据只应有唯一实现」冲突。
- **名册符号用 baseCoin+quoteCoin 拼**：落选——Bybit 线性面除 `BTCUSDT` 还有 `BTCPERP`（USDC 永续）等符号形，拼出来的名字交易所不认。

## Consequences

- Bybit 路由下 `crypto_get_ticker symbol=TSLAUSDT-SWAP` 要么打 `category=linear` 拿真合约价、要么报结构化不支持；**没有任何路径把 `-SWAP` 落到 spot 端点**（单测按 URL 断言，含盘口/分笔）。
- CCXT 的永续请求是显式失败：`TRADING_UNSUPPORTED_SYMBOL` 且零网络请求。
- Bybit 名册使永续进入检索面（router 消费 listInstruments）；assetClass 由交易所 `symbolType` 字面量裁决（stock/ETF/xstocks→equity、commodity→commodity、innovation/adventure→crypto），空串（交易所没给分类）与 forex/mstocks 留空。
- **真实网络已验证（2026-10-08，可达出口）**：本机默认出口对 `api.bybit.com` / `api.bytick.com` / `api-demo.bybit.com` / `api.bybit.nl` 全量 HTTP 403（CloudFront 地域拦截，加 7890 代理仍是同一美国出口 IP）——阻断是出口地区造成的；换出口地区（SG/JP/HK/TW/DE/KR/GB 实测全部 200）后，线性 ticker 真值（`TSLAUSDT-SWAP` 374.34/374.21、`BTCUSDT-SWAP` 82339.7）与 `instruments-info` 行字段（LinearPerpetual 853 / status 全 Trading、`contractSize` 0 行、`qtyStep`/`tickSize`/`maxLeverage` 各 893 行）逐条复核完毕，20 条判据全过（含工具路径 `marketData.getTicker` 真价，commit `25d18c7b`）。证据：[EVIDENCE-reverify-2026-10-08.md](../../../../spikes/impl-crypto-perp-tradfi/EVIDENCE-reverify-2026-10-08.md)、首轮捕获 [EVIDENCE-P3-bybit-ccxt.md](../../../../spikes/impl-crypto-perp-tradfi/EVIDENCE-P3-bybit-ccxt.md)。
- 设计与卡拆分见 [crypto-perp-and-tradfi.md](../../../../docs/roadmap/crypto-perp-and-tradfi.md)（P3）。
