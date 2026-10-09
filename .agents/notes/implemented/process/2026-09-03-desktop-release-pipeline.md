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
  `scripts/verify-release-version.mjs`；private 包按 manifest `private: true`
  豁免，2026-09-17 起，见
  [release-version-gate-private-package-exempt](../bug-fix/2026-09-17-release-version-gate-private-package-exempt.md)）；② `build-desktop` 在 macos/windows
  runner 上执行与 ci.yml 同源的 build+test 门禁，随后 npm ci + prepare-runtime
  打 runtime payload，按 tag 重写 desktop 版本（新增
  `scripts/set-desktop-version.mjs`）后 electron-builder 打包（mac dmg+zip
  arm64/x64，win nsis+zip x64）；③ `github-release` 汇总产物、生成
  SHA256SUMS.txt、`gh release create --generate-notes`。
- 版本事实源 = tag。changesets fixed 组（@dsh-trading/*）负责统一 bump；
  desktop/package.json 不参与 changesets，版本由管线按 tag 重写，安装包文件
  名自动跟随。
- npm 发布通道（2026-09-03 用户授权，原"不发布 npm"决策作废）：desktop-release.yml
  增加 npm-publish job——同源门禁后按 workspace 依赖拓扑序幂等发布 45 个
  @dsh-trading/* 包（scripts/publish-npm.mjs：registry 已存在的精确版本跳过，
  pnpm publish 替换 workspace:*），token 存 GitHub secret NPM_TOKEN（凭据
  只进 secret，不进仓库文件），workflow env NPM_PUBLISH_ENABLED 可一键关闭
  npm 通道退回仅桌面发布。npm 与桌面并行、两路全绿才创建 Release（保持
  all-or-nothing）。npm 版本不可变 ⇒ 同版本换代码禁止，坏包走 deprecate +
  下一补丁；删 tag 重推安全（幂等跳过）。
- 新增 `.dsh/skills/dsh-trading-release/SKILL.md`（骨架移植自 dsh-web 的
  dsh-web-release skill：tag 即事实源 + 硬校验 + tag 触发管线 + 发布后验证；
  内容按本仓重写：changesets bump、无 npm 通道、同 tag 修复重推规则、
  未签名安装包约定）。skill 原放 .dsh/skills/；2026-09-14 起 skill 迁至
  `.agents/skills/dsh-trading-release/` 并删除顶层 .dsh（owner 要求统一技能
  目录，宿主会话技能发现统一走 .agents/skills），「不进分发资产」约束改由
  sync-skills.mjs 的 `DISTRIBUTION_EXCLUDED` 排除集保留。

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
  kit 包资产，污染用户侧技能面——该落败原因 2026-09-14 由 `DISTRIBUTION_EXCLUDED`
  排除集化解（skill 迁入 .agents/skills 但不同步）；「保持 .dsh/skills/ 独立
  顶层目录」随之放弃：双目录增加维护与发现成本，owner 明确要求统一到
  .agents/skills。

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
- **「删 tag 重推安全」有前提（2026-10-09 补，v0.6.0 → v0.6.1 实证）**：那条幂等性
  只在**代码本来就对**时成立。0.6.0 是相反形态：`npm-publish` 与 mac 桌面都成功、
  58 个 npm 包已公开，Windows 桌面因 `@dshtrading/authority` / `base` 的真实代码缺陷
  判红，`github-release` 因 all-or-nothing 跳过 ⇒ npm 已部分外化，而 Release 无法创建。
  这种形态**不能靠重推 tag 或重跑失败 job 救回**：tag 指向的 SHA 代码本身就是坏的，
  重跑只会复现同一失败；npm 同版本换代码被 §仓库契约禁止。唯一出路是**新版本号**
  （0.6.1 带上修复 + 已发布的 0.6.0 内容）+ 新 tag，重走整条管线。
  操作含义：`pnpm -r test` 遇首个失败包即中止，**发版前必须确认该次门禁是跑完全部包
  还是中止在首个失败包**——v0.6.0 的 Windows 桌面 job 只跑到 10/53 个包就因第一个失败
  包退出，其后包的 Windows 信号全部未观测（见 windows-compat note 的边界补充）。
