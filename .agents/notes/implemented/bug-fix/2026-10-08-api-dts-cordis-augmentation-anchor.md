# Agent Note: api 的 cordis augmentation 锚点在 dts 产物里丢失（消费方 Context 身份分裂）

Status: implemented

## Problem

`packages/api/src/index.ts` 的 `declare module '@deepseek-ai/cordis'`（在 Context 上追加各市场服务键）依赖文件顶部的 `import type {} from '@deepseek-ai/cordis'` 作解析锚点（源码注释自述：无此 import，TS2664 下 augmentation 整体失效）。但 declaration emit 会丢弃**无绑定**的 type import：`lib/index.d.ts` 里只剩 `declare module`，对 cordis 没有任何引用。当消费方的导入图里存在「深度 ≥2 的模块引 api」时，该 `declare module` 被当成新的 ambient 模块而非 augmentation，消费方的 `Context` 变成「只有 api 注册的服务键」的接口（缺 `inject`/`on`/`plugin`/`get`/`set`…）。

2026-10-08 实测（router 是判据样本，`node node_modules/typescript/bin/tsc --noEmit -p packages/router/tsconfig.json`）：

- HEAD 两文件 = 5（= 基线）；P4 给 catalog 加 `form`/`assetClass` 后 = 12，其中 7 条是身份分裂（`index.ts` 4 条 TS2379 + (522,7)/(522,35)/(539,7) TS2339），与新增内容本身无关。
- 手工把锚点补回 `lib/index.d.ts` = 2 ⇒ 根因坐实。
- 触发条件二分：catalog 只加一条引 api 的 import（type / value / barrel / `import()` / 相对 `lib` 路径 5 种写法）都触发；只加字段、类型用本地字面量不触发；旁路文件引 api 但无人引用不触发，被 `tools.ts` 引用（深度 ≥2）触发。

## Decision

锚点改成**有绑定且被引用**的 type import，并让 dts 生成器保持外部裸说明符：

1. `packages/api/src/index.ts`：`import type { Context as CordisContext } from '@deepseek-ai/cordis'` + `export type { CordisContext }`——被导出引用，声明产物才留得住它。
2. `packages/api/tsdown.config.ts`：加 `external: ['@deepseek-ai/cordis']`。否则 dts 生成器把该外部类型解析成 `./node_modules/.pnpm/...` 相对路径、还把 cordis 的 d.ts 拷进 `lib/node_modules/`，于是 `declare module '@deepseek-ai/cordis'` 与相对路径导入落在两个模块身份上，锚点依旧失效（实测仅做 1 时 12→9，无实质改善）。

判据：`pnpm --filter @dshtrading/api build` 后 `lib/index.d.ts` 第 4 行为 `import { Context as CordisContext } from "@deepseek-ai/cordis";`，且 router 的 tsc 从 9 回落到 **2**（< 基线 5）。

## Alternatives considered

- **保持 `import type {}` 不变**：落选——产物里没有锚点，缺陷必然复现。
- **`export type CordisContext = import('@deepseek-ai/cordis').Context` 或 `interface CordisAugmentedContext extends CordisContext {}`**：落选——同样迫使 dts 生成器解析外部类型，产物里仍是 `.pnpm` 相对路径（实测 router 仍 9）。
- **在 router 侧改用本地词汇别名 + 编译期同集护栏**：落选——把「词汇唯一家」搬回 router，还多一层护栏，根因仍留在 api。
- **让每个消费方自己 import cordis 的 Context**：落选——消费方多一条无关依赖，且每加一个消费方就要重新记得。

## Consequences

- 消费方的 `Context` 重获 cordis 完整成员；router 的 typecheck 实测剩 2 条 = `Schema.string().default(undefined)` 的 schemastery 签名限制（既有债，改它要碰行为，未动）。
- 一般规则：包内**导出**了类型专用外部包（未列入 dependencies 的 type-only 依赖）时，必须在 tsdown 里把它标成 `external`，否则 dts 产物会把它解析成 `.pnpm` 相对路径并拷入 `lib/node_modules/`。
- `lib/` 不入库，这类缺陷只在 `pnpm build` 之后才可复现，源码审阅与 `tsc -p` 单包检查都发现不了——改 api 顶部的锚点或 tsdown 的 external 时，必须复跑消费方 tsc（router 是判据样本）。
