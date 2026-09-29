# Agent Note: 「发送给 Agent」入口统一——报价头分体按钮 + 下拉菜单收敛三处散落入口

Archived: 2026-09-29
Status: implemented

## Problem

快照投递通道铺开后，「把上下文交给 Agent」的入口散落三处：

1. 图表工具栏「发给 Agent」——行情快照 + 图表截图，且仅图表页签可见（切到衍生品/
   新闻页签就消失）；
2. 衍生品指标条「分析资金面」——衍生品快照，仅 crypto + 图表页签可见；
3. 新闻/公告条目内联「发送给 Agent 分析」——逐条投递。

同一动作（往 composer 填上下文）三个按钮三种叫法三种位置，新用户要分别发现、分别理解；
图表工具栏入口在非图表页签不可见，进一步放大认知成本。owner 2026-09-04 要求：功能与
入口统一合并到「发送给 Agent」按钮，降低使用难度。

## Decision

默认打包范围由 [完整标的上下文](2026-09-06-send-complete-instrument-context.md) 扩展：主按钮与首项菜单现在点击时补齐新闻、公告和基本面，不再只填行情快照；分体入口和只填不发语义保留。

1. **报价头常驻分体按钮**（`css.sendWrap` = 主按钮 + caret，紧随 `.meta` 右对齐）：
   主按钮保留原「发给 Agent」一键直填行情快照的快路径（态机 idle/sending/sent/error
   原样承载于整个按钮组）；caret 打开下拉菜单（`sendBackdrop` + `sendMenu`，复用
   picker 弹层族 z-index 39/40 与脱离式遮罩范式）。
2. **菜单项按可用性显隐**：「行情快照（含图表截图）」恒在；「资金面快照（衍生品指标）」
   仅 `market === 'crypto' && derivatives !== null` 时出现。菜单行为 = 关菜单 + 执行。
3. **填入反馈收敛为 `runFill`**：行情/资金面两路径共用同一套 sending/sent/error 状态
   与 console 告警，`onAnalyzeDerivatives` 更名 `onSendFunding` 并入态机（原实现无
   发送中防抖，借此补齐：`sendState === 'sending'` 时拒绝重复填入）。
4. **散落入口移除**：图表工具栏旧按钮删除（`toolbarActions` 只剩工具开关组）；
   `DerivativesPane` 的 `onAnalyze` prop、按钮与 `.analyze` 样式删除，组件退化为
   纯展示 + 跳转。词典废弃 `derivatives.analyze/analyzeHint`（contract 同步收敛），
   新增 `quote.sendMenuSnapshot/sendMenuFunding/sendMenuOpen/sendFundingHint`；
   顺手修复 zh/en 词典里 `analyzeBody` 与 `analyzeHint` 挤同一行的历史格式问题。
5. **新闻条目内联按钮保留**：它发送的是具体某条新闻（条目级操作），与「当前标的
   上下文」不同维度，统一按钮无法按条投递——不纳入本次收敛。
6. **测试**：smoke 新增统一入口两例（fillComposer 注入 → 主按钮渲染 + 菜单打开 +
   行情快照一键填入 + 资金面项快照未到位时隐藏；未注入 → 入口整体不渲染），
   DerivativesPane 例改为断言发送按钮不复存在。pnpm build / pnpm test（884）/
   i18n:check 全绿。

## Alternatives considered

- **单按钮一键合并（行情 + 资金面一次全发）**：零选择最简，但每次都发全量上下文，
  非 crypto 无资金面、用户无法只发其一；与仓库既有的细粒度文案资产（compose-quote /
  analyzeBody 骨架）冲突。落选。
- **图表工具栏原地改下拉**：改动最小，但非图表页签依旧无入口，收敛目标（一处可发现）
  不成立。落选。
- **纯菜单按钮（点击先开菜单）**：入口唯一性最好，但最高频动作（行情快照）从一击变
  两击，回归既有肌肉记忆。分体按钮 = 快路径保留 + 菜单可发现，胜出。

## Consequences

- 「发送给 Agent」全页签恒在（报价头），语义单一：把**当前标的**的上下文填入 composer，
  只填不发语义不变（owner 2026-09-02 裁决沿用）；快照/菜单形态见本记录。
- 图表截图仍受 `captureRef` 生命周期约束：非图表页签点击主按钮 → 无截图 → 文本尾注
  自动降级为「无截图」变体（既有行为，未改动）。
- `DerivativesPane` 变纯展示后不再感知 fillComposer，QuoteStage 中间层（QuotePane/
  MiddleStage）透传链不变。
