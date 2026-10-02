/**
 * desk 进程装配（P5 步骤 1：runbook 记的缺口是"**环路有了，但没有进程启动它**"）。
 *
 * 它把两根线接成一个进程里能跑的东西：
 *   - %%createDeskLoop%%（P5 步骤 1 的环路）：每轮取信号 → 判档 → 更新风控状态 → 变化才留痕；
 *   - %%createTriggerPump%%（P3 的进程内驱动）：到点判定 → 扇出 → 记账 → 排下一次。
 * 两者此前**只有单测与演练在构造**（runbook「接线台账」：createTriggerPump 生产调用点 0），
 * 本模块是它们的第一处运行期装配。
 *
 * 四条立场：
 *   1. **dry-run 是唯一被实现的派发语义**。派发器只把"本会派发什么"写进审计
 *      （%%trigger.dispatch.dry-run%%），**不触达任何 venue**：本装配**不接受任何下单端口**，
 *      且选项键是白名单（未知即放宽，直接抛错，§13 #4 的同一条纪律）。白名单里没有任何
 *      一个键能承载下单能力 ⇒ "没有下单路径"是装配出来的事实，不是纪律承诺。
 *   2. **dry-run 不是开关，因此没有"关掉"的路径**。本模块**不读任何环境变量**：没有
 *      %%process.env%%，就没有"环境变量悄悄把它关掉"这回事。将来要接 live 派发，必须显式改这个
 *      模块并走权威授权机制（authority:sign 签署 + %%live-trading:check%% 门禁，§13 #3）——
 *      本模块**不发明第二套授权判据**（一个事实只有一个家）。请求了未实现的模式时直接抛错：
 *      宁可不启动，也不许静默降级、更不许假装在跑实盘。
 *   3. **写不进去的派发不算派发**。审计 append 失败时派发器**抛出**，由泵把它记成 %%failed%%
 *      并留痕（泵的既有语义）：宁可下一次按原节奏重来，也不许把"没记下来"当成"已派发"。
 *   4. **积压告警写审计、且不打死进程**（runbook「待接线」的第一件事）：%%onBacklog%% →
 *      journal %%trigger.backlog%%（带 due 条数与时刻）。停机后补发的规模是事后复盘的关键信息，
 *      只 console 一下等于没有。但告警**只是观察、不是状态转移**：它写不进去时不抛
 *      （抛出去会顺着泵的调度链变成 unhandled rejection，可能直接打死进程），改为计数可见
 *      （%%stats().backlog.recordFailures%%）。
 *
 * 折叠策略**不在本模块决定**：泵当前调 %%dueOccurrences%% 不传折叠参数（停机一天 ⇒ 最多 1000 条
 * 补发）。折叠与否改变的是派发语义，属需人确认的待决策项（见 ops-runbook「积压折叠」一节）；
 * 本装配只把规模**可见化**（告警入审计），不替人做这个决定，也不静默降级。
 *
 * @module @dshtrading/tractl/desk-process
 */
import { createDeskLoop, type DeskLoopOptions, type LoopStats } from './desk-loop.ts'
import { createTriggerPump, type PumpStats } from './pump.ts'
import type { GapReport } from './degradation.ts'
import type { GapWindow } from './gap-collector.ts'
import type { Occurrence } from './triggers.ts'

/** 派发模式：**只有 dry-run 被实现**（缺省即它）。 */
export type DeskDispatchMode = 'dry-run'

const DRY_RUN: DeskDispatchMode = 'dry-run'

/**
 * 允许的选项键（白名单，逐字列出）——**未知即放宽**。
 * 有了它，"把 venue/下单端口塞进装配"这件事在运行期就不可能悄悄发生。环路将来新增选项时
 * 必须同批加进这里，否则装配会**显式拒绝启动**：宁可不启动，也不许带着一个没被审查过的端口跑起来。
 */
