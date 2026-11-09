# @dshtrading/client-ui-special-indicators

## 0.7.1

### Patch Changes

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

- @dshtrading/dsh-home@0.7.0

## 0.6.3

### Patch Changes

- @dshtrading/dsh-home@0.6.3

## 0.6.2

### Patch Changes

- @dshtrading/dsh-home@0.6.2

## 0.6.1

### Patch Changes

- @dshtrading/dsh-home@0.6.1

## 0.6.0

### Patch Changes

- 8901682: 桥缓存落盘：宿主重启后首个请求直接命中，不再每次冷拉上游。

  成因：内存 TTL 缓存随宿主进程退出清零，而浏览器侧缓存按 origin 隔离——桌面壳每次启动挑随机空闲端口，origin 一变上个会话的 sessionStorage/localStorage 整片成孤儿，于是「重启一次 = 冷拉一次」。

  - FinanceClient 新增 persistence 注入端口（load 同步补水 / save 异步原子写），落盘到 $DSH_HOME/special-indicators/cache.json：v1 信封 + baseUrl 指纹（换过上游地址即判废）、条目保留写入时刻（跨进程继续按同一 TTL 判定陈旧）、7 天保鲜期（覆盖周末与长假）、256 条上限（板块明细按代码分键防无界增长）；读写失败一律静默降级为慢。
  - 新增 Config.cacheFile（空 = 默认路径）；新增依赖 @dshtrading/dsh-home。

- 189f5e9: 特殊指标：修正「数据滞后」徽标语义与容器边缘自适应。

  - 滞后判据改为「上游数据日 vs 预期数据日」：T+1 指标在交易日显示上一交易日数据不再误标滞后；桥 SWR 缓存标记不再驱动徽标（基差撤掉徽标，恒科只认上游自身 stale）。
  - 板块双栏/单栏断点由视口宽（@media）改为中栏实际宽（@container）：会话侧栏展开/关闭时布局跟随；卡片补 box-sizing: border-box，消除 26px 右缘越界与横向滚动条。
  - @dshtrading/dsh-home@0.6.0

## 0.5.0

### Minor Changes

- DSH 宿主 cohort 前移到 `0.2.0-rc.2`，新增银河星耀数智 A 股数据源，并收口一批客户端图表与适配缺陷。

  - `@dshtrading/base`：宿主 floor 与内置面随 official cohort 前移（移除 0.1.7 失效的内置插件，
    改用原生面；role presets 迁到 agent-preset registry 运行时注册）。
  - `@dshtrading/connector-xysz`：接入银河星耀数智（AmazingData/tgw）A 股数据源，含真实网络
    原始响应证据与健康/品种/K 线/盘口数据面。
  - `@dshtrading/client-ui-trading`：会话寻址与草稿附件 API 适配官方面；副图 legend 下漂修复。
  - `@dshtrading/client-ui-settings`：适配 configForms 与 locale 合并的宿主迁移。
  - `@dshtrading/client-ui-special-indicators`：拉数据不再整屏清空（桥 SWR 陈旧回源 + 面板缓存优先）、
    图表铺满中栏并移除宽度上限、图例移出绘图区。
  - `@dshtrading/knowledge`：作者字段跨平台归一（别名表 + 入库/写盘/读盘三处接线）。

## 0.4.1

### Patch Changes

- 私有插件并入 fixed 组版本流：桌面 vendor 闭包与增量更新载荷硬校验所有打包包版本等于 release tag（pack-update-payload），changesets ignore 使其停在 0.1.0 并令 v0.4.0 mac 构建失败。版本随家族演进，保持 private 不发布（publish-npm 跳过 private）。
