# Agent Note: 桌面安装包内置完整工具链（node + npm + pnpm）

Status: implemented

## Problem

桌面版发行目标是一台「从未配置任何编程环境」的电脑开箱即用。此前
`desktop/scripts/fetch-node.mjs` 已经把官方 Node 发行版打进安装包（node + npm +
npx + corepack 随发行版自带），`main.cjs` 的 `childEnv` 也把内置 bin 目录置顶
PATH——但 **pnpm 不在内置工具链里**。dsh 宿主管理 profile 插件时会把
`pnpm <args>` 前转到 profile 目录，宿主源码里明确有
"pnpm not found on PATH — install pnpm to manage profile plugins" 的报错路径；
desktop README 的 Known limitations 也长期记录着「依赖 pnpm 的应用内插件安装
不可用」。fallback 行为是 corepack 首次使用时从 registry 联网下载，对纯净机
既不可靠也不可离线。

## Decision

1. **新增 `desktop/scripts/stage-pnpm.mjs`**：把 pnpm 以 `npm install -g
   pnpm@<pin> --prefix <staged-node-dir>` 的方式装进当前平台暂存的 Node 发行版
   （darwin 装两个 arch、win32 装 x64，bin shim 样式天然按平台正确：unix 相对
   symlink / Windows cmd shim）。pnpm 版本钉仓库根 `packageManager`
   （`pnpm@11.9.0`），与构建载荷用的 pnpm 同版本。幂等：已装同版本跳过；
   装完断言 bin 存在、posix symlink 全为可解析的相对链接（afterPack 对 node
   目录只放行相对 symlink，会被它兜底）、`pnpm --version` 可执行。
2. **接线 `prepare-runtime`**：`fetch-node → fetch-redist → stage-pnpm →
   build-runtime`；`build-runtime.mjs` 的 VERSION.json 戳记增加 `pnpm` 字段
   （informational，不进 main.cjs 的 reseed stampText，避免无谓的全量 profile
   reseed）。
3. **新增发布闸门 `desktop/scripts/verify-runtime-toolchain.mjs`**：逐项校验
   当前平台每个暂存发行版的 node/npm/npx/pnpm 存在且可执行（打印版本），
   desktop-release.yml 在 prepare-runtime 之后、electron-builder 之前跑，
   缺件即 fail fast。
4. README（中英）同步：描述改为「内置完整工具链」，删除已失效的
   「依赖 pnpm 的应用内插件安装不可用」限制条目。

为什么选 `npm -g` 装真 pnpm 而不是 corepack shim：corepack 的 shim 依赖
corepack 缓存目录（用户目录下），首用还要联网拉 pnpm，装进安装包后不可携带；
`npm -g` 装的是真实文件树 + 相对 symlink，离线、自包含、与 npm 自身的分发
方式同构。

## Consequences

- 本地实测（darwin arm64/x64 暂存目录）：stage-pnpm 安装 + 验证通过、
  幂等重跑正确、`verify-runtime-toolchain` 打出 node v24.20.0 / npm 11.19.0 /
  npx 11.19.0 / pnpm 11.9.0；`npm test`（desktop）8/8 绿。Windows 侧走
  win32 runner 实机（cmd shim 布局），首次发版时由新闸门验证。
- 纯净机能力升级：安装包内 pnpm 离线可用，宿主的 pnpm 前转
  （`dsh plugin add` 等）不再依赖系统环境或联网下载。
- Windows 布局说明：win32 全局 bin = prefix 根（node.exe 旁的 `pnpm.cmd`），
  包体在 `<dir>\node_modules\pnpm`；脚本与闸门都按此路径校验。
- 变更面：`desktop/scripts/stage-pnpm.mjs`（新增）、
  `desktop/scripts/verify-runtime-toolchain.mjs`（新增）、
  `desktop/scripts/build-runtime.mjs`（戳记）、`desktop/package.json`
  （scripts + 描述）、`.github/workflows/desktop-release.yml`
  （prepare-runtime 链 + 闸门步骤 + 头注释）、`desktop/README.md` /
  `README.zh.md`、本 note。`resources/runtime/` 为 git-ignored 构建产物。
