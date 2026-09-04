# Agent Note: 行情上下文对 Agent 透明——自选合并视图 + 「发给 Agent」一键投递

Status: implemented

## Problem

owner 2026-09-02 实测暴露两处「行情插件数据对 Agent 不透明」缺口（附截图：会话里用户问"看一下苹果的行情"，agent 翻文档、读别的仓库的适配器源码，最后答"苹果不在自选里(美股只跟踪 GOOGL/MSFT/PURR)"——而用户左栏明明看着苹果）：

1. **自选行 agent 不可见**：GUI 左栏的展示行 = 用户定制行 ∪ 市场种子行（`rowsFor` 回落），但种子表只活在 client-ui-trading `store.ts`，host 侧 `watchlist_list` 只读用户定制行（`~/.dsh/watchlists.json` 实况：只有 HYPEUSDT）。用户眼里的"自选"与 agent 眼里的"自选"是两个集合；工具描述里"falls back to client-side seed display"一句对 agent 只是不可展开的注释。`watchlist_select` 的名称解析（自选行带展示名）也因此漏种子行——agent 从 list 看到行、select 却拿不到名。
2. **行情上下文无投递通道**：用户正在看的标的/周期/指标/图表，agent 只能靠用户手打文字描述；没有"把当前标的发给 agent"的 UI 入口。

## Decision

1. **种子表上收为共享单源**（新 `@dsh-trading/watchlist/src/seeds.ts`）：`WATCHLIST_SEEDS` + `effectiveWatchlistRows`（定制行优先、未定制回落种子，与客户端 `rowsFor` 同构）+ `watchlistRowSource`；client `store.ts` 的 `DEFAULT_WATCHLISTS` 改为再导出（client bundle 把纯数据模块内联，tsdown alwaysBundle 路径，实测 `贵州茅台` 在产物中）。
2. **`watchlist_list` 输出合并视图**：`watchlists` = 各市场有效展示行（与 GUI 左栏一致），新增 `sources[market] = 'custom' | 'seed'`；描述改写为权威口径——"this list IS what the user sees"，指示 agent 在用户提到任何标的（名称或代码）时**先调本工具**，并标注展示名↔代码映射（苹果 → AAPL / us）。
3. **`watchlist_select` 名称解析走合并视图**（`effectiveWatchlistRows` 查找），种子行同样复用展示名，与 list 契约闭环。
4. **「发给 Agent」按钮**（QuoteStage 工具栏右侧，与指标选择器同组 `css.toolbarActions`；2026-09-04 起入口迁至报价头统一「发送给 Agent」分体按钮，见 [unified-send-to-agent-entry](2026-09-04-unified-send-to-agent-entry.md)）——**只填入会话输入框，不自动提交**（owner 2026-09-02 复审裁决：首版直接 `session.prompt` 启动分析过了头，用户大概率还要补自己的 prompt，发送必须由用户自己按）：
   - 文本上下文：`compose-quote.ts` 纯函数组装（名称·代码·市场·周期 + 现价/涨跌/昨收 + 十字线读数 K 线 OHLCV + 已开指标），截图有无只影响尾注；
   - 图表截图：TvChart `onCaptureReady` 注册 `chart.takeScreenshot()` 回调（v5 覆盖主图+副图 pane，白底、不含十字线），挂载注册/卸载置 null，QuoteStage 经 `captureRef` 消费；
   - 落地通道（模块改名 `fill-composer.ts`，编排纯函数零 SDK runtime import）：根服务 `ctx.get('conversation')`（ConversationController）的 `createDraftImages([file])` 把截图注册成 browser-owned 草稿图 → per-session `input.shell(sessionId)` facade 的 `addImages(ids)` 挂图、`setDraft(text)` 写草稿——`setDraft` 是整稿替换，先读 `state.draft` 非空时以空行拼接追加，绝不覆盖用户已打内容；**绝不调 `submit()`**；composer 提交中（`phase !== 'plain'`）拒绝写入（防与乐观提交竞态），`addImages` 被拒时回收草稿图、文本照填；
   - 无会话时经 uiWorkspace `startSession()` 建会话并短轮询（100ms×30）等 `list.current` 落地再填；截图经 `dataUrlToFile`（atob → PNG File）摄取；
   - 按钮态机 idle/sending/sent/error（文案改「填入中…/已填入输入框/填入失败」，title 说明"可继续编辑，自行发送"）；`fillComposer` prop 可选，独立渲染/单测不注入时按钮不渲染。注入链：client `apply()` 组装（`sessions` + `conversation`/`uiWorkspace` 均点击时惰性解析）→ QuotePane → MiddleStage → QuoteStage。
5. **测试**：watchlist 合并视图/来源标注/种子名解析 8 例；client `agent-send.test.ts`（fake ISessions）8 例——queue 投递与 requestId 贯穿、附图剥前缀、被拒 abandon、无会话建会话轮询、始终无会话抛错、compose 文案全量/缺省两态。全仓 654 通过、build 全绿。

## Alternatives considered

- **客户端首启把种子行写进 host store（升级迁移同款）**：会违背 issue #32/P3 的既定裁决「种子不进 host」——种子是展示回退不是用户数据，写进去后 remove/customize 语义全部变形，多端（重置 localStorage 的浏览器）行为漂移；合并视图在读取侧闭环，零写入。
- **`watchlist_add` 时自动补全市场种子**：方向反了——用户加一行不该拉进来 14 行噪音，agent 侧重复度更高。
- **按钮走 DOM 注入 composer（querySelector 填 textarea）**：官方 composer 是 shell 持有的 Lexical 编辑器，对外只暴露 session 作用域 slot 的 `InputActions` 标准 prop 与 `conversation` 根服务（`SessionInputResolver` face）——`setDraft`/`addImages` 是文档化的程序化写入口，DOM hack 反而绕过草稿镜像与撤销栈（旧首版 `session.prompt` 直投方案已被 owner 复审否决：自动启动分析过了头，见 Decision 4）。
- **截图走 html2canvas 全面板**：重依赖 + CSS 兼容风险；v5 `takeScreenshot()` 是库原生能力，零依赖覆盖图表主体（头部报价文本已并入消息文本，无需入图）。
- **无会话时禁用按钮**：home 场景（未开会话）恰是用户最可能指行情问询的时刻；startSession + 短轮询让入口恒可用。

## Consequences

- agent 与 GUI 的"自选"语义从此同源：种子表改动只碰 `seeds.ts` 一处；`watchlist_list` 输出多了 `sources` 字段（旧消费者无——该工具输出仅 LLM 阅读）。
- 「发给 Agent」只准备不发送：草稿（文本 + 截图缩略）停在 composer，由用户补 prompt 后自行提交；写入不进 durable log，不触审批链、不烧 token。
- 填入依赖宿主 `conversation` 根服务 + `sessions`/`uiWorkspace` 服务面（alpha.2 实测契约）；宿主升级若改 `setDraft/addImages/createDraftImages` 签名，故障面收敛在 `fill-composer.ts` 单文件。
- **验证记录**：pnpm build / test 全绿（657，新增 8+9 内）；trading-web profile 副本 client-ui-trading 经硬链接原地直达（inode 一致），watchlist 副本分叉已 `ln` 重建硬链接。实机 UI 走查见交付记录。
