# @dsh-trading/connector-tencent

> **状态：已实证（本出口可用）**。2026-08-31 实测：报价（qt.gtimg.cn）与日/周/月 K（web.ifzq.gtimg.cn fqkline/hkfqkline）从本开发出口均可返回真实数据，cn（贵州茅台）+ hk（腾讯控股）真实网络验证 PASS 2/2，证据 `spikes/impl-cn-hk/REPORT.md` 与 `r1/r2/r3-*` 原始文件。

dsh-trading **cn+hk 双市场切片**市场连接器：经腾讯公共行情端点实现 `@dsh-trading/api` 的 `MarketDataService` 契约，并提供 `<market>_get_ticker` / `<market>_get_klines` / `<market>_place_order` 三工具（下单三段闸门与 connector-binance/connector-stooq 同构）。

## 单包双市场（多实例模式）

本包是**一个插件、两个市场实例**（手册 §8，新模式）：

- Config 首键 `market: 'cn' | 'hk'` 分流；插件名统一为 `dsh-trading-tencent`；
- cn-trader / hk-trader 两个 preset 用**不同行 id**（`dsh-trading-cn-connector` / `dsh-trading-hk-connector`）挂载**同一 bare 包名**，`config.market` 决定实例行为；
- cn 实例 provide `tradingCnMarketData` + 注册 `cn_get_ticker/cn_get_klines/cn_place_order`；hk 实例 provide `tradingHkMarketData` + `hk_` 三件；
- isolate 组键 = 对应服务名（preset 挂载硬规则）。

## 已知局限（实现时已内置）

- 报价响应为 **GBK 编码**，客户端用 `TextDecoder('gbk')` 解码（Node 全 ICU 内置）；
- cn/hk 报价字段布局不同：cn 成交量单位是**手**（×100 归一到股）、hk 是**股**；hk 买卖档位字段全 0（`r_hk` 无实时档）→ bid/ask 缺省；
- hk K 线 wire 前缀是 `hk`（报价才是 `r_hk`）；K 线行字段序是**开收高低量**，hk 行第 7 元素起为分红/回购附加对象（解析丢弃）；
- 分钟线端点（kline/mkline）本出口不可达，未实现（待验证）；支持 interval = 1d/1w/1M（前权 qfq）。

## 合规记录（README 铁律 #5）

**腾讯公共行情端点：公开、无 key、无官方授权；个人使用边界自负**，以腾讯服务条款为准。本仓不缓存、不批量抓取、不再分发行情数据。腾讯不提供交易 API——live 下单路径恒为 `TRADING_NOT_IMPLEMENTED`（券商 API 是后续任务）。
