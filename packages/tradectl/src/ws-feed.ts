/**
 * 流式行情传输层（P3 步骤 4 的缺口：真实 WS 那一层）。
 *
 * 设计取向：**把"传输"做成可注入的端口**，把订阅/心跳/重连/限频/解码这些**策略**
 * 留在本模块。这样：
 *   - 真实交易所适配器（Binance/OKX/Bybit/CCXT）只剩"怎么连、怎么订阅"这一层薄适配；
 *   - 策略层可以被完整测试（注入传输 + 注入时钟 + 注入调度器 ⇒ 无 sleep、无网络）。
 *
 * 四条与对齐状态机的接口约定：
 *   1. 每条消息都必须带 %%epoch%%——世代守卫在对齐层，这里只负责把世代号如实传下去；
 *   2. 心跳超时（heartbeatTimeoutMs 内没有任何消息）⇒ 主动断开重连，并把对齐层置为
 *      stale（静默的"连接还在但没数据"是最危险的状态）；
 *   3. 重连走**指数退避 + 上限**，且每一次重连都消耗订阅令牌（限频预算），免得把交易所
 *      的限频打爆；
 *   4. 所有时间来自注入时钟与注入调度器 ⇒ 测试里"等 30 秒"就是把调度器里的回调拿出来跑。
 *
 * @module @dshtrading/tractl/ws-feed
 */
import { createTokenBucket } from './alignment.ts'

/** 传输端口：真实实现包一层 WebSocket；测试注入脚本化的假传输。 */
export interface FeedTransport {
  connect(input: {
    readonly url: string
    readonly onOpen: () => void
    readonly onMessage: (text: string) => void
    readonly onClose: (reason: string) => void
    readonly onError: (error: string) => void
  }): void
  send(text: string): void
  close(): void
}

/** 调度端口：真实实现用 setTimeout；测试注入可手工推进的调度器。 */
export interface Scheduler {
  schedule(callback: () => void, delayMs: number): () => void
}

/** 一条流式消息（**必须带 epoch**）。 */
export interface FeedMessage {
  readonly kind: 'snapshot' | 'tick'
  readonly epoch: number
  readonly symbol: string
  readonly price: number
  readonly seq?: number
  readonly atMs: number
}

/** 解析一帧文本；格式不对返回 undefined（**不抛**：一条坏帧不该打断整条流）。 */
export function parseFeedMessage(text: string): FeedMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const message = parsed as Record<string, unknown>
  const kind = message.kind
  if (kind !== 'snapshot' && kind !== 'tick') return undefined
  if (typeof message.epoch !== 'number' || typeof message.symbol !== 'string' || typeof message.price !== 'number' || typeof message.atMs !== 'number') return undefined
  return {
    kind,
    epoch: message.epoch,
    symbol: message.symbol,
    price: message.price,
    ...(typeof message.seq === 'number' ? { seq: message.seq } : {}),
    atMs: message.atMs,
  }
}

/** 喂给对齐层的最小端口（本模块不 import alignment 的实现细节）。 */
export interface AlignmentSink {
  onSnapshot(snapshot: { epoch: number; symbol: string; price: number; atMs: number }, atMs: number): unknown
  onTick(tick: { epoch: number; symbol: string; price: number; atMs: number; seq: number }, atMs: number): unknown
  /**
   * 读对齐态：**必须带标的**。对齐态在设计 §9/§13 #22 里就是标的级词汇，一个没有
   * symbol 的全局读法会让"某只标的的健康"冒充"全 desk 的健康"（2026-10-02 F3）。
   */
  state(atMs: number, symbol: string): { alignment: string }
}

