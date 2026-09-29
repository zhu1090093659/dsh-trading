# @dshtrading/base

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
  - @dshtrading/client-ui-trading@0.5.0
  - @dshtrading/client-ui-settings@0.5.0
  - @dshtrading/knowledge@0.5.0
  - @dshtrading/dsh-i18n@0.5.0
  - @dshtrading/client-ui-knowledge@0.5.0
  - @dshtrading/api@0.5.0
  - @dshtrading/client-ui-indicators@0.5.0
  - @dshtrading/client-ui-masters-quotes@0.5.0
  - @dshtrading/client-ui-strategies@0.5.0
  - @dshtrading/client-ui-updater@0.5.0
  - @dshtrading/connector-jin10@0.5.0
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
- @dshtrading/client-ui-indicators@0.4.1
- @dshtrading/client-ui-knowledge@0.4.1
- @dshtrading/client-ui-masters-quotes@0.4.1
- @dshtrading/client-ui-settings@0.4.1
- @dshtrading/client-ui-strategies@0.4.1
- @dshtrading/client-ui-trading@0.4.1
- @dshtrading/client-ui-updater@0.4.1
- @dshtrading/connector-jin10@0.4.1
- @dshtrading/dsh-home@0.4.1
- @dshtrading/dsh-i18n@0.4.1
- @dshtrading/eventbus@0.4.1
- @dshtrading/holdings@0.4.1
- @dshtrading/indicators@0.4.1
- @dshtrading/knowledge@0.4.1
- @dshtrading/router@0.4.1
- @dshtrading/strategies@0.4.1
- @dshtrading/watchlist@0.4.1

## 0.4.0

### Minor Changes

- e399b62: global 市场 market-group 平权：新市场分组从「base 寄居」升格为完整 bundle + kit 形态（照 2026-09-12 futures 先例）。

  - `@dshtrading/global`（新包）：市场 bundle——host 面 `dsh-trading-global-installer`（boot 时幂等贡献 global-trader preset 切片）+ host 面数据行 `dsh-trading-global-dataplane-jin10`（自 base 迁入，金十源注册 `(global, jin10)` 进行情注册表）；preset 资产 global-trader（connector 组 `isolate: tradingGlobalMarketData` + kit 行）。
  - `@dshtrading/kit-global`（新包）：skill provider——`global-risk-checklist`（杠杆/隔夜利息/休市跳空/数据行情/美元计价）+ 四个共享技能，base role-skill 白名单全量可解析。
  - `@dshtrading/connector-jin10`：新增 preset 面入口 `./global-plugin`（隔离组内直接 provide `tradingGlobalMarketData`，与 host 面 dataplane 分工，避免重复注册响亮失败）。
  - `@dshtrading/base`：`MARKETS`/`ORDER_GATE_PATTERN`/research-tools markets 扩 `global`；persona 市场枚举文案同步；base patch 不再持有 global dataplane 行（改由 bundle 认领）。
  - 部署面：`@dshtrading/global` 需进 profile 直接依赖（desktop build-runtime 两清单已纳入；已装 profile 需 `dsh plugin add` + 刷新后生效）。

### Patch Changes

- Updated dependencies [e399b62]
  - @dshtrading/connector-jin10@0.4.0
  - @dshtrading/api@0.4.0
  - @dshtrading/client-ui-indicators@0.4.0
  - @dshtrading/client-ui-knowledge@0.4.0
  - @dshtrading/client-ui-masters-quotes@0.4.0
  - @dshtrading/client-ui-settings@0.4.0
  - @dshtrading/client-ui-strategies@0.4.0
  - @dshtrading/client-ui-trading@0.4.0
  - @dshtrading/client-ui-updater@0.4.0
  - @dshtrading/dsh-home@0.4.0
  - @dshtrading/dsh-i18n@0.4.0
  - @dshtrading/eventbus@0.4.0
  - @dshtrading/holdings@0.4.0
  - @dshtrading/indicators@0.4.0
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