const ALLOWED_OPTION_KEYS: readonly string[] = [
  'orders',
  'audit',
  'journal',
  'gate',
  'signals',
  'scheduler',
  'now',
  'intervalMs',
  'heartbeatPath',
  'probeDir',
  'clockDriftToleranceMs',
  'monotonicNow',
  'deskSessionId',
  'backlogWarnThreshold',
  'dispatchMode',
]

export interface DeskProcessOptions extends DeskLoopOptions {
  /**
   * 触发时对话的会话 id。dry-run 下它只被记进审计（真实扇出是 followup 的接线点，
   * 见 pump.ts 的 %%createTriggerPump%% 与 triggers.ts 的 %%createThrottledFanout%%）。
   */
  readonly deskSessionId: string
  /**
   * 积压告警阈值（转交泵；不传则用泵的默认值——阈值语义的家在 pump.ts，这里不复制一份）。
   */
  readonly backlogWarnThreshold?: number | undefined
  /**
   * 派发模式。缺省 %%'dry-run'%%；传任何其它值（含被 %%as any%% 塞进来的 %%'live'%%）一律抛错。
   */
  readonly dispatchMode?: DeskDispatchMode | undefined
}

/** dry-run 派发器的记账（调用次数与其结果条数必须与泵的统计对得上）。 */
export interface DryRunDispatchStats {
  /** 派发器被调用的次数（批次数，含失败）。 */
  readonly calls: number
  /** 经审计记录下来的 occurrence 条数（只算真的写进 journal 的）。 */
  readonly occurrences: number
  /** 审计写不进去而失败的派发次数（不为 0 = 有触发没能留痕）。 */
  readonly failures: number
  readonly lastAtMs: number | null
  readonly lastError: string | null
}

/** 积压告警的记账。 */
export interface BacklogAuditStats {
  /** 观察到积压超阈值的次数。 */
  readonly warnings: number
  readonly lastAtMs: number | null
  readonly lastDue: number | null
  /** 告警写审计失败的次数（不为 0 = 积压规模没能留痕）。 */
  readonly recordFailures: number
}

export interface DeskProcessStats {
  readonly mode: DeskDispatchMode
  readonly running: boolean
  readonly loop: LoopStats
  readonly pump: PumpStats
  readonly dryRun: DryRunDispatchStats
  readonly backlog: BacklogAuditStats
}

/** 未知选项一律拒绝：它们可能承载的正是"放宽"（§13 #4）。 */
function assertKnownOptions(options: DeskProcessOptions): void {
  const unknown = Object.keys(options).filter((key) => !ALLOWED_OPTION_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error('createDeskProcess: 未知选项 ' + unknown.join(', ') + ' —— 未知即放宽；本装配不接受任何下单端口')
  }
}

/** 派发模式只实现了 dry-run：请求别的模式必须**当场报错**，不许静默降级。 */
function assertDryRunOnly(requested: unknown): void {
  if (requested !== undefined && requested !== DRY_RUN) {
    throw new Error(
      'createDeskProcess: 只实现了 dry-run 派发，收到 ' + String(requested)
      + '。live 派发路径在本仓尚不存在（实盘授权属 authority:sign 签署 + live-trading:check 门禁，§13 #3），'
      + '本模块不发明第二套授权判据：宁可不启动，也不静默降级。',
    )
  }
}

/**
 * 装配一个 desk 进程：环路 + 事件泵 + dry-run 派发 + 积压告警入审计。
 * @param options - 环路选项 + 泵的会话 id/积压阈值（见 %%DeskProcessOptions%%）。
 */
