---
name: dsh-trading-release
description: dsh-trading 发布与失败恢复入口。明确发布请求才执行统一版本、tag 和发布；CI/桌面管线修复只做诊断、补丁与验证，不自动发版。
whenToUse: 用户明确请求 dsh-trading 发版、桌面发布、指定发布 run 恢复，或修改 desktop-release 管线时使用；按正文先区分权限与任务路径。
---

# dsh-trading 发布与管线维护

## 先选路径与确认授权

- **修 CI/管线/配置**：只诊断、最小修复及相关门禁；到此停止。不得自动 bump 发布版本、提交/推送、打 tag、npm publish 或创建 Release。
- **恢复失败 run**：先读第 4 节，核对 tag/SHA、已发布 npm 版本与 Release 资产。重跑发布 job 仍会写外部系统，必须在当前授权内。
- **明确完整发布**：才执行第 0–3、5 节。用户未指定版本时可选下一 patch，但这不是把维护请求升级成发布的理由。
- 历史授权、现有 token、workflow 开关及旧 Note 都不授予当前发布权。确认请求覆盖的通道、仓库与版本范围；边界不清先问，不执行不可逆操作。
- 当前配置 `.github/workflows/desktop-release.yml` 的 `NPM_PUBLISH_ENABLED` 为 true（执行前重读）。推 tag 会连带 npm 发布及桌面/GitHub Release；只授权桌面发布时不能直接推 tag，也不能擅改开关来规避权限。明确 npm 通道许可或另行确认配置调整。

## 仓库契约

- 规范仓库 `zhu1090093659/dsh-trading`；只有 main，无 dev，tag 从含全部发布内容的 main 提交创建。大改动经 PR、小改可 main，遵循根 AGENTS 分级与当前 Git 授权。
- `@dshtrading/*` 全家族版本由 `.changeset/config.json` 的 fixed 组管理；`scripts/verify-release-version.mjs` 校验家族版本等于 vX.Y.Z tag。不手抄包数量。
- private 的 `desktop/package.json` 不参与 changesets；管线用 `scripts/set-desktop-version.mjs` 按 tag 重写。可在获授权的版本变更中对齐，不作强制手工步骤。
- npm 由 `scripts/publish-npm.mjs` 按 workspace 拓扑序发布，已存在的 name@version 跳过；**跳过不证明内容一致，也不允许换代码复用已发布版本**。任何发布包内容变化需新版本。
- 桌面产物经 GitHub Actions 构建，遵循 `desktop/electron-builder.yml` 未签名约定；签名/公证是独立决策。token 仅放受控 secret，不进文件或日志。
- 本技能位于 `.agents/skills/` 但被 `scripts/sync-skills.mjs` 排除，不进包分发资产；非平凡流程变化同步 Agent Note。

## 0. 门禁与基线

先加载 `dsh-parallel-dev`，检查 `git status --short --branch`、main 与远端 SHA、`git remote -v`；fetch/push 目的地须为规范仓库。共享 checkout 不自动 checkout/rebase；需整合时先确认本地改动与分支安全。发布前全部内容已合入 main。

完整发布门禁（在项目根执行）：

```sh
pnpm build
pnpm test
node scripts/typecheck-gate.mjs
pnpm i18n:check
```

桌面壳有改动时另在 `desktop/` 执行 `npm ci && npm test`。workflow 修复先 `actionlint` 并做针对性复现；不靠推 tag 测 CI。纯指令修改按文档差异验证，不运行会生成分发副本的构建。

## 1. 统一版本（仅明确发布路径）

1. 明确 X.Y.Z 或 major/minor/prerelease 要求优先；未指定时核验远端正式 tag、GitHub 已发布版本与 npm 占用，选下一可用 patch。无历史正式版本时检查现有家族版本，不盲猜。
2. 有 pending changeset：`pnpm changeset version`；无 pending 时先 `pnpm changeset` 创建所需级别 changeset，再消费。保持 fixed 组，不用 sed 批量改 package.json。
3. 检查输出与目标版本一致、变更范围仅含预期 package.json、CHANGELOG、changeset 等；首次发布且家族已等于目标可跳过 bump。
4. 按验证脚本的当前接口传入目标版本，校验所有包与 tag 一致；版本变化后补足受影响门禁，发布边界完整门禁必须全绿。

## 2. 提交与 tag（仅当前授权内）

- `git diff` 核对每个文件，`git add -- <逐个核对的精确文件路径>`；禁止宽目录暂存（packages/、scripts/、.agents/ 等）和 `git add -A`。检查 `git diff --cached` 无他人改动，再用 Conventional Commit 提交。
- 核对 main SHA、目标 tag 不存在、版本与全绿证据一致后，`git tag "vX.Y.Z"`。推送 main 与精确 tag 前再次核对 remote；不要 `--tags` 批推。
- `git push origin main`、`git push origin "vX.Y.Z"` 是发布路径的外部写入，不是修 CI 的测试方法。记录本次 tag、SHA 与 run id。

