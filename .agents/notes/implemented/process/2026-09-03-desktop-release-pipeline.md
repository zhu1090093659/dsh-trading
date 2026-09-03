# Agent Note: 桌面发版管线（desktop-release.yml）与 dsh-trading-release skill

Status: implemented

## Problem

仓库已有桌面壳（desktop/，Electron + electron-builder，mac/win 双平台，未签名），
但没有发版管线：远端尚无任何 tag，打包与发布全靠手工，产物没有稳定的对外
分发渠道。需要一个"发版开关"：推 tag 即自动打包桌面版并创建 GitHub Release。
同时发版操作流程没有固化入口，跨会话不可复现。

## Decision

- 新增 `.github/workflows/desktop-release.yml`：推送 `v*` tag 触发，三 job——
  ① `check-version` 硬校验 @dsh-trading/* 全家族版本 = tag 版本（新增
  `scripts/verify-release-version.mjs`）；② `build-desktop` 在 macos/windows
  runner 上执行与 ci.yml 同源的 build+test 门禁，随后 npm ci + prepare-runtime
  打 runtime payload，按 tag 重写 desktop 版本（新增
  `scripts/set-desktop-version.mjs`）后 electron-builder 打包（mac dmg+zip
  arm64/x64，win nsis+zip x64）；③ `github-release` 汇总产物、生成
  SHA256SUMS.txt、`gh release create --generate-notes`。
- 版本事实源 = tag。changesets fixed 组（@dsh-trading/*）负责统一 bump；
  desktop/package.json 不参与 changesets，版本由管线按 tag 重写，安装包文件
  名自动跟随。
- 不发布 npm：本仓库未授权 npm 发布，桌面安装包是唯一对外分发物。因此没有
  "版本号不可重发"约束——管线失败（Release 未创建）时删 tag 重推即可；
  Release 已创建后需先删 Release 再删 tag。
- 新增 `.dsh/skills/dsh-trading-release/SKILL.md`（骨架移植自 dsh-web 的
  dsh-web-release skill：tag 即事实源 + 硬校验 + tag 触发管线 + 发布后验证；
  内容按本仓重写：changesets bump、无 npm 通道、同 tag 修复重推规则、
  未签名安装包约定）。skill 放 .dsh/skills/ 而非 .agents/skills/，避免被
  sync-skills.mjs 打进 kit 包资产——它是仓库流程 skill，不是用户侧技能。

## Alternatives considered

- **npm publish 管线（照搬 dsh-web release.yml）**：本仓库未授权 npm 发布，
  workspace 包经桌面安装包 tarball 内嵌分发，registry 通道无意义，放弃。
- **main 分支 push 触发构建（无 tag）**：无法区分"每次合入"与"发版"，会为
  每个提交产出安装包并覆盖 Release；tag 是显式发版开关，语义清晰且可追溯，
  放弃。
- **版本一致性只警告不阻断**：桌面安装包内嵌的 workspace tarball 版本来自各
  package.json，警告会被忽略并发出"包内版本与 Release 版本矛盾"的安装包，
  必须硬失败，放弃。
- **本地脚本打包后手动上传 Release**：不可复现、依赖本机 electron/Xcode
  状态，且跨平台（win 安装器）无法在本机构建，放弃。
- **skill 放 .agents/skills/ 走 sync-skills 分发**：会把仓库流程说明打进四个
  kit 包资产，污染用户侧技能面；.dsh/skills/ 是会话级 skill 目录，与 dsh-web
  的存放约定一致，放弃。

## Consequences

- 发版动作收敛为"main 全绿 → changeset version → commit → tag → push tag"，
  桌面产物与 GitHub Release 全自动产出，跨会话按 skill 可复现。
- desktop/package.json 的 version 字段仅在 CI 中被重写，本地它与 tag 可能
  短暂不同步（无害，但 review 时不要误当作 bug）。
- 管线引入新的外部依赖面：Node 发行版下载（fetch-node.mjs，带 SHASUMS256
  校验）、Electron/electron-builder 二进制（已加 actions/cache）。这些步骤
  失败时的排障路径写入 skill 第 3 节。
- 首次运行（v0.1.0）即暴露 Windows 路径问题：build-runtime.mjs 的
  spawnSync('pnpm') 在 Windows 上无法解析 pnpm.cmd shim（ENOENT），修复为
  win32 下 spawn 带 shell:true（args 均为固定常量或 CI 上的无空格绝对路径，
  不引入注入面）；mac job 首跑即绿，验证了 mac 链路端到端可用。
- 后续若引入代码签名/公证，是独立决策，须新增 Agent Note 并同步 skill。
