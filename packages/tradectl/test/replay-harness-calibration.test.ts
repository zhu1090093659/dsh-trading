/**
 * 标定口径的 harness 能力测试（设计 §3 门禁 / §13 不变量 #23）。
 *
 * 三个上界要"按实测取数"，前提是 harness 能把实测出全：年龄的**分布**（不只是 max）、
 * 缓冲的**全局**峰值（不只是单标的切片）、重对齐的**需求曲线**（不只是总次数）。
 * 本文件逐条钉住这三件事，外加一处曾经少算的计数（快照到达后补发的缓冲 tick）。
 * 纯函数 + 注入时钟，无 mock 无 sleep。
 */
import { describe, expect, it } from 'vitest'
import {
  calibrate,
  peakDemandInWindow,
  percentile,
  runMultiSymbolScenario,
  runScenario,
  summarizeAgeSamples,
  type AlignmentParams,
  type HarnessScenario,
  type MultiSymbolScenario,
} from '../src/replay-harness.ts'

const BTC = 'BTC/USDT'
const ETH = 'ETH/USDT'

/** 标定期间的基参数（阈值与下单预算不是本次标定对象）。 */
const BASE = { realignRefillPerSec: 1, divergenceBps: 50, divergenceStrikes: 2, orderTokenCapacity: 2, orderRefillPerSec: 1 }
/** 测峰值时必须无界：界会截断观测，测到的就成了界而不是需求。 */
const UNBOUNDED: AlignmentParams = { ...BASE, snapshotAgeBudgetMs: 1_000_000, bufferMaxTicks: 1_000_000, bufferMaxBytes: 128_000_000, realignTokenCapacity: 1_000 }

/** 健康路径：周期刷新 + 到达抖动（0/300ms 交替 ⇒ 刷新间隔在 4.7s 与 5.3s 之间）。 */
const healthy: MultiSymbolScenario = {
  name: 'healthy-jitter-20s',
  durationMs: 20_000,
  snapshotBurst: 0,
  feeds: [BTC, ETH].map((symbol) => ({
    symbol,
    snapshotDelayMs: 300,
    snapshotRefreshMs: 5_000,
    tickEveryMs: 100,
    snapshotDelaysMs: [300, 0],
  })),
}

/** 断供：两只标的在 4s 内没有基准、各按 50 条/秒洪泛。 */
const starved: MultiSymbolScenario = {
  name: 'starved-flood-4s',
  durationMs: 5_000,
  snapshotBurst: 0,
  feeds: [BTC, ETH].map((symbol) => ({
    symbol,
    snapshotDelayMs: 4_000,
    snapshotRefreshMs: 0,
    tickEveryMs: 1_000,
    tickFloodPerSec: 49,
  })),
}

/** 重连风暴：三次重连（退避梯子给的是具体时刻），每次换世代都要重新快照。 */
const storm: HarnessScenario = {
  name: 'reconnect-storm-3',
  symbol: BTC,
  durationMs: 8_000,
  tickEveryMs: 100,
  snapshotDelayMs: 100,
  outOfOrderEvery: 0,
  epochChanges: 3,
  epochChangeAtMs: [1_000, 3_000, 7_000],
  tickFloodPerSec: 0,
  snapshotBurst: 0,
  realignOnEpochChange: true,
}

describe('标定口径的百分位与需求窗口', () => {
  it('管理员：百分位取最近秩（确定性；空样本为 0）', () => {
    // Given 1..10 的样本
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    // When 取 p50 与 p99
    const p50 = percentile(samples, 50)
    const p99 = percentile(samples, 99)
    // Then 最近秩分别落在第 5 与第 10 个样本，空样本退化为 0
    expect(p50).toBe(5)
    expect(p99).toBe(10)
    expect(percentile([], 50)).toBe(0)
  })

  it('管理员：回填窗口的峰值需求是"任意一个窗口内最多几次"（决定桶要多大）', () => {
    // Given 请求时刻 0/999/1000/1500ms 与一组均匀铺开的请求
    const atMs = [0, 999, 1_000, 1_500]
    const spread = [0, 1_001, 2_002]
    // When 以 1s 为窗口求峰值需求
    const peak = peakDemandInWindow(atMs, 1_000)
    // Then 窗口可以锚在任何时刻：[999,1999) 内有 3 次；同刻的重复请求各算一次；均匀铺开则峰值 1
    expect(peak).toBe(3)
    expect(peakDemandInWindow([500, 500, 500], 1_000)).toBe(3)
    expect(peakDemandInWindow(spread, 1_000)).toBe(1)
    expect(peakDemandInWindow([], 1_000)).toBe(0)
  })
})

