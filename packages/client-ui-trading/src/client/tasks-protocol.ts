/**
 * 右侧栏定时任务——协议层：任务记录形状、动作判别联合与线校验。
 *
 * 设计对齐 dsh-web dsh-task-board 的 Host 权威账本语义（浏览器是异步视图，
 * Host 确认后的 snapshot 才是 UI 状态），但按交易侧栏场景裁剪：
 *
 * - 保留：任务记录（标题/prompt/定时规则/钉住三元组/权限确认门）、有界执行
 *   历史、幂等动作信封、revision 快照、5 段 cron。
 * - 裁剪：看板列状态/描述列/归档/续接冻结卡/交接包/浏览器导入——那些是看板
 *   工作流概念；侧栏定时任务的心智模型是「到点自动开新会话跑 prompt」。
 *
 * 安全面与 task-board 同构：所有变更载荷走严格、版本化的判别联合 + 精确键
 * 校验；浏览器不能写 scheduler 独占时间戳或执行结果；协议不接受命令、可执
 * 行路径、shell 文本或任意参数字段。字符串字段全部有上界。
 */

export const TASKS_SCHEMA_VERSION = 1 as const

/** 交易桥上定时任务子路径（挂在 /dshtrading/api 之后）。 */
export const TASKS_API_SUBPATH = '/tasks'

/** 动作载荷上限（对齐 task-board：普通动作 64 KiB）。 */
export const TASKS_ACTION_BYTES_LIMIT = 64 * 1024

/** 任务可钉住的会话权限预设（/permission <id> 的 id 词汇）。 */
export const TASK_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** 单个权限预设 id。 */
export type TaskPermission = (typeof TASK_PERMISSIONS)[number]

/** 未钉住权限时的会话默认（交易宿主保守取 read-only）。 */
export const DEFAULT_SESSION_PERMISSION: TaskPermission = 'read-only'

/** 权限等级比较：高于会话默认的钉住权限必须经人工确认才能运行。 */
export function permissionRank(permission: TaskPermission): number {
  return TASK_PERMISSIONS.indexOf(permission)
}

/** 是否为已知权限预设 id。 */
export function isTaskPermission(value: unknown): value is TaskPermission {
  return typeof value === 'string' && (TASK_PERMISSIONS as readonly string[]).includes(value)
}

/** 单次真实执行尝试：自己的 id、承载它的 dsh 会话、结算结果。 */
export interface ExecutionRecord {
  /** 执行尝试 id（uuid）。 */
  id: string
  /** 承载本次执行的 dsh 会话；会话创建落定前缺省。 */
  sessionId: string | undefined
  /** 启动时刻（ms epoch）。 */
  startedAt: number
  /** 结算时刻；仍在运行时缺省。 */
  endedAt: number | undefined
  /** 结算后的结果。 */
  result: 'succeeded' | 'failed' | 'cancelled' | undefined
  /** 失败时的人类可读原因（prompt 拒绝、agent 出错、启动失败等）。 */
  error: string | undefined
  /** 本次执行的触发来源。 */
  trigger: 'cron' | 'manual'
}

/**
 * 每任务保留的执行历史上限：新执行开始时裁掉最旧的已结算记录，账本体积与
 * 单次写入成本不随历史无限增长。
 */
export const EXECUTION_HISTORY_LIMIT = 20

/**
 * 把执行列表裁剪到至多 {@link EXECUTION_HISTORY_LIMIT} 条，最近的在最后。
 * 未结算（运行中）的执行永不裁剪：Host 监视与重启恢复都依赖活跃记录。
 */
export function retainRecentExecutions(executions: readonly ExecutionRecord[]): ExecutionRecord[] {
  if (executions.length <= EXECUTION_HISTORY_LIMIT) return [...executions]
  const open = executions.filter(execution => execution.endedAt === undefined)
  const settled = executions.filter(execution => execution.endedAt !== undefined)
  const keepSettled = Math.max(EXECUTION_HISTORY_LIMIT - open.length, 0)
  return [...settled.slice(Math.max(settled.length - keepSettled, 0)), ...open]
}

/** 挂在任务上的定时规则；Host 调度器在 nextRunAt 到期时触发。 */
export interface ScheduleRule {
  /** 是否已启用。 */
  enabled: boolean
  /** 5 段 cron：分 时 日 月 周（宿主本地时区）。 */
  cron: string
  /** 下次到期时刻（ms epoch）；由调度器/控制器维护。 */
  nextRunAt: number | undefined
  /** 最近一次定时触发点的时刻（ms epoch）。 */
  lastTriggeredAt: number | undefined
}

