/**
 * 右侧栏定时任务——Host 编排服务：cron tick、执行轮询、重启对账、动作应用。
 *
 * 节奏对齐 dsh-web dsh-task-board：30 秒调度 tick（错过触发点不补跑，从当前
 * 时刻取下一个匹配）、5 秒执行轮询（会话静默 + turn/end 侦查结算）、启动对账
 * （有会话 id 的运行中执行继续观察，无 id 的启动中断取消不重发）。所有定时器
 * 异常吞掉并记入 scheduler.error，绝不打断宿主进程。
 */
import { TasksLedger, TaskActionError, type AppliedAction } from './ledger.ts'
import {
  DEFAULT_SESSION_PERMISSION,
  type TaskPermission,
  type TasksActionEnvelope,
  type TasksSnapshot,
} from './protocol.ts'
import { TasksRunner, SessionLaunchError, type SessionCommandDispatcher, type SessionGateway } from './runner.ts'

/** 宿主工作区名册面（meta + runner 校验共用；name 可缺省）。 */
export interface WorkspaceDirectoryLike {
  list(): readonly { id: string; name?: string }[]
}

export interface TasksMeta {
  sessionDefaultPermission: TaskPermission
  workspaces: Array<{ id: string; name?: string }>
  agentPresets: Array<{ id: string }>
}

export interface TradingTasksServiceOptions {
  /** 账本文件路径（含 .lock 同目录）。 */
  ledgerPath: string
  /** 惰性解析宿主 typertGateway（每轮调用，服务晚激活也能接上）。 */
  gateway: () => SessionGateway | undefined
  /** 惰性解析宿主 commands 服务（权限斜杠命令）。 */
  commands?: () => SessionCommandDispatcher | undefined
  /** 惰性解析宿主 workspaceRegistry。 */
  workspaces?: () => WorkspaceDirectoryLike | undefined
  /** 账本每次提交后的失效信号回调（桥层接 SSE emit('tasks')）。 */
  onEvent?: () => void
  /** 会话默认权限（确认门基准）；缺省 read-only。 */
  sessionDefaultPermission?: TaskPermission
  /** 可注入时钟与节奏（测试）。 */
  now?: () => number
  tickMs?: number
  pollMs?: number
}

const TICK_MS = 30_000
const POLL_MS = 5_000

export class TradingTasksService {
  private readonly ledger: TasksLedger
  private readonly runner: TasksRunner
  private readonly options: TradingTasksServiceOptions
  private readonly tickMs: number
  private readonly pollMs: number
  private timers: Array<ReturnType<typeof setInterval>> = []
  private tickInFlight = false
  private pollInFlight = false
  private disposed = false

