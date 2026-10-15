# Agent Note: 跨包重复的测试夹具与契约用例样本

Status: implemented

## Problem

测试面有三处「同一份事实在多个包各写一遍」，都由「本仓不存在共享测试包」这一约束顶着：

- **假服务与假响应桩**。`MarketDataService` 假件 10 份（`bot-api/test/` 六份、`strategies/test/` 三份、
  `router/test/tools.test.ts` 一份），其中 `bridge.test.ts`、`bridge-southbound-holdings.test.ts`、
  `bridge-kline-cross-source.test.ts` 三份是同一签名 `fakeService(overrides: Partial<MarketDataService> = {})`
  的重写。HTTP 响应桩 5 份且**同名不同形**：`bot-api/test/sse.test.ts` 的 `fakeRes()` 基于
  `EventEmitter + vi.fn`，而 `client-ui-bot-gui/test/route-handler.test.ts` 与
  `client-ui-special-indicators/test/route-handler.test.ts` 的 `fakeRes()` 只有 `writeHead` / `end`。
  提出时全仓 `from '@dshtrading/*test` 命中为 0——当时没有任何跨包测试依赖。
- **合法策略源码样本 `VALID_SOURCE` 6 份 / 2 个包**：`strategies/test/` 四份
  （`plugin.test.ts`、`plugin-management.test.ts`、`plugin-list.test.ts`、`validate.test.ts`）加
  `bot-api/test/bridge-strategy-management.test.ts` 一份，另有 `screener-management.test.ts` 里
  一个同名但内容不同（动量选股器）的变体。它是 strategies 沙箱契约的「合法源码」样本，
  契约每变一次要在两个包六处同步核对。
- **词典契约用例三份**：`client-ui-bot-gui/test/locale-contract.test.ts`、
  `client-ui-special-indicators/test/locale-contract.test.ts`（与前者近乎逐字）、
  `client-ui-strategies/test/locale-contract.test.ts`，合计 178 行。
  `scripts/i18n-audit.mjs` 只管 `dsh-i18n` 中心包，这三个包的词典靠各自的用例钉住。

## Decision

本仓有一个私有测试支持包 `packages/test-support/`（`@dshtrading/test-support`，`"private": true`，
不进发布闭包），有 `build`（tsdown → `lib/`）与 `test` 两个脚本。它承载三样东西，消费方一律
**只改 import**，断言一条不改。

**词典对齐**：`expectLocaleKeyParity(zh, en)` 断言 zh/en 键集合双向对齐、zh 非空、逐键 `{placeholder}`
集合一致（失败消息 `'key ' + key`），逐条等价搬运自那三处重复用例。`client-ui-bot-gui` 与
`client-ui-special-indicators` 的两条 parity 用例合并为一次调用；`client-ui-strategies` 原有 4 条
用例未动，另加一条 parity 用例——该包此前没有键集合/占位符契约（其词典 159 键双向对齐、零占位符漂移）。
三个包各自保留一个三行的用例文件调用它，包内不再有第二份断言实现。这三个包的词典仍不进
`dsh-i18n` 中心包的静态 import 名单——那会给已发布的 `dsh-i18n` 引入对私有包的 workspace 依赖。

**合法源码样本**：`VALID_STRATEGY_SOURCE`（compute 返回信号**列表**）收拢三处逐字节相同的原文，
`validate.test.ts` 的 `(bars, params)` 变体改用共享样本后 15/15 全绿，该变体已删；
`VALID_SCREENER_SOURCE`（evaluate 返回 `{ metrics, reason }` 或 null）保留独立形状。两者形状不同
是刻意的：策略返回信号列表，选股器返回单次命中，不可互换。消费方用
`import { VALID_*_SOURCE as VALID_SOURCE }`，调用点一行未动，样本字节与原文 sha256 一致。

**假服务**：`fakeMarketService(overrides)` 的默认体取自 `bot-api/test/bridge-cache.test.ts`
（与 `bridge-strategy-management`、`bridge-screener-management` 两处逐字相同），是契约默认值。
14 处 `MarketDataService` 假件里，3 处本地签名与默认体同共享默认、直接 import 别名；其余 11 处
（含 `bridge-active-buy` 与 `screener-run` 这两处带 options 的）保留 2–7 行薄包装，用 `overrides`
在调用点之外一次性表达差异（`timestamp` 1234/DAY/0/1、1 根/60 根/120 根 bar、`listInstruments`、
`getActiveBuySnapshot`）。100 个调用点一行未动。

