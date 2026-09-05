# Agent Note: 资产抽屉侧栏化——TradeDrawer 移除，HoldingsPanel 右缘竖栏 + 添加资产主按钮

Status: implemented

## Problem

统一资产台账（issue #65）落地后，资产抽屉以底部全宽横条形态挂在行情面板副图区域：
折叠态占 28px 状态栏、展开态压掉 200px 图表高度，且表格 10 列横向拥挤。截图解析
确认流（staged 横幅）出现在视口底部，与图表联动观察持仓的动线割裂；「手动新增」
按钮藏在抽屉动作区，入口不显性。需要把资产面改为右侧竖栏面板，重构紧凑展示，
并让「添加资产」成为常驻主按钮。

## Decision

- **挂载迁移**：删除 `TradeDrawer.tsx` + `trade-drawer.module.css`；新增
  `HoldingsPanel.tsx` + `holdings-panel.module.css`，挂 QuoteStage chartRow
  右缘独立一列（300px，与盘口/交易台 `.rightSidebar` 并排、位于其右）。
  仍仅图表页签展示（与原抽屉一致）。`HoldingsActions` 类型改从
  `HoldingsPanel.tsx` 导出，QuoteStage 数据管道（三源组装、30s 盯市轮询、
  FX 拉取、SSE 失效信号、台账写动作）全部不动，仅门控状态改名
  `tradeDrawerOpen` → `holdingsOpen`。
- **开关入口**：图表工具栏新增「资产」toggle 按钮（aria-pressed 模式，同盘口/
  交易台）；状态持久化 `dshtrading.holdingsPanel.open`，**默认开**——原抽屉
  折叠条常驻可见，侧栏化后无默认入口会丢失资产可见性；下单成功后自动
  `setHoldingsOpen(true)`（原自动展开底栏语义平移）。面板头部 × 关闭。
- **展示重构**（300px 宽度约束）：宽表格改紧凑卡片/行列表——持仓为三行卡片
  （来源徽章+symbol+方向 / 账户+数量+开仓价 / 市值+盈亏+编辑删除）；汇总为
  总资产卡（基准币选择 + 大数字 + 分来源/分币种小计）+ 可展开聚合行；
  委托/成交/余额为紧凑行列表。tab 条用短标签键 `trade.tab.*`（持仓/汇总/
  委托/成交/余额）。staged 横幅移到 tab 条下方。对话框（新增/编辑/staged
  确认）为全屏遮罩层，不受面板宽度约束，逻辑原样迁移。
- **「+ 添加资产」主按钮**：面板头部常驻（`holdingsActions` 在位时渲染），
  打开原「手动新增」对话框；「导入持仓」「重置模拟金」收敛到持仓 tab 的
  动作行。`trade.holdings.add` 文案改「添加资产 / Add Asset」。
- **文案同步**（跨包）：`packages/holdings` 的 `holdings_stage` 工具 description
  与回包文案、`trade.holdings.import.guide` 中「资产抽屉」→「资产面板」
  （agent 会照文案引导用户，指向已不存在的界面即误导）；删除孤儿键
  `trade.drawer.collapse/expand`；`data-dshtrading-trade-drawer` →
  `data-dshtrading-holdings-panel`。docs/design/holdings-ledger.md §6.3 加
  修订注记。

## Alternatives considered

- **面板塞进现有 `.rightSidebar`（与盘口同列纵向堆叠）**：240px 列宽对持仓
  卡片过窄且纵向滚动动线差（盘口 + 资产合计高度超出视口）；独立 300px 列
  保持盘口列不动，两面板互不挤压。
- **保留 TradeDrawer 组件仅改挂载点**：底部横向表格形态在 300px 竖栏不可用
  （10 列表格需横向滚动），展示必须重写；保留双形态（底部抽屉 + 侧栏）双入口
  则维护两套展示、状态同步复杂，放弃。
- **默认关面板**：与盘口默认开一致地「少打扰」，但资产面是用户高频观察面
  （原抽屉折叠条即常驻），默认关会回归「看不见持仓」的原始问题。
- **汇总条常驻面板头部（不限于汇总 tab）**：信息价值高但挤压 300px 高度
  预算；维持 tab 语义，总资产在汇总 tab 首屏。

## Consequences

- 资产观察与图表纵向并列，staged 确认动线不再压缩图表高度；「添加资产」
  一键可达。非图表页签（基本面/新闻/公告）暂无资产入口——与原抽屉行为
  一致，后续如需可把面板挂载提升到 stage 级。
- 删除约 910 行 TradeDrawer 实现，展示层单一来源；`trade.drawer.*` 键族
  只剩 balances 行标签仍在用。
- 老用户 localStorage 无 `dshtrading.holdingsPanel.open` 记录 → 首次升级
  默认展开面板；关闭过一次即记忆。

## Verification & Gates

- `pnpm build` + `pnpm test` 全仓全绿（1058 passed，含 quote-stage 渲染冒烟
  与 holdings tool 文案断言更新）。
- trading-web profile 重建刷新 + 宿主 HTTP + 无头 Chrome 截图实测：面板右缘
  展示、添加资产按钮、tab 切换（见同日 process note 的验证手法）。