- e9bd316: 新增金十数据 MCP 连接器（跨市场快讯/资讯/财经日历）。`@dshtrading/connector-jin10`
  封装 Jin10 标准 MCP 服务（Streamable HTTP，协议 2025-11-25，Bearer BYOK）：9 个市场无关
  只读工具 `flash_list` / `flash_search` / `news_list` / `news_search` / `news_get` /
  `econ_calendar` / `global_instruments` / `global_quote` / `global_klines`；
  `structuredContent` 优先、`cursor → next_cursor / has_more` 分页、限流与未知品种错误映射；
  快讯/资讯只下发标题/时间/链接（+ 文章导语），正文零再分发。`@dshtrading/base` 新增
  host 平面工具行 `dsh-trading-connector-jin10`（市场无关共享行）并纳入安装闭包。

### Patch Changes

- Updated dependencies [152c0c0]
- Updated dependencies [e9bd316]
  - @dshtrading/connector-jin10@0.3.0
  - @dshtrading/api@0.3.0
  - @dshtrading/router@0.3.0
  - @dshtrading/client-ui-trading@0.3.0
  - @dshtrading/client-ui-settings@0.3.0
  - @dshtrading/strategies@0.3.0
  - @dshtrading/dsh-i18n@0.3.0
  - @dshtrading/client-ui-indicators@0.3.0
  - @dshtrading/client-ui-knowledge@0.3.0
  - @dshtrading/client-ui-masters-quotes@0.3.0
  - @dshtrading/client-ui-strategies@0.3.0
  - @dshtrading/client-ui-updater@0.3.0
  - @dshtrading/dsh-home@0.3.0
  - @dshtrading/eventbus@0.3.0
  - @dshtrading/holdings@0.3.0
  - @dshtrading/indicators@0.3.0
  - @dshtrading/knowledge@0.3.0
  - @dshtrading/watchlist@0.3.0

## 0.2.1

### Patch Changes

- SDK cohort 对齐官方 0.1.5-rc.1：全家族 peer floor >=0.1.5-rc.1，desktop 自带宿主运行时（runtime/host 闭包 lockfile 从零重解析）与 CLI 宿主同世代，发布安装包与本地/CI 构建单一世代。
  - @dshtrading/api@0.2.1
  - @dshtrading/client-ui-indicators@0.2.1
  - @dshtrading/client-ui-knowledge@0.2.1
  - @dshtrading/client-ui-masters-quotes@0.2.1
  - @dshtrading/client-ui-settings@0.2.1
  - @dshtrading/client-ui-strategies@0.2.1
  - @dshtrading/client-ui-trading@0.2.1
  - @dshtrading/client-ui-updater@0.2.1
  - @dshtrading/dsh-home@0.2.1
  - @dshtrading/dsh-i18n@0.2.1
  - @dshtrading/eventbus@0.2.1
  - @dshtrading/holdings@0.2.1
  - @dshtrading/indicators@0.2.1
  - @dshtrading/knowledge@0.2.1
  - @dshtrading/router@0.2.1
  - @dshtrading/strategies@0.2.1
  - @dshtrading/watchlist@0.2.1

## 0.2.0

### Patch Changes

- 41dc2be: 修复两处既存问题（issue #88）：① 指标 vm 试算超时改为可注入（默认仍是 100ms 死循环熔断线）——Windows CI（2 vCPU）上 `pnpm -r test` 全包并行时墙钟抖动会把合法指标误判为超时，测试与 CI 改注入 5s，并新增「默认判超时 / 注入后通过」回归用例，死循环保护用例仍走默认值；② `packages/base` 的四行 npm 复用插件（会话归档 / IM / 使用统计 / 插件管理）其 host 半硬依赖 webServer / workspaceRegistry / connection，headless 宿主（trading-dev、trading-all）缺服务即永久 pending、宿主启动即崩，改为按宿主树是否存在服务提供方行条件禁用——web / 桌面宿主照常启用，功能不倒退。
- Updated dependencies [5a61735]
- Updated dependencies [41dc2be]
  - @dshtrading/holdings@0.2.0
  - @dshtrading/indicators@0.2.0
  - @dshtrading/client-ui-trading@0.2.0
  - @dshtrading/strategies@0.2.0
  - @dshtrading/api@0.2.0
  - @dshtrading/client-ui-indicators@0.2.0
  - @dshtrading/client-ui-knowledge@0.2.0
  - @dshtrading/client-ui-masters-quotes@0.2.0
  - @dshtrading/client-ui-settings@0.2.0
  - @dshtrading/client-ui-strategies@0.2.0
  - @dshtrading/client-ui-updater@0.2.0
  - @dshtrading/dsh-home@0.2.0
  - @dshtrading/dsh-i18n@0.2.0
  - @dshtrading/eventbus@0.2.0
  - @dshtrading/knowledge@0.2.0
  - @dshtrading/router@0.2.0
  - @dshtrading/watchlist@0.2.0

