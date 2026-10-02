/**
 * 行情对齐状态机（P3 步骤 4）：epoch 世代、先缓冲后发布、**标的级价格状态**、
 * 全局缓冲界、独立限频预算、静默分歧探测器。
 *
 * 六条硬要求（卡片原文）与落点：
 *   1. 两条通道都带**世代号 epoch**；epoch 不一致 ⇒ 旧缓冲一律丢弃并重新快照。
 *   2. **先缓冲后发布**：快照未到之前 tick 只入缓冲，不对外发布（发出去就是让下游拿
 *      半张图做决定）。
 *   3. **快照自身也做年龄检查**：快照再新，放久了也是陈旧价格。
 *   4. **缓冲有全局界**：条数与字节双界；越界即清空缓冲并强制重快照（不静默截断）。
 *   5. **快照与下单各自独立限频预算**：共享预算 = 打忙下单通道即可让 bot 降级（§13 #14）。
 *   6. **静默分歧探测器**：与 venue 心跳对账，相对差 > 配置 bps 连续 N 次 ⇒ DIVERGED
 *      + 强制重快照 + 按 STALE 对待。
 *
 * ## 标的级价格状态（2026-10-02，验收发现 F3 修复）
 *
 * `snapshotAtMs` / `alignment` / `divergenceStrikes` **按标的分开记**（与既有的
 * `lastSeqBySymbol` 同构）；一个标的的快照只影响该标的的判定。为什么必须这样：
 * `alignment` 在设计 §9/§13 #22 里就是**标的级**词汇，运行期的唯一接线把它按标的喂给
 * `openRiskAllowedFor`（`signals.alignmentOf(symbol)`）。第一版只有一个全局
 * `snapshotAtMs`/`alignment`，探针实测撞出三条：
 *
 *   A) BTC 快照已过期 6s（预算 5s）+ 只有 BTC tick ⇒ 正确丢弃（`snapshot-stale`）；
 *   B) 同一张过期 BTC 快照，但 **ETH 在 t=6000 来了一张快照** ⇒ BTC tick 被 published；
 *   C) **只有 ETH 快照**（BTC 从未有过基准）⇒ BTC tick 也被 published。
 *
 * B/C 是同一类失效：**异标的的新快照让本标的的陈旧价格重新变成"可信"**。反向则是
 * 一只标的的陈旧快照把整个 desk 判 stale（单标的 DoS，§9「只降肇事标的」）。§13 #13
 * 的输入侧因此不成立。三条场景的回归用例在 `test/alignment.test.ts` 的
 * 「标的级价格状态（多标的回归）」一组。
 *
 * 仍然是**通道级**的事实（不按标的切）：epoch（一次连接一个世代，由 feed 盖章）、
 * 缓冲条数/字节的全局界、重对齐与下单令牌桶。理由：这些描述的是"这条通道/这个进程
 * 现在什么状况"，而 `alignment` 描述的是"这只标的的价格能不能信"。
 *
 * 读状态有两个入口，**名字即用途**：
 *   - `state(atMs, symbol)`：某只标的的价格侧状态（发布与风控的唯一输入）；
 *   - `worstAlignment(atMs)`：全 desk 聚合态，字段显式叫 `worstAlignment`，
 *     **只能用于观测/告警，不得作为发布或风控输入**（把标的级状态提升为 desk 级正是
 *     §13 #22 禁止的那条）。没有 symbol 参数的 `state()` 会**抛错**而不是悄悄返回
 *     全局值——静默的全局态正是这个缺陷的形态。
 *
 * 三个上界参数（年龄预算 / 缓冲条数与字节 / 重对齐令牌桶容量）**必须先经
 * replay-harness 标定**才能写成常量——本模块不提供缺省值，调用方必须显式传入
 * （缺省猜测值会让"没标定"变成"看起来标定过"）。当前取值是 **harness 实测标定值**
 * （`drill/alignment-params.ts`，来源见 `docs/design/alignment-calibration.md`，2026-10-02，
 * 不变量 #23）；它是**演练标定**，接入真实行情录音后必须重标。
 *
 * @module @dshtrading/tractl/alignment
 */
