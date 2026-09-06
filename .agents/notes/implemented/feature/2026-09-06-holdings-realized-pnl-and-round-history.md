# Agent Note: 资产面板总盈亏（已实现 + 浮动）与每标的历史持仓（平仓回合）

Status: implemented

## Problem

右侧资产面板（HoldingsPanel）权益条只有「总资产」，缺总口径盈亏；且持仓视图只有当前快照——平仓后再新开仓，上一轮的持仓盈亏信息无处可看（issues #65 台账只记未实现盈亏，无已实现账本）。

需求（2026-09-06 用户澄清）：① 权益条计算**已实现总盈亏 + 盈亏比例**；② 每个标的提供**历史持仓信息**——平仓后再开仓仍能回看曾经的持仓盈亏。

## Decision

1. **FIFO 持仓回合撮合引擎（新模块 `position-rounds.ts`，纯函数 + 8 项单测）**：
   - 从成交流水按 FIFO 撮合出「净持仓 0 → 开 → 清零」的回合：openTs/closeTs、closedSize、avgEntry/avgExit、realizedPnl（Σ(卖价−买价)×量，费用不计——paper fee 恒 0）；回合内多段平仓累加进同一回合（对齐交易所「回合盈亏」口径）。
   - 输入顺序不敏感（内部按 timestamp 稳定排序，兼容 paper store 最新在前存储）；流水不完整时匹配不到成本批次的卖出不计盈亏与平仓量（宁缺勿编）。
   - `convertUsdToBase`：模拟池按 USD/USDT 记账，展示时折算基准币，fx 缺席/缺 USD 汇率 → undefined（权益条整块隐藏）。
2. **数据源边界（v1 明示）**：唯一完整自洽的成交流水是 paper 本地账本（localStorage fills 持久化），已实现口径 v1 仅覆盖模拟盘；导入持仓（截图快照、无流水）与实盘（连接器 fills 历史窗口不完整）暂不参与，UI 文案（realizedHint/history.hint）如实披露。`TradeFill` 是 `@dshtrading/api` 公共契约，不动它——按 #65 `PaperPosition` 先例在 paper store 做客户端扩展 `PaperFill = TradeFill & { market? }`，新流水补记 market 供回合打市场标签（旧流水无 market → 按 symbol 分组）。
3. **浮动总盈亏（`holdings-aggregate.ts` 扩展，契约内纯增量）**：`HoldingDetailRow.costBase`（entryPrice×size 折算）；聚合输出 `totalPnlBase`/`totalCostBase`/`pnlRatio`——**比例只在「盈亏行集合 === 成本行集合」时给出**（缺成本价或缺现价的行会让分子分母口径错位，不一致时 undefined 宁缺勿错）。
4. **UI（权益条 + 已平仓历史分区）**：
   - 权益 hero 条追加「已实现」（paper FIFO 回合合计 + 比例 = 已实现÷平仓成本）与「浮动」（盯市 uPnL 合计 + 比例）两块，方向色走 directionColor（跟随红涨/绿涨色板）；窄容器 flex-wrap 换行右对齐。
   - 汇总页签新增「已平仓历史」分区：按标的聚合回合（徽章「已平仓」+ 轮数 + 最近平仓日期 + 已实现合计与比例），展开看每轮 `#n 起止日期 数量 avgEntry → avgExit ±盈亏`；**持仓清零的标的也保留**（与 summaries 互不吞并）——这正是「平仓后再开仓回看上一轮」的入口；最近平仓的标的前置。
   - 文案键 9 个（zh/en 同步，`contract.ts` MarketLocaleKey 收口），i18n-audit 通过。

## Alternatives considered

1. **在 paper 撮合引擎卖出时同步记 realizedPnl 台账**：否决——fills 本身完整持久化，FIFO 从流水可精确重放，单一事实源（流水），免迁移免双记账。
2. **已实现台账上收 holdings 包/bridge（服务端）**：本轮否决——导入/实盘无可信流水源，服务端账本解决不了数据从哪来的问题；留作实盘 fills 持久化需求成熟后的跨包演进（届时走 PR 流程）。
3. **删除导入持仓时用最后盯市价记「近似已实现」**：否决——违背台账「不编造」纪律，退出价未知就是未知。
4. **比例不设覆盖一致性门槛（直接 Σ盈亏/Σ成本）**：否决——缺成本价行只进分子不进分母会系统性高估/低估收益率，宁缺勿错。

## Consequences

- 权益条一条看全三个总口径：总资产 / 已实现（含比例）/ 浮动（含比例）；模拟盘平仓历史按标的可回看，每个回合开平均价与盈亏独立成行。
- 旧 paper localStorage 数据零迁移可算（fills 全量重放）；新流水起 market 标签逐步补齐。
- 全量门禁绿：root build ✓、1110 tests ✓、包内 279 tests（新增 28）✓、tsc --noEmit ✓、i18n-audit ✓；trading-web profile 已刷新，真实实例截图验证权益条三块渲染、-800/+2000/-3000 等撮合数值与方向色（红涨绿跌）逐项核对无误。
- 已知边界：导入/实盘暂无已实现口径（UI 有披露）；paper 回合 market 依赖新流水。
