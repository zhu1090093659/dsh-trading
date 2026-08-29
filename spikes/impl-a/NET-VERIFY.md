# 任务 A 真实网络验证证据 — connector-binance MarketDataService

- 时间：2026-08-29T08:28:56Z（UTC）
- 命令：`node spikes/impl-a/net-verify.mjs`（经构建产物 `packages/connector-binance/lib/rest.js`）
- 目标：`https://api.binance.com/api/v3`（ticker/24hr + ticker/bookTicker + klines），公共接口，无凭证
- 结果：exit=0，getTicker 与 getKlines 均成功

## 原始输出

```
[1] getTicker BTCUSDT -> {"symbol":"BTCUSDT","price":77593.05,"timestamp":1787992138796,"bid":77593.05,"ask":77593.06,"volume":16617.30385}
[2] getKlines BTCUSDT 1h x3 -> [{"openTime":1787983200000,"open":77632.52,"high":77632.53,"low":77382.37,"close":77466.82,"volume":305.02922,"closeTime":1787986799999},{"openTime":1787986800000,"open":77466.83,"high":77672,"low":77438.01,"close":77626.01,"volume":933.89852,"closeTime":1787990399999},{"openTime":1787990400000,"open":77626.01,"high":77626.01,"low":77487.73,"close":77593.05,"volume":161.90641,"closeTime":1787993999999}]
[ok] symbol=BTCUSDT price=77593.05 klines=3 firstOpen=77632.52 elapsed=2307ms
```

## 一致性交叉验证

- ticker.price = 77593.05 与最后一根 1h K 线 close = 77593.05 完全一致 → 24hr/bookTicker/klines 三路映射（字符串→number、行序→字段）正确。
- bid=77593.05 / ask=77593.06 来自 bookTicker 补充路径；K 线 openTime/closeTime 连续无缝（整点对齐）。
- getTicker 实际发起 2 个请求（24hr + bookTicker 并行），getKlines 1 个请求，共 3 次真实 REST 往返，10s AbortController 超时未触发（耗时 2.3s）。
