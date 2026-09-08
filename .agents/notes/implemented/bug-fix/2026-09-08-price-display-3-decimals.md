# Agent Note: 标的价格显示自适应保留第 3 位小数——≥1 价位不再截断港股 0.001 tick

Status: implemented

## Problem

全局标的价格显示固定按「量级取小数位」，≥1 的价位一律只展示 2 位小数
（`client-ui-trading` format.ts `priceDigits`：abs≥1000→2、abs≥1→2）。港股
tick 为 0.001（连接器侧 ×1000 分精度还原），107.125 这类 3 位小数价格在行情
头、盘口、持仓、自选列表、图表价格轴等所有显示位被截成 107.13——丢精度且
与真实成交价对不上。同一问题还散落在绕过 `fmtPrice` 的内联 `toFixed(2)`：
K 线信号 marker 文案、基本面 52 周区间/目标价、选股命中表现价列、回测成交
表开平价、策略范式 reason 文案。

## Decision

- **规则单一来源**：`@dshtrading/strategies` 新增 `src/price-format.ts`
  （`priceDigits` + `fmtPrice`），经包 barrel 导出。规则 = ≥1 默认 2 位，
  当 2 位舍入会丢失第 3 位有效小数（`|toFixed(2) 舍入差| ≥ 1e-9`）时升 3
  位；<1 维持原量级 4/6 位。1e-9 容差只滤浮点表示噪声（常规价位下比第 3
  位小数低多个数量级），107.125→3 位、346.59→2 位、107→2 位。
- **依赖方向落点**：client-ui 依赖链为 client-ui-trading → client-ui-strategies
  → strategies，strategies 是唯一三包共同祖先，故规则放它；client-ui-trading
  `format.ts` import 后再导出（维持 `./format.ts` 既有 import 面；注意纯
  `export from` 转发不绑定本地作用域，`fmtChange` 内部引用会 ReferenceError，
  必须 `import` + `export`）。
- **消费面切换**：`fmtPrice`/`fmtChange` 的全部既有消费方（行情头、盘口、
  成交、持仓、自选、衍生品、发给 Agent 文案、TvChart 价格轴 precision/minMove）
  零改动自动跟随；内联点切换为 `fmtPrice`：QuoteStage marker 信号文案、
  FundamentalsStage 52 周高低/目标价、ScreenerPane 命中表现价列、
  StrategyView 回测开平价列、5 个范式策略 reason/reasonParams 的价格类槽位
  （百分比/倍数槽位维持原精度不动；EPS/PE 等会计与比率指标维持 2 位）。
- **范式 compute 自包含约束**：`compute.toString()` 导出经
  `compileStrategySource` 只注入 `bars`/`params` 两个形参，compute 体内不可
  引用模块级导入，故 5 个范式在 compute 内部内联同式 `fmtPrice` 小助手
  （与既有 `smaOf`/`emaOf` 内联重复同一模式），与 price-format.ts 改动须同步。

## Alternatives considered

- **≥1 一律固定 3 位**：A 股/美股 tick 为 0.01，所有价格被迫显示 107.130
  式尾零噪声，全 UI 可读性下降，放弃。
- **Quote/Instrument 契约加 pricePrecision/tickSize 从连接器贯通**
  （packages/api 现无精度字段，OKX tickSz 也未透出）：语义上最正确，但要动
  公共契约 + 全部连接器，属较大功能开发；本次是显示层缺陷修复，量级自适应
  已覆盖实际精度需求，按标的精度贯通留作后续独立提案。
- **规则留在 client-ui-trading、client-ui-strategies 本地复制一份**：两份
  实现必然漂移，且 strategies 范式 reason 仍无规则可用，放弃。
- **不动 strategies 包（只修 UI）**：策略面板信号文案/成交表的 3 位小数
  截断依旧，「全局」要求不成立，放弃。

## Consequences

- 港股等 3 位小数标的在全部显示位保真；2 位 tick 市场显示与原状完全一致
  （第 3 位非零才升位），无视觉回归面。
- 新增规则若有演进（如按标的 tickSize 贯通），单一来源 + 范式内联副本两处
  需同步——已写入 price-format.ts 头注。
- 金额类（盈亏/市值/手续费）、百分比、成交量、指标读数、EPS/PE 维持原精度，
  刻意不在本修复范围。
- 验证：strategies 119 例（含新增 price-format 3 例）、client-ui-trading
  315 例（format.test.ts 增 3 位小数用例，fmtChange(1.234) 期望随新规则更新
  为 +1.234）、client-ui-strategies 17 例全绿；`pnpm build` / `pnpm test`
  全仓门禁通过。
