/**
 * 右侧栏定时任务——Host 权威文件账本。
 *
 * 职责对齐 dsh-web dsh-task-board 的 host-ledger：浏览器/桥动作只有经本账本
 * 确认后才成为 UI 状态；串行动作 + 临时文件原子 rename 持久化；requestId 幂
 * 等（重启后仍去重）；执行历史有界。按交易场景裁剪：无看板列/归档/迁移代际，
 * 换来一个可读的小文件。
 *
 * 并发安全：同一 `$DSH_HOME` 可能同时跑多个宿主进程（桌面壳 + trading-web
 * profile），账本目录锁保证单写者——第二把锁失败关闭并报出持有者 pid（移植
 * task-board 的 pid 探活 + 僵尸态豁免）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SESSION_PERMISSION,
  hasOpenExecution,
  permissionPending,
  retainRecentExecutions,
  TASKS_SCHEMA_VERSION,
  type ExecutionRecord,
  type NewTaskInput,
  type ScheduleRule,
  type TaskPermission,
  type TaskRecord,
  type TasksAction,
  type TasksActionEnvelope,
  type TasksSchedulerSnapshot,
  type TasksSnapshot,
  type TaskUpdatePatch,
} from './protocol.ts'
import { isValidCron, nextRunAtMs } from './schedule.ts'

/** 账本磁盘文档形状。 */
interface LedgerDocument {
  schemaVersion: typeof TASKS_SCHEMA_VERSION
  revision: number
  tasks: TaskRecord[]
  scheduler: TasksSchedulerSnapshot
  recentRequests: Array<{ requestId: string; fingerprint: string }>
}

/** 幂等缓存容量（对齐 task-board：256 条，随账本持久化）。 */
const MAX_REQUEST_CACHE = 256

/** 业务拒绝（HTTP 映射由桥层完成）。 */
export class TaskActionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'TaskActionError'
  }
}

/** 账本目录被另一个活宿主持有。 */
export class LedgerLockedError extends Error {
  constructor(readonly holderPid: number, lockPath: string) {
    super(`task ledger is locked by another live host process (pid ${holderPid}): ${lockPath}`)
    this.name = 'LedgerLockedError'
  }
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
}

function cloneTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  return JSON.parse(JSON.stringify(tasks)) as TaskRecord[]
}

function fingerprintOf(action: TasksAction): string {
  return createHash('sha256').update(JSON.stringify(action), 'utf8').digest('hex')
}

/**
 * 进程是否存活。`process.kill(pid, 0)` 对僵尸态（Z/X，已死未收尸）也报活，
 * 崩溃残留的锁会被误判为活锁——POSIX 下补一次进程态探针。
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform === 'win32') return true
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const end = stat.lastIndexOf(')')
      const state = end === -1 ? '' : (stat.slice(end + 2).split(' ')[0] ?? '')
      return state !== 'Z' && state !== 'X'
    } catch {
      return false // /proc 无此进程 = 已死
    }
  }
  try {
    const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { timeout: 2_000 })
    if (probe.status !== 0 || probe.stdout.length === 0) return false
    const state = probe.stdout.toString('utf8').trim()
    return state !== 'Z' && state !== 'X'
  } catch {
    return true // 探针不可用时保守认为活（宁可误拒不可双写）
  }
}

/** 武装定时规则：启用且表达式合法 → 计算下次运行；禁用 → 保留表达式、清到期。 */
function armSchedule(rule: { enabled: boolean; cron: string }, now: number): ScheduleRule | undefined {
  if (!rule.enabled) {
    return { enabled: false, cron: rule.cron, nextRunAt: undefined, lastTriggeredAt: undefined }
  }
  if (!isValidCron(rule.cron)) {
    throw new TaskActionError(400, 'TASKS_CRON_INVALID', `invalid cron expression: ${rule.cron}`)
  }
  return { enabled: true, cron: rule.cron, nextRunAt: nextRunAtMs(rule.cron, now), lastTriggeredAt: undefined }
}

