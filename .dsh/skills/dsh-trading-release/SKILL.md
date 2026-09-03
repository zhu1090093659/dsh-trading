---
name: dsh-trading-release
description: Release the dsh-trading monorepo — run pre-release gates, bump the unified @dsh-trading/* family version via changesets, commit and tag vX.Y.Z on main, push the tag that triggers the desktop-release GitHub Actions pipeline (builds the Electron desktop app for macOS arm64/x64 and Windows x64), and verify the GitHub Release artifacts. No npm publishing (unauthorized). Defaults an unspecified target to the next patch after the previous published release. Use when the user asks to 发布/发版/release/bump 版本/publish a new version of dsh-trading or the desktop app, or to build/repair the desktop release pipeline.
whenToUse: The user wants to release dsh-trading (发布新版、发个版本、release、打 tag、发桌面安装包、desktop release), change the release pipeline (.github/workflows/desktop-release.yml、发版脚本、发版流程), or recover from a failed release run (tag 与包版本不一致、桌面打包失败、Release 产物缺失). Not for routine commits, docs/notes changes, connector development, or CI changes unrelated to releasing.
---

# dsh-trading 发布（release / desktop artifacts）

本技能固化 dsh-trading 的完整发版流程：发版前门禁 → changesets 统一版本 bump →
提交 → 打 tag → 推送 tag 触发 GitHub Actions 桌面打包管线（macOS dmg/zip +
Windows nsis/zip）→ GitHub Release 自动创建并附着产物 → 发布后验证。

与 dsh-web 的关键差异：**不发布 npm**（未授权），对外分发物只有桌面安装包；
因此没有 npm 版本占用约束，tag 修复后可删除重推（详见第 4 节排障）。

## 仓库事实（先读，决定每一步怎么做）

- 仓库：zhu1090093659/dsh-trading（**PUBLIC**），本机路径 /Users/zcl/code/dsh-trading。
- **版本策略：@dsh-trading/* 全家族统一版本**，由 changesets fixed 组管理
  （.changeset/config.json 的 fixed: [["@dsh-trading/*"]]）。tag vX.Y.Z 即版本
  事实源，发布管线用 scripts/verify-release-version.mjs 硬校验全家族（当前
  45 个包，以脚本输出为准，不在技能中手抄数量）版本等于 tag 版本。
- desktop/package.json（Electron 桌面壳，private）**不参与 changesets**，版本
  由管线在打包前按 tag 重写（scripts/set-desktop-version.mjs），安装包文件名
  dsh-trading-desktop-${version}-<mac|win>-<arch>.* 跟随 tag。发版提交时建议
  顺手把它对齐到目标版本，但不作硬性要求。
- **npm 通道（2026-09-03 起授权）**：发布 @dsh-trading/* 全家族到
  registry.npmjs.org，仓库 secret NPM_TOKEN（automation token），管线 job
  `npm-publish` 由 workflow env NPM_PUBLISH_ENABLED 门控（'false' 时退回仅
  桌面发布）。发布脚本 scripts/publish-npm.mjs 按 workspace 依赖拓扑序逐包
  `pnpm publish`（workspace:* 由 pnpm 替换为真实版本），registry 已存在的
  精确版本自动跳过——删 tag 重推修 CI 是安全的。
- **npm 版本不可变**：同版本号换代码重推被禁止，包内容变更必须 bump；
  发出去的坏包只能 deprecate + 下一补丁版本，与 dsh-web 纪律一致。
- **分支模型**：只有 main（默认分支），无 dev 集成分支。发版 tag 一律从 main
  打。分支策略遵循仓库 AGENTS.md 交付流分级：大改动先 PR 合入 main，CI/文档
  小改可直推；tag 必须打在包含全部待发布内容的 main 提交上。
- 发布通道全部由 GitHub Actions 完成（.github/workflows/desktop-release.yml），
  不依赖本机 electron-builder / Xcode / 登录态；安装包按 electron-builder.yml
  约定**未签名**（identity: null，macOS 侧用户需右键打开或 xattr -cr 放行）。
- 本机有 actionlint（/opt/homebrew/bin/actionlint），改 workflow 后先本地 lint。
- 本技能位于 .dsh/skills/（会话技能），**不放 .agents/skills/**——后者是
  sync-skills.mjs 的分发源，仓库流程类 skill 不应被打进 kit 包资产。

## 0. 发版前检查（本地全绿才允许打 tag）

```sh
cd /Users/zcl/code/dsh-trading
git checkout main && git fetch origin && git rebase origin/main
git status --short                 # 明确本次要提交的内容，无意外文件
pnpm build                         # 全仓构建（含 sync:skills）
pnpm test                          # 全仓测试
node scripts/typecheck-gate.mjs    # 类型棘轮门禁（只许降不许升）
pnpm i18n:check                    # zh/en 键位对齐门禁
```

涉及桌面壳改动（desktop/）时额外跑：

```sh
cd desktop && npm ci && npm test && cd ..
```

发版前提：待发布的全部改动已合入 main（大改动经 PR），本地 main 全绿。

## 1. 版本 bump（changesets 统一）

### 选择目标版本

1. 用户明确给出 X.Y.Z，或明确要求 major/minor/prerelease 变更时，以该要求为准。
2. 用户没有指定具体版本号时，直接取远端最新正式 vX.Y.Z tag，默认目标为下一个
   补丁版本，不向用户追问：

```sh
PREVIOUS_TAG="$(
  git ls-remote --tags --refs --sort=-version:refname origin 'v*' \
    | awk '$2 ~ /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/ { sub("refs/tags/", "", $2); print $2; exit }'
)"
test -n "$PREVIOUS_TAG" || PREVIOUS_TAG="v0.0.0"   # 首次发版

IFS=. read -r MAJOR MINOR PATCH <<EOF
${PREVIOUS_TAG#v}
EOF
TARGET_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
printf 'Previous release: %s; default target: %s\n' "$PREVIOUS_TAG" "$TARGET_VERSION"
```

3. 首次发版（无任何远端 tag）且全家族已是目标版本时，可跳过第 2 步的 bump，
   直接进入提交与 tag；此时管线校验仍然必须通过（tag = 现有家族版本）。

### 消费 changesets（有 pending changeset 时）

```sh
pnpm changeset version    # 消费 .changeset/*.md，统一 bump 全家族
git status --short        # 确认 bump 范围：packages/**/package.json + 消费掉的 changeset 文件
```

没有 pending changeset 而需要手工 bump（例如用户直接点名版本）时，用
changesets 兜底：`pnpm changeset` 写入 patch changeset 后再 `pnpm changeset
version`，保持 fixed 组统一，不要用 sed 逐个改 package.json。

可选对齐：把 desktop/package.json 的 version 手工改成目标版本（非硬性要求，
管线会按 tag 重写）。

## 2. 提交与 tag

```sh
# 发版提交：版本 bump + 发布相关变更（管线/skill/脚本/.agents/notes/）
git add packages desktop/package.json .github/workflows/ scripts/ .dsh/skills/ .agents/notes/ .changeset/
git commit -m "chore(release): bump to X.Y.Z"

