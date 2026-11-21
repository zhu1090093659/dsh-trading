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
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { tryAcquireHomeFileLeaseSync, type HomeFileLease } from '@dshtrading/dsh-home'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  countOpenExecutions,
  DEFAULT_MAX_INFLIGHT_EXECUTIONS,
  DEFAULT_SESSION_PERMISSION,
  DEFAULT_TASK_AGENT_PRESET,
  DEFAULT_TASK_PERMISSION,
  hasOpenExecution,
  isTaskSkipReason,
  permissionPending,
  retainRecentExecutions,
  TASKS_SCHEMA_VERSION,
  type ExecutionRecord,
  type NewTaskInput,
  type ScheduleRule,
  type ScheduleSkipRecord,
  type TaskPermission,
  type TaskSkipReason,
  type TaskRecord,
  type TasksAction,
  type TasksActionEnvelope,
  type TasksSchedulerSnapshot,
  type TasksSnapshot,
  type TaskUpdatePatch,
} from '@dshtrading/api'
import { isValidCron, nextRunAtMs } from '@dshtrading/api'

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
  } catch (error) {
    // Only ESRCH proves death; permission or probing failures must fail closed.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
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
    return interpretProcessProbe(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { timeout: 2_000 }))
  } catch {
    return true // 探针不可用时保守认为活（宁可误拒不可双写）
  }
}

/**
 * 解释一次进程探针的结果（纯函数：逐分支钉住保守语义）。
 *
 * 「探针不可用」与「进程已死」是两件事，混为一谈会让目录锁在同 uid／受限环境下**静默
 * 失效**：2026-10-01 实测（文件沙箱把 `ps` 判 EPERM，spawnSync 返回 status=null +
 * error=EPERM），旧实现按 status!==0 判成「已死」，于是活着的持有者被接管，直接违反
 * 不变量 #15「同一份 home 同一时刻只允许一个 dsh host 写者」。
 * 判据只看输出：探针报错 ⇒ 活（保守）；跑完没输出 ⇒ 死；跑出 Z/X（僵尸）⇒ 死；其余 ⇒ 活。
 */
export function interpretProcessProbe(probe: { error?: unknown; stdout: string | Buffer; status: number | null }): boolean {
  if (probe.error !== undefined && probe.error !== null) return true
  const state = probe.stdout.toString('utf8').trim()
  if (state.length === 0) return false
  return state !== 'Z' && state !== 'X'
}

/**
 * 目录条目同步：rename 的持久性依赖父目录 fsync（POSIX）。Windows 不支持对
 * 目录做 fsync，按「适用平台」跳过。失败即让 commit 失败——「发布」必须建立在
 * 文件与目录都落定之上（调用方会看到错误，内存保持旧状态）。
 */
function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** 武装定时规则：启用且表达式合法 → 计算下次运行；禁用 → 保留表达式、清到期。 */
function armSchedule(rule: { enabled: boolean; cron: string }, now: number): ScheduleRule {
  if (!rule.enabled) {
    return { enabled: false, cron: rule.cron, nextRunAt: undefined, lastTriggeredAt: undefined }
  }
  if (!isValidCron(rule.cron)) {
    throw new TaskActionError(400, 'TASKS_CRON_INVALID', `invalid cron expression: ${rule.cron}`)
  }
  const nextRunAt = nextRunAtMs(rule.cron, now)
  // 语法合法但日历上永不匹配（如 `0 0 31 2 *`）同样拒绝：存成「已启用却没有下次
  // 运行」会让任务永远不触发且不留痕迹，官方 occurrence 引擎对同一输入也是拒绝。
  if (nextRunAt === undefined) {
    throw new TaskActionError(400, 'TASKS_CRON_INVALID', `cron expression never matches a calendar instant: ${rule.cron}`)
  }
  return { enabled: true, cron: rule.cron, nextRunAt, lastTriggeredAt: undefined }
}

/**
 * 由新建输入落一条任务记录（id/时间戳由账本盖）。未钉住 agent 预设/权限时落
 * 插件默认（大师 + workspace-write，2026-09-08 起）：钉住必须落盘——runner 只
 * 对钉住权限执行 /permission，缺省会话回退宿主默认，拿不到写入。
 */
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
    agentPreset: input.agentPreset === undefined || input.agentPreset === '' ? DEFAULT_TASK_AGENT_PRESET : input.agentPreset,
    permission: input.permission ?? DEFAULT_TASK_PERMISSION,
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
      const skipRow = scheduleRow.lastSkip as Record<string, unknown> | undefined
      const lastSkip: ScheduleSkipRecord | undefined = skipRow !== undefined && typeof skipRow === 'object'
        && typeof skipRow.at === 'number' && typeof skipRow.triggerPoint === 'number' && isTaskSkipReason(skipRow.reason)
        ? { at: skipRow.at, triggerPoint: skipRow.triggerPoint, reason: skipRow.reason }
        : undefined
      schedule = {
        enabled: scheduleRow.enabled,
        cron: scheduleRow.cron,
        nextRunAt: typeof scheduleRow.nextRunAt === 'number' ? scheduleRow.nextRunAt : undefined,
        lastTriggeredAt: typeof scheduleRow.lastTriggeredAt === 'number' ? scheduleRow.lastTriggeredAt : undefined,
        ...(lastSkip === undefined ? {} : { lastSkip }),
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
  /** 会话默认权限（确认门基准）；缺省 workspace-write。 */
  sessionDefaultPermission?: TaskPermission
  /** 全局在飞执行容量上限（跨任务）；缺省 DEFAULT_MAX_INFLIGHT_EXECUTIONS。 */
  maxInflightExecutions?: number
  /** 可注入时钟（测试）。 */
  now?: () => number
}

