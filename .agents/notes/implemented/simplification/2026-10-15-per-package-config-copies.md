# Agent Note: 逐包构建与类型配置收敛到共享 base

Status: implemented

## Problem

四组配置面各自把同一份事实抄了 N 遍，且每一份都被门禁单独记账：

- **`packages/*/tsconfig.json`：61 份里 46 份去空白后完全相同**，内容为
  `{"extends":"../../tsconfig.base.json","compilerOptions":{"rootDir":"src","outDir":"lib"},"include":["src"]}`。
  它们不是装饰：`scripts/typecheck-gate.mjs` 以 `^tsconfig[^/]*\.json$` 枚举每个包目录下的配置文件并逐份
  `tsc --noEmit -p`，`scripts/typecheck-baseline.json` 为每份记一条独立键。
  改一次 `rootDir` / `outDir` / `include` 策略要改 46 个文件。
- **`packages/*/tsconfig.host.json`：8 份去空白后是同一份 12 行**，相对同包 `tsconfig.json` 的唯一增量
  `composite: false` 在 `tsconfig.base.json` 自述删除 composite/incremental 之后已无对象可覆盖
  （composite 默认即 false）。全仓对它的引用只有 typecheck 基线的 8 条键。
- **`packages/*/tsdown.config.ts`：61 份里 20 个 connector 落在两个去空白等价组（16 + 4）**，
  两组逐字差异只有一行注释。
- **`packages/*/tsdown.client.config.mjs`：11 份合计 1283 行**，摘掉各自的 `const ID` 行后 4 份与 2 份分别
  逐字节相同。banner/footer/intro 三段是 DSH 内部 preset 的手抄镜像，内部 preset 每变一次
  （externals 白名单、purityGate 正则、CJS 包装形状）都要人工同步 11 处，漏改的失败模式是整条
  client loader entry 在浏览器里炸。

## Decision

按「只合并等价组、不动真有分叉的那几份」收敛，策略变更点从 46 + 8 + 20 + 11 处收成 4 处。

1. 根 `tsconfig.package.json` 承载包内编译口径，46 份 `packages/*/tsconfig.json` 退化为
   `{"extends":"../../tsconfig.package.json"}`。**文件保留是硬约束**：typecheck 门禁按文件名发现，
   删文件等于让这些包退出类型检查。
2. 8 份 `tsconfig.host.json` 已删除，`typecheck-baseline.json` 同批移掉对应 8 条键；host 半的类型面
   由同包 `tsconfig.json` 承担（逐对 `tsc --listFiles` 证明 host 程序文件集 ⊆ sibling）。
3. 根 `tsdown.package.config.ts` 是 20 个 connector 的共享构建口径，各包 `tsdown.config.ts` 只剩一行
   `export { default } from '../../tsdown.package.config.ts'`。
4. 根 `tsdown.client.preset.mjs` 是 client-bundle 镜像的唯一副本；6 个包各留一行 ID 覆盖，
   经 `tsdown.client.package.buffer.mjs`（client-ui-knowledge/settings/strategies/updater）与
   `tsdown.client.package.string.mjs`（client-ui-indicators/indicator-supertrend）两个 base 分派。

### 共享面必须用 `${configDir}` 锚定包目录

`extends` 的相对路径按「声明它的文件」解析，不是在引用方解析。因此根 `tsconfig.package.json` 里
`rootDir`/`outDir`/`include` 写成 `"src"` / `"lib"` 会落到仓库根（实测 TS18003），必须写成
`${configDir}/src`、`${configDir}/lib`、`["${configDir}/src"]`（TS 5.5+，本仓钉 5.9.3）。
代价是这 46 份的 `tsc --showConfig` 不再打印 `files` 报告键（include 由相对变绝对所致），
程序本身不变——已用 `tsc --listFiles` 对拍确认。

## Scope of the merge

**未合并**（各有真实分叉或属刻意重复）：

- `connector-hithink` / `connector-jin10` / `connector-polymarket` 的 `tsdown.config.ts`——entry 集不同。
- 六个市场 bundle（crypto/us/cn/hk/futures/global）与 `all`/`gui` 那组 `tsdown.config.ts`——
  多市场对称是刻意的 provider/平台中立重复。
