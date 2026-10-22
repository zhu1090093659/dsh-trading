/**
 * 用户可见路径确定性工作量普查：「点击打开右侧面板 / 左栏 / 订单簿 / 新闻流 / 委托面板
 * → 首次显示可用内容」。
 *
 * 测量卡（measure-first）：
 * | 字段 | 取值 |
 * |---|---|
 * | 用户操作 | 点击竖条按钮打开某个面板（资产 / 定时任务 / 快讯 / 宏观 / 预测）或打开左栏自选；订单簿 / 新闻流 / 委托面板由 QuoteStage 原位展开。外部可观察完成条件 = 该面板首次拿到非空数据并铺出列表行 |
 * | 工作负载 | 真实规模：自选 18 行（crypto 2 / cn 7 / hk 2 / us 6 / futures 1）、持仓 15 条（crypto 2 / us 6 / cn 6 / hk 1）、自选分组 1、知识卡 6、storage 文件 401。尾部规模：自选 84 行（cn 40 越过桥 32 上限）、持仓 96 条（cn 40 → 2 块） |
 * | 进入路径 | 生产模块直入：holdings-store.refresh系列/reload系列、api.fetch系列、tasks-api.fetch系列、market-providers.ensure系列、intraday-series 三函数、holdings-aggregate.aggregateHoldings、position-rounds.derivePositionRounds、prediction-view 三函数。本基准**只桩 globalThis.fetch**（api.ts:21 getJson 与 tasks-api.ts:32 tasksJson 的唯一出网口），以及 Intl.DateTimeFormat.prototype.format/formatToParts 的调用计数 |
 * | 时钟 | **本表无权威时钟**。CPU 仅约 12% idle、compressor 5.6GB，墙钟不具可比性；脚本末尾附带的 elapsed 一律标注「非权威、待安静窗口复测」。权威量 = 请求次数、块数、串行波数、条目数、Intl 调用次数、store 通知次数 |
 * | 内存 | 本基准不做内存断言（不给 process.memoryUsage 结论） |
 * | 判据 | 确定性计数（同一输入两次运行完全相等）+ §0 的三条源码漂移守卫（批量报价按 TICKERS_CHUNK 分块 / prevClose 兜底带 ticker 与 prices 门控 / refreshLiveTagged 与 refreshM2mPrices 分处两条 effect）+ 正反两路对照：未分块的 40 行 /tickers 必被桥 400 拒绝、ticker 缺 prevClose 时兜底按行补拉 |
 * | 行为 | 不改生产代码；每面板的取数函数与调度顺序原样调用，组件 effect 的循环形态转写在本文件（逐处标注 file:line，并由 §0 的守卫钉在源码上） |
 *
 * 被排除的层与理由：
 *  - transport（HTTP 栈、桥 node 半的 JSON 解析、上游连接器的重试/限流）——两侧相同，
 *    且属于非确定量；本基准只数「发起了几次请求」。
 *  - SSE（subscribeTradingEvents → EventSource，api.ts:1008 起）——Node 无 window 时
 *    该函数直接 return，不建连；真浏览器里是**每会话 1 条共享连接**，不随面板数线性增长。
 *  - React 渲染、DOM 节点、首帧、输入延迟——必须真浏览器，本轮一律记「未测」。
 *
 * 运行：pnpm exec tsx spikes/bench-ui-panel-mount.mts
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TICKERS_CHUNK, holdingsDataStore, reloadHoldingsBook, refreshLiveTagged, refreshM2mPrices, refreshFx,
  subscribeTradingEventsHoldings,
} from '../packages/client-ui-trading/src/client/holdings-store.ts'
import { aggregateHoldings } from '../packages/client-ui-trading/src/client/holdings-aggregate.ts'
import { derivePositionRounds } from '../packages/client-ui-trading/src/client/position-rounds.ts'
import { paperTradingStore } from '../packages/client-ui-trading/src/client/paper-trading-store.ts'
import { HOLDINGS_MARKETS } from '../packages/client-ui-trading/src/client/holdings-types.ts'
import { intradayCandidates, intradayRequest, selectIntradaySeries } from '../packages/client-ui-trading/src/client/intraday-series.ts'
import {
  fetchMarkets, fetchSymbols, fetchKlines, fetchTickers, fetchFlash, fetchMacroCalendar,
  fetchMacroRates, fetchPredictionFomc, fetchOrderbook, fetchRecentTrades, fetchNews,
} from '../packages/client-ui-trading/src/client/api.ts'
import { fetchTasksSnapshot, fetchTasksMeta } from '../packages/client-ui-trading/src/client/tasks-api.ts'
import { inflationEventsOf, meetingViewOf, visibleMeetingsOf, VISIBLE_MEETINGS } from '../packages/client-ui-trading/src/client/prediction-view.ts'
import type { MarketId, Ticker } from '../packages/client-ui-trading/src/client/types.ts'

/* ── 断言与小节标题（本文件此前只打印不断言，本轮补上红/绿）──────── */

let failures = 0
function check(ok: boolean, what: string): void {
  if (ok) { console.log('  [OK]   ' + what); return }
  failures += 1
  console.log('  [FAIL] ' + what)
}

function section(title: string): void {
  console.log('\n════ ' + title + ' ════')
}

/* ── 源码现读（漂移即抛错 = 红，不静默）────────────────────────── */

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SRC = {
  holdings: 'packages/client-ui-trading/src/client/HoldingsPanel.tsx',
  holdingsStore: 'packages/client-ui-trading/src/client/holdings-store.ts',
  sidebar: 'packages/client-ui-trading/src/client/MarketSidebar.tsx',
  api: 'packages/client-ui-trading/src/client/api.ts',
  marketProviders: 'packages/client-ui-trading/src/client/market-providers.ts',
  tasksApi: 'packages/client-ui-trading/src/client/tasks-api.ts',
  aggregate: 'packages/client-ui-trading/src/client/holdings-aggregate.ts',
  positionRounds: 'packages/client-ui-trading/src/client/position-rounds.ts',
  quoteStage: 'packages/client-ui-trading/src/client/QuoteStage.tsx',
  bridge: 'packages/bot-api/src/bridge.ts',
} as const

const textCache = new Map<string, string>()
const textOf = (file: string): string => {
  const hit = textCache.get(file)
  if (hit !== undefined) return hit
  const rawText = readFileSync(path.join(ROOT, file), 'utf8')
  textCache.set(file, rawText)
  return rawText
}
const linesOf = (file: string): string[] => textOf(file).split('\n')
/** 1-based：文件内首个匹配行号；找不到抛错（源码漂移即红）。 */
const lineOf = (file: string, re: RegExp, from = 1): number => {
  const lines = linesOf(file)
  for (let index = from - 1; index < lines.length; index += 1) {
    if (re.test(lines[index]!)) return index + 1
  }
  throw new Error('源码漂移：' + file + ' 第 ' + from + ' 行之后找不到 ' + re)
}
const numOf = (file: string, re: RegExp, label: string): number => {
  const found = re.exec(textOf(file))
  if (found === null) throw new Error('源码漂移：' + file + ' 解析不到 ' + label + '（' + re + '）')
  return Number(found[1])
}

/* ── 转写锚点：本文件每处转写都钉在源码上（漂移即红）────────────── */

/** 桥的批量 symbols 上限（bridge.ts：node 半的闸门，超限整批 400）。 */
const MAX_SYMBOLS = numOf(SRC.bridge, /export const MAX_SYMBOLS = (\d+)/, 'bridge MAX_SYMBOLS')
/** 左栏参考序列降级日 K 的取数上限（MarketSidebar.tsx:70）。 */
const DAILY_FALLBACK_LIMIT = numOf(SRC.sidebar, /const DAILY_FALLBACK_LIMIT = (\d+)/, 'MarketSidebar DAILY_FALLBACK_LIMIT')

