# @dshtrading/connector-jin10

## 0.6.0

### Patch Changes

- @dshtrading/api@0.6.0

## 0.5.0

### Patch Changes

- @dshtrading/api@0.5.0

## 0.4.1

### Patch Changes

- @dshtrading/api@0.4.1

## 0.4.0

### Minor Changes

- e399b62: global 市场 market-group 平权：新市场分组从「base 寄居」升格为完整 bundle + kit 形态（照 2026-09-12 futures 先例）。

  - `@dshtrading/global`（新包）：市场 bundle——host 面 `dsh-trading-global-installer`（boot 时幂等贡献 global-trader preset 切片）+ host 面数据行 `dsh-trading-global-dataplane-jin10`（自 base 迁入，金十源注册 `(global, jin10)` 进行情注册表）；preset 资产 global-trader（connector 组 `isolate: tradingGlobalMarketData` + kit 行）。
  - `@dshtrading/kit-global`（新包）：skill provider——`global-risk-checklist`（杠杆/隔夜利息/休市跳空/数据行情/美元计价）+ 四个共享技能，base role-skill 白名单全量可解析。
  - `@dshtrading/connector-jin10`：新增 preset 面入口 `./global-plugin`（隔离组内直接 provide `tradingGlobalMarketData`，与 host 面 dataplane 分工，避免重复注册响亮失败）。
  - `@dshtrading/base`：`MARKETS`/`ORDER_GATE_PATTERN`/research-tools markets 扩 `global`；persona 市场枚举文案同步；base patch 不再持有 global dataplane 行（改由 bundle 认领）。
  - 部署面：`@dshtrading/global` 需进 profile 直接依赖（desktop build-runtime 两清单已纳入；已装 profile 需 `dsh plugin add` + 刷新后生效）。

### Patch Changes

- @dshtrading/api@0.4.0

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

- e9bd316: 新增金十数据 MCP 连接器（跨市场快讯/资讯/财经日历）。`@dshtrading/connector-jin10`
  封装 Jin10 标准 MCP 服务（Streamable HTTP，协议 2025-11-25，Bearer BYOK）：9 个市场无关
  只读工具 `flash_list` / `flash_search` / `news_list` / `news_search` / `news_get` /
  `econ_calendar` / `global_instruments` / `global_quote` / `global_klines`；
  `structuredContent` 优先、`cursor → next_cursor / has_more` 分页、限流与未知品种错误映射；
  快讯/资讯只下发标题/时间/链接（+ 文章导语），正文零再分发。`@dshtrading/base` 新增
  host 平面工具行 `dsh-trading-connector-jin10`（市场无关共享行）并纳入安装闭包。

### Patch Changes

- Updated dependencies [152c0c0]
  - @dshtrading/api@0.3.0