import { PRICE_ALIGNMENTS, type Alignment } from './risk-gate.ts'

/** 一条行情 tick。 */
export interface Tick {
  readonly epoch: number
  readonly symbol: string
  readonly price: number
  readonly atMs: number
  /** 交易所侧序号（判断乱序用）。 */
  readonly seq: number
}

/** 一次快照。 */
export interface Snapshot {
  readonly epoch: number
  readonly symbol: string
  readonly price: number
  readonly atMs: number
}

/** 上界与阈值——**没有缺省值**，必须由 harness 标定后显式传入。 */
export interface AlignmentParams {
  /** 快照年龄预算（超过即 stale）。 */
  readonly snapshotAgeBudgetMs: number
  /** 缓冲全局界：条数。 */
  readonly bufferMaxTicks: number
  /** 缓冲全局界：字节（按每条 128B 估）。 */
  readonly bufferMaxBytes: number
  /** 重对齐令牌桶：容量与每秒回填。 */
  readonly realignTokenCapacity: number
  readonly realignRefillPerSec: number
  /** 分歧阈值（bps）与连续次数。 */
  readonly divergenceBps: number
  readonly divergenceStrikes: number
  /** 下单侧预算与快照侧**完全独立**（§13 #14）。 */
  readonly orderTokenCapacity: number
  readonly orderRefillPerSec: number
}