/** 一条定时任务。 */
export interface TaskRecord {
  /** 稳定任务 id（uuid）。 */
  id: string
  /** 短标题（会话重命名同款文案）。 */
  title: string
  /** 到点发给新 dsh 会话的 prompt。 */
  prompt: string
  /** 创建时刻（ms epoch）。 */
  createdAt: number
  /** 最近变更时刻（ms epoch）。 */
  updatedAt: number
  /** 执行历史，最近在最后（见 {@link retainRecentExecutions}）。 */
  executions: ExecutionRecord[]
  /** 定时规则；未排期（仅手动运行）时缺省。 */
  schedule?: ScheduleRule
  /** 执行必须落在的工作区（workspace id）；缺省 = 执行时的最近工作区回退。 */
  workspaceId?: string
  /** 执行会话使用的 agent 预设（agentPreset id）；缺省 = 部署默认。 */
  agentPreset?: string
  /** 经 /permission <id> 应用到执行会话的权限预设；缺省 = 会话默认。 */
  permission?: TaskPermission
  /** 高于会话默认权限的人工确认戳（ms epoch）；钉住权限/变更即清除（重新武装确认门）。 */
  permissionConfirmedAt?: number
}

/** 新建任务输入（UI → Host）。 */
export interface NewTaskInput {
  title: string
  prompt: string
  workspaceId?: string
  agentPreset?: string
  permission?: TaskPermission
  /** 创建时可携带的定时规则；enabled 且 cron 合法才武装。 */
  schedule?: { enabled: boolean; cron: string }
}

/** 更新补丁：出现的键才更新；显式 null 清除对应钉住字段。 */
export interface TaskUpdatePatch {
  title?: string
  prompt?: string
  workspaceId?: string | null
  agentPreset?: string | null
  permission?: TaskPermission | null
  schedule?: { enabled: boolean; cron: string }
}

/** 任务是否处于权限确认门待确认状态（定时与手动运行都拒绝）。 */
export function permissionPending(task: TaskRecord, sessionDefaultPermission: TaskPermission): boolean {
  const effective = task.permission ?? sessionDefaultPermission
  return permissionRank(effective) > permissionRank(sessionDefaultPermission)
    && task.permissionConfirmedAt === undefined
}

/** 任务是否还有未结算的执行（同一任务不并发执行）。 */
export function hasOpenExecution(task: TaskRecord): boolean {
  return task.executions.some(execution => execution.endedAt === undefined)
}

/** 调度器快照（Host 独占字段，浏览器只读）。 */
export interface TasksSchedulerSnapshot {
  timeZone: string
  lastTickAt?: number
  error?: string
}

/** 完整 revision 快照：Host 确认后的唯一权威 UI 状态。 */
export interface TasksSnapshot {
  schemaVersion: typeof TASKS_SCHEMA_VERSION
  revision: number
  tasks: TaskRecord[]
  scheduler: TasksSchedulerSnapshot
  /** 确认门比较基准：部署的会话默认权限。 */
  sessionDefaultPermission: TaskPermission
}

export type TasksAction =
  | { kind: 'create'; id: string; input: NewTaskInput }
  | { kind: 'update'; taskId: string; patch: TaskUpdatePatch }
  | { kind: 'delete'; taskId: string }
  | { kind: 'set-schedule'; taskId: string; patch: { enabled?: boolean; cron?: string } }
  | { kind: 'run'; taskId: string }
  | { kind: 'confirm-permission'; taskId: string }

/** 动作信封：requestId 供 Host 侧幂等去重（重启后仍有效）。 */
export interface TasksActionEnvelope {
  requestId: string
  action: TasksAction
}

// ── 线校验（精确键 + 上界；对齐 task-board 协议闸门的风格） ────────────────

export const TITLE_MAX = 200
export const PROMPT_MAX = 64 * 1024
export const PIN_MAX = 200
export const CRON_MAX = 100

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/** undefined 或有界字符串。 */
function optionalBoundedString(value: unknown, max: number): value is string | undefined {
  return value === undefined || boundedString(value, max)
}

/** undefined / null 或有界字符串（补丁语义：null 显式清除钉住字段）。 */
function optionalBoundedStringOrNull(value: unknown, max: number): value is string | null | undefined {
  return value === undefined || value === null || boundedString(value, max)
}

/** undefined 或「有界且非空白」字符串（标题语义）。 */
function optionalBoundedNonEmptyString(value: unknown, max: number): value is string | undefined {
  return value === undefined || (boundedString(value, max) && value.trim() !== '')
}

/** 校验并收敛 schedule 输入；非法返回 undefined。 */
function scheduleInput(value: unknown): { enabled: boolean; cron: string } | undefined {
  const row = record(value)
  if (row === undefined || !exactKeys(row, ['enabled', 'cron'])) return undefined
  if (typeof row.enabled !== 'boolean' || !boundedString(row.cron, CRON_MAX)) return undefined
  return { enabled: row.enabled, cron: row.cron }
}

