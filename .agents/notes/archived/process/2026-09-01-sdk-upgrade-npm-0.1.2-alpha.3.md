# Agent Note: SDK 依赖对齐官方 NPM 0.1.2-alpha.3 世代

Archived: 2026-09-04
Status: implemented

## Problem

dsh-web 已于 82c033ff4 把官方 SDK cohort 升到 0.1.2-alpha.3（npm `alpha` dist-tag，
2026-08-31T16:20Z 发布），宿主 `dsh` CLI 同步升到 0.1.2-alpha.3 并完成双宿主重启。
dsh-trading 的 root devDeps（编译期类型面）还钉在 `^0.1.2-alpha.2`、lockfile 解析
alpha.2，与 dsh-web / 宿主的 cohort 不一致。

## Decision

1. root devDeps `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-tools` → `^0.1.2-alpha.3`
   （编译期类型对齐；本仓未消费 alpha.3 新增面）。
2. `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 全量 alpha.2 → alpha.3（与
   dsh-web 清单一致，仅钉本 cohort 版本）；注释同步到 alpha.3 世代。
3. packages/* 的 runtime peer 保持 `>=0.1.2-alpha.1` 不变——宿主 alpha.3 天然满足，
   「SDK 不得领先宿主」原则不受影响；如后续需要收紧再单独处理。
4. lockfile 随 install 重解析到 alpha.3（skill/tools 两条边）。

## Consequences

- CI 基线全绿：`pnpm build` exit 0（19+ 包）、`pnpm test` 483 passed + 2 skipped、
  0 失败（含工作区内另一任务未提交的 client-ui-trading 改动一并通过）。
- 无源码适配：alpha.3 公开面变化（api-session-controller 增量 `mode`/`placement`/
  `loadThrough`、subagent 图片准入与 `subagent/attachment-invalid` 错误码更名、
  client-ui-primitives 视口高亮重做、client-ui-conversation 视图惰性创建与
  `openView`/`selectView`）在 dsh-trading 无消费者，build+test 直接通过。
- 宿主实测（Playwright 无头探针 + 截图）：trading-web 3081 工作台完整渲染、0 控制台
  错误；web 3080 的 3 项控制台错误全部归因为宿主内部访问器（`remote.session`
  pageerror 位于宿主自带 assets）、doctor 插件文档化降级（SUPERVISOR 503）与
  skin-center 设计内静态兜底（whale-song hooks 403），与 dsh-trading 无关。
- 变更面：root `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、本 note。
  另一任务的未提交文件（client-ui-trading src/test 与两份 bug-fix note）未纳入本提交。