- `kit-cn`/`kit-crypto`/`kit-hk`/`kit-us`/`connector-stooq` 那组、`kit-futures`/`kit-global` 那组、
  `client-ui-knowledge`/`client-ui-strategies` 那组——同属等价组，本变更未纳入。
- `tsdown.client.config.mjs` 的 `client-ui-trading`（白名单更窄）与
  `client-ui-masters-quotes`/`dsh-i18n`（结构不同）——externals 白名单是安全边界
  （purityGate 对不在白名单的 `@deepseek-ai/*` 直接 throw），差异组不得并入。

## Verification facts worth keeping

- **`lib/client.js` 的原始字节在同配置重复构建之间不稳定**：同一份配置连跑 4 次得到 4 个不同 sha256，
  差异只在 CSS class map 的键序与尾逗号位置。因此 client 半的产物比对不能按原始字节判等，
  判据是「排序归一化后的摘要 + CSS class 对集合」。
- `typecheck-baseline.json` 是棘轮：删配置必须同批删键，否则 `+`/`-` 两类报错会让改动被误读成
  「破坏了门禁」。

## Alternatives considered

- **维持逐包一份**：否决。等价性已用去空白哈希证明，这些文件此刻表达的分叉是零；留着只是让
  「改一次构建口径」变成 46 处编辑。
- **把配置压成一份、连文件一起删**：否决。`typecheck-gate.mjs` 按文件名枚举，删掉配置即这些包退出
  类型检查——那是减少覆盖，不是移除维护义务。
- **共享 `tsconfig.package.json` 里直接写 `"src"` / `"lib"`**：否决，实测 TS18003，包含路径落到仓库根。
  用 `${configDir}` 是让 3 行形态成立的必要条件。
- **把六个市场 bundle 的 `tsdown.config.ts` 一并并入**：否决。多市场对称是刻意的
  provider/平台中立重复，本变更只碰等价组。
- **把 `tsdown.client.config.mjs` 的 4 份与 2 份并成一个 base**：可做但未做。两组唯一差异是 CSS 文本
  包不包 Buffer，lightningcss 的 `code` 两者都收，产物证明等价；保留两个 base 是为了让这次合并是
  纯搬运、不夹带行为变更，日后要收成一个 base 只需删 `cssCodeFrom` 参数。
- **给 typecheck 门禁改成「按策略生成配置」而不是按文件枚举**：暂不提议。那会把配置面从文件树搬进
  门禁脚本，复杂度只是换了个家。

## Consequences

- 省文本：`tsconfig.json` 约 326 行、`tsconfig.host.json` 96 行、`tsdown.config.ts` 约 280 行、
  `tsdown.client.config.mjs` 约 774 行。
- 门禁侧少 8 次 `tsc` 进程与 8 条基线键。
- 新增 5 个根级配置文件（`tsconfig.package.json`、`tsdown.package.config.ts`、
  `tsdown.client.preset.mjs`、`tsdown.client.package.buffer.mjs`、`tsdown.client.package.string.mjs`）。
  这些名字都不匹配 tsdown 的 `tsdown.config.*` 发现模式和 typecheck 的 `packages/*` 枚举，
  不会被自动加载或重复记账。
- 无模型可见面变化：这些文件不进工具 schema、不进提示词。

### 2026-10-21 补充：unbundle 包必须把 SDK 与自有 scope 钉为 neverBundle

`unbundle: true` 只会把包 package.json **声明过**的依赖当作 external；未声明的 scope 会被 rolldown 的
preserveModules 复制进 `lib/node_modules`，并把导入改写成 `./node_modules/.pnpm/…` 相对路径。那条路径
嵌着构建机 pnpm 虚拟 store 的目录名（版本 + peer 哈希），profile 副本换代漏同步即 `ERR_MODULE_NOT_FOUND`；
即便解析成功，加载的也是宿主之外的第二份 `@deepseek-ai/*`（cordis Service 身份割裂）。

因此 unbundle 包要在 tsdown 配置里固定 `deps: { neverBundle: [/^@deepseek-ai\//, /^@dshtrading\//] }`，
或者补上真实的依赖声明。当前只有 `packages/indicators`（值导入 cordis）与 `packages/router`（类型导入
cosmokit）出现过该形态并已修正；其余 unbundle 包是否收进共享 base 尚未做。见
[SDK cohort 升级 Note](../process/2026-10-21-sdk-upgrade-npm-0.2.1-rc.2.md)。