describe('标定口径的快照年龄分布', () => {
  it('管理员：健康路径给出年龄分位，最大年龄落在"刷新节奏 + 到达抖动"带内', { timeout: 30_000 }, () => {
    // Given 两只标的、刷新 5s、到达抖动 0/300ms 交替、回放 20s
    // When 回放并取年龄分位
    const metrics = runMultiSymbolScenario(UNBOUNDED, healthy)
    const age = summarizeAgeSamples(metrics.snapshotAgeSamplesMs)
    // Then 有样本、分位单调，且最大年龄不超过"刷新 + 抖动"、又确实超过纯刷新节奏
    expect(age.count).toBeGreaterThan(0)
    expect(age.p50).toBeLessThanOrEqual(age.p99)
    expect(age.p99).toBeLessThanOrEqual(age.max)
    expect(age.max).toBeGreaterThan(5_000 - 100)
    expect(age.max).toBeLessThanOrEqual(5_000 + 300)
  })
})

describe('标定口径的缓冲峰值（每标的 vs 全局）', () => {
  it('管理员：全局峰值是各标的峰值之和，单标的切片不能拿来标全局界', { timeout: 30_000 }, () => {
    // Given 两只标的断供、各 50 条/秒洪泛、基准 4s 后才到
    // When 回放并读每标的与全局峰值
    const metrics = runMultiSymbolScenario(UNBOUNDED, starved)
    const btc = metrics.bySymbol[BTC]!
    const eth = metrics.bySymbol[ETH]!
    // Then 到达前各缓冲 200 条（4 步 × 50），全局峰值是二者之和 400 条
    expect(btc.maxBufferTicks).toBe(200)
    expect(eth.maxBufferTicks).toBe(200)
    expect(metrics.maxBufferTicks).toBe(200)
    expect(metrics.maxGlobalBufferTicks).toBe(400)
    expect(metrics.maxGlobalBufferBytes).toBe(400 * 128)
  })

  it('管理员：calibrate 的缓冲建议值按全局峰值取，且证据行点名全局口径', { timeout: 30_000 }, () => {
    // Given 一个两只标的都断供的洪泛场景
    // When 用 calibrate 标定
    const result = calibrate(BASE, [starved], 1.5)
    const measured = result.measured[0]!
    // Then 建议值不小于全局峰值（而全局峰值严格大于单标的切片）
    expect(measured.maxGlobalBufferTicks).toBeGreaterThan(measured.maxBufferTicks)
    expect(result.suggested.bufferMaxTicks).toBeGreaterThanOrEqual(measured.maxGlobalBufferTicks)
    expect(result.evidence.join(' ')).toContain('maxGlobalBufferedTicks')
  })
})

describe('标定口径的重连风暴与发布计数', () => {
  it('管理员：epoch 变更按给定时刻注入，每次换世代都记一次重对齐需求', { timeout: 30_000 }, () => {
    // Given 三次重连时刻 1s/3s/7s（退避梯子），每次换世代后请求重对齐
    // When 回放
    const metrics = runScenario(UNBOUNDED, storm)
    // Then 三次换世代事件、三次请求按时刻记全，且同一秒内只有一次需求
    const epochEvents = metrics.events.filter((event) => event.kind === 'snapshot' && event.detail.includes('epoch changed'))
    expect(epochEvents).toHaveLength(3)
    expect(metrics.realignRequestedAtMs).toEqual([1_000, 3_000, 7_000])
    expect(peakDemandInWindow(metrics.realignRequestedAtMs, 1_000)).toBe(1)
  })

  it('管理员：断供窗口里缓冲的 tick 在快照到达后计入发布（只数 onTick 会少算）', { timeout: 30_000 }, () => {
    // Given 单标的、首张基准 1s 后才到、每 100ms 一条 tick、回放 2s
    const late: MultiSymbolScenario = {
      name: 'late-bootstrap',
      durationMs: 2_000,
      snapshotBurst: 0,
      feeds: [{ symbol: BTC, snapshotDelayMs: 1_000, snapshotRefreshMs: 0, tickEveryMs: 100 }],
    }
    // When 回放
    const metrics = runMultiSymbolScenario(UNBOUNDED, late)
    // Then 到达前 10 条只进缓冲，全部 21 条最终都在发布流里（10 条是补发的）
    expect(metrics.bySymbol[BTC]!.bufferedOnly).toBe(10)
    expect(metrics.publishedTicks).toBe(21)
  })
})