/** 由新建输入落一条任务记录（id/时间戳由账本盖）。 */
function taskFromInput(id: string, input: NewTaskInput, now: number): TaskRecord {
  return {
    id,
    title: input.title.trim(),
    prompt: input.prompt,
    createdAt: now,
    updatedAt: now,
    executions: [],
    ...(input.schedule?.enabled === true ? { schedule: armSchedule(input.schedule, now) } : {}),
    ...(input.workspaceId === undefined || input.workspaceId === '' ? {} : { workspaceId: input.workspaceId }),
    ...(input.agentPreset === undefined || input.agentPreset === '' ? {} : { agentPreset: input.agentPreset }),
    ...(input.permission === undefined ? {} : { permission: input.permission }),
  }
}

/** 磁盘行归一化：丢弃非法形状的行（带告警），不让单个坏行毒化整本账本。 */
function normalizeTask(value: unknown, warnings: string[]): TaskRecord | undefined {
  const row = value as Record<string, unknown>
  if (typeof row?.id !== 'string' || typeof row?.title !== 'string' || typeof row?.prompt !== 'string'
    || typeof row?.createdAt !== 'number' || typeof row?.updatedAt !== 'number' || !Array.isArray(row?.executions)) {
    warnings.push('dropped malformed task row')
    return undefined
  }
  const scheduleRow = row.schedule as Record<string, unknown> | undefined
  let schedule: ScheduleRule | undefined
  if (scheduleRow !== undefined && typeof scheduleRow === 'object') {
    if (typeof scheduleRow.enabled === 'boolean' && typeof scheduleRow.cron === 'string' && isValidCron(scheduleRow.cron)) {
      schedule = {
        enabled: scheduleRow.enabled,
        cron: scheduleRow.cron,
        nextRunAt: typeof scheduleRow.nextRunAt === 'number' ? scheduleRow.nextRunAt : undefined,
        lastTriggeredAt: typeof scheduleRow.lastTriggeredAt === 'number' ? scheduleRow.lastTriggeredAt : undefined,
      }
    } else {
      warnings.push('dropped invalid schedule on task ' + String(row.id))
    }
  }
  const executions = (row.executions as unknown[]).filter((item): item is ExecutionRecord => {
    const execution = item as Record<string, unknown>
    return typeof execution?.id === 'string' && typeof execution?.startedAt === 'number'
  })
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    executions,
    ...(schedule === undefined ? {} : { schedule }),
    ...(typeof row.workspaceId === 'string' ? { workspaceId: row.workspaceId } : {}),
    ...(typeof row.agentPreset === 'string' ? { agentPreset: row.agentPreset } : {}),
    ...((typeof row.permission === 'string') ? { permission: row.permission as TaskPermission } : {}),
    ...(typeof row.permissionConfirmedAt === 'number' ? { permissionConfirmedAt: row.permissionConfirmedAt } : {}),
  }
}

/** 应用更新补丁（纯段）：返回新任务或 undefined（任务不存在）。 */
function applyPatch(task: TaskRecord, patch: TaskUpdatePatch, now: number, sessionDefaultPermission: TaskPermission): TaskRecord {
  const next: TaskRecord = { ...task, updatedAt: now }
  if (patch.title !== undefined) next.title = patch.title.trim()
  if (patch.prompt !== undefined) next.prompt = patch.prompt
  if (patch.workspaceId !== undefined) {
    if (patch.workspaceId === null || patch.workspaceId === '') delete next.workspaceId
    else next.workspaceId = patch.workspaceId
  }
  if (patch.agentPreset !== undefined) {
    if (patch.agentPreset === null || patch.agentPreset === '') delete next.agentPreset
    else next.agentPreset = patch.agentPreset
  }
  if (patch.permission !== undefined) {
    if (patch.permission === null) delete next.permission
    else next.permission = patch.permission
    // 确认门重新武装：绑定变了，旧确认作废（封死先确认后替换的提权路径）。
    if (patch.permission !== task.permission) delete next.permissionConfirmedAt
  }
  if (patch.schedule !== undefined) {
    const armed = armSchedule(patch.schedule, now)
    if (armed === undefined) delete next.schedule
    else next.schedule = armed
  }
  void sessionDefaultPermission
  return next
}

