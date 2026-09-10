# Agent Note: SDK cohort 升级官方 NPM 0.1.5-rc.1（宿主 CLI + dev cohort + desktop runtime + profile 全家验收）

Status: implemented

## Problem

官方 `@deepseek-ai` SDK 于 2026-09-10T03:12Z 发布 `0.1.5-rc.1`（npm `next`
tag；`latest` 仍为 `0.1.2-rc.1`，`alpha` 为 `0.1.5-alpha.2`）。本仓 dev
cohort overrides 钉 `0.1.5-alpha.2`、宿主 CLI 为 `0.1.5-alpha.2`、桌面壳自带
runtime 为 `0.1.5-alpha.2`。owner 指令：升级到 0.1.5-rc.1 并适配（沿用
2026-09-09 alpha.2 轮的决策门范围：宿主 CLI 与桌面壳随本轮升级）。

## Decision

1. **根 overrides 整块搬移**：53 项 `@deepseek-ai/dsh-*` 精确钉
   `0.1.5-rc.1`。`minimumReleaseAgeExclude` 的 dsh 条目同步搬移；
   cordis@4.0.2 / cosmokit@1.8.3 / schemastery@3.18.2 /
   plugin-include@1.0.7 / plugin-loader@1.0.3 在 rc.1 世代无新版本，保持
   不动（经 rc.1 宿主闭包核实）；本轮 pnpm 无需自动补录新包（rc.1 无
   alpha.2 之外的新家族成员）。
2. **floor 随 cohort 移动**：全部 packages/*/package.json 的 peer floor
   `>=0.1.5-alpha.2` → `>=0.1.5-rc.1`；devDeps 精确钉统一 rc.1。
3. **README/README_zh** DSH Baseline 徽章 → `0.1.5-rc.1`。本仓无
   `dsh.engines.dsh` floor、无 CI mount pin（workflows 仅
   ci.yml/desktop-release.yml，无宿主版本字面量），与上轮核实一致。
4. **desktop 宿主闭包**：`desktop/runtime/host/package.json` 钉 rc.1，
   其 pnpm-workspace.yaml 的 exclude 全量搬移；
   `build-runtime.mjs` 的 search-exa pin → rc.1。lockfile **从零重解析**。
5. **宿主 CLI**：`npm i -g @deepseek-ai/dsh@0.1.5-rc.1`（闭包 521 包换新；
   `~/.local/bin/dsh` → `/opt/homebrew/bin/dsh` symlink 链不受影响）。
6. **desktop runtime 全量重建 + 重装**：`pnpm prepare-runtime`（host 闭包 +
   profile-trading vendor tarball 均落 rc.1，assertHostCohort 普查门禁）→
   `pnpm dist:mac` → ditto 替换 `/Applications/DSH Trading.app`（先
   osascript 优雅退出）。
7. **profile 全家验收**：`refresh-trading-web-profile.sh`（重装 + 核心包
   symlink 归一 CLI 宿主）+ `profile-cohort-check.sh`（DSH_HOME=~/.dsh-trading）
   + `pnpm ui:check` 交互级门禁。

## 兼容性（compatibility handoff 结论）

- **导出面 diff 为零**：worktree 内对 58 个被消费的 `@deepseek-ai/*` 包做
  alpha.2 vs rc.1 顶层导出符号 diff（`lib/**/*.d.{c,m}ts` 的 export
  class/function/const/interface/type/enum 清单），零增删——rc.1 是
  alpha.2 之后的保守修复型候选，无 API 面变化。
- typecheck 棘轮 481=481（基线持平，无新类型错误）；**本轮零源码适配**
  （上轮的 `addImages`→`addAttachments` 改名在 alpha.2 已完成）。

## 新坑：pnpm minimumReleaseAge 供应链策略拒绝原地刷新锁文件

`pnpm install` 在旧 lockfile 上原地刷新时被
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 拒绝：旧 lockfile 的 alpha.2 条目
原本靠 exclude 放行，搬移 exclude 后这些条目失去豁免、又仍在 24h 冷却期内
（alpha.2 发布于 2026-09-09T14:41Z，安装时点 2026-09-10 午后），策略直接
判死。pnpm 官方建议即「重建全新 resolution」——2026-09-09 desktop 混代闪退
教训（原地刷新 ≠ cohort 迁移）在根仓也被工具链强制化了。根 lockfile 与
desktop runtime/host lockfile 均从零重解析。

另踩 `ERR_PNPM_CACHE_MISSING_AFTER_304`（pnpm 11.9.0 元数据缓存损坏，
304 Not Modified 后读不到缓存体）：清 `~/Library/Caches/pnpm/v11/metadata`
与 `metadata-full` 后恢复；清 store 目录无效（packument 缓存在 Caches 不在
store）。

## 验证

- worktree 内 CI 级门禁（与 .github/workflows/ci.yml 同清单）：
  `pnpm install --frozen-lockfile --ignore-scripts` ✓ → `pnpm -r build` ✓ →
  `node scripts/typecheck-gate.mjs` 棘轮 481=481 ✓ → `pnpm i18n:check` ✓ →
  `pnpm test` 1394 passed / 2 skipped / 0 failed ✓。
- 锁文件终态：root lockfile 1026 处 rc.1、0 处 alpha 残留；desktop
  runtime/host lockfile 2164 处 rc.1、0 alpha、0 旧代残留；clean-slate 安装
  后闭包普查 230 个 dsh-* 全部 rc.1（assertHostCohort 同款逻辑）。
- 宿主 CLI：npm i -g 后闭包 230 个 dsh-* 全 rc.1；dsh web 实例重启后端口
  监听 + 未认证 API 401 栅栏正常。
- profile 验收与 ui:check / 冒烟证据见交付报告（本轮执行记录）。

## 教训 / 备注

- **pnpm 11.9 的 minimumReleaseAge 策略把「cohort 迁移必须 clean-slate」
  从纪律升级为硬约束**：含未到期版本的旧 lockfile 原地刷新会被直接拒绝，
  不会再静默保留旧代条目（好事）；遇到该报错不要想办法豁免旧条目，直接删
  lockfile 重解析。
- **packument 元数据缓存位置**：`~/Library/Caches/pnpm/v11/metadata*`，
  不在 store 内；304 缓存类故障先清这里。
- 其余纪律（desktop 闭包 clean-slate、profile file: 依赖复制在 build 之后、
  cohort check 脚本需显式 `DSH_HOME=~/.dsh-trading`、桌面壳「最后启动者」
  归一语义）与 2026-09-09 轮一致，全部继续适用。
