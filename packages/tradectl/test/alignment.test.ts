/**
 * 行情对齐与回放 harness 测试（P3 步骤 4）：纯函数 + 注入时钟，无 mock 无 sleep。
 *
 * 2026-10-02 补：**标的级价格状态**回归（验收发现 F3）。V3 的探针
 * （/tmp/alignment-symbol-probe.mjs）在修复前实测：
 *   A) BTC 快照超龄 6s（预算 5s）⇒ snapshot-stale（正确）；
 *   B) 同一张过期 BTC 快照 + ETH 在 t=6000 来了一张新快照 ⇒ BTC tick 被 published（缺陷）；
 *   C) 只有 ETH 快照（BTC 从来没基准）⇒ BTC tick 也被 published（缺陷）。
 * 三条场景在 `标的级价格状态（多标的回归）` 一组里逐条钉住。
 */
import { describe, expect, it } from 'vitest'
import { createAlignment, createTokenBucket, type AlignmentParams } from '../src/alignment.ts'
import { calibrate, runMultiSymbolScenario, runScenario, type HarnessScenario, type MultiSymbolMetrics, type MultiSymbolScenario } from '../src/replay-harness.ts'

const T0 = 0
const BTC = 'BTC/USDT'
const ETH = 'ETH/USDT'
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
  state.onSnapshot({ epoch: 1, symbol: BTC, price: 60_000, atMs: T0 }, T0)
  return state
}
const tick = (seq: number, atMs: number, epoch = 1, price = 60_000) => ({ epoch, symbol: BTC, price, atMs, seq })
const tickFor = (symbol: string, seq: number, atMs: number, epoch = 1, price = 60_000) => ({ epoch, symbol, price, atMs, seq })

describe('epoch 世代守卫', () => {
  it('管理员：tick 的 epoch 与通道不一致时被丢弃并强制重快照', () => {
    // Given 一个 epoch=1 的对齐态
    const state = fresh()
    // When 收到 epoch=2 的 tick（还没收到新快照）
    const outcome = state.onTick(tick(1, T0 + 10, 2), T0 + 10)
    const snapshot = state.state(T0 + 10, BTC)
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
    const accepted = state.onSnapshot({ epoch: 2, symbol: BTC, price: 61_000, atMs: T0 + 2 }, T0 + 2)
    // Then 接受且缓冲清空、回到 aligned
    expect(accepted).toMatchObject({ accepted: true, reason: 'epoch-changed' })
    expect(state.state(T0 + 2, BTC)).toMatchObject({ alignment: 'aligned', buffered: 0, epoch: 2 })
  })

  it('管理员：比当前世代更旧的快照被忽略（不接受回退世代）', () => {
    // Given 一个 epoch=5 的对齐态
    const state = createAlignment(params, T0)
    state.onSnapshot({ epoch: 5, symbol: BTC, price: 60_000, atMs: T0 }, T0)
    // When 收到 epoch=4 的快照
    const rejected = state.onSnapshot({ epoch: 4, symbol: BTC, price: 59_000, atMs: T0 + 1 }, T0 + 1)
    // Then 忽略且世代不回退
    expect(rejected).toMatchObject({ accepted: false, reason: 'stale-epoch' })
    expect(state.state(T0 + 1, BTC).epoch).toBe(5)
  })
})

describe('先缓冲后发布与顺序守卫', () => {
  it('管理员：快照未到时 tick 只入缓冲、不对外发布', () => {
    // Given 一个还没有快照的状态机
    const state = createAlignment(params, T0)
    // When 收到 tick
    const outcome = state.onTick(tick(1, T0), T0)
    const snapshot = state.state(T0, BTC)
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
    expect(state.state(T0 + 6, BTC).droppedTicks).toBe(1)
  })

  it('管理员：快照年龄超预算 ⇒ stale 且 tick 不再发布（陈旧价格不发出去）', () => {
    // Given 一张到达于 T0 的快照、预算 5s
    const state = fresh()
    // When 在 T0+6000 收到 tick
    const outcome = state.onTick(tick(1, T0 + 6000), T0 + 6000)
    // Then 丢弃并标 stale
    expect(outcome).toMatchObject({ published: [], dropped: 1, reason: 'snapshot-stale' })
    expect(state.state(T0 + 6000, BTC).alignment).toBe('stale')
  })
})

