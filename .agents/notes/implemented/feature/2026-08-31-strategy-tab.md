# Agent Note: 中栏「策略」板块与纯函数回测内核及参考范式

Status: implemented

## Problem

原中栏第二 Tab 命名为「量化」（`WorkflowView` 占位），在业务语境上偏工程实现而非用户交易心智。同时，用户在进行短线、波段或长线交易构思时，缺乏开箱即用、确定性可复现、纯浏览器端可计算的经典策略参考实现与多维度量化回测评价标准；旧切片中曾将回测列为 non-goal，随着中栏整体升级，需要将回测明确收敛为“纯函数、单标的、本地确定性计算”，服务于教学与策略验证，同时严守铁律 #3（策略层绝不直连实盘下单）。

## Decision

1. **中栏 Tab 更名与注册表收敛**：
   - 将 `MiddleStage` 第二 Tab 从「量化」更名为「策略」（`stage.strategy`），彻底移除 `WorkflowView` 及 `workflow.*` 词条；
   - 视图注册表形态定为 `[quote, strategy]`，采用互斥挂载策略（切走即卸载，后台零渲染开销）。

2. **新建纯库包 `@dsh-trading/strategies`**：
   - 零运行时依赖、浏览器与 Node 端同构执行；
   - 复用 `@dsh-trading/indicators` 的数学函数（SMA, EMA, RSI, Bollinger, Stdev 等）与 `Kline` 类型，禁止重复实现；
   - 内置纯函数回测执行器 `run()`：采用严格成交假设（$bars[i]$ 信号在 $bars[i+1].open \pm \text{slippage}$ 成交，扣除单边手续费），输出 8 项立体绩效指标（累计收益率、CAGR、最大回撤、夏普比率、胜率、盈亏比、交易笔数、市场暴露度）；
   - 内置三类共 6 个经典参考范式：
     - 短线：`donchian-breakout`（唐奇安通道突破）、`rsi-reversion`（RSI(2) 极值均值回归）；
     - 波段：`ema-crossover`（EMA20/EMA60 双均线金叉死叉）、`bollinger-reversion`（布林带下轨均值回归）；
     - 长线：`sma-baseline`（SMA200 牛熊择时基线）、`momentum-12m`（12 个月动量择时）。

3. **`StrategyView` UI 交互与视觉规范**：
   - 周期分段（短线 / 波段 / 长线）+ 策略卡高亮选择 + 参数动态调节 + 标的周期继承（拉取 500 根日 K，确保 250 根长线策略有充足样本窗口）；
   - 严格对齐 Futu 牛牛设计规范：全面使用 `--dsw-futu-*` Design Tokens（`--dsw-futu-bg-*` / `--dsw-futu-border-*` / `--dsw-futu-text-*` / `--dsw-futu-up/down`），无未定义变量与硬编码内联样式；
   - 空态使用 `IconStrategy` 矢量 SVG 图标；
   - 8 核心指标卡（Tabular-nums 排版、红涨绿跌 Token）+ Lightweight-charts AreaSeries 权益曲线 + 逐笔交易流水明细表；
   - 状态持久化至 `dshtrading.strategy.v1`；
   - 完备的 i18n 字典覆盖（中文与英文 locale 全覆盖，零 `as never` cast 与无掩盖性 `||` 回退）。

4. **SOP 技能体系与通用单源分发**：
   - 编写 `.agents/skills/trading-strategy-paradigms/SKILL.md`（五段论 SOP、反方情景、免责提示与铁律红线）；
   - 实现通用目录扫描与前缀路由分发的 `scripts/sync-skills.mjs`，`trading-*` 与 `indicator-*` 同步至全部 4 个 market kit（`crypto/us/cn/hk`），市场前缀同步至单 kit，其他同步至 base；在 root 提供 `pnpm sync:skills` 幂等分发。

## Alternatives considered

- **服务端复杂回测引擎（如引入 Python backtrader / zipline）**：
  - *落败原因*：引入庞大的后端依赖、跨语言通信与部署门槛；当前阶段单标的历史数据可直接经现有 HTTP 行情桥由浏览器纯函数即时计算，毫秒级响应，架构极简且安全。
- **策略自动下单循环 / 托管实盘**：
  - *落败原因*：严重违反铁律 #3（所有下单必须有显式开关与 Base 统一审批闸门）。策略层定位于决策辅助与历史验证，严禁直接触发订单。

## Consequences

- 交易用户在中栏获得完整的「行情 + 策略」两重视角；
- 策略引擎经过 12 个确定性与边界用例全面验证，全仓构建 20 个 package 与 431+ 个单测 100% 绿灯；
- 建立标准的 `pnpm sync:skills` 前缀路由分发机制，跨市场通用技能与单市场专用技能单源维护。