export interface FeedOptions {
  readonly transport: FeedTransport
  readonly scheduler: Scheduler
  readonly sink: AlignmentSink
  readonly now: () => number
  readonly url: string
  /** 订阅载荷（由交易所适配器给出）。 */
  readonly subscribePayload: (symbol: string) => string
  readonly symbols: readonly string[]
  readonly heartbeatTimeoutMs: number
  readonly reconnectBaseMs: number
  readonly reconnectMaxMs: number
  /** 订阅/重连的限频预算（与下单预算独立）。 */
  readonly subscribeTokenCapacity: number
  readonly subscribeRefillPerSec: number
  /**
   * 帧解码钩子：把交易所原始帧映射成 FeedMessage。缺省用内置 parseFeedMessage；
   * 交易所适配器必须传自己的解码器（Binance 的字段是 e/s/p/T，不是我们的 kind/epoch/...）。
   * 2026-10-01 真实冒烟暴露：第一版没有这个钩子，适配器的解码器无处可接，每一帧都被
   * 算成坏帧——离线测试发现不了，因为测试喂的本来就是自家格式。
   */
  /**
   * 帧解码钩子。返回值语义（2026-10-01 细化）：FeedMessage = 数据帧；
   * **%%ignored%% = 认识但无需处理的事件帧**（订阅确认、pong 等，不计入坏帧）；
   * undefined = 真的解析不了（计入坏帧）。把"事件帧"混进坏帧会让监控失去意义——
   * 坏帧应当是"要么协议变了要么有人在乱发"，而不是"交易所回了句 pong"。
   */
  readonly decode?: (text: string, epoch: number) => FeedMessage | 'ignored' | undefined
  /** 引导快照要覆盖的标的（symbols 为空时用它；Binance 的订阅在 URL 里，symbols 常为空）。 */
  readonly bootstrapSymbols?: readonly string[]
  /**
   * 开流后的**快照引导**：连上（并订阅）之后拉一批基准快照喂进对齐层。
   * 为什么必须有这一步：真实推流（如 Binance aggTrade）只有 tick、没有快照；没有基准，
   * 对齐层按"先缓冲后发布"永远停在 unaligned、一条都不发布。引导失败**不打断**流
   * （记事件 + 继续缓冲），因为"有 tick 没基准"总好过"什么都不要"。
   */
  readonly bootstrap?: (symbols: readonly string[]) => Promise<readonly FeedMessage[]>
  /** 每次状态变化的通知（诊断/审计用）。 */
  readonly onEvent?: (event: { atMs: number; kind: 'open' | 'close' | 'error' | 'heartbeat-timeout' | 'reconnect' | 'bad-frame'; detail: string }) => void
}

/** 传输层运行统计（报告与告警用）。 */
export interface FeedStats {
  readonly connects: number
  readonly reconnects: number
  readonly messages: number
  /** 认识但无需处理的事件帧（订阅确认/pong 等）。 */
  readonly ignoredFrames: number
  readonly badFrames: number
  readonly heartbeatTimeouts: number
  readonly lastMessageAtMs: number | null
  readonly state: 'idle' | 'connecting' | 'live' | 'backoff' | 'stopped'
}

/**
 * 建一条流式行情源。
 * @param options - 传输、调度器、对齐层与各种参数。
 */
