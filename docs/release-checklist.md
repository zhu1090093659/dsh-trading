# 发布前检查清单（release checklist）

> 2026-08-30 架构评审整改 #6。本仓当前是「本机开发形态」（未发布 npm，AGENTS.md：
> 发布需用户显式授权）。本清单是从开发形态切换到可分发形态的**全部闸门**——
> 逐条过完才允许 `pnpm release`（changesets 已配，`@dshtrading/*` fixed 组同族发版）。

## 1. SDK 钉版解除（最硬的闸门）——✅ 已解除（2026-08-30）

> **状态更新（2026-08-30）**：DSH 0.1.2-alpha.2 已发布 npm，本仓 SDK 依赖整体切换到
> 官方 npm cohort（cordis 4.0.2 / cosmokit 1.8.3 / schemastery 3.18.2；PR #13）。
> overrides 全部移除、干净环境 CI 全绿、README 口径已改——本节闸门**已通过**，
> 决策细节见 `.agents/notes/implemented/process/2026-08-30-sdk-upgrade-npm-0.1.2-alpha.2.md`。
> 以下原始清单保留作历史口径。

本仓 `pnpm-workspace.yaml` 的 overrides 把 `@deepseek-ai/*` SDK 钉到本机绝对路径
（`/Users/zcl/code/deepseek-harness/...`）——**任何其他机器都无法 install 本仓**。
发布前必须：

- [x] npm 上 `@deepseek-ai/*` 世代与本仓代码面兼容（~~当前宿主 0.1.2-alpha.1~~
  → npm 0.1.2-alpha.2 cohort 已对齐）；
- [x] 删除本仓 overrides 全部 file:/link: 行（peerDependencies 声明已是正式包名+版本，
  无需改）；
- [x] 在一台**干净环境**（无 /Users/zcl/code/deepseek-harness）`pnpm install &&
  pnpm -r build && pnpm -r test` 全绿（CI 即干净环境实证）；
- [x] README「安装与卸载」节的 file: 钉版口径改写为 npm 版本口径（含 profile
  pnpm-workspace.yaml 范本更新）。

## 2. 功能与合规

- [ ] `pnpm -r build` / `pnpm -r test` 全绿（基线见 README 当前状态节）；
- [ ] trading-web profile 全市场回归（安装/四 preset roster/会话隔离/下单三态闸门/
  设置页/行情桥/布局）—— checklist 见 spikes/acceptance-all/REPORT.md 六项；
- [ ] 数据源 ToS 表（README）逐条复查仍成立（端点可用性、授权口径变化）；
- [ ] `@dshtrading/all` 元 bundle 限制复核：宿主版本是否已支持传递 bundle 展开
  （apps/cli/src/plugin.ts reconcilePlugins），支持则改回「单命令装齐」口径；
- [ ] secrets 审计：全仓 grep 无内置 key/token（凭证一律 BYOK ref，铁律 #3）；
- [ ] license 审计：client bundle 内联 lightweight-charts（Apache-2.0）与 fancy-canvas
  —— 分发物需附带相应 license 文本或 NOTICE（发布物形态定后落实）；
- [ ] 铁律 #5 合规复查：无缓存回传、无再分发；回测本地缓存若已落地，确认不回传
  不共享（2026-08-30 边界精确化口径）。

## 3. 文档与包面

- [ ] 各包 README 的「未实证/备选」标注复查（connector-stooq 等）；
- [ ] docs/ 三手册与实现一致（replication / connector-playbook / exchange-routing）；
- [ ] Agent Notes 活跃树无 proposed 遗留（要么落地要么 rejected）；
- [ ] changeset 为每个有行为变化的包写好发版说明。
