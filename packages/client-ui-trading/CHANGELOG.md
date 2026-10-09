# @dshtrading/client-ui-trading

## 0.6.1

### Patch Changes

- @dshtrading/api@0.6.1
- @dshtrading/client-ui-knowledge@0.6.1
- @dshtrading/client-ui-strategies@0.6.1
- @dshtrading/dsh-home@0.6.1
- @dshtrading/eventbus@0.6.1
- @dshtrading/holdings@0.6.1
- @dshtrading/indicators@0.6.1
- @dshtrading/kit-cn@0.6.1
- @dshtrading/kit-crypto@0.6.1
- @dshtrading/kit-hk@0.6.1
- @dshtrading/kit-us@0.6.1
- @dshtrading/knowledge@0.6.1
- @dshtrading/router@0.6.1
- @dshtrading/strategies@0.6.1
- @dshtrading/watchlist@0.6.1

## 0.6.0

### Patch Changes

- @dshtrading/api@0.6.0
- @dshtrading/client-ui-knowledge@0.6.0
- @dshtrading/client-ui-strategies@0.6.0
- @dshtrading/dsh-home@0.6.0
- @dshtrading/eventbus@0.6.0
- @dshtrading/holdings@0.6.0
- @dshtrading/indicators@0.6.0
- @dshtrading/kit-cn@0.6.0
- @dshtrading/kit-crypto@0.6.0
- @dshtrading/kit-hk@0.6.0
- @dshtrading/kit-us@0.6.0
- @dshtrading/knowledge@0.6.0
- @dshtrading/router@0.6.0
- @dshtrading/strategies@0.6.0
- @dshtrading/watchlist@0.6.0

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

### Patch Changes

- Updated dependencies
  - @dshtrading/knowledge@0.5.0
  - @dshtrading/client-ui-knowledge@0.5.0
  - @dshtrading/kit-cn@0.5.0
  - @dshtrading/kit-crypto@0.5.0
  - @dshtrading/kit-hk@0.5.0
  - @dshtrading/kit-us@0.5.0
  - @dshtrading/api@0.5.0
  - @dshtrading/client-ui-strategies@0.5.0
  - @dshtrading/dsh-home@0.5.0
  - @dshtrading/eventbus@0.5.0
  - @dshtrading/holdings@0.5.0
  - @dshtrading/indicators@0.5.0
  - @dshtrading/router@0.5.0
  - @dshtrading/strategies@0.5.0
  - @dshtrading/watchlist@0.5.0

## 0.4.1

### Patch Changes

- @dshtrading/api@0.4.1
- @dshtrading/client-ui-knowledge@0.4.1
- @dshtrading/client-ui-strategies@0.4.1
- @dshtrading/dsh-home@0.4.1
- @dshtrading/eventbus@0.4.1
- @dshtrading/holdings@0.4.1
- @dshtrading/indicators@0.4.1
- @dshtrading/kit-cn@0.4.1
- @dshtrading/kit-crypto@0.4.1
- @dshtrading/kit-hk@0.4.1
- @dshtrading/kit-us@0.4.1
- @dshtrading/knowledge@0.4.1
- @dshtrading/router@0.4.1
- @dshtrading/strategies@0.4.1
- @dshtrading/watchlist@0.4.1

## 0.4.0

### Patch Changes

- @dshtrading/api@0.4.0
- @dshtrading/client-ui-knowledge@0.4.0
- @dshtrading/client-ui-strategies@0.4.0
- @dshtrading/dsh-home@0.4.0
- @dshtrading/eventbus@0.4.0
- @dshtrading/holdings@0.4.0
- @dshtrading/indicators@0.4.0
- @dshtrading/kit-cn@0.4.0
- @dshtrading/kit-crypto@0.4.0
- @dshtrading/kit-hk@0.4.0
- @dshtrading/kit-us@0.4.0
- @dshtrading/knowledge@0.4.0
- @dshtrading/router@0.4.0
- @dshtrading/strategies@0.4.0
- @dshtrading/watchlist@0.4.0

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

