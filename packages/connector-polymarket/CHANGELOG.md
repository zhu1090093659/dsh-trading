# @dshtrading/connector-polymarket

## 0.7.1

### Patch Changes

- @dshtrading/api@0.7.1
- @dshtrading/dsh-home@0.7.1

## 0.7.0

### Minor Changes

- 8882933: 把五类数据能力做成 agent 可直接调用的只读工具（此前只能绕脚本、绕本地缓存文件或绕私有桥）：
  **特殊指标五只、KDAS 读数一只、Polymarket 三只、金十补两只**，全部沿用各自既有的取数 service 实例，
  不新增第二份取数逻辑，不引入任何下单/撤单/改参数/改台账能力。

  - **`@dshtrading/indicators`**：新增 host 平面工具 `indicator_get_values`（一个工具覆盖 crypto/us/cn/hk/futures/global）。
    关键日取图表激活名册的**现场权威值**（`chartStore` 里 `kdas` 实例的 `symbolParams["market:symbol"]`，命中即整体
    替代全局 params），算法复用该指标自己的 `computeSource`（`runSourceInVmSandbox`，超时放宽到 2000ms），
    行情经 `tradingMarketDataRegistry` 按与桥 `/klines` **相同的候选序**取数（active 在前、其余按 provider 名升序、
    只有 `TRADING_UNSUPPORTED_INTERVAL` 才换源），出参回带 `provider`/`parity` 与 `bars_requested`/`window_*`。
    `interval` 固定 `1d`（关键日锚定只在日线上成立，名册 applyScope 里有 1w 也不放行）；
    锚点被窗口截断、关键日晚于最新一根、无可用关键日、K 线为空一律 **fail-closed 不给数**，只报缺什么。
    新增 `test/values-tool.test.ts` 15 例；现场证据 `spikes/impl-kdas-values/`（与 `kdas.py` 复算逐条对齐）。

  - **`@dshtrading/connector-jin10`**：`flash_list` 增可选 `hot`（火/热/沸/爆，逗号分隔多值；非法值显式报错并列出
    支持值），走与 GUI 快讯面板同一实现 `listFlashByHeat`（数据源是**网页版公开快讯接口**，出参 source 如实改写），
    不给 `hot` 时行为与改动前完全一致；新增 `macro_rates`（央行最新利率，约 30 家；可选 `region` 过滤，
    未命中返回空列表 + 可用地区而不是失败），出参带 `as_of`/`source`/`unit` 与「上游未声明快照时间」的如实标注。
    新增 `test/agent-tools-hot-rates.test.ts` 7 例；真实响应证据 `spikes/impl-jin10-agent-tools/`。

  - **`@dshtrading/connector-polymarket`**：新增三只只读工具 `prediction_fomc_meetings`（可选 `meetingId` 收窄）、
    `prediction_search_events`（关键词；上游 `/events` **无检索参数**，单页 100 条本地过滤并在出参声明
    `filtering`/`pageLimit`/`scanned`/`matched`，不翻页）、`prediction_event_detail`（事件 id 或 slug）。
    三者与桥 `/dshtrading/api/prediction/fomc` 共用 `apply()` 里那一个 `PolymarketService`；
    出参带 `observedAt`（本进程取数时刻）、`source`、`stale`（`cf-cache-status: HIT` 是唯一判据）；
    `changeSincePrevious` 缺失一律**省略而不是填 0**；403（Cloudflare 1010）结构化抛错，绝不回落成空数据。
    `inject` 从 `[]` 改为 `['tools']`。新增 `test/tools.test.ts` 16 例；真实网络与 403 证据
    `spikes/impl-polymarket/agent-tools-ACCEPTANCE.md`。

  - **`@dshtrading/client-ui-special-indicators`**：新增五只只读工具 `special_indicators_get_snapshot`、
    `special_indicators_get_sentiment_history`、`special_indicators_get_sector_ranking`、
    `special_indicators_get_sector_series`、`special_indicators_get_hk_short_top10`，
    与 `/dshtrading/api/special-indicators` 白名单桥**共用同一个 `FinanceClient`**（同一 TTL/落盘缓存、
    in-flight 去重、SWR、同一惰性凭据链）；白名单子路由、参数夹取与缓存档抽到 `src/routes.ts`，桥与工具面同源。
    出参带 `as_of`/`expected_data_date`（含派生来源标注）/`stale`（上游声明优先）/`cache_stale`（桥缓存档）/
    `stale_source`/`source`；只读 GET，不动原桥 auth 栅栏。新增 `test/indicator-tools.test.ts` 28 例
    （含「工具面与桥共用同一缓存、上游命中数恒为 1」的组装面实证）；补 `@deepseek-ai/dsh-tools` peerDependency。

### Patch Changes

- @dshtrading/api@0.7.0
- @dshtrading/dsh-home@0.7.0

## 0.6.3

### Patch Changes

- @dshtrading/api@0.6.3
- @dshtrading/dsh-home@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies [a838864]
- Updated dependencies [add0db1]
  - @dshtrading/api@0.6.2
  - @dshtrading/dsh-home@0.6.2

## 0.6.1

### Patch Changes

- @dshtrading/api@0.6.1
