/**
 * 统一资产台账共享 Store（issue #65 数据管道出 QuoteStage）：
 * 资产面板 2026-09-05 起挂右缘会话列容器（SessionRail 树），与 QuoteStage
 * 不再同树——台账快照/盯市价格/FX/写动作抽成无 React 依赖的单例 store，
 * 面板组件消费并驱动轮询（挂载即开、卸载即停），QuoteStage 只保留下单
 * 成功后 setHoldingsPanelOpen(true) 的联动入口。
 *
 * 状态分片：
 * - data：台账快照 book（imported 源 + staged）+ live 打标持仓 + 盯市价格 +
 *   FX 快照（一个对象一次 notify）；
 * - baseCurrency：汇总基准币（localStorage 持久化，契约 §6.3）；
 * - open：面板开关（会话级默认关——盖住对话列，不宜跨会话记忆）。
 *
 * 轮询节奏与原 QuoteStage 实现一致：30s 盯市 + live 刷新（TICKERS_CHUNK=32
 * 分块）、SSE 'holdings' 失效信号重拉快照；fetch 失败静默保留上一帧。
 */
import { createObservable } from './store.ts'
import {
  fetchHoldings, fetchFx, confirmHoldings, discardHoldings, addHolding, updateHolding, removeHolding,
  fetchMarkets, fetchTickers, fetchTradePositions, subscribeTradingEvents,
} from './api.ts'
import {
  DEFAULT_HOLDINGS_BASE_CURRENCY, HOLDINGS_BASE_CURRENCIES, HOLDINGS_BASE_CURRENCY_KEY, HOLDINGS_MARKETS,
  MARKET_DEFAULT_CURRENCY, holdingsPriceKey,
} from './holdings-types.ts'
import type {
  FxSnapshot, Holding, HoldingsBaseCurrency, HoldingsBookSnapshot, NewHolding, NewHoldingInput, TaggedPosition,
} from './holdings-types.ts'
import type { MarketId } from './types.ts'

/** 桥单次批量报价 symbols 封顶（镜像 node 半 bridge.ts MAX_SYMBOLS）。 */
const TICKERS_CHUNK = 32

export interface HoldingsDataSnapshot {
  /** 宿主台账快照；null = 桥缺席（老部署）或未加载——imported 源降级为空。 */
  book: HoldingsBookSnapshot | null
  /** 四市场 live 持仓（origin='live' 已打标）。 */
  liveTagged: TaggedPosition[]
  /** 盯市价格表：键 `${market}:${symbol}`（契约 §6.2）。 */
  prices: Record<string, number>
  /** FX 快照；null = 未拉取/桥缺席 → 汇总折算降级为未折算分区。 */
  fx: FxSnapshot | null
}

const dataStore = createObservable<HoldingsDataSnapshot>({
  book: null,
  liveTagged: [],
  prices: {},
  fx: null,
})

/** 台账数据 Store（useSyncExternalStore 直用；快照引用不变则不触发渲染）。 */
export const holdingsDataStore = {
  subscribe: dataStore.subscribe,
  getSnapshot: dataStore.getSnapshot,
}

function patchData(part: Partial<HoldingsDataSnapshot>): void {
  dataStore.set({ ...dataStore.getSnapshot(), ...part })
}

/* ── 面板开关 ─────────────────────────────────────────────── */

const openStore = createObservable<boolean>(false)

/** 资产面板开关 Store（SessionRail 页签 + QuoteStage 下单联动共用）。 */
export const holdingsPanelStore = {
  subscribe: openStore.subscribe,
  getSnapshot: openStore.getSnapshot,
}

/** 打开/关闭资产面板（SessionRail 页签与下单后自动展开共用入口）。 */
export function setHoldingsPanelOpen(open: boolean): void {
  openStore.set(open)
}

/* ── 基准币 ───────────────────────────────────────────────── */

const baseStore = createObservable<HoldingsBaseCurrency>(readBaseCurrency())

/** 汇总基准币 Store（契约 §6.3：localStorage 持久化，缺省 USD）。 */
export const holdingsBaseStore = {
  subscribe: baseStore.subscribe,
  getSnapshot: baseStore.getSnapshot,
}

function readBaseCurrency(): HoldingsBaseCurrency {
  try {
    const raw = localStorage.getItem(HOLDINGS_BASE_CURRENCY_KEY)
    if (raw !== null && (HOLDINGS_BASE_CURRENCIES as readonly string[]).includes(raw)) {
      return raw as HoldingsBaseCurrency
    }
  } catch { /* 忽略 */ }
  return DEFAULT_HOLDINGS_BASE_CURRENCY
}

/** 切换基准币并持久化。 */
export function setHoldingsBaseCurrency(base: HoldingsBaseCurrency): void {
  baseStore.set(base)
  try {
    localStorage.setItem(HOLDINGS_BASE_CURRENCY_KEY, base)
  } catch { /* 忽略 */ }
}

/* ── 拉取动作（面板组件的 usePoll 调用面）────────────────── */

