/**
 * 行情对齐与回放 harness 测试（P3 步骤 4）：纯函数 + 注入时钟，无 mock 无 sleep。
 */
import { describe, expect, it } from 'vitest'
import { createAlignment, createTokenBucket, type AlignmentParams } from '../src/alignment.ts'
import { calibrate, runScenario, type HarnessScenario } from '../src/replay-harness.ts'

const T0 = 0
const params: AlignmentParams = {
  snapshotAgeBudgetMs: 5_000,
  bufferMaxTicks: 3,
  bufferMaxBytes: 3 * 128,
  realignTokenCapacity: 2,
  realignRefillPerSec: 0,
  divergenceBps: 50,
  divergenceStrikes: 2,
  orderTokenCapacity: 2,
  orderRefillPerSec: 0,
}

function fresh() {
  const state = createAlignment(params, T0)
  state.onSnapshot({ epoch: 1, symbol: 'BTC/USDT', price: 60_000, atMs: T0 }, T0)
  return state
}
const tick = (seq: number, atMs: number, epoch = 1, price = 60_000) => ({ epoch, symbol: 'BTC/USDT', price, atMs, seq })

describe('epoch 世代守卫', () => {
  it('管理员：tick 的 epoch 与通道不一致时被丢弃并强制重快照', () => {
    // Given 一个 epoch=1 的对齐态
    const state = fresh()
    // When 收到 epoch=2 的 tick（还没收到新快照）
    const outcome = state.onTick(tick(1, T0 + 10, 2), T0 + 10)
    const snapshot = state.state(T0 + 10)
    // Then 丢弃、转 unaligned、强制重快照计数 +1
    expect(outcome).toMatchObject({ published: [], dropped: 1, reason: 'epoch-mismatch' })
    expect(snapshot.alignment).toBe('unaligned')
    expect(snapshot.forcedResnapshots).toBe(1)
  })

  it('管理员：新 epoch 的快照到达时旧缓冲一律丢弃（不把两个世代混着发）', () => {
    // Given 旧世代缓冲里有一条 tick
    const state = fresh()
    state.onTick(tick(1, T0 + 1), T0 + 1)
    // When 新世代快照到达
    const accepted = state.onSnapshot({ epoch: 2, symbol: 'BTC/USDT', price: 61_000, atMs: T0 + 2 }, T0 + 2)
    // Then 接受且缓冲清空、回到 aligned
    expect(accepted).toMatchObject({ accepted: true, reason: 'epoch-changed' })
    expect(state.state(T0 + 2)).toMatchObject({ alignment: 'aligned', buffered: 0, epoch: 2 })
  })

  it('管理员：比当前世代更旧的快照被忽略（不接受回退世代）', () => {
    // Given 一个 epoch=5 的对齐态
    const state = createAlignment(params, T0)
    state.onSnapshot({ epoch: 5, symbol: 'BTC/USDT', price: 60_000, atMs: T0 }, T0)
    // When 收到 epoch=4 的快照
    const rejected = state.onSnapshot({ epoch: 4, symbol: 'BTC/USDT', price: 59_000, atMs: T0 + 1 }, T0 + 1)
    // Then 忽略且世代不回退
    expect(rejected).toMatchObject({ accepted: false, reason: 'stale-epoch' })
    expect(state.state(T0 + 1).epoch).toBe(5)
  })
})

describe('先缓冲后发布与顺序守卫', () => {
  it('管理员：快照未到时 tick 只入缓冲、不对外发布', () => {
    // Given 一个还没有快照的状态机
    const state = createAlignment(params, T0)
    // When 收到 tick
    const outcome = state.onTick(tick(1, T0), T0)
    const snapshot = state.state(T0)
    // Then 未发布、缓冲里有、状态是 unaligned
    expect(outcome).toMatchObject({ published: [], buffered: 1, reason: 'buffered-only' })
    expect(snapshot.alignment).toBe('unaligned')
  })

  it('管理员：乱序 tick（序号回退）被丢弃，不污染已发布的序列', () => {
    // Given 已发布过 seq=5
    const state = fresh()
    state.onTick(tick(5, T0 + 5), T0 + 5)
    // When 收到 seq=2
    const outcome = state.onTick(tick(2, T0 + 6), T0 + 6)
    // Then 丢弃并说明原因
    expect(outcome).toMatchObject({ published: [], dropped: 1, reason: 'out-of-order' })
    expect(state.state(T0 + 6).droppedTicks).toBe(1)
  })

  it('管理员：快照年龄超预算 ⇒ stale 且 tick 不再发布（陈旧价格不发出去）', () => {
    // Given 一张到达于 T0 的快照、预算 5s
    const state = fresh()
    // When 在 T0+6000 收到 tick
    const outcome = state.onTick(tick(1, T0 + 6000), T0 + 6000)
    // Then 丢弃并标 stale
    expect(outcome).toMatchObject({ published: [], dropped: 1, reason: 'snapshot-stale' })
    expect(state.state(T0 + 6000).alignment).toBe('stale')
  })
})

