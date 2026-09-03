# Agent Note: SDK cohort 升级官方 NPM 0.1.2-rc.1（宿主 CLI + dev cohort + desktop pins + floor/overrides 机制修正）

Status: implemented

## Problem

官方 `@deepseek-ai` SDK 于 2026-09-03T06:21Z 发布 `0.1.2-rc.1`（npm `next` tag，
alpha 世代收口进入 rc）。本仓 dev cohort 钉在 `0.1.2-alpha.3`、宿主 `dsh` CLI 为
`0.1.2-alpha.4`、desktop 嵌入式 runtime payload 钉 `0.1.2-alpha.4`（search-exa 钉
`0.1.2-alpha.2`）。owner 指令：升级到 0.1.2.rc.1。

升级过程中发现上一轮（alpha.3，e814b30）遗留的结构性问题：锁文件存在
`0.1.2-alpha.2/alpha.3` 传递地层（dsh-invariants@alpha.2 在 peer 后缀中出现 326
次，node_modules 真实物化 alpha.2 拷贝）——这正是 2026-09-02 profile 嵌入拷贝
identity-split（`reading 'prepare'`）事故的根源，本轮一并根治。

## Root cause（新认识，修正 alpha.3 轮的决策前提）

- pnpm 11 默认 `minimumReleaseAge=1440`（24h）**非严格**模式：刚发布的版本在
  「宽 range」解析中被跳过，静默回退到域内最旧的合格版本。
- `minimumReleaseAgeExclude` 只在「域内没有任何年龄合格候选」时兜底生效；
  对 `>=0.1.2-alpha.1` 这类宽 floor 与官方包自身的宽 peer range **不生效**——
  alpha 老版本永远在场，rc 新版本永远选不上。
- 因此 alpha.3 轮仅动 exclude 清单 + root devDeps 的做法，注定留下 alpha.2 地层
  （当时靠 profile symlink 归一在运行面补救，仓库锁文件病根未除）。

## Decision

1. **floor 升级**：35 个 packages/*/package.json 中 56 处 `@deepseek-ai/dsh-*`
   floor `>=0.1.2-alpha.1|alpha.3` → `>=0.1.2-rc.1`（修正 alpha.3 轮「floor 不动」
   的决策——floor 是宿主版本契约，必须随 cohort 移动，且窄化 range 是解析落点
   正确的前提）。cordis/cosmokit/schemastery floor 不动（非 cohort 版本化）。
2. **overrides 钉定**：`pnpm-workspace.yaml` 新增 overrides 块，把图谱中 53 个
   `@deepseek-ai/dsh-*` 包精确钉 `0.1.2-rc.1`——在含传递 peer 的一切解析上下文
   强制单一世代。这是根治地层的机制（floor 管宿主契约，overrides 管 dev 解析）。
   升 cohort 时整块替换。
3. `minimumReleaseAgeExclude` 全量 alpha.3 → rc.1（54 条逐条核实 npm 存在；
   pnpm 自动补录 `dsh-client-ui-tool@0.1.2-rc.1` 第 55 条；配套 cordis@4.0.2 /
   cosmokit@1.8.3 / schemastery@3.18.2 / plugin-include@1.0.7 / loader@1.0.3
   在 rc.1 世代无新版本，保持不动）。
4. root devDeps `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-tools` → `^0.1.2-rc.1`。
5. desktop 面：`desktop/runtime/host/package.json` 宿主 pin alpha.4 → `0.1.2-rc.1`
   （lockfile 重解析，560 包闭包全落 rc.1，pnpm 自动生成 192 条 exclude）；`desktop/scripts/build-runtime.mjs`
   的 search-exa pin alpha.2 → `0.1.2-rc.1`（该文件是 profile-trading 清单的真实
   仓库面——`desktop/runtime/profile-trading/package.json` 本身被 gitignore，由
   脚本生成）。本次不重建 `desktop/resources/runtime` payload（gitignored 暂存物，
   由 build-runtime.mjs 再生，升 rc.1 后需重跑一次）。
6. 宿主 CLI 全局升级 alpha.4 → `0.1.2-rc.1`；trading-web profile 以
   `scripts/refresh-trading-web-profile.sh` 重挂宿主核心包 symlink 后冒烟。
7. `.github/workflows/ci.yml` SDK 注释改为版本无关表述（原注释钉 alpha.2 字样）；
   AGENTS.md 宿主权威版本行同步 rc.1。

## Consequences

- **非 SDK 漂移仅 3 个 patch**（整册重铸的连带）：@csstools/css-syntax-patches
  1.1.10→1.1.12、undici 8.10.0→8.10.1、zod 4.5.2→4.5.4，均在原 caret 域内。
- 锁文件终态：106 个 rc.1 快照、**0 个 alpha 残留**；frozen 从零安装 58 个
  @deepseek-ai 目录全部 rc.1 世代。
- 无源码适配：rc.1 公开面对 build+test 直接通过，未触发 compatibility handoff。
- CI 级门禁（worktree 内实测）：`pnpm install --frozen-lockfile` ✓ →
  `pnpm -r build` ✓ → `node scripts/typecheck-gate.mjs` 515=515 基线 ✓ →
  `pnpm i18n:check` ✓（715 zh 键）→ `pnpm -r test` exit 0（40 文件全过）✓。
- rc.1 无 engines 变更，CI node 22/24 矩阵不受影响；宿主 rc.1 下 trading-web
  冒烟含工具调用 + 行情 + auth fence + 重启持久化（防「能聊天一干活就崩」类）。
- 变更面：root `package.json`、`pnpm-workspace.yaml`（exclude+overrides+注释）、
  `pnpm-lock.yaml`、35 个 packages/*/package.json（floor）、
  `desktop/runtime/host/{package.json,pnpm-lock.yaml}`、
  `desktop/scripts/build-runtime.mjs`、`.github/workflows/ci.yml`（注释）、
  `AGENTS.md`（宿主版本行）、本 note。
