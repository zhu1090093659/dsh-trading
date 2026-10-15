# Agent Note: 客户端 UI 四包移除零消费者的死组件、死样式、死图标与死词典键

Status: implemented

## Problem

`packages/client-ui-*` 里四类面已无任何 shipped 消费者，却仍参与构建、覆盖率分母与词典门禁：

- **TradeDesk 组件与它的整张 CSS 是孤儿**。`client-ui-trading/src/client/TradeDesk.tsx`（252 行）
  与 `trade-desk.module.css`（199 行）是 issue #40 的行情页底部交易工作台（设计记录在
  [archived/feature/2026-09-02-issue-40-trade-desk.md](../../archived/feature/2026-09-02-issue-40-trade-desk.md)）。
  后续 `QuoteStage.tsx:1468-1469` 在同一个 `tradeDeskOpen` 开关下改渲染 `OrderPanel`，组件本体
  从此没有入口：八个 client-ui 包加 `gui` 与 `desktop/src` 的 import 图零命中，包内 `TradeDesk`
  文本也只命中自身。CSS Modules 内联按 importer 解析模块说明符，无 importer 即不进包——
  这 199 行既不渲染也不随包发出。
- **12 条死 CSS 规则**（规则本体 73 行，连分隔空行与所属注释 86 行）：
  `fundamentals-stage.module.css` 的 `.rangeTrack` / `.rangeProgress` / `.shareholdersWrap` /
  `.shareholdersTable{, th, td}`（现役是 `.rangeGaugeWrap` 一族与 `.holderRank`，
  `FundamentalsStage.tsx:717-724` 在用）、`quote-stage.module.css` 的 `.subTabNav` 与
  `.subTabBtn` 四条状态（现役是 `.stageTabs` / `.stageTab`，`QuoteStage.tsx:1010-1059`）、
  `updater-panel.module.css` 的 `.statusTextAvailable`（同文件 `.statusTextError` 仍在用）。
  十二个类名在全仓 `.ts/.tsx` 里零出现（含模板字符串）；包内唯一的动态类名索引是
  `OrderbookPane.tsx:130` 的 `css[kind]`，与本组无关。
- **3 个死图标**：`client-ui-trading/src/client/icons.tsx` 的 `IconSearch` / `IconStrategy` /
  `IconKnowledge` 零引用。真正在用的同名同形副本住在两个视图包自己那里
  （`client-ui-knowledge/src/client/icons.tsx`、`client-ui-strategies/src/client/icons.tsx`），
  后两者文件头把「不 import shell 内部模块」写成契约，该镜像是有意的，不在移除面内。
- **30 个死词典键**：`client-ui-trading` 21（上一代 `fundamentals.*` 15 个，加 `trade.liveChannel`、
  `trade.drawer.asset`、`trade.paper.tag`、`trade.paper.initialBalance`、`trade.paper.totalPnl`、
  `trade.holdings.origin`）、`client-ui-knowledge` 6、`client-ui-settings` 2、`client-ui-bot-gui` 1。
  zh 与 en 两份加上键联合共 89 行。`scripts/i18n-audit.mjs` 只校 zh/en 键位与占位符对齐、
  不校使用量，因此门禁主动维持这 30 个永不显示的字符串，每新增一种语言都要再翻译一遍。

## Decision

四个包一次删除 659 行，分四组，判定口径统一为「有没有 shipped 消费者」——测试引用与类型
声明只证明契约存在，不证明有消费方：

- `TradeDesk.tsx` 与 `trade-desk.module.css` 整文件删除；`QuoteStage` 的开关与刷新链
  （`tradeDeskOpen` / `setTradeDeskOpen` / `refreshTradeDesk` / `writeTradeDeskOpen`）是活代码，
  一行不动。
- 12 条死 CSS 规则删除；相邻的现役规则与中文注释保留（`.holderRank` 段继续享有
  「十大股东表格」注释）。
- `icons.tsx` 三个死导出删除；两个视图包的镜像副本保留。
- 30 个死键从各包 `locales.ts` 的 zh 与 en 两份、以及 `contract.ts` 的键联合里同批删除。
  `client-ui-settings` 的键联合与词典同文件；`client-ui-bot-gui` 的词典是无类型标注的
  `export const zh = { … }`，没有联合要同步。

## Alternatives considered

- **保留 TradeDesk 作为「将来恢复底栏工作台」的底稿**：否决。它承载的是已被 GUI 逐动作审批
  取代的旧架构，而同一段安全边界散文（`dryRun:false` 直通桥 + `liveTrading` 显式开关）在
  `OrderPanel.tsx` 与其调用面仍有一份；留着它只是留一份「改 bug 改错文件」的机会。
- **只删组件或只删 CSS**：否决。组件没有 importer 才使那张 CSS 模块进不了包，两者是同一个
  事实的两半——留下任一半都会让另一半看起来仍在使用。
- **给 30 个死键加 `i18n-allow:` 豁免而不删除**：否决。豁免是给「有意不翻译」的键留的逃生口，
  而这 30 个键没有任何渲染点；用豁免表达只会让门禁继续为它们要求两语齐整。
- **把「词典键零引用」做成新门禁**：否决。静态键使用量的假阳性面太大——四包里靠字符串拼接
  命中的键就有 8 个（`'market.' + market.key`、`` `bot.runMode.${runMode}` `` 等），
  门禁会先制造误报、再需要一份豁免清单，那正是本次要移除的那类维护义务。

## Consequences

- 净删 659 行 / 12 个文件：组件与其 CSS 451、CSS 规则 86、图标 33、词典与键联合 89。
- 现场取证（基线 HEAD `0d1f8685` 之后的本次改动）：
  - `pnpm build` 退出码 0（日志里 4 处 `error` 字样是 `lib/errors.js` 产物文件名，不是报错）；
  - `pnpm i18n:check` OK：**1017** zh keys / 30 exemption —— 删前为 1047，差值正好 −30，
    即门禁的键数统计独立复算了本次的删除面；
  - 六个受影响包 `pnpm --filter … test`：76 个测试文件 / 628 例全绿
    （trading 547、settings 27、bot-gui 24、updater 15、dsh-i18n 8、knowledge 7）。
- 30 个死键由调度者另写一遍扫描脚本独立复算（词典键集 × 全仓 `.ts/.tsx` 文本，排除
  `locales.ts` / `contract.ts` / `lib`，并对 `'prefix.'` 拼接线索做动态前缀剔除），
  与勘察结论逐键一致，且测试引用为 0 —— 本次删除不动任何测试断言。
- 覆盖率分母同步下降（`TradeDesk.tsx` 原为 204 行 0 覆盖），棘轮基线只会向好的方向变化，
  刷新留到本轮清理的统一验收里做。
- 未跟踪空目录 `packages/client-ui-trading/src/tasks/`（`src/client/tasks-api.ts` 迁走前的
  旧位置残留，git 未跟踪）随本次清理删除。
