# Agent Note: 定时任务默认改大师模式 + workspace-write 权限

Status: implemented

## Problem

右侧栏「定时任务」（含 agent 工具面 tasks_*）新建任务时未钉住三元组走两级保守缺省：agent 预设落「部署默认」（实际为 trader），权限不落盘——runner 只对钉住权限执行 `/permission`，缺省会话回退宿主默认 read-only。结果：定时任务默认既不是用户想要的大师模式，也没有写入权限，每日自动化任务（盘前分析、持仓盘点等）频繁因只读会话无法落盘产出。

## Decision

缺省语义整体前移到**创建时落盘**（`ledger.taskFromInput`），三条常量都在 `client/tasks-protocol.ts`：

- `DEFAULT_TASK_AGENT_PRESET = 'master'`：新建任务未钉住 agentPreset 时落 `master`（大师），UI/工具/HTTP 三个入口统一覆盖。
- `DEFAULT_TASK_PERMISSION = 'workspace-write'`：未钉住权限时落 `workspace-write`。**必须钉住落盘**——只有钉住权限 runner 才会在 launch 时对执行会话执行 `/permission workspace-write`，不落盘则静默回退宿主默认（read-only），拿不到写入。
- `DEFAULT_SESSION_PERMISSION = 'workspace-write'`（原 `read-only`）：确认门基准随之从 read-only 放宽到 workspace-write。否则创建即钉住的 workspace-write 高于基准，每条新任务都卡权限待确认，违背默认可用写权限的本意。`danger-full-access` 仍高于基准，提权依然走右侧栏人工确认门（安全语义零放宽）。

UI 编辑器新建表单默认选中 master / workspace-write（所见即所存，与账本缺省一致）；编辑既有任务仍显示其存储值，未钉住字段照旧显示「跟随默认」。兼容性：存量任务不回填——老任务（无钉住）在新基准下不再触发确认门，但运行时行为不变（launch 不执行 /permission，仍宿主默认），不做静默提权。

## Alternatives considered

- **只在 UI 表单给缺省选中、账本不落盘**：agent 工具面（tasks_create）与 HTTP 直连入口不经过 UI，缺省不生效；两套缺省必然漂移。选账本（Host 权威写路径）单点落缺省。
- **launch 时兜底 `task.permission ?? DEFAULT_TASK_PERMISSION`**：会静默改变存量任务的运行时权限（老任务突然获得写入），且 UI 显示「跟随会话默认」与实际行为不一致。选创建时落盘，存量不回填。
- **保持基准 read-only、仅创建时钉 workspace-write**：每条新任务创建即「权限待确认」，需人工点确认才能跑——与本变更目的直接冲突。基准必须同步放宽。

## Consequences

- 新建定时任务开箱即大师模式 + 写入权限，无需手动选预设/权限，也不触发确认门；显式钉 `danger-full-access` 的确认门语义不变。
- master 预设在 dsh-trading 部署恒在（base presets），但 runner 对钉住预设做名册校验——若某部署缺 master，执行以 `agent preset not found: master` 失败，错误面可读。
- launch 路径现在对默认任务执行 `/permission`，宿主 commands 服务从「钉权限才用」变成常规依赖（web 宿主核心服务，缺席时 launch 报 `permission command dispatcher (commands) is unavailable`，结算 failed，错误面可读）。
- 测试：4 个任务测试文件随语义更新（门测试改用 danger-full-access 触发、假网关补 agentPresets 名册、假 commands 派发面），新增创建缺省断言（ledger/tools 两层）。门禁 `pnpm build` / `pnpm test`（1208 绿）/ typecheck 棘轮（484==基线）全绿；`service-wiring.test.ts` 首轮全量并发跑出现一次与本地活宿主持锁竞态的无关 flake，隔离与复跑均绿。
- 生效条件：宿主重启/重载加载新包产物；trading-web profile 验证前需按流程刷新 file: 副本。
