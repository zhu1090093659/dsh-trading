# Agent Note: 两处既存问题修复——指标试算超时可注入 + headless 条件禁用 web 依赖行

Status: implemented

## Problem

issue #88 登记的两处与 #86（agent 工具面）无关的既存缺陷，实施 #86 / PR #87 期间实证复现：

1. **Windows CI 必现 flake**：`build-test (windows-latest, 22)` 在 `pnpm -r test` 阶段偶发红，失败点集中在 `packages/indicators/test/chart-activations.test.ts` 与 `test/validate.test.ts`，报错形态 `[indicator_author] Validation failed: 在 short 样例数据上试算执行报错: 指标试算执行超时（超过 100ms）`（另一轮表现为「re-author 后 params.a2 应为 9 实际 7」——同一根因：校验失败令工具提前返回、未重挂，测试只断言 store 状态看不出校验失败）。重跑同一 commit 即绿。
   根因：`packages/indicators/src/validate.ts` 的 `DEFAULT_TIMEOUT_MS = 100` 是 `node:vm` `runInContext(ctx, { timeout })` 的**墙钟**超时。试算本身是 30 根 K 线的纯计算（正常微秒级），100ms 只是死循环熔断线，不是性能阈值；Windows runner 只有 2 vCPU，`pnpm -r test` 全包并行时进程被抢占，合法指标也会越过墙钟线。
2. **`trading-dev`（headless）profile 启动失败**：`DSH_HOME=~/.dsh-trading dsh --profile trading-dev "…"` 直接抛 `dsh: 4 entries did not activate`（session-archive 缺 webServer + workspaceRegistry、im 缺 connection、usage / plugin-manager 缺 webServer）。根因：`466cbe1` 在 `packages/base/cordis.patch.yml` 新增的 4 行 npm 复用插件，其 host 半顶层 `inject` 硬依赖 web 宿主服务；`dsh-headless` 层不挂 Host / HTTP server / Web runtime，没有这些服务 → 行永久 pending → `assertEntriesActivated` 终止启动。原注释「headless 宿主 host 半 webServer 注入挂起无害」与事实相反——真正无害的是走 `ctx.inject(..., cb)` 惰性注入的 client-ui-updater 行。

## Decision

1. **试算超时可注入，默认值不动**：`validate.ts` 导出 `DEFAULT_TRIAL_TIMEOUT_MS = 100`（并把原常量改名为该语义名，附「熔断线非性能阈值」说明）；`validateCustomIndicator` / `validateCustomIndicatorAsync` 增加 `options.trialTimeoutMs`，`validateCustomIndicatorNode` / `createAuthorIndicatorTool` / `createGetIndicatorsTool` 逐层透传。生产默认仍是 100ms 熔断，只有测试注入 5s。
2. **四行按宿主树条件禁用**：`cordis.patch.yml` 的 `dsh-trading-session-archive` / `-im` / `-usage` / `-plugin-manager` 各加 `disabled: !!js (...)`，判定「宿主树里是否存在服务提供方行」——`@deepseek-ai/dsh-host-webserver`（webServer）、`@deepseek-ai/dsh-workspace`（workspaceRegistry）、`@deepseek-ai/dsh-client-connection`（connection）。沿用 `dsh-trading-dynamic-capabilities` 先例（issue #62）；文件头语义从「两层」扩为「三类」，新增「条件禁用行」一节，四行注释同步纠正「挂起无害」的错误表述。

## Alternatives considered

- **把默认超时直接调大（如 1000ms）**：生产端指标创作遇死循环要卡 5 场景 × 1s，且墙钟阈值依旧，负载更高时照样误判——拒绝；把「该可注入的参数」当「该调大的参数」是治标。
- **只在 Windows CI 用环境变量放宽**：`validate.ts` 是浏览器安全模块（零 Node 运行时依赖），引入 `globalThis.process?.env` 守卫会把 CI 环境语义塞进纯函数——拒绝。
- **降低 `pnpm -r test` 并发度**：治标，且拖慢 ubuntu 两个 job——拒绝。
- **给四行补 headless 无害降级实现 / 把 inject 改可选**：要改的是 npm 复用插件的宿主半（`@linxin666/*`、`@xmanrui/*`，非本仓代码）——不可行。
- **直接删掉这四行**：web / 桌面宿主会失去使用统计、插件管理、会话归档、IM 四个功能——拒绝。
- **顺手把 `packages/strategies/src/validate.ts` 同形的 `DEFAULT_TIMEOUT_MS = 100` 一并可注入**：Windows 失败点只在 indicators，无实证；按「只修测试证明的问题」留待有证据时处理（已在下方 Consequences 记为已知同形风险）。

## Consequences

- 实测（本机，2026-09-09）：`DSH_HOME=~/.dsh-trading dsh --profile trading-dev "Reply with exactly: ok"` 无需 `--patch` 返回 `ok`（exit 0）。
- 实测（loader 探针，同一 `!!js` 求值路径，`ctx.loader.entries()` 直读四行有效 `disabled`）：
  - trading-dev 树（123 行，无 webserver / workspace / connection 提供方行）：四行 `disabled=true`。
  - trading-web 隔离副本（197 行，三个提供方行全在）：四行 `disabled=false`——web / 桌面宿主回归不倒退。
- 测试：`packages/indicators` 6 文件 69 用例全绿，新增「trialTimeoutMs 可注入：慢试算默认判超时、放宽后通过（issue #88）」；死循环保护用例仍走默认 100ms 熔断；`pnpm build` 与 `pnpm -r test` 全绿。
- 未改动 profile / 桌面壳 / 已安装实例：验证走独立 `DSH_HOME` 隔离副本（`/private/tmp`，APFS clone + 重指向全局宿主的 cohort 重挂），运行中的桌面实例全程未受影响。隔离副本的**服务器启动路径**在本机 CLI 下会 100% CPU 空转（无日志、不监听端口）——A/B 实证：换回未加 guard 的 origin/main 版本 `cordis.patch.yml` 现象完全相同，故属隔离副本的既有环境现象，与本变更无关；回归结论以 loader 层探针为准。
- 已知同形风险（本次不修）：`packages/strategies/src/validate.ts:43` 与其 Node vm runner 走同一 100ms 墙钟模式，若将来出现同类 Windows flake，按本记录第 1 条同款注入 `trialTimeoutMs` 即可。
