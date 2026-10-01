/**
 * 行情对齐状态机（P3 步骤 4）：epoch 世代、先缓冲后发布、全局界、独立限频预算、
 * 静默分歧探测器。
 *
 * 六条硬要求（卡片原文）与落点：
 *   1. 两条通道都带**世代号 epoch**；epoch 不一致 ⇒ 旧缓冲一律丢弃并重新快照。
 *   2. **先缓冲后发布**：快照未到之前 tick 只入缓冲，不对外发布（发出去就是让下游拿
 *      半张图做决定）。
 *   3. **快照自身也做年龄检查**：快照再新，放久了也是陈旧价格。
 *   4. **缓冲有全局界**：条数与字节双界；越界即丢最旧并强制重快照（不静默截断）。
 *   5. **快照与下单各自独立限频预算**：共享预算 = 打忙下单通道即可让 bot 降级（§13 #14）。
 *   6. **静默分歧探测器**：与 venue 心跳对账，相对差 > 配置 bps 连续 N 次 ⇒ DIVERGED
 *      + 强制重快照 + 按 STALE 对待。
 *
 * 三个上界参数（年龄预算 / 缓冲条数与字节 / 重对齐令牌桶容量）**必须先经
 * replay-harness 标定**才能写成常量——本模块不提供缺省值，调用方必须显式传入
 * （缺省猜测值会让"没标定"变成"看起来标定过"）。
 *
 * @module @dshtrading/tractl/alignment
 */
import { PRICE_ALIGNMENTS, type Alignment } from './risk-gate.ts'

/** 一条行情 tick。 */
export interface Tick {
  readonly epoch: number
  readonly symbol: string
  readonly price: number
  readonly atMs: number
  /** 交易所侧序号（判断乱序用）。 */
  readonly seq: number
}

/** 一次快照。 */
export interface Snapshot {
  readonly epoch: number
  readonly symbol: string
  readonly price: number
  readonly atMs: number
}

/** 上界与阈值——**没有缺省值**，必须由 harness 标定后显式传入。 */
export interface AlignmentParams {
  /** 快照年龄预算（超过即 stale）。 */
  readonly snapshotAgeBudgetMs: number
  /** 缓冲全局界：条数。 */
  readonly bufferMaxTicks: number
  /** 缓冲全局界：字节（按每条 128B 估）。 */
  readonly bufferMaxBytes: number
  /** 重对齐令牌桶：容量与每秒回填。 */
  readonly realignTokenCapacity: number
  readonly realignRefillPerSec: number
  /** 分歧阈值（bps）与连续次数。 */
  readonly divergenceBps: number
  readonly divergenceStrikes: number
  /** 下单侧预算与快照侧**完全独立**（§13 #14）。 */
  readonly orderTokenCapacity: number
  readonly orderRefillPerSec: number
}

