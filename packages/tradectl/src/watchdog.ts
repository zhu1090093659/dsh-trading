/**
 * 快环看门狗（dead-man 第一层：**不依赖 agent 存活**）。
 *
 * 它只做一件事：读心跳文件，超过阈值就**喊一次**（onStale），恢复后再允许下一次。
 * 喊什么由调用方决定（A0 的 pause/kill、通知、写审计）—— 本模块不做决策，只做"发现失活"。
 *
 * 三条立场：
 *   1. **一次失活只喊一次**：反复喊会把通知通道和审计淹掉，而人只需要知道"它停了"；
 *   2. **心跳读不到 ≠ 心跳停了**：文件不存在或坏掉时**照失活处理**（fail-closed）—— dead-man 的
 *      误报代价是"多停一次"，漏报代价是"该停没停"，两者不对称；
 *   3. **恢复要留痕**：心跳回来后回调一次 onRecovered，否则事后只看到"停过"、看不到"回来了"。
 *
 * @module @dshtrading/tractl/watchdog
 */
import { readFileSync } from 'node:fs'
import type { PumpScheduler } from './pump.ts'

export interface WatchdogOptions {
  readonly heartbeatPath: string
  /** 超过这个时长没有新心跳即视为失活。 */
  readonly timeoutMs: number
  readonly scheduler: PumpScheduler
  readonly now: () => number
  /** 检查间隔（与超时阈值独立：检查可以更密，判定仍按阈值）。 */
  readonly intervalMs: number
  readonly onStale: (reason: string) => void
  readonly onRecovered?: ((silentMs: number) => void) | undefined
}

export interface WatchdogStats {
  readonly checks: number
  readonly staleEpisodes: number
  readonly recoveries: number
  readonly running: boolean
}

/** 读心跳；读不到/坏掉/无 atMs 一律返回 undefined（调用方按失活处理）。 */
function readHeartbeatAtMs(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { atMs?: unknown }
    return typeof parsed.atMs === 'number' && Number.isFinite(parsed.atMs) ? parsed.atMs : undefined
  } catch {
    return undefined
  }
}

export function createWatchdog(options: WatchdogOptions): {
  start(): void
  stop(): void
  checkOnce(): { stale: boolean; reason: string; silentMs: number | null }
  stats(): WatchdogStats
} {
  let checks = 0
  let staleEpisodes = 0
  let recoveries = 0
  let running = false
  let stale = false
  let cancel: (() => void) | undefined

  const checkOnce = (): { stale: boolean; reason: string; silentMs: number | null } => {
    checks += 1
    const atMs = options.now()
    const beatAtMs = readHeartbeatAtMs(options.heartbeatPath)
    const silentMs = beatAtMs === undefined ? null : atMs - beatAtMs
    const isStale = silentMs === null || silentMs > options.timeoutMs
    if (isStale) {
      if (!stale) {
        stale = true
        staleEpisodes += 1
        // 一次失活只喊一次
        options.onStale(
          silentMs === null
            ? '心跳读不到（文件缺失或内容损坏）：按失活处理（fail-closed）'
            : '心跳静默 ' + String(silentMs) + 'ms，超过阈值 ' + String(options.timeoutMs) + 'ms',
        )
      }
      return { stale: true, reason: silentMs === null ? 'no-heartbeat' : 'heartbeat-stale', silentMs }
    }
    if (stale) {
      stale = false
      recoveries += 1
      options.onRecovered?.(silentMs ?? 0)
    }
    return { stale: false, reason: 'fresh', silentMs }
  }

  const arm = (): void => {
    cancel = options.scheduler.schedule(() => {
      checkOnce()
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
    checkOnce,
    stats: () => ({ checks, staleEpisodes, recoveries, running }),
  }
}
