# 跨源 K 线能力路由：真实网络证据（2026-10-15）

复现命令：

```
pnpm build
node spikes/impl-cross-source-kline-routing/run-probe.mjs   # 原始输出 probe.raw.json
```

运行时刻：2026-10-15T03:05:06Z（北京时间 11:05，盘中）。探针 import 各包 `lib/` 产物，
`TradingBridge` / `createBridgeHost` 是真实实现，数据面是围绕三个**真实 REST 客户端**
（`TencentRestClient` / `EastmoneyRestClient`）的最小适配器（`getKlines` / `getTicker` /
`klineCapabilities` 直通客户端本体）。适配器只替代 cordis dataplane 注册那一层，
不伪造业务行为；dataplane 注册路径由各连接器 `dataplane-loader` 用例覆盖。

## 判据与实测

| # | 判据 | 实测 | 原始字段 |
|---|---|---|---|
| 1 | 腾讯 A 股对 1m 是**结构性拒绝**（不是网络失败） | `TRADING_UNSUPPORTED_INTERVAL`「unsupported interval 1m — supported: 5m/30m/1d/1w/1M」 | `direct.tencentCn1m` |
| 2 | 腾讯港股同样拒绝 1m | 同上 | `direct.tencentHk1m` |
| 3 | 东财 1m 单请求能诚实给 5 个交易日（cn） | 1061 根 / **5 个交易日**；2026-10-09T01:30Z → 2026-10-15T03:06Z | `direct.eastmoneyCn1m2500` |
| 4 | 东财 1m 单请求能诚实给 5 个交易日（hk） | 1421 根 / **5 个交易日** | `direct.eastmoneyHk1m2500` |
| 5 | 连接器自我声明 | 腾讯 cn `5m/30m/1d/1w/1M@800`、hk `1d/1w/1M@800`（**均无 1m**）；东财 cn/hk 8 周期 @2500 | `direct.declared` |
| 6 | cn 路由 = tencent 时 `1m/limit=2500` 由东财供数 | `provider=eastmoney`，1061 根 / 5 个交易日 | `bridge.cn1m2500` |
| 7 | cn 路由 = tencent 时 `1d/limit=750` **仍**由腾讯供数（零跨源） | `provider=tencent`，751 根 | `bridge.cn1d750` |
| 8 | hk 路由 = tencent 时 `1m/limit=2500` 由东财供数（腾讯港股无分钟线） | `provider=eastmoney`，1421 根 / 5 个交易日 | `bridge.hk1m2500` |
| 9 | `/markets` 上报该市场**全部注册源**的能力并集（与路由无关，客户端「五日」判据的输入） | cn：`provider=tencent` 且并集含 `1m@2500`（来自东财）与 `5m/15m/30m/1h@2500`；hk 同形 | `bridge.markets` |
| 10 | `/tickers` 不带 provider → 路由源（腾讯） | ok，price 1312.87 | `bridge.tickersActive` |
| 11 | `/tickers?provider=eastmoney` → 真实东财取价（五日级别跨源时的同源取价路径） | ok，price 1312.88 | `bridge.tickersByProvider` |
| 12 | `/tickers?provider=stooq`（未注册）→ 400，不静默降级 | `tickers: provider "stooq" is not a registered source of market cn` | `bridge.tickersUnregisteredProvider` |

第 10/11 条同时说明：两个源对同一标的的报价在该时刻相差 0.01 元（1312.87 / 1312.88），
即跨源合流若不同源会引入肉眼可见的末根跳变——这是「五日级别最新价也由跨源 provider
提供」这条口径的直接动因。

## 未覆盖

- cordis dataplane 注册与 `routeAllows` 裁决（由各连接器 dataplane-loader 用例覆盖）。
- 客户端渲染层（`'5d'` 胶囊出现、按源取价请求）——证据在 `client-ui-trading` 的
  `five-day-series` / `market-providers` / `quote-stage.smoke` 用例，均以手写契约假件
  记录桥请求；桌面壳实机 UI 验证不在本次范围内。
- 上游失败路径（网络/限流）不换源由 `bot-api/test/bridge-kline-cross-source.test.ts`
  的契约化假件断言覆盖（真实网络无法确定性构造）。
  **2026-10-23 口径变更**：网络级失败与上游 HTTP 非 2xx 已改为**有界兜底**（一次取数最多
  换 1 个源），限流/坏符号/交易所业务错误仍原样抛；该文件已按新口径断言，现行为以
  [不变量 #9](../../docs/current-state.md) 为准，本行保留为当时的观测记录。
