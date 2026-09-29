# Agent Note: 下线会话输入框的「发给 Agent」填入入口

Status: implemented

## Problem

客户端曾有三处「把上下文填进会话输入框（只填不发）」入口：报价头「发给 Agent」分体按钮（行情/公告/新闻/基本面/资金面快照 + 图表截图）、新闻列表每行的「↦ Agent」、资产面板「导入持仓」引导。三处共用 `fill-composer.ts` 通道（`conversation.createDrafts` + per-session `input.shell` 的 `setDraft`/`addAttachments`）与 `session-target.ts` 活动会话读面桥，另带 `compose-quote.ts` / `compose-quote-data.ts` / `compose-research.ts` 三个组装纯函数与 TvChart 截图回调。owner 2026-09-29 判定该入口整体不再需要：Agent 已有行情、新闻、公告、基本面与持仓原语工具，用户直接描述标的即可，不必经由草稿注入通道。

## Decision

- 报价头分体按钮、新闻行「↦ Agent」、资产面板「导入持仓」三处入口全部移除（含下拉菜单与其「资金面快照」菜单项）。
- 删除独占实现：`fill-composer.ts`、`session-target.ts`、`compose-quote.ts`、`compose-quote-data.ts`、`compose-research.ts`、`IconSend`、TvChart 的 `TvChartCapture`/`onCaptureReady` 截图回调，以及 `QuotePane`/`MiddleStage`/`SessionRail`/`QuoteStage`/`NewsFeedPane`/`HoldingsPanel` 的 `fillComposer` 透传 props。
- 词典收敛：`quote.sendToAgent*`、`quote.sendMenu*`、`quote.sendFundingHint`、`news.sendToAgentTitle`、`compose.*`、`derivatives.analyzeBody`、`trade.holdings.import*` 的 zh/en 键与 `contract.ts` 键 union 同步删除；对应 CSS 规则与单测一并移除。
- 持仓录入保留「手动新增」对话框；截图解析入库仍由 Agent 的 `holdings_stage` 工具完成，不新增客户端入口。
- 按 owner 要求同步移除仓库文档中的入口截图与描述（README.md / README_zh.md / docs/design/holdings-ledger.md、README 截图记录），并原地修正引用该入口的既有 implemented 记录事实（换向 [composer 填入入口下线] 指针）。

## Alternatives considered

- **只隐藏按钮、保留组装与填入代码**：违背「完全移除」诉求，留下无调用方的死代码与测试。落选。
- **保留 fill-composer 通道、只删三个入口**：通道将没有任何调用方；保留会误导后续把新入口接进这条已被否决的路径。落选。
- **保留新闻行「↦ Agent」单条投递**（2026-09-04 曾以其为条目级操作为由保留）：owner 要求三处一并下线；条目 URL 仍可由用户直接粘贴，Agent 也有新闻工具。落选。

## Consequences

- 客户端不再有向会话输入框写入草稿的入口；`session-target.ts` 的活动会话读面桥随之成为死代码并删除，0.1.7 会话寻址收口不再有插件侧消费方（宿主 `conversation` 根服务仍由官方 UI 使用）。
- 快照文本、图表截图与资金面上下文的组装逻辑不再存在；行情与资金面数据改由 Agent 用原生工具按需取用，上下文体积按分析深度发生。
- 上一代记录归档：[2026-09-04 入口统一](../../archived/feature/2026-09-04-unified-send-to-agent-entry.md)、[2026-09-05 快照升级](../../archived/feature/2026-09-05-send-to-agent-kline-series-and-indicator-values.md)、[2026-09-06 完整标的上下文](../../archived/feature/2026-09-06-send-complete-instrument-context.md)；自选合并视图决策保留在 [2026-09-02 自选合并视图](../feature/2026-09-02-watchlist-agent-visibility.md)。