  constructor(options: TradingTasksServiceOptions) {
    this.options = options
    this.tickMs = options.tickMs ?? TICK_MS
    this.pollMs = options.pollMs ?? POLL_MS
    // LedgerLockedError 直接上抛：桥层据此把任务面降级为 503（特性不挂，宿主照跑）。
    this.ledger = new TasksLedger(options.ledgerPath, {
      ...(options.sessionDefaultPermission === undefined ? {} : { sessionDefaultPermission: options.sessionDefaultPermission }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    this.ledger.subscribe(() => { options.onEvent?.() })
    this.runner = new TasksRunner(
      options.gateway,
      options.commands ?? (() => undefined),
      options.workspaces as (() => WorkspaceDirectoryLike | undefined) | undefined ?? (() => undefined),
    )
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  /** 启动对账 + 定时器（幂等；dispose 后拒绝）。 */
  start(): void {
    if (this.disposed || this.timers.length > 0) return
    this.ledger.reconcileStartup()
    const tickTimer = setInterval(() => { void this.tick() }, this.tickMs)
    const pollTimer = setInterval(() => { void this.poll() }, this.pollMs)
    tickTimer.unref?.()
    pollTimer.unref?.()
    this.timers.push(tickTimer, pollTimer)
    void this.tick()
    void this.poll()
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer)
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.ledger.dispose()
  }

  // ── 读面 ────────────────────────────────────────────────────────────────

  snapshot(): TasksSnapshot {
    return this.ledger.snapshot()
  }

  /** 元数据面：确认门基准 + 工作区名册 + agent 预设名册（UI 下拉用）。 */
  async meta(): Promise<TasksMeta> {
    const snapshot = this.ledger.snapshot()
    const directory = this.options.workspaces?.()
    const workspaces = directory === undefined
      ? []
      : directory.list().map(item => ({ id: item.id, ...(item.name === undefined ? {} : { name: item.name }) }))
    const gateway = this.options.gateway()
    const agentPresets: Array<{ id: string }> = []
    if (gateway !== undefined) {
      try {
        const response = await gateway.invoke({ namespace: 'agentPresets', method: 'list', args: {} }) as { presets?: readonly { id: string }[] }
        for (const preset of response.presets ?? []) agentPresets.push({ id: preset.id })
      } catch {
        // 预设名册不可用 → 空表（UI 只显示部署默认），不阻塞元数据面。
      }
    }
    return { sessionDefaultPermission: snapshot.sessionDefaultPermission, workspaces, agentPresets }
  }

  // ── 写面 ────────────────────────────────────────────────────────────────

  /** 应用一个动作信封（幂等）；run 动作返回后异步起跑。 */
  apply(envelope: TasksActionEnvelope): AppliedAction['snapshot'] {
    const applied = this.ledger.apply(envelope)
    if (applied.openedRun !== undefined) {
      void this.launchTask(applied.openedRun.taskId, applied.openedRun.executionId)
    }
    return applied.snapshot
  }

  // ── 内部：启动与轮询 ───────────────────────────────────────────────────

  /** 异步起跑一条已开的执行：launch 落定绑定会话；失败结算 failed。 */
  private async launchTask(taskId: string, executionId: string): Promise<void> {
    const task = this.ledger.task(taskId)
    if (task === undefined) return
    const runnerTask = {
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId }),
      ...(task.agentPreset === undefined ? {} : { agentPreset: task.agentPreset }),
      ...(task.permission === undefined ? {} : { permission: task.permission }),
    }
    try {
      const sessionId = await this.runner.launch(runnerTask)
      this.ledger.attachSession(taskId, executionId, sessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof SessionLaunchError) {
        // 会话已建但启动中途失败：绑上会话再结算，观察面能对上号。
        this.ledger.attachSession(taskId, executionId, error.sessionId)
      }
      this.ledger.settleRun(taskId, executionId, 'failed', message)
    }
  }

  /** 调度 tick：到期任务推进触发点并起跑；拒绝（并发/权限门）即跳过该触发点。 */
  private async tick(): Promise<void> {
    if (this.disposed || this.tickInFlight) return
    this.tickInFlight = true
    try {
      const now = this.options.now?.() ?? Date.now()
      for (const due of this.ledger.dueTasks(now)) {
        const task = this.ledger.task(due.taskId)
        if (task === undefined) continue
        // 先推进再尝试：错过不补跑，被跳过（并发执行/权限待确认）的触发点不滞留。
        this.ledger.advanceSchedule(due.taskId, due.nextRunAt, this.options.now?.() ?? Date.now())
        try {
          const opened = this.ledger.openRun(due.taskId, 'cron')
          void this.launchTask(opened.taskId, opened.executionId)
        } catch (error) {
          if (!(error instanceof TaskActionError)) throw error
          // 权限待确认 / 已有执行在跑：跳过该触发点（对齐 task-board 的 cron 拒绝语义）。
        }
      }
      this.ledger.updateScheduler({ lastTickAt: this.options.now?.() ?? Date.now(), error: undefined })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[dsh-trading/tasks] schedule tick failed:', error)
      try {
        this.ledger.updateScheduler({ error: message })
      } catch {
        // 账本已不可写（锁丢失等）——只能打日志。
      }
    } finally {
      this.tickInFlight = false
    }
  }

  /** 执行轮询：已绑定会话的未结算执行侦查结局并结算。 */
  private async poll(): Promise<void> {
    if (this.disposed || this.pollInFlight) return
    this.pollInFlight = true
    try {
      for (const open of this.ledger.openExecutions()) {
        // 未绑定会话 = launch 还在途（launchTask 自己负责失败结算），跳过。
        if (open.sessionId === undefined) continue
        try {
          const inspection = await this.runner.inspect(open.sessionId, open.startedAt)
          if (inspection.outcome === 'pending') continue
          this.ledger.settleRun(
            open.taskId,
            open.executionId,
            inspection.outcome,
            inspection.outcome === 'failed' || inspection.outcome === 'cancelled' ? inspection.error : undefined,
          )
        } catch {
          // 单个执行侦查失败不影响其他执行，下轮再试。
        }
      }
    } finally {
      this.pollInFlight = false
    }
  }
}