export class TasksLedger {
  private document: LedgerDocument
  private readonly listeners = new Set<() => void>()
  private readonly lockPath: string
  private readonly now: () => number
  private readonly sessionDefaultPermission: TaskPermission
  private readonly maxInflightExecutions: number
  private disposed = false
  private lease: HomeFileLease | undefined
  private lockIdentity: string | undefined

  constructor(readonly filePath: string, options: TasksLedgerOptions = {}) {
    this.lockPath = `${filePath}.lock`
    this.now = options.now ?? Date.now
    this.sessionDefaultPermission = options.sessionDefaultPermission ?? DEFAULT_SESSION_PERMISSION
    this.maxInflightExecutions = options.maxInflightExecutions ?? DEFAULT_MAX_INFLIGHT_EXECUTIONS
    this.acquireLock()
    try { this.document = this.load() } catch (error) { this.dispose(); throw error }
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  /**
   * 先取得 SQLite 进程持有的 writer lease，再串行裁决标记的获取/接管/释放。
   * 标记首行保留 PID 兼容旧读者，第二行是每次获取的唯一 token 与本机身份。
   * 未知身份、异机身份及活着的旧格式 PID 锁都拒绝；只有当前 lease 持有者
   * 能接管已经释放的 SQLite owner，旧实例不能按相同 PID 删除新实例的标记。
   */
  private acquireLock(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const lease = tryAcquireHomeFileLeaseSync(this.filePath)
    if (lease === undefined) throw new LedgerLockedError(this.readLockHolder() ?? 0, this.lockPath)
    try {
      const prior = this.readLockText()
      if (prior !== undefined) {
        const holderPid = this.readLockHolder()
        let releasedSqliteOwner = false
        try {
          const metadataText = prior.split('\n')[1]
          if (metadataText !== undefined) {
            const metadata = JSON.parse(metadataText) as { host?: unknown; lease?: unknown; token?: unknown }
            if (metadata.host !== hostname() || metadata.lease !== 'sqlite-v1'
              || typeof metadata.token !== 'string' || !/^[0-9a-f-]{36}$/.test(metadata.token)) {
              throw new LedgerLockedError(holderPid ?? 0, this.lockPath)
            }
            releasedSqliteOwner = true
          }
        } catch { throw new LedgerLockedError(holderPid ?? 0, this.lockPath) }
        if (!releasedSqliteOwner && (holderPid === undefined || processAlive(holderPid))) {
          throw new LedgerLockedError(holderPid ?? 0, this.lockPath)
        }
        // Kernel lease serializes the check and takeover: another current writer cannot intervene.
        unlinkSync(this.lockPath)
      }
      const identity = String(process.pid) + '\n' + JSON.stringify({
        host: hostname(), token: randomUUID(), lease: 'sqlite-v1',
      })
      const fd = openSync(this.lockPath, 'wx', 0o600)
      try { writeFileSync(fd, identity, 'utf8') } finally { closeSync(fd) }
      this.lockIdentity = identity
      this.lease = lease
    } catch (error) { lease.dispose(); throw error }
  }

  private readLockText(): string | undefined {
    try { return readFileSync(this.lockPath, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private readLockHolder(): number | undefined {
    const first = this.readLockText()?.split('\n')[0]
    if (first === undefined || !/^[1-9][0-9]*$/.test(first)) return undefined
    const pid = Number(first)
    return Number.isSafeInteger(pid) ? pid : undefined
  }

  private assertOwned(): void {
    if (this.lease === undefined || this.lockIdentity !== this.readLockText()) {
      throw new TaskActionError(503, 'TASKS_LEDGER_LOCK_LOST', 'task ledger writer lease is no longer owned; restart after reconciling the owner')
    }
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
    if (this.disposed) return
    this.disposed = true
    try {
      if (this.lockIdentity !== undefined && this.readLockText() === this.lockIdentity) unlinkSync(this.lockPath)
    } catch { /* Leave an unreadable marker in place; do not erase an unknown owner. */ }
    finally { this.lease?.dispose(); this.lease = undefined }
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
    if (this.disposed) throw new TaskActionError(503, 'TASKS_LEDGER_DISPOSED', 'task ledger is disposed')
    this.assertOwned()
    next.revision += 1
    next.recentRequests = next.recentRequests.slice(-MAX_REQUEST_CACHE)
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
    syncDirectory(dirname(this.filePath))
    // 只有文件写盘 + fsync + 适用平台的目录同步都成功之后，才发布新的内存文档/
    // revision 并广播。真实落盘失败（EISDIR/EACCES/ENOSPC…）不能污染内存状态，
    // 也不能让 requestId 幂等缓存记下一次根本没写下去的请求——否则重试会被
    // 当成重放静默返回旧快照。
    this.document = next
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
   * 薄扩展（官方 dsh-schedule 无对应）：requestId 幂等账本，见 tasks/service.ts 顶部「薄扩展边界」。
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
    return { snapshot: this.snapshot(), ...(openedRun === undefined ? {} : { openedRun }) }
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
   * 薄扩展（官方 dsh-schedule 无对应）：人工确认门 + 有界扇出，见 tasks/service.ts 顶部「薄扩展边界」。
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
    const inflight = countOpenExecutions(document.tasks)
    if (inflight >= this.maxInflightExecutions) {
      throw new TaskActionError(
        429,
        'TASKS_CAPACITY_EXCEEDED',
        `global in-flight execution capacity is exhausted (${inflight}/${this.maxInflightExecutions})`,
      )
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

  /** 单条执行记录只读引用（服务层启动护栏与诊断用）。 */
  execution(taskId: string, executionId: string): ExecutionRecord | undefined {
    return this.document.tasks.find(task => task.id === taskId)?.executions.find(item => item.id === executionId)
  }

  /** 执行结算（结果 + 失败原因）；结算即清掉未结算期的侦查诊断。 */
  settleRun(taskId: string, executionId: string, result: 'succeeded' | 'failed' | 'cancelled', error: string | undefined): void {
    this.mutate(document => {
      const task = document.tasks.find(item => item.id === taskId)
      const execution = task?.executions.find(item => item.id === executionId)
      if (task === undefined || execution === undefined || execution.endedAt !== undefined) return
      execution.endedAt = this.now()
      execution.result = result
      execution.error = error
      delete execution.note
    })
  }

  /**
   * 记录未结算执行的侦查诊断（为什么还开着）。只在内容变化时落盘——轮询每
   * 5 秒一次，内容不变也写盘会造成无谓 fsync 与 SSE 广播。note 为 undefined
   * 即清空；已结算的执行忽略。
   */
  noteInspection(taskId: string, executionId: string, note: string | undefined): void {
    if (this.disposed) return
    const current = this.execution(taskId, executionId)
    if (current === undefined || current.endedAt !== undefined || current.note === note) return
    this.mutate(document => {
      const execution = document.tasks.find(task => task.id === taskId)?.executions.find(item => item.id === executionId)
      if (execution === undefined || execution.endedAt !== undefined) return
      if (note === undefined) delete execution.note
      else execution.note = note
    })
  }

  /**
   * 记录一次被跳过的定时触发点（权限门/容量/已有执行）。cron 错过不补跑的策略
   * 不变，但「到点没跑」必须在快照上能解释，否则只剩一个空转的 nextRunAt。
   */
  recordScheduleSkip(taskId: string, triggerPoint: number, reason: TaskSkipReason, at: number): void {
    if (this.disposed) throw new TaskActionError(503, 'TASKS_LEDGER_DISPOSED', 'task ledger is disposed')
    this.mutate(document => {
      const schedule = document.tasks.find(item => item.id === taskId)?.schedule
      if (schedule === undefined) return
      schedule.lastSkip = { at, triggerPoint, reason }
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
  // error 显式允许 undefined：tick 成功时用它清空上次错误（缺省=无错误）。
  // 心跳快路径：纯 lastTickAt 刷新且当前无错误态时只在内存文档推进——不做
  // 整文档克隆/落盘 fsync/监听器广播。tick 每 30s 一次，空转时整文档 fsync
  // + SSE 扇出（每标签页随即 refetch 全量快照）是宿主唯一稳态写放大源；
  // lastTickAt 是易失心跳（snapshot() 读内存文档即可见），下一次真实 commit
  // 会顺带把它落盘。错误的出现/清除仍走完整 mutate（可见状态变化必须广播）。
  updateScheduler(patch: { lastTickAt?: number; error?: string | undefined }): void {
    if (patch.error === undefined && patch.lastTickAt !== undefined && this.document.scheduler.error === undefined) {
      this.document.scheduler = { timeZone: this.document.scheduler.timeZone, lastTickAt: patch.lastTickAt }
      return
    }
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
   * 薄扩展（官方 dsh-schedule 无对应）：重启对账，见 tasks/service.ts 顶部「薄扩展边界」。
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
