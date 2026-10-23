# @dshtrading/connector-eastmoney

> **状态：已实证（本出口可用）**。2026-10-14 实测：报价（`push2.eastmoney.com` `ulist.np/get`）、
> 日 K 与分钟 K（`push2his.eastmoney.com` `kline/get` / `trends2`）从本开发出口返回真实数据，
> 批量报价把自选 7 行压成 2 次请求。证据 `spikes/impl-eastmoney-quote-endpoint/EVIDENCE.md`、
> `spikes/impl-eastmoney-hk/`、`spikes/impl-five-day-1m-fetch/EVIDENCE.md`。

东方财富公开 REST 行情连接器：**cn + hk 单包双市场**（照 connector-tencent 的多实例模式），
实现 `@dshtrading/api` 的 `MarketDataService` 契约并提供 `<market>_get_ticker` / `<market>_get_klines`
两工具。**纯行情，无交易通道**（东财公共端点不提供交易 API）。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否激活本连接器 |
| `market` | `'cn'` | `cn` = A 股，`hk` = 港股；同一 bare 包名挂两行、行 id 不同即两个实例 |

## 接线

- **数据面行**：`packages/cn/cordis.patch.yml` 与 `packages/hk/cordis.patch.yml` 各挂一行，注册
  `(cn, eastmoney)` / `(hk, eastmoney)` 进 `tradingMarketDataRegistry`，不占根市场键。
- **preset 行**：`packages/{cn,hk}/assets/preset/*/agent.cordis.yml`；`routeAllows` 只在该市场
  `provider === 'eastmoney'` 时激活本实例。
- **服务键**：cn → `tradingCnMarketData`，hk → `tradingHkMarketData`（isolate 组键 = 服务名）。

## 上游端点

| 用途 | 端点 |
|---|---|
| 报价（单只与批量同端点） | `push2.eastmoney.com/api/qt/ulist.np/get?secids=<secid,…>` |
| 5m 及以上 K 线 | `push2his.eastmoney.com/api/qt/stock/kline/get?klt=…&fqt=1` |
| 1m 分时（多日窗口） | `push2his.eastmoney.com/api/qt/stock/trends2/get?ndays=5` |
| 名册检索 | `searchapi.eastmoney.com/api/suggest/get?type=14` |
| 港股通持股（hk 实例） | 数据中心 `RPT_MUTUAL_STOCK_HOLDRANKS` 报表 |

## 周期与契约

- 周期词汇 `1m/5m/15m/30m/1h/1d/1w/1M`（`klt` 1/5/15/30/60/101/102/103），前复权 `fqt=1`，cn 与 hk 同面。
- **1m 只能走 `trends2`**：`kline/get` 的 `klt=1` 只给当日（`lmt` 与 `end` 被上游忽略），多日窗口的唯一通道是
  `ndays`；`ndays=5` 是上限（`ndays=10` → `rc:102` / 0 行），cn 一次约 1205 根、hk 约 1655 根。
- **`ndays>1` 时历史交易日的开价恒为 `0.00`**：实现按「同日前一根 close」重建并夹进当根 `[low, high]`，
  是派生值而非交易所开价（证据 `spikes/impl-five-day-1m-fetch/EVIDENCE.md`）。
- **取价必须按行的 `f1` 除**：`price = f2 / 10^f1`。CN ETF 行的 `f1` 是 3，套市场级 ÷100 会把 1.059 元读成 10.59 元。
- 未收录的 secid 在响应里**整行缺席**（不报错）→ `TRADING_SYMBOL_NOT_FOUND`；批量路径按契约由调用方回落单取。
- 错误映射：非 2xx → `TRADING_UPSTREAM_ERROR`，不可达/超时 → `TRADING_NETWORK`，非 JSON → `TRADING_NETWORK`
  （后两者里只有「不可达/超时」可重试）。
- **请求通道的硬上界**：只有网络级失败才重试，最多 3 枪、重试间**固定 200 ms** 冷却（不退避）、
  单枪超时 2 s（盖住建连、响应头与**响应体解析**整段：200 头已回但 body 挂住同样在 2 s 内终结）、
  一次取数整通 3 s 硬截止（含冷却与全部枪，到点不续命）。整通失败后把**该主机**
  静置 30 s（熔断，push2 / push2his / searchapi / datacenter-web 各自独立）：窗口内零网络请求、
  立即抛 `TRADING_NETWORK`，消息带 `circuit open` 与剩余毫秒，到期自愈、任一成功清零。
  HTTP 非 2xx 与坏 JSON 不重试、也不打开熔断。

## 能力面

| 服务方法 | cn 实例 | hk 实例 |
|---|---|---|
| `getTicker` / `getTickers`（一次请求取多只） | 有 | 有 |
| `getKlines` | 有 | 有 |
| `listInstruments`（关键词检索） | 有 | 有 |
| `subscribeTicker`（快照轮询，最小 1000 ms） | 有 | 有 |
| `getSouthboundHoldings`（港股通持股历史） | **缺席** | 有 |
| 盘口 / 基本面 / 主动买盘 | 未实现 | 未实现 |

## 已知边界（实测）

- **`/api/qt/stock/get` 路径级空回**（2026-10-14）：同一时刻、同域、同 UA 的 `ulist.np/get`、`trends2`、
  `kline/get` 全部正常，只有该路径传输层空回（`curl` 对照 `(52) Empty reply from server`）。
  报价因此改走 `ulist.np/get`。
- **空回的归因是代理链路，不是东财边缘**（2026-10-23 16 枪二次实测）：连败时 connect 均 3 ms 级
  成功、total 0.15-0.31 s、`curl (52) Empty reply from server` / `http=000 bytes=0`，而 `remote_ip`
  全是本机代理 fake-ip `198.18.0.167`（系统代理 `127.0.0.1:7890`）；同刻 push2 与 push2his 一起
  空回、腾讯 200。东财边缘在失败时刻的行为未验证，换东财主机/域名无效。
- **对突发并发极敏感**：2026-10-14 实测在飞 4 就触发「TCP+TLS 建连成功、服务端约 70 ms 后直接断连、
  无 HTTP 响应」，且失效面会从路径级扩到 `push2` 域全路径、持续 ≥12 分钟；2026-09-08 另有整 IP
  断开约 20 分钟的先例。客户端轮询应保持 ≥60 s 量级，**不要拿它跑批量探测**。
- 横向对比（周期 / 品种 / 历史深度 / 时延并发）见 [docs/guides/cn-data-source-comparison.md](../../docs/guides/cn-data-source-comparison.md)。

## 合规记录（README 铁律 #5）

**东方财富公开端点：公开、无 key、无官方授权；个人使用边界自负**，以东财服务条款为准。
本仓不缓存、不再分发行情数据。

## 出网验证

```sh
pnpm --filter @dshtrading/connector-eastmoney build
node spikes/impl-eastmoney-quote-endpoint/p1-quote-endpoint-and-scale.mjs   # 报价端点与按行 f1 取价
node spikes/impl-eastmoney-quote-endpoint/p2-getTickers-batch.mjs           # 批量报价（请求次数由外层计数器给出）
./node_modules/.bin/tsx spikes/impl-five-day-1m-fetch/fetch-five-day-1m.ts  # 五日 1m 与开价重建
```
