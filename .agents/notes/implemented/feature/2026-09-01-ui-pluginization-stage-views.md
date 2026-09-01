# Agent Note: UI 插件化收口——tradingStageViews 开放注册面 + 视图拆包 + toolview 富卡片（issue #34 / P5）

Status: implemented

## Problem

中栏视图注册表 `MIDDLE_VIEWS` 是 client-ui-trading 的内部常量，第三方无法贡献视图——与「一切皆插件」裁决（D1）不符。策略/知识视图代码寄生于 shell 包，无法独立装卸；对话内工具结果只有官方通用行，无富卡片。

## Decision

1. **`tradingStageViews` client 服务**（`stage-views.ts`，仿 tradingIndicators provide 模式）：
   - `createStageViewRegistry()`：register/unregister/list/subscribe/getVersion（useSyncExternalStore 驱动 tab 条）；definition = `{ id, titleKey, order?, render }`；
   - **quote 是工厂内建种子条目**（绕过公开 register 的保留 id 检查——shell 自注册会撞 `RESERVED_STAGE_VIEW_ID` 防线，trading-web 实测 boot 崩，见 Gotchas）；
   - **同 bundle 直引实例、跨 bundle 走服务**：registry 模块单例只在本包内安全（ESM bundle 隔离，indicators registry 同款教训），插件视图一律 `ctx.inject(['tradingStageViews'])`；
   - MiddleStage：tab 条从名册渲染；quote 走 QuoteStage 直引（需全部指标动作面），插件视图走 `definition.render({ t, view })`；持久化 id 指向未安装视图时回落 quote（卸载安全）。
2. **`tradingBridge` client 服务**（api.ts `createTradingBridgeService()`）：视图包对桥的唯一依赖面（fetchKlines/fetchCustomStrategies/fetchKnowledgeCards/subscribeTradingEvents）。两个动机：插件间不得 import 彼此内部模块（D1）；SSE EventSource 单例留在 shell，多视图包共享一条连接。
3. **视图拆包**：`@dsh-trading/client-ui-strategies`（id `strategy`，order 10；引擎经 `@dsh-trading/strategies` 纯库）与 `@dsh-trading/client-ui-knowledge`（id `knowledge`，order 20；force-graph 随包打包，shell 卸下该依赖）。文案走**独立 locale namespace**（`dshtrading.strategies` 的 `sv.*` / `dshtrading.knowledge` 的 `kv.*`）——同 NS 双包注册会整表覆盖。shell 词典同步删掉 strategy./knowledge. 前缀 61 键。**插件间零内部模块 import**：视图包各自镜像 readJson/writeJson 与最小类型面（shell-faces.ts，~20 行，编译期可见漂移）。
4. **toolview 富卡片**（keyed slot `tool.call.toolview`，官方 dsh-client-ui-tool 契约：`{ name, key: '<工具名>', locale }` + 组件收 `ToolCallOwnerProps`）：
   - 归属随视图：client-ui-strategies 注册 `strategy_backtest`（权益 sparkline + 8 指标 mini 卡）与 `strategy_author`（校验结果/参数摘要）；shell 注册 `crypto|us|cn|hk_place_order`（三态标识：模拟单/实盘单/已拒绝 + 参考价）与 `watchlist_add`/`watchlist_select`（标的 chip）；
   - **契约：running 或解析失败 → 返回 null 回落通用工具行**（卡片坏了不吞工具结果）；
   - 解析器防御式全字段容错（wire 数据不可信），place_order 覆盖三态形态（闸门拒绝 `{status:'rejected'}` / dry-run 回执 `{dryRun:true,...}` / 实盘 OrderReceipt 无 dryRun 字段）与 instId/symbol/ticker 别名。
5. **挂载**：base cordis.patch.yml insert 两行（`dsh-trading-client-ui-strategies/knowledge`）+ base deps；`sync-profile-overrides.mjs --all` 补 5 个 profile 的 overrides。

## Gotchas（实测踩坑，后续拆包必读）

