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

## 已落地（2026-10-15）

第 1、2 项已交付；第 3 项（假服务与 HTTP 形状参数化）仍未做。

**共享包**：`packages/test-support/`（`@dshtrading/test-support`，`"private": true`，不进发布闭包），
有 `build`（tsdown → `lib/`）与 `test` 两个脚本。`tsdown.config.ts` 显式 `external: ['vitest']`：
本包运行期唯一的 import 就是 vitest（声明在 devDependencies），不外置会把 vitest 的模块图拷进
`lib/node_modules`（实测 48 个文件 600 kB）。它导出：

- `expectLocaleKeyParity(zh, en)`：词典 zh/en 键集合双向对齐 + zh 非空 + 逐键 `{placeholder}` 集合一致，
  逐条等价搬运自三处重复用例（含失败消息 `'key ' + key`）。本包自带行为测试，证明词典缺键或
  占位符漂移时该断言确实报错。
- `VALID_STRATEGY_SOURCE`：合法策略源码样本（compute 返回信号**列表**）。三处逐字节相同的原文收成一份；
  第 4 处消费方 `validate.test.ts` 原为 `(bars, params)` 变体，改用共享样本后 15/15 全绿，该变体已删。
- `VALID_SCREENER_SOURCE`：选股器 evaluate 样本（返回 `{ metrics, reason }`，未命中返回 null）。
  与上一条形状不同是刻意的：策略返回信号列表，选股器返回单次命中，两者不可互换。

**刻意保留的分叉**：`packages/strategies/test/plugin-list.test.ts` 仍用本地样本，reason 文案是
`'demo'/'demo'`（该用例断言列表渲染原样透传 reason 文案）。该文件已加注释标明分叉刻意、不得合并，
`VALID_STRATEGY_SOURCE` 的文档注释同时点明这一点。

**消费方只改 import**：bot-gui 与 special-indicators 的 `locale-contract.test.ts` 把两条 parity 用例
合并为一次 `expectLocaleKeyParity` 调用；`client-ui-strategies` 的 `locale-contract.test.ts` 原有 4 条
用例未动，另加一条 parity 用例（该包此前没有键集合/占位符契约）。四处策略源码样本改用
`import { VALID_*_SOURCE as VALID_SOURCE }`，调用点一行未动，样本字节数与原文 sha256 一致
（策略 459B `de1a519b…`、选股器 214B `cc5b144b…`）。

**门禁事实**：`typecheck-gate` 基线新增 `packages/test-support/tsconfig.json: 0`；`test:audit` 无新增
测试债（`client-ui-strategies` 那份用例的 bdd-title/bdd-gwt 存量债仍是 4/4）；覆盖率分母新增本包
（`coverage-gate` 只枚举有 `test` 脚本的包），其 `src` 覆盖 100%（16 行 / 7 分支 / 2 函数），
仓库级四项指标无下降，故未改 `coverage-baseline.json`。

## Context & Efficiency Impact

- 可省约 150–250 行夹具 + 约 54 行样本 + 约 70 行重复用例。
- 真实收益在「契约变一次要核对几处」：`MarketDataService` 从 10 处变 1 处，
  合法源码样本从 6 处变 1 处（刻意的变体除外）。
- 成本：新增一个私有包（`packages/test-support/`）。它有 `build` 与 `test` 脚本，因此同时进了
  `pnpm -r build` / `-r test` 的枚举、多出一条 `typecheck-gate` 基线、多一个 `coverage-gate` 分母项
  ——三项都在落地同批处理，见「已落地（2026-10-15）」。

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

- 新增包会改变 `pnpm -r build` / `-r test` 的拓扑与覆盖率分母。已核实：`gates-all` 直接跑
  `pnpm -r build` 与 `pnpm -r test`，某个子命令在不在包里由 pnpm 按脚本存在与否决定，
  不存在「把没有 build 脚本的包当缺产物」的判定；`typecheck-gate`（枚举 `packages/*/tsconfig*.json`）
  与 `coverage-gate`（只枚举有 `test` 脚本的包）各按自己的枚举收一次新包，已在落地同批登记。
- `VALID_SOURCE` 的「有意分叉」若被合并成一份，会把 `plugin-list.test.ts` 那条
  「列表渲染用不同 reason 文案」的断言悄悄改成与其它处相同——合并时必须保留那份差异。
- 夹具共享会让一个工厂同时承担多个包的形状需求；`shape` 参数必须显式，
  不能退回成 `Partial<T>` + 默认值的隐式形态。
