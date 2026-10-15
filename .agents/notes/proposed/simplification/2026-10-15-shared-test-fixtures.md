# Agent Note: 跨包重复的测试夹具与契约用例样本

Status: proposed

## Problem

测试面有三处「同一份事实在多个包各写一遍」，都由「本仓不存在共享测试包」这一约束顶着：

- **假服务与假响应桩 15 处 / 5 个包**。`MarketDataService` 假服务 10 份
  （`bot-api/test/` 六份、`strategies/test/` 三份、`router/test/tools.test.ts` 一份），
  其中 `bridge.test.ts`、`bridge-southbound-holdings.test.ts`、`bridge-kline-cross-source.test.ts`
  三份是同一签名 `fakeService(overrides: Partial<MarketDataService> = {})` 的重写。
  HTTP 响应桩 5 份且**同名不同形**：`bot-api/test/sse.test.ts` 的 `fakeRes()` 基于
  `EventEmitter + vi.fn`，而 `client-ui-bot-gui/test/route-handler.test.ts` 与
  `client-ui-special-indicators/test/route-handler.test.ts` 的 `fakeRes()` 只有
  `writeHead` / `end`。实测全仓 `from '@dshtrading/*test` 命中为 **0**——目前没有任何跨包测试依赖。
- **合法策略源码样本 `VALID_SOURCE` 6 份 / 2 个包**：`strategies/test/` 四份
  （`plugin.test.ts`、`plugin-management.test.ts`、`plugin-list.test.ts`、`validate.test.ts`）加
  `bot-api/test/bridge-strategy-management.test.ts` 一份，另有 `screener-management.test.ts` 里
  一个同名但内容不同（动量选股器）的变体。它是 strategies 沙箱契约的「合法源码」样本，
  契约每变一次要在两个包六处同步核对。
- **词典契约用例三份**：`client-ui-bot-gui/test/locale-contract.test.ts`（33 行）、
  `client-ui-special-indicators/test/locale-contract.test.ts`（36 行，与前者近乎逐字）、
  `client-ui-strategies/test/locale-contract.test.ts`（109 行，扩写变体），合计 178 行。
  `scripts/i18n-audit.mjs` 只管 `dsh-i18n` 中心包，这三个包的词典靠各自的用例钉住；
  special-indicators 那份的文件头写明了理由（「私有包不进 i18n-audit 中心包门禁——
  那会给已发布 dsh-i18n 引入对私有包的 workspace 依赖」）。

## Proposal

新增一个私有（`"private": true`、不入发布闭包）的测试支持包，例如
`packages/test-support/`，承载三样东西：

1. `fakeMarketService(overrides)` 与 `fakeHttpRes(shape)` 两个工厂；
   `shape` 显式区分「事件流响应」与「只写 head/end 的响应」两种形态，避免同名不同形。
2. `VALID_STRATEGY_SOURCE` 常量（合法策略源码样本），以及**有意分叉**的那份
   `VALID_SCREENER_SOURCE`，两者都带注释说明差异是刻意断言。
3. `expectLocaleKeyParity(zh, en)` 断言函数，三个 client-ui 包各自保留一个三行的用例文件调用它。

各包现有的用例**只改 import，不改断言**。

## Context & Efficiency Impact

- 可省约 150–250 行夹具 + 约 54 行样本 + 约 70 行重复用例。
- 真实收益在「契约变一次要核对几处」：`MarketDataService` 从 10 处变 1 处，
  合法源码样本从 6 处变 1 处（刻意的变体除外）。
- 成本：新增一个私有包（`packages/test-support/`），它不进 `pnpm -r build` 的产物面吗——
  需要显式确认；若被 `coverage-gate` / `typecheck` 的门禁枚举收进去，则要同批登记基线。

## Alternatives considered

- **保持每包自带最小桩**：这是当前的默认，理由是「每包可独立演进、不新增依赖」。
  但 15 份里已经有 3 份是同签名的重写，说明这条自由在实践中并没有被用到；
  真正的分叉只有 HTTP 桩那两种形状，而它恰恰是**应该显式区分**而不是散落成同名不同形的。
- **跨包直接 `import` 别包的 `test/` 目录**：否决。那会把包变成测试期的 workspace 依赖，
  并波及覆盖率收集口径（一个包的测试开始拉另一个包的源码）。
- **把夹具塞进 `@dshtrading/api`**：否决。`@dshtrading/api` 是纯契约包（明文「本包不做运行时」），
  且带运行时代码的假件不是契约。
- **三处只做其中一处**：可行，按收益排序应为 词典契约用例（178 行、两个包近乎逐字）
  → `VALID_SOURCE`（跨包、契约同步成本最高）→ 假服务（面最大但要处理两种 HTTP 形状）。
  若不愿新增包，至少先把 `VALID_SOURCE` 抽到 `strategies` 已有的测试支持位置，由 `bot-api` 跨包引用。

## Verification & Gates

- 每个被改的包跑 `pnpm --filter @dshtrading/<pkg> test`，断言一条不改即为通过。
- `pnpm test:audit`（测试卫生棘轮）不得因新增测试支持包而判红：新包的用例必须满足
  BDD 命名与 Given/When/Then 结构。
- `pnpm coverage:check`：新包若被覆盖率门禁枚举，需同批登记基线。
- 收口：`pnpm gates:all`（含 `pnpm -r test` 与覆盖率）。

## Risks

- 新增包会改变 `pnpm -r build` / `-r test` 的拓扑与覆盖率分母，可能触发棘轮；
  若 `test-support` 没有 `build` 脚本，需确认 `gates-all` 的枚举不会把它当缺产物。
- `VALID_SOURCE` 的「有意分叉」若被合并成一份，会把 `plugin-list.test.ts` 那条
  「列表渲染用不同 reason 文案」的断言悄悄改成与其它处相同——合并时必须保留那份差异。
- 夹具共享会让一个工厂同时承担多个包的形状需求；`shape` 参数必须显式，
  不能退回成 `Partial<T>` + 默认值的隐式形态。