/** 一次动作应用的产出：新快照 +（run 动作）待启动的执行引用。 */
export interface AppliedAction {
  snapshot: TasksSnapshot
  openedRun?: { taskId: string; executionId: string; trigger: 'cron' | 'manual' }
}

export interface TasksLedgerOptions {
  /** 会话默认权限（确认门基准）；缺省 read-only。 */
  sessionDefaultPermission?: TaskPermission
  /** 可注入时钟（测试）。 */
  now?: () => number
}

export class TasksLedger {
  private document: LedgerDocument
  private readonly listeners = new Set<() => void>()
  private readonly lockPath: string
  private readonly now: () => number
  private readonly sessionDefaultPermission: TaskPermission
  private disposed = false

  constructor(readonly filePath: string, options: TasksLedgerOptions = {}) {
    this.lockPath = `${filePath}.lock`
    this.now = options.now ?? Date.now
    this.sessionDefaultPermission = options.sessionDefaultPermission ?? DEFAULT_SESSION_PERMISSION
    this.acquireLock()
    this.document = this.load()
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  private acquireLock(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    if (existsSync(this.lockPath)) {
      let holderPid = 0
      try {
        holderPid = Number.parseInt(readFileSync(this.lockPath, 'utf8'), 10)
      } catch {
        holderPid = 0
      }
      if (Number.isFinite(holderPid) && holderPid > 0 && processAlive(holderPid)) {
        throw new LedgerLockedError(holderPid, this.lockPath)
      }
      // 持有者已死 → 接管。同进程双开（另一实例还活着）同样拒绝：两个实例各挂
      // 一套调度器是真实双写者场景，不豁免同 pid。
    }
    writeFileSync(this.lockPath, String(process.pid), { flag: 'w' })
  }

  private load(): LedgerDocument {
    const fresh: LedgerDocument = {
      schemaVersion: TASKS_SCHEMA_VERSION,
      revision: 0,
      tasks: [],
      scheduler: { timeZone: timeZone() },
      recentRequests: [],
    }
    if (!existsSync(this.filePath)) return fresh
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch (error) {
      // 损坏账本隔离留证，绝不带病续写；新账本 + 可见告警启动。
      const quarantine = `${this.filePath}.corrupt-${this.now()}`
      try { renameSync(this.filePath, quarantine) } catch { /* 隔离失败也只能新建 */ }
      console.error(`[dsh-trading/tasks] ledger corrupted, quarantined to ${quarantine}:`, error)
      fresh.scheduler.error = 'ledger was corrupted; quarantined and restarted empty'
      return fresh
    }
    const row = parsed as Record<string, unknown>
    if (row?.schemaVersion !== TASKS_SCHEMA_VERSION || !Array.isArray(row?.tasks)) {
      const quarantine = `${this.filePath}.corrupt-${this.now()}`
      try { renameSync(this.filePath, quarantine) } catch { /* 同上 */ }
      console.error(`[dsh-trading/tasks] ledger schemaVersion unknown, quarantined to ${quarantine}`)
      fresh.scheduler.error = 'ledger schemaVersion unknown; quarantined and restarted empty'
      return fresh
    }
    const warnings: string[] = []
    const tasks = (row.tasks as unknown[]).map(item => normalizeTask(item, warnings)).filter((item): item is TaskRecord => item !== undefined)
    for (const message of warnings) console.warn('[dsh-trading/tasks] ledger load:', message)
    return {
      schemaVersion: TASKS_SCHEMA_VERSION,
      revision: typeof row.revision === 'number' ? row.revision : 0,
      tasks,
      scheduler: {
        timeZone: timeZone(),
        ...(typeof (row.scheduler as Record<string, unknown> | undefined)?.lastTickAt === 'number'
          ? { lastTickAt: (row.scheduler as { lastTickAt: number }).lastTickAt }
          : {}),
      },
      recentRequests: Array.isArray(row.recentRequests)
        ? (row.recentRequests as Array<{ requestId?: unknown; fingerprint?: unknown }>)
          .filter(item => typeof item?.requestId === 'string' && typeof item?.fingerprint === 'string')
          .map(item => ({ requestId: item.requestId as string, fingerprint: item.fingerprint as string }))
        : [],
    }
  }

  /** 释放目录锁（幂等；dispose 后其余方法拒绝工作）。 */
  dispose(): void {
    this.disposed = true
    try {
      if (existsSync(this.lockPath)) unlinkSync(this.lockPath)
    } catch {
      // 锁文件清理失败不阻断退出（接管逻辑能处理残留）。
    }
  }

  // ── 读面 ────────────────────────────────────────────────────────────────

  /** 当前快照（深拷贝——调用方拿不到账本内部引用）。 */
  snapshot(): TasksSnapshot {
    return {
      schemaVersion: TASKS_SCHEMA_VERSION,
      revision: this.document.revision,
      tasks: cloneTasks(this.document.tasks),
      scheduler: { ...this.document.scheduler },
      sessionDefaultPermission: this.sessionDefaultPermission,
    }
  }

  /** 任务行只读引用（调度器内部用，绝不外泄可变引用）。 */
  task(taskId: string): TaskRecord | undefined {
    return this.document.tasks.find(task => task.id === taskId)
  }

  /** 待观察的未结算执行（轮询面）。 */
  openExecutions(): Array<{ taskId: string; executionId: string; sessionId: string | undefined; startedAt: number }> {
    const open: Array<{ taskId: string; executionId: string; sessionId: string | undefined; startedAt: number }> = []
    for (const task of this.document.tasks) {
      for (const execution of task.executions) {
        if (execution.endedAt === undefined) {
          open.push({ taskId: task.id, executionId: execution.id, sessionId: execution.sessionId, startedAt: execution.startedAt })
        }
      }
    }
    return open
  }

  /** 到期的已武装定时（tick 面）。 */
  dueTasks(now: number): Array<{ taskId: string; cron: string; nextRunAt: number }> {
    const due: Array<{ taskId: string; cron: string; nextRunAt: number }> = []
    for (const task of this.document.tasks) {
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled || schedule.nextRunAt === undefined) continue
      if (schedule.nextRunAt <= now) due.push({ taskId: task.id, cron: schedule.cron, nextRunAt: schedule.nextRunAt })
    }
    return due
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // ── 写面（串行 + 原子持久化 + 修订广播） ────────────────────────────────

  private commit(next: LedgerDocument): void {
    next.revision += 1
    next.recentRequests = next.recentRequests.slice(-MAX_REQUEST_CACHE)
    this.document = next
    const payload = JSON.stringify(next)
    const tmp = `${this.filePath}.tmp`
    mkdirSync(dirname(this.filePath), { recursive: true })
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, payload, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.filePath)
    if (process.platform !== 'win32') {
      try {
        chmodSync(this.filePath, 0o600)
      } catch {
        // 权限收紧失败不阻断（本地单用户目录）。
      }
    }
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-trading/tasks] ledger listener crashed:', error)
      }
    }
  }

  private mutate(fn: (document: LedgerDocument) => void): void {
    const next = JSON.parse(JSON.stringify(this.document)) as LedgerDocument
    fn(next)
    this.commit(next)
  }

  /**
   * 应用一个动作信封（幂等）：同 requestId + 同指纹 → 无副作用返回当前快照；
   * 同 requestId + 异指纹 → 拒绝（对齐 task-board 的重试防重放语义）。
   * run 动作在账本内开执行记录，启动返回给服务层异步进行。
   */
  apply(envelope: TasksActionEnvelope): AppliedAction {
    if (this.disposed) throw new TaskActionError(503, 'TASKS_LEDGER_DISPOSED', 'task ledger is disposed')
    const fingerprint = fingerprintOf(envelope.action)
    const cached = this.document.recentRequests.find(item => item.requestId === envelope.requestId)
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) {
        throw new TaskActionError(409, 'TASKS_REQUEST_CONFLICT', `requestId ${envelope.requestId} was already used with a different action`)
      }
      return { snapshot: this.snapshot() }
    }
    const now = this.now()
    const next = JSON.parse(JSON.stringify(this.document)) as LedgerDocument
    next.recentRequests.push({ requestId: envelope.requestId, fingerprint })
    const openedRun = this.applyTo(next, envelope.action, now)
    this.commit(next)
    return { snapshot: this.snapshot(), openedRun }
  }

  /** 动作分发（调用方已克隆文档；纯段，无 IO）。 */
  private applyTo(document: LedgerDocument, action: TasksAction, now: number): AppliedAction['openedRun'] {
    const taskOf = (taskId: string): TaskRecord | undefined => document.tasks.find(task => task.id === taskId)
    switch (action.kind) {
      case 'create': {
        if (document.tasks.some(task => task.id === action.id)) {
          throw new TaskActionError(409, 'TASKS_ID_EXISTS', `task id already exists: ${action.id}`)
        }
        document.tasks.push(taskFromInput(action.id, action.input, now))
        return undefined
      }
      case 'update': {
        const task = taskOf(action.taskId)
        if (task === undefined) throw new TaskActionError(404, 'TASKS_NOT_FOUND', `task not found: ${action.taskId}`)
        const updated = applyPatch(task, action.patch, now, this.sessionDefaultPermission)
        document.tasks.splice(document.tasks.indexOf(task), 1, updated)
        return undefined
      }
      case 'delete': {
        const task = taskOf(action.taskId)
        if (task === undefined) throw new TaskActionError(404, 'TASKS_NOT_FOUND', `task not found: ${action.taskId}`)
        // 允许删除运行中任务：未结算执行就地结算为 cancelled（不再被观察；
        // 已创建的会话本身不杀——杀会话不在本特性语义内，注释明示）。
        for (const execution of task.executions) {
          if (execution.endedAt === undefined) {
            execution.endedAt = now
            execution.result = 'cancelled'
            execution.error = 'task deleted while running'
          }
        }
        document.tasks.splice(document.tasks.indexOf(task), 1)
        return undefined
      }
      case 'set-schedule': {
        const task = taskOf(action.taskId)
        if (task === undefined) throw new TaskActionError(404, 'TASKS_NOT_FOUND', `task not found: ${action.taskId}`)
        const current: { enabled: boolean; cron: string } = task.schedule !== undefined
          ? { enabled: task.schedule.enabled, cron: task.schedule.cron }
          : { enabled: false, cron: '' }
        const merged = { ...current, ...action.patch }
        const armed = armSchedule({ ...merged, enabled: merged.enabled && merged.cron !== '' }, now)
        if (armed === undefined) delete task.schedule
        else task.schedule = armed
        task.updatedAt = now
        return undefined
      }
      case 'run': {
        const opened = this.openRunIn(document, action.taskId, 'manual', now)
        return opened === undefined ? undefined : { taskId: opened.taskId, executionId: opened.executionId, trigger: 'manual' }
      }
      case 'confirm-permission': {
        const task = taskOf(action.taskId)
        if (task === undefined) throw new TaskActionError(404, 'TASKS_NOT_FOUND', `task not found: ${action.taskId}`)
        if (permissionPending(task, this.sessionDefaultPermission)) {
          task.permissionConfirmedAt = now
          task.updatedAt = now
        }
        return undefined
      }
    }
  }

  /**
   * 打开一条执行记录（手动 run 与 cron 触发共用）。拒绝：任务不存在、已有未
   * 结算执行（同任务不并发）、权限门待确认（cron 与手动一致拒绝）。
   */
  openRun(taskId: string, trigger: 'cron' | 'manual'): { taskId: string; executionId: string } {
    if (this.disposed) throw new TaskActionError(503, 'TASKS_LEDGER_DISPOSED', 'task ledger is disposed')
    const next = JSON.parse(JSON.stringify(this.document)) as LedgerDocument
    const opened = this.openRunIn(next, taskId, trigger, this.now())
    if (opened === undefined) throw new TaskActionError(404, 'TASKS_NOT_FOUND', `task not found: ${taskId}`)
    this.commit(next)
    return opened
  }

  /** openRun 的纯段（文档已克隆）；拒绝抛 TaskActionError。 */
  private openRunIn(document: LedgerDocument, taskId: string, trigger: 'cron' | 'manual', now: number): { taskId: string; executionId: string } | undefined {
    const task = document.tasks.find(item => item.id === taskId)
    if (task === undefined) return undefined
    if (hasOpenExecution(task)) {
      throw new TaskActionError(409, 'TASKS_ALREADY_RUNNING', `task ${task.title} already has a running execution`)
    }
    if (permissionPending(task, this.sessionDefaultPermission)) {
      throw new TaskActionError(403, 'TASKS_PERMISSION_PENDING', `task ${task.title} awaits permission confirmation; runs are refused`)
    }
    const execution: ExecutionRecord = {
      id: crypto.randomUUID(),
      sessionId: undefined,
      startedAt: now,
      endedAt: undefined,
      result: undefined,
      error: undefined,
      trigger,
    }
    task.executions = retainRecentExecutions([...task.executions, execution])
    task.updatedAt = now
    return { taskId, executionId: execution.id }
  }

  /** 执行绑定会话（launch 落定后）。 */
  attachSession(taskId: string, executionId: string, sessionId: string): void {
    this.mutate(document => {
      const task = document.tasks.find(item => item.id === taskId)
      const execution = task?.executions.find(item => item.id === executionId)
      if (task === undefined || execution === undefined || execution.endedAt !== undefined) return
      execution.sessionId = sessionId
    })
  }

  /** 执行结算（结果 + 失败原因）。 */
  settleRun(taskId: string, executionId: string, result: 'succeeded' | 'failed' | 'cancelled', error: string | undefined): void {
    this.mutate(document => {
      const task = document.tasks.find(item => item.id === taskId)
      const execution = task?.executions.find(item => item.id === executionId)
      if (task === undefined || execution === undefined || execution.endedAt !== undefined) return
      execution.endedAt = this.now()
      execution.result = result
      execution.error = error
    })
  }

  /**
   * 定时触发点推进：lastTriggeredAt 盖为到期触发点，nextRunAt 从 now 重算。
   * 宿主宕机期间错过的触发点不补跑——从当前时刻取下一个匹配（对齐 task-board）。
   */
  advanceSchedule(taskId: string, triggerPoint: number, now: number): void {
    this.mutate(document => {
      const task = document.tasks.find(item => item.id === taskId)
      const schedule = task?.schedule
      if (task === undefined || schedule === undefined || !schedule.enabled || !isValidCron(schedule.cron)) return
      schedule.lastTriggeredAt = triggerPoint
      schedule.nextRunAt = nextRunAtMs(schedule.cron, now)
    })
  }

  /** 调度器快照字段（tick 时间/错误）。 */
  updateScheduler(patch: { lastTickAt?: number; error?: string }): void {
    this.mutate(document => {
      document.scheduler = {
        timeZone: document.scheduler.timeZone,
        ...(patch.lastTickAt === undefined ? {} : { lastTickAt: patch.lastTickAt }),
        ...(patch.error === undefined ? {} : { error: patch.error }),
      }
    })
  }

  /**
   * 重启对账：有 sessionId 的运行中执行继续观察（确定性恢复）；没有 sessionId
   * 的启动中断就地取消，不重发。
   */
  reconcileStartup(): void {
    const now = this.now()
    this.mutate(document => {
      for (const task of document.tasks) {
        for (const execution of task.executions) {
          if (execution.endedAt !== undefined) continue
          if (execution.sessionId === undefined) {
            execution.endedAt = now
            execution.result = 'cancelled'
            execution.error = 'host restarted before the execution session was created'
          }
        }
      }
    })
  }
}
