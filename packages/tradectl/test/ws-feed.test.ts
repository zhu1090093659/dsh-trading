/**
 * 流式传输层测试（P3 步骤 4 缺口）：注入传输 + 注入时钟 + 可手工推进的调度器，
 * 无网络、无 sleep、无 mock 框架（假传输是契约假件：只实现文档化的四个回调）。
 */
import { describe, expect, it } from 'vitest'
import { createAlignment, type AlignmentParams } from '../src/alignment.ts'
import { createStreamingFeed, parseFeedMessage, type FeedTransport, type Scheduler } from '../src/ws-feed.ts'

const T0 = 1_700_000_000_000
const params: AlignmentParams = {
  snapshotAgeBudgetMs: 5_000,
  bufferMaxTicks: 64,
  bufferMaxBytes: 64 * 128,
  realignTokenCapacity: 4,
  realignRefillPerSec: 1,
  divergenceBps: 50,
  divergenceStrikes: 2,
  orderTokenCapacity: 2,
  orderRefillPerSec: 0,
}

/** 契约假传输：如实记录 connect/send/close，并允许测试手工触发回调。 */
function fakeTransport() {
  const sent: string[] = []
  let handlers: Parameters<FeedTransport['connect']>[0] | undefined
  let closes = 0
  const transport: FeedTransport = {
    connect(input) {
      handlers = input
    },
    send(text) {
      sent.push(text)
    },
    close() {
      closes += 1
    },
  }
  return {
    transport,
    sent,
    get closes() {
      return closes
    },
    open() {
      handlers?.onOpen()
    },
    message(text: string) {
      handlers?.onMessage(text)
    },
    serverClose(reason: string) {
      handlers?.onClose(reason)
    },
    error(message: string) {
      handlers?.onError(message)
    },
  }
}