## 0.1.6

### Patch Changes

- 桌面壳角色预设上下文注入自愈：四个角色预设补挂 `dsh-trading-agent-instructions` 行（web 面已关闭宿主 plane 的兜底行，否则会话读不到工作区 AGENTS.md），桌面壳启动前把 profile 内 `@deepseek-ai/*` 核心包归一为自带 runtime 单实例（`normalizeProfileCohort`）——修掉双 `dsh-scope` 实例导致的角色人格、AGENTS.md 与 skill-catalog 三类注入静默失效。
- 770878d: 修复 2026-09-08 代码审查发现的问题：自选 store 单实例化（agent 工具写不再覆盖 GUI 写与分组归属）、未定制市场分组时种子基线完整物化、东财符号形态按实例市场分流 + 港股时间戳 UTC+8 锚定、futu 行情面按市场分实例（美股搜索不再返回港股）、旧 DSH_HOME 一次性数据迁移与 Windows 卸载清理目标修正、OpenD 桥订阅槽 LRU 淘汰，以及配套测试补齐（含两条此前不可失败的冒烟用例）。
- Updated dependencies [770878d]
  - @dshtrading/dsh-home@0.1.6
  - @dshtrading/watchlist@0.1.6
  - @dshtrading/client-ui-trading@0.1.6
  - @dshtrading/api@0.1.6
  - @dshtrading/client-ui-indicators@0.1.6
  - @dshtrading/client-ui-knowledge@0.1.6
  - @dshtrading/client-ui-masters-quotes@0.1.6
  - @dshtrading/client-ui-settings@0.1.6
  - @dshtrading/client-ui-strategies@0.1.6
  - @dshtrading/client-ui-updater@0.1.6
  - @dshtrading/dsh-i18n@0.1.6
  - @dshtrading/eventbus@0.1.6
  - @dshtrading/holdings@0.1.6
  - @dshtrading/indicators@0.1.6
  - @dshtrading/knowledge@0.1.6
  - @dshtrading/router@0.1.6
  - @dshtrading/strategies@0.1.6

## 0.1.5

### Patch Changes

- Release v0.1.5: role-based built-in skill assignment (kit/role-skills whitelist); holdings panel total P&L and per-symbol round-trip history; market symbol search by Chinese name/pinyin with core CN index quotes; preset methodology iron rules for base and kit-crypto; preset injection text unified to English; native trajectory view restored in client-ui-trading; Windows compatibility fixes (LF normalization, CI windows matrix, nsis include hardening); base master-preset dsh-tool-jobs mount fix.
  - @dshtrading/api@0.1.5
  - @dshtrading/client-ui-indicators@0.1.5
  - @dshtrading/client-ui-knowledge@0.1.5
  - @dshtrading/client-ui-masters-quotes@0.1.5
  - @dshtrading/client-ui-settings@0.1.5
  - @dshtrading/client-ui-strategies@0.1.5
  - @dshtrading/client-ui-trading@0.1.5
  - @dshtrading/client-ui-updater@0.1.5
  - @dshtrading/dsh-i18n@0.1.5
  - @dshtrading/eventbus@0.1.5
  - @dshtrading/holdings@0.1.5
  - @dshtrading/indicators@0.1.5
  - @dshtrading/knowledge@0.1.5
  - @dshtrading/router@0.1.5
  - @dshtrading/strategies@0.1.5
  - @dshtrading/watchlist@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies
  - @dshtrading/client-ui-trading@0.1.4
  - @dshtrading/api@0.1.4
  - @dshtrading/client-ui-indicators@0.1.4
  - @dshtrading/client-ui-knowledge@0.1.4
  - @dshtrading/client-ui-masters-quotes@0.1.4
  - @dshtrading/client-ui-settings@0.1.4
  - @dshtrading/client-ui-strategies@0.1.4
  - @dshtrading/client-ui-updater@0.1.4
  - @dshtrading/dsh-i18n@0.1.4
  - @dshtrading/eventbus@0.1.4
  - @dshtrading/holdings@0.1.4
  - @dshtrading/indicators@0.1.4
  - @dshtrading/knowledge@0.1.4
  - @dshtrading/router@0.1.4
  - @dshtrading/strategies@0.1.4
  - @dshtrading/watchlist@0.1.4