### Patch Changes

- Updated dependencies [152c0c0]
  - @dshtrading/api@0.3.0
  - @dshtrading/router@0.3.0
  - @dshtrading/kit-cn@0.3.0
  - @dshtrading/kit-crypto@0.3.0
  - @dshtrading/kit-hk@0.3.0
  - @dshtrading/kit-us@0.3.0
  - @dshtrading/strategies@0.3.0
  - @dshtrading/client-ui-knowledge@0.3.0
  - @dshtrading/client-ui-strategies@0.3.0
  - @dshtrading/dsh-home@0.3.0
  - @dshtrading/eventbus@0.3.0
  - @dshtrading/holdings@0.3.0
  - @dshtrading/indicators@0.3.0
  - @dshtrading/knowledge@0.3.0
  - @dshtrading/watchlist@0.3.0

## 0.2.1

### Patch Changes

- @dshtrading/api@0.2.1
- @dshtrading/client-ui-knowledge@0.2.1
- @dshtrading/client-ui-strategies@0.2.1
- @dshtrading/dsh-home@0.2.1
- @dshtrading/eventbus@0.2.1
- @dshtrading/holdings@0.2.1
- @dshtrading/indicators@0.2.1
- @dshtrading/kit-cn@0.2.1
- @dshtrading/kit-crypto@0.2.1
- @dshtrading/kit-hk@0.2.1
- @dshtrading/kit-us@0.2.1
- @dshtrading/knowledge@0.2.1
- @dshtrading/router@0.2.1
- @dshtrading/strategies@0.2.1
- @dshtrading/watchlist@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [5a61735]
- Updated dependencies [41dc2be]
  - @dshtrading/holdings@0.2.0
  - @dshtrading/indicators@0.2.0
  - @dshtrading/kit-cn@0.2.0
  - @dshtrading/kit-crypto@0.2.0
  - @dshtrading/kit-hk@0.2.0
  - @dshtrading/kit-us@0.2.0
  - @dshtrading/strategies@0.2.0
  - @dshtrading/api@0.2.0
  - @dshtrading/client-ui-knowledge@0.2.0
  - @dshtrading/client-ui-strategies@0.2.0
  - @dshtrading/dsh-home@0.2.0
  - @dshtrading/eventbus@0.2.0
  - @dshtrading/knowledge@0.2.0
  - @dshtrading/router@0.2.0
  - @dshtrading/watchlist@0.2.0

## 0.1.6

### Patch Changes

- 770878d: 修复 2026-09-08 代码审查发现的问题：自选 store 单实例化（agent 工具写不再覆盖 GUI 写与分组归属）、未定制市场分组时种子基线完整物化、东财符号形态按实例市场分流 + 港股时间戳 UTC+8 锚定、futu 行情面按市场分实例（美股搜索不再返回港股）、旧 DSH_HOME 一次性数据迁移与 Windows 卸载清理目标修正、OpenD 桥订阅槽 LRU 淘汰，以及配套测试补齐（含两条此前不可失败的冒烟用例）。
- Updated dependencies [770878d]
  - @dshtrading/dsh-home@0.1.6
  - @dshtrading/watchlist@0.1.6
  - @dshtrading/api@0.1.6
  - @dshtrading/client-ui-knowledge@0.1.6
  - @dshtrading/client-ui-strategies@0.1.6
  - @dshtrading/eventbus@0.1.6
  - @dshtrading/holdings@0.1.6
  - @dshtrading/indicators@0.1.6
  - @dshtrading/kit-cn@0.1.6
  - @dshtrading/kit-crypto@0.1.6
  - @dshtrading/kit-hk@0.1.6
  - @dshtrading/kit-us@0.1.6
  - @dshtrading/knowledge@0.1.6
  - @dshtrading/router@0.1.6
  - @dshtrading/strategies@0.1.6

## 0.1.5

### Patch Changes