- 资金面菜单项依赖衍生品快照在位（30s 轮询首帧前不可用）；现货/非 crypto 市场永不出现。
- 旧入口记录指向：[2026-09-02 自选合并视图 +「发给 Agent」](../../implemented/feature/2026-09-02-watchlist-agent-visibility.md)（工具栏按钮位置决策由本记录取代）、
  [2026-09-03 issue #54 衍生品页签](../../implemented/feature/2026-09-03-issue-54-derivatives-stage.md)（「分析资金面」按钮由本记录收敛）。

## 0.1.7 cohort 迁移（2026-09-23）：会话寻址收口 + 活动会话读面桥

0.1.7 官方把客户端 Session 多实例共存（0.1.6-alpha.2 起）落到插件服务面：
`SessionListState.current` 删除，`ISessions.open`/`list.current` 收口，selection
内化进 `UiWorkspaceService`（`selection` 私有）。因此「填入哪个 composer」不能再读
「当前会话」，改由调用方显式给目标，缺省目标经官方 slot 契约投影：

- `FillComposerFn` 增加可选 `target?: FillComposerTarget`（`{ sessionId }`）；
  `fillComposerWithQuote` 无目标时显式抛错，绝不猜会话（猜错会把行情写进错误
  composer）。
- 活动会话读面桥 `session-target.ts`：挂一个零渲染的官方 `conversation.input.left`
  （session 作用域 list 槽）条目，其 `inject` 工厂收到框架解析的 `sessionId`
  （dsh-client-ui-renderer 的 `runInject` 把 scope binding 的 key 作为首参，按
  entry × binding 记忆化），采集件把 id 投影进插件本地 holder；卸载清回 undefined。
  这是官方 slot 契约上的薄扩展层，不复制官方选择状态。
- `captureTarget()`（异步采集开始前固定目标）改为解析并固定活动会话：采集中切
  会话不会写错目标；采集开始无会话则填入阶段显式报错。
- 上一版（0.1.7 迁移首提交）的「QuoteStage 发给 Agent 暂时显式报错」降级由本桥
  恢复；恢复后的目标语义与升级前一致（填当前显示的会话 composer，只填不发）。
- 验证：`session-target.test.tsx` 3 例覆盖挂载写入/切换跟随/卸载清空；
  client-ui-trading 全量单测通过。**真机 GUI 待验**：本机已安装桌面壳仍跑旧
  cohort（0.1.5-rc.1）runtime，与 0.1.7 客户端包混代会模块割裂，待桌面壳重发布
  （见 [2026-08-29-trading-web-profile.md](../../implemented/process/2026-08-29-trading-web-profile.md)）
  后按本文「真机端到端验收」口径复核一次「发给 Agent」填入链路。
- 端到端 GUI 验收（2026-09-23，隔离 profile + 全局 CLI 0.1.7 宿主 + 无头 Chrome）：
  选中 AAPL → 点「发给 Agent」→ composer 真实出现行情快照文本与随附图表截图缩略图，
  按钮态变为「已填入输入框」，控制台零异常。首次跑失败暴露并修复了同一 cohort 的
  草稿附件 API 变更：0.1.7 把根服务 `createDraftImages([file])` / `releaseDraftImage(id)`
  换成按会话寻址的 `createDrafts(sessionId, files)` / `releaseDraftAttachment(id)`——
  旧调用在附图路径抛 `createDraftImages is not a function`，导致主按钮恒失败。
  `fill-composer.ts` 与单测 fake 已同步到新 API。
- 同一 `SessionListState.current` 删除面还静默打碎了 Home 融合历史面板：`HomeHistory`
  的 `blank` 可见性与 `ChatResizeHandle` 的在场判定都读 `sessions.current`，0.1.7 后
  恒 `undefined`——面板永不物化，官方 WorkspaceBrowser 又被 priority -1 遮蔽，首页
  既看不到历史会话也够不到工作区管理入口；单测 fixture 自带 `current`，全绿漏检。
  修复抽出 `current-session.ts`：按官方 ui-layout（DocumentTitle）/ ui-workspace
  （mainSessionId）同款读法，从 `SessionListState.byId[*].retainedBy.mainView > 0`
  解出当前会话（`mainView` 由 dsh-client-ui-session 声明进 SessionReferenceSourceMap），
  HomeHistory 与 ChatResizeHandle 共用。验证：新增 `current-session.test.ts` 3 例 +
  `home-history.test.tsx` 两条可见性回归；隔离 profile（trading-web 副本 + 0.1.7 桌面
  runtime :8890）无头 Chrome 实测首页融合面板在位（历史会话 44 条：可见 3 行 +
  「展开其余 41 条」，工作区 ⋯ 入口在位），控制台零异常。
