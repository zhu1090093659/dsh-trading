# Agent Note: SDK cohort 升级到 npm @deepseek-ai 0.2.2-rc.1（宿主已在该世代，插件侧追平）

Status: implemented

## Problem

本仓以 peerDependencies 消费官方 `@deepseek-ai/*`，dev 与测试期由 `pnpm-workspace.yaml`
的 overrides 块钉住单一世代。升级前该块停在 `0.2.1-rc.2`，而本机宿主 CLI
（`/usr/local/lib/node_modules/@deepseek-ai/dsh`）已是 `0.2.2-rc.1`——npm 上
`latest`/`next` 两个 dist-tag 都指向它（`alpha` 为 0.2.2-alpha.3，2026-11-04 发布）。
两者不同世代时 profile 里的 `@deepseek-ai/*` 会以实体拷贝与宿主并存两份模块实例，
模块级 identity 随副本分裂（2026-09-01 实测过该类崩溃）。

声明面同源失真：带 prerelease 的比较器只匹配同一 major.minor.patch 三元组，
实测 `satisfies("0.2.2-rc.1", ">=0.2.1-rc.2") === false`。floor 不随 cohort 走，声明即失真。

## Decision

1. **cohort 整块搬移**：`pnpm-workspace.yaml` 的 overrides 钉 70 个 dsh 包到
   `0.2.2-rc.1`，cordis 家族按官方同批口径搬移——cordis `4.0.5→4.1.0`、
   cosmokit `1.8.6→1.9.0`、schemastery `3.18.5→3.19.0`、
   cordis-plugin-loader `1.0.6→1.1.0`、include `1.0.10→1.1.0`、
   timer `1.1.7→1.2.0`、group `1.0.5→1.1.0`；`minimumReleaseAgeExclude` 78 条同步。
   版本依据是 `@deepseek-ai/dsh@0.2.2-rc.1` 的 90 条直接依赖（它声明 cordis `~4.1.0`、
   schemastery `~3.19.0`、loader `~1.1.0`、include `~1.1.0`、timer `~1.2.0`），
   加上 registry 逐包实证：70 个 dsh 包全部存在 `0.2.2-rc.1`，0 个停发。
2. **floor 随 cohort 前移**：57 个 `package.json` 共 195 条声明——peer floor
   `>=0.2.1-rc.2 → >=0.2.2-rc.1`（77 条）、编译期 devDep 精确钉同版本（16 条）、
   cordis `>=4.0.0 → >=4.1.0`（56 条）与 `^4.0.5 → ^4.1.0`（5 条）、
   schemastery `>=3.18.0 → >=3.19.0`（40 条）、cosmokit `>=1.8.6 → >=1.9.0`（1 条）。
3. **Node 下限抬到官方要求**：官方 0.2.2 线把最低 Node.js 提到 24.9，root
   `engines.node` 由 `^22.19.0 || >=24.0.0` 收敛为 `>=24.9.0`。
4. **宿主 floor 面同步**：`desktop/runtime/host/package.json` 的宿主钉版；
   `desktop/runtime/host/pnpm-lock.yaml` 以 `--lockfile-only` 重算（旧版残留 2666 处 → 0，
   新版 2880 处）；`desktop/runtime/host/pnpm-workspace.yaml` 的
   `minimumReleaseAgeExclude` 按已安装 0.2.2-rc.1 宿主闭包整表重建为 330 条；
   `desktop/scripts/build-runtime.mjs` 的 `REGISTRY_DEPENDENCIES` 五包；
   `README.md` 与 `README_zh.md` 的 DSH Baseline 徽章。本仓仍无 `engines.dsh`、
   无 CI mount pin，不凭空新增声明。`desktop/runtime/profile-trading` 的播种清单与锁
   不手改——它由 `build-runtime.mjs` 在打包时重生成，手改会留下 prerelease peer 破口。
5. **源码与测试适配（生产源码零改动）**：0.2.2 把工具执行拆成按 Agent 作用域选择的
   插件，三处测试组合补 `setExecutor(new NativeToolExecutor(ctx))`——只注册工具而没有
   执行器时 `ToolsService.execute` 抛 `ToolExecutorUnavailableError`；`ToolsService.execute`
   只接受批量输入 `{ calls }`，单调用快捷形状不存在，`base` 与 `watchlist` 的
   `output-contract` 契约用例收敛成一条调用的批次后取 `batch.results[0].result`；
   loop 在提示词组装与 pre-step 之前固定本步模型，取不到 provider/model 会直接抛错、
   根本不进 `agent/pre-step` waterfall，`bot-api` 的 `gui-approval` 组合因此补一条
   占位路由（生产宿主总有模型选择，实盘审批闸门语义未变）。

