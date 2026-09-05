# Agent Note: 资产抽屉侧栏化——HoldingsPanel 挂会话列容器（定时任务同款切换页签）+ 添加资产主按钮

Status: implemented

## Problem

统一资产台账（issue #65）落地后，资产抽屉以底部全宽横条形态挂在行情面板副图区域：
折叠态占 28px 状态栏、展开态压掉 200px 图表高度，且表格 10 列横向拥挤。截图解析
确认流（staged 横幅）出现在视口底部，与图表联动观察持仓的动线割裂；「手动新增」
按钮藏在抽屉动作区，入口不显性。owner 要求把资产面放进右缘真正的侧栏容器——
与 agent 对话、定时任务同一个（会话列容器），首版误挂 chartRow 自建列已返工。

## Decision

- **容器与入口**：删除 `TradeDrawer.tsx` + `trade-drawer.module.css`；新增
  `HoldingsPanel.tsx` + `holdings-panel.module.css`，由 `SessionRail` 渲染——
  竖条分隔线下第二个功能页签（钱包图标，定时任务 = 1 号）。同款「对话列容器
  切换页签」模式：激活时 shell-pad.css 规则 12 隐去对话列直接子节点，面板
  fixed 原位覆盖（`right: var(--dshtrading-sidebar-w)` +
  `width: var(--dshtrading-chat-user-w)`，吃同一组轨道变量），非并排非悬浮；
  与定时任务互斥（同一条轨道同时只容一个覆盖面，SessionRail effect 联动）。
  开关走 `holdings-store` 的 `holdingsPanelStore`（会话级默认关——面板盖住
  对话列，不宜跨会话记忆）；QuoteStage 下单成功后 `setHoldingsPanelOpen(true)`
  跨树联动。
- **数据管道出 QuoteStage**：面板与 QuoteStage 不再同树，台账快照/盯市价格/
  FX/基准币/写动作抽成无 React 依赖的 `holdings-store.ts` 单例（observable
  快照 + fetch 动作，SSE 'holdings' 失效信号重拉）；轮询由面板组件驱动——
  挂载即拉、卸载即停（30s 盯市 + live 刷新节奏不变）。交易模式同步抽
  `trade-mode-store.ts`（OrderPanel 切换与面板 paper 徽章/数据源跨树共享）。
- **委托/成交/余额改跨市场聚合**：原抽屉按激活市场取数；侧栏面板是全局面，
  live 模式改四市场逐个拉取（失败静默跳过、行打市场标签、30s 且仅对应 tab
  激活时拉，全市场 no-trade-service → 切 provider 提示）；paper 模式仍读本地
  模拟账本。头部新增交易模式 ghost 切换钮（paper 琥珀/live 绿）。
- **「+ 添加资产」主按钮**：面板头部常驻（台账桥在位时渲染），打开手动新增
  对话框；「导入持仓」「重置模拟金」在持仓 tab 动作行。
  `trade.holdings.add` 文案改「添加资产 / Add Asset」。
- **展示重构**（会话列宽度约束）：宽表格改紧凑卡片/行列表——持仓三行卡片、
  汇总总资产卡 + 可展开聚合行、委托/成交/余额紧凑行；tab 条短标签键
  `trade.tab.*`；staged 横幅在 tab 条下方；对话框为全屏遮罩层不受面板约束。
- **文案同步**（跨包）：`holdings_stage` 工具与 `trade.holdings.import.guide`
  「资产抽屉」→「资产面板」；删除孤儿键 `trade.drawer.collapse/expand`；
  `data-dshtrading-trade-drawer` → `data-dshtrading-holdings-panel`；
  docs/design/holdings-ledger.md §6.3 加修订注记。

## Alternatives considered

- **首版：QuoteStage chartRow 自建 300px 列（已实施后返工）**：面板悬在行情
  区与对话列的交界，视觉上像浮窗而非侧栏——owner 明确否定；改挂真正的会话列
  容器。
- **继续留在 QuoteStage 树、props 跨树透传**：SessionRail 与 QuotePane 是两个
  slot 注入面，无父子关系；透传要经过宿主 slot 契约，比单例 store 复杂且
  轮询生命周期难随面板挂载收敛——落选。
- **保留底部抽屉 + 侧栏双入口**：两套展示、状态同步复杂；资产面单一来源。
- **面板默认展开**：会盖住对话列（与 chartRow 时代「默认开」的依据不同），
  对以对话为主的使用场景是干扰——改会话级默认关，下单联动自动开。
- **汇总条常驻面板头部**：挤压高度预算；总资产留在汇总 tab 首屏。

## Consequences

- 资产面成为会话列容器三页签之一（对话 | 定时任务 | 资产），动线与宿主
  官方面板一致；staged 确认不再挤压图表。「添加资产」一键可达。
- 台账数据层与视图解耦（holdings-store），后续任何树（如左栏）都可消费；
  QuoteStage 减约 200 行管道代码。
- 委托/成交/余额 live 轮询从「激活市场 15s」变「四市场 30s 且 tab 激活才拉」，
  请求量级相当（4 请求/30s vs 2 请求/15s），配额纪律可接受。
- 面板仅在会话列轨道内可见：会话列被折叠（规则 9 display:none）时页签入口
  仍在竖条上，面板 fixed 定位不受折叠影响（`--dshtrading-sidebar-w` 轨道仍在）。

## Verification & Gates

- `npx tsc --noEmit` + `pnpm build` + `pnpm test` 全仓全绿（1058 passed，
  含 quote-stage 渲染冒烟与 holdings tool 文案断言更新）。
- trading-web profile 重建刷新 + 宿主 HTTP + 无头 Chrome 截图实测：竖条钱包
  页签打开面板覆盖对话列、持仓/汇总 tab、添加资产对话框、与定时任务互斥。
