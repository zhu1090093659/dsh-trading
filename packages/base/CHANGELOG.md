# @dshtrading/base

## 0.6.1

### Patch Changes

- Windows 可移植性修复：桌面构建在 windows-latest 上恢复。

  - **authority（属主隔离按平台能力判定）**：属主/权限这一层的前提是 POSIX 语义。Windows 上 `process.geteuid` 不存在，`fs.Stats.uid` 恒为 0、`mode` 按只读属性合成——「平面归另一个 uid」没有可比对的证据。新增 `hasUidSemantics()` 与 `uidSemantics` 选项，能力不成立即 `no-uid-semantics`，与是否注入 `euid` 无关。修正前注入 `euid` 会把合成 stat 当真属主，得出 `group-or-other-writable` 这类假阳性结论（把「不知道」说成某个具体判定）；不注入时读取端已 fail-closed，写入侧也在同码先抛，故生产路径并未放行，缺陷在「注入即改口」。该层此前从未在 Windows 上跑过：`pnpm -r test` 遇首个失败包即中止，排在它前面的 `dsh-home` 一直先红，把它整段遮住。
  - **base（Office 接线用例按本平台算期望值）**：`path.resolve('/opt/dsh-primary-runtime')` 在 Windows 上会按当前盘符补成 `D:\opt\dsh-primary-runtime`；把 POSIX 结果写成跨平台事实会让该用例在 windows-latest 判红。承接前一条：authority 修好后 base 成为首个失败包。

  发布意图：0.6.0 的 npm 包已公开但桌面构建在 Windows 失败，GitHub Release 因 all-or-nothing 未创建；本版本把 Windows 修复与已发布的 0.6.0 内容一起补齐，以新版本号发布完整 Release。

  - @dshtrading/api@0.6.1
  - @dshtrading/connector-jin10@0.6.1
  - @dshtrading/dsh-home@0.6.1
  - @dshtrading/eventbus@0.6.1
  - @dshtrading/holdings@0.6.1
  - @dshtrading/indicators@0.6.1
  - @dshtrading/knowledge@0.6.1
  - @dshtrading/router@0.6.1
  - @dshtrading/strategies@0.6.1
  - @dshtrading/watchlist@0.6.1

## 0.6.0

### Minor Changes

- 0.6.0：宿主 cohort 前移后的工具面收口、官方 Office 技能接线、加密永续/合约交易语义、Futu 桥交易面与桌面壳刷新。

  - `@dshtrading/base`：接线官方 Office provider 与 workspace-dependencies 行（`DSH_PRIMARY_RUNTIME` 门控，无载荷显式缺席）；多进程整表 store 增加跨进程写保护（锁文件 + 陈旧回收 + 锁内读-改-原子写）。
  - 工具注入面：全量描述体例统一、host 读工具声明 value-schema 输出、只读现状扫描器 `tool-surface-inventory`（33 个注入点 / 149 个工具基线）。
  - `@dshtrading/api`+`@dshtrading/router`+`connector-binance`/`connector-okx`/`connector-bybit`/`connector-ccxt`+`@dshtrading/kit-crypto`：标的形态契约（`form` = spot/perp）与 TradFi 永续元数据落地，名册/行情按形态分流，检索面与 `/symbols` wire 透传 `form`/`assetClass`。
  - OKX 合约交易 Tier 2：合约下单（张 ↔ 币按 ctVal 向下取整）、`crypto_set_leverage` 杠杆/保证金模式（与下单同门槛）、持仓强平/保证金字段；Binance `-SWAP` 下单显式 `TRADING_UNSUPPORTED_SYMBOL`，绝不回落现货端点。dry-run 仍是缺省，实盘仍需人工签署授权 + 审批。
  - `@dshtrading/connector-futu`：桥交易面按 owner 授权开启（三条 `/api/trd/*` POST 路由 + 挂单列表契约，布尔/缺 accId/GET 均结构化拒绝）。
  - `@dshtrading/indicators`+`@dshtrading/client-ui-trading`：指标适用范围（按市场独立开关与 K 线级别）、KDAS 关键日图表右键菜单（设/删 Key Day）。
  - `@dshtrading/client-ui-special-indicators`：桥缓存落盘（宿主重启后首个请求直接命中）；滞后徽标改按「上游数据日 vs 预期数据日」判定；板块双栏/单栏断点改按中栏实际宽（`@container`）。
  - `@dshtrading/client-ui-bot-gui`（新，private）：交易终端内嵌机器人控制台插件（header run-mode badge + 决策 feed 分页）。
  - `@dshtrading/bot-api`（新）：公开 GUI 的服务端半（回迁主仓）。
  - `@dshtrading/dsh-home`：缺省 home 告警（解析到 `~/.dsh` 且存在 `~/.dsh-trading` 时提示，返回值与优先级不变）。
  - 桌面壳：宿主存在自带 primary runtime 时交接给宿主；移除附着模式分支。
  - 仓库治理：仓库边界门禁（主仓不再长出自动交易实现，该平面迁往私有卫星仓）；CI 接线双向门禁；`scripts/refresh-profile.sh` 泛化刷新任意 profile 并强制重挂核心包 symlink。

### Patch Changes

- @dshtrading/api@0.6.0
- @dshtrading/connector-jin10@0.6.0
- @dshtrading/dsh-home@0.6.0
- @dshtrading/eventbus@0.6.0
- @dshtrading/holdings@0.6.0
- @dshtrading/indicators@0.6.0
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
