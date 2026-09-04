# Agent Note: trading-web profile 内嵌 0.1.2-alpha.2 影子拷贝清理（cohort check 5 项 FAIL）

Archived: 2026-09-04
Status: implemented

## Problem

2026-09-02 例行 `profile-cohort-check.sh`（dsh-sdk-upgrade skill）对 trading-web profile 报 5 项 FAIL（exit 1）：
`@dsh-trading/router/lib/node_modules/.pnpm/` 内嵌的 `dsh-llm`、`dsh-scope`、`dsh-timeout`、
`dsh-typert-protocol`、`dsh-util-crypto` 实体拷贝停留在 **0.1.2-alpha.2**，与宿主
CLI（0.1.2-alpha.3）版本错位——即 2026-09-01 `reading 'prepare'` 事故的同类
（模块级状态/Symbol 跨拷贝互不相认），只是这次藏在 router 构建产物的嵌套
node_modules 里。另有 3 项 WARN：`dsh-settings`、`dsh-skill`、`dsh-tool-cordis`
同版（alpha.3）实体拷贝，下个宿主补丁就会升级成同型 FAIL。

### 根因（两层）

1. **仓库 lockfile 混代**：`pnpm-lock.yaml` 中这五个包（autoInstallPeers 物化的
   peer 传递集）仍解析到 alpha.2（dsh-llm ×21、dsh-scope ×65、dsh-timeout ×7、
   dsh-typert-protocol ×2、dsh-util-crypto ×2 条目）。2026-09-01 的 alpha.3 升级
   只 bump 了直接声明的包；`>=0.1.2-alpha.1` 浮动区间 + pnpm install 保留既有
   解析，使旧代次条目原样存留。
2. **产物携带**：`packages/router/lib/node_modules/.pnpm/` 构建产物把这些 alpha.2
   拷贝打进 lib；`dsh plugin --profile trading-web install` 每次刷新都会把
   alpha.2 嵌套拷贝重新物化进 profile，脚本原有的 CORE_PKGS（7 个包）覆盖不到。

## Decision

- **本次**：扩充 `scripts/refresh-trading-web-profile.sh` 的 CORE_PKGS symlink 归一
  集（+8：上述 5 个 FAIL 包 + 3 个 WARN 包），按文档流程重建 + 刷新 profile。
  symlink 归一后嵌套路径上无论物化出什么版本，运行期都指向宿主单一实例，
  消除整类风险，且不触碰 lockfile。
- **顺延**：仓库 lockfile 的五包 alpha.2 → alpha.3 重解析（`pnpm dedupe` 类操作）
  不在本次做——属依赖图变异，按 dsh-sdk-upgrade 规范应走隔离 worktree，
  与下一次 cohort 升级（npm 已有 0.1.2-alpha.4，2026-09-01 发布）合并处理。

## Evidence

- 修复前：`profile-cohort-check.sh` → 5 FAIL / 4 WARN，exit 1。
- `pnpm build` 全绿 → `refresh-trading-web-profile.sh`（15 条 symlink 落地，
  含 5 条 alpha.2 嵌套路径）→ 复检 trading-web 全 OK，无 FAIL，exit 0。
- 实例冒烟（`dsh --profile trading-web --port 3081`）：
  - 认证栅栏：未认证请求 401（DSH_CHECK_PORT 探针）。
  - 工具调用面（`reading 'prepare'` 崩溃类）：GUI 新消息触发 Bash 工具调用，
    8 秒返回 `smoke-cohort-ok-20260902` 原样输出，无崩溃。
  - UI 面：自选行情行、TradingView 图表、指标面板、大盘指数条全部实时更新。
- 会话持久化：重启后既有会话（641 条 compact 历史）完整加载。

## Follow-ups

1. npm `alpha` dist-tag 已有 **0.1.2-alpha.4**（2026-09-01T16:01Z 发布，cordis
   ^4.0.2 / schemastery ^3.18.2 不变）。升级属宿主先行决策（SDK 不得领先宿主），
   待 owner 裁决；届时顺带 lockfile dedupe 消除五包混代，并同步
   minimumReleaseAgeExclude 至新 cohort。
2. 5 个非本仓 profile（headless、spike-runner、spike-s2、trading-all、trading-dev）
   的 `dsh-headless` symlink 仍指向已弃用的 /Users/zcl/code/deepseek-harness
   checkout（WARN 级），可能是 spike 期故意钉源码，未动，待 owner 确认后归一。
