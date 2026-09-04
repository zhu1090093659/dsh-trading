# Agent Note: 定时任务 Agent 工具面（tasks_list/meta/create/update/delete/run）

Status: implemented

## Problem

右侧栏定时任务（[2026-09-04-sidebar-scheduled-tasks](./2026-09-04-sidebar-scheduled-tasks.md)）只有浏览器 HTTP 通路（`/dshtrading/api/tasks{,/meta,/action}`），没有注册任何 agent 工具——对比 knowledge/行情面均有 `ctx.tools` 注册。2026-09-04 实测 agent 侧现状：无凭证 curl `GET /dshtrading/api/tasks` → 401；URL `?token=` 仅首页换票一次且为进程内存随机值（宿主重启即失效）；唯一可行路径是借已鉴权浏览器上下文回放（用遗留自动化 Chrome profile 实测拿到 revision 97 活快照）——能通但绕、且依赖 cookie 寿命。agent 要创建/巡检/手动触发定时任务（如「把明早盘前分析挂成任务」），每次都要用户手工在 UI 点，或走这条脆弱的浏览器借道。

## Decision

**在 `@dshtrading/client-ui-trading` 单包内为 `TradingTasksService` 动作面注册 6 个 host 平面 agent 工具**（`src/tasks/tools.ts`，进程内直调，不动包结构、不加 base patch 行、不改 `@dshtrading/api` 公共契约）：

- **注册位置与生命周期**：web 宿主闭包（`ctx.inject(['webServer','connection'])`）内 service 构造成功后 `registerTasksTools(ctx, tasks)`——服务存在 = 工具存在；headless 宿主服务本就不构造，工具随之缺席，账本锁竞争面不扩大。注册走 `ctx.inject(['tools'])` + `tools.get(name) === undefined` 去重护栏（knowledge/plugin 同款）；账本锁被他宿主持有时构造失败（既有 try/catch）→ 工具不注册 + 路由 503 降级不变。`@deepseek-ai/dsh-tools` 以 peerDependency `>=0.1.2-rc.1` 声明（connector-yahoo 同款）。
- **工具面（动词薄工具）**：`tasks_list`（快照）、`tasks_meta`（工作区/agent 预设名册 + 确认门基准）、`tasks_create`（cron 缺省 = 仅手动，提供即武装；可选显式 `taskId`）、`tasks_update`（`patchJson` 承载 `TaskUpdatePatch`，钉住字段显式 null 清除）、`tasks_delete`、`tasks_run`（手动起跑）。工具只做参数 → 版本化动作联合的机械翻译，校验真相仍是 `client/tasks-protocol.ts`（`parseTasksEnvelope` 精确键 + 上界 + 权限词汇）与 ledger 语义闸门（存在性/并发/cron 合法性/权限门）。
- **`confirm-permission` 不注册工具**：确认门保持人类唯一通路（右侧栏 UI）；agent 建了钉住高于会话默认权限（默认 `read-only`）的任务 → 落待确认态，服务既有闸门同时拒绝 cron 与手动 run（`TASKS_PERMISSION_PENDING`），工具流程是 `tasks_list` 读到待确认 → 提示用户去 UI 确认。工具层零新增闸门代码。
- **错误面**：`TaskActionError` → `{ ok:false, code, message }` JSON（预期协议错误不抛，模型可读 10 个稳定码自纠）；意外内部错误原样上抛。工具侧入参越界收敛为 `TASKS_ACTION_INVALID`，坏 JSON 补丁收敛为 `TASKS_PATCH_INVALID`。
- **幂等**：requestId 工具生成或透传（同键同指纹 → 账本缓存命中不重复应用，异指纹 → `TASKS_REQUEST_CONFLICT`）；create 的显式 `taskId` 重试得 `TASKS_ID_EXISTS`——可辨识、不重复建。
- **SSE 复用**：写入走 `service.apply`，`onEvent → emit('tasks')` 自动接线，UI 即时刷新。
- **顺带修复（同变更）**：`parseTaskUpdatePatch` 此前把显式 null 从补丁里丢弃，而 `ledger.applyPatch` 以 null 为清除信号、UI 编辑器也发 null——钉住字段（工作区/agent 预设/权限）的清除在 HTTP 桥路径被静默吞掉（回归实证：UI 发 `permission: null` 后任务仍钉住）。修复为 null 原样保留（语义对齐协议注释与 applyPatch），并在工具测试里立回归用例。

## Alternatives considered

- **单一 `tasks_apply(actionJson)` 万能工具**：工具数最少、协议零重复，但 agent 可发现性差、六个动作形状挤进一个 description，update 的 null 清除与 create 常用面混在同一 JSON 串里，模型出错率高于显式动词。败，选动词薄工具。
- **抽独立 `@dshtrading/tasks` 能力包 + base patch 行（knowledge 模式）**：单主人场景（消费方仅 client-ui-trading）下纯搬家成本，无第二个复用方。败，留待出现第二个消费方时再做。
- **hoist 到 host 平面全宿主注册（headless 也可用）**：一次性 headless profile（spike-runner 等）会抢账本锁 + 空转调度器，锁竞争面从 web 宿主扩大到全 cohort，且 S4 spike 已实证一次性进程里调度无意义。败，保持 web 宿主专属。
- **维持 HTTP-only 现状**：鉴权摩擦已实证（token 进程内存、重启失效、无凭证 401），agent 每次都要借浏览器上下文。败，本记录即为此而立。

## Consequences

- agent 会话内可直接 `tasks_create` 挂任务、`tasks_list` 巡检、`tasks_run` 手动触发；钉住值先 `tasks_meta` 查名册。执行消耗 API 额度的语义不变（每轮真实会话），确认门兜底不变。
- 门禁实证：包内 vitest 210 用例全绿（新增 10：工具形状/映射/错误码收敛/幂等/确认门不可达/null 清除回归/注册去重），全仓 `pnpm build` 52 包全绿、`pnpm test` 942 用例全绿，`pnpm install --frozen-lockfile` 通过（lockfile 仅新增 peer 依赖一条），`codegraph sync` 后索引 up to date。
- 待办（标准交付步）：trading-web profile 刷新副本 + 重启实例后，在真机会话做一次冒烟（`tasks_create` → 右侧栏 SSE 即现 → `tasks_run` 全链路）。实例运行中禁止 `dsh plugin install`，需与用户协调窗口。
- 多宿主并发（桌面壳 + trading-web 同机同跑）：后启动方账本面降级 503、工具缺席——agent 视角是「没有 tasks_* 工具」而非报错，需如实说明。
- 风险与缓解（继承自提案评审）：高频 cron 滥用靠工具 description 纪律（每轮真实会话耗额度），必要时后续在账本加每任务最小间隔门（独立小变更）；任务数膨胀时 `tasks_list` 全量输出线性增长，个位数可忽略，膨胀再加分页/过滤；动词薄映射的漂移由映射单测钉住。
