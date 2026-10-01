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

function fixture(overrides: Partial<Parameters<typeof createStreamingFeed>[0]> = {}) {
  const clock = manualScheduler()
  const fake = fakeTransport()
  const alignment = createAlignment(params, T0)
  const feed = createStreamingFeed({
    transport: fake.transport,
    scheduler: clock.scheduler,
    sink: alignment,
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
    expect(alignment.state(T0).alignment).toBe('aligned')
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
    expect(alignment.state(T0).alignment).toBe('aligned')
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
    expect(alignment.state(T0).alignment).toBe('unaligned')
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
    expect(alignment.state(T0).alignment).toBe('aligned')
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
    expect(alignment.state(T0).alignment).toBe('aligned')
  })
})