/** 单独的令牌桶（快照与下单各一个实例，互不影响）。 */
export function createTokenBucket(capacity: number, refillPerSec: number, atMs: number): {
  take(atMs: number): boolean
  available(atMs: number): number
} {
  let tokens = capacity
  let lastMs = atMs
  const refill = (nowMs: number): void => {
    const elapsed = Math.max(0, nowMs - lastMs)
    tokens = Math.min(capacity, tokens + (elapsed / 1000) * refillPerSec)
    lastMs = nowMs
  }
  return {
    take(nowMs) {
      refill(nowMs)
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
    available(nowMs) {
      refill(nowMs)
      return tokens
    },
  }
}

/** 一次 tick 的处理结果。 */
export interface TickOutcome {
  readonly published: readonly Tick[]
  readonly buffered: number
  readonly dropped: number
  readonly reason: string
}

/** 对齐状态（可读快照，便于审计与测试）。 */
export interface AlignmentSnapshot {
  readonly epoch: number | null
  readonly alignment: Alignment
  readonly buffered: number
  readonly bytes: number
  readonly divergenceStrikes: number
  readonly forcedResnapshots: number
  readonly droppedTicks: number
}

/** 事件日志（provenance：判定要能重建，卡片的审计要求）。 */
export interface AlignmentEvent {
  readonly atMs: number
  readonly kind: 'snapshot' | 'tick' | 'divergence' | 'stale' | 'drop' | 'realign'
  readonly detail: string
}

const BYTES_PER_TICK = 128

/**
 * 建一个对齐状态机。
 * @param params - 标定过的上界参数（无缺省）。
 * @param startedAtMs - 起始时刻（注入时钟）。
 */
export function createAlignment(params: AlignmentParams, startedAtMs: number): {
  onSnapshot(snapshot: Snapshot, atMs: number): { accepted: boolean; reason: string; published: readonly Tick[] }
  onTick(tick: Tick, atMs: number): TickOutcome
  onHeartbeat(venuePrice: number, ourPrice: number, atMs: number): { diverged: boolean; strikes: number; bps: number }
  requestRealign(atMs: number): { granted: boolean; reason: string }
  placeOrder(atMs: number): { granted: boolean; reason: string }
  state(atMs: number): AlignmentSnapshot
  events(): readonly AlignmentEvent[]
} {
  let epoch: number | null = null
  let alignment: Alignment = 'unaligned'
  let buffer: Tick[] = []
  let snapshotAtMs: number | null = null
  let divergenceStrikes = 0
  let forcedResnapshots = 0
  let droppedTicks = 0
  let lastSeq = -1
  const realignBucket = createTokenBucket(params.realignTokenCapacity, params.realignRefillPerSec, startedAtMs)
  const orderBucket = createTokenBucket(params.orderTokenCapacity, params.orderRefillPerSec, startedAtMs)
  const log: AlignmentEvent[] = []
  const note = (atMs: number, kind: AlignmentEvent['kind'], detail: string): void => {
    log.push({ atMs, kind, detail })
  }

  const freshEnough = (atMs: number): boolean => snapshotAtMs !== null && atMs - snapshotAtMs <= params.snapshotAgeBudgetMs

  const enforceBounds = (atMs: number): void => {
    const tooMany = buffer.length > params.bufferMaxTicks
    const tooBig = buffer.length * BYTES_PER_TICK > params.bufferMaxBytes
    if (!tooMany && !tooBig) return
    buffer = []
    alignment = 'unaligned'
    forcedResnapshots += 1
    note(atMs, 'drop', 'buffer exceeded its global bound; buffer dropped and a resnapshot is required')
  }

  return {
    onSnapshot(snapshot, atMs) {
      if (epoch !== null && snapshot.epoch < epoch) {
        note(atMs, 'drop', 'snapshot epoch ' + String(snapshot.epoch) + ' is older than current epoch ' + String(epoch) + '; ignored')
        return { accepted: false, reason: 'stale-epoch', published: [] }
      }
      const epochChanged = epoch !== null && snapshot.epoch !== epoch
      epoch = snapshot.epoch
      snapshotAtMs = atMs
      // epoch 变了 ⇒ 旧缓冲一律丢弃（卡片原文）。
      buffer = epochChanged ? [] : buffer
      alignment = 'aligned'
      divergenceStrikes = 0
      note(atMs, 'snapshot', 'epoch ' + String(epoch) + (epochChanged ? ' (epoch changed: old buffer discarded)' : ''))
      // 先缓冲后发布的另一半：快照到齐后把同世代的缓冲按 seq 发出去。
      const flushed = buffer.slice().sort((left, right) => left.seq - right.seq)
      buffer = []
      if (flushed.length > 0) note(atMs, 'tick', 'flushed ' + String(flushed.length) + ' buffered tick(s) after the snapshot arrived')
      return { accepted: true, reason: epochChanged ? 'epoch-changed' : 'ok', published: flushed }
    },
    onTick(tick, atMs) {
      if (epoch !== null && tick.epoch !== epoch) {
        droppedTicks += 1
        alignment = 'unaligned'
        forcedResnapshots += 1
        note(atMs, 'drop', 'tick epoch ' + String(tick.epoch) + ' != channel epoch ' + String(epoch) + '; tick dropped and a resnapshot is required')
        return { published: [], buffered: buffer.length, dropped: 1, reason: 'epoch-mismatch' }
      }
      // 快照存在但已过期 ⇒ 陈旧价格，丢弃（不能拿旧价当新价用）。
      if (snapshotAtMs !== null && !freshEnough(atMs)) {
        droppedTicks += 1
        alignment = 'stale'
        note(atMs, 'stale', 'snapshot older than the age budget; tick dropped')
        return { published: [], buffered: buffer.length, dropped: 1, reason: 'snapshot-stale' }
      }
      // 还没有任何快照 ⇒ 先缓冲等快照（先缓冲后发布的前一半），不丢。
      // 乱序：序号回退的 tick 直接丢（它描述的是更早的价格，补进去只会污染序列）。
      if (tick.seq <= lastSeq) {
        droppedTicks += 1
        note(atMs, 'drop', 'out-of-order tick seq ' + String(tick.seq) + ' <= ' + String(lastSeq))
        return { published: [], buffered: buffer.length, dropped: 1, reason: 'out-of-order' }
      }
      lastSeq = tick.seq
      buffer = [...buffer, tick]
      enforceBounds(atMs)
      // 先缓冲后发布：只有 aligned 且缓冲未越界时才把这些 tick 发出去。
      if (alignment !== 'aligned') {
        return { published: [], buffered: buffer.length, dropped: 0, reason: 'buffered-only' }
      }
      const published = buffer
      buffer = []
      note(atMs, 'tick', 'published ' + String(published.length) + ' buffered tick(s)')
      return { published, buffered: 0, dropped: 0, reason: 'published' }
    },
    onHeartbeat(venuePrice, ourPrice, atMs) {
      const bps = ourPrice === 0 ? Number.POSITIVE_INFINITY : Math.abs(venuePrice - ourPrice) / ourPrice * 10_000
      if (bps > params.divergenceBps) {
        divergenceStrikes += 1
      } else {
        divergenceStrikes = 0
      }
      if (divergenceStrikes >= params.divergenceStrikes) {
        alignment = 'stale'
        buffer = []
        forcedResnapshots += 1
        note(atMs, 'divergence', 'diverged by ' + bps.toFixed(1) + ' bps for ' + String(divergenceStrikes) + ' consecutive checks: forced resnapshot, treated as stale')
        return { diverged: true, strikes: divergenceStrikes, bps }
      }
      return { diverged: false, strikes: divergenceStrikes, bps }
    },
    requestRealign(atMs) {
      const granted = realignBucket.take(atMs)
      if (!granted) {
        note(atMs, 'realign', 're-alignment token bucket is empty; request refused')
        return { granted: false, reason: 'realign-budget-exhausted' }
      }
      alignment = 'unaligned'
      note(atMs, 'realign', 're-alignment granted')
      return { granted: true, reason: 'ok' }
    },
    placeOrder(atMs) {
      // 下单预算与快照预算**完全独立**：快照洪泛不能把下单通道饿死。
      const granted = orderBucket.take(atMs)
      return granted ? { granted: true, reason: 'ok' } : { granted: false, reason: 'order-budget-exhausted' }
    },
    state(atMs) {
      const effective: Alignment = alignment === 'aligned' && !freshEnough(atMs) ? 'stale' : alignment
      return {
        epoch,
        alignment: effective,
        buffered: buffer.length,
        bytes: buffer.length * BYTES_PER_TICK,
        divergenceStrikes,
        forcedResnapshots,
        droppedTicks,
      }
    },
    events: () => log,
  }
}

/** 词汇必须是 risk-gate 的那一套（导入即证明，不是注释里的一句话）。 */
export const ALIGNMENT_VOCABULARY: readonly Alignment[] = PRICE_ALIGNMENTS