## 3. 发布管线与追踪

执行前以当前 workflow 为准；典型四个 job：

1. `check-version`：校验家族版本与 tag。
2. `npm-publish`：install/build/test 后按 NPM_PUBLISH_ENABLED 门控发布，与桌面构建并行。因此 **Release 尚未创建不表示 npm 未发布**。
3. `build-desktop`：macOS/Windows matrix，workspace 构建/测试、desktop `npm ci`、`npm run prepare-runtime` 拉取 Node 并构建 runtime payload、按 tag 设置桌面版本，再 electron-builder。mac arm64/x64 的 dmg/zip，win x64 的 nsis/zip。
4. `github-release`：汇总资产与 SHA256SUMS.txt，notes 使用 `.github/release-preamble.md`（保留 macOS 放行提示）加自动说明，创建 GitHub Release。

用 `gh run list --workflow=desktop-release.yml` 定位本次 SHA 的 run，再 `gh run watch <run-id>`，不把“最新 run”误认作本次。

## 4. 失败恢复（不默认改已发布 tag 代码）

- 先记录 tag 指向 SHA、失败 job/log、npm 每个目标包版本和已有 Release/资产。npm 可能部分成功，不能因没有 Release 就断言可复用版本。
- 网络抖动、临时凭据或权限故障：在当前授权允许补发且 SHA/包内容不变时重跑该 run 的失败 jobs。先核对幂等性和已存在资产，不默认重跑所有发布步骤。
- 版本不一致、代码/打包脚本/管线需改动：在 main 修复并验证；需要发布修复结果时申请/遵循新版本授权，创建新版本和新 tag。已发布 tag 保持原 SHA，不用 amend、force-tag、删远端 tag 或删除 Release 后重推恢复。
- 未发布 tag 的任何重定向也不在默认恢复流程内；只有独立明确授权并完成无已发布内容审计才另行评估。已分发内容不可静默替换。
- npm 坏包：报告影响，建议另行授权 deprecate 与下一补丁版本，不自动 deprecate/unpublish；禁止手工 publish 绕过管线。token 故障只报告所需 secret/权限，不泄露凭据。
- `prepare-runtime` 下载/host closure install 失败：按日志区分网络与构建问题；同原因连续失败走 notes 的 CI 归因闭环，不盲重试。
- Windows `spawnSync pnpm ENOENT`：pnpm 是 .cmd shim，核查 `build-runtime.mjs` 平台 spawnOptions；同时检查 POSIX-only 脚本。
- electron-builder 失败：检查 `desktop/electron-builder.yml` 与 `scripts/after-pack.cjs` staging 契约，runtime payload 应由 afterPack hook 复制，extraResources 会丢 node_modules。
- Contributors 误含 org mention：发布提交主题避免裸 `@org`；仅在授权修改 notes 时使用 `gh release edit ... --notes-file` 转义 mention，不删除重建 Release。

## 5. 发布后验证

- 记录精确 tag/SHA 与该 run 各 job 状态，不以其他 run 全绿替代。
- npm 通道实际启用且获授权时，检查目标 name@X.Y.Z 的发布结果及 dist 信息；抽查 `@dshtrading/all`、`@dshtrading/base`，并按发布日志对账全家族，不能只看 latest。
- `gh release view "vX.Y.Z" --json assets,body`：核对 mac 两架构 dmg/zip、win exe/zip、SHA256SUMS.txt、自动更新 feed `trading-update-vX.Y.Z.zip` 与 `updates-manifest-vX.Y.Z.json`；以当前 workflow 的实际资产契约为准，校验下载 hash。
- `git ls-remote --tags origin "refs/tags/vX.Y.Z"` 核对远端目标，说明失败或部分发布，不虚报完成。
- mac 抽查先核实安装目标、用户数据和运行实例，不擅自覆盖/重启。显式路径与 home 启动：`env -u ELECTRON_RUN_AS_NODE open --env DSH_HOME=$HOME/.dsh-trading "/Applications/DSH Trading.app"`；避免会话继承 `DSH_HOME=~/.dsh`、`ELECTRON_RUN_AS_NODE=1`（Electron 降级为纯 Node、应用根本不启动）或 LaunchServices 命中旧开发副本。
- 从 `~/Library/Logs/dsh-trading-desktop/dsh-host.log` 新增日志确认 `[desktop] dsh home:` 和 runtime/profile，再用 tokenized HTTP URL、curl、headless Chrome `--timeout` 验证，不做全屏桌面截图。

相关证据：[UI 验证](../../../.agents/notes/implemented/process/2026-09-04-ui-verification-hosted-http-headless-chrome.md) 由根 AGENTS 路由；[桌面 home 故障说明](../../../.agents/notes/implemented/bug-fix/2026-09-09-desktop-crash-profile-partial-copy.md)、[启动环境继承坑](../../../.agents/notes/implemented/process/2026-09-11-desktop-shell-local-rebuild-open-env-pitfall.md)。
