# Agent Note: CI tsc --noEmit 棘轮门禁 — 噪音口径先修零再取基线（55 tsconfig / 555 错）

Status: implemented

## Problem

tsdown/esbuild 的 `pnpm -r build` 不做类型检查，PR #46（2026-09-02）协作者
「build 全绿」但实际带着 3 个真实类型错误（读契约上不存在的字段、TS6133 死
变量、TS2375）合入 main，直到人工跑 tsc 才发现。直接把 `tsc --noEmit` 设为
失败门禁不可行：存量旧债约 900+ 条（含大量模块解析噪音），一次性修完超出
合理 PR 范围。

## Decision

**1. 棘轮门禁（ratchet gate），不做错误码豁免。**
`scripts/typecheck-gate.mjs` 遍历 `packages/*/tsconfig*.json`（55 个，含
client-ui-\* 与 indicator-supertrend 的 json/client/host 三件套），逐配置跑
仓库内 TypeScript（`node node_modules/typescript/bin/tsc --noEmit`，版本由
lockfile 钉死，绕开 npx 网络漂移），统计 `error TS\d+` 诊断行数，与
`scripts/typecheck-baseline.json` 比较：超基线 → exit 1；新增 tsconfig 未入
基线 / 基线含已删除配置 → exit 1；`--update` 刷新基线但拒绝升高（升高需
`--force` 并在 PR 说明）。CI 在 `pnpm -r build` 之后、`pnpm -r test` 之前跑
（node 22/24 矩阵各跑一次，tsc 退出码 0/2 为正常语义——5.6+ 带诊断退出 2，
脚本按「有诊断数且退出码 ∈ {1,2}」判定，防静默吞基础设施失败）。

**2. 噪音口径：优先修 tsconfig 归零，而非 gate 豁免。** 修零前全量探底
~1120 条错误中三类结构性噪音：

| 噪音 | 条数 | 根因 | 修法 |
|---|---|---|---|
| TS5097 | 140 | 全仓惯用 `.ts`/`.tsx` 扩展导入（tsdown 原生支持），tsc 未开开关 | `tsconfig.base.json` 加 `allowImportingTsExtensions: true`（仅 noEmit 形态合法，base 内注释已声明该前提） |
| TS17004 | 160 | client-ui-knowledge/settings/supertrend/strategies 的 tsconfig.json `include:["src"]` 把 client `.tsx` 扫进 server 配置 | include 收紧到 `["src/index.ts"]`（与 client-ui-trading 同款；已验证 server 入口不 import client 代码，tsc 沿 import 图不会扫入） |
| TS2307 | 74 | ① kit 四包与 strategies type-only 导入 `@dsh-trading/api` 但未声明依赖（pnpm 严格解析无 symlink，**build 后也不归零**——不是缺 lib/\*.d.ts）；② client 包 CSS Modules 无类型；③ `@deepseek-ai/dsh-client-ui-tool/client` type 导入无源 | ① 各包 devDependencies 补 `workspace:*`（type-only 导入擦除，零产物影响）；② 四个 client 包加 `src/client/modules.d.ts`（声明契约与 cssModulesInline 插件的 `Record<local, hashed>` 对齐）；③ client-ui-trading/strategies devDep 精确钉 `0.1.2-alpha.3`（cohort 对齐宿主，不浮动） |

另修 1 个真 bug：`packages/api/src/index.ts` 的 cordis Context augmentation
从未 import 目标模块，TS2664 下整段 augmentation 失效（市场命名空间 ctx 键
类型没挂上）——文件顶部加 type-only import `import type {} from
'@deepseek-ai/cordis'` 锚定解析，保持零运行时。修完 api 归零。

修零后重跑全量得 **555 条真实旧债**（部分包比修零前多，如 kit-cn 35→26 反而
更少、client-ui-trading.client 137→63；也有因类型解析打通后级联抑制解除而
显形的，属预期）。

**3. 基线与清债路径。** 基线在 `pnpm -r build` 之后的干净环境取（依赖包
`lib/*.d.ts` 就位；脚本带前置检查，缺 api/lib 会 exit 2 提示先 build）。基线
数字 555，大头：client-ui-trading.client 63、connector-tiger 25、connector-
longbridge 24、kit-cn 26、knowledge 26、strategies 42、settings.client 33。
清债方式：改哪个包就顺手清哪个包的存量 → `node scripts/typecheck-gate.mjs
--update` 只降不升地下调基线；错误数任何回升（新代码引入新错）直接红。

## Gotchas

- **tsc 5.9 退出码带诊断是 2 不是 1**：脚本首版按「exit 1 = 有诊断」判定，
  并发池下 40/53 配置被误判基础设施异常。实证 `node tsc --noEmit` 带错退出
  2、干净退出 0 后修正判定（有诊断数且 ∈ {1,2}）。任何「exit code 语义」
  假设都要单点验证。
- **vitest/esbuild 转译 `test/*.tsx` 按就近 tsconfig 读 `jsx`，与 include 无关**：
  收紧 client-ui-strategies tsconfig.json include 时删掉了原本为压 TS17004 加
  的 `jsx: react-jsx`，6 个 toolview-card 测试当场炸 `React is not defined`
  （本地最小复现归因后恢复选项并注释存在理由）。tsconfig 的 compilerOptions
  不只服务 tsc 程序内文件，动了要跑全量测试。
- **块注释里不能写 `kit-*/strategies` 这类含 `*/` 的片段**：会把 `/** */`
  提前闭合，脚本直接语法错误。
- **`--update` 也要允许首建**：基线文件不存在时 `--update` 从空表起步；
  门禁模式仍强制要求基线存在。

## Verification

- 红测：向基线为 0 的 packages/base 注入 TS2339 探针 → gate 精确指认
  `packages/base/tsconfig.json：1 > 基线 0` exit 1；删除后恢复绿（555/555）。
- `--update` 在探针存在时拒绝写入（exit 1，要求 --force）。
- `pnpm build && pnpm test` 全绿（101 文件 711 测试 passed；jsx 回归在验证中
  暴露并已修）。