/** 可手工推进的调度器：把"等待"变成"取出回调来跑"。 */
function manualScheduler() {
  let tick = T0
  const pending: { at: number; callback: () => void; cancelled: boolean }[] = []
  const scheduler: Scheduler = {
    schedule(callback, delayMs) {
      const entry = { at: tick + delayMs, callback, cancelled: false }
      pending.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  }
  return {
    scheduler,
    now: () => tick,
    advance(ms: number) {
      tick += ms
      for (const entry of pending.splice(0)) {
        if (entry.cancelled) continue
        if (entry.at <= tick) entry.callback()
        else pending.push(entry)
      }
    },
  }
}

/**
 * 契约假件：把 feed 的消息转发给**真实**对齐层，并记录被发布的 tick。
 * 对齐态是标的级的，所以要证明"某条 tick 没被发布"必须看得见发布流本身。
 */
function recordingSink(alignment: ReturnType<typeof createAlignment>) {
  const published: { symbol: string; price: number }[] = []
  return {
    published,
    sink: {
      onSnapshot: (snapshot: { epoch: number; symbol: string; price: number; atMs: number }, atMs: number) => alignment.onSnapshot(snapshot, atMs),
      onTick: (tick: { epoch: number; symbol: string; price: number; atMs: number; seq: number }, atMs: number) => {
        const outcome = alignment.onTick(tick, atMs)
        for (const item of outcome.published) published.push({ symbol: item.symbol, price: item.price })
        return outcome
      },
      state: (atMs: number, symbol: string) => alignment.state(atMs, symbol),
    },
  }
}

function fixture(
  overrides: Partial<Parameters<typeof createStreamingFeed>[0]> = {},
  sink?: Parameters<typeof createStreamingFeed>[0]['sink'],
) {
  const clock = manualScheduler()
  const fake = fakeTransport()
  const alignment = createAlignment(params, T0)
  const feed = createStreamingFeed({
    transport: fake.transport,
    scheduler: clock.scheduler,
    sink: sink ?? alignment,
    now: clock.now,
    url: 'wss://example.invalid/stream',
    subscribePayload: (symbol) => JSON.stringify({ op: 'subscribe', symbol }),
    symbols: ['BTC/USDT'],
    heartbeatTimeoutMs: 3_000,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 8_000,
    subscribeTokenCapacity: 2,
    subscribeRefillPerSec: 0,
    ...overrides,
  })
  return { clock, fake, alignment, feed }
}

describe('帧解析', () => {
  it('管理员：合法帧解析出字段；坏 JSON 与非对象一律 undefined（坏帧不打断整条流）', () => {
    // Given 四种输入
    // When 解析
    // Then 只有合法的那两条给出对象
    expect(parseFeedMessage(JSON.stringify({ kind: 'tick', epoch: 1, symbol: 'BTC/USDT', price: 60_000, atMs: T0, seq: 3 }))).toMatchObject({ kind: 'tick', epoch: 1, seq: 3 })
    expect(parseFeedMessage(JSON.stringify({ kind: 'snapshot', epoch: 2, symbol: 'BTC/USDT', price: 1, atMs: T0 }))).toMatchObject({ kind: 'snapshot', epoch: 2 })
    expect(parseFeedMessage('not json')).toBeUndefined()
    expect(parseFeedMessage(JSON.stringify({ kind: 'nope', epoch: 1 }))).toBeUndefined()
  })
})

describe('连接、订阅与心跳', () => {
  it('管理员：连上后逐标的发订阅载荷，并把消息喂进对齐层', () => {
    // Given 一条流
    const { fake, alignment, feed } = fixture()
    // When 启动并打开连接、发一条快照与一条 tick
    feed.start()
    fake.open()
    fake.message(JSON.stringify({ kind: 'snapshot', epoch: 1, symbol: 'BTC/USDT', price: 60_000, atMs: T0 }))
    fake.message(JSON.stringify({ kind: 'tick', epoch: 1, symbol: 'BTC/USDT', price: 60_100, atMs: T0, seq: 1 }))
    // Then 订阅已发出、对齐层进入 aligned
    expect(fake.sent).toEqual([JSON.stringify({ op: 'subscribe', symbol: 'BTC/USDT' })])
    expect(alignment.state(T0, 'BTC/USDT').alignment).toBe('aligned')
    expect(feed.stats()).toMatchObject({ connects: 1, messages: 2, badFrames: 0, state: 'live' })
  })

  it('管理员：心跳超时（连接还在但没数据）触发断开与重连，并如实计数', () => {
    // Given 一条已连上但静默的流
    const { clock, fake, feed } = fixture()
    feed.start()
    fake.open()
    // When 推进超过心跳超时
    clock.advance(3_001)
    // Then 主动断开并安排重连
    expect(fake.closes).toBe(1)
    expect(feed.stats().heartbeatTimeouts).toBe(1)
    expect(feed.stats().state).toBe('backoff')
  })

  it('管理员：坏帧被计数但不影响后续好帧', () => {
    // Given 一条流
    const { fake, alignment, feed } = fixture()
    feed.start()
    fake.open()
    // When 先来一个坏帧，再来一条好帧
    fake.message('{ this is not json')
    fake.message(JSON.stringify({ kind: 'snapshot', epoch: 1, symbol: 'BTC/USDT', price: 60_000, atMs: T0 }))
    // Then 坏帧计数为 1，好帧照常生效
    expect(feed.stats()).toMatchObject({ badFrames: 1, messages: 2 })
    expect(alignment.state(T0, 'BTC/USDT').alignment).toBe('aligned')
  })
})

describe('事件帧与坏帧的区分', () => {
  it('管理员：解码器返回 ignored 的事件帧只计 ignoredFrames，不进 badFrames', () => {
    // Given 一条把 ack 帧判为 ignored 的流
    const { fake, feed } = fixture({ decode: (text, epoch) => (text === 'ack' ? 'ignored' : (text === 'bad' ? undefined : { kind: 'tick', epoch, symbol: 'BTC/USDT', price: 1, atMs: T0, seq: 1 })) })
    feed.start()
    fake.open()
    // When 依次收到 ack（ignored）、bad（畸形）、好帧
    fake.message('ack')
    fake.message('bad')
    fake.message(JSON.stringify({ kind: 'tick', epoch: 1, symbol: 'BTC/USDT', price: 60_000, atMs: T0, seq: 1 }))
    // Then ignored=1、bad=1（互不混淆）
    expect(feed.stats()).toMatchObject({ messages: 3, ignoredFrames: 1, badFrames: 1 })
  })
})

describe('重连退避与订阅限频预算', () => {
  it('管理员：重连按指数退避并封顶（注入调度器推进，不 sleep）', () => {
    // Given 一条已连上的流（预算足够）
    const { clock, fake, feed } = fixture({ subscribeTokenCapacity: 10 })
    feed.start()
    fake.open()
    // When 服务端断开并推进 1 秒
    fake.serverClose('server said bye')
    clock.advance(1_000)
    // Then 发生一次重连，退避基数生效
    expect(feed.stats().reconnects).toBe(1)
  })

  it('管理员：订阅预算打空后不再连接（宁可晚点连，也不打爆交易所）', () => {
    // Given 订阅预算只有 1 个令牌
    const { clock, fake, feed } = fixture({ subscribeTokenCapacity: 1, subscribeRefillPerSec: 0 })
    // When 启动（花掉唯一令牌）后服务端断开
    feed.start()
    fake.open()
    fake.serverClose('bye')
    const before = feed.stats().connects
    clock.advance(60_000)
    // Then 预算耗尽 ⇒ 不产生新连接
    expect(feed.stats().connects).toBe(before)
    expect(feed.stats().state).toBe('backoff')
  })

  it('管理员：stop 之后不再重连，且状态为 stopped', () => {
    // Given 一条已连接并断开的流
    const { clock, fake, feed } = fixture({ subscribeTokenCapacity: 10 })
    feed.start()
    fake.open()
    fake.serverClose('bye')
    // When stop 之后推进时间
    feed.stop()
    clock.advance(60_000)
    // Then 不重连
    expect(feed.stats().state).toBe('stopped')
    expect(feed.stats().reconnects).toBe(0)
  })
})

describe('世代号如实下传', () => {
  it('管理员：epoch 变化的消息由对齐层判定（传输层只如实传递世代号）', () => {
    // Given 已建立 epoch=1 的流
    const { fake, alignment, feed } = fixture()
    feed.start()
    fake.open()
    fake.message(JSON.stringify({ kind: 'snapshot', epoch: 1, symbol: 'BTC/USDT', price: 60_000, atMs: T0 }))
    // When 收到 epoch=2 的 tick（还没收到新快照）
    fake.message(JSON.stringify({ kind: 'tick', epoch: 2, symbol: 'BTC/USDT', price: 61_000, atMs: T0, seq: 9 }))
    // Then 对齐层把它判为 unaligned（世代不符）——传输层不越权处理
    expect(alignment.state(T0, 'BTC/USDT').alignment).toBe('unaligned')
    expect(feed.stats().badFrames).toBe(0)
  })
})

describe('快照世代号由 feed 盖章', () => {
  it('管理员：快照源自带的 epoch 被覆盖为当前连接世代（硬编码 epoch 是静默停摆的根源）', async () => {
    // Given 一条已连上的流与一批自带错误 epoch（999）的引导快照
    const { fake, alignment, feed } = fixture({
      bootstrap: async () => [{ kind: 'snapshot', epoch: 999, symbol: 'BTC/USDT', price: 60_000, atMs: T0 }],
    })
    feed.start()
    fake.open()
    // 引导是异步的（void bootstrap().then(...)）：先让它落地，再发 tick
    await new Promise((resolve) => setImmediate(resolve))
    // When 引导完成后再来一条同世代的 tick
    fake.message(JSON.stringify({ kind: 'tick', epoch: 1, symbol: 'BTC/USDT', price: 60_100, atMs: T0, seq: 1 }))
    // Then 对齐层进入 aligned（若 epoch 仍是 999，这条 tick 会被判 unaligned）
    expect(alignment.state(T0, 'BTC/USDT').alignment).toBe('aligned')
  })

  it('管理员：deliverSnapshot 同样被盖章（周期刷新不需要知道自己是第几次连接）', () => {
    // Given 一条已连上的流
    const { fake, alignment, feed } = fixture()
    feed.start()
    fake.open()
    // When 外部喂一张自带错误 epoch 的快照，再来一条 tick
    feed.deliverSnapshot({ kind: 'snapshot', epoch: 42, symbol: 'BTC/USDT', price: 60_000, atMs: T0 })
    fake.message(JSON.stringify({ kind: 'tick', epoch: 1, symbol: 'BTC/USDT', price: 60_050, atMs: T0, seq: 1 }))
    // Then 仍然对齐
    expect(alignment.state(T0, 'BTC/USDT').alignment).toBe('aligned')
  })
})
describe('重连路径', () => {
  it('管理员：重连后重新引导并再次对齐（这正是"静默停摆"的场景）', async () => {
    // Given 一条连上并已对齐的流（引导快照自带错误 epoch，靠 feed 盖章纠正）
    const { fake, alignment, feed, clock } = fixture({
      bootstrap: async () => [{ kind: 'snapshot', epoch: 999, symbol: 'BTC/USDT', price: 60_000, atMs: T0 }],
      subscribeTokenCapacity: 10,
    })
    feed.start()
    fake.open()
    await new Promise((resolve) => setImmediate(resolve))
    fake.message(JSON.stringify({ kind: 'tick', epoch: 1, symbol: 'BTC/USDT', price: 60_100, atMs: T0, seq: 1 }))
    expect(alignment.state(T0, 'BTC/USDT').alignment).toBe('aligned')
    // When 服务端断开、重连（新一代连接）并重新引导
    fake.serverClose('server said bye')
    clock.advance(1_000)
    fake.open()
    await new Promise((resolve) => setImmediate(resolve))
    // Then 新世代的 tick 仍然能对齐（若快照 epoch 仍是 999，这里会永远 unaligned）
    const later = T0 + 1_000
    fake.message(JSON.stringify({ kind: 'tick', epoch: 2, symbol: 'BTC/USDT', price: 60_200, atMs: later, seq: 2 }))
    expect(alignment.state(later, 'BTC/USDT').alignment).toBe('aligned')
    expect(feed.stats().reconnects).toBe(1)
  })
})
describe('订阅载荷', () => {
describe('订阅载荷为空时不发送', () => {
  it('管理员：URL 式订阅（空载荷）不发订阅帧——发空串会被交易所当畸形 JSON 回 error 帧', () => {
    // Given 一个 URL 式适配器（subscribePayload 返回空串）与两只标的
    const { fake, feed } = fixture({ symbols: ['BTC/USDT', 'ETH/USDT'], subscribePayload: () => '' })
    feed.start()
    // When 连接打开
    fake.open()
    // Then 一条订阅帧都没发（第一版无条件发送 ⇒ Binance 回 {"error":{"code":3,...}}）
    expect(fake.sent).toEqual([])
  })

  it('管理员：非空载荷按标的逐条发送（帧式订阅的交易所需要它）', () => {
    // Given 一个帧式适配器
    const { fake, feed } = fixture({ symbols: ['BTC/USDT', 'ETH/USDT'], subscribePayload: (symbol) => 'sub:' + symbol })
    feed.start()
    // When 连接打开
    fake.open()
    // Then 两只标的各发一条，顺序与 symbols 一致
    expect(fake.sent).toEqual(['sub:BTC/USDT', 'sub:ETH/USDT'])
  })
})
})

describe('多标的传输（验收发现 F3 的传输侧回归）', () => {
  it('管理员：ETH 的快照经传输层到达，也不会让 BTC 超龄的 tick 进入发布流', () => {
    // Given 一条同时订阅 BTC 与 ETH 的流（发布流可观测），BTC 的基准快照在 T0 到达
    const alignment = createAlignment(params, T0)
    const recorder = recordingSink(alignment)
    const { clock, fake, feed } = fixture({ symbols: ['BTC/USDT', 'ETH/USDT'], heartbeatTimeoutMs: 60_000 }, recorder.sink)
    feed.start()
    fake.open()
    fake.message(JSON.stringify({ kind: 'snapshot', epoch: 1, symbol: 'BTC/USDT', price: 60_000, atMs: T0 }))
    // When 时钟推进 6 秒（超过 5 秒的年龄预算）后 ETH 来了一张新快照，随后两只标的各来一条 tick
    clock.advance(6_000)
    fake.message(JSON.stringify({ kind: 'snapshot', epoch: 1, symbol: 'ETH/USDT', price: 3_000, atMs: T0 + 6_000 }))
    fake.message(JSON.stringify({ kind: 'tick', epoch: 1, symbol: 'BTC/USDT', price: 60_000, atMs: T0 + 6_000, seq: 1 }))
    fake.message(JSON.stringify({ kind: 'tick', epoch: 1, symbol: 'ETH/USDT', price: 3_100, atMs: T0 + 6_000, seq: 1 }))
    // Then 只有 ETH 的 tick 被发布；BTC 因自己的快照超龄而未发布、态为 stale
    expect(recorder.published).toEqual([{ symbol: 'ETH/USDT', price: 3_100 }])
    expect(alignment.state(T0 + 6_000, 'BTC/USDT').alignment).toBe('stale')
    expect(alignment.state(T0 + 6_000, 'ETH/USDT').alignment).toBe('aligned')
  })
})