/** 单独的令牌桶（快照与下单各一个实例，互不影响）。 */
export function createTokenBucket(capacity: number, refillPerSec: number, atMs: number): {
  take(atMs: number): boolean
  available(atMs: number): number
} {
  let tokens = capacity
  let lastMs = atMs
  const refill = (nowMs: number): void => {
    const elapsed = Math.max(0, nowMs - lastMs)
    tokens = Math.min(capacity, tokens + (elapsed / 1000) * refillPerSec)
    lastMs = nowMs
  }
  return {
    take(nowMs) {
      refill(nowMs)
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
    available(nowMs) {
      refill(nowMs)
      return tokens
    },
  }
}

/** 一次 tick 的处理结果。 */
export interface TickOutcome {
  readonly published: readonly Tick[]
  /** 当前缓冲**总**条数（全局界的主体；按标的切片见 `state(atMs, symbol).buffered`）。 */
  readonly buffered: number
  readonly dropped: number
  readonly reason: string
}

/** 某只标的的对齐状态（可读快照，便于审计与测试）。 */
export interface SymbolAlignmentSnapshot {
  readonly symbol: string
  /** 通道世代（feed 每次连接盖一次章；这是通道级事实）。 */
  readonly epoch: number | null
  /** 该标的的价格侧状态。 */
  readonly alignment: Alignment
  /** 该标的最近一次被接受的快照到达时刻；从未有过基准时为 null。 */
  readonly snapshotAtMs: number | null
  /** 该标的当前快照的年龄；没有基准时为 null。 */
  readonly snapshotAgeMs: number | null
  /** 该标的当前在缓冲里的 tick 条数与字节（缓冲本身是全局的，这里按标的切片）。 */
  readonly buffered: number
  readonly bytes: number
  /** 该标的的分歧连击。 */
  readonly divergenceStrikes: number
  /** 以下两项是通道级计数（观测用，不分标的）。 */
  readonly forcedResnapshots: number
  readonly droppedTicks: number
}

/**
 * 全 desk 聚合视图。**只用于观测/告警**：字段显式叫 `worstAlignment`，没有任何叫
 * `alignment` 的字段——发布与风控必须按标的读 `state(atMs, symbol)`（§13 #22：
 * 标的级状态不得提升为 desk 级）。
 */
export interface AlignmentAggregate {
  readonly worstAlignment: Alignment
  readonly bySymbol: Readonly<Record<string, Alignment>>
  readonly knownSymbols: readonly string[]
  readonly staleSymbols: readonly string[]
  readonly unalignedSymbols: readonly string[]
  readonly buffered: number
  readonly bytes: number
  readonly forcedResnapshots: number
  readonly droppedTicks: number
}

/** 事件日志（provenance：判定要能重建，卡片的审计要求）。 */
export interface AlignmentEvent {
  readonly atMs: number
  readonly kind: 'snapshot' | 'tick' | 'divergence' | 'stale' | 'drop' | 'realign'
  readonly detail: string
}

const BYTES_PER_TICK = 128

/**
 * 建一个对齐状态机。
 * @param params - 标定过的上界参数（无缺省）。
 * @param startedAtMs - 起始时刻（注入时钟）。
 */
/**
 * 参数守卫：**配错就大声失败**，不要静默降级成"永远 stale"。
 *
 * 2026-10-01 实测踩中：调用方把预算写成了 %%snapshotMaxAgeMs%%（真名是 %%snapshotAgeBudgetMs%%），
 * 于是 %%atMs - snapshotAtMs <= undefined%% 恒为 false ⇒ **每一帧都被判陈旧、对齐层永远 stale**，
 * 表现为"行情接不通"而不是"参数写错了"。drills 与 tests 不在 tsc 范围内，这类拼写错误不会在编译期暴露，
 * 所以这里做运行期校验：必需的正数参数缺失或非正就抛错。
 */
function assertAlignmentParams(params: AlignmentParams): void {
  // 所有字段都必须是**有限数**（拼错名字时它是 undefined，到这里就会被抓住）
  const required: (keyof AlignmentParams)[] = [
    'snapshotAgeBudgetMs',
    'bufferMaxTicks',
    'bufferMaxBytes',
    'realignTokenCapacity',
    'realignRefillPerSec',
    'divergenceBps',
    'divergenceStrikes',
    'orderTokenCapacity',
    'orderRefillPerSec',
  ]
  const bad = required.filter((key) => typeof params[key] !== 'number' || !Number.isFinite(params[key]))
  // 结构性参数另外要求 > 0；其余允许 0（例如"不回填令牌桶"是合法配置）
  const mustBePositive: (keyof AlignmentParams)[] = ['snapshotAgeBudgetMs', 'bufferMaxTicks', 'bufferMaxBytes']
  const nonPositive = mustBePositive.filter((key) => params[key] <= 0)
  const missing = [...bad, ...nonPositive]
  if (missing.length > 0) {
    throw new Error('createAlignment: 参数缺失或非正数 —— ' + missing.join(', ') + '（常见原因：字段名拼错，例如把 snapshotAgeBudgetMs 写成 snapshotMaxAgeMs）')
  }
}

/** 标的级状态：**一个标的一份**（与 lastSeqBySymbol 同构）。 */
interface SymbolState {
  snapshotAtMs: number | null
  alignment: Alignment
  divergenceStrikes: number
}

/** 从未见过该标的时返回的共享只读态（只读，绝不写回 map）。 */
const UNSEEN_SYMBOL_STATE: SymbolState = { snapshotAtMs: null, alignment: 'unaligned', divergenceStrikes: 0 }

/** 越差越靠前的排序，用于聚合态（观测用）。 */
function worse(left: Alignment, right: Alignment): Alignment {
  const rank: Record<Alignment, number> = { aligned: 0, unaligned: 1, stale: 2 }
  return rank[left] >= rank[right] ? left : right
}

export function createAlignment(params: AlignmentParams, startedAtMs: number): {
  onSnapshot(snapshot: Snapshot, atMs: number): { accepted: boolean; reason: string; published: readonly Tick[] }
  onTick(tick: Tick, atMs: number): TickOutcome
  onHeartbeat(venuePrice: number, ourPrice: number, atMs: number, symbol: string): { diverged: boolean; strikes: number; bps: number }
  requestRealign(atMs: number): { granted: boolean; reason: string }
  placeOrder(atMs: number): { granted: boolean; reason: string }
  state(atMs: number, symbol: string): SymbolAlignmentSnapshot
  worstAlignment(atMs: number): AlignmentAggregate
  events(): readonly AlignmentEvent[]
} {
  assertAlignmentParams(params)
  let epoch: number | null = null
  let buffer: Tick[] = []
  let forcedResnapshots = 0
  let droppedTicks = 0
  // 每个标的各自的最后序号：全局比较会让两个交错的标的互相误判（2026-10-01 真实冒烟实测）
  const lastSeqBySymbol = new Map<string, number>()
  // 每个标的各自的价格状态：快照年龄/对齐态/分歧连击（2026-10-02 探针实测后修，见模块头注）
  const symbolStates = new Map<string, SymbolState>()
  const realignBucket = createTokenBucket(params.realignTokenCapacity, params.realignRefillPerSec, startedAtMs)
  const orderBucket = createTokenBucket(params.orderTokenCapacity, params.orderRefillPerSec, startedAtMs)
  const log: AlignmentEvent[] = []
  const note = (atMs: number, kind: AlignmentEvent['kind'], detail: string): void => {
    log.push({ atMs, kind, detail })
  }

  /** 读：没见过就不建档（否则"探一下未知标的"会污染聚合态）。 */
  const peekSymbol = (symbol: string): SymbolState => symbolStates.get(symbol) ?? UNSEEN_SYMBOL_STATE
  /** 写：真收到该标的的事件才建档。 */
  const symbolStateOf = (symbol: string): SymbolState => {
    let state = symbolStates.get(symbol)
    if (state === undefined) {
      state = { snapshotAtMs: null, alignment: 'unaligned', divergenceStrikes: 0 }
      symbolStates.set(symbol, state)
    }
    return state
  }

  /** 快照年龄**按本标的**判：异标的的新快照不构成本标的的基准。 */
  const freshEnough = (atMs: number, symbol: string): boolean => {
    const state = peekSymbol(symbol)
    return state.snapshotAtMs !== null && atMs - state.snapshotAtMs <= params.snapshotAgeBudgetMs
  }

  const bufferedOf = (symbol: string): readonly Tick[] => buffer.filter((tick) => tick.symbol === symbol)

  /** 取走并清掉**这只标的**的缓冲（按 seq 排序）——异标的的 tick 必须留在缓冲里。 */
  const takeBuffered = (symbol: string): readonly Tick[] => {
    const mine = buffer.filter((tick) => tick.symbol === symbol)
    if (mine.length === 0) return []
    buffer = buffer.filter((tick) => tick.symbol !== symbol)
    return mine.slice().sort((left, right) => left.seq - right.seq)
  }

  const enforceBounds = (atMs: number): void => {
    const tooMany = buffer.length > params.bufferMaxTicks
    const tooBig = buffer.length * BYTES_PER_TICK > params.bufferMaxBytes
    if (!tooMany && !tooBig) return
    buffer = []
    // 全局界是**通道级**事实（§3）：整块缓冲被丢，所有标的一起回到 unaligned 等新快照。
    for (const state of symbolStates.values()) state.alignment = 'unaligned'
    forcedResnapshots += 1
    note(atMs, 'drop', 'buffer exceeded its global bound; buffer dropped and a resnapshot is required')
  }

  const assertSymbol = (symbol: string, where: string): void => {
    if (typeof symbol !== 'string' || symbol === '') {
      throw new Error(
        where + '：对齐态是**标的级**的，必须传 symbol——不传就等于把某只标的的价格状态当成全 desk 的' +
        '（这正是 2026-10-02 验收发现 F3 的缺陷形态）。聚合观测请用 worstAlignment(atMs)（不得作为发布/风控输入）。',
      )
    }
  }

  const readSymbol = (atMs: number, symbol: string): SymbolAlignmentSnapshot => {
    const state = peekSymbol(symbol)
    const effective: Alignment = state.alignment === 'aligned' && !freshEnough(atMs, symbol) ? 'stale' : state.alignment
    const mine = bufferedOf(symbol)
    return {
      symbol,
      epoch,
      alignment: effective,
      snapshotAtMs: state.snapshotAtMs,
      snapshotAgeMs: state.snapshotAtMs === null ? null : Math.max(0, atMs - state.snapshotAtMs),
      buffered: mine.length,
      bytes: mine.length * BYTES_PER_TICK,
      divergenceStrikes: state.divergenceStrikes,
      forcedResnapshots,
      droppedTicks,
    }
  }

  return {
    onSnapshot(snapshot, atMs) {
      if (epoch !== null && snapshot.epoch < epoch) {
        note(atMs, 'drop', 'snapshot for ' + snapshot.symbol + ' epoch ' + String(snapshot.epoch) + ' is older than current epoch ' + String(epoch) + '; ignored')
        return { accepted: false, reason: 'stale-epoch', published: [] }
      }
      const epochChanged = epoch !== null && snapshot.epoch !== epoch
      epoch = snapshot.epoch
      const state = symbolStateOf(snapshot.symbol)
      state.snapshotAtMs = atMs
      state.alignment = 'aligned'
      state.divergenceStrikes = 0
      // epoch 变了 ⇒ 旧缓冲一律丢弃（卡片原文）。缓冲与 epoch 都是通道级事实，
      // 所以这里丢的是**所有标的**的缓冲——这一条不是"异标的互相影响"，是世代切换。
      if (epochChanged) buffer = []
      note(atMs, 'snapshot', 'snapshot for ' + snapshot.symbol + ' epoch ' + String(epoch) + (epochChanged ? ' (epoch changed: old buffer discarded)' : ''))
      // 先缓冲后发布的另一半：只补发**这只标的**的缓冲（异标的的快照不得处置本标的的 tick）。
      const flushed = takeBuffered(snapshot.symbol)
      if (flushed.length > 0) note(atMs, 'tick', 'flushed ' + String(flushed.length) + ' buffered ' + snapshot.symbol + ' tick(s) after the snapshot arrived')
      return { accepted: true, reason: epochChanged ? 'epoch-changed' : 'ok', published: flushed }
    },
    onTick(tick, atMs) {
      if (epoch !== null && tick.epoch !== epoch) {
        droppedTicks += 1
        // 只降**肇事标的**（§9：降级不得自愈成闩锁、也不牵连别的标的）。
        symbolStateOf(tick.symbol).alignment = 'unaligned'
        forcedResnapshots += 1
        note(atMs, 'drop', 'tick for ' + tick.symbol + ' epoch ' + String(tick.epoch) + ' != channel epoch ' + String(epoch) + '; tick dropped and a resnapshot is required')
        return { published: [], buffered: buffer.length, dropped: 1, reason: 'epoch-mismatch' }
      }
      // 建档：**见过 tick 的标的也是"已知标的"**——只喂 tick、从没拿到快照的标的必须出现在
      // 聚合观测里（否则断供标的在 worstAlignment 上隐身，正是这次缺陷的同一形态）。
      const symbolState = symbolStateOf(tick.symbol)
      // 快照年龄**按本标的**判（2026-10-02 F3）：异标的的新快照不能让本标的的旧价变成可信价格。
      if (symbolState.snapshotAtMs !== null && !freshEnough(atMs, tick.symbol)) {
        droppedTicks += 1
        symbolState.alignment = 'stale'
        note(atMs, 'stale', 'snapshot for ' + tick.symbol + ' is older than the age budget; tick dropped')
        return { published: [], buffered: buffer.length, dropped: 1, reason: 'snapshot-stale' }
      }
      // 还没有任何快照 ⇒ 先缓冲等快照（先缓冲后发布的前一半），不丢。
      // 乱序：序号回退的 tick 直接丢（它描述的是更早的价格，补进去只会污染序列）。
      const previousSeq = lastSeqBySymbol.get(tick.symbol) ?? -1
      if (tick.seq <= previousSeq) {
        droppedTicks += 1
        note(atMs, 'drop', 'out-of-order tick ' + tick.symbol + ' seq ' + String(tick.seq) + ' <= ' + String(previousSeq))
        return { published: [], buffered: buffer.length, dropped: 1, reason: 'out-of-order' }
      }
      lastSeqBySymbol.set(tick.symbol, tick.seq)
      buffer = [...buffer, tick]
      enforceBounds(atMs)
      // 先缓冲后发布：只有**本标的**已对齐时才把它发出去；别的标的的 tick 继续等自己的基准。
      if (symbolState.alignment !== 'aligned') {
        return { published: [], buffered: buffer.length, dropped: 0, reason: 'buffered-only' }
      }
      const published = takeBuffered(tick.symbol)
      note(atMs, 'tick', 'published ' + String(published.length) + ' buffered ' + tick.symbol + ' tick(s)')
      return { published, buffered: buffer.length, dropped: 0, reason: 'published' }
    },
    onHeartbeat(venuePrice, ourPrice, atMs, symbol) {
      assertSymbol(symbol, 'onHeartbeat(venuePrice, ourPrice, atMs, symbol)')
      const bps = ourPrice === 0 ? Number.POSITIVE_INFINITY : Math.abs(venuePrice - ourPrice) / ourPrice * 10_000
      const state = symbolStateOf(symbol)
      if (bps > params.divergenceBps) {
        state.divergenceStrikes += 1
      } else {
        state.divergenceStrikes = 0
      }
      if (state.divergenceStrikes >= params.divergenceStrikes) {
        state.alignment = 'stale'
        // 只丢这只标的的缓冲：分歧是标的级判定。
        buffer = buffer.filter((tick) => tick.symbol !== symbol)
        forcedResnapshots += 1
        note(atMs, 'divergence', symbol + ' diverged by ' + bps.toFixed(1) + ' bps for ' + String(state.divergenceStrikes) + ' consecutive checks: forced resnapshot, treated as stale')
        return { diverged: true, strikes: state.divergenceStrikes, bps }
      }
      return { diverged: false, strikes: state.divergenceStrikes, bps }
    },
    requestRealign(atMs) {
      const granted = realignBucket.take(atMs)
      if (!granted) {
        note(atMs, 'realign', 're-alignment token bucket is empty; request refused')
        return { granted: false, reason: 'realign-budget-exhausted' }
      }
      // 重对齐是**通道级**请求（令牌桶也是通道级的）：所有已知标的回到 unaligned 等新快照。
      for (const state of symbolStates.values()) state.alignment = 'unaligned'
      note(atMs, 'realign', 're-alignment granted')
      return { granted: true, reason: 'ok' }
    },
    placeOrder(atMs) {
      // 下单预算与快照预算**完全独立**：快照洪泛不能把下单通道饿死。
      const granted = orderBucket.take(atMs)
      return granted ? { granted: true, reason: 'ok' } : { granted: false, reason: 'order-budget-exhausted' }
    },
    state(atMs, symbol) {
      assertSymbol(symbol, 'state(atMs, symbol)')
      return readSymbol(atMs, symbol)
    },
    worstAlignment(atMs) {
      // 聚合态：**只用于观测/告警**（字段名就叫 worstAlignment，没有 alignment 字段可供误用）。
      const knownSymbols = [...symbolStates.keys()].sort()
      const bySymbol: Record<string, Alignment> = {}
      const staleSymbols: string[] = []
      const unalignedSymbols: string[] = []
      // 一个标的都不知道 ⇒ unaligned（没有可信价格的集合不可能是 aligned）。
      let worstAlignment: Alignment = knownSymbols.length === 0 ? 'unaligned' : 'aligned'
      for (const symbol of knownSymbols) {
        const view = readSymbol(atMs, symbol)
        bySymbol[symbol] = view.alignment
        if (view.alignment === 'stale') staleSymbols.push(symbol)
        if (view.alignment === 'unaligned') unalignedSymbols.push(symbol)
        worstAlignment = worse(worstAlignment, view.alignment)
      }
      return {
        worstAlignment,
        bySymbol,
        knownSymbols,
        staleSymbols,
        unalignedSymbols,
        buffered: buffer.length,
        bytes: buffer.length * BYTES_PER_TICK,
        forcedResnapshots,
        droppedTicks,
      }
    },
    events: () => log,
  }
}

/** 词汇必须是 risk-gate 的那一套（导入即证明，不是注释里的一句话）。 */
export const ALIGNMENT_VOCABULARY: readonly Alignment[] = PRICE_ALIGNMENTS