export function createDeskProcess(options: DeskProcessOptions): {
  start(): void
  stop(): void
  stats(): DeskProcessStats
  /** 重连：产出 gap report 并写进 journal（§13 #19：恢复必须产出）。 */
  onReconnect(window: GapWindow): GapReport
} {
  assertKnownOptions(options)
  assertDryRunOnly(options.dispatchMode)

  const dryRun: { calls: number; occurrences: number; failures: number; lastAtMs: number | null; lastError: string | null } = {
    calls: 0,
    occurrences: 0,
    failures: 0,
    lastAtMs: null,
    lastError: null,
  }
  const backlog: { warnings: number; lastAtMs: number | null; lastDue: number | null; recordFailures: number } = {
    warnings: 0,
    lastAtMs: null,
    lastDue: null,
    recordFailures: 0,
  }

  /**
   * dry-run 派发器：**只记录意图**。审计写失败必须抛出（见模块头注立场 3）。
   * %%reduceOnly%% 与 %%createThrottledFanout%% 同口径（批里有 %%missed%% 即只减风险，§13 #20）——
   * 真正的派发语义归扇出器，这里只是把口径一并写进审计，便于事后复盘。
   */
  const dispatchDryRun = async (sessionId: string, due: readonly Occurrence[]): Promise<void> => {
    const atMs = options.now()
    dryRun.calls += 1
    try {
      options.journal.append('trigger.dispatch.dry-run', {
        mode: DRY_RUN,
        deskSessionId: sessionId,
        count: due.length,
        reduceOnly: due.some((occurrence) => occurrence.missed),
        occurrences: due.map((occurrence) => ({
          scheduleId: occurrence.scheduleId,
          kind: occurrence.kind,
          dueAtMs: occurrence.dueAtMs,
          missed: occurrence.missed,
          // §13 #26：被折叠掉的次数（若将来启用折叠）也要能重建判定，不能只留个总数
          skipped: occurrence.skipped,
        })),
      }, atMs)
    } catch (error) {
      dryRun.failures += 1
      dryRun.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
    dryRun.occurrences += due.length
    dryRun.lastAtMs = atMs
  }

  /**
   * 积压告警 → 审计（runbook「待接线」第一件事）。写失败只计数、不抛：
   * 它只是观察，不该把泵的调度链打断（那里的失败会变成 unhandled rejection）。
   */
  const onBacklog = (info: { readonly due: number; readonly atMs: number }): void => {
    backlog.warnings += 1
    backlog.lastAtMs = info.atMs
    backlog.lastDue = info.due
    try {
      options.journal.append('trigger.backlog', {
        due: info.due,
        atMs: info.atMs,
        deskSessionId: options.deskSessionId,
      }, info.atMs)
    } catch {
      backlog.recordFailures += 1
    }
  }

  const loop = createDeskLoop({
    orders: options.orders,
    audit: options.audit,
    journal: options.journal,
    gate: options.gate,
    signals: options.signals,
    scheduler: options.scheduler,
    now: options.now,
    intervalMs: options.intervalMs,
    heartbeatPath: options.heartbeatPath,
    probeDir: options.probeDir,
    clockDriftToleranceMs: options.clockDriftToleranceMs,
    monotonicNow: options.monotonicNow,
  })

  const pump = createTriggerPump({
    // 触发器表挂在 orders 库（本仓约定，与 pump 的测试夹具一致）
    db: options.orders,
    deskSessionId: options.deskSessionId,
    dispatch: dispatchDryRun,
    scheduler: options.scheduler,
    now: options.now,
    intervalMs: options.intervalMs,
    backlogWarnThreshold: options.backlogWarnThreshold,
    onBacklog,
  })

  let running = false
  return {
    start() {
      if (running) return
      running = true
      // 环路先起：心跳先落地（dead-man 第一层据此判断失活），再让泵开始派发
      loop.start()
      pump.start()
    },
    stop() {
      running = false
      // 泵先停（派发的一半是异步的），再停环路
      pump.stop()
      loop.stop()
    },
    stats: () => ({
      mode: DRY_RUN,
      running,
      loop: loop.stats(),
      pump: pump.stats(),
      dryRun: { ...dryRun },
      backlog: { ...backlog },
    }),
    onReconnect: (window) => loop.onReconnect(window),
  }
}
