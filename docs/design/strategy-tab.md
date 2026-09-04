# 中栏「策略」板块设计（Strategy Tab）

> 状态：设计定稿（待实现） · 2026-08-31
> 决策：项目所有者（Mode 2） · 起草：agent 评审
> 关联：[docs/design/knowledge-graph.md](knowledge-graph.md)（第三 Tab）、[docs/skills-guide.md](../skills-guide.md)（Skill SSOT）、[docs/crypto-slice-plan.md](../archive/crypto-slice-plan.md)（旧回测 non-goal 的反转说明）

## 1. 背景与决策

1. 中栏第二 Tab 原名「量化」（`WorkflowView` 占位，2026-08-30 视图注册表机制验证）。项目所有者 2026-08-31 定稿：
   - **「量化」更名「策略」**——「量化」是工程语义，「策略」才是交易用户的心智词汇；
   - 板块内容 = **常用交易策略的参考范式**：短线、中线波段、长线投资三类，给用户可读、可跑、可改的实现参考；
   - 中栏 Tab 三分法定稿：**行情 | 策略 | 知识库**。
2. 决策反转记录：`docs/archive/crypto-slice-plan.md`（2026-08-29）曾把「回测引擎」列为 non-goal——那是单交易所切片期的范围控制，不是永久否定。本设计将回测收敛为**纯函数、浏览器端、单标的本地回测**，服务参考范式的教学与验证；**实盘自动化仍然不在范围内**（铁律 #3 不变，策略层永不直接触发 `place_order`）。旧文档已加指向注。

## 2. 目标与非目标

**目标（In scope）**

- 中栏视图注册表更新：`quote | strategy`（`workflow` 占位完成使命后移除；`knowledge` 由知识库任务追加）；
- 新包 `packages/strategies`：策略契约类型 + 纯函数回测引擎 + 6 个参考范式策略（纯库、零运行时依赖、浏览器可打包，形态对齐 `packages/indicators`）；
- `StrategyView` UI：策略目录 → 参数面板 → 回测结果（指标卡 + 权益曲线 + 交易明细）；
- 策略知识 Skill 化：`.agents/skills/trading-strategy-paradigms/`（五段论 SOP，经 `scripts/sync-skills.mjs` 分发至 4 个 kit）。

**非目标（Out of scope）**

- 实盘自动下单循环 / 策略托管执行（策略输出仅为信号与回测；任何下单仍走连接器 dry-run 闸门 + base 统一审批）；
- 参数优化器、机器学习、walk-forward 分析；
- 多标的组合回测、现金流（定投）语义（留 v2）；
- 服务端/长历史回测（v1 全部在浏览器端完成，数据经既有 bridge）。

## 3. 架构

### 3.1 包布局 `packages/strategies`

```
packages/strategies/src/
├── index.ts        # 公共导出（types + engine + paradigms）
├── types.ts        # 契约（StrategyDefinition / StrategySignal / ParamSpec）
├── engine.ts       # run()：纯函数回测引擎（确定性，可单测）
└── paradigms/
    ├── donchian-breakout.ts    # 短线
    ├── rsi-reversion.ts        # 短线
    ├── ema-crossover.ts        # 波段
    ├── bollinger-reversion.ts  # 波段
    ├── sma-baseline.ts         # 长线
    └── momentum-12m.ts         # 长线
```

契约草案（实现时可微调字段名，语义不得偏移）：

```ts
import type { Kline } from '@dshtrading/indicators'

export type StrategyHorizon = 'short' | 'swing' | 'long'
export type SignalAction = 'entry' | 'exit'

export interface StrategySignal {
  /** bars 下标：信号在 bars[i] 收盘确认，engine 按 bars[i+1].open 成交 */
  readonly index: number
  readonly time: number
  readonly action: SignalAction
  /** v1 只有 long/flat 两态（不做做空）；预留词汇避免后续破坏性变更 */
  readonly direction: 'long' | 'flat'
  readonly price: number      // 确认时收盘价（展示用；成交价由 engine 决定）
  readonly reason: string     // 人话解释，UI 直接展示（如 'EMA20 上穿 EMA60'）
}

export interface StrategyParamSpec {
  key: string; label: string; default: number; min: number; max: number; step: number
}

export interface StrategyDefinition {
  readonly id: string            // 稳定词汇，如 'donchian-breakout'
  readonly horizon: StrategyHorizon
  readonly name: string
  readonly summary: string       // 一句话思路
  readonly params: readonly StrategyParamSpec[]
  /** 纯函数：无 IO/随机/全局态；同一输入必须同一输出（回测确定性） */
  compute(bars: Kline[], params: Record<string, number>): StrategySignal[]
}
```

复用声明：`Kline` 类型与 `sma/ema/rsi/bollinger/stdev` 数学函数一律从 `@dshtrading/indicators` 导入，**禁止复制实现**。

### 3.2 回测引擎（`engine.ts`）成交假设（写死成文，保证可复现）

- 信号在 `bars[i]` 收盘确认，按 `bars[i+1].open` ±滑点成交；`i` 为最后一根时信号不成交；
  （该假设天然契合 A 股 T+1：今日收盘信号次日开盘执行）