const SIDEBAR_CHUNK_IMPORT_LINE = lineOf(SRC.sidebar, /^import \{ TICKERS_CHUNK \} from '\.\/holdings-store\.ts'/)
const SIDEBAR_CHUNK_LOOP_LINE = lineOf(SRC.sidebar, /for \(let offset = 0; offset < symbols\.length; offset \+= TICKERS_CHUNK\)/)
const SIDEBAR_CHUNK_SLICE_LINE = lineOf(SRC.sidebar, /symbols: symbols\.slice\(offset, offset \+ TICKERS_CHUNK\)/)
const SIDEBAR_BATCH_LINE = lineOf(SRC.sidebar, /await Promise\.all\(batches\.map\(/)
const SIDEBAR_QUOTE_POLL_LINE = lineOf(SRC.sidebar, /const batches: Array<\{ market: MarketId; symbols: string\[\] \}> = \[\]/)
const PREVCLOSE_PRICES_LINE = lineOf(SRC.sidebar, /const ticker = prices\[key\]/)
const PREVCLOSE_TICKER_GATE_LINE = lineOf(SRC.sidebar, /if \(ticker === undefined \|\| ticker\.prevClose !== undefined\) return/)
const PREVCLOSE_SERIES_GATE_LINE = lineOf(SRC.sidebar, /if \(series\[key\]\?\.prevClose !== undefined\) return/)
const PREVCLOSE_FETCH_LINE = lineOf(SRC.sidebar, /fetchKlines\(row\.market, row\.symbol, '1d', 2\)/)
const ROWKEY_LINE = lineOf(SRC.sidebar, /^export function rowKey/)
const ORDERBOOK_POLL_LINE = lineOf(SRC.quoteStage, /if \(!orderbookOpen \|\| stageTab !== 'chart'/)
const NEWS_POLL_LINE = lineOf(SRC.quoteStage, /stageTab !== 'news' && stageTab !== 'announcements'/)

const LIVE_EFFECT_CALL_LINE = lineOf(SRC.holdings, /void refreshLiveTagged\(\)/)
const LIVE_EFFECT_DEPS_LINE = lineOf(SRC.holdings, /^\s*\}, \[\]\)/, LIVE_EFFECT_CALL_LINE)
const M2M_EFFECT_CALL_LINE = lineOf(SRC.holdings, /void refreshM2mPrices\(/)
const M2M_EFFECT_DEPS_LINE = lineOf(SRC.holdings, /^\s*\}, \[m2mTargetsKey\]\)/, M2M_EFFECT_CALL_LINE)
const HOLDINGS_LIVE_CALLS = (textOf(SRC.holdings).match(/void refreshLiveTagged\(\)/g) ?? []).length
const HOLDINGS_SNAPSHOT_READS = (textOf(SRC.holdings).match(/useSyncExternalStore\(/g) ?? []).length
const SIDEBAR_SNAPSHOT_READS = (textOf(SRC.sidebar).match(/useSyncExternalStore\(/g) ?? []).length

/** 与 MarketSidebar.tsx 的 rowKey 同口径（:73-75，守卫见 §0）。 */
const rowKey = (market: string, symbol: string): string => market + ':' + symbol

/** m2mTargetsKey 的同一口径（HoldingsPanel.tsx:447-453：market:symbol 去重后排序成逗号串）。 */
function m2mTargetsKeyOf(snapshot: { liveTagged: ReadonlyArray<{ market?: string; symbol: string }> }): string {
  const keys = new Set<string>()
  for (const position of snapshot.liveTagged) {
    if (position.market !== undefined) keys.add(rowKey(position.market, position.symbol))
  }
  return [...keys].sort().join(',')
}

/* ── 计量器 ─────────────────────────────────────────────────── */

interface HttpCall { path: string; query: string; status: number }

const http: HttpCall[] = []
const store = { notify: 0 }
const intl = { format: 0, formatToParts: 0 }
const work = { bars: 0, items: 0, peak: 0 }
let inflight = 0

function resetMeters(): void {
  http.length = 0
  store.notify = 0
  intl.format = 0
  intl.formatToParts = 0
  work.bars = 0
  work.items = 0
  work.peak = 0
  inflight = 0
}

/** Intl 调用计数：marketLocalDay/marketLocalMinute 每个 bar 各一次（market-time.ts:48,54）。 */
function instrumentIntl(): boolean {
  try {
    const proto = Intl.DateTimeFormat.prototype as unknown as Record<string, unknown>
    const desc = Object.getOwnPropertyDescriptor(proto, 'format')
    if (desc === undefined || typeof desc.get !== 'function') return false
    const originalGet = desc.get
    Object.defineProperty(proto, 'format', {
      configurable: true,
      get(this: Intl.DateTimeFormat) {
        const bound = originalGet.call(this) as (value: number | Date) => string
        return (value: number | Date): string => { intl.format += 1; return bound(value) }
      },
    })
    const originalParts = proto.formatToParts as (value: number | Date) => unknown[]
    proto.formatToParts = function (this: Intl.DateTimeFormat, value: number | Date): unknown[] {
      intl.formatToParts += 1
      return originalParts.call(this, value)
    }
    return true
  } catch {
    return false
  }
}

/* ── 工作负载（owner 授权的真实聚合特征）──────────────────────── */

type WatchCounts = Record<'crypto' | 'us' | 'cn' | 'hk' | 'futures' | 'global', number>
type PositionCounts = Record<'crypto' | 'us' | 'cn' | 'hk', number>

interface Workload {
  readonly id: string
  readonly watch: WatchCounts
  readonly positions: PositionCounts
  readonly groups: number
  readonly knowledgeCards: number
  readonly storageFiles: number
}

const REAL: Workload = {
  id: 'real',
  watch: { crypto: 2, us: 6, cn: 7, hk: 2, futures: 1, global: 0 },
  positions: { crypto: 2, us: 6, cn: 6, hk: 1 },
  groups: 1,
  knowledgeCards: 6,
  storageFiles: 401,
}

/** 尾部规模：把两处 32 封顶都越过去（自选 cn 40 行、持仓 cn 40 条）。 */
const TAIL: Workload = {
  id: 'tail',
  watch: { crypto: 8, us: 24, cn: 40, hk: 8, futures: 4, global: 0 },
  positions: { crypto: 20, us: 30, cn: 40, hk: 6 },
  groups: 4,
  knowledgeCards: 24,
  storageFiles: 401,
}

const watchRows = (w: Workload): number => Object.values(w.watch).reduce((a, b) => a + b, 0)
const positionRows = (w: Workload): number => Object.values(w.positions).reduce((a, b) => a + b, 0)
/** 该市场自选行 → 真实 symbol（确定性命名，只用于桩载荷）。 */
const symOf = (market: string, index: number): string => market.toUpperCase() + String(index).padStart(3, '0')

/* ── 固定时钟基准（保证载荷与计数确定）────────────────────────── */
const BASE_MS = Date.UTC(2026, 9, 20, 0, 0, 0)

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '30m': 1_800_000, '1h': 3_600_000, '1d': 86_400_000,
}

function klinesFor(interval: string, limit: number): unknown[] {
  const step = INTERVAL_MS[interval] ?? 60_000
  const bars: unknown[] = []
  for (let i = limit - 1; i >= 0; i--) {
    const openTime = BASE_MS - i * step
    bars.push({ openTime, open: 10, high: 11, low: 9, close: 10 + (i % 7) * 0.01, volume: 100, closeTime: openTime + step })
  }
  return bars
}

/* ── transport 桩（唯一被桩的层：globalThis.fetch）──────────────── */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface TransportOptions {
  /** 正对照用：让 ticker 不带官方昨收，逼出 prevClose 兜底那一路。 */
  readonly omitPrevClose?: boolean
}

function installTransport(w: Workload, options: TransportOptions = {}): void {
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    inflight += 1
    if (inflight > work.peak) work.peak = inflight
    try {
    // 让出一次微任务：使 Promise.all 扇出的并发请求在计量器眼里真正重叠
    // （桩体本身是同步的，不 yield 的话每次调用的 inflight 都会立刻归零）。
    await Promise.resolve()
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname
    const q = url.searchParams
    const market = q.get('market') ?? ''

    // 镜像 node 半 bridge.ts:215 MAX_SYMBOLS / :869 超限 400（常量从源码现读）。
    if (path === '/dshtrading/api/tickers') {
      const symbols = (q.get('symbols') ?? '').split(',').filter(Boolean)
      if (symbols.length > MAX_SYMBOLS) {
        http.push({ path, query: q.toString(), status: 400 })
        return json({ code: 'TRADING_PROTOCOL', message: 'tickers: too many symbols' }, 400)
      }
    }
    // 镜像腾讯 A 股不提供 1m（intraday-series.ts:2-6 注释的降级前提）。
    if (path === '/dshtrading/api/klines' && market === 'cn' && q.get('interval') === '1m') {
      http.push({ path, query: q.toString(), status: 400 })
      return json({ code: 'TRADING_UNSUPPORTED_INTERVAL', message: 'tencent cn has no 1m' }, 400)
    }

    http.push({ path, query: q.toString(), status: 200 })
    switch (path) {
      case '/dshtrading/api/markets':
        return json({ markets: (['crypto', 'us', 'cn', 'hk', 'futures', 'global'] as const)
          .map(id => ({ id, provider: id + '-provider', klineCapabilities: [{ interval: '5m', maxBars: 500 }] })) })
      case '/dshtrading/api/symbols': {
        const n = w.watch[(market as keyof WatchCounts)] ?? 0
        return json({ symbols: Array.from({ length: n }, (_, i) => ({ symbol: symOf(market, i), name: symOf(market, i) })) })
      }
      case '/dshtrading/api/klines':
        return json({ klines: klinesFor(q.get('interval') ?? '1m', Number(q.get('limit') ?? '0')) })
      case '/dshtrading/api/tickers': {
        const symbols = (q.get('symbols') ?? '').split(',').filter(Boolean)
        const tickers: Record<string, unknown> = {}
        for (const s of symbols) {
          tickers[s] = {
            ok: true,
            ticker: {
              symbol: s, price: 12.5, name: s + ' name',
              ...(options.omitPrevClose === true ? {} : { prevClose: 12 }),
            },
          }
        }
        return json({ tickers })
      }
      case '/dshtrading/api/holdings': {
        // 15 条持仓只放在 live 源（/trade/positions）单一侧：本账本无 imported 行。
        // 若两侧都给 15 条，taggedPositions 会变成 30 行 —— 那是双计，不是真实规模。
        return json({ ok: true, revision: 7, staged: [], holdings: [] })
      }
      case '/dshtrading/api/fx':
        return json({ ok: true, base: q.get('base') ?? 'USD', rates: { USD: 1, CNY: 7.1, HKD: 7.8 }, asOf: BASE_MS, stale: false })
      case '/dshtrading/api/trade/positions': {
        const n = w.positions[(market as keyof PositionCounts)] ?? 0
        return json({ ok: true, positions: Array.from({ length: n }, (_, i) => ({
          symbol: symOf(market, i), side: 'long', size: 10, entryPrice: 12, markPrice: 12.5, unrealizedPnl: 5,
        })) })
      }
      case '/dshtrading/api/flash':
        return json({ ok: true, items: Array.from({ length: 30 }, (_, i) => ({
          source: 'jin10', title: 'flash ' + String(i), url: 'https://example.invalid/' + String(i),
          publishedAt: new Date(BASE_MS - i * 60_000).toISOString(), hot: '沸',
        })), hasMore: true, nextCursor: 'c1' })
      case '/dshtrading/api/macro/calendar':
        // 代码实测量级：MacroPanel.tsx:24「整周实测已到 254 条」。
        return json({ ok: true, items: Array.from({ length: 254 }, (_, i) => ({
          publishedAt: new Date(BASE_MS - i * 3_600_000).toISOString(), star: i % 6,
          region: ['美国', '日本', '中国', '德国', '法国'][i % 5]!, title: 'event ' + String(i),
          previous: '1.0', consensus: '1.1',
        })) })
      case '/dshtrading/api/macro/rates':
        // MacroPanel.tsx:12「央行利率 = 金十网页版 interest_rates（全量 30 家）」。
        return json({ ok: true, items: Array.from({ length: 30 }, (_, i) => ({
          region: ['美国', '日本', '中国'][i % 3]!, bankName: 'bank ' + String(i), rate: '4.5', publishedAt: '2026-10-01',
        })) })
      case '/dshtrading/api/prediction/fomc':
        return json({ ok: true, fetchedAt: new Date(BASE_MS).toISOString(),
          meetings: Array.from({ length: 4 }, (_, m) => ({
            id: 'm' + String(m), slug: 'fomc-' + String(m), title: 'FOMC ' + String(m),
            endDate: '2026-11-0' + String(m + 1), closed: m === 3, probabilitySum: 1, degraded: [],
            buckets: [{ key: 'no_change', label: 'no change', probability: 0.5, acceptingOrders: true, closed: false }],
          })) })
      case '/dshtrading/api/tasks':
        return json({ ok: true, revision: 2, tasks: [], sessionDefaultPermission: 'workspace-write' })
      case '/dshtrading/api/tasks/meta':
        return json({ ok: true, sessionDefaultPermission: 'workspace-write', workspaces: [], agentPresets: [] })
      case '/dshtrading/api/orderbook':
        return json({ ok: true, orderbook: {
          symbol: q.get('symbol') ?? '', timestamp: BASE_MS,
          bids: Array.from({ length: 10 }, (_, i) => ({ price: 100 - i, amount: 10 + i })),
          asks: Array.from({ length: 10 }, (_, i) => ({ price: 101 + i, amount: 10 + i })),
        } })
      case '/dshtrading/api/trades':
        return json({ ok: true, trades: Array.from({ length: 50 }, (_, i) => ({
          id: 't' + String(i), price: 100 + i * 0.01, amount: 1, side: 'buy', timestamp: BASE_MS - i * 1000,
        })) })
      case '/dshtrading/api/news':
        return json({ ok: true, unavailable: [], items: Array.from({ length: 50 }, (_, i) => ({
          source: 'eastmoney', title: 'news ' + String(i), url: 'https://example.invalid/n' + String(i),
          publishedAt: new Date(BASE_MS - i * 60_000).toISOString(),
        })) })
      default:
        return json({ ok: true })
    }
    } finally { inflight -= 1 }
  }) as unknown as typeof globalThis.fetch
}

