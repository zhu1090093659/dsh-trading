/**
 * 事件泵（P3 步骤 3 的进程内驱动）：把「到点判定 → 扇出 → 记账 → 排下一次」跑起来。
 *
 * 为什么需要一个泵：%%dueOccurrences%% / %%markFired%% / %%advanceSchedule%% 都是纯函数式的零件，
 * 而**没有任何东西在推动它们** —— 触发器只在测试里被手动 tick 过。真实运行需要一个驱动器。
 *
 * 三条设计立场：
 *   1. **不重造策略**：泵只做"推进 + 记账"，扇出交给注入的 %%dispatch%%（生产用 %%createThrottledFanout%%，
 *      测试用受控假件）。错过是否降级为 reduce_only 属于触发器策略，泵不重复判断 —— 一个事实一个家。
 *   2. **调度器可注入**：与 ws-feed 同一套做法，测试里把"等 30 秒"变成"取出回调来跑"，因此**无 sleep**。
 *   3. **单次失败不许停机**：扇出抛错时标记该 occurrence 为 failed 并继续排下一次 —— 泵在第一次
 *      网络抖动后静默停摆，是最危险的一种故障（界面看起来一切正常，触发器再也不响）。
 *
 * @module @dshtrading/tractl/pump
 */
import type { DatabaseSync } from 'node:sqlite'
import { advanceSchedule, dueOccurrences, markFired, type Occurrence } from './triggers.ts'

/** 调度端口：真实实现用 setTimeout；测试注入可手工推进的调度器。 */
export interface PumpScheduler {
  schedule(callback: () => void, delayMs: number): () => void
}

/** 一次泵运行的统计。 */
export interface PumpStats {
  readonly ticks: number
  readonly dispatched: number
  readonly failed: number
  readonly lastTickAtMs: number | null
  readonly running: boolean
}

export interface TriggerPumpOptions {
  readonly db: DatabaseSync
  /** 扇出：生产传 createThrottledFanout(...).send；测试传受控假件。 */
  readonly dispatch: (sessionId: string, occurrences: readonly Occurrence[]) => Promise<unknown>
  /** 触发时对话的会话 id（P3 卡片：经 ctx.agents.get(deskSessionId).followup 扇出）。 */
  readonly deskSessionId: string
  readonly scheduler: PumpScheduler
  readonly now: () => number
  /** 泵的检查间隔（不是触发精度：到点判定由 dueOccurrences 按 nextAtMs 决定）。 */
  readonly intervalMs: number
  /**
   * 积压告警阈值（不改派发语义，只让它可见）。
   * 停机久了会一次性补发很多条：实测 5 秒间隔停一天 ⇒ 查询上限 1000 条。
   * 超过阈值时通过 onBacklog 报出来，便于人（或后续策略）决定是否启用折叠。
   */
  readonly backlogWarnThreshold?: number | undefined
  readonly onBacklog?: ((info: { readonly due: number; readonly atMs: number }) => void) | undefined
}

/**
 * 建一个事件泵。**start() 之后必须 stop()**，否则调度器里的链不会断。
 * @param options - 库、扇出、调度器与时间。
 */
export function createTriggerPump(options: TriggerPumpOptions): {
  start(): void
  stop(): void
  stats(): PumpStats
  /** 单轮推进（测试与手动驱动用；返回本轮处理的 occurrence 条数）。 */
  pumpOnce(): Promise<number>
} {
  let ticks = 0
  let dispatched = 0
  let failed = 0
  let lastTickAtMs: number | null = null
  let running = false
  let cancel: (() => void) | undefined

  const arm = (): void => {
    cancel = options.scheduler.schedule(() => {
      void pumpOnce().finally(() => {
        if (running) arm()
      })
    }, options.intervalMs)
  }

  const pumpOnce = async (): Promise<number> => {
    const atMs = options.now()
    ticks += 1
    lastTickAtMs = atMs
    const due = dueOccurrences(options.db, atMs)
    // 积压可见化（**不改派发语义**）：停机久了补发条数会很多，必须让人看得见
    const backlogWarnAt = options.backlogWarnThreshold ?? 200
    if (due.length >= backlogWarnAt) options.onBacklog?.({ due: due.length, atMs })
    if (due.length === 0) return 0
    try {
      await options.dispatch(options.deskSessionId, due)
      // 成功：逐条记账并排下一次（间隔型）—— 记账发生在**扇出成功之后**，
      // 这样"扇出失败"不会把 occurrence 记成已触发（宁可下次重来，也不要静默丢失）。
      for (const occurrence of due) {
        markFired(options.db, occurrence, atMs, 'fired')
        advanceSchedule(options.db, occurrence.scheduleId, occurrence.dueAtMs, atMs)
        dispatched += 1
      }
    } catch {
      for (const occurrence of due) {
        markFired(options.db, occurrence, atMs, 'failed')
        // **失败也要推进排期**（第一版漏了这一步，被测试抓出来）：
        // 不推进的话，该 occurrence 永远停在"已失败"且 nextAt 留在过去 ——
        // 既不会重试（dueOccurrences 跳过已记录的 due_at），也不会走到下一个间隔。
        // 推进之后语义是：这一次算失败并留痕（不静默消失），下一次按原节奏继续。
        advanceSchedule(options.db, occurrence.scheduleId, occurrence.dueAtMs, atMs)
        failed += 1
      }
    }
    return due.length
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
    stats: () => ({ ticks, dispatched, failed, lastTickAtMs, running }),
    pumpOnce,
  }
}
