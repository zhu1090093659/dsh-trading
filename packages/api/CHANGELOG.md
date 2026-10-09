# @dshtrading/api

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
