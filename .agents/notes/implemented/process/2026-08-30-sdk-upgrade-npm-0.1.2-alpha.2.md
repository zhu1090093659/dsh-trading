# Agent Note: SDK 依赖切到官方 NPM 0.1.2-alpha.2 世代（DSH SDK 不再 pin 源码 checkout）

Status: implemented

## Problem

开发期 DSH SDK（`@deepseek-ai/*`）此前用 `pnpm-workspace.yaml` 的 `overrides` 把名字钉到
官方源码 checkout（`file:`/`link:` 指向 `/Users/zcl/code/deepseek-harness`，只读消费）。
DSH 0.1.2-alpha.2 已发布到 npm（dsh-web 已成功升级），官方 SDK 世代可直接从 npm 解析，
继续 pin checkout 属于历史的开发期过渡。目标：把 dsh-trading 的 dev/构建依赖切到 npm
官方 0.1.2-alpha.2 世代，并移除 checkout 的 `file:`/`link:` overrides。

## Decision

1. **cohort 对齐 dsh-web**：`@deepseek-ai/dsh-*` → npm `0.1.2-alpha.2`；配套生态钉
   `cordis@4.0.2`、`cosmokit@1.8.3`、`schemastery@3.18.2`（registry `@deepseek-ai` 源
   显式写 `.npmrc`）。
2. **移除全部 `file:`/`link:` overrides**，删除对 DSH checkout 的依赖；root devDeps 从
   `*` 改为显式 cohort range（`^0.1.2-alpha.2` / `^4.0.2` / `^1.8.3` / `^3.18.2`）。
3. **`autoInstallPeers: true`**：把 SDK 声明/静态 import 的宿主 peer 集自动物化进本仓，
   确保 vitest 能解析 `defineTool` 等入口的静态 peer import（0.1.2-alpha.2 的 barrel
   只静态 import `dsh-scope`/`dsh-llm`；`dsh-session`/`dsh-system-prompt` 已非静态依赖，
   比 checkout 世代更小）。发布语义不变——仍是 peers，不进 dependencies。
4. **peer range 保留宿主兼容**：插件在运行时由宿主 dsh 提供 SDK。当前宿主
   `/Users/zcl/.local/bin/dsh` 仍是 0.1.2-alpha.1，故 peer range 保留 `>=0.1.2-alpha.1`
   / `>=4.0.0` / `>=3.18.0`（lockfile 仍解析到最高 = alpha.2）。不收紧到 `^0.1.2-alpha.2`
   ——否则 alpha.1 宿主无法满足 peer（SDK 领先宿主的老问题，禁止）。
5. **顺带修正 latent bug**：`crypto/us/cn/hk` 的 `schemastery` peer range 声明为
   `>=4.0.0`（npm 无 4.x，overrides 时代被 file: 掩盖）→ 改为 `>=3.18.0`，否则无法从 npm
   解析。`base` 的 `dsh-agent-presets`（dependencies）从精确 `0.1.2-alpha.1` → `>=0.1.2-alpha.1`
   （解析到 alpha.2，与该世代数一致）。
6. **pnpm 11 minimumReleaseAge**：0.1.2-alpha.2 刚发布、落在 release-age 窗口内，pnpm
   install 自动把全部 cohort 版本写入 `minimumReleaseAgeExclude`（与 dsh-web 清单一致）；
   保留并注释。

## Consequences / Compatibility Handoff

- **CI 基线全绿**：`pnpm -r build`（19 包，exit 0）、`pnpm -r test`（283 passed + 2
  skipped，0 失败）；`pnpm install --frozen-lockfile --ignore-scripts` 通过（supply-chain
  366 entries）。
- **无源码二次修复**：dsh-trading 消费的 API/type/service 面在 alpha.2 无破坏性变化（build+
  test 均通过），未触发 `dsh-web-sdk-compatibility` 的源码适配阶段。
- **host 注意**：宿主 `dsh` 仍 0.1.2-alpha.1。因 peer range 保留 `>=0.1.2-alpha.1`，当前
  宿主仍可满足，无回归。后续宿主升级到 0.1.2-alpha.2（走 dsh-upgrade）时，同一构建产物
  直接兼容；届时如需收紧 peer range 再单独处理。
- 变更面：`pnpm-workspace.yaml`（overrides 移除 + autoInstallPeers + exclude）、root &
  api/base/cn/crypto/hk/us `package.json`、`pnpm-lock.yaml`（全量对 npm）、新增 `.npmrc`
  （@deepseek-ai registry）。connectors/kits/client-ui 的 peer range 与基线一致（无改动）。