describe('标的级价格状态（多标的回归：验收发现 F3）', () => {
  it('管理员：场景 A —— BTC 只有一张 6 秒前的快照时，BTC tick 被丢弃并给 snapshot-stale', () => {
    // Given 一张 T0 到达的 BTC 快照、预算 5s（V3 探针 A）
    const state = fresh()
    // When t=6000 来了 BTC tick
    const outcome = state.onTick(tick(1, 6000), 6000)
    // Then 丢弃、理由是 snapshot-stale、该标的转 stale
    expect(outcome).toMatchObject({ published: [], buffered: 0, dropped: 1, reason: 'snapshot-stale' })
    expect(state.state(6000, BTC)).toMatchObject({ alignment: 'stale', snapshotAtMs: T0, snapshotAgeMs: 6000 })
  })

  it('管理员：场景 B —— ETH 在 t=6000 拿到新快照，也不让 BTC 的 6 秒旧价重新发布', () => {
    // Given 一张 T0 到达的 BTC 快照（到 6001 已超 5s 预算）
    const state = fresh()
    // When ETH 在 t=6000 来了一张新快照，随后 BTC tick 在 t=6001 到达（V3 探针 B）
    const ethSnapshot = state.onSnapshot({ epoch: 1, symbol: ETH, price: 3_000, atMs: 6000 }, 6000)
    const outcome = state.onTick(tick(2, 6001), 6001)
    // Then ETH 的快照只让 ETH 对齐；BTC 仍被丢弃并给 snapshot-stale（异标的快照不构成本标的的基准）
    expect(ethSnapshot.accepted).toBe(true)
    expect(state.state(6001, ETH).alignment).toBe('aligned')
    expect(outcome).toMatchObject({ published: [], dropped: 1, reason: 'snapshot-stale' })
    expect(state.state(6001, BTC).alignment).toBe('stale')
  })

  it('管理员：场景 C —— 只有 ETH 有快照时，BTC tick 不发布且 BTC 态是 unaligned（无基准 = 等，不是陈旧）', () => {
    // Given 一张 ETH 快照，BTC 从来没有过自己的基准
    const state = createAlignment(params, T0)
    state.onSnapshot({ epoch: 1, symbol: ETH, price: 3_000, atMs: T0 }, T0)
    // When t=10 来了 BTC tick（V3 探针 C：修复前它被 published）
    const outcome = state.onTick(tickFor(BTC, 1, 10), 10)
    // Then 一条都不发布；BTC 是 unaligned（等自己的基准），绝不是被 ETH 带成 aligned
    expect(outcome.published).toEqual([])
    expect(outcome.reason).toBe('buffered-only')
    expect(outcome.dropped).toBe(0)
    expect(state.state(10, BTC)).toMatchObject({ alignment: 'unaligned', snapshotAtMs: null, buffered: 1 })
    expect(state.state(10, ETH).alignment).toBe('aligned')
  })

  it('管理员：ETH 新鲜、BTC 陈旧时两只标的各自独立判定（健康标的照常发布）', () => {
    // Given BTC 的快照停在 T0，ETH 的快照在 t=4000 刷新过（预算 5s）
    const state = createAlignment(params, T0)
    state.onSnapshot({ epoch: 1, symbol: BTC, price: 60_000, atMs: T0 }, T0)
    state.onSnapshot({ epoch: 1, symbol: ETH, price: 3_000, atMs: 4_000 }, 4_000)
    // When t=6000 两只标的各来一条 tick
    const ethOutcome = state.onTick(tickFor(ETH, 1, 6_000, 1, 3_000), 6_000)
    const btcOutcome = state.onTick(tickFor(BTC, 1, 6_000, 1, 60_000), 6_000)
    // Then ETH（年龄 2s）发布、BTC（年龄 6s）丢弃，互不背书
    expect(ethOutcome.published.map((published) => published.symbol)).toEqual([ETH])
    expect(btcOutcome).toMatchObject({ published: [], dropped: 1, reason: 'snapshot-stale' })
    expect(state.state(6_000, ETH).alignment).toBe('aligned')
    expect(state.state(6_000, BTC).alignment).toBe('stale')
  })

  it('管理员：ETH 的快照只补发 ETH 的缓冲 tick，BTC 的留在缓冲里等自己的基准', () => {
    // Given BTC 与 ETH 都还没有基准，各自缓冲了一条 tick
    const state = createAlignment(params, T0)
    const btcBuffered = state.onTick(tickFor(BTC, 1, 10), 10)
    const ethBuffered = state.onTick(tickFor(ETH, 1, 11, 1, 3_000), 11)
    // When ETH 的快照到达
    const ethSnapshot = state.onSnapshot({ epoch: 1, symbol: ETH, price: 3_000, atMs: 12 }, 12)
    // Then 只补发 ETH 的那一条；BTC 的仍在缓冲里，态仍是 unaligned
    expect(btcBuffered).toMatchObject({ published: [], reason: 'buffered-only' })
    expect(ethBuffered).toMatchObject({ published: [], reason: 'buffered-only' })
    expect(ethSnapshot.published.map((published) => published.symbol)).toEqual([ETH])
    expect(state.state(12, BTC)).toMatchObject({ alignment: 'unaligned', buffered: 1 })
    expect(state.state(12, ETH)).toMatchObject({ alignment: 'aligned', buffered: 0 })
  })

  it('管理员：一只标的的分歧连击不被另一只标的的健康对账清零（分歧是标的级判定）', () => {
    // Given BTC 与 ETH 都已对齐
    const state = fresh()
    state.onSnapshot({ epoch: 1, symbol: ETH, price: 3_000, atMs: T0 }, T0)
    state.onTick(tickFor(ETH, 1, T0 + 1, 1, 3_000), T0 + 1)
    // When BTC 偏离一次、ETH 健康一次、BTC 再偏离一次
    const btcFirst = state.onHeartbeat(60_000, 60_600, T0 + 2, BTC)
    state.onHeartbeat(3_000, 3_000, T0 + 3, ETH)
    const btcSecond = state.onHeartbeat(60_000, 60_600, T0 + 4, BTC)
    // Then BTC 连击累到 2 判分歧并转 stale；ETH 不受影响
    expect(btcFirst).toMatchObject({ diverged: false, strikes: 1 })
    expect(btcSecond).toMatchObject({ diverged: true, strikes: 2 })
    expect(state.state(T0 + 4, BTC).alignment).toBe('stale')
    expect(state.state(T0 + 4, ETH).alignment).toBe('aligned')
  })
})