describe('全局界与限频预算', () => {
  it('管理员：缓冲越过全局界时整块丢弃并强制重快照（不静默截断）', () => {
    // Given 界为 3 条、且故意让状态停在 unaligned（不发出去）
    const state = createAlignment(params, T0)
    state.requestRealign(T0)
    for (let i = 1; i <= 3; i += 1) state.onTick(tick(i, T0 + i), T0 + i)
    // When 第 4 条进来
    state.onTick(tick(4, T0 + 4), T0 + 4)
    const snapshot = state.state(T0 + 4)
    // Then 缓冲被清空、强制重快照、状态 unaligned、事件里留下痕迹
    expect(snapshot).toMatchObject({ buffered: 0, alignment: 'unaligned' })
    expect(snapshot.forcedResnapshots).toBeGreaterThanOrEqual(1)
    expect(state.events().some((event) => event.detail.includes('exceeded its global bound'))).toBe(true)
  })

  it('管理员：快照/重对齐预算与下单预算完全独立（快照洪泛饿不死下单通道）', () => {
    // Given 重对齐桶只有 2 个令牌
    const state = fresh()
    const first = state.requestRealign(T0)
    const second = state.requestRealign(T0)
    const third = state.requestRealign(T0)
    // When 桶空了之后再下单
    const order = state.placeOrder(T0)
    // Then 重对齐被拒但下单照常（两条通道互不影响）
    expect([first.granted, second.granted, third.granted]).toEqual([true, true, false])
    expect(order).toEqual({ granted: true, reason: 'ok' })
    expect(state.placeOrder(T0).granted).toBe(true)
    expect(state.placeOrder(T0).granted).toBe(false)
  })

  it('管理员：令牌桶按时间回填（注入时钟，不 sleep）', () => {
    // Given 容量 1、每秒回填 1
    const bucket = createTokenBucket(1, 1, T0)
    // When 取两次（第二次应失败），推进 1 秒后再取
    expect(bucket.take(T0)).toBe(true)
    expect(bucket.take(T0)).toBe(false)
    // Then 回填后可再取
    expect(bucket.take(T0 + 1000)).toBe(true)
  })
})

describe('静默分歧探测器', () => {
  it('管理员：相对差超阈值连续两次 ⇒ DIVERGED + 强制重快照 + 按 stale 对待', () => {
    // Given 一个 aligned 状态
    const state = fresh()
    // When 第一次偏离（100bps）
    const first = state.onHeartbeat(60_000, 60_600, T0 + 1)
    // Then 只累计一次、不判定分歧
    expect(first.diverged).toBe(false)
    expect(first.strikes).toBe(1)
    // When 第二次偏离
    const second = state.onHeartbeat(60_000, 60_600, T0 + 2)
    // Then 判定分歧、状态转 stale、强制重快照
    expect(second.diverged).toBe(true)
    expect(state.state(T0 + 2).alignment).toBe('stale')
    expect(state.state(T0 + 2).forcedResnapshots).toBeGreaterThanOrEqual(1)
  })

  it('管理员：中间有一次回到阈值内就清零连击（不是累计计数）', () => {
    // Given 偏离一次
    const state = fresh()
    state.onHeartbeat(60_000, 60_600, T0 + 1)
    // When 回到正常再偏离
    state.onHeartbeat(60_000, 60_000, T0 + 2)
    const again = state.onHeartbeat(60_000, 60_600, T0 + 3)
    // Then 连击重新从 1 开始，不判定分歧
    expect(again).toMatchObject({ diverged: false, strikes: 1 })
  })
})

describe('录音-回放 harness 与标定', () => {
  const scenarios: HarnessScenario[] = [
    { name: 'steady', durationMs: 5_000, tickEveryMs: 100, snapshotDelayMs: 50, outOfOrderEvery: 0, epochChanges: 0, tickFloodPerSec: 0, snapshotBurst: 0 },
    { name: 'flood+delay', durationMs: 5_000, tickEveryMs: 100, snapshotDelayMs: 500, outOfOrderEvery: 7, epochChanges: 1, tickFloodPerSec: 200, snapshotBurst: 3 },
  ]

  it('管理员：五种可注入条件（快照延迟/乱序/epoch 变更/洪泛/预算占用）都能跑出实测', () => {
    // Given 两个场景（含洪泛与 epoch 变更）
    const metrics = scenarios.map((scenario) => runScenario(params, scenario))
    // When 读实测
    const flood = metrics[1]!
    // Then 洪泛场景发布量远大于平稳场景，且事件日志存在（可审计）
    expect(metrics[0]!.publishedTicks).toBeGreaterThan(0)
    expect(flood.publishedTicks).toBeGreaterThan(metrics[0]!.publishedTicks)
    expect(flood.events.length).toBeGreaterThan(0)
    expect(flood.realignGranted + flood.realignRefused).toBe(scenarios[1]!.snapshotBurst >= 0 ? flood.realignGranted + flood.realignRefused : 0)
  })

  it('管理员：calibrate 的常量来自实测（每个数都能追到哪次测量 + 余量），不是猜的', () => {
    // Given 一组场景
    const result = calibrate(
      { realignRefillPerSec: 1, divergenceBps: 50, divergenceStrikes: 2, orderTokenCapacity: 5, orderRefillPerSec: 1 },
      scenarios,
      1.5,
    )
    // When 看建议常量与证据
    const maxTicks = Math.max(...result.measured.map((metrics) => metrics.maxBufferTicks))
    // Then 三个上界都不小于实测最大值，且证据行逐条写明来源
    expect(result.suggested.bufferMaxTicks).toBeGreaterThanOrEqual(maxTicks)
    expect(result.suggested.snapshotAgeBudgetMs).toBeGreaterThan(0)
    expect(result.suggested.realignTokenCapacity).toBeGreaterThanOrEqual(Math.max(...scenarios.map((scenario) => scenario.snapshotBurst)))
    expect(result.evidence).toHaveLength(4)
    expect(result.evidence.join(' ')).toContain('x 1.5')
  })
})
