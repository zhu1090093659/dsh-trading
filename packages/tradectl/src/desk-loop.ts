/**
 * desk 运行时环路（P5 步骤 1 的最后一根线：**把各层接起来**）。
 *
 * 此前每一层都有，但**没有东西把它们串起来**：检测层产出触发源、degradation 决定档位、
 * risk-gate 维护状态、desk-records 负责留痕、gap-collector 生成报告 —— 全是零件。
 * 本模块是那条链：每轮取信号 → 判定 → 更新风控状态 → 变化时留痕；重连时产出并记录 gap report。
 *
 * 三条立场：
 *   1. **映射不重造策略**：触发源到风控事件的翻译只做"作用域"判断（单标的走 alignment，
 *      全局走 desk-level），档位一律取自 decideDegradation —— 一个事实一个家；
 *   2. **只有变化才留痕**：每轮都写"还是 reduce_only"会把 journal 淹掉（与 recordPositionChange 同一纪律）；
 *   3. **恢复也要留痕**：回到 aligned/normal 同样是一条 degradation.transition（否则事后只看到"降下去"看不到"回来了"）。
 *
 * @module @dshtrading/tractl/desk-loop
 */
import type { DatabaseSync } from 'node:sqlite'
import { decideDegradation, type DegradationTrigger } from './degradation.ts'
import { collectGapReport, type GapWindow } from './gap-collector.ts'
import type { GapReport } from './degradation.ts'
import type { Journal } from './journal.ts'
import { recordDegradation } from './desk-records.ts'
import { applyRiskEvent, initialRiskState, openRiskAllowedFor, type RiskGateOptions, type RiskState } from './risk-gate.ts'
import { scanDegradation, type MonitorSignals } from './degradation-monitor.ts'
import { writeHeartbeat } from './heartbeat.ts'

/** 调度端口（与事件泵同一接口，便于测试注入）。 */
export interface LoopScheduler {
  schedule(callback: () => void, delayMs: number): () => void
}

export interface DeskLoopOptions {
  readonly orders: DatabaseSync
  readonly audit: DatabaseSync
  readonly journal: Journal
  readonly gate: RiskGateOptions
  /** 每轮取一次信号（真实运行时从对齐层/心跳/错误计数读）。 */
  readonly signals: () => MonitorSignals
  readonly scheduler: LoopScheduler
  readonly now: () => number
  readonly intervalMs: number
  /**
   * 心跳文件路径（可选）：给了就每轮原子写一次。
   * **dead-man 第一层的前提**：看门狗要在"bot 已经死了"的前提下还能判断失活，
   * 所以心跳必须落在独立于 agent 会话的文件里，而不是靠问进程。
   */
  readonly heartbeatPath?: string | undefined
}

/** 一轮的结果（名字带 Desk 前缀：triggers.ts 已导出过 TickResult，避免 barrel 重名）。 */
export interface DeskTickResult {
  readonly triggers: readonly DegradationTrigger[]
  readonly state: RiskState
  /** 本轮新写进 journal 的降级过渡条数（0 = 档位没变）。 */
  readonly transitions: number
}

export interface LoopStats {
  readonly ticks: number
  readonly transitions: number
  readonly gapReports: number
  readonly running: boolean
  /** 记录（审计）写入失败的次数：**不为 0 就是"审计可能缺行"的信号**，必须被看见。 */
  readonly recordFailures: number
  readonly lastRecordFailure: string | null
}