- @dshtrading/api@0.1.5
- @dshtrading/client-ui-knowledge@0.1.5
- @dshtrading/client-ui-strategies@0.1.5
- @dshtrading/eventbus@0.1.5
- @dshtrading/holdings@0.1.5
- @dshtrading/indicators@0.1.5
- @dshtrading/kit-cn@0.1.5
- @dshtrading/kit-crypto@0.1.5
- @dshtrading/kit-hk@0.1.5
- @dshtrading/kit-us@0.1.5
- @dshtrading/knowledge@0.1.5
- @dshtrading/router@0.1.5
- @dshtrading/strategies@0.1.5
- @dshtrading/watchlist@0.1.5

## 0.1.4

### Patch Changes

- 修复 HomeHistory 面板容器层级：composerStack（z-index:1）盒子下缘盖进 header
  行，静态 portal 容器整层被压其下——背景透明可见但点击不达，删除与折叠按钮同
  遭殃。容器建立时内联 relative + z-index:2 盖回；合成 click 测不出该缺陷，以坐
  标级 Input.dispatchMouseEvent + elementFromPoint 复归验证通过，composer 无误
  伤。
  - @dshtrading/api@0.1.4
  - @dshtrading/client-ui-knowledge@0.1.4
  - @dshtrading/client-ui-strategies@0.1.4
  - @dshtrading/eventbus@0.1.4
  - @dshtrading/holdings@0.1.4
  - @dshtrading/indicators@0.1.4
  - @dshtrading/kit-cn@0.1.4
  - @dshtrading/kit-crypto@0.1.4
  - @dshtrading/kit-hk@0.1.4
  - @dshtrading/kit-us@0.1.4
  - @dshtrading/knowledge@0.1.4
  - @dshtrading/router@0.1.4
  - @dshtrading/strategies@0.1.4
  - @dshtrading/watchlist@0.1.4

## 0.1.3

### Patch Changes

- @dshtrading/api@0.1.3
- @dshtrading/client-ui-knowledge@0.1.3
- @dshtrading/client-ui-strategies@0.1.3
- @dshtrading/eventbus@0.1.3
- @dshtrading/holdings@0.1.3
- @dshtrading/indicators@0.1.3
- @dshtrading/kit-cn@0.1.3
- @dshtrading/kit-crypto@0.1.3
- @dshtrading/kit-hk@0.1.3
- @dshtrading/kit-us@0.1.3
- @dshtrading/knowledge@0.1.3
- @dshtrading/router@0.1.3
- @dshtrading/strategies@0.1.3
- @dshtrading/watchlist@0.1.3

## 0.1.2

### Patch Changes

- @dshtrading/api@0.1.2
- @dshtrading/client-ui-knowledge@0.1.2
- @dshtrading/client-ui-strategies@0.1.2
- @dshtrading/eventbus@0.1.2
- @dshtrading/holdings@0.1.2
- @dshtrading/indicators@0.1.2
- @dshtrading/kit-cn@0.1.2
- @dshtrading/kit-crypto@0.1.2
- @dshtrading/kit-hk@0.1.2
- @dshtrading/kit-us@0.1.2
- @dshtrading/knowledge@0.1.2
- @dshtrading/router@0.1.2
- @dshtrading/strategies@0.1.2
- @dshtrading/watchlist@0.1.2

## 0.1.1

### Patch Changes

- @dshtrading/api@0.1.1
- @dshtrading/client-ui-knowledge@0.1.1
- @dshtrading/client-ui-strategies@0.1.1
- @dshtrading/eventbus@0.1.1
- @dshtrading/indicators@0.1.1
- @dshtrading/kit-cn@0.1.1
- @dshtrading/kit-crypto@0.1.1
- @dshtrading/kit-hk@0.1.1
- @dshtrading/kit-us@0.1.1
- @dshtrading/knowledge@0.1.1
- @dshtrading/router@0.1.1
- @dshtrading/strategies@0.1.1
- @dshtrading/watchlist@0.1.1
