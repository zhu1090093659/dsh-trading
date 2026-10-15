# Agent Note: 逐包构建与类型配置是同一份配置的 N 份副本

Status: proposed

## Problem

四组配置面各自把同一份事实抄了 N 遍，且每一份都被门禁单独记账：

- **`packages/*/tsconfig.json`：61 份里 46 份去掉空白后完全相同**（内容为
  `{"extends":"../../tsconfig.base.json","compilerOptions":{"rootDir":"src","outDir":"lib"},"include":["src"]}`，
  两种缩进排版）。它们不是装饰：`scripts/typecheck-gate.mjs` 以
  `^tsconfig[^/]*\.json$` 枚举每个包目录下的配置文件并逐份 `tsc --noEmit -p`，`scripts/typecheck-baseline.json`
  为每份记一条独立键，调用点是 `ci.yml` 的 static-gates、`scripts/gates-all.mjs` 与
  `desktop-release.yml`。改一次 `rootDir` / `outDir` / `include` 策略要改 46 个文件。
- **`packages/*/tsconfig.host.json`：8 份（client-ui-* 七个加 indicator-supertrend）去空白后是同一份 12 行。**
  同包 `tsconfig.json` 覆盖同一文件集，而这 8 份相对它的唯一增量 `composite: false` 在
  `tsconfig.base.json` 自述「删除 composite/incremental」之后已无对象可覆盖（实测去空白哈希 8 份同一组）。
  全仓对它的引用只有 typecheck 基线的 8 条键——没有任何构建、编辑器或脚本读它。
- **`packages/*/tsdown.config.ts`：61 份里 37 份落在 6 个去空白等价组**（16 / 8 / 5 / 4 / 2 / 2）。
  其中 8 份那组正是六个市场 bundle 与 all / gui，属既定的「多市场对称是刻意重复」，不在本提案面内；
  20 个 connector 落在 16 + 4 两组，逐字差异只有注释行。
- **`packages/*/tsdown.client.config.mjs`：11 份合计 1283 行；摘掉各自的 `const ID` 行后，4 份与 2 份分别逐字节相同。**
  文件注释自述 banner/footer/intro 三段必须与 DSH 内部 preset 一致——即这段配置是内部 preset 的手抄镜像，
  内部 preset 每变一次（externals 白名单、purityGate 正则、CJS 包装形状）都要人工同步 11 处，
  漏改的失败模式是整条 client loader entry 在浏览器里炸。

## Proposal

按「只合并等价组、不动真有分叉的那几份」推进，分四步，每步独立可验收：

1. 新增 `tsconfig.package.json`（3 行，`extends` 自 `tsconfig.base.json` 并补 `rootDir`/`outDir`/`include`），
   把 46 份等价的 `tsconfig.json` 瘦身为 3 行 `{"extends":"../../tsconfig.package.json"}`。
   **文件必须保留**——typecheck 门禁按文件名发现，删文件等于让这些包退出类型检查。
2. 删除 8 个 `tsconfig.host.json`，同步移除 `typecheck-baseline.json` 里对应的 8 条键
   （不删键门禁会报基线过期）。host 半的类型面由同包 `tsconfig.json` 承担。
3. 为 `tsdown.config.ts` 的 6 个等价组各建一份共享 base（`tsdown.package.config.ts` 一族），
   等价组内各包改为 1 行引入。**先只做差异仅注释行的 20 个 connector**，其余 4 组各自评估。
4. 为 `tsdown.client.config.mjs` 的 4 份与 2 份各建一份共享 base，ID 由每包一行覆盖，
   banner/footer/intro 只留一份。

## Context & Efficiency Impact

- 可省文本：`tsconfig.json` 约 276 行、`tsconfig.host.json` 96 行、`tsdown.config.ts` 约 260 行、
  `tsdown.client.config.mjs` 约 640 行。
- 门禁侧：typecheck 少 8 次 `tsc` 进程与 8 条基线键；策略变更点从 46 + 8 + 37 + 11 处收成 4 处。
- 无模型可见面变化：这些文件不进工具 schema、不进提示词。

## Alternatives considered

- **维持逐包一份**：否决。等价性已用去空白哈希证明（46/61、8/8、37 落 6 组、6/11），
  它们此刻表达的分叉是零；留着只是让「改一次构建口径」变成 46 处编辑。
- **把配置压成一份、连文件一起删**：否决。`typecheck-gate.mjs` 按文件名枚举，
  删掉配置即这些包退出类型检查——那是减少覆盖，不是移除维护义务。
- **把六个市场 bundle 的 `tsdown.config.ts` 一并并入**：否决。多市场对称是刻意的
  provider/平台中立重复（见 `AGENTS.md` 的工作约定与既有裁决），本提案只碰等价组。
- **给 typecheck 门禁改成「按策略生成配置」而不是按文件枚举**：暂不提议。
  那会把配置面从文件树搬进门禁脚本，复杂度只是换了个家；先做瘦身，再看是否还值得。

## Verification & Gates

- 每步之后跑 `pnpm build` 与受影响包的 `pnpm --filter … test`，并跑 `pnpm typecheck` 与 `pnpm gates:all`。
- 步骤 1/2 的判据：`pnpm typecheck` 退出码 0 且 `typecheck-baseline.json` 无「基线过期」报错。
- 步骤 3/4 的判据：`pnpm -r build` 退出码 0，且逐包比对 `lib/` 产物与改动前一致
  （`tsdown` 的 `target` / `unbundle` / `fixedExtension` / externals 任何一项漂移都会在产物形状上暴露）。

## Risks

- `typecheck-baseline.json` 是棘轮：删配置必须同批删键，否则门禁判红；顺序错了会被误读成「改动破坏了门禁」。
- 步骤 4 的 client 构建配置牵着浏览器运行时：externals 白名单收窄会让 `purityGate` 直接 throw。
  必须逐组比对 externals 列表后再合并，不能按「看起来一样」合并。
- 步骤 3 只对有 diff 证据的等价组成立；`connector-hithink` / `jin10` / `polymarket` 三份是真的分叉，
  不得并入。
