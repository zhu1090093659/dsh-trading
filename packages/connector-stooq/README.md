# @dsh-trading/connector-stooq

> **状态：未实证（本出口被反爬拒止）**。2026-08-31 实测：Stooq 对无浏览器特征的客户端先下发 JS proof-of-work 挑战页（`/__verify`），清挑战后 CSV 下载仍返回 `Access denied`（stooq.pl：`Odmowa dostępu`），疑似按出口 IP/账户策略拒绝匿名下载——本开发出口**无任何一次成功数据返回**，证据 `spikes/impl-us/REPORT.md`。代码完整、单测绿（夹具为 Stooq 长期稳定的 CSV 格式），**其他出口可能可用**，保留在仓备查。
>
> **us 切片已切换到 Yahoo Finance**（`packages/connector-yahoo`，本出口已实证，2026-08-29），本包不再是 us bundle 依赖。换出口复测通过前，不要据此包跑真数据验收。

dsh-trading us 切片市场连接器（原数据源）：经 Stooq 公共 CSV 端点实现 `@dsh-trading/api` 的 `MarketDataService` 契约（ctx 键 `tradingUsMarketData`），并提供 `us_get_ticker` / `us_get_klines` / `us_place_order` 三工具（下单三段闸门与 connector-binance 同构）。

## 已知局限（实现时已内置）

- 手册引用的报价端点 `/q/l/` 已 404（stooq.com 与 stooq.pl 均实测），`getTicker` 以最新日 K 收盘价近似，不反映盘前盘后；
- 反爬挑战页 → `TRADING_RATE_LIMITED`（不做挑战求解/伪装）；`Access denied` → `TRADING_AUTH_FAILED`。

## 合规记录（README 铁律 #5）

Stooq 免费公开 CSV 端点、无 key；个人/非商业使用边界以 stooq.com 条款为准；本仓不缓存、不批量抓取、不再分发行情数据。
