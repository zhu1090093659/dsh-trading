# Agent Note: 策略 Agent 产出管线——strategy_author + strategy_backtest + 自定义策略 store（issue #31 / P2）

Status: implemented

## Problem

`@dsh-trading/strategies` 已有纯函数回测引擎 `run()` 与 6 大范式策略，但唯一消费方是 GUI 的 StrategyView——右侧对话 Agent 完全不可达（能力已存在但 Agent 不可达，设计文档 §4.3 的定式缺口）。按「稳定工具面 + 活注册表」补整条管线（owner 2026-08-31 裁决 D4：strategy_backtest host 平面注册，全会话可见）。

## Decision

1. **`@dsh-trading/strategies/plugin` 子路径插件**（dataplane 行同款 subpath 先例）：base patch insert 行 `id dsh-trading-strategies` + base deps；host 平面注册 `strategy_author` / `strategy_backtest` 两工具（全会话可见，standard 会话也可用）。策略层永不触发 place_order（铁律 #3 不变）。
2. **CustomStrategyRecord**：`{ id, title, horizon, summary, paramsJson, computeSource, createdAt }`——paramsJson 用 JSON 字符串承载 StrategyParamSpec[]（store 形状扁平可序列化，tool 参数名与 record 字段同名，沿用 knowledge_ingest 的 Json 后缀惯例）；computeSource 契约与 StrategyDefinition.compute 一致。file store 落 `~/.dsh/strategies/custom.json`（tmp+rename 原子写，indicators/custom-fs 同款）。
3. **信号序列专用校验器**（不复用指标的等长断言——信号序列语义不同）：index 整数落在 bar 范围内且**严格单调**、time === bars[index].openTime、action/direction 合法且配对（entry→long、exit→flat）、price === bars[index].close（浮点容差，i 收盘确认）、reason 非空；**可复算**：从 flat 起步 entry/exit 严格交替（与引擎「i 收盘确认、i+1 开盘成交」语义逐位对齐）。多场景样例试算（复用 indicators 的特征 K 线）。
4. **超时护栏**：Node 侧 vm 沙箱 + 100ms 熔断（validate-node.ts，indicators 同款）；**浏览器端 new Function 裸执行缺口一并补**——新增 `workerComputeRunner`（blob URL Worker 内编译执行，主线程超时 terminate）作为 strategies 默认校验 runner；指标侧新增 `validateCustomIndicatorAsync`（结构与语法校验与同步版同源，试算走可等待 runner），client 自定义指标加载已切换至该入口。
5. **桥端点**：`GET/DELETE /dshtrading/api/strategies/custom`（复用既有认证栅栏，只增不改铁律 #6）；DELETE 成功后 emit tradingEvents('strategies')（issue #30 通道复用），strategy_author 落盘同样 emit。
6. **StrategyView 名册**：静态 strategyParadigms → 「范式 ∪ 自定义合并」（自定义记录经 validateCustomStrategy 校验后并入，compute 编译落定）；SSE 驱动刷新。
7. **测试**：strategies 新增 41 例（信号序列矩阵 9 + 校验器 6 + file store 4 + 插件工具链 9 + 原范式回归）；桥新增 3 例；全量 589 通过、build 全绿。

## Alternatives considered

- **params 存结构化数组而非 paramsJson 字符串**：file store 本就直接 JSON 序列化，嵌套数组也可行；但工具参数面（schema 仅 string/number/boolean/integer 词汇）必须收 JSON 字符串，record 与工具参数同名同形（paramsJson）省一层转换——采纳字符串。
- **strategy_backtest 只收自定义策略**：拒绝——范式 id 直通回测让「先比比范式再写变体」的对话流成立，实现只是 store 未命中时回退 getStrategyById，一行成本。
- **浏览器超时护栏用 Worker 文件（vite worker import）**：client 构建经 tsdown.client.config，独立 worker 文件的产物接线复杂；blob URL Worker 自包含零接线，且库包（非应用）拿不到构建器约定——采纳 blob。
- **把 worker runner 放 strategies 内部**：指标侧要「一并受益」必须共享；strategies 本就依赖 indicators，runner 放 indicators/validate.ts 单点实现两包共用——采纳。
- **回测执行（StrategyView 的 run()）也走 Worker**：校验期已熔断 + 策略纯函数受 bars.length 约束，执行期残余风险低；改造成本涉及渲染流重构——本轮不做，如实记录残余风险。

## Consequences

- 对话链路成立：「写一个双均线止损止盈策略，回测 BTC 日线」→ strategy_author（校验+落盘）→ strategy_backtest（8 指标 + 交易流水 + 净值曲线 JSON）；中栏策略 tab 名册经 SSE 实时出现新策略（无需刷新）。
- host 平面工具面 +2（strategy_author / strategy_backtest，schema 一次成型后冻结）；standard 会话可调（D4）。
- 自定义策略与范式共用同一 run() 引擎，GUI 与对话回测结果确定性一致（同一纯函数）。
- 残余风险（如实记录）：已过校验的策略在真实 K 线上执行仍可能较慢（无执行期熔断，见备选 5）；恶意源码在 Node 侧被 vm 熔断拦截、浏览器侧被 Worker 熔断拦截于校验期。
- UI 实机验收与 P1 同受「宿主开发 checkout 迁移」环境阻塞（见 2026-09-01-sse-invalidation-signal.md 记录），工具链已由离线测试全覆盖。
- 验证：pnpm build 全绿；pnpm test 589 通过（新增 44：strategies 41 + 桥 3）；base patch yml 静态结构有效。
