# Agent Note: 策略一级分区拆分 — 选股策略 | 量化策略 + 5 个内置选股器

Archived: 2026-09-04
Status: implemented

## Problem

owner 需求（2026-09-03，附截图）：「策略」页一级菜单拆成两块——
**选股策略**（内置智能选股器，帮用户从全市场筛出符合要求的标的）与
**量化策略**（现有回测体系）。现有「短线交易 / 波段操作 / 长线投资」
三个 horizon tab 整体下沉为量化策略下的三级选项。选股能力此前完全没有：
策略页只能对单个已知标的跑回测，没有「从全市场里找标的」的截面筛选入口。

## Decision

1. **选股器契约进 strategies 纯库**（`src/screeners/`，与 paradigms 同风格）：
   `ScreenerDefinition = { id, name, summary, params, columns, evaluate }`。
   与 `StrategyDefinition` 的本质区别：回测是「时序信号 → 引擎撮合」，
   选股是「单时点截面判断」——`evaluate(bars, params): ScreenerMatch | null`
   只回答最后一根 bar 命不命中，无信号序列、无回测语义。id 加 `scr.`
   前缀与范式策略 id 空间隔离。数据不足（新上市标的窗口不够）返回 null：
   既不算命中也不算错误，扫描层静默跳过。
2. **5 个内置选股器**（纯函数，17 个单测覆盖正例/反例/数据不足三线）：
   均线多头排列（20/60/120 三线顺排）、放量突破（N 日新高 + M 倍量能确认，
   量比口径跨市场可比）、RSI 超卖（逆势反转候选池，理由文案明示逆势）、
   接近一年新高（要求完整 250 日窗口，防把「上市不久」误判成「接近新高」）、
   站上牛熊线（现价 > SMA200 且均线斜率向上，与量化页 200 日基线同源）。
3. **扫描调度在视图层**（`ScreenerPane.tsx`）：桥 `fetchSymbols`（30min
   进程内缓存）取名册 → 截断到扫描池上限（默认 300，50..800 可调）→
   受限并发 5 逐标的拉 300 根日 K → 纯函数评估。并发限 5 是刻意保守：
   每标的 1 次日 K 请求，不追求扫描速度、追求不打疼公共数据源。
   runId 自增作取消令牌，扫描中可「停止」，命中行实时进表。
4. **桥面扩展**：`tradingBridge` 服务（client-ui-trading api.ts）补
   `fetchSymbols`——端点 `/dshtrading/api/symbols` 与 `TradingBridge.symbols`
   早已存在（Issue #15 名册），只是没暴露给视图包，纯接口面增量。
5. **UI 两级分区**（StrategyView）：顶部分段控件「选股策略 | 量化策略」，
   持久化进 `dshtrading.strategy.v1` 的 `section` 字段（additive，旧存档
   缺省落 quant，行为无回归）；量化分区内容原样下沉（horizon 三 tab +
   策略卡 + 回测）。选股器独立持久化 `dshtrading.screener.v1`。

## Consequences

- **名册能力决定选股可用性**（诚实降级，零假数据）：Binance/OKX 有
  `listInstruments` 全集 → 可用；eastmoney 的名册实现是搜索式 suggest、
  不带 query 返回空 → CN 市场显示「数据源未提供标的全集」空态；yahoo
  未实现 → US 同样空态。CN/US 全市场筛选（5000+ 标的）在现有逐标的
  getKlines 架构下成本不可接受，v1 不做，需要连接器级排行/筛选端点再议。
- 300 根日 K 窗口支撑最长参数（250 日窗口 + 斜率余量）；参数上限收紧到
  300/500 以内与窗口匹配。
- typecheck 棘轮顺手清 2 个存量债（547 < 549）：strategies 包 6 个新错误
  （严格索引访问）修零；client-ui-strategies 的 TS2353（shell render 传
  `view` prop 但 StrategyViewProps 不收，main 上已漂移超基线）以补
  `view?: string` 收口。
- 未做 UI 实测（worktree 隔离开发，trading-web profile 刷新流程未走）；
  build + 749 测试 + 棘轮全绿。合并前建议按 AGENTS.md 流程重建包并刷新
  profile 后过一遍两个分区的交互。