**HTTP 响应桩**：`fakeHttpRes(shape)` 用显式形状名 + 重载区分三种形态，不做 `Partial` + 默认值合并：
`'json-response'`（记录 status/headers/body 并附 `json()`）、`'sse-writer'`（`EventEmitter` + `vi.fn`
的 writeHead/write，**无 end**，侧信道挂在返回包上）、`'sse-endpoint'`（有 end，侧信道挂在 res 自身）。
`vi.fn` 随之只出现在共享包，消费文件的 mock 计数从 199 降到 187。

**刻意保留的分叉**：`packages/strategies/test/plugin-list.test.ts` 仍用本地样本，reason 文案是
`'demo'/'demo'`，因为它断言列表渲染原样透传 reason 文案。该文件已加注释标明分叉刻意、不得合并，
`VALID_STRATEGY_SOURCE` 的文档注释同时点明这一点。

## 范围内外

本卡收的是「同名工厂/样本在多处各写一遍」这一类。刻意**不**纳入的内联桩（不是工厂多份，
收进来会把卡片拖成另一件事，留给后续按需处理）：

- closure 风格内联 `ServerResponse` 桩：`bot-api/test/bridge-invalidation`、`holdings-bridge`、
  `service-wiring`、`smoke`。
- 非 `MarketDataService` 的 `getTicker` 内联桩：`base/output-contract`、`base/research-tools`、
  `bot-api/smoke`、`connector-{alpaca,futu,okx,stooq,template,tencent,yahoo}`、`kit-crypto`（两处）。

## Alternatives considered

- **保持每包自带最小桩**：这是曾经的默认，理由是「每包可独立演进、不新增依赖」。
  但假服务里已经有 3 份是同签名的重写，说明这条自由在实践中并没有被用到；
  真正的分叉只有 HTTP 桩那几种形状，而它恰恰是**应该显式区分**而不是散落成同名不同形的。
- **跨包直接 `import` 别包的 `test/` 目录**：否决。那会把包变成测试期的 workspace 依赖，
  并波及覆盖率收集口径（一个包的测试开始拉另一个包的源码）。
- **把夹具塞进 `@dshtrading/api`**：否决。`@dshtrading/api` 是纯契约包（明文「本包不做运行时」），
  且带运行时代码的假件不是契约——它现在是 `test-support` 的 type-only devDependency。
- **只做其中一处**：三处最终都做了，按收益排序为 词典契约用例 → 合法源码样本 → 假服务与响应桩。
- **把三种 HTTP 形状合并成一个 Partial 形态**：否决。`'sse-writer'` 没有 `end`、`'sse-endpoint'`
  的侧信道挂在 res 自身，合并会把「同名不同形」这个原始问题重新引入。

## Consequences

- 共享包同时进了 `pnpm -r build` / `-r test` 的枚举（两个脚本都有），因此多出一条
  `typecheck-gate` 基线（`packages/test-support/tsconfig.json: 0`）；`coverage-gate` 只枚举有
  `test` 脚本的包，本包因此进分母，其 `src` 覆盖 100%（含共享假件的 5 条自测），仓库级四项指标无下降，
  `coverage-baseline.json` 未改。`gates-all` 直接跑 `pnpm -r build` / `pnpm -r test`，不存在
  「把没有 build 脚本的包当缺产物」的判定。
- `tsdown.config.ts` 显式 `external: ['vitest', '@dshtrading/api']`：`vitest` 是本包运行期唯一的
  import（devDependencies），不外置会把它的模块图拷进 `lib/node_modules`（实测 48 文件 600 kB）。
- 共享假件落在 `src` 却不被本包用例覆盖时，`--coverage.all` 会把本包拉到 33%，正卡门禁 0.2pp 容差
  ——所以假件自带行为测试是这条路径的必要条件，不是可选项。
- 契约变一次要核对的位置：`MarketDataService` 从 14 处变 1 处，合法源码样本从 5 处变 1 处
  （刻意分叉的 plugin-list 与选股器样本除外），词典对齐断言从 3 处变 1 处。
- 共享夹具让一个工厂同时承担多个包的形状需求，`fakeHttpRes` 的 `shape` 参数因此必须显式，
  不能退回成 `Partial<T>` + 默认值的隐式形态。
