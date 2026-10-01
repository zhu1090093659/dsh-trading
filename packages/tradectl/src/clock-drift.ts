/**
 * 时钟漂移检测（降级触发源 %%)%%clock-drift%% 的**检测**半边）。
 *
 * 设计 §13 要求"以核心时钟为准"，但**谁来发现时钟漂了**此前没人管：%%scanDegradation%% 只有 %%now()%%，
 * 而 %%now()%% 自己就是被怀疑的对象。所以这里用**两条独立时钟**互校：
 *   - %%wallNow%%：墙上时钟（会被人调、会被 NTP 拨）；
 *   - %%monotonicNow%%：单调时钟（%%process.hrtime.bigint()%% 之类，只会前进）。
 * 两者的**增量**若显著不一致，说明墙上时钟被动过 —— 而按墙钟算的年龄预算、窗口切分都会因此失真。
 *
 * 三条立场：
 *   1. **首样本只做基线**：没有前一个样本就没有"增量"，此时报 0 而不是报漂移（避免启动瞬间误报）；
 *   2. **单调钟倒退视为异常**：单调钟理论上不倒退；倒退说明实现或环境有问题，按**最大可疑**处理；
 *   3. **只报告不决策**：是否降级由 %%decideDegradation%% 定（一个事实一个家）。
 *
 * @module @dshtrading/tractl/clock-drift
 */
export interface ClockSample {
  readonly wallNowMs: number
  readonly monotonicNowMs: number
}

export interface ClockDriftDetectorOptions {
  /** 容差：两次采样之间 |Δ墙钟 − Δ单调钟| 超过它才算漂移（毫秒）。 */
  readonly toleranceMs: number
}

export interface DriftReading {
  /** 相对单调钟的漂移量（毫秒）；正数表示墙钟跑得快。 */
  readonly driftMs: number
  /** 是否超过容差。 */
  readonly drifted: boolean
  /** 是否已有基线（首个样本必然 false）。 */
  readonly hasBaseline: boolean
}

/**
 * 建一个漂移检测器（纯内存状态，注入两条时钟的读数）。
 * @param options - 容差。
 */
export function createClockDriftDetector(options: ClockDriftDetectorOptions): {
  sample(reading: ClockSample): DriftReading
  /** 重新建立基线（例如刚刚对过时之后）。 */
  reset(): void
} {
  let previous: ClockSample | undefined
  return {
    sample(reading) {
      if (previous === undefined) {
        previous = reading
        return { driftMs: 0, drifted: false, hasBaseline: false }
      }
      const wallDelta = reading.wallNowMs - previous.wallNowMs
      const monotonicDelta = reading.monotonicNowMs - previous.monotonicNowMs
      previous = reading
      // 单调钟倒退：按最大可疑处理（用一个明显超容差的值），并在 drifted 上如实反映
      if (monotonicDelta < 0) {
        return { driftMs: Math.abs(monotonicDelta) + options.toleranceMs + 1, drifted: true, hasBaseline: true }
      }
      const driftMs = wallDelta - monotonicDelta
      return { driftMs, drifted: Math.abs(driftMs) > options.toleranceMs, hasBaseline: true }
    },
    reset() {
      previous = undefined
    },
  }
}