## 0.1.3

### Patch Changes

- 桌面版修复：桌面壳宿主进程注入 dsh-scope symbol 归一 loader，修复与 CLI 共管
  trading-web profile 时核心包跨树双实例（各自独立的 `Symbol("dsh.scope")`）导致
  会话 resume 全挂——表现为 `/` 指令菜单无法唤起、重开会话失败。npm 包内容无实质
  变更，本 patch 为随桌面发版门禁的全家族统一 bump（安装包内嵌 workspace tarball
  的版本一致性要求）。
  - @dshtrading/api@0.1.3
  - @dshtrading/client-ui-indicators@0.1.3
  - @dshtrading/client-ui-knowledge@0.1.3
  - @dshtrading/client-ui-masters-quotes@0.1.3
  - @dshtrading/client-ui-settings@0.1.3
  - @dshtrading/client-ui-strategies@0.1.3
  - @dshtrading/client-ui-trading@0.1.3
  - @dshtrading/client-ui-updater@0.1.3
  - @dshtrading/dsh-i18n@0.1.3
  - @dshtrading/eventbus@0.1.3
  - @dshtrading/holdings@0.1.3
  - @dshtrading/indicators@0.1.3
  - @dshtrading/knowledge@0.1.3
  - @dshtrading/router@0.1.3
  - @dshtrading/strategies@0.1.3
  - @dshtrading/watchlist@0.1.3

## 0.1.2

### Patch Changes

- @dshtrading/api@0.1.2
- @dshtrading/client-ui-indicators@0.1.2
- @dshtrading/client-ui-knowledge@0.1.2
- @dshtrading/client-ui-masters-quotes@0.1.2
- @dshtrading/client-ui-settings@0.1.2
- @dshtrading/client-ui-strategies@0.1.2
- @dshtrading/client-ui-trading@0.1.2
- @dshtrading/client-ui-updater@0.1.2
- @dshtrading/dsh-i18n@0.1.2
- @dshtrading/eventbus@0.1.2
- @dshtrading/holdings@0.1.2
- @dshtrading/indicators@0.1.2
- @dshtrading/knowledge@0.1.2
- @dshtrading/router@0.1.2
- @dshtrading/strategies@0.1.2
- @dshtrading/watchlist@0.1.2

## 0.1.1

### Patch Changes

- @dshtrading/api@0.1.1
- @dshtrading/client-ui-indicators@0.1.1
- @dshtrading/client-ui-knowledge@0.1.1
- @dshtrading/client-ui-settings@0.1.1
- @dshtrading/client-ui-strategies@0.1.1
- @dshtrading/client-ui-trading@0.1.1
- @dshtrading/dsh-i18n@0.1.1
- @dshtrading/eventbus@0.1.1
- @dshtrading/indicators@0.1.1
- @dshtrading/knowledge@0.1.1
- @dshtrading/router@0.1.1
- @dshtrading/strategies@0.1.1
- @dshtrading/watchlist@0.1.1
