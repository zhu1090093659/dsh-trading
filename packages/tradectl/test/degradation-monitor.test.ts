/**
 * 降级检测层测试：信号 → 触发源。纯函数，注入时钟，无 sleep、无 mock 框架。
 */
import { describe, expect, it } from 'vitest'
import { scanDegradation, type MonitorSignals } from '../src/degradation-monitor.ts'

const T0 = 1_700_000_000_000

/** 契约：所有项都健康的信号集（各用例只改自己关心的那一项）。 */
function healthy(overrides: Partial<MonitorSignals> = {}): MonitorSignals {
  return {
    symbols: ['BTC/USDT'],
    alignmentOf: () => 'aligned',
    lastHeartbeatAtMs: T0,
    heartbeatTimeoutMs: 30_000,
    venueErrorStreak: 0,
    venueErrorThreshold: 3,
    diskWriteFailed: false,
    // 时钟漂移必须显式给出才算"已测"；不给就是未知（不假装健康）
    clockDriftMs: 0,
    clockDriftToleranceMs: 100,
    now: () => T0 + 1_000,
    ...overrides,
  }
}

describe('降级检测层', () => {
  it('管理员：全部健康时不产出任何触发源', () => {
    // Given 健康信号
    // When 扫描
    const result = scanDegradation(healthy())
    // Then 无触发源、无未知
    expect(result.triggers).toEqual([])
    expect(result.unknownSignals).toEqual([])
  })

  it('管理员：未对齐/陈旧的标的产出 market-stale，且只带那些标的', () => {
    // Given 两只标的，一只 stale 一只 aligned
    const result = scanDegradation(healthy({
      symbols: ['BTC/USDT', 'ETH/USDT'],
      alignmentOf: (symbol) => (symbol === 'BTC/USDT' ? 'stale' : 'aligned'),
    }))
    // When/Then 触发源只带 stale 那只（减风险要精确到标的）
    expect(result.triggers).toEqual(['market-stale'])
    expect(result.symbolsByTrigger['market-stale']).toEqual(['BTC/USDT'])
  })

  it('管理员：心跳超时产出 heartbeat-lost（dead-man 判的是核心自己的心跳）', () => {
    // Given 心跳已超过阈值
    const result = scanDegradation(healthy({ lastHeartbeatAtMs: T0 - 60_000, now: () => T0 }))
    // When/Then 命中
    expect(result.triggers).toContain('heartbeat-lost')
  })

  it('管理员：从未收到心跳算"未知"而不是"健康"', () => {
    // Given 从未有过心跳
    const result = scanDegradation(healthy({ lastHeartbeatAtMs: undefined }))
    // When/Then 不产触发源，但**如实报告未知**（静默把未知当健康是最危险的默认值）
    expect(result.triggers).not.toContain('heartbeat-lost')
    expect(result.unknownSignals).toContain('heartbeat')
  })

  it('管理员：取不到对齐态算"未知"，不当成 aligned', () => {
    // Given 对齐态取不到
    const result = scanDegradation(healthy({ alignmentOf: () => undefined }))
    // When/Then 报告未知，且**不**误报 market-stale
    expect(result.triggers).toEqual([])
    expect(result.unknownSignals).toEqual(['alignment:BTC/USDT'])
  })

  it('管理员：交易所连续报错达到阈值才触发；磁盘写失败立即触发', () => {
    // Given 未达阈值 / 达到阈值 / 磁盘写失败
    const below = scanDegradation(healthy({ venueErrorStreak: 2 }))
    const at = scanDegradation(healthy({ venueErrorStreak: 3 }))
    const disk = scanDegradation(healthy({ diskWriteFailed: true }))
    // When/Then 边界正确
    expect(below.triggers).toEqual([])
    expect(at.triggers).toContain('venue-error')
    expect(disk.triggers).toContain('disk-full')
  })

  it('管理员：检测层永不产出带外 halt（自动路径上 halt 永不可达）', () => {
    // Given 所有信号同时恶化
    const result = scanDegradation(healthy({
      symbols: ['BTC/USDT'],
      alignmentOf: () => 'stale',
      lastHeartbeatAtMs: T0 - 999_999,
      venueErrorStreak: 99,
      diskWriteFailed: true,
    }))
    // When/Then 触发源里只有可自动降级的那些
    expect(result.triggers).not.toContain('out-of-band-halt')
    expect(result.triggers.sort()).toEqual(['disk-full', 'heartbeat-lost', 'market-stale', 'venue-error'])
  })

  it('管理员：时钟漂移超容差 ⇒ 触发；未测 ⇒ 记未知而不是当健康', () => {
    // Given 漂移 500ms、容差 100ms
    const drifted = scanDegradation(healthy({ clockDriftMs: 500, clockDriftToleranceMs: 100 }))
    // When/Then 命中触发源
    expect(drifted.triggers).toContain('clock-drift')
    // Given 完全没给漂移读数
    const notMeasured = scanDegradation(healthy({ clockDriftMs: undefined, clockDriftToleranceMs: undefined }))
    // Then 记未知（静默当健康是这类系统最危险的默认值）
    expect(notMeasured.triggers).not.toContain('clock-drift')
    expect(notMeasured.unknownSignals).toContain('clock-drift')
    // Given 只给漂移量、没给容差
    const noTolerance = scanDegradation(healthy({ clockDriftToleranceMs: undefined }))
    // Then 同样算未测
    expect(noTolerance.unknownSignals).toContain('clock-drift')
  })

  it('管理员：容差边界——等于容差不触发、超过才触发', () => {
    // Given 漂移恰好等于容差 / 超过 1ms
    const atLimit = scanDegradation(healthy({ clockDriftMs: 100, clockDriftToleranceMs: 100 }))
    const overLimit = scanDegradation(healthy({ clockDriftMs: 101, clockDriftToleranceMs: 100 }))
    // Then 严格大于才触发
    expect(atLimit.triggers).not.toContain('clock-drift')
    expect(overLimit.triggers).toContain('clock-drift')
  })})