/* ── 报告结构 ───────────────────────────────────────────────── */

interface Report {
  panel: string
  entry: string
  http: number
  waves: number
  storeReads: number
  storeNotifies: number
  intl: number
  bars: number
  items: number
  rows: number
  peak: number
  endpoints: Array<[string, number]>
  notes: string[]
  /** 该面板的关键分项计数（供下游汇总按模型引用，不再写字面量）。 */
  detail: Record<string, number>
}

function endpointHistogram(): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const call of http) {
    const key = call.path + (call.status === 400 ? ' [400]' : '')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function report(
  panel: string, entry: string, waves: number, rows: number, storeReads: number,
  notes: string[] = [], detail: Record<string, number> = {},
): Report {
  return {
    panel, entry, waves,
    http: http.length,
    storeReads,
    storeNotifies: store.notify,
    intl: intl.format + intl.formatToParts,
    bars: work.bars,
    items: work.items,
    rows,
    peak: work.peak,
    endpoints: endpointHistogram(),
    notes,
    detail,
  }
}

/* ── 面板场景（转写的只是「调用哪些生产函数、几次」，逐处标注 file:line）── */

/** 资产面板：HoldingsPanel.tsx:413-483（四条独立 effect：台账首拉 / live 刷新 / 批量盯市 / FX）。 */
async function holdingsPanel(w: Workload, coldProviders: boolean): Promise<Report> {
  resetMeters()
  const unsubscribeStore = holdingsDataStore.subscribe(() => { store.notify += 1 })
  // :413-416 台账首拉 + SSE 失效订阅（Node 无 window → 不建连）
  const unsubSse = subscribeTradingEventsHoldings()
  // 挂载瞬间四条 effect 各自起跑。store 是模块级的：同一规模的第二次打开会带着上一拍的
  // liveTagged（键不变 → 盯市 effect 不重跑）；换到另一个规模时那份残留不是真实用户态，
  // 按「本规模首开」处理（空键 → 首拍 0 请求，liveTagged 落地后再打一拍）。
  const snapshotAtMount = holdingsDataStore.getSnapshot()
  const keyAtMount = snapshotAtMount.liveTagged.length === positionRows(w) ? m2mTargetsKeyOf(snapshotAtMount) : ''
  await Promise.all([
    reloadHoldingsBook(),             // :413-416
    refreshLiveTagged(),              // :458-462（dep 恒空 → 只跑一次）
    refreshM2mPrices(keyAtMount),     // :469-478 首拍
    refreshFx('USD'),                 // :481-483
  ])
  // liveTagged 落地 → m2mTargetsKey 变化 → 盯市 effect 整段重跑（dep=[m2mTargetsKey]）；键不变就不重跑
  const keyAfterMount = m2mTargetsKeyOf(holdingsDataStore.getSnapshot())
  const m2mRefired = keyAfterMount !== keyAtMount
  if (m2mRefired) await refreshM2mPrices(keyAfterMount)

  unsubSse()
  const snap = holdingsDataStore.getSnapshot()
  const aggregation = aggregateHoldings(
    [...snap.liveTagged, ...(snap.book?.holdings ?? []).map(h => ({
      symbol: h.symbol, side: h.side, size: h.size, entryPrice: h.entryPrice, timestamp: h.updatedAt,
      origin: 'imported' as const, kind: h.kind, market: h.market, account: h.account, holdingId: h.id,
    }))],
    snap.prices,
    snap.fx ?? undefined,
  )
  derivePositionRounds(paperTradingStore.getFills())
  work.items = aggregation.rows.length + aggregation.summaries.length
  unsubscribeStore()

  const positions = http.filter(call => call.path === '/dshtrading/api/trade/positions').length
  const m2mTickers = http.filter(call => call.path === '/dshtrading/api/tickers').length
  return report(
    coldProviders ? 'HoldingsPanel 首开（providers 冷缓存）' : 'HoldingsPanel 再开（providers 已缓存）',
    'SessionRail 竖条钱包按钮 → setHoldingsPanelOpen(true)',
    3, aggregation.rows.length,
    HOLDINGS_SNAPSHOT_READS + 1,
    [
      'store 读取 ' + String(HOLDINGS_SNAPSHOT_READS + 1) + ' 次（' + String(HOLDINGS_SNAPSHOT_READS)
        + ' 个 useSyncExternalStore 快照 + paperTick 驱动重读，HoldingsPanel.tsx:405-410）',
      'store 通知 = ' + String(store.notify) + ' 次 patchData（首拉 / liveTagged / 盯市拍 / FX' + (m2mRefired ? ' / 键变化后的第二拍' : '') + '）',
      'refreshLiveTagged 在 dep 恒空的 effect 里（HoldingsPanel.tsx:' + String(LIVE_EFFECT_DEPS_LINE) + '）只跑一次 → /trade/positions '
        + String(positions) + ' 次（= HOLDINGS_MARKETS 的 ' + String(HOLDINGS_MARKETS.length) + ' 个市场），不再被盯市 effect 连带重打',
      'refreshM2mPrices 在 dep=[m2mTargetsKey] 的 effect 里（HoldingsPanel.tsx:' + String(M2M_EFFECT_DEPS_LINE) + '）：挂载拍到 '
        + (keyAtMount === '' ? '空键（0 请求）' : '本规模的已有键（' + String(keyAtMount.split(',').length) + ' 个目标）')
        + (m2mRefired ? '，键变化后再打一拍' : '，liveTagged 落地后键不变 → 不重跑')
        + ' → 本拍共 ' + String(m2mTickers) + ' 次 /tickers（每市场 ≤ ' + String(TICKERS_CHUNK) + ' 个/块）',
      coldProviders ? 'ensureMarketProviders 冷启动多 1 次 /markets（market-providers.ts:84）' : 'providers 已缓存 → 0 次 /markets',
      'aggregateHoldings 输入 ' + String(aggregation.rows.length) + ' 行 → ' + String(aggregation.summaries.length)
        + ' 汇总行（holdings-aggregate.ts:196），derivePositionRounds 输入 ' + String(paperTradingStore.getFills().length) + ' 笔 paper 成交',
    ],
    { positions, m2mTickers, markets: coldProviders ? 1 : 0 },
  )
}

/**
 * prevClose 兜底补拉（MarketSidebar.tsx:314-329）：只有「ticker 已落地且确实没有官方昨收」
 * 且「本序列也还没有」才补一次。两条守卫与源码逐字同构，§0 钉在 :317-321 上。
 */
async function prevCloseFallback(
  row: { market: MarketId; symbol: string },
  prices: ReadonlyMap<string, Ticker>,
  series: Map<string, { prevClose?: number }>,
): Promise<number> {
  const key = rowKey(row.market, row.symbol)
  const ticker = prices.get(key)
  if (ticker === undefined || ticker.prevClose !== undefined) return 0
  if (series.get(key)?.prevClose !== undefined) return 0
  try {
    const pair = await fetchKlines(row.market, row.symbol, '1d', 2)
    work.bars += pair.length
    const prevClose = pair.length >= 2 ? pair[pair.length - 2]?.close : undefined
    if (prevClose !== undefined) {
      const entry = series.get(key)
      if (entry !== undefined) entry.prevClose = prevClose
    }
    return 1
  } catch {
    return 0 // 下轮再试
  }
}

/** 参考序列拍：MarketSidebar.tsx:263-332（日内候选粒度 → 降级日 K → prevClose 兜底）。 */
async function seriesPass(
  rows: ReadonlyArray<{ market: MarketId; symbol: string }>,
  prices: ReadonlyMap<string, Ticker>,
  series: Map<string, { prevClose?: number }>,
): Promise<void> {
  await Promise.all(rows.map(async (row) => {
    const key = rowKey(row.market, row.symbol)
    let storedIntraday = false
    for (const interval of intradayCandidates(row.market)) {
      // :278-298 逐候选粒度尝试，首个成功粒度被记住（cn 的 1m 会被桥 400）
      try {
        const request = intradayRequest(row.market, interval)
        const klines = await fetchKlines(row.market, row.symbol, request.interval, request.limit)
        const picked = selectIntradaySeries(row.market, klines)
        work.bars += klines.length
        if (picked.closes.length === 0) throw new Error('empty intraday series')
        series.set(key, {})
        storedIntraday = true
        break
      } catch { /* 试下一档粒度 */ }
    }
    if (!storedIntraday) {
      // :299-313 降级日 K（本桩下不触发：日内候选都能成）
      try {
        const daily = await fetchKlines(row.market, row.symbol, '1d', DAILY_FALLBACK_LIMIT)
        work.bars += daily.length
        if (daily.length === 0) return
        series.set(key, daily.length >= 2 ? { prevClose: daily[daily.length - 2]?.close } : {})
      } catch { /* 序列失败不影响报价行 */ }
    }
    await prevCloseFallback(row, prices, series)
  }))
}

/** 批量报价拍：MarketSidebar.tsx:337-...，按市场分组、每市场按 TICKERS_CHUNK 分块（:355-360）。 */
async function quotePass(
  rows: ReadonlyArray<{ market: MarketId; symbol: string }>,
  prices: Map<string, Ticker>,
): Promise<{ chunks: number; perMarket: string }> {
  const byMarket = new Map<MarketId, string[]>()
  for (const row of rows) {
    const list = byMarket.get(row.market) ?? []
    list.push(row.symbol)
    byMarket.set(row.market, list)
  }
  // :355-360 按块展开成扁平的并行批次（市场数 × 块数），每块各自 try/catch
  const batches: Array<{ market: MarketId; symbols: string[] }> = []
  for (const [market, symbols] of byMarket.entries()) {
    for (let offset = 0; offset < symbols.length; offset += TICKERS_CHUNK) {
      batches.push({ market, symbols: symbols.slice(offset, offset + TICKERS_CHUNK) })
    }
  }
  await Promise.all(batches.map(async ({ market, symbols }) => {
    try {
      const outcome = await fetchTickers(market, symbols)
      for (const [symbol, result] of Object.entries(outcome)) {
        if (result.ok) prices.set(rowKey(market, symbol), result.ticker)
      }
    } catch { /* 块级失败隔离，下轮再试（:384） */ }
  }))
  const perMarket = [...byMarket.entries()]
    .map(([market, symbols]) => market + ' ' + String(symbols.length) + ' 行 → ' + String(Math.ceil(symbols.length / TICKERS_CHUNK)) + ' 块')
    .join('，')
  return { chunks: batches.length, perMarket }
}

/** 左栏自选：MarketSidebar.tsx:134-160（markets + 6 x symbols）+ :263-332（参考序列）+ :337-...（批量报价）。 */
async function marketSidebar(w: Workload): Promise<Report> {
  resetMeters()
  const rows: Array<{ market: MarketId; symbol: string }> = []
  for (const [market, n] of Object.entries(w.watch) as Array<[MarketId, number]>) {
    for (let i = 0; i < n; i++) rows.push({ market, symbol: symOf(market, i) })
  }
  const prices = new Map<string, Ticker>()
  const series = new Map<string, { prevClose?: number }>()

  // :134-139 reloadMarkets → fetchMarkets（不读 providers 缓存，每次都发）
  await fetchMarkets()
  // :147-160 watch 页签 = 6 个市场各一次 fetchSymbols
  await Promise.all((['crypto', 'us', 'cn', 'hk', 'futures', 'global'] as const).map(m => fetchSymbols(m)))

  // 参考序列拍（:263-332）：首拍 onDemand=true → 目标是全部 rows；此刻 prices 还空着
  await seriesPass(rows, prices, series)
  // 批量报价拍（:337-...）：按 TICKERS_CHUNK 分块并行
  const quote = await quotePass(rows, prices)
  // 第二拍参考序列只跑 prevClose 兜底：报价已落地、ticker 带官方昨收 → 同一条守卫仍挡下
  const secondWave = await Promise.all(rows.map(row => prevCloseFallback(row, prices, series)))

  const perMarketRows = new Map<MarketId, number>()
  for (const row of rows) perMarketRows.set(row.market, (perMarketRows.get(row.market) ?? 0) + 1)

  work.items = rows.length
  const tickerCalls = http.filter(call => call.path === '/dshtrading/api/tickers')
  const rejected = tickerCalls.filter(call => call.status === 400).length
  const oneMinute = http.filter(call => call.path === '/dshtrading/api/klines' && call.query.includes('interval=1m')).length
  const kline400 = http.filter(call => call.path === '/dshtrading/api/klines' && call.status === 400).length
  const prevCloseCalls = http.filter(call => call.path === '/dshtrading/api/klines' && /(?:^|&)limit=2$/.test(call.query)).length
  return report(
    'MarketSidebar 左栏自选',
    'MarketDock 挂载 → MarketSidebar（shell.overlay 常驻）',
    3, rows.length, SIDEBAR_SNAPSHOT_READS,
    [
      '1m 尝试 ' + String(oneMinute) + ' 次，其中 ' + String(kline400) + ' 次被 400 拒绝后降 5m（cn：intraday-series.ts:21-23）',
      'prevClose 兜底 ' + String(prevCloseCalls) + ' 次 1d/limit=2（首拍 prices 必空；第二拍补跑 ' + String(secondWave.reduce((a, b) => a + b, 0))
        + ' 次，ticker 带 prevClose 时被 MarketSidebar.tsx:' + String(PREVCLOSE_TICKER_GATE_LINE) + ' 挡下）',
      '批量报价 ' + String(tickerCalls.length) + ' 次 = Σ ceil(n_m/' + String(TICKERS_CHUNK) + ')（' + quote.perMarket + '），每块 ≤ '
        + String(MAX_SYMBOLS) + ' → 0 个 400（MarketSidebar.tsx:' + String(SIDEBAR_CHUNK_LOOP_LINE) + '-' + String(SIDEBAR_CHUNK_SLICE_LINE) + '）',
      rejected > 0
        ? '负对照命中：' + String(rejected) + ' 次 /tickers 因 symbols>' + String(MAX_SYMBOLS) + ' 被桥 400 拒绝'
        : '负对照未触发：0 次 /tickers 400（单市场最多 ' + String(Math.max(0, ...perMarketRows.values())) + ' 行，分块后每块 ≤ ' + String(TICKERS_CHUNK) + '）',
      'Intl 调用 ' + String(intl.format + intl.formatToParts) + ' 次（marketLocalDay/Minute 逐 bar，market-time.ts:48,54）',
      'store 读 = 组件里 useSyncExternalStore 快照数（MarketSidebar.tsx:' + String(lineOf(SRC.sidebar, /useSyncExternalStore\(/)) + '；selection/watchlists 走注入的 hooks 面，不在本口径内）',
    ],
    { chunks: tickerCalls.length, prevClose: prevCloseCalls, oneMinute, rejected, klines: http.filter(call => call.path === '/dshtrading/api/klines').length },
  )
}

/** 正对照：ticker 不带 prevClose 时兜底会按行补拉（证明上面的 0 是守卫生效，不是死分支）。 */
async function prevClosePositiveControl(w: Workload): Promise<{ tickers: number; fallback: number; rows: number }> {
  resetMeters()
  installTransport(w, { omitPrevClose: true })
  const rows: Array<{ market: MarketId; symbol: string }> = []
  for (const [market, n] of Object.entries(w.watch) as Array<[MarketId, number]>) {
    for (let i = 0; i < n; i++) rows.push({ market, symbol: symOf(market, i) })
  }
  const prices = new Map<string, Ticker>()
  const series = new Map<string, { prevClose?: number }>()
  const quote = await quotePass(rows, prices)
  const fired = (await Promise.all(rows.map(row => prevCloseFallback(row, prices, series)))).reduce((a, b) => a + b, 0)
  return { tickers: quote.chunks, fallback: fired, rows: rows.length }
}

/** 负对照：不分块把整市场 40 行塞进一次 /tickers，桥必须 400（证明「0 个 400」有意义）。 */
async function unchunkedNegativeControl(w: Workload): Promise<{ symbols: number; status: number | null }> {
  resetMeters()
  installTransport(w)
  const symbols = Array.from({ length: w.watch.cn }, (_, i) => symOf('cn', i))
  try {
    await fetchTickers('cn', symbols)
  } catch { /* 400 经 getJson 转成 rejection */ }
  const hit = http.find(call => call.path === '/dshtrading/api/tickers')
  return { symbols: symbols.length, status: hit?.status ?? null }
}

/** 快讯面板：FlashPanel.tsx:50-71。 */
async function flashPanel(): Promise<Report> {
  resetMeters()
  const page = await fetchFlash({ limit: 30, hot: ['沸', '爆'] })
  const items = page?.items ?? []
  work.items = items.length
  return report('FlashPanel 快讯', 'SessionRail 闪电按钮 → flashOpen', 1, items.length, 0,
    ['子组件 NewsFeedPane 挂载 0 取数（纯展示，NewsFeedPane.tsx:89-96 只挂 1 个 60s 定时器）'])
}

/** 宏观面板：MacroPanel.tsx:94-107。 */
async function macroPanel(): Promise<Report> {
  resetMeters()
  const [calendar, rates] = await Promise.all([fetchMacroCalendar(400), fetchMacroRates()])
  // MacroPanel.tsx:109-114 地区过滤 + 排序（纯派生）
  const g3 = ['美国', '日本', '中国']
  const calRows = [...(calendar ?? []).filter(e => g3.includes(e.region))].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
  const rateRows = (rates ?? []).filter(r => g3.includes(r.region))
  work.items = (calendar ?? []).length + (rates ?? []).length
  return report('MacroPanel 宏观/利率', 'SessionRail 地球按钮 → macroOpen', 1, calRows.length + rateRows.length, 0,
    ['载荷 ' + String((calendar ?? []).length) + ' 日历条 + ' + String((rates ?? []).length) + ' 利率条',
      '地区过滤后 ' + String(calRows.length) + ' + ' + String(rateRows.length) + ' 条上屏（MacroPanel.tsx:109-114）'])
}

/** 预测市场面板：PolymarketPanel.tsx:109-147。 */
async function polymarketPanel(): Promise<Report> {
  resetMeters()
  const [prediction, calendar] = await Promise.all([fetchPredictionFomc(), fetchMacroCalendar(400)])
  let buckets = 0
  if (prediction.status === 'ok') {
    // :123-134 meetingViewOf x 会议数；采样只记 visibleMeetingsOf 的档位
    for (const meeting of prediction.meetings) buckets += meetingViewOf(meeting).buckets.length
    for (const meeting of visibleMeetingsOf(prediction.meetings)) buckets += meetingViewOf(meeting).buckets.length
  }
  const events = calendar === null ? [] : inflationEventsOf(calendar)
  work.items = buckets + events.length
  const shown = prediction.status === 'ok'
    ? prediction.meetings.filter(m => !m.closed).slice(0, VISIBLE_MEETINGS).length
    : 0
  return report('PolymarketPanel 预测市场', 'SessionRail 预测按钮 → predictionOpen', 1, shown + events.length, 0,
    ['会议视图构建 ' + String(buckets) + ' 次档位映射；VISIBLE_MEETINGS=' + String(VISIBLE_MEETINGS),
      '事件对照 ' + String(events.length) + ' 条（inflationEventsOf，prediction-view.ts；桩载荷标题不含通胀关键词 → 0，真实条数未测）'])
}

/** 定时任务面板：ScheduledTasksPanel.tsx:76-84。 */
async function scheduledTasksPanel(): Promise<Report> {
  resetMeters()
  const [snapshot, meta] = await Promise.all([fetchTasksSnapshot(), fetchTasksMeta()])
  const tasks = [...(snapshot.tasks ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  work.items = tasks.length + (meta.agentPresets?.length ?? 0) + (meta.workspaces?.length ?? 0)
  return report('ScheduledTasksPanel 定时任务', 'SessionRail 时钟按钮 → tasksOpen', 1, tasks.length, 0,
    ['2 次并行取数；SSE tasks 信号 + 15s 兜底轮询（:78-79）'])
}

/** 订单簿竖栏：自身 0 取数，成本记在宿主 QuoteStage.tsx:494-507。 */
async function orderbookPane(): Promise<Report> {
  resetMeters()
  const [book, trades] = await Promise.all([fetchOrderbook('us', 'US000'), fetchRecentTrades('us', 'US000', 50)])
  const asks = (book?.asks ?? []).slice(0, 10)
  const bids = (book?.bids ?? []).slice(0, 10)
  const tradeRows = (trades ?? []).slice().reverse().slice(0, 50)
  work.items = asks.length + bids.length + tradeRows.length
  return report('OrderbookPane 订单簿', 'QuoteStage 右侧竖栏展开（宿主轮询 QuoteStage.tsx:' + String(ORDERBOOK_POLL_LINE) + ' 起）', 1,
    asks.length + bids.length + tradeRows.length, 0,
    ['面板自身 0 取数（OrderbookPane.tsx:11「纯展示组件，轮询在 QuoteStage」）',
      '宿主 ORDERBOOK_POLL_MS 节拍内 2 次请求；派生 10 买 + 10 卖 + 50 笔（:55-58）'])
}

/** 新闻流：自身 0 取数，成本记在宿主 QuoteStage.tsx:661-674。 */
async function newsFeedPane(): Promise<Report> {
  resetMeters()
  const result = await fetchNews('us', 'US000', 50)
  const items = result?.items ?? []
  // NewsFeedPane.tsx:98-104 过滤 + :127-142 逐条 map
  const filtered = items.filter(it => !it.source.includes('exchange'))
  work.items = items.length
  return report('NewsFeedPane 新闻流', 'QuoteStage news/announcements 页签（宿主轮询 QuoteStage.tsx:' + String(NEWS_POLL_LINE) + ' 起）', 1,
    filtered.length, 0,
    ['面板自身 0 取数；只有 1 个 60s 相对时间定时器（NewsFeedPane.tsx:93-96）'])
}

/** 委托面板：OrderPanel.tsx:145-149 只有一个建议价回填 effect。 */
async function orderPanel(): Promise<Report> {
  resetMeters()
  // 挂载即执行的派生：resolveAssetUnit（:142）与 estimatedAmount（:156-162），纯计算
  return report('OrderPanel 委托面板', 'QuoteStage 右侧快速下单区展开', 0, 0, 0,
    ['挂载 0 次取数、0 个 store 订阅（OrderPanel.tsx:120-162）',
      '挂载即执行 1 次 resolveAssetUnit；提交才走 placeGuiOrder（:181）'])
}

/* ── 输出 ───────────────────────────────────────────────────── */

function printReportTable(title: string, reports: Report[]): void {
  const sorted = [...reports].sort((a, b) => b.http - a.http || b.items - a.items)
  console.log('\n' + title)
  console.log('| 面板 | 请求次数 | 结构波数 | store 读 | store 通知 | Intl 调用 | bar 数 | 处理条目 | 上屏行 |')
  console.log('|---|---|---|---|---|---|---|---|---|')
  for (const r of sorted) {
    console.log('| ' + r.panel + ' | ' + String(r.http) + ' | ' + String(r.waves) + ' | ' + String(r.storeReads)
      + ' | ' + String(r.storeNotifies) + ' | ' + String(r.intl) + ' | ' + String(r.bars) + ' | '
      + String(r.items) + ' | ' + String(r.rows) + ' |')
  }
}

function printNotes(reports: Report[]): void {
  console.log('\n### 逐面板证据')
  for (const r of reports) {
    console.log('\n**' + r.panel + '**  进入：' + r.entry)
    console.log('  端点明细：' + r.endpoints.map(([path, n]) => path.replace('/dshtrading/api', '') + ' x' + String(n)).join(' , '))
    for (const note of r.notes) console.log('  - ' + note)
  }
}

/* ── §0 转写守卫（三个转写点从源码现读；漂移即红）─────────────── */

function driftGuards(): void {
  section('§0 转写守卫：三个转写点从源码现读（生产代码一改，这里就红）')
  check(TICKERS_CHUNK === MAX_SYMBOLS,
    'TICKERS_CHUNK=' + String(TICKERS_CHUNK) + '（holdings-store.ts）镜像 bridge.ts 的 MAX_SYMBOLS=' + String(MAX_SYMBOLS)
    + '（左栏分块上限 = 桥的批量上限）')
  check(/from '\.\/holdings-store\.ts'/.test(linesOf(SRC.sidebar)[SIDEBAR_CHUNK_IMPORT_LINE - 1] ?? ''),
    'MarketSidebar.tsx:' + String(SIDEBAR_CHUNK_IMPORT_LINE) + ' 直接 import holdings-store 的 TICKERS_CHUNK（不是本地另立一份常量）')
  check(/for \(let offset = 0; offset < symbols\.length; offset \+= TICKERS_CHUNK\)/.test(linesOf(SRC.sidebar)[SIDEBAR_CHUNK_LOOP_LINE - 1] ?? '')
    && /symbols\.slice\(offset, offset \+ TICKERS_CHUNK\)/.test(linesOf(SRC.sidebar)[SIDEBAR_CHUNK_SLICE_LINE - 1] ?? ''),
    'MarketSidebar.tsx:' + String(SIDEBAR_CHUNK_LOOP_LINE) + '-' + String(SIDEBAR_CHUNK_SLICE_LINE)
    + ' 批量报价确实按 TICKERS_CHUNK 分块（本基准的 quotePass 与它同构，不是手写的「不分块」）')
  check(/await Promise\.all\(batches\.map\(/.test(linesOf(SRC.sidebar)[SIDEBAR_BATCH_LINE - 1] ?? ''),
    'MarketSidebar.tsx:' + String(SIDEBAR_BATCH_LINE) + ' 块之间并行发出（块级 try/catch 隔离失败）')
  check(/const ticker = prices\[key\]/.test(linesOf(SRC.sidebar)[PREVCLOSE_PRICES_LINE - 1] ?? '')
    && /ticker\.prevClose !== undefined/.test(linesOf(SRC.sidebar)[PREVCLOSE_TICKER_GATE_LINE - 1] ?? '')
    && /series\[key\]\?\.prevClose !== undefined/.test(linesOf(SRC.sidebar)[PREVCLOSE_SERIES_GATE_LINE - 1] ?? ''),
    'prevClose 兜底仍带 prices[key] 与 ticker.prevClose !== undefined 门控（MarketSidebar.tsx:'
    + String(PREVCLOSE_PRICES_LINE) + '/' + String(PREVCLOSE_TICKER_GATE_LINE) + '/' + String(PREVCLOSE_SERIES_GATE_LINE) + '）')
  check((linesOf(SRC.sidebar)[ROWKEY_LINE] ?? String()).includes('${market}:${symbol}'),
    'rowKey 口径 market:symbol（MarketSidebar.tsx:' + String(ROWKEY_LINE + 1) + '），本基准的 rowKey 与它同构')
  check(LIVE_EFFECT_DEPS_LINE > LIVE_EFFECT_CALL_LINE && M2M_EFFECT_DEPS_LINE > M2M_EFFECT_CALL_LINE
    && LIVE_EFFECT_DEPS_LINE < M2M_EFFECT_CALL_LINE,
    'refreshLiveTagged（HoldingsPanel.tsx:' + String(LIVE_EFFECT_CALL_LINE) + '，dep 恒空 → :' + String(LIVE_EFFECT_DEPS_LINE)
    + '）与 refreshM2mPrices（:' + String(M2M_EFFECT_CALL_LINE) + '，dep=[m2mTargetsKey] → :' + String(M2M_EFFECT_DEPS_LINE)
    + '）分处两条 effect')
  check(HOLDINGS_LIVE_CALLS === 2,
    'refreshLiveTagged 在 HoldingsPanel 里只有「effect 首跑 + setInterval 回调」两处调用（实测 ' + String(HOLDINGS_LIVE_CALLS) + ' 处）')
}

/* ── 生产调用点清单（定义行号从源码现读，漂移即红）─────────────── */

const at = (file: string, re: RegExp): string => file.slice(file.lastIndexOf('/') + 1) + ':' + String(lineOf(file, re))

const CALL_SITES: ReadonlyArray<readonly [string, string, string]> = [
  ['holdings-store.reloadHoldingsBook', at(SRC.holdingsStore, /export async function reloadHoldingsBook/),
    'HoldingsPanel.tsx 挂载 effect 首拉；SSE holdings 信号由 subscribeTradingEventsHoldings 触发'],
  ['holdings-store.refreshLiveTagged', at(SRC.holdingsStore, /export async function refreshLiveTagged/),
    'HoldingsPanel.tsx:' + String(LIVE_EFFECT_CALL_LINE) + ' 独立 effect（dep 恒空，30s 拍）'],
  ['holdings-store.refreshM2mPrices', at(SRC.holdingsStore, /export async function refreshM2mPrices/),
    'HoldingsPanel.tsx:' + String(M2M_EFFECT_CALL_LINE) + ' 盯市 effect（dep=[m2mTargetsKey]；每市场 ' + String(TICKERS_CHUNK) + ' 个/块）'],
  ['holdings-store.refreshFx', at(SRC.holdingsStore, /export async function refreshFx/),
    'HoldingsPanel.tsx 挂载 + baseCurrency 变化'],
  ['holdings-store.subscribeTradingEventsHoldings', at(SRC.holdingsStore, /export function subscribeTradingEventsHoldings/),
    'HoldingsPanel.tsx 挂载订阅（Node 侧无 window → 不建连）'],
  ['market-providers.ensureMarketProviders', at(SRC.marketProviders, /export async function ensureMarketProviders/),
    'holdings-store.ts refreshLiveTagged 内（模块级缓存，会话内只首次付 1 次 /markets）'],
  ['api.fetchMarkets', at(SRC.api, /export async function fetchMarkets/),
    'MarketSidebar.tsx reloadMarkets（挂载 + routing 信号）'],
  ['api.fetchSymbols', at(SRC.api, /export async function fetchSymbols/),
    'MarketSidebar.tsx 挂载/切页签；搜索输入防抖 200ms'],
  ['api.fetchKlines', at(SRC.api, /export async function fetchKlines/),
    'MarketSidebar.tsx 参考序列 / 降级日 K / prevClose 兜底（:' + String(PREVCLOSE_FETCH_LINE) + '）'],
  ['api.fetchTickers', at(SRC.api, /export async function fetchTickers/),
    'holdings-store.ts 盯市；MarketSidebar.tsx 批量报价（分块 :' + String(SIDEBAR_CHUNK_LOOP_LINE) + '）'],
  ['api.fetchFlash', at(SRC.api, /export async function fetchFlash/), 'FlashPanel.tsx 挂载 + 翻页'],
  ['api.fetchMacroCalendar', at(SRC.api, /export async function fetchMacroCalendar/), 'MacroPanel.tsx；PolymarketPanel.tsx'],
  ['api.fetchMacroRates', at(SRC.api, /export async function fetchMacroRates/), 'MacroPanel.tsx'],
  ['api.fetchPredictionFomc', at(SRC.api, /export async function fetchPredictionFomc/), 'PolymarketPanel.tsx'],
  ['tasks-api.fetchTasksSnapshot / fetchTasksMeta', at(SRC.tasksApi, /export async function fetchTasksSnapshot/) + ' / :' + String(lineOf(SRC.tasksApi, /export async function fetchTasksMeta/)),
    'ScheduledTasksPanel.tsx 挂载 + SSE 信号 + 15s 兜底轮询'],
  ['api.fetchOrderbook / fetchRecentTrades', at(SRC.api, /export async function fetchOrderbook/) + ' / :' + String(lineOf(SRC.api, /export async function fetchRecentTrades/)),
    'QuoteStage.tsx 竖栏展开且 chart 页签'],
  ['api.fetchNews', at(SRC.api, /export async function fetchNews/), 'QuoteStage.tsx news/announcements 页签或事件图钉'],
  ['holdings-aggregate.aggregateHoldings', at(SRC.aggregate, /export function aggregateHoldings/), 'HoldingsPanel.tsx 挂载 useMemo'],
  ['position-rounds.derivePositionRounds', at(SRC.positionRounds, /export function derivePositionRounds/), 'HoldingsPanel.tsx paper 成交 FIFO'],
]

function printCallSites(): void {
  console.log('\n### 生产调用点清单')
  console.log('| 被调函数 | 定义（源码现读） | 谁在什么时机调 |')
  console.log('|---|---|---|')
  for (const [name, at_, who] of CALL_SITES) console.log('| ' + name + ' | ' + at_ + ' | ' + who + ' |')
}

function printUnmeasured(): void {
  console.log('\n### 本轮记为「未测」（必须真浏览器）')
  for (const line of [
    'React 渲染次数、提交次数、重渲染放大（useSyncExternalStore 的快照比较只在浏览器里发生）',
    'DOM 节点数、行高/虚拟化、布局与绘制（18 行 vs 84 行的真实差异）',
    '首帧时间、TTI、输入延迟（点击 → 视觉反馈）',
    'Intl 格式化在浏览器里的真实开销（本表只数调用次数，不主张耗时）',
    'CSS module 加载、字体、图表画布（QtChart/TvChart）初始化',
    'SSE 首连握手与重连（每会话 1 条共享连接，Node 侧不建连）',
    '两次 usePoll 在真实浏览器里的发射顺序（本转写按源码顺序串行，故 prevClose 兜底的首拍门控是「prices 还没到」这一侧）',
  ]) console.log('- ' + line)
}

/** 串行波结构：总深度 = 串行往返波数，是唯一与机器负载无关的「等待」量。 */
function printWaveStructure(reports: Report[]): void {
  console.log('\n### 串行波结构（深度 = 用户等到可用内容前的最少 RTT 次数；计数确定，RTT 未测）')
  // 每行 = 一次用户点击；「再开」变体不计入合计（同一面板的第二次打开）。
  const waves: ReadonlyArray<readonly [string, string, readonly string[], number]> = [
    ['MarketSidebar 左栏自选', 'W1 markets(1)+symbols(6) → W2 日内 klines（每行 1 次；cn 的 1m 先 400 再 5m）→ W3 报价分块（Σ ceil(n_m/'
      + String(TICKERS_CHUNK) + ')）；prevClose 兜底首拍被 prices 门控挡下 → 不占波。报价拍与序列拍并行（本转写顺序执行，故并发峰值是真实值的下界）',
      ['MarketSidebar 左栏自选'], 3],
    ['HoldingsPanel（一次点击）', 'W1 holdings(1)+fx(1)+markets(1) → W2 trade/positions(' + String(HOLDINGS_MARKETS.length)
      + ' 个市场) → W3 盯市 tickers：dep=[m2mTargetsKey] 让盯市 effect 重跑，但 live 刷新在另一条 effect 里不再重打',
      ['HoldingsPanel 首开（providers 冷缓存）'], 3],
    ['MacroPanel', '两次取数同波并行 → 1 波', ['MacroPanel 宏观/利率'], 1],
    ['PolymarketPanel', '两次取数同波并行 → 1 波', ['PolymarketPanel 预测市场'], 1],
    ['ScheduledTasksPanel', '两次取数同波并行 → 1 波', ['ScheduledTasksPanel 定时任务'], 1],
    ['OrderbookPane（宿主轮询）', 'orderbook 与 trades 同波并行 → 1 波', ['OrderbookPane 订单簿'], 1],
    ['NewsFeedPane（宿主轮询）', '单请求 → 1 波', ['NewsFeedPane 新闻流'], 1],
    ['FlashPanel', '单请求 → 1 波', ['FlashPanel 快讯'], 1],
    ['OrderPanel', '无请求 → 0 波（提交时才出网）', ['OrderPanel 委托面板'], 0],
  ]
  let total = 0
  let peak = 0
  for (const [label, shape, names, depth] of waves) {
    const hits = reports.filter(r => names.includes(r.panel))
    const n = hits.reduce((sum, r) => sum + r.http, 0)
    const p = hits.reduce((max, r) => Math.max(max, r.peak), 0)
    total += n
    peak = Math.max(peak, p)
    console.log('- ' + label + '：深度 ' + String(depth) + ' 波 / ' + String(n) + ' 次请求 / 单波并发峰值 '
      + String(p) + ' —— ' + shape)
  }
  console.log('  一次完整巡览（每个面板各点一次）合计 ' + String(total) + ' 次请求，不含 SSE；'
    + '全套里单波并发峰值 ' + String(peak) + '（浏览器同源连接上限通常 6，多出的部分在浏览器内再串行化 —— 本轮未测）')
}

/** 最重面板判定：请求数优先，其次派生条目 / Intl。 */
function printHeaviest(reports: Report[]): void {
  const sorted = [...reports].sort((a, b) => b.http - a.http || b.intl - a.intl || b.items - a.items)
  const top = sorted[0] as Report
  const second = sorted[1] as Report
  console.log('\n### 最重面板判定')
  console.log('- 最重 = ' + top.panel + '：' + String(top.http) + ' 次请求 / ' + String(top.intl)
    + ' 次 Intl / ' + String(top.bars) + ' 根 bar / 深度 ' + String(top.waves) + ' 波')
  console.log('- 它同时重在**工作量**（' + String(top.intl) + ' 次 Intl 格式化，逐 bar；' + String(top.bars) + ' 根 bar 逐根过时区换算）与**等待往返**（'
    + String(top.waves) + ' 波串行；单波并发峰值 ' + String(top.peak)
    + ' 个请求，超出浏览器同源连接上限后还要再串行化，该串行化本轮未测）')
  console.log('  判定：重在工作量 —— 请求数 ' + String(top.http) + ' 只是手段，' + String(top.intl)
    + ' 次 Intl 与 ' + String(top.bars) + ' 根 bar 的逐根处理是不可并发的纯本地量；'
    + '往返部分靠并发已压到 ' + String(top.waves) + ' 波')
  console.log('- 次重 = ' + second.panel + '：' + String(second.http) + ' 次请求 / 深度 ' + String(second.waves)
    + ' 波 / ' + String(second.intl) + ' 次 Intl；分项 = /trade/positions ' + String(second.detail.positions ?? 0)
    + ' 次（每个持仓市场一次，无重复拍）+ 盯市 /tickers ' + String(second.detail.m2mTickers ?? 0) + ' 次（按市场分块）')
  console.log('- 其余面板全部 ≤2 次请求、1 波，不是这条路径的成本来源；OrderPanel 为 0')
}

/** 本轮已落地的三处修复：数值全部取自本次运行的 Report（不是预期值）。 */
function printImplemented(reports: Report[]): void {
  console.log('\n### 本轮已落地的修复（实测，不是预期）')
  const sidebars = reports.filter(r => r.panel === 'MarketSidebar 左栏自选').sort((a, b) => a.rows - b.rows)
  const sidebarReal = sidebars[0] as Report
  const sidebarTail = sidebars[sidebars.length - 1] as Report
  const holding = reports.find(r => r.panel.startsWith('HoldingsPanel 首开')) as Report
  console.log('- H1 prevClose 兜底门控（MarketSidebar.tsx:' + String(PREVCLOSE_TICKER_GATE_LINE) + '）：真实规模兜底 '
    + String(sidebarReal.detail.prevClose) + ' 次、尾部 ' + String(sidebarTail.detail.prevClose) + ' 次'
    + '（旧行为 = 每行 1 次 → ' + String(sidebarReal.rows) + ' / ' + String(sidebarTail.rows) + ' 次）')
  console.log('- H2 批量报价分块（MarketSidebar.tsx:' + String(SIDEBAR_CHUNK_LOOP_LINE) + '）：真实 '
    + String(sidebarReal.detail.chunks) + ' 次、尾部 ' + String(sidebarTail.detail.chunks) + ' 次块；'
    + '400 次数 真实 ' + String(sidebarReal.detail.rejected) + ' / 尾部 ' + String(sidebarTail.detail.rejected))
  console.log('- H3 资产面板两条 effect（HoldingsPanel.tsx:' + String(LIVE_EFFECT_DEPS_LINE) + ' / :' + String(M2M_EFFECT_DEPS_LINE)
    + '）：首开 ' + String(holding.http) + ' 次请求，其中 /trade/positions ' + String(holding.detail.positions)
    + ' 次（旧行为 2 拍 → ' + String(holding.detail.positions * 2) + ' 次）')
}

/** 仍未做的假设（H4-H6；只给假设，本轮不实现）。 */
function printOpenHypotheses(reports: Report[]): void {
  console.log('\n### 仍未做的假设（H4-H6，本轮不实现）')
  const sidebars = reports.filter(r => r.panel === 'MarketSidebar 左栏自选').sort((a, b) => a.rows - b.rows)
  const sidebarReal = sidebars[0] as Report
  const items: ReadonlyArray<readonly [string, string, string, string]> = [
    ['H4 左栏参考序列改批量', 'MarketSidebar.tsx:263-332 —— 桥侧加 klines 批量端点，或只在选中标的拉序列',
      '当前真实规模 klines 请求 ' + String(sidebarReal.detail.klines) + ' 次（每行 1 次 + cn 的 1m 400 重试）；'
        + '改成桥侧批量端点可降到每市场 1 次，Intl 不变——真正的杠杆是「不逐行拉序列」而不是「合并请求」',
      '若迷你走势是自选行的核心信息且上游无批量端点（需连接器能力证据），只能靠并发掩盖'],
    ['H5 宏观日历双面板共享缓存', 'MacroPanel.tsx 与 PolymarketPanel.tsx 共拉 /macro/calendar?limit=400 —— 抽出 ensureMarketProviders 同款模块级缓存',
      '单次点击 0 收益（五面板互斥挂载，见 SessionRail.tsx）；只在来回切换时省 1 次 254 条响应与 2 次过滤',
      '若两处 limit/字段需求分叉，或面板从互斥改为同屏，本项才有收益'],
    ['H6 定时任务双请求合并', 'ScheduledTasksPanel.tsx —— /tasks 与 /tasks/meta 合并为一个信封',
      '请求数 2 → 1，但两请求同波并行，**首屏深度不变**，用户不可感',
      '若 meta 与 snapshot 分属不同服务端子系统，合并会放大 snapshot 体积 —— 本项预期收益接近 0，不建议做'],
  ]
  for (const [name, change, gain, refute] of items) {
    console.log('- ' + name)
    console.log('  改动点：' + change)
    console.log('  当前 / 预期：' + gain)
    console.log('  推翻条件：' + refute)
  }
}

async function main(): Promise<void> {
  const intlOk = instrumentIntl()
  console.log('# 面板挂载确定性工作量普查')
  console.log('')
  console.log('工作负载（owner 授权聚合特征）：自选 ' + String(watchRows(REAL)) + ' 行 / 持仓 '
    + String(positionRows(REAL)) + ' 条 / 分组 ' + String(REAL.groups) + ' / 知识卡 '
    + String(REAL.knowledgeCards) + ' / storage ' + String(REAL.storageFiles) + ' 文件')
  console.log('Intl 计数仪表：' + (intlOk ? '已装（Intl.DateTimeFormat.prototype.format/formatToParts）' : '未装（仅 bar 数）'))
  console.log('HOLDINGS_MARKETS = ' + HOLDINGS_MARKETS.join(',') + '；TICKERS_CHUNK = ' + String(TICKERS_CHUNK)
    + '；MAX_SYMBOLS = ' + String(MAX_SYMBOLS))

  driftGuards()

  installTransport(REAL)

  // 顺序有意：先冷 providers 打开资产面板，再测左栏，最后测热缓存。
  const realHoldingCold = await holdingsPanel(REAL, true)
  const realSidebar = await marketSidebar(REAL)
  const realHoldingWarm = await holdingsPanel(REAL, false)
  const realFlash = await flashPanel()
  const realMacro = await macroPanel()
  const realPrediction = await polymarketPanel()
  const realTasks = await scheduledTasksPanel()
  const realOrderbook = await orderbookPane()
  const realNews = await newsFeedPane()
  const realOrder = await orderPanel()

  const realReports = [realHoldingCold, realHoldingWarm, realSidebar, realFlash, realMacro,
    realPrediction, realTasks, realOrderbook, realNews, realOrder]
  printReportTable('## 真实规模（自选 ' + String(watchRows(REAL)) + ' / 持仓 ' + String(positionRows(REAL)) + ' / storage ' + String(REAL.storageFiles) + '）', realReports)

  installTransport(TAIL)
  const tailHolding = await holdingsPanel(TAIL, false)
  const tailSidebar = await marketSidebar(TAIL)
  const tailFlash = await flashPanel()
  const tailMacro = await macroPanel()
  const tailPrediction = await polymarketPanel()
  const tailTasks = await scheduledTasksPanel()
  const tailAll = [tailHolding, tailSidebar, tailFlash, tailMacro, tailPrediction, tailTasks]
  printReportTable('## 尾部规模（自选 ' + String(watchRows(TAIL)) + ' / 持仓 ' + String(positionRows(TAIL)) + '，cn 越过桥 ' + String(MAX_SYMBOLS) + ' 上限）', tailAll)

  /* ── 正反两路对照（证明「0 个 400 / 0 次兜底」是守卫生效，不是死分支）── */

  section('正反两路对照')

  const negative = await unchunkedNegativeControl(TAIL)
  check(negative.symbols > MAX_SYMBOLS && negative.status === 400,
    '负对照：不分块把尾部的 ' + String(negative.symbols) + ' 行 cn 塞进一次 /tickers → 桥 ' + String(negative.status)
    + '（分块后的「0 个 400」因此有意义）')

  const positive = await prevClosePositiveControl(REAL)
  check(positive.fallback === positive.rows && positive.tickers > 0,
    '正对照：ticker 不带 prevClose 时兜底按行补拉 ' + String(positive.fallback) + '/' + String(positive.rows)
    + ' 次（行情拍 ' + String(positive.tickers) + ' 块）→ 守卫是门控，不是死分支')

  const tailRejected = tailSidebar.detail.rejected ?? 0
  const realRejected = realSidebar.detail.rejected ?? 0
  check(realRejected === 0 && tailRejected === 0,
    '分块后真实/尾部两档的 /tickers 400 均为 0（' + String(realRejected) + ' / ' + String(tailRejected) + '）')
  check((tailSidebar.detail.chunks ?? 0) === Math.ceil(TAIL.watch.cn / TICKERS_CHUNK) + 1 + 1 + 1 + 1,
    '尾部左栏报价块数 = Σ ceil(n_m/' + String(TICKERS_CHUNK) + ') = ' + String(tailSidebar.detail.chunks)
    + '（含 cn ' + String(TAIL.watch.cn) + ' 行 → ' + String(Math.ceil(TAIL.watch.cn / TICKERS_CHUNK)) + ' 块）')
  check(realHoldingCold.detail.positions === HOLDINGS_MARKETS.length,
    'HoldingsPanel 首开 /trade/positions = ' + String(realHoldingCold.detail.positions)
    + ' 次 = HOLDINGS_MARKETS 的市场数（旧行为 2 拍 = ' + String(HOLDINGS_MARKETS.length * 2) + '）')

  // 确定性自检：同一场景在同一输入下两次运行的计数必须逐项相等（否则「确定性工作量」不成立）。
  installTransport(REAL)
  const again = await marketSidebar(REAL)
  const fingerprint = (x: Report): string => [x.http, x.intl, x.bars, x.items, x.rows, x.storeNotifies].join('/')
  const stable = fingerprint(again) === fingerprint(realSidebar)
  console.log('\n### 确定性自检（真实规模左栏，跑两遍逐项比对）')
  console.log('  第一遍 = ' + fingerprint(realSidebar) + '（请求/Intl/bar/条目/上屏行/store 通知）')
  console.log('  第二遍 = ' + fingerprint(again))
  console.log('  判定 = ' + (stable ? 'PASS 两项完全相等' : 'FAIL 计数漂移，本表不可用'))
  if (!stable) throw new Error('nondeterministic counters: ' + fingerprint(realSidebar) + ' vs ' + fingerprint(again))

  printNotes([...realReports, ...tailAll])

  console.log('\n### 规模阈值（与机器负载无关的结构事实）')
  console.log('- 持仓盯市分块：每市场 ceil(n/' + String(TICKERS_CHUNK) + ') 块、每波 4 块并行（holdings-store.ts 的 TICKERS_CHUNK / TICKERS_MARKET_CONCURRENCY）'
    + ' → 真实 cn 6 条/1 块；尾部 cn 40 条/2 块。请求数 = Σ ceil(n_m/' + String(TICKERS_CHUNK) + ')')
  console.log('- 左栏批量报价同样按 TICKERS_CHUNK=' + String(TICKERS_CHUNK) + ' 分块（MarketSidebar.tsx:'
    + String(SIDEBAR_CHUNK_LOOP_LINE) + '-' + String(SIDEBAR_CHUNK_SLICE_LINE) + '）→ 单市场 >' + String(MAX_SYMBOLS)
    + ' 行拆成 ceil(n/' + String(TICKERS_CHUNK) + ') 块各自成功；尾部 cn ' + String(TAIL.watch.cn) + ' 行 = '
    + String(Math.ceil(TAIL.watch.cn / TICKERS_CHUNK)) + ' 块，0 个 400')
  console.log('- 左栏参考序列：每行 1 次 klines（cn 先 1m 400 再 5m）；prevClose 兜底只在 ticker 已落地且缺省时补'
    + '（MarketSidebar.tsx:' + String(PREVCLOSE_TICKER_GATE_LINE) + '）→ 首拍 prices 必空，实测 0 次')
  console.log('- 资产面板：live 刷新与批量盯市分处两条 effect（HoldingsPanel.tsx:' + String(LIVE_EFFECT_DEPS_LINE)
    + ' / :' + String(M2M_EFFECT_DEPS_LINE) + '）→ 首开 /trade/positions 只 ' + String(HOLDINGS_MARKETS.length) + ' 次')

  printWaveStructure(realReports)
  printHeaviest(realReports)
  printImplemented([...realReports, ...tailAll])
  printOpenHypotheses([...realReports, ...tailAll])
  printCallSites()
  printUnmeasured()

  console.log('\n### 非权威：脚本墙钟（**待安静窗口复测**，不得作为结论）')
  const t0 = performance.now()
  installTransport(REAL)
  await marketSidebar(REAL)
  console.log('marketSidebar(real) elapsed = ' + (performance.now() - t0).toFixed(1) + ' ms —— 非权威、待安静窗口复测')

  if (failures > 0) {
    console.log('\n  有 ' + String(failures) + ' 条判据未通过（见上方 [FAIL]）。')
    process.exitCode = 1
  } else {
    console.log('\n  全部判据通过。')
  }
}

await main()