git tag "vX.Y.Z"                    # tag 命名固定 v 前缀；tag 即版本事实源
git push origin main
git push origin "vX.Y.Z"            # 推送 tag 即触发桌面打包管线（唯一发布开关）
```

## 3. 发布管线（tag 触发，.github/workflows/desktop-release.yml）

推送 v* tag 后 GitHub Actions 自动执行，三个 job：

1. **check-version**（ubuntu）：scripts/verify-release-version.mjs 硬校验
   @dsh-trading/* 全家族版本 = tag 版本；不一致即中止，无任何构建产物。
2. **npm-publish**（ubuntu，与 build-desktop 并行）：同源门禁（install/build/
   test）→ scripts/publish-npm.mjs 幂等发布全家族（NPM_PUBLISH_ENABLED 门控）；
3. **build-desktop**（matrix：macos-latest + windows-latest）：pnpm install →
   pnpm -r build → pnpm -r test（与 ci.yml 同源的发布门禁）→ desktop 内
   npm ci → npm run prepare-runtime（拉取 Node 发行版 + 把 workspace 包打包
   成 runtime payload，内部含再次 pnpm -r build，幂等）→ 按 tag 重写
   desktop 版本 → electron-builder 打包。mac 产物：dmg + zip（arm64/x64 各
   一套）；win 产物：nsis 安装器 + zip（x64）。
4. **github-release**（ubuntu，needs 两路全绿）：汇总产物，生成 SHA256SUMS.txt，
   `gh release create --generate-notes` 创建 Release 并附着全部文件。

关注与排障：

```sh
gh run watch                          # 跟踪最新 run
gh run list --workflow=desktop-release.yml   # 查历史
```

- 版本不一致失败 → 本地把家族版本修到 tag 版本（第 1 节），amend/新提交后
  **删除远端 tag 重新推送**（npm 侧会跳过已发布包，无重发风险）。
- npm 部分发布失败（网络、scope 权限、token 过期）→ 脚本已跳过成功包，修好
  后重推同一 tag 会只补发缺的包；**同版本号换代码是禁止的**（npm 不可变），
  换代码必须 bump。token 过期到 repo Settings → Secrets → Actions 更新
  NPM_TOKEN；scope 权限问题找 npm 账号（@dsh-trading scope 的所有者）确认。
- 发出去的坏包（内容错误但版本已占用）→ `npm deprecate` + 下一补丁版本，
  不尝试覆盖。
- prepare-runtime 失败（Node 发行版下载超时、host closure pnpm install 失败）
  → 多为网络抖动，直接重跑 failed jobs；连续失败按 CI 自愈四步归因。
- Windows 上 `spawnSync pnpm ENOENT` → pnpm 是 .cmd shim，spawn 必须带
  shell（build-runtime.mjs 已用平台化 spawnOptions 修复；新增子进程调用时
  记得复用它）。
- electron-builder 打包失败 → 检查 desktop/electron-builder.yml 与
  scripts/after-pack.cjs 的 runtime staging 约定（runtime payload 必须由
  afterPack hook 复制，extraResources 会丢 node_modules）。
- Windows runner 上 pnpm/npm 行为差异 → 检查脚本是否用了 POSIX-only 写法。

## 4. 同 tag 修复重推规则（与 dsh-web 相反）

- 管线失败且 **GitHub Release 尚未创建**：修复后删除远端 tag 重推即可，
  同一版本号可复用：
  `git push origin :refs/tags/vX.Y.Z && git tag -f vX.Y.Z && git push origin vX.Y.Z`
- **GitHub Release 已创建**后发现问题：先 `gh release delete vX.Y.Z --yes`
  再删 tag 重推；产物有实质缺陷且已有用户下载时，发下一个补丁版本并在
  Release notes 说明，而不是静默重推。

- **org mention 误入 Contributors（v0.1.0 实证）**：提交主题里的 `@组织名`（如
  "switch DSH SDK to official npm @deepseek-ai ..."）会在自动 notes 里被链接成
  org mention，GitHub 把它列进 Release 的 Contributors 侧栏（方形 org 头像）。
  发版提交避免在 commit subject 写裸 `@org`；notes 已生成时用
  `gh release edit vX.Y.Z --notes-file` 把误入的 mention 用反引号转义，
  转义后侧栏即消失（v0.1.0 已这样修复）。

## 5. 发布后验证（必须逐项执行）

```sh
npm view @dsh-trading/all version        # 期望 = X.Y.Z
npm view @dsh-trading/base version       # 期望 = X.Y.Z
gh release view "vX.Y.Z" --json assets --jq '.assets[].name'
# 期望资产（7 个）：dsh-trading-desktop-X.Y.Z-mac-{arm64,x64}.{dmg,zip} +
# dsh-trading-desktop-X.Y.Z-win-x64.{exe,zip} + SHA256SUMS.txt
gh release view "vX.Y.Z" --json body --jq .body      # 自动 notes 已生成
gh run list --workflow=desktop-release.yml           # 全部成功
git ls-remote --tags origin | grep "vX.Y.Z"          # tag 已在远端
```

本地抽查安装包（macOS）：下载 dmg 安装后启动，确认托盘/窗口品牌为 DSH
Trading、runtime/host 与 profile-trading 正常加载。

## 6. 纪律

- tag 即版本事实源：先 bump 家族版本、全绿，再打 tag；管线版本校验是最后
  防线，不是唯一防线。
- npm 发布只走管线（tag 触发）；手工 publish 只用于管线事故的定向补发。
  token 只存 GitHub secret，绝不进仓库文件；对话/日志中出现过的 token 用完
  应轮换。
- 发版前必须本地全量门禁通过；桌面改动必须 desktop 内 npm test 也通过。
- 每次非平凡的发版流程/管线变更，同一变更内补 Agent Note
  （.agents/notes/implemented/process/）并更新本 skill。
- 安装包保持未签名是当前约定（internal/local 分发）；引入签名/公证是独立
  决策，须先记 Agent Note。
