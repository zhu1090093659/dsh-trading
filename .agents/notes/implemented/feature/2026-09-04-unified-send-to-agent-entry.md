# Agent Note: 「发送给 Agent」入口统一——报价头分体按钮 + 下拉菜单收敛三处散落入口

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
- 旧入口记录指向：[2026-09-02 自选合并视图 +「发给 Agent」](../2026-09-02-watchlist-agent-visibility-and-send-to-agent.md)（工具栏按钮位置决策由本记录取代）、
  [2026-09-03 issue #54 衍生品页签](2026-09-03-issue-54-derivatives-stage.md)（「分析资金面」按钮由本记录收敛）。