- **cordis 插件 `export const inject` 是服务名名单，不是包 id**：dsh.client.inject（package.json）是包 id（加载/预取元数据），插件体的 inject 是服务名。视图包 apply 里同步访问 `ctx.locale`/`ctx.slots` 就必须声明 `inject = ['slots', 'locale']`，否则 boot 崩 `cannot get property "locale" without inject`（trading-web 实测两连崩）。
- **quote 种子不能走公开 register**：保留 id 防线会拒绝 shell 自己——种子在 `createStageViewRegistry()` 工厂内写入。
- **lightningcss NAPI 的 code 参数必须传 Buffer**（tsdown.client.config.mjs 复制自 indicators 包的版本传 string，构建炸 `Get TypedArray info failed`；trading 系 config 注释里早有此坑记录）。
- **keyed slot 的 locale 字段是可选 NS**，视图包用自己的 NS；owner 传入的 `t` 由官方 renderer 按 NS 绑定。
- **blank-hero 态 composer 不接受 CDP 输入**（insertText/paste/keyEvent 均不进，placeholder「选择一个工作区开始」不随 workspace 菜单选择变化）——对话内端到端发消息在本轮自动化验收中受阻（官方输入时序，非 P5 改动面）；富卡片验收降级为「组件级 jsdom 渲染测试 + CSS 注入旁证 + keyed slot 注册路径执行」。

## Alternatives considered

- **quote 也走 definition.render**：QuoteStage 需要中栏全部指标动作面（toggleIndicator/setIndicatorParams/deleteIndicator/useChart），definition.render 只收 `{t, view}`——要么扩 props 面（开放面变宽）要么保留直引（quote 保留 id 语义即「shell 内建」）——选直引。
- **视图包直接 import shell api.ts**：违背插件间服务化协作（D1），且各包自开 EventSource 会线性堆积连接——收口 tradingBridge 服务。
- **文案留在 dshtrading.market**：titleKey 类型约束会让视图包依赖 shell 词典键集；且 locale.register 同 NS 后注册覆盖先注册者（整表替换语义）——独立 NS。
- **toolview 卡片全放 shell**：strategy_backtest/author 的展示语义属于策略视图包（拆包目标就是能力自治）；且 keyed slot 注册是插件面行为，归属清晰。

## Consequences

- 第三方视图插件接入面 = `ctx.inject(['tradingStageViews'], scope => scope.tradingStageViews.register({...}))`，与 tradingIndicators 同构；可选依赖语义成立：卸载 client-ui-strategies/knowledge 任一包，中栏只剩「行情」tab 正常工作（未实测 live 卸载——无 live 卸载纪律，重启宿主验证口径）。
- 对话内富卡片：strategy_backtest（sparkline+8 指标）、strategy_author（校验结果）、`<market>_place_order`（三态+参考价）、watchlist_add/select（chip）。
- 验收记录：pnpm build 全绿；pnpm test 637 passed（+14：toolview-parse 7+7、toolview-card jsdom 6）；trading-web profile 重启 + 刷新实测「行情 | 策略 | 知识库」三 tab 注册/切换/视图挂载/零 JS 错误，两包 toolview CSS 注入旁证 keyed slot 注册路径执行。对话内富卡片端到端待 owner 日常会话自然回归（blank-hero 输入自动化受限，见 Gotchas）。
- Profile 刷新链路：refresh-trading-web-profile.sh 全量重装 + 宿主核心包 symlink 重挂，一次通过。

## Files

- `packages/client-ui-trading/src/client/stage-views.ts`（新，注册面 + quote 种子）
- `packages/client-ui-trading/src/client/api.ts`（+tradingBridge 服务装配）
- `packages/client-ui-trading/src/client/MiddleStage.tsx`（动态名册渲染）
- `packages/client-ui-trading/src/client/{toolview,toolview-parse,toolview.module.css}`（新，place_order/watchlist 卡）
- `packages/client-ui-trading/src/client/index.ts`（provide×2 + toolview 注册 + 词典瘦身）
- `packages/client-ui-trading/src/client/contract.ts`（迁出 61 key）
- `packages/client-ui-strategies/*`、`packages/client-ui-knowledge/*`（新包全量）
- `packages/base/cordis.patch.yml` + `packages/base/package.json`（挂行+deps）
- 迁出：StrategyView.tsx/.module.css → strategies 包；KnowledgeView/KnowledgeGraph.tsx/.module.css → knowledge 包