/**
 * 时钟漂移检测器测试：两条时钟互校，注入读数 ⇒ 无 sleep、无 mock 框架。
 */
import { describe, expect, it } from 'vitest'
import { createClockDriftDetector } from '../src/clock-drift.ts'

const T0 = 1_700_000_000_000
const M0 = 1_000_000

describe('时钟漂移检测器', () => {
  it('管理员：首个样本只做基线，不报漂移（避免启动瞬间误报）', () => {
    // Given 一个检测器
    const detector = createClockDriftDetector({ toleranceMs: 100 })
    // When 采第一个样本
    const first = detector.sample({ wallNowMs: T0, monotonicNowMs: M0 })
    // Then 无基线、不判漂移
    expect(first).toEqual({ driftMs: 0, drifted: false, hasBaseline: false })
  })

  it('管理员：两条时钟同步前进时不判漂移', () => {
    // Given 已建立基线
    const detector = createClockDriftDetector({ toleranceMs: 100 })
    detector.sample({ wallNowMs: T0, monotonicNowMs: M0 })
    // When 墙钟与单调钟都走了 1000ms
    const reading = detector.sample({ wallNowMs: T0 + 1_000, monotonicNowMs: M0 + 1_000 })
    // Then 漂移 0
    expect(reading.driftMs).toBe(0)
    expect(reading.drifted).toBe(false)
  })

  it('管理员：墙钟被拨快 5 秒 ⇒ 判漂移且给出漂移量', () => {
    // Given 已建立基线
    const detector = createClockDriftDetector({ toleranceMs: 100 })
    detector.sample({ wallNowMs: T0, monotonicNowMs: M0 })
    // When 单调钟走 1 秒，而墙钟跳了 6 秒（被 NTP 拨快 5 秒）
    const reading = detector.sample({ wallNowMs: T0 + 6_000, monotonicNowMs: M0 + 1_000 })
    // Then 漂移 5000ms、判漂移
    expect(reading.driftMs).toBe(5_000)
    expect(reading.drifted).toBe(true)
  })

  it('管理员：墙钟被拨慢同样判漂移（负数也要取绝对值）', () => {
    // Given 已建立基线
    const detector = createClockDriftDetector({ toleranceMs: 100 })
    detector.sample({ wallNowMs: T0, monotonicNowMs: M0 })
    // When 墙钟只走了 200ms 而单调钟走了 1 秒
    const reading = detector.sample({ wallNowMs: T0 + 200, monotonicNowMs: M0 + 1_000 })
    // Then 漂移 -800ms 且判漂移
    expect(reading.driftMs).toBe(-800)
    expect(reading.drifted).toBe(true)
  })

  it('管理员：单调钟倒退视为最大可疑（理论上它只会前进）', () => {
    // Given 已建立基线
    const detector = createClockDriftDetector({ toleranceMs: 100 })
    detector.sample({ wallNowMs: T0, monotonicNowMs: M0 })
    // When 单调钟倒退
    const reading = detector.sample({ wallNowMs: T0 + 100, monotonicNowMs: M0 - 500 })
    // Then 判漂移且漂移量明显超容差
    expect(reading.drifted).toBe(true)
    expect(Math.abs(reading.driftMs)).toBeGreaterThan(100)
  })

  it('管理员：reset 后需要重新建立基线（对过时之后不该拿旧基线比）', () => {
    // Given 已采过样本
    const detector = createClockDriftDetector({ toleranceMs: 100 })
    detector.sample({ wallNowMs: T0, monotonicNowMs: M0 })
    // When 重置后再采
    detector.reset()
    const afterReset = detector.sample({ wallNowMs: T0 + 999_999, monotonicNowMs: M0 })
    // Then 又是首样本（无基线、不判漂移）
    expect(afterReset.hasBaseline).toBe(false)
    expect(afterReset.drifted).toBe(false)
  })
})