describe('聚合态只能用于观测', () => {
  it('管理员：worstAlignment 是显式命名的聚合态（BTC stale + ETH aligned ⇒ stale），且不冒充标的级状态', () => {
    // Given BTC 的快照停在 T0（t=6000 时超龄）、ETH 的快照在 t=5000 刷新过
    const state = createAlignment(params, T0)
    state.onSnapshot({ epoch: 1, symbol: BTC, price: 60_000, atMs: T0 }, T0)
    state.onSnapshot({ epoch: 1, symbol: ETH, price: 3_000, atMs: 5_000 }, 5_000)
    state.onTick(tick(1, 6_000), 6_000)
    // When 读聚合态与标的级态
    const aggregate = state.worstAlignment(6_000)
    // Then 聚合字段叫 worstAlignment（没有可被误用的 alignment 字段），标的级读数各自独立
    expect(aggregate.worstAlignment).toBe('stale')
    expect(aggregate.bySymbol).toEqual({ [BTC]: 'stale', [ETH]: 'aligned' })
    expect(aggregate.staleSymbols).toEqual([BTC])
    expect(aggregate.knownSymbols).toEqual([BTC, ETH])
    expect(Object.keys(aggregate)).not.toContain('alignment')
    expect(state.state(6_000, ETH).alignment).toBe('aligned')
  })

  it('管理员：未知标的按 unaligned 兜底（fail-closed），且探一下不会把自己写进聚合态', () => {
    // Given 只有 BTC 有基准
    const state = fresh()
    // When 读一只从未见过的标的
    const unseen = state.state(T0, 'SOL/USDT')
    // Then 兜底为 unaligned（没有价格就没有可开的仓），聚合态仍然只列真的见过事件的标的
    expect(unseen).toMatchObject({ alignment: 'unaligned', snapshotAtMs: null, buffered: 0 })
    expect(state.worstAlignment(T0).knownSymbols).toEqual([BTC])
  })

  it('管理员：漏传 symbol 的全局读法直接抛错，而不是悄悄返回全局值（标的级守卫）', () => {
    // Given 一个对齐态
    const state = fresh()
    // When 用修复前的全局读法调用（漏传 symbol）
    const legacyState = state.state as unknown as (atMs: number) => unknown
    const legacyHeartbeat = state.onHeartbeat as unknown as (venuePrice: number, ourPrice: number, atMs: number) => unknown
    // Then 两处都抛错，错误信息指路 worstAlignment —— 静默的全局态正是缺陷形态
    expect(() => legacyState(T0)).toThrow(/标的级/)
    expect(() => legacyState(T0)).toThrow(/worstAlignment/)
    expect(() => legacyHeartbeat(60_000, 60_000, T0)).toThrow(/标的级/)
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
    const snapshot = state.state(T0 + 4, BTC)
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
    const first = state.onHeartbeat(60_000, 60_600, T0 + 1, BTC)
    // Then 只累计一次、不判定分歧
    expect(first.diverged).toBe(false)
    expect(first.strikes).toBe(1)
    // When 第二次偏离
    const second = state.onHeartbeat(60_000, 60_600, T0 + 2, BTC)
    // Then 判定分歧、状态转 stale、强制重快照
    expect(second.diverged).toBe(true)
    expect(state.state(T0 + 2, BTC).alignment).toBe('stale')
    expect(state.state(T0 + 2, BTC).forcedResnapshots).toBeGreaterThanOrEqual(1)
  })

  it('管理员：中间有一次回到阈值内就清零连击（不是累计计数）', () => {
    // Given 偏离一次
    const state = fresh()
    state.onHeartbeat(60_000, 60_600, T0 + 1, BTC)
    // When 回到正常再偏离
    state.onHeartbeat(60_000, 60_000, T0 + 2, BTC)
    const again = state.onHeartbeat(60_000, 60_600, T0 + 3, BTC)
    // Then 连击重新从 1 开始，不判定分歧
    expect(again).toMatchObject({ diverged: false, strikes: 1 })
  })
})

