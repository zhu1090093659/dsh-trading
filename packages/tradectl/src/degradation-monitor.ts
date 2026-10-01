/**
 * 降级检测层（P5 步骤 3 手册暴露的缺口：策略层完整、但**没有运行时消费它**）。
 *
 * 分工：%%degradation.ts%% 回答"给了触发源该怎么办"；本模块回答"**现在有哪些触发源**"。
 * 两者合起来才是一条能跑的链路 —— 此前 %%decideDegradation%% / %%buildGapReport%% 的调用点只有测试。
 *
 * 三条立场：
 *   1. **只做检测与映射，不做决策**：档位判定交回 %%decideDegradation%%（一个事实一个家）；
 *   2. **信号缺失 ≠ 正常**：拿不到心跳时间、拿不到对齐态时按"未知"处理并**如实报告**，不假装健康
 *      （%%unknownSignals%% 字段）—— 静默把未知当健康是这类系统最危险的默认值；
 *   3. **自动路径永不产 halt**：检测层只能产出可自动降级的触发源；%%out-of-band-halt%% 不在本层产出，
 *      它只由带外通道产生（设计 §13：自动路径上 halt 永不可达）。
 *
 * @module @dshtrading/tractl/degradation-monitor
 */
import type { Alignment } from './risk-gate.ts'
import type { DegradationTrigger } from './degradation.ts'

/** 检测层的输入信号（全部注入，便于测试与真实运行时替换）。 */
export interface MonitorSignals {
  /** 各标的当前价格对齐态；取不到就是 undefined（未知）。 */
  readonly alignmentOf: (symbol: string) => Alignment | undefined
  readonly symbols: readonly string[]
  /** 最近一次收到核心心跳的时间；undefined = 从未收到。 */
  readonly lastHeartbeatAtMs: number | undefined
  readonly heartbeatTimeoutMs: number
  /** 交易所报错连续次数与阈值。 */
  readonly venueErrorStreak: number
  readonly venueErrorThreshold: number
  /** 磁盘写入是否失败（由写入方上报，检测层不去猜）。 */
  readonly diskWriteFailed: boolean
  /**
   * 时钟漂移量（毫秒，由 clock-drift 检测器给出；负数=墙钟落后）。
   * 不给就是"没测"，**不等于没漂** —— 与其它未知信号同样处理（不假装健康）。
   */
  readonly clockDriftMs?: number | undefined
  /** 漂移容差；给了 clockDriftMs 但没给容差时按"未测"处理。 */
  readonly clockDriftToleranceMs?: number | undefined
  readonly now: () => number
}

export interface ScanResult {
  /** 本轮的触发源（去重、顺序稳定）。 */
  readonly triggers: readonly DegradationTrigger[]
  /** 携带标的的触发源所对应的标的（同一触发源可命中多只）。 */
  readonly symbolsByTrigger: Readonly<Record<string, readonly string[]>>
  /** 未知信号清单：这些项**没有**被判定为健康，只是判不了。 */
  readonly unknownSignals: readonly string[]
}

/**
 * 扫描一次信号，给出当前应处理的触发源。
 * @param signals - 注入的信号集合。
 */
export function scanDegradation(signals: MonitorSignals): ScanResult {
  const triggers: DegradationTrigger[] = []
  const symbolsByTrigger: Record<string, string[]> = {}
  const unknownSignals: string[] = []

  // ① 行情陈旧 / 未对齐：逐标的（只有取不到对齐态才算"未知"）
  const staleSymbols: string[] = []
  for (const symbol of signals.symbols) {
    const alignment = signals.alignmentOf(symbol)
    if (alignment === undefined) {
      unknownSignals.push('alignment:' + symbol)
      continue
    }
    if (alignment !== 'aligned') staleSymbols.push(symbol)
  }
  if (staleSymbols.length > 0) {
    triggers.push('market-stale')
    symbolsByTrigger['market-stale'] = staleSymbols
  }

  // ② 心跳失活（dead-man 的触发条件是**核心自己的心跳**，不是手机连不上）
  if (signals.lastHeartbeatAtMs === undefined) {
    unknownSignals.push('heartbeat')
  } else if (signals.now() - signals.lastHeartbeatAtMs > signals.heartbeatTimeoutMs) {
    triggers.push('heartbeat-lost')
  }

  // ③ 交易所连续报错
  if (signals.venueErrorStreak >= signals.venueErrorThreshold && signals.venueErrorThreshold > 0) {
    triggers.push('venue-error')
  }

  // ④ 磁盘写失败（由写入方上报）
  if (signals.diskWriteFailed) triggers.push('disk-full')

  // ⑤ 时钟漂移（由 clock-drift 检测器给出漂移量；没给就是没测 ⇒ 记未知而不是当健康）
  if (signals.clockDriftMs === undefined || signals.clockDriftToleranceMs === undefined) {
    unknownSignals.push('clock-drift')
  } else if (Math.abs(signals.clockDriftMs) > signals.clockDriftToleranceMs) {
    triggers.push('clock-drift')
  }

  return { triggers, symbolsByTrigger, unknownSignals }
}