export function createDeskLoop(options: DeskLoopOptions): {
  start(): void
  stop(): void
  tickOnce(): DeskTickResult
  /** 重连：产出 gap report 并写进 journal（#19：恢复必须产出）。 */
  onReconnect(window: GapWindow): GapReport
  stats(): LoopStats
  /** 当前某只标的能否开新仓（对外的合取判定，便于演练与测试）。 */
  openAllowed(symbol: string): { allowed: boolean; reason: string }
} {
  let state = initialRiskState(options.now())
  let ticks = 0
  let transitions = 0
  let gapReports = 0
  let running = false
  let cancel: (() => void) | undefined
  let recordFailures = 0
  let lastRecordFailure: string | null = null
  /** 记录写入是否已经失败过：失败本身就是"存储坏了"的证据，要按 disk-full 处理。 */
  let storeBroken = false

  /**
   * 记录一次降级过渡。
   * **失败不吞**：计数 + 记住原因（stats 里可见），并把 %%storeBroken%% 置位 —— 下一次判定就会按
   * disk-full 降级。为什么不让它直接抛：抛出去会打断整轮判定（连风控状态都不再更新），
   * 而"审计写不进去"的正确反应是**停止新增风险 + 大声可见**，不是让 desk 停摆。
   */
  const recordOrCount = (write: () => void): void => {
    try {
      write()
    } catch (error) {
      recordFailures += 1
      lastRecordFailure = error instanceof Error ? error.message : String(error)
      storeBroken = true
    }
  }

  /** 当前状态里某标的的对齐态（没有则视为 aligned）。 */
  const alignmentOfState = (symbol: string): string => state.symbols[symbol]?.alignment ?? 'aligned'

  const tickOnce = (): DeskTickResult => {
    const atMs = options.now()
    ticks += 1
    // 先落心跳再判定：宁可让人看到"还在跳但已降级"，也不要让看门狗因为一次长判定误判失活
    if (options.heartbeatPath !== undefined) writeHeartbeat(options.heartbeatPath, { atMs, note: 'desk tick ' + String(ticks) })
    const scan = scanDegradation(options.signals())
    // 记录写入失败过 ⇒ 这条证据必须并进本轮的触发源（审计写不进去就等于盘坏了）
    const triggers: DegradationTrigger[] = storeBroken && !scan.triggers.includes('disk-full') ? [...scan.triggers, 'disk-full'] : [...scan.triggers]
    let written = 0

    for (const trigger of triggers) {
      const symbols = scan.symbolsByTrigger[trigger] ?? []
      if (symbols.length > 0) {
        // 单标的故障：只降级这些标的（#24 不牵连全局）
        for (const symbol of symbols) {
          if (alignmentOfState(symbol) === 'stale') continue
          const decision = decideDegradation({ trigger, symbol })
          state = applyRiskEvent(state, { scope: 'symbol', kind: 'alignment', symbol, alignment: 'stale', atMs }, options.gate).state
          recordOrCount(() => recordDegradation(options.journal, { trigger, from: 'aligned', to: 'stale', reason: decision.reason + ' (' + symbol + ')', atMs }))
          written += 1
        }
        continue
      }
      // 全局故障：降到 decideDegradation 给的档位（自动触发封顶 reduce_only）
      const decision = decideDegradation({ trigger })
      if (decision.mode === 'normal') continue
      // fail-safe：自动触发**封顶 reduce_only**（#25）。decideDegradation 已经保证自动路径不产 halt，
      // 这里再挡一道 —— 万一将来的策略改动放进 halt，宁可多降一级，也不许自动路径拿到最严档位，
      // 因为 halt 的前提（venue 侧保护性订单）不一定成立，那时最严状态会变成陷阱。
      const autoLevel = decision.mode === 'halt' ? 'reduce_only' : decision.mode
      if (state.level === autoLevel) continue
      const from = state.level
      state = applyRiskEvent(state, { scope: 'desk', kind: 'desk-level', level: autoLevel, atMs, reason: decision.reason }, options.gate).state
      recordOrCount(() => recordDegradation(options.journal, { trigger, from, to: state.level, reason: decision.reason, atMs }))
      written += 1
    }

    // 恢复：本轮没有任何触发源 ⇒ 把降过的都提回来（自愈而非闩锁，#24）
    if (triggers.length === 0) {
      for (const [symbol, risk] of Object.entries(state.symbols)) {
        if (risk.alignment === 'stale') {
          state = applyRiskEvent(state, { scope: 'symbol', kind: 'alignment', symbol, alignment: 'aligned', atMs }, options.gate).state
          recordOrCount(() => recordDegradation(options.journal, { trigger: 'market-stale', from: 'stale', to: 'aligned', reason: 'fresh snapshot accepted: back to aligned', atMs }))
          written += 1
        }
      }
      if (state.level === 'reduce_only' || state.level === 'caution') {
        const from = state.level
        state = applyRiskEvent(state, { scope: 'desk', kind: 'desk-level', level: 'normal', atMs, reason: 'all signals healthy: back to normal' }, options.gate).state
        recordOrCount(() => recordDegradation(options.journal, { trigger: 'recovered', from, to: state.level, reason: 'all signals healthy', atMs }))
        written += 1
      }
    }

    transitions += written
    return { triggers, state, transitions: written }
  }

  const arm = (): void => {
    cancel = options.scheduler.schedule(() => {
      tickOnce()
      if (running) arm()
    }, options.intervalMs)
  }

  return {
    start() {
      if (running) return
      running = true
      arm()
    },
    stop() {
      running = false
      cancel?.()
      cancel = undefined
    },
    tickOnce,
    onReconnect(window) {
      const collected = collectGapReport({ orders: options.orders, audit: options.audit }, window)
      // 报告本身也进 journal：否则"产出过一份 gap report"这件事在事后无法证明
      options.journal.append('gap.report', { ...collected.report, missingInputs: collected.missingInputs }, window.reconnectedAtMs)
      gapReports += 1
      return collected.report
    },
    stats: () => ({ ticks, transitions, gapReports, running, recordFailures, lastRecordFailure }),
    openAllowed: (symbol) => openRiskAllowedFor(state, symbol, options.now()),
  }
}
