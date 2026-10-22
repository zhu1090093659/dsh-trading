# @dshtrading/api

## 0.6.3

## 0.6.2

### Patch Changes

- a838864: CCXT 连接器的 quote 表按所维护、K 线切到九所，并把 `TRADING_SYMBOL_NOT_FOUND` 补进 api 错误码词汇表：

  - `@dshtrading/api`：`TradingErrorCode` 收录 `TRADING_SYMBOL_NOT_FOUND`（已被 8 个连接器实际使用，
    此前只是漏进词汇表；与 `TRADING_UNSUPPORTED_SYMBOL` 的分界写进注释），**运行时错误码不变**。
  - `@dshtrading/connector-ccxt`：七条形态变换分支各有一份 quote 资产表（数据来源 = 该所公开挂牌端点
    普查），表外计价币仍零请求拒绝；K 线从单分支扩到九所（周期按所映射、行结构按所解析、输出升序、
    单请求根数按所裁剪），该所不支持的周期抛 `TRADING_UNSUPPORTED_INTERVAL` 且零请求；`exchange`
    只加在客户端方法与 `crypto_get_klines` 工具上，`MarketDataService.getKlines` 保持三形参；
    包内 `CcxtErrorCode` 下线。
  - 真实网络证据（`spikes/impl-ccxt-exchange-expansion/`）：七份挂牌普查 + 九份 K 线 + 六份上游 400 原文，
    `run-probe.ts` 退出码 0、63/63 判据通过。

- add0db1: 行情 K 线取数支持**按能力跨源**：当前路由的连接器结构性缺该 (周期, 深度) 时，由同市场另一个
  已注册源供数（候选序 = active 在前、其余按 provider 名升序）。修掉用户报障——A 股/港股数据源切到
  腾讯后「行情·五日」级别直接消失：该级别取数恒为最近 5 个交易日的 1 分钟 K 线，而腾讯公开端点对
  1m 是结构性拒绝（`TRADING_UNSUPPORTED_INTERVAL`），东财 `trends2 ndays=5` 能诚实给出
  （实测 cn 1061 根 / hk 1421 根，均 5 个交易日）。

  - `@dshtrading/api`：`MarketDataService` 增可选 `klineCapabilities?()`（周期 + 本源能承接的 `limit`
    上限；`maxBars` 是承接闸门而非返回根数承诺；缺席 = 未声明，不是「不支持」）。
  - `@dshtrading/bot-api`：`/klines` 按能力解析取数源并标注**实际供数** `provider`；`/markets` 上报该
    市场全部注册源的能力并集；`/tickers` 收可选 `provider`（未注册或注册表缺席即 400，不静默降级到
    active）。**只有 `TRADING_UNSUPPORTED_INTERVAL` 触发换源**——网络/限流/坏符号/交易所错误一律原样
    抛，候选耗尽抛最后一个错误；active 声明覆盖请求时永远用 active（零跨源）。
  - 连接器声明：tencent cn `5m/30m/1d/1w/1M@800`、hk `1d/1w/1M@800`（**无 1m**）；eastmoney cn/hk
    8 周期 @2500（1m 走 `trends2 ndays=5` 五日窗口）；yahoo `1m@2730` 与其余周期 @2500。其余连接器
    本批不声明，走错误码兜底路径（行为与改动前一致）。
  - `@dshtrading/client-ui-trading`：「五日」可得性改读桥上报的能力并集（存在 `1m` 且
    `maxBars ≥ FIVE_DAY_KLINE_LIMIT`），删除客户端路由白名单（能力并集未上报仍是 `unknown`，保留
    记忆不判不可得）；跨源时该级别 ticker 向同一 provider 取价，且只在两端同源时才合并进最后一根。

  真实网络原始响应证据：`spikes/impl-cross-source-kline-routing/EVIDENCE.md`（cn `1m/2500` →
  `provider=eastmoney` 1061 根 / 5 个交易日；cn `1d/750` → `provider=tencent`，零跨源）。

## 0.6.1

## 0.6.0

## 0.5.0

## 0.4.1

## 0.4.0

## 0.3.0

### Minor Changes

- 152c0c0: 金十数据接入面扩展：设置卡片 + GUI 快讯面板 + `global` 市场数据面（行情接市场路由）。

  - `@dshtrading/connector-jin10`：新增 `tradingFlashFeed` 快讯源（桥与工具面共用取数）与
    `global` 市场数据面（`market-data.ts`：报价/K 线/品种名册/轮询订阅；分钟 K 线按桶本地聚合，
    最多拼 300 分钟窗口 → 支持 `1m/3m/5m/15m/30m/1h`，日线及以上显式报错）+ 数据面插件行
    `@dshtrading/connector-jin10/dataplane`。
  - `@dshtrading/api`：新增 `FlashFeedService` 契约与 Context 增强 `tradingFlashFeed` /
    `tradingGlobalMarketData`。
  - `@dshtrading/router`：provider 词汇新增 `jin10`，`DEFAULT_MARKETS` 新增
    `global: { provider: 'jin10' }`，品种目录新增 `global`（零静态种子，经 `listInstruments` 动态注入）。
  - `@dshtrading/base`：新增数据面行 `dsh-trading-global-dataplane-jin10`（global 无 bundle/kit，归 base）。
  - `@dshtrading/client-ui-trading`：中栏新增「快讯」视图（轮询 + 关键词搜索 + 翻页，复用新闻面板渲染）
    与桥端点 `GET /dshtrading/api/flash`；市场词汇新增 `global`（侧栏/自选/行情面板/指数条/周期与时段模型）。
  - `@dshtrading/client-ui-settings`：交易设置区新增市场无关的「市场快讯数据源」卡片（金十 MCP Token，
    与 provider 凭据同键）与「全球」市场 tab（jin10 provider 卡片）。

## 0.2.1

## 0.2.0

## 0.1.6

## 0.1.5

## 0.1.4

## 0.1.3

## 0.1.2

## 0.1.1