/** 校验并收敛新建输入；非法返回 undefined（Host 拒绝而不是猜测）。 */
export function parseNewTaskInput(value: unknown): NewTaskInput | undefined {
  const row = record(value)
  if (row === undefined || !exactKeys(row, ['title', 'prompt', 'workspaceId', 'agentPreset', 'permission', 'schedule'])) return undefined
  if (!boundedString(row.title, TITLE_MAX) || row.title.trim() === '') return undefined
  if (!boundedString(row.prompt, PROMPT_MAX)) return undefined
  // 先收窄到局部量再收敛对象：exactOptionalPropertyTypes 下可选属性不接受显式 undefined。
  const workspaceId: unknown = row.workspaceId
  if (!optionalBoundedString(workspaceId, PIN_MAX)) return undefined
  const agentPreset: unknown = row.agentPreset
  if (!optionalBoundedString(agentPreset, PIN_MAX)) return undefined
  const permission: unknown = row.permission
  if (permission !== undefined) {
    if (!isTaskPermission(permission)) return undefined
  }
  const schedule = row.schedule === undefined ? undefined : scheduleInput(row.schedule)
  if (row.schedule !== undefined && schedule === undefined) return undefined
  return {
    title: row.title,
    prompt: row.prompt,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(permission === undefined ? {} : { permission }),
    ...(schedule === undefined ? {} : { schedule }),
  }
}

/** 校验并收敛更新补丁；非法返回 undefined。 */
export function parseTaskUpdatePatch(value: unknown): TaskUpdatePatch | undefined {
  const row = record(value)
  if (row === undefined || !exactKeys(row, ['title', 'prompt', 'workspaceId', 'agentPreset', 'permission', 'schedule'])) return undefined
  const title: unknown = row.title
  if (title !== undefined && !optionalBoundedNonEmptyString(title, TITLE_MAX)) return undefined
  const prompt: unknown = row.prompt
  if (prompt !== undefined && !optionalBoundedString(prompt, PROMPT_MAX)) return undefined
  const workspaceId: unknown = row.workspaceId
  if (!optionalBoundedStringOrNull(workspaceId, PIN_MAX)) return undefined
  const agentPreset: unknown = row.agentPreset
  if (!optionalBoundedStringOrNull(agentPreset, PIN_MAX)) return undefined
  const permission: unknown = row.permission
  if (permission !== undefined && permission !== null) {
    if (!isTaskPermission(permission)) return undefined
  }
  const schedule = row.schedule === undefined ? undefined : scheduleInput(row.schedule)
  if (row.schedule !== undefined && schedule === undefined) return undefined
  return {
    ...(title === undefined ? {} : { title }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(workspaceId === undefined || workspaceId === null ? {} : { workspaceId }),
    ...(agentPreset === undefined || agentPreset === null ? {} : { agentPreset }),
    ...(permission === undefined || permission === null ? {} : { permission }),
    ...(schedule === undefined ? {} : { schedule }),
  }
}

/** 校验动作判别联合；非法返回 undefined。 */
export function parseTasksAction(value: unknown): TasksAction | undefined {
  const row = record(value)
  if (row === undefined || typeof row.kind !== 'string') return undefined
  switch (row.kind) {
    case 'create': {
      if (!exactKeys(row, ['kind', 'id', 'input'])) return undefined
      if (!boundedString(row.id, 64) || row.id === '') return undefined
      const input = parseNewTaskInput(row.input)
      return input === undefined ? undefined : { kind: 'create', id: row.id, input }
    }
    case 'update': {
      if (!exactKeys(row, ['kind', 'taskId', 'patch'])) return undefined
      if (!boundedString(row.taskId, 64) || row.taskId === '') return undefined
      const patch = parseTaskUpdatePatch(row.patch)
      return patch === undefined ? undefined : { kind: 'update', taskId: row.taskId, patch }
    }
    case 'delete':
    case 'run':
    case 'confirm-permission': {
      if (!exactKeys(row, ['kind', 'taskId'])) return undefined
      if (!boundedString(row.taskId, 64) || row.taskId === '') return undefined
      return { kind: row.kind, taskId: row.taskId } as TasksAction
    }
    case 'set-schedule': {
      if (!exactKeys(row, ['kind', 'taskId', 'patch'])) return undefined
      if (!boundedString(row.taskId, 64) || row.taskId === '') return undefined
      const patch = record(row.patch)
      if (patch === undefined || !exactKeys(patch, ['enabled', 'cron'])) return undefined
      if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') return undefined
      if (patch.cron !== undefined && !boundedString(patch.cron, CRON_MAX)) return undefined
      return {
        kind: 'set-schedule',
        taskId: row.taskId,
        patch: {
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.cron === undefined ? {} : { cron: patch.cron }),
        },
      }
    }
    default:
      return undefined
  }
}

/** 校验动作信封；非法返回 undefined。 */
export function parseTasksEnvelope(value: unknown): TasksActionEnvelope | undefined {
  const row = record(value)
  if (row === undefined || !exactKeys(row, ['requestId', 'action'])) return undefined
  if (!boundedString(row.requestId, 64) || row.requestId === '') return undefined
  const action = parseTasksAction(row.action)
  return action === undefined ? undefined : { requestId: row.requestId, action }
}