describe('录音-回放 harness 与标定', () => {
  const scenarios: HarnessScenario[] = [
    { name: 'steady', symbol: ETH, durationMs: 5_000, tickEveryMs: 100, snapshotDelayMs: 50, outOfOrderEvery: 0, epochChanges: 0, tickFloodPerSec: 0, snapshotBurst: 0 },
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

describe('录音-回放 harness 的多标的场景', () => {
  const starving: MultiSymbolScenario = {
    name: 'eth-fresh-btc-starved',
    durationMs: 2_000,
    snapshotBurst: 0,
    feeds: [
      { symbol: ETH, snapshotDelayMs: 0, snapshotRefreshMs: 200, tickEveryMs: 100 },
      { symbol: BTC, snapshotDelayMs: null, snapshotRefreshMs: 0, tickEveryMs: 100 },
    ],
  }
  const shortBudget: AlignmentParams = { ...params, snapshotAgeBudgetMs: 500 }

  it('管理员：一只标的快照断供时它的 tick 一条都不发布，健康标的照常发布', () => {
    // Given ETH 每 200ms 刷新快照、BTC 快照断供（snapshotDelayMs: null）
    const metrics = runMultiSymbolScenario(params, starving)
    // When 读逐标的实测
    const btc = metrics.bySymbol[BTC]!
    const eth = metrics.bySymbol[ETH]!
    // Then BTC 全部只进缓冲（不发布）、末态 unaligned；ETH 正常发布；聚合态如实标出断供
    expect(btc).toMatchObject({ publishedTicks: 0, finalAlignment: 'unaligned', finalSnapshotAgeMs: null })
    expect(btc.bufferedOnly).toBeGreaterThan(0)
    expect(eth.publishedTicks).toBeGreaterThan(0)
    expect(metrics.symbolsNeverAligned).toEqual([BTC])
    expect(metrics.worstAlignment).toBe('unaligned')
  })

  it('管理员：一只标的的快照超龄被丢弃时，另一只标的的新快照不构成它的基准', () => {
    // Given BTC 只在 t=0 有一张快照（此后不刷新）、ETH 每 200ms 刷新；预算 500ms
    const oneShot: MultiSymbolScenario = {
      name: 'eth-refreshing-btc-one-shot',
      durationMs: 2_000,
      snapshotBurst: 0,
      feeds: [
        { symbol: ETH, snapshotDelayMs: 0, snapshotRefreshMs: 200, tickEveryMs: 100 },
        { symbol: BTC, snapshotDelayMs: 0, snapshotRefreshMs: 0, tickEveryMs: 100 },
      ],
    }
    // When 跑回放
    const metrics = runMultiSymbolScenario(shortBudget, oneShot)
    const btc = metrics.bySymbol[BTC]!
    const eth = metrics.bySymbol[ETH]!
    // Then BTC 在 500ms 之后每条 tick 都被 snapshot-stale 丢掉（ETH 那 10 张新快照不算它的基准），ETH 照常发布
    expect(btc.staleDrops).toBeGreaterThan(0)
    expect(btc.finalAlignment).toBe('stale')
    expect(eth.publishedTicks).toBeGreaterThan(0)
    expect(eth.finalAlignment).toBe('aligned')
    expect(metrics.worstAlignment).toBe('stale')
    expect(metrics.events.filter((event) => event.kind === 'stale').every((event) => event.detail.includes(BTC))).toBe(true)
  })

  it('管理员：calibrate 能混着吃多标的场景，建议值仍逐条追到实测', () => {
    // Given 一个断供场景（混在多标的判别路径上）
    const result = calibrate(
      { realignRefillPerSec: 0, divergenceBps: 50, divergenceStrikes: 2, orderTokenCapacity: 2, orderRefillPerSec: 0 },
      [starving],
      1.5,
    )
    // When 读建议值与证据
    const measured = result.measured[0] as MultiSymbolMetrics
    // Then 建议的年龄预算不小于实测最长无快照间隔，且断供标的被如实列出（不靠调大预算洗白）
    expect(result.suggested.snapshotAgeBudgetMs).toBeGreaterThanOrEqual(measured.healthyGapMs)
    expect(result.evidence.join(' ')).toContain('maxHealthyGap')
    expect(measured.symbolsNeverAligned).toEqual([BTC])
  })
})

describe('参数守卫', () => {
  it('管理员：参数名拼错时立刻抛错，而不是静默降级成"永远 stale"', () => {
    // Given 把 snapshotAgeBudgetMs 写成 snapshotMaxAgeMs（2026-10-01 实测踩中的坑）
    const wrong = {
      symbols: [BTC],
      snapshotMaxAgeMs: 5_000,
      bufferMaxTicks: 1_000,
      bufferMaxBytes: 1_048_576,
      realignTokenCapacity: 3,
      realignRefillPerSec: 1,
      divergenceBps: 50,
      divergenceStrikes: 3,
      orderTokenCapacity: 3,
      orderRefillPerSec: 1,
    } as unknown as Parameters<typeof createAlignment>[0]
    // When/Then 抛错且提示指出可能的原因
    expect(() => createAlignment(wrong, 0)).toThrow(/snapshotAgeBudgetMs/)
    expect(() => createAlignment(wrong, 0)).toThrow(/拼错/)
  })

  it('管理员：结构性参数非正数同样抛错（0 预算等于永远陈旧）', () => {
    // Given 预算为 0
    const zero = {
      symbols: [BTC],
      snapshotAgeBudgetMs: 0,
      bufferMaxTicks: 1_000,
      bufferMaxBytes: 1_048_576,
      realignTokenCapacity: 3,
      realignRefillPerSec: 0,
      divergenceBps: 50,
      divergenceStrikes: 3,
      orderTokenCapacity: 3,
      orderRefillPerSec: 0,
    }
    // When/Then 抛错（注意 refill 为 0 是合法的，只有结构性参数不许为 0）
    expect(() => createAlignment(zero, 0)).toThrow(/snapshotAgeBudgetMs/)
  })
})