/** 台账快照首拉/重拉（SSE 失效信号与写动作成功后共用）。 */
export async function reloadHoldingsBook(): Promise<void> {
  try {
    patchData({ book: await fetchHoldings() })
  } catch {
    /* 桥不可用：保留上一帧（book 保持 null → imported 源降级为空） */
  }
}

/** 各市场 provider 名缓存（live 持仓的 account 标签；拉一次）。 */
let providers: Partial<Record<MarketId, string>> | null = null

async function ensureProviders(): Promise<Partial<Record<MarketId, string>>> {
  if (providers !== null) return providers
  try {
    const markets = await fetchMarkets()
    const map: Partial<Record<MarketId, string>> = {}
    for (const info of markets) {
      if (info.provider !== undefined && (HOLDINGS_MARKETS as readonly string[]).includes(info.id)) {
        map[info.id as MarketId] = info.provider
      }
    }
    providers = map
  } catch {
    /* 下轮重试（providers 保持 null） */
  }
  return providers ?? {}
}

/** live 源（契约 §6.4）：四个市场逐个 GET /trade/positions?market=，失败静默跳过。 */
export async function refreshLiveTagged(): Promise<void> {
  const providersNow = await ensureProviders()
  const perMarket = await Promise.all(HOLDINGS_MARKETS.map(async (m): Promise<TaggedPosition[]> => {
    const result = await fetchTradePositions(m)
    if (result.rows === null) return [] // 未挂交易连接器/凭证缺失/失败 → 该市场静默跳过
    return result.rows.map((p) => ({
      ...p,
      origin: 'live' as const,
      kind: 'real' as const,
      market: m,
      account: providersNow[m] ?? m,
      currency: MARKET_DEFAULT_CURRENCY[m],
    }))
  }))
  patchData({ liveTagged: perMarket.flat() })
}

/** 批量盯市：targets 键（`${market}:${symbol}` 逗号串）按市场分组、32 个/块。 */
export async function refreshM2mPrices(targetsKey: string): Promise<void> {
  const keys = targetsKey === '' ? [] : targetsKey.split(',')
  if (keys.length === 0) {
    patchData({ prices: {} })
    return
  }
  const byMarket = new Map<MarketId, string[]>()
  for (const key of keys) {
    const sep = key.indexOf(':')
    const market = key.slice(0, sep) as MarketId
    const symbol = key.slice(sep + 1)
    const bucket = byMarket.get(market)
    if (bucket === undefined) byMarket.set(market, [symbol])
    else bucket.push(symbol)
  }
  const next: Record<string, number> = {}
  await Promise.all([...byMarket.entries()].map(async ([m, symbols]) => {
    for (let offset = 0; offset < symbols.length; offset += TICKERS_CHUNK) {
      const chunk = symbols.slice(offset, offset + TICKERS_CHUNK)
      try {
        const outcome = await fetchTickers(m, chunk)
        for (const sym of chunk) {
          const result = outcome[sym]
          if (result?.ok === true && result.ticker.price > 0) next[holdingsPriceKey(m, sym)] = result.ticker.price
        }
      } catch {
        /* 单块失败不拖垮整批；下轮重试 */
      }
    }
  }))
  patchData({ prices: next })
}

/** FX 快照（换基准币时拉取；失败 → null，不阻断原币展示）。 */
export async function refreshFx(base: HoldingsBaseCurrency): Promise<void> {
  try {
    const fx = await fetchFx(base)
    if (holdingsBaseStore.getSnapshot() === base) patchData({ fx })
  } catch {
    patchData({ fx: null })
  }
}

/* ── 台账写动作（契约 §6.3；成功 → 重拉快照，SSE 同源信号双保险幂等）── */

export const holdingsActions = {
  async confirm(ids: string[], edits?: Record<string, Partial<NewHolding>>): Promise<boolean> {
    const revision = await confirmHoldings(ids, edits)
    if (revision === null) return false
    await reloadHoldingsBook()
    return true
  },
  async discard(ids: string[]): Promise<boolean> {
    const revision = await discardHoldings(ids)
    if (revision === null) return false
    await reloadHoldingsBook()
    return true
  },
  async add(item: NewHoldingInput): Promise<boolean> {
    const created = await addHolding(item)
    if (created === null) return false
    await reloadHoldingsBook()
    return true
  },
  async update(id: string, patch: Partial<NewHolding>): Promise<boolean> {
    const revision = await updateHolding(id, patch)
    if (revision === null) return false
    await reloadHoldingsBook()
    return true
  },
  async remove(id: string): Promise<boolean> {
    const revision = await removeHolding(id)
    if (revision === null) return false
    await reloadHoldingsBook()
    return true
  },
}

/** staged 待确认区（面板横幅/确认对话框消费）。 */
export function stagedHoldings(): Holding[] {
  return holdingsDataStore.getSnapshot().book?.staged ?? []
}

/** SSE 'holdings' 失效信号订阅（agent 经 holdings_stage 写入 → 重拉快照）。
 *  返回取消订阅函数（useEffect 清理直用）。 */
export function subscribeTradingEventsHoldings(): () => void {
  return subscribeTradingEvents({
    holdings: () => { void reloadHoldingsBook() },
  })
}