export function createStreamingFeed(options: FeedOptions): {
  start(): void
  stop(): void
  stats(): FeedStats
  /**
   * 外部喂一张快照（周期刷新基准用；不经过传输层）。
   * **传入的 epoch 会被忽略** —— feed 用当前连接世代盖章，见下。
   */
  deliverSnapshot(snapshot: FeedMessage): void
} {
  const bucket = createTokenBucket(options.subscribeTokenCapacity, options.subscribeRefillPerSec, options.now())
  let state: FeedStats['state'] = 'idle'
  let connects = 0
  let reconnects = 0
  let messages = 0
  let badFrames = 0
  let ignoredFrames = 0
  let heartbeatTimeouts = 0
  let lastMessageAtMs: number | null = null
  let cancelHeartbeat: (() => void) | undefined
  let cancelReconnect: (() => void) | undefined
  let attempt = 0
  let stopped = false
  let generation = 0
  let scheduledGeneration = -1
  const events: { atMs: number; kind: string; detail: string }[] = []
  const note = (kind: Parameters<NonNullable<FeedOptions['onEvent']>>[0]['kind'], detail: string): void => {
    events.push({ atMs: options.now(), kind, detail })
    options.onEvent?.({ atMs: options.now(), kind, detail })
  }

  const armHeartbeat = (): void => {
    cancelHeartbeat?.()
    cancelHeartbeat = options.scheduler.schedule(() => {
      // 心跳超时：连接可能还"活着"，但数据已经断了——这种状态必须当成失败处理。
      heartbeatTimeouts += 1
      note('heartbeat-timeout', 'no feed message within ' + String(options.heartbeatTimeoutMs) + 'ms')
      options.transport.close()
      // 不等传输回调 onClose：那个回调可能永远不来，连接就会停在"看起来还活着"的状态
      scheduleReconnect('heartbeat timeout')
    }, options.heartbeatTimeoutMs)
  }

  const scheduleReconnect = (why: string): void => {
    if (stopped) return
    // 同一世代只排一次：心跳超时之后传输还可能回调 onClose，不能因此排两次重连
    if (scheduledGeneration === generation) return
    scheduledGeneration = generation
    state = 'backoff'
    const delay = Math.min(options.reconnectMaxMs, options.reconnectBaseMs * Math.pow(2, attempt))
    attempt += 1
    note('reconnect', 'reconnect in ' + String(delay) + 'ms (' + why + ')')
    cancelReconnect = options.scheduler.schedule(() => {
      reconnects += 1
      connectOnce()
    }, delay)
  }

  const connectOnce = (): void => {
    if (stopped) return
    generation += 1
    // 每次连接（含重连）都要花一个订阅令牌：限频预算打空时宁可晚点连，也不去打爆交易所。
    if (!bucket.take(options.now())) {
      scheduleReconnect('subscribe budget exhausted')
      return
    }
    state = 'connecting'
    options.transport.connect({
      url: options.url,
      onOpen: () => {
        connects += 1
        attempt = 0
        state = 'live'
        note('open', 'transport open')
        for (const symbol of options.symbols) {
          const payload = options.subscribePayload(symbol)
          // **空载荷不发**：URL 式订阅（Binance）没有订阅帧，而发一个空串会被交易所当成畸形 JSON
          // 回一个 error 帧 —— 那会被算成"坏帧"，把真实解码问题淹没（2026-10-01 实测：
          // Binance 返回 {"error":{"code":3,"msg":"Invalid JSON: EOF while parsing a value"}}）。
          if (payload !== '') options.transport.send(payload)
        }
        armHeartbeat()
        // 快照引导：拉到基准后对齐层才可能 aligned；失败只记事件
        if (options.bootstrap !== undefined) {
          void options.bootstrap(options.symbols.length > 0 ? options.symbols : (options.bootstrapSymbols ?? []))
            .then((snapshots) => {
              for (const snapshot of snapshots) {
                // 世代号由 feed **盖章**（覆盖快照源自带的 epoch）：
                // "这条快照属于哪次连接"是 feed 独有的事实。让每个适配器/脚本自己记，
                // 就会出现硬编码 epoch=1 的写法 —— 重连后新世代的 tick 与旧世代快照永远对不上，
                // 对齐层于是永远停在 unaligned、一条都不发布（2026-10-01 实测确认的静默停摆）。
                options.sink.onSnapshot({ epoch: generation, symbol: snapshot.symbol, price: snapshot.price, atMs: snapshot.atMs }, options.now())
              }
              note('open', 'bootstrap delivered ' + String(snapshots.length) + ' snapshot(s)')
            })
            .catch((error: unknown) => {
              note('error', 'bootstrap failed: ' + (error instanceof Error ? error.message : String(error)))
            })
        }
      },
      onMessage: (text) => {
        messages += 1
        lastMessageAtMs = options.now()
        armHeartbeat()
        const message = (options.decode ?? ((raw: string) => parseFeedMessage(raw)))(text, generation)
        if (message === 'ignored') {
          ignoredFrames += 1
          return
        }
        if (message === undefined) {
          badFrames += 1
          note('bad-frame', 'unparseable frame (first 80 chars): ' + text.slice(0, 80))
          return
        }
        if (message.kind === 'snapshot') {
          options.sink.onSnapshot({ epoch: message.epoch, symbol: message.symbol, price: message.price, atMs: message.atMs }, options.now())
          return
        }
        options.sink.onTick(
          { epoch: message.epoch, symbol: message.symbol, price: message.price, atMs: message.atMs, seq: message.seq ?? messages },
          options.now(),
        )
      },
      onClose: (reason) => {
        cancelHeartbeat?.()
        note('close', 'transport closed: ' + reason)
        scheduleReconnect('closed: ' + reason)
      },
      onError: (error) => {
        cancelHeartbeat?.()
        note('error', error)
        scheduleReconnect('error: ' + error)
      },
    })
  }

  return {
    start() {
      stopped = false
      connectOnce()
    },
    stop() {
      stopped = true
      cancelHeartbeat?.()
      cancelReconnect?.()
      options.transport.close()
      state = 'stopped'
    },
    deliverSnapshot(snapshot) {
      // 同样盖章：外部只负责"拿到一个价"，不需要知道当前是第几次连接
      options.sink.onSnapshot({ epoch: generation, symbol: snapshot.symbol, price: snapshot.price, atMs: snapshot.atMs }, options.now())
    },
    stats: () => ({ connects, reconnects, messages, badFrames, ignoredFrames, heartbeatTimeouts, lastMessageAtMs, state }),
  }
}