## 兼容性结论

- 类型面：`node scripts/typecheck-gate.mjs` 79 个 tsconfig 总错误数 **354 = 基线 354**，
  逐配置均未超基线——cohort 未引入任何新的类型错误。
- 依赖面：`pnpm install` +83/−78，`pnpm peers check` 报 "No peer dependency issues found"。
- 构建面：`pnpm build` 全绿。
- 行为面：三处真实回归全部落在测试组合，已被上面的适配逐条修掉；`base` 100/100、
  `watchlist` 57/57、`bot-api` 的 `gui-approval` 13/13。
- 官方变更记录取证：`dsh-v0.2.1-rc.3 / rc.4 / rc.5 / v0.2.2-alpha.2 / alpha.3 / v0.2.2-rc.1`
  六个 release 的 release notes。破坏性面集中在「其他变更」小节：Node 24.9 下限、
  工具执行拆成按 Agent 作用域的插件（`tools.resolve/executable` 迁移）、
  session projection 注册改异步、PTC 拆插件与取消改 `ABORTED`、
  `dsh-official-bundles` 接管组合包列表、Cordis Timer 返回值适配。
  本仓对后四项零消费（无 `dsh-app-boot` / `dsh-official-bundles` / session-projection 引用）。

## 官方能力去重（native 为基座）

上一轮把本仓定时任务平面记为 exception，理由是「官方 `schedule_*` 只投递 reminder、
不建会话执行任务」。**这条前提在本 cohort 已被打破**：
`@deepseek-ai/dsh-schedule@0.2.2-rc.1` 的描述改为 "Host-wide durable reminders with shared
management and delivery to existing **or new Sessions**"，并导出 `createCronScheduleRecord` /
`resolveCronOccurrence` / 投递历史 / `deleteInactive` 一整套调度域。

重新比对后的结论是**不是同一产品面，仍保留，但理由改写**：

| native `dsh-schedule` 0.2.2 | 本仓 `packages/bot-api/src/tasks/*` |
|---|---|
| 宿主级提醒调度域：cron/at/every/daily/weekly + occurrence 解析 + 投递历史 | 6 个 agent 工具（`tasks_list/meta/create/update/delete/run`）+ 右侧栏面板 |
| **零 agent 工具**（`defineTool` 命中 0，纯服务 + UI 页） | 工具面是本仓的全部对外通路 |
| 无审批闸门 | 人类唯一确认闸门（`TASKS_PERMISSION_PENDING`，confirm-permission 不注册工具） |
| 无请求幂等 | requestId 幂等账本（同 id 同指纹缓存命中，异指纹 `TASKS_REQUEST_CONFLICT`） |

真正重复的只剩 **cron occurrence 引擎**：本仓 `packages/api` 自带
`parseCron` / `nextRunAtMs` / `isValidCron`（`tasks-schedule.ts`），与 native
`parseCronInput` / `resolveCronOccurrence` 同职。去掉它要把 `@dshtrading/api`
改挂宿主调度服务，属跨包责任迁移且会波及私有卫星仓 dsh-trading-bot 的消费面，
本轮不做，记为待办而非已完成——不是「无重复」，是「重复面已收窄到一处且已知」。

## 验收状态（如实）

`pnpm gates:all` 17 条门禁 **14 通过 / 3 失败**（升级前基线是 11 通过 / 6 失败）：

- 本轮修掉的 3 条：`home-guard:check`（`scripts/home-guard-check.mjs` 的 `walk()` 对每个条目
  无条件 `statSync`，撞上 `desktop/resources/runtime` 里未跟踪构建产物的断链软链就
  ENOENT 崩——改为 `throwIfNoEntry: false` 跳过取不到 stat 的条目）、
  `test:scripts`（它 `--only` 真跑 `home-guard:check`，是该红的级联）、
  `typecheck-gate`（7 个新 `tsconfig.host.json` 未登记基线，`--update` 纳入）。
- 剩余 3 条全部是**与 cohort 无关的环境阻塞**：`-r test` 只红在 `packages/authority`
  的 7 个 uid 隔离用例（`plane-not-isolated`：非 root 单 uid 无法构造"平面归另一个 uid"）；
  `coverage:check` 只因该包跑不出报告而判"未验证"（本轮补齐 base/bot-api/watchlist 三包
  报告后，"指标低于基线"的告警消失——此前的跌幅是分母被剔除造成的假象）；
  `test:desktop` 红在播种 profile 的 vendor fixture 解析（`fixture-alpha-1.0.0.tgz` 不存在）。
  三条在升级前的 `6984af68` 上同样红。