- entry 全仓买入（现金约束），exit 全部卖出；不加仓、不杠杆、不做空；
- 已持仓时忽略重复 entry；无持仓时忽略 exit；
- 手续费单边费率（默认 1e-3），买卖各收一次；滑点默认 0；
- 输出：`BacktestResult { signals, trades, equity, metrics }`；
  `Metrics { totalReturn, cagr, maxDrawdown, sharpe, winRate, profitFactor, tradeCount, exposure }`（年化按 bars 周期换算）。

### 3.3 数据流（零新增 node 面）

`fetchKlines()`（既有 `/dshtrading/api/klines` bridge 端点，client-api 已封装）→ `engine.run()` 纯浏览器计算 → 渲染。不新增 node 端点、不引入新服务。

### 3.4 UI（`StrategyView.tsx`，替换 `WorkflowView.tsx`）

- `MiddleStage.tsx`：`MIDDLE_VIEWS` 变为 `[quote, strategy]`，`MiddleViewId = 'quote' | 'strategy'`；删除 `WorkflowView.tsx` 与 `stage.workflow` 等 locale 键；
- 结构（自上而下）：周期分段控件（短线 | 波段 | 长线）→ 策略卡列表（选中态高亮）→ 参数行（按 `params` spec 渲染数字输入）+ 标的/周期选择（默认继承行情视图当前 selection，日线）+ 「运行回测」→ 结果区：8 指标卡行 + 权益曲线（lightweight-charts AreaSeries，红涨绿跌 token 沿用 `tokens.css`）+ 交易明细表（时间/方向/价格/盈亏%）；
- 状态持久化：`dshtrading.strategy.v1`（选中策略 id + 参数），模式对齐 `dshtrading.stage.v1`；
- i18n：新增 `stage.strategy`（'策略'）与 `strategy.*` 一族，删除 `workflow.*`；
- 空态：未运行时给引导文案（选择策略 → 运行回测）。

### 3.5 Skill 层

`.agents/skills/trading-strategy-paradigms/SKILL.md`（SSOT，五段论）：教 agent 讲解范式、跑回测、解读绩效与反方情景；明确「回测 ≠ 未来收益、不构成投资建议、实盘仍走闸门」。经 `scripts/sync-skills.mjs` 同步至 4 个 kit assets。

## 4. 六个参考范式详表（实现指示）

| id | 类别 | 思路 | 入场（收盘确认） | 出场（收盘确认） | 参数 | 适用边界 / 风险 |
|---|---|---|---|---|---|---|
| `donchian-breakout` | 短线 | 唐奇安通道突破（海龟简化版） | 收盘价突破前 N1 根最高价 | 收盘价跌破前 N2 根最低价（N2 < N1） | N1=20, N2=10 | 趋势市有效，震荡市连续假突破；单边市注意追高 |
| `rsi-reversion` | 短线 | 短周期 RSI 极值均值回归 | RSI(2) < 10 | RSI(2) > 60 | rsiPeriod=2, enter=10, exit=60 | 强趋势中越跌越买风险大；仅作短线超卖反弹参考 |
| `ema-crossover` | 波段 | 双均线趋势跟踪 | EMA20 上穿 EMA60 | EMA20 下穿 EMA60 | fast=20, slow=60 | 震荡市来回止损；滞后于拐点 |
| `bollinger-reversion` | 波段 | 布林带下轨均值回归 | 收盘 < 下轨且未持仓 | 收盘回到中轨 | period=20, k=2 | 单边下跌中接飞刀；须配合仓位控制 |
| `sma-baseline` | 长线 | 200 日均线择时基线（Faber 式） | 收盘 > SMA200 且空仓 | 收盘 < SMA200 | period=200 | 震荡市频繁小额进出；牛市跑赢持有、熊市大幅避险 |
| `momentum-12m` | 长线 | 12 月动量择时（Fama-French 12-1 单标的简化） | 近 12 个月收益 > 0 且收盘 > 12 月均线 | 动量转负或跌破均线 | lookbackMonths=12 | 月度级信号换手低；对慢趋势钝化 |

实现要求：每个范式一个文件 + 一个正例测试（合成 bars 断言 trades 精确值）+ 一个不触发边界测试；`reason` 必须是可直接展示的中文短句。

## 5. 验收清单

- [ ] `pnpm -r build`（新增 1 包）与 `pnpm -r test` 全绿；engine 有确定性单测（固定合成 bars → 精确断言 metrics）
- [ ] 中栏显示「行情 | 策略」两 Tab；旧 `workflow` 视图与 locale 键清理干净（grep 无残留）
- [ ] 任一策略在任一市场标的（如 BTCUSDT 日线）可运行出结果；指标卡与权益曲线渲染正常；切 Tab 再切回状态保持
- [ ] `trading-strategy-paradigms` skill 经 sync 脚本出现在 4 个 kit assets；`pnpm sync:skills` 幂等
- [ ] Agent Note（feature）随 PR 提交；遵守 Conventional Commits；**不得在 CHANGES_REQUESTED 状态下自行合并**

## 6. 参考

- `packages/indicators`：包形态 / math 函数 / Kline 类型的复用来源；`client-ui-trading` 中 `TvChart.tsx`（vanilla 库 + React 外壳先例）、`api.ts`（`fetchKlines`）、`MiddleStage.tsx`（视图注册表）
- `docs/archive/crypto-slice-plan.md`：旧 non-goal 原文与本设计的反转关系
- 五条铁律见 `README.md`；本设计不触碰铁律 #3（无下单路径）与铁律 #2（策略 SOP 全部进 skill）
