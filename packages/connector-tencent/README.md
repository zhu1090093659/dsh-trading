# @dshtrading/connector-tencent

> **状态：已实证（本出口可用）**。报价（`qt.gtimg.cn`）、日/周/月 K（`ifzq.gtimg.cn`
> `fqkline`/`hkfqkline`；`web.ifzq` 同族域名已被上游 WAF 封死，只作回退垫底）、分钟 K
> （`ifzq.gtimg.cn` `mkline`）与批量报价均从本开发出口返回真实数据。
> 证据 `spikes/impl-cn-hk/REPORT.md`、`spikes/impl-tencent-minute/EVIDENCE.md`、
> `spikes/impl-tencent-quote-batch/EVIDENCE.md`、`spikes/impl-cn-datasource-bench/EVIDENCE.md`。

dsh-trading **cn+hk 双市场切片**市场连接器：经腾讯公共行情端点实现 `@dshtrading/api` 的
`MarketDataService` 契约，并提供 `<market>_get_ticker` / `<market>_get_klines` / `<market>_place_order`
三工具（下单三段闸门与 connector-binance/connector-stooq 同构）。

## 单包双市场（多实例模式）

本包是**一个插件、两个市场实例**（手册 §8，新模式）：

- Config 首键 `market: 'cn' | 'hk'` 分流；插件名统一为 `dsh-trading-tencent`；
- cn-trader / hk-trader 两个 preset 用**不同行 id**（`dsh-trading-cn-connector` / `dsh-trading-hk-connector`）挂载**同一 bare 包名**，`config.market` 决定实例行为；
- cn 实例 provide `tradingCnMarketData` + 注册 `cn_get_ticker/cn_get_klines/cn_place_order`；hk 实例 provide `tradingHkMarketData` + `hk_` 三件；
- isolate 组键 = 对应服务名（preset 挂载硬规则）。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `market` | 必填 | `cn` = A 股，`hk` = 港股（两个实例各写一行） |
| `dryRun` | `true` | 下单工具默认模拟 |
| `liveTrading` | `false` | 实盘总开关；base 审批闸门不得绕过 |

## 上游端点

| 用途 | 端点 |
|---|---|
| 报价（单只与批量同端点） | `qt.gtimg.cn/q=<wire[,wire…]>`（`q=` 原生支持逗号列表） |
| 日/周/月 K（前复权） | `ifzq.gtimg.cn/appstock/app/{fqkline,hkfqkline}/get`（回退链 `ifzq` → `web.ifzq`；后者自 2026-10-23 起被上游 WAF 封死，见 Agent Note `2026-10-23-tencent-kline-host-fallback-and-eastmoney-network-retry`） |
| 分钟 K（**仅 cn**） | `ifzq.gtimg.cn/appstock/app/kline/mkline`（host **无 `www.`**，带则 301） |
| 名册检索 | `smartbox.gtimg.cn/s3/?t=all&q=` |

单次请求超时 10 s（`DEFAULT_TIMEOUT_MS`）。

## 周期与能力面

- 周期：cn `5m/30m/1d/1w/1M`（`mkline` / `fqkline` 前复权）；**hk 仅 `1d/1w/1M`**，分钟周期抛
  `TRADING_UNSUPPORTED_INTERVAL`（公开端点不通）。
- `getTickers` 一次上游请求取多只标的（键 = 入参原字符串，未收录的整行缺席故跳过，整批失败抛出）；
  实现不分片，标的数由调用方裁剪。
- cn 实例独有：`getActiveBuySnapshot`（同一报价行的外盘/内盘，「盘口推断」口径）；
  该方法在 hk 实例上**本身缺席**，消费方按「方法是否存在」判降级。
- `getOrderbook`（同一报价行五档）两个实例都声明，但 hk 调用抛 `TRADING_NOT_IMPLEMENTED`
  ——`r_hk` 行的档位字段恒 0，桥层据此显示「未提供」而不是空盘口。
- cn/hk 均有：`getTicker` / `getKlines` / `getFundamentals` / `listInstruments` /
  `subscribeTicker`（快照轮询，最小 250 ms，默认 5 s）。

## 已知局限（实现时已内置）

- 报价响应为 **GBK 编码**，客户端用 `TextDecoder('gbk')` 解码（Node 全 ICU 内置）；
- cn/hk 报价字段布局不同：cn 成交量单位是**手**（×100 归一到股）、hk 是**股**；hk 买卖档位字段全 0（`r_hk` 无实时档）→ bid/ask 缺省；
- hk K 线 wire 前缀是 `hk`（报价才是 `r_hk`）；K 线行字段序是**开收高低量**，hk 行第 7 元素起为分红/回购附加对象（解析丢弃）；
- **超限静默降级**（HTTP 仍 200、`code=0`）：`mkline` 的 `count > 800` 降到 320 根；`fqkline` 的 `count ≥ 801` 降到 641 根。
  实现侧 `Math.min(limit, 800)` 让这两个悬崖在调用面上不可达，代价是**日 K 最多只能取到 801 根（约 3.2 年）**，
  需要更长历史须换 provider；
- 北交所不在符号词汇内（只认 `sh`/`sz` 前缀），裸 wire 也只回 09:00:00 / 零成交量的占位行。

## 合规记录（README 铁律 #5）

**腾讯公共行情端点：公开、无 key、无官方授权；个人使用边界自负**，以腾讯服务条款为准。本仓不缓存、不批量抓取、不再分发行情数据。腾讯不提供交易 API——live 下单路径恒为 `TRADING_NOT_IMPLEMENTED`（券商 API 是后续任务）。

## 出网验证

```sh
node spikes/impl-cn-hk/r3-real-network-verify.mjs          # cn+hk 链路（报价 + K 线）
node spikes/impl-tencent-quote-batch/r0-live-probe.mjs     # 批量报价（默认只打印，不落盘）
./node_modules/.bin/tsx spikes/impl-cn-datasource-bench/bench.mts   # 时延 / 并发 / 批量 / 分钟 K 上限
```
