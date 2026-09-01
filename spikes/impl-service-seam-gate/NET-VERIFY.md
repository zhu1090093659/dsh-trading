# P0 服务缝闸门 真实网络验证证据（issue #29）

- 时间：2026-09-01（UTC+8）
- 命令：`pnpm build && node spikes/impl-service-seam-gate/net-verify.mjs`（经构建产物 `packages/connector-okx/lib/*.js`）
- 网络：仅 OKX 公共 REST `https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT`（无凭证、无下单）
- 目的：证明 `liveTrading=false`（缺省安全位）时**绕过工具层直调 TradeService** 的实盘请求在服务缝被结构化拒绝（fail-closed），dry-run 路径照常可用且回执显式标注。

## 原始输出

```
[A] direct placeOrder(dryRun=false, liveTrading=false) -> TradingServiceError TRADING_LIVE_TRADING_DISABLED | crypto_place_order rejected: the call requests real execution (dryRun=false) but live trading is disabled (liveTrading=false). Ask the user to enable liveTrading explicitly after confirmation, or keep dryRun=true for a simulated fill.
[B] direct placeOrder(dryRun 缺省) -> {"id":"dry-1788239405044-34l7d4","symbol":"BTCUSDT","side":"buy","type":"market","status":"filled","quantity":0.01,"dryRun":true,"timestamp":1788239405044}
[C] direct cancelOrder(liveTrading=false) -> TradingServiceError TRADING_LIVE_TRADING_DISABLED | OKX cancelOrder rejected at the service seam: cancel is a live action and requires liveTrading=true with dryRun=false (keep liveTrading=false if the order was not placed through this service).
[D] OKX public getTicker BTC-USDT -> {"symbol":"BTCUSDT","price":78921.9,"timestamp":1788239404967,"bid":78922.8,"ask":78922.9,"volume":5251.69369428,"prevClose":77678.4,"changePercent":1.600831119075573} (545ms)
[D] buildDryRunReceipt（真实参照价） -> {"status":"filled","dryRun":true,"note":"DRY-RUN — simulated fill; no order was sent to OKX. The reference price is market data only, not a fill price.","id":"dry-1788239405511-kzoerd","instId":"BTC-USDT","side":"buy","type":"market","quantity":0.01,"quantityUnit":"base-asset coins (SWAP orders would be converted to contracts by ctVal)","reference":{"source":"okx-public-ticker","price":78921.9,"bid":78922.8,"ask":78922.9,"timestamp":1788239404672},"timestamp":1788239405511}
[ok] seamRejectStructured=true simReceiptLabeled=true dryRunReceiptLabeled=true
```

## 判读

| 证据 | 调用形态 | 期望 | 实测 |
|---|---|---|---|
| A 服务缝 ① | 直调 `OkxTradeService.placeOrder(dryRun=false)`，`liveTrading=false` | `TRADING_LIVE_TRADING_DISABLED` 结构化抛出，不触网 | ✅ TradingServiceError，code 正确 |
| B 服务缝 ② | 直调 `placeOrder(dryRun 缺省)` | 本地模拟回执 `dryRun:true` | ✅ `dry-...` 回执，显式标注 |
| C 服务缝（撤单） | 直调 `cancelOrder`，`liveTrading=false` | 与下单同门槛，结构化拒绝 | ✅ TradingServiceError |
| D 真实网络 dry-run | 工具层闸门 ② 富回执路径：OKX 公共 ticker 作参照 | 回执含真实参照价且显式 `dryRun:true` | ✅ price=78921.9（545ms 真实往返） |

## 语义要点

1. 服务缝与工具层共用 `evaluateOrderGate` 三态语义（okx 单点裁决）；工具层 ask 交互与文案保留（双保险）。
2. [A]/[C] 全程未发起任何交易网络请求（拒绝发生在签名/触网之前）——动态包宿主半直调 `TradeService` 也拿不到实盘路径。
3. [D] 证明 dry-run 模拟链路在真实网络下端到端可用：公共行情参照进入回执，`no order was sent to OKX` 注记保留。

## 范围与未验证项（如实记录）

- 本 spike 覆盖 okx（唯一具备完整签名实盘下单路径的 crypto 连接器）；其余 9 个连接器（alpaca/futu/ibkr/qmt/longbridge/tiger 实盘路径 + bybit/ccxt/fmp/polygon/finnhub/tushare 模拟 stub）的服务缝三态行为由 `packages/connector-*/test/trade-gate.test.ts` 离线矩阵覆盖（60 测试），未对各家券商网关做真实下单验证（需要真实凭证，属各 connector 独立任务）。
- `liveTrading=true` 放行路径（闸门 ③）由单测 `mock 交易所` 证明（okx trade.test.ts 服务缝 ③ 用例 + 各 connector trade-gate ③ 用例），spike 不做真实实盘下单。
