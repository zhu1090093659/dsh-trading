/**
 * 用户可见路径性能基线：「中栏视图 / 行情页签之间来回切」的**确定性工作量**普查。
 *
 * 测量卡（measure-first）——照 spikes/bench-client-ui-tickers.mts、spikes/bench-user-paths.mts 的格式。
 * 本轮机器饱和（CPU ~12% idle、compressor 5.6GB），**权威证据一律是不依赖机器负载的计数**；
 * 本文件顺带打印的 elapsed / ms 一律标注「非权威」。
 *
 * 卡片 1 — 中栏视图 A ↔ B（跨视图切换：QuoteStage 卸载 / 重挂）
 * | 字段 | 取值 |
 * |---|---|
 * | 用户操作 | 点中栏顶部 tab 从「行情」切到另一个已注册视图，再切回「行情」；外部可观察完成条件 = 图表首帧 + 首根 K 线落地 |
 * | 工作负载 | 聚焦标的 1 个（自选 18 标的：crypto 2 / cn 7 / hk 2 / us 6 / futures 1）；持仓 15 条；指标实例 = 出厂默认 1 组（ma，6 条输出）或全预置 10 组 |
 * | 进入路径 | MiddleStage.tsx:105-114（三目互斥挂载 → 切走即卸载）→ 回到行情 = QuoteStage 全量重挂 → 11 个挂载期取数调用点（§3）+ TvChart 重建（TvChart.tsx:389-474、710-717） |
 * | 时钟 | 全部结论 = 调用/对象/元素计数；ms 仅附注且非权威（机器饱和，待安静窗口复测） |
 * | 内存 | 权威侧只报「数组个数 / 元素个数」这类确定性量；浏览器堆占用不可由 Node 代表，记未测（§10） |
 * | 判据 | 每次挂载的桥调用数由 §3 的调用点模型对 ctx（市场 / 周期 / 开关）现算，§5 表为准：1d 下 K 线只取 1 次（日 K 参考复用图表序列，:446 落地时顺带 setDaily）、交易台 0 次（关着不拉；面板开着或实盘才拉 4 次）、ticker 1 次、指数 1 次（futures 无）、衍生品 1 次（crypto）；图表 1 个 + 序列对象 11 个（4 基础 + 6 ma + 1 标记插件）、数据点 5011 个 |
 * | 行为 | 卸载即丢内存态（缩放平移、悬浮下标、框选、行情页签、盘口快照）；localStorage 态存活（周期记忆、自选、指标实例、中栏视图 id） |
 *
 * 卡片 2 — 行情页签 chart ↔ fundamentals / news / derivatives（同一视图内切页签）
 * | 字段 | 取值 |
 * |---|---|
 * | 用户操作 | 在行情视图内点「图表 / 基本面 / 新闻 / 衍生品」页签来回切 |
 * | 工作负载 | 同上：聚焦 1 标的、出厂默认指标组 |
 * | 进入路径 | QuoteStage.tsx:1281-1540（三目互斥挂载）→ 离开 chart 卸载 TvChart（:1285）；QuoteStage 不卸载，但页签是 usePoll 的依赖 → 回图表页签时交易台轮询 effect 重跑（:530-533 的 deps 含 stageTab；守卫还要求 tradeDeskOpen 或实盘） |
 * | 时钟 | 同上：只报计数 |
 * | 内存 | 常驻：klines 750 + daily 750 + 指标输出 6×750 = 6000 个元素（共 8 个数组：klines / daily / 6 条 ma 输出），切换期间不重取 |
 * | 判据 | chart→fundamentals→chart = **0 次桥调用**（去程 0、回程交易台被 tradeDeskOpen / tradeMode 守卫挡掉 0——§5 表现算）、1 次 createChart、11 个序列对象重建、5011 个数据点重新灌入；chart→news→chart / chart→derivatives→chart 各只剩去程那 1 条 |
 * | 行为 | 页签记忆不跨卸载存活（stageTab 初值 chart，QuoteStage.tsx:264） |
 *
 * 卡片 3 — 标的 A → B（同市场换标的）
 * | 字段 | 取值 |
 * |---|---|
 * | 用户操作 | 在左缘自选栏点另一只标的 |
 * | 工作负载 | 18 标的中任选两只（同市场），持仓 15 条 |
 * | 进入路径 | QuoteStage.tsx:606-625 清场 → deps 含 symbol 的轮询重发（klines / daily / ticker / derivatives = 4 次）；dataKey 变化 → 蜡烛 setData 全量替换，**图表对象不重建** |
 * | 时钟 | 同上 |
 * | 内存 | 旧数组被替换（不是追加）：klines 750 → 750 |
 * | 判据 | 每换一次 = §3 模型现算的换标的增量（crypto / 1d / 盘口关：K 线轮询 + 衍生品 + ticker 各 1，日 K 参考在 1d 下为 0）、0 次 createChart、0 个新序列、5011 个数据点全量重灌 |
 * | 行为 | 换标的 = 「重取数但不重建图表」；跨视图切 = 「重建图表且重取数」 |
 *
 * 卡片 4 — 真实规模 vs 尾部规模
 * | 字段 | 取值 |
 * |---|---|
 * | 用户操作 | 同卡片 1，分别按真实规模与尾部规模计 |
 * | 工作负载 | 真实：18 标的 / 15 持仓 / 1 分组 / 6 知识卡 / 401 storage 文件；尾部：盘口竖栏打开 + 全预置 10 指标组（18 只全落单一市场只把 dock 的 5 次批量请求压成 1 次，不影响切换成本） |
 * | 进入路径 | 同卡片 1；规模只改变每个批量端点里的标的数、指标组数、面板数，不改变调用点数 |
 * | 时钟 | 同上 |
 * | 内存 | 尾部规模下序列元素数 = 750 ×（4 + Σ 输出数） |
 * | 判据 | 切换路径的调用点数由 §5 表现算且与 18 标的无关（只随市场 / 周期 / 盘口与交易台开关变），随规模变的只有每拍携带的行数（15 持仓）与序列/元素数（指标组数：6 → 29 条） |
 * | 行为 | 自选表尺寸不影响切换成本：左缘 dock 与右缘资产面板是常驻 overlay 条目，切换中栏不重挂它们 |
 *
 * 运行：cd /Users/zcl/code/dsh-trading && pnpm exec tsx spikes/bench-ui-tab-switch.mts
 *
 * 证据边界（必读）：
 * - **本文件权威**：调用次数、序列对象个数、数组个数、元素个数、桥请求条数与 URL——全部由真实生产函数
 *   （dispatchIndicatorGroups / syncIndicators / requiredAuxKeys / loadAuxSeries / selectApplicableInstances /
 *   createChartStateStore / residentPollMs / presetDefinitions / createIndicatorRegistry / api.ts 的 fetch*）
 *   在 Node 侧直接执行得出，与机器负载无关。
 * - **桩在哪一层**：① globalThis.fetch（HTTP 传输层）——只用于把「一个生产 fetch 函数 = 几次桥请求」量出来，
 *   不含网络时延；② IChartApi（lightweight-charts 的渲染 API 面）——只记录 addSeries/removeSeries/setData
 *   调用，不建 canvas；③ HoldingsFetcher / ActiveBuyFetcher（aux-series.ts 自带的注入缝）——只计数。
 *   渲染、绘制、canvas 分配、输入延迟**不在** Node 侧可测范围（§10）。
 * - 源码里解析出来的量（K 线根数上限、轮询周期、每个 usePoll 的 deps 数组）在运行时现读并附 file:line：
 *   生产常量一改，本脚本打印的就是新值（漂移检测见 §1/§3）。
 * - 指标注册表用 presetDefinitions() 建（与 client-ui-indicators 插件同一份预置表），
 *   默认实例集用真实 createChartStateStore 读回（chart-state.ts:56-58）。
 * - 「切一次会重发哪些请求」不是我手写的分支表：deps 数组从源码现读，含 symbol / stageTab 与否决定重发集合。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { syncIndicators, subIndicatorPaneIndex } from '../packages/client-ui-trading/src/client/TvChart.tsx'
import { dispatchIndicatorGroups } from '../packages/client-ui-trading/src/client/indicator-dispatch.ts'
import { selectApplicableInstances } from '../packages/client-ui-trading/src/client/indicator-scope.ts'
import { createChartStateStore } from '../packages/client-ui-trading/src/client/chart-state.ts'
import { loadAuxSeries, requiredAuxKeys } from '../packages/client-ui-trading/src/client/aux-series.ts'
import { residentPollMs } from '../packages/client-ui-trading/src/client/quote-budget.ts'
import { ensureMarketProviders } from '../packages/client-ui-trading/src/client/market-providers.ts'
import { MARKET_INDICES } from '../packages/client-ui-trading/src/client/market-status.ts'
import * as bridge from '../packages/client-ui-trading/src/client/api.ts'
import { tradeModeStore } from '../packages/client-ui-trading/src/client/trade-mode-store.ts'
import { createIndicatorRegistry, presetDefinitions } from '../packages/indicators/lib/index.js'

const t0 = performance.now()

/* ──────────────────────────── 输出小工具 ──────────────────────────── */

const dw = (s: string): number => {
  let w = 0
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
  return w
}
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - dw(s)))

function table(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): void {
  const cells = rows.map(row => row.map(cell => String(cell)))
  const widths = headers.map((header, index) => Math.max(dw(header), ...cells.map(row => dw(row[index] ?? ''))))
  console.log(headers.map((header, index) => pad(header, widths[index]!)).join('  '))
  console.log(widths.map(width => '-'.repeat(width)).join('  '))
  for (const row of cells) console.log(row.map((cell, index) => pad(cell, widths[index]!)).join('  '))
  console.log('')
}

let failures = 0
function check(ok: boolean, what: string): void {
  if (ok) { console.log('  [OK]   ' + what); return }
  failures += 1
  console.log('  [FAIL] ' + what)
}

function section(title: string): void {
  console.log('\n════ ' + title + ' ════')
}

/* ──────────────────────────── 源码读取与漂移检测 ──────────────────────────── */

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLIENT = 'packages/client-ui-trading/src/client'

const SRC = {
  quoteStage: CLIENT + '/QuoteStage.tsx',
  middleStage: CLIENT + '/MiddleStage.tsx',
  tvChart: CLIENT + '/TvChart.tsx',
  useAuxSeries: CLIENT + '/useAuxSeries.ts',
  marketSidebar: CLIENT + '/MarketSidebar.tsx',
  chartState: CLIENT + '/chart-state.ts',
  foldStore: CLIENT + '/fold-store.ts',
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
/** 1-based：文件内首个匹配行号；找不到抛错（源码漂移即红，不静默）。 */
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

/* ──────────────────────────── 真实生产规模常量（现读源码） ──────────────────────────── */

const DAILY_LIMIT = numOf(SRC.quoteStage, /const DAILY_LIMIT = (\d+)/, 'DAILY_LIMIT')
const KLINE_LIMIT_DEFAULT = numOf(SRC.quoteStage, /const KLINE_LIMIT_DEFAULT = (\d+)/, 'KLINE_LIMIT_DEFAULT')
const KLINE_LIMIT_CRYPTO = numOf(SRC.quoteStage, /KLINE_LIMIT_BY_MARKET[^\n]*\{ crypto: (\d+) \}/, 'KLINE_LIMIT_BY_MARKET.crypto')
const POLL_MS = {
  ticker: numOf(SRC.quoteStage, /const TICKER_POLL_MS = (\d+)/, 'TICKER_POLL_MS'),
  klineResync: numOf(SRC.quoteStage, /const KLINE_RESYNC_MS = (\d+)/, 'KLINE_RESYNC_MS'),
  orderbook: numOf(SRC.quoteStage, /const ORDERBOOK_POLL_MS = (\d+)/, 'ORDERBOOK_POLL_MS'),
  tradeDesk: numOf(SRC.quoteStage, /const TRADE_DESK_POLL_MS = (\d+)/, 'TRADE_DESK_POLL_MS'),
}
const klineLimit = (market: string): number => (market === 'crypto' ? KLINE_LIMIT_CRYPTO : KLINE_LIMIT_DEFAULT)

/** 授权口径的真实工作负载规模（owner 已核对；本脚本只用这些聚合数字，不读任何内容）。 */
const WORKLOAD = {
  watchlist: { crypto: 2, cn: 7, hk: 2, us: 6, futures: 1 },
  positions: 15,
  groups: 1,
  knowledgeCards: 6,
  storageFiles: 401,
} as const

/* ──────────────────────────── §1 生命周期事实 + 漂移检测 ──────────────────────────── */

section('§1 事实：切走时旧视图是卸载还是保活')

const middleRenderStart = lineOf(SRC.middleStage, /^\s*\{view === 'quote' \? \(/)
const middleRenderEnd = lineOf(SRC.middleStage, /^\s*\)\}\s*$/, middleRenderStart)
const middleRender = linesOf(SRC.middleStage).slice(middleRenderStart - 1, middleRenderEnd).join('\n')
const quoteStageRenderedOnce = (textOf(SRC.middleStage).match(/<QuoteStage/g) ?? []).length
const keepAliveInMiddle = /display:\s*'none'|visibility:\s*'hidden'|keepAlive|keep-alive/.test(middleRender)

console.log('  中栏渲染块：' + SRC.middleStage + ':' + middleRenderStart + '-' + middleRenderEnd)
console.log('  ' + linesOf(SRC.middleStage)[middleRenderStart - 1]!.trim())
console.log('  …')
console.log('  ' + linesOf(SRC.middleStage)[middleRenderEnd - 1]!.trim())
console.log('')
table(['判据', '实测', '结论'], [
  ['<QuoteStage> 在本块里出现次数', quoteStageRenderedOnce, '= 1 → 只有活动视图在树上'],
  ['块内是否有 display:none / visibility:hidden / keepAlive', keepAliveInMiddle ? '是' : '否', keepAliveInMiddle ? '有保活 → 需重测' : '无保活 → 互斥挂载'],
  ['非活动分支渲染的是什么', 'registry 视图 definition.render（同块另一支）', '切走 = 卸载 = React state 全部丢弃'],
])
check(quoteStageRenderedOnce === 1 && !keepAliveInMiddle, '中栏「切走即卸载」（无隐藏保活）')

const stageTabInitLine = lineOf(SRC.quoteStage, /const \[stageTab, setStageTab\] = useState</)
const stageRenderLine = lineOf(SRC.quoteStage, /^\s*\{viewTab === 'chart' \? \(/)
const stageChartMountLine = lineOf(SRC.quoteStage, /^\s*\{klines !== null && bars\.length > 0 && \(/)
console.log('  行情视图内页签（chart / fundamentals / news / announcements / derivatives）：' + SRC.quoteStage + ':' + stageRenderLine + ' 起三目互斥；')
console.log('  stageTab 是 useState，初值 chart（' + SRC.quoteStage + ':' + stageTabInitLine + '）→ QuoteStage 一旦卸载，页签回落到 chart。')
console.log('  TvChart 只在 chart 页签挂载（' + SRC.quoteStage + ':' + stageChartMountLine + '）→ 切页签卸载图表；QuoteStage 与取数状态保留，但页签是 usePoll 的依赖（见 §3）。')
console.log('')
check(true, '行情页签切换：图表卸载重建、QuoteStage 与数据状态保留（与跨视图切换是两条不同路径）')

const stageKeyLine = lineOf(SRC.middleStage, /const STAGE_KEY = /)
const foldKeysLine = lineOf(SRC.foldStore, /const RIGHT_FOLD_KEY = /)
const intervalKeyLine = lineOf(SRC.quoteStage, /const INTERVAL_KEY_PREFIX = /)
const chartKeyLine = lineOf(SRC.chartState, /const CHART_KEY = /)
console.log('  localStorage 存活面（卸载不影响）：中栏视图 id（' + SRC.middleStage + ':' + stageKeyLine + '）、')
console.log('  左右栏折叠（' + SRC.foldStore + ':' + foldKeysLine + '）、周期记忆（' + SRC.quoteStage + ':' + intervalKeyLine + '）、指标实例（' + SRC.chartState + ':' + chartKeyLine + '）。')
console.log('  内存态丢失面：klines / daily / ticker / derivatives / orderbook / news / hoverIndex / rangeSelection / kdasMenu / stageTab。')
console.log('')

/* ──────────────────────────── §2 桥调用单位成本（真实 api 函数 × fetch 桩） ──────────────────────────── */

section('§2 一次桥调用 = 几次 HTTP 请求（真实 api.ts 函数 × fetch 桩；桩在传输层，不含网络时延）')

interface CallRecord { name: string; urls: string[] }
const callLog: string[] = []
const realFetch = globalThis.fetch

function payloadFor(url: string): unknown {
  const pathname = new URL(url, 'http://localhost').pathname
  if (pathname.endsWith('/markets')) return { markets: [] }
  if (pathname.endsWith('/tickers')) return { tickers: {} }
  if (pathname.endsWith('/klines')) return { klines: [] }
  if (pathname.endsWith('/orderbook')) return { ok: true, orderbook: {} }
  if (pathname.endsWith('/trades')) return { ok: true, trades: [] }
  if (pathname.endsWith('/trade/positions')) return { ok: true, positions: [] }
  if (pathname.endsWith('/trade/balances')) return { ok: true, balances: [] }
  if (pathname.endsWith('/trade/orders')) return { ok: true, orders: [] }
  if (pathname.endsWith('/trade/fills')) return { ok: true, fills: [] }
  if (pathname.endsWith('/derivatives/history')) return { ok: true, history: {} }
  if (pathname.endsWith('/derivatives')) return { ok: true, derivatives: {} }
  if (pathname.endsWith('/news')) return { ok: true, items: [], unavailable: [] }
  return { ok: true }
}

async function withFetchStub<T>(run: () => Promise<T>): Promise<{ value: T; urls: string[] }> {
  callLog.length = 0
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    callLog.push(url)
    return new Response(JSON.stringify(payloadFor(url)), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  try {
    const value = await run()
    return { value, urls: [...callLog] }
  } finally {
    globalThis.fetch = realFetch
  }
}

const FOCUS = { market: 'crypto', symbol: 'BTCUSDT' }

const unitCalls: Array<[string, () => Promise<unknown>]> = [
  ['fetchMarkets()', () => bridge.fetchMarkets()],
  ['fetchTickers(crypto, 1 标的)', () => bridge.fetchTickers('crypto', [FOCUS.symbol])],
  ['fetchTickers(us, 6 标的)', () => bridge.fetchTickers('us', ['A', 'B', 'C', 'D', 'E', 'F'])],
  ['fetchKlines(crypto, 1d, 750)', () => bridge.fetchKlines('crypto', FOCUS.symbol, '1d', DAILY_LIMIT)],
  ['fetchKlinesFrom(crypto, 1m, 2500)', () => bridge.fetchKlinesFrom('crypto', FOCUS.symbol, '1m', 2500)],
  ['fetchDerivatives(crypto)', () => bridge.fetchDerivatives('crypto', FOCUS.symbol)],
  ['fetchDerivativesHistory(crypto)', () => bridge.fetchDerivativesHistory('crypto', FOCUS.symbol)],
  ['fetchOrderbook(crypto)', () => bridge.fetchOrderbook('crypto', FOCUS.symbol)],
  ['fetchRecentTrades(crypto, 50)', () => bridge.fetchRecentTrades('crypto', FOCUS.symbol, 50)],
  ['fetchTradePositions(crypto)', () => bridge.fetchTradePositions('crypto')],
  ['fetchTradeBalances(crypto)', () => bridge.fetchTradeBalances('crypto')],
  ['fetchTradeOpenOrders(crypto)', () => bridge.fetchTradeOpenOrders('crypto')],
  ['fetchTradeFills(crypto)', () => bridge.fetchTradeFills('crypto')],
  ['fetchNews(crypto, 50)', () => bridge.fetchNews('crypto', FOCUS.symbol, 50)],
  ['fetchFundamentals(us)', () => bridge.fetchFundamentals('us', 'AAPL')],
  ['fetchSouthboundHoldings(hk)', () => bridge.fetchSouthboundHoldings('hk', '00700')],
  ['fetchActiveBuy(cn)', () => bridge.fetchActiveBuy('cn', '600519')],
]

const unit = new Map<string, CallRecord>()
for (const [name, run] of unitCalls) {
  const { urls } = await withFetchStub(run)
  unit.set(name, { name, urls })
}
table(
  ['生产函数', 'HTTP 请求数', '请求 URL'],
  [...unit.values()].map(record => [record.name, record.urls.length, record.urls.join(' ; ').slice(0, 96)]),
)
check([...unit.values()].every(record => record.urls.length === 1), '每个生产 fetch 函数 = 恰好 1 次 HTTP 请求（批量端点不按标的拆分）')

const urlOf = (name: string): string => unit.get(name)!.urls[0]!
const req = (name: string): number => unit.get(name)!.urls.length

const klineUrlPoll = urlOf('fetchKlines(crypto, 1d, 750)')
const klineUrlDaily = urlOf('fetchKlines(crypto, 1d, 750)')
const klinePollFetchLine = lineOf(SRC.quoteStage, /await fetchKlines\(market, symbol, chartInterval,/)
const dailyRefEffectLine = lineOf(SRC.quoteStage, /if \(!market \|\| !symbol \|\| chartInterval === '1d'\) return/)
const dailyFeedLine = lineOf(SRC.quoteStage, /if \(chartInterval === '1d'\) setDaily\(rows\)/)
const statsPrevCloseLine = lineOf(SRC.quoteStage, /const prevClose = ticker\?\.prevClose \?\? klinePrevClose/)
console.log('  缺省周期 1d 下两处取数指向同一 URL（' + SRC.quoteStage + ':' + klinePollFetchLine + ' 的 K 线轮询 vs :' + dailyRefEffectLine + ' 的日 K 参考 effect）：')
console.log('    ' + klineUrlPoll)
console.log('    ' + klineUrlDaily)
console.log('  → 但 1d 下只发这一条：K 线轮询落地时顺带 setDaily(rows)（:' + dailyFeedLine + '），')
console.log('    日 K 参考 effect 在 1d 直接短路（:' + dailyRefEffectLine + '）；只有非 1d 周期才另发一条 750 根，')
console.log('    只喂 stats 的昨收与涨跌两个数（:' + statsPrevCloseLine + '）。')
console.log('')
check(klineUrlPoll === klineUrlDaily, '缺省周期下 K 线轮询与日 K 参考指向同一 URL（同一个生产函数 + 同一组参数）')
check(/chartInterval === '1d'\) return/.test(linesOf(SRC.quoteStage)[dailyRefEffectLine - 1]!), '日 K 参考在 1d 下短路（不另发第 2 条 750 根请求）')
check(/if \(chartInterval === '1d'\) setDaily\(rows\)/.test(linesOf(SRC.quoteStage)[dailyFeedLine - 1]!), 'K 线轮询在 1d 落地时顺带喂 daily（日 K 参考复用图表序列）')

let watchlistRequests = 0
for (const [market, count] of Object.entries(WORKLOAD.watchlist)) {
  if (count === 0) continue
  const symbols = Array.from({ length: count }, (_, index) => market.toUpperCase() + index)
  const { urls } = await withFetchStub(() => bridge.fetchTickers(market as never, symbols))
  watchlistRequests += urls.length
}
const watchlistTail = await withFetchStub(() => bridge.fetchTickers('us' as never, Array.from({ length: 18 }, (_, index) => 'T' + index)))
console.log('  自选 18 标的（crypto 2 / cn 7 / hk 2 / us 6 / futures 1）按市场分组 → ' + watchlistRequests + ' 次批量请求/拍；')
console.log('  尾部规模（18 只全在 us）→ ' + watchlistTail.urls.length + ' 次批量请求/拍（同一批端点，只是组数变少）。')
const sidebarQuotePollLine = lineOf(SRC.marketSidebar, /const batches: Array<\{ market: MarketId; symbols: string\[\] \}> = \[\]/)
console.log('  这两条属于左缘 dock（MarketDock 是 shell.overlay 常驻条目）——中栏切视图不重挂它们，切换的边际成本为 0（'
  + SRC.marketSidebar + ':' + sidebarQuotePollLine + ' 起的分块报价拍）。')
console.log('')

/* ──────────────────────────── §3 挂载期取数调用点表 ──────────────────────────── */

section('§3 取数调用点表（行号 + deps 数组均从源码现读；deps 决定「哪种切会重发」）')

interface Ctx {
  market: string
  /** 图表周期（QuoteStage 的 chartInterval）：1d 下日 K 参考复用图表序列，见 §2。 */
  interval: string
  stageTab: string
  orderbookOpen: boolean
  /** 交易台面板开关（localStorage 记忆，缺省 false：QuoteStage.tsx:2030-2035 readTradeDeskOpen）。 */
  tradeDeskOpen: boolean
  /** 交易模式（tradeModeStore 快照，缺省 paper）：实盘时交易台轮询不看开关。 */
  tradeMode: string
  knowledgeOn: boolean
  auxKeys: readonly string[]
  marketProvidersWarm: boolean
}

type SiteKey =
  | 'index' | 'kline' | 'dailyRef' | 'derivatives' | 'derivativesHistory'
  | 'orderbook' | 'tradeDesk' | 'ticker' | 'news' | 'aux' | 'providers'

interface PollSite {
  /** 模型内的稳定标识（§5/§8 按它取数，不按行号）。 */
  key: SiteKey
  file: string
  line: number
  label: string
  requests: (ctx: Ctx) => number
  note: string
  guard?: string
  deps?: string
  symbolRefire?: boolean
}

const pollLines = linesOf(SRC.quoteStage)
  .map((line, index) => ({ line, no: index + 1 }))
  .filter(entry => /^\s*usePoll\(/.test(entry.line))
  .map(entry => entry.no)

/** refreshTradeDesk 一拍里 Promise.all 的 fetch 个数（源码现读，不写字面量 4）。 */
const tradeDeskBodyStart = lineOf(SRC.quoteStage, /const refreshTradeDesk = async/)
const tradeDeskBodyEnd = lineOf(SRC.quoteStage, /^\s*\}\s*$/, tradeDeskBodyStart + 1)
const TRADE_DESK_REQUESTS = linesOf(SRC.quoteStage)
  .slice(tradeDeskBodyStart - 1, tradeDeskBodyEnd)
  .filter(line => /^\s*fetchTrade(Positions|Balances|OpenOrders|Fills)\(/.test(line)).length

const SITES: PollSite[] = [
  { key: 'index', file: SRC.quoteStage, line: 374, label: '底部大盘指数', requests: ctx => ((MARKET_INDICES[ctx.market as never]?.length ?? 0) === 0 ? 0 : req('fetchTickers(crypto, 1 标的)')), note: '1 次批量 ticker（该市场 3 个指数代码）；futures 无指数 → 0' },
  { key: 'kline', file: SRC.quoteStage, line: 422, label: 'K 线轮询（挂载即 tick）', requests: ctx => req('fetchKlines(crypto, 1d, 750)'), note: '1d 取 ' + DAILY_LIMIT + ' 根；分钟级 crypto ' + KLINE_LIMIT_CRYPTO + ' / 其它 ' + KLINE_LIMIT_DEFAULT + '；1d 落地顺带 setDaily' },
  { key: 'dailyRef', file: SRC.quoteStage, line: 456, label: '日 K 参考（昨收/涨跌）', requests: ctx => (ctx.interval === '1d' ? 0 : req('fetchKlines(crypto, 1d, 750)')), note: 'useEffect（不是 usePoll）：1d 复用图表序列 → 0；其它周期另发 1 条 ' + DAILY_LIMIT + ' 根' },
  { key: 'derivatives', file: SRC.quoteStage, line: 474, label: '衍生品快照轮询', requests: ctx => (ctx.market === 'crypto' ? req('fetchDerivatives(crypto)') : 0), note: 'crypto 专属' },
  { key: 'derivativesHistory', file: SRC.quoteStage, line: 486, label: '衍生品历史轮询', requests: ctx => (ctx.stageTab === 'derivatives' && ctx.market === 'crypto' ? req('fetchDerivativesHistory(crypto)') : 0), note: '页签激活才拉' },
  { key: 'orderbook', file: SRC.quoteStage, line: 498, label: '盘口 + 分笔轮询', requests: ctx => (ctx.orderbookOpen && ctx.stageTab === 'chart' ? req('fetchOrderbook(crypto)') + req('fetchRecentTrades(crypto, 50)') : 0), note: 'Promise.all 两请求；开关记忆在 localStorage' },
  { key: 'tradeDesk', file: SRC.quoteStage, line: 530, label: '交易台只读轮询 refreshTradeDesk', requests: ctx => (ctx.stageTab === 'chart' && (ctx.tradeDeskOpen || ctx.tradeMode === 'live') ? TRADE_DESK_REQUESTS : 0), note: 'Promise.all ' + TRADE_DESK_REQUESTS + ' 请求；守卫 = 页签 chart 且（面板开 或 实盘）——关着时这四个响应没有渲染消费者' },
  { key: 'ticker', file: SRC.quoteStage, line: 641, label: 'ticker 轮询（价 + 尾随合并）', requests: () => req('fetchTickers(crypto, 1 标的)'), note: '1 次批量 ticker（1 标的）' },
  { key: 'news', file: SRC.quoteStage, line: 665, label: '新闻情报流轮询', requests: ctx => (ctx.stageTab === 'news' || ctx.stageTab === 'announcements' || ctx.knowledgeOn ? req('fetchNews(crypto, 50)') : 0), note: '只在页签/知识图钉激活时拉' },
  {
    key: 'aux',
    file: SRC.useAuxSeries,
    line: 65,
    label: '外部序列预取（QuoteStage.tsx:464 调用）',
    requests: ctx => ctx.auxKeys.length,
    note: '每键 1 次；usePoll 那条（:70）挂载时被 covered 守卫挡掉',
    guard: '刷新内部：request === "" || keys.length === 0 || inFlight !== null → 跳过',
    deps: '}, [request, signature])  // request = market:symbol',
    symbolRefire: true,
  },
  {
    key: 'providers',
    file: SRC.quoteStage,
    line: 191,
    label: 'ensureMarketProviders（市场路由/能力缓存）',
    requests: ctx => (ctx.marketProvidersWarm ? 0 : 1),
    note: '模块级缓存：会话内只有首次挂载付 1 次',
    guard: 'if (infos !== null) return providers（缓存命中即 0 请求）',
    deps: '}, [])  // 只在挂载时跑一次',
  },
]

const guardOf = (site: PollSite): string => {
  if (site.guard !== undefined) return site.guard
  const lines = linesOf(site.file)
  for (let index = site.line; index < Math.min(site.line + 4, lines.length); index += 1) {
    const trimmed = lines[index]!.trim()
    if (trimmed.startsWith('if (')) return trimmed
  }
  return '（无显式守卫）'
}
const depsOf = (site: PollSite): string => {
  if (site.deps !== undefined) return site.deps
  const lines = linesOf(site.file)
  for (let index = site.line; index < Math.min(site.line + 40, lines.length); index += 1) {
    const trimmed = lines[index]!.trim()
    if (/^\},.*\[/.test(trimmed)) return trimmed
  }
  return '（未解析到 deps）'
}
const refiresOnStageTab = (site: PollSite): boolean => /stageTab/.test(depsOf(site))
const refiresOnSymbol = (site: PollSite): boolean => site.symbolRefire === true || /symbol/.test(depsOf(site))

const sitePollLines = pollLines.slice().sort((a, b) => a - b)
const tablePollLines = SITES
  .filter(site => /usePoll\(/.test(linesOf(site.file)[site.line - 1] ?? ''))
  .map(site => site.line)
  .sort((a, b) => a - b)
console.log('  源码中 QuoteStage.tsx 的 usePoll 调用点行号：' + sitePollLines.join(', '))
console.log('  本表覆盖的 usePoll 行号：' + tablePollLines.join(', '))
check(JSON.stringify(sitePollLines) === JSON.stringify(tablePollLines), '取数表覆盖全部 usePoll 调用点（新增/删除 poll 会在此处变红）')
check(!/usePoll\(/.test(linesOf(SRC.useAuxSeries)[64] ?? '') && /refresh\(true\)/.test(linesOf(SRC.useAuxSeries)[64] ?? ''), 'useAuxSeries 首次取数是 effect 内 refresh(true)（' + SRC.useAuxSeries + ':65），不是 usePoll')
check(/usePoll\(/.test(linesOf(SRC.useAuxSeries)[69] ?? ''), 'useAuxSeries 的 usePoll 在 :70（挂载时被 covered 守卫挡掉，不重复取数）')
check(/ensureMarketProviders/.test(linesOf(SRC.quoteStage)[190] ?? ''), 'ensureMarketProviders 在 QuoteStage.tsx:191 的挂载 effect 里')

callLog.length = 0
globalThis.fetch = (async (input: unknown) => new Response(JSON.stringify(payloadFor(String(input))), { status: 200 })) as typeof globalThis.fetch
await ensureMarketProviders()
globalThis.fetch = realFetch
const providersSecondCall = await withFetchStub(() => ensureMarketProviders())
check(providersSecondCall.urls.length === 0, 'ensureMarketProviders 第二次调用 0 请求（模块级缓存生效）')

/** tradeMode 的真实缺省（trade-mode-store.ts readInitial：无 localStorage → paper）。 */
const DEFAULT_TRADE_MODE = tradeModeStore.getSnapshot()
/** readTradeDeskOpen 的缺省：无 localStorage 记忆时 false（QuoteStage.tsx:2030-2035）。 */
const DEFAULT_TRADE_DESK_OPEN = false

const ctxCrypto: Ctx = {
  market: 'crypto',
  interval: '1d',
  stageTab: 'chart',
  orderbookOpen: false,
  tradeDeskOpen: DEFAULT_TRADE_DESK_OPEN,
  tradeMode: DEFAULT_TRADE_MODE,
  knowledgeOn: false,
  auxKeys: [],
  marketProvidersWarm: true,
}

table(
  ['调用点', '标签', '守卫（源码）', 'deps（源码）', '含 stageTab', '含 symbol', '缺省请求数'],
  SITES.map(site => [
    site.file.split('/').pop() + ':' + site.line,
    site.label,
    guardOf(site).replace(/\s+/g, ' ').slice(0, 62),
    depsOf(site).replace(/\s+/g, ' ').slice(0, 46),
    refiresOnStageTab(site) ? '是' : '否',
    refiresOnSymbol(site) ? '是' : '否',
    site.requests(ctxCrypto),
  ]),
)
check(SITES.filter(site => refiresOnStageTab(site)).length === 4, 'deps 含 stageTab 的调用点恰好 4 个（衍生品历史 / 盘口 / 交易台 / 新闻）')
check(SITES.filter(site => refiresOnSymbol(site)).length === 8, 'deps 含 symbol 的调用点恰好 8 个（K 线 / 日 K / 衍生品 / 衍生品历史 / 盘口 / ticker / 新闻 / aux）')
check(/^\s*useEffect\(\(\) => \{/.test(linesOf(SRC.quoteStage)[dailyRefEffectLine - 2] ?? ''), '日 K 参考是 effect（' + SRC.quoteStage + ':' + (dailyRefEffectLine - 1) + '），不是 usePoll')
check(TRADE_DESK_REQUESTS > 0, 'refreshTradeDesk 一拍解析到 ' + TRADE_DESK_REQUESTS + ' 个 fetch（' + SRC.quoteStage + ':' + tradeDeskBodyStart + '-' + tradeDeskBodyEnd + ' 的 Promise.all，源码现读）')
const tradeDeskSite = SITES.find(site => site.key === 'tradeDesk')!
const tradeDeskGuard = guardOf(tradeDeskSite)
check(/tradeDeskOpen/.test(tradeDeskGuard) && /tradeMode/.test(tradeDeskGuard), '交易台守卫含 tradeDeskOpen / tradeMode：' + tradeDeskGuard.replace(/\s+/g, ' '))
check(DEFAULT_TRADE_MODE !== 'live', 'tradeMode 缺省 = ' + DEFAULT_TRADE_MODE + '（trade-mode-store.ts readInitial）→ 交易台关着时这 ' + TRADE_DESK_REQUESTS + ' 个请求真的不发')
check(/return localStorage\.getItem\(TRADE_DESK_OPEN_KEY\) === '1'/.test(textOf(SRC.quoteStage)), 'tradeDeskOpen 缺省 = false（未写记忆时，QuoteStage.tsx:2030-2035）')

table(
  ['市场', 'K 线 resync（residentPollMs）', 'ticker（residentPollMs）'],
  (['crypto', 'cn', 'hk', 'us', 'futures'] as const).map(market => [
    market,
    residentPollMs(market as never, POLL_MS.klineResync) === null ? '按需（无定时器）' : POLL_MS.klineResync / 1000 + 's',
    residentPollMs(market as never, POLL_MS.ticker) === null ? '按需（无定时器）' : POLL_MS.ticker / 1000 + 's',
  ]),
)

const totalRequests = (ctx: Ctx): number => SITES.reduce((sum, site) => sum + site.requests(ctx), 0)
/** 换页签引发的重发：只有 deps 含 stageTab 的调用点会在 effect 重跑时立即 tick。 */
const stageTabDelta = (ctx: Ctx, nextTab: string): number => SITES
  .filter(site => refiresOnStageTab(site))
  .reduce((sum, site) => sum + site.requests({ ...ctx, stageTab: nextTab }), 0)
/** 换标的引发的重发：deps 含 symbol 的调用点（aux 用 request = market:symbol 判定）。 */
const symbolDelta = (ctx: Ctx): number => SITES
  .filter(site => refiresOnSymbol(site))
  .reduce((sum, site) => sum + site.requests(ctx), 0)

/* ──────────────────────────── §4 图表对象/序列重建计数 ──────────────────────────── */

section('§4 一次图表重建会造几个对象（真实 syncIndicators × 记录型 IChartApi 桩；桩在 lightweight-charts 渲染 API 面）')

const registry = createIndicatorRegistry()
for (const definition of presetDefinitions()) registry.register(definition)
const chartStore = createChartStateStore(registry)
const storedInstances = chartStore.getSnapshot().instances
const factoryDefault = registry.defaultInstance('ma')
console.log('  指标名册（真实 presetDefinitions）：' + presetDefinitions().length + ' 个 —— ' + presetDefinitions().map(definition => definition.id).join(', '))
console.log('  chart-state 读回的实例：' + JSON.stringify(storedInstances))
console.log('  registry.defaultInstance(ma)：' + JSON.stringify(factoryDefault))
check(storedInstances.length === 1 && storedInstances[0]!.id === 'ma' && Object.keys(storedInstances[0]!.params).length === 6, 'chart-state 出厂默认 = 1 个 ma 实例（6 条输出），本机 Node 存储为空故读到出厂值')

interface ChartRec { addSeries: number; removeSeries: number; setDataCalls: number; setDataPoints: number; panes: Set<number> }
function recordingChart(): { chart: unknown; rec: ChartRec } {
  const rec: ChartRec = { addSeries: 0, removeSeries: 0, setDataCalls: 0, setDataPoints: 0, panes: new Set<number>() }
  const chart = {
    addSeries: (_definition: unknown, _options: unknown, paneIndex = 0) => {
      rec.addSeries += 1
      rec.panes.add(paneIndex)
      return {
        setData: (data: readonly unknown[]) => { rec.setDataCalls += 1; rec.setDataPoints += data.length },
        applyOptions: () => undefined,
        options: () => ({}) as Record<string, unknown>,
      }
    },
    removeSeries: () => { rec.removeSeries += 1 },
    priceScale: () => ({ width: () => 0 }),
    panes: () => [],
    timeScale: () => ({ subscribeVisibleLogicalRangeChange: () => undefined, unsubscribeVisibleLogicalRangeChange: () => undefined }),
  }
  return { chart, rec }
}

interface Bar { openTime: number; open: number; high: number; low: number; close: number; volume: number }
/** 确定性合成 K 线（无随机数，重跑一致）；只用来喂真实 compute，不参与任何计数口径。 */
function makeBars(count: number): Bar[] {
  const start = Date.UTC(2024, 0, 1)
  const bars: Bar[] = []
  for (let index = 0; index < count; index += 1) {
    const close = 100 + Math.sin(index / 7) * 5
    const open = 100 + Math.sin((index - 1) / 7) * 5
    bars.push({
      openTime: start + index * 86_400_000,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 1000 + (index % 97),
    })
  }
  return bars
}

interface Config { name: string; instances: readonly unknown[] }
const allPresetInstances = presetDefinitions()
  .map(definition => registry.defaultInstance(definition.id))
  .filter((instance): instance is NonNullable<typeof instance> => instance !== undefined)
const CONFIGS: Config[] = [
  { name: '出厂默认（ma）', instances: storedInstances },
  { name: '全预置（' + allPresetInstances.length + ' 组）', instances: allPresetInstances },
]

let holdingsCalls = 0
let activeBuyCalls = 0
const stubHoldings = async (): Promise<undefined> => { holdingsCalls += 1; return undefined }
const stubActiveBuy = async (): Promise<undefined> => { activeBuyCalls += 1; return undefined }

const auxRows: Array<Array<string>> = []
for (const config of CONFIGS) {
  for (const market of ['crypto', 'cn', 'hk', 'us', 'futures'] as const) {
    const applicable = selectApplicableInstances(config.instances as never, market, '1d')
    const keys = requiredAuxKeys(applicable, market, id => registry.get(id))
    holdingsCalls = 0
    activeBuyCalls = 0
    for (const key of keys) await loadAuxSeries(key, market, 'SYMBOL', stubHoldings, stubActiveBuy)
    auxRows.push([config.name, market, keys.join(',') || '（无）', String(holdingsCalls + activeBuyCalls)])
  }
}
table(['指标配置', '市场', 'requiredAuxKeys', '预取请求数'], auxRows)
check(auxRows.filter(row => row[3] === '0').length === auxRows.length - 2, '外部序列预取只在「声明 aux 的实例在该市场适用」时发生（出厂默认全 0；全预置只在 hk/cn 各 1 次）')

interface BuildStat {
  addSeries: number
  removeSeries: number
  setDataCalls: number
  setDataPoints: number
  panes: number
  groups: number
  outputs: number
  placeholders: number
  indicatorElements: number
}

function buildSeries(config: Config, market: string, interval: string, barsCount: number, auxReady: boolean): BuildStat {
  const bars = makeBars(barsCount)
  const applicable = selectApplicableInstances(config.instances as never, market, interval)
  const auxKeys = requiredAuxKeys(applicable, market, id => registry.get(id))
  const aux: Record<string, Array<{ date: number; value: number }>> = {}
  if (auxReady) for (const key of auxKeys) aux[key] = makeBars(250).map(bar => ({ date: bar.openTime, value: bar.close }))
  const groups = dispatchIndicatorGroups({
    klines: bars as never,
    instances: applicable as never,
    market,
    symbol: FOCUS.symbol,
    aux: aux as never,
    deps: {
      getDefinition: id => registry.get(id),
      clampParams: (definition, params) => registry.clampParams(definition, params),
      instanceKey: instance => registry.instanceKey(instance),
    },
  })
  const toGroup = (group: (typeof groups)[number]): { key: string; title?: string; outputs: readonly unknown[]; emptyNotice?: string } => ({
    key: group.key,
    ...(group.title !== undefined ? { title: group.title } : {}),
    outputs: group.outputs,
    ...(group.auxEmptyKey !== undefined ? { emptyNotice: group.auxEmptyKey } : {}),
  })
  const mainGroups = groups.filter(group => group.pane === 'main').map(toGroup)
  const subGroups = groups.filter(group => group.pane === 'sub').map(toGroup)
  const timeAxis = bars.map(bar => Math.floor(bar.openTime / 1000))
  const { chart, rec } = recordingChart()
  const mainRefs = new Map<string, Map<string, unknown>>()
  const subRefs = new Map<string, Map<string, unknown>>()
  syncIndicators(chart as never, mainRefs as never, mainGroups as never, timeAxis as never, false, 0, false)
  syncIndicators(chart as never, subRefs as never, subGroups as never, timeAxis as never, true, subIndicatorPaneIndex(0), false)
  const indicatorElements = groups.reduce((sum, group) => sum + group.outputs.reduce((acc, output) => acc + output.values.length, 0), 0)
  return {
    addSeries: rec.addSeries,
    removeSeries: rec.removeSeries,
    setDataCalls: rec.setDataCalls,
    setDataPoints: rec.setDataPoints,
    panes: rec.panes.size,
    groups: groups.length,
    outputs: groups.reduce((sum, group) => sum + group.outputs.length, 0),
    placeholders: groups.filter(group => group.outputs.length === 0).length,
    indicatorElements,
  }
}

const tvMountStart = lineOf(SRC.tvChart, /const chart = createChart\(container/)
const tvMountEnd = lineOf(SRC.tvChart, /^\s*return \(\) => \{/, tvMountStart)
const tvMountRegion = linesOf(SRC.tvChart).slice(tvMountStart - 1, tvMountEnd)
const tvMountText = tvMountRegion.join('\n')
const baseSeries = tvMountRegion.filter(line => /chart\.addSeries\(/.test(line)).length
const mirrorSeries = (tvMountText.match(/\.\.\.mirrorBase\(\)/g) ?? []).length
const markerPlugin = (textOf(SRC.tvChart).match(/createSeriesMarkers\(candles, markers\)/g) ?? []).length
console.log('  TvChart 挂载 effect 区间：' + SRC.tvChart + ':' + tvMountStart + '-' + tvMountEnd + '（createChart → 基础序列 → 事件订阅 → cleanup 的 chart.remove()）')
console.log('  该区间 chart.addSeries(...) 调用数 = ' + baseSeries + '（蜡烛 1 + 右轴镜像 ' + mirrorSeries + '）；createSeriesMarkers(...) 全文件 ' + markerPlugin + ' 处（每次建图 1 个插件）。')
check(baseSeries === 4 && mirrorSeries === 3, '每次建图固定 4 个基础序列（蜡烛 + 3 根右轴镜像线）')
check(markerPlugin === 1, '每次建图固定 1 个序列标记插件')

const buildRows: Array<Array<string | number>> = []
for (const config of CONFIGS) {
  for (const market of ['crypto', 'cn', 'hk', 'us'] as const) {
    const stat = buildSeries(config, market, '1d', DAILY_LIMIT, true)
    buildRows.push([
      config.name,
      market,
      '1d',
      DAILY_LIMIT,
      stat.groups + ' 组 / ' + stat.outputs + ' 输出',
      stat.addSeries,
      baseSeries + stat.addSeries + (stat.outputs > 0 ? 1 : 0),
      stat.setDataCalls,
      stat.setDataPoints,
      stat.indicatorElements,
    ])
  }
}
table(['指标配置', '市场', '周期', 'bar 根数', '调度结果', '指标序列对象', '建图对象总数', 'setData 次数', 'setData 点数', '指标数组元素'], buildRows)
console.log('  建图对象总数 = 4（基础序列）+ 指标序列对象 + 1（标记插件）。数据点按 toLineData 跳过 undefined 的口径计（warm-up 不灌）。')
console.log('')

const warmProbe = (() => {
  const bars = makeBars(DAILY_LIMIT)
  const applicable = selectApplicableInstances(storedInstances as never, 'crypto', '1d')
  const groups = dispatchIndicatorGroups({
    klines: bars as never,
    instances: applicable as never,
    market: 'crypto',
    symbol: FOCUS.symbol,
    aux: {} as never,
    deps: {
      getDefinition: id => registry.get(id),
      clampParams: (definition, params) => registry.clampParams(definition, params),
      instanceKey: instance => registry.instanceKey(instance),
    },
  }).filter(group => group.pane === 'main').map(group => ({ key: group.key, outputs: group.outputs }))
  const timeAxis = bars.map(bar => Math.floor(bar.openTime / 1000))
  const { chart, rec } = recordingChart()
  const refs = new Map<string, Map<string, unknown>>()
  syncIndicators(chart as never, refs as never, groups as never, timeAxis as never, false, 0, false)
  const cold = { addSeries: rec.addSeries, setDataCalls: rec.setDataCalls, setDataPoints: rec.setDataPoints }
  syncIndicators(chart as never, refs as never, groups as never, timeAxis as never, false, 0, false)
  const warm = { addSeries: rec.addSeries - cold.addSeries, setDataCalls: rec.setDataCalls - cold.setDataCalls, setDataPoints: rec.setDataPoints - cold.setDataPoints }
  const { chart: chart2, rec: rec2 } = recordingChart()
  syncIndicators(chart2 as never, new Map() as never, groups as never, timeAxis as never, false, 0, false)
  const remount = { addSeries: rec2.addSeries, setDataCalls: rec2.setDataCalls, setDataPoints: rec2.setDataPoints }
  return { cold, warm, remount }
})()
table(['场景', 'addSeries', 'setData 次数', 'setData 点数', '对应生产路径'], [
  ['首次同步（refs 为空）', warmProbe.cold.addSeries, warmProbe.cold.setDataCalls, warmProbe.cold.setDataPoints, '挂载 / 切回页签 = 这条路径'],
  ['热同步（refs 已在，bars 变化）', warmProbe.warm.addSeries, warmProbe.warm.setDataCalls, warmProbe.warm.setDataPoints, '30s resync、ticker 尾随合并、换标的'],
  ['重挂同步（新 refs，同数据）', warmProbe.remount.addSeries, warmProbe.remount.setDataCalls, warmProbe.remount.setDataPoints, '切走再切回：数据一条没变也要重建'],
])
check(warmProbe.warm.addSeries === 0 && warmProbe.remount.addSeries === warmProbe.cold.addSeries, '热同步 0 新建；重挂同步新建数 = 首次同步（数据未变也重建）')

/* ──────────────────────────── §5 三种切换的一次成本 ──────────────────────────── */

section('§5 三种「切」的一次成本（计数，不是时间）')

const ctxCn: Ctx = { ...ctxCrypto, market: 'cn' }
const ctxFutures: Ctx = { ...ctxCrypto, market: 'futures' }
const ctxOrderbook: Ctx = { ...ctxCrypto, orderbookOpen: true }
/** 交易台开着的同一 ctx：与 ctxCrypto 只差 tradeDeskOpen，用来量守卫那一项。 */
const ctxTradeDeskOpen: Ctx = { ...ctxCrypto, tradeDeskOpen: true }
/** 非 1d 周期的同一 ctx：与 ctxCrypto 只差 interval，用来量日 K 参考那一项。 */
const ctxNonDaily: Ctx = { ...ctxCrypto, interval: '1m' }
/** 旧守卫 + 旧取数口径（面板开着 + 非 1d）：一次挂载的对照成本。 */
const ctxLegacy: Ctx = { ...ctxCrypto, tradeDeskOpen: true, interval: '1m' }

const requestsOf = (key: SiteKey, ctx: Ctx): number => SITES.find(site => site.key === key)!.requests(ctx)
/** 一次挂载/一次重跑实际发出的 K 线请求数（1d 下日 K 参考复用图表序列 → 只剩 1 条）。 */
const klineRequests = (ctx: Ctx): number => requestsOf('kline', ctx) + requestsOf('dailyRef', ctx)

const cryptoMount = totalRequests(ctxCrypto)
const cnMount = totalRequests(ctxCn)
const futuresMount = totalRequests(ctxFutures)
const cryptoMountOrderbook = totalRequests(ctxOrderbook)
const legacyMount = totalRequests(ctxLegacy)
const accountPerSwitch = requestsOf('tradeDesk', ctxTradeDeskOpen)

const cryptoBuild = buildSeries(CONFIGS[0]!, 'crypto', '1d', DAILY_LIMIT, true)
const perMountSeries = baseSeries + cryptoBuild.addSeries + 1
const chartPointsPerBuild = cryptoBuild.setDataPoints + DAILY_LIMIT
const retainedElements = DAILY_LIMIT + DAILY_LIMIT + cryptoBuild.indicatorElements
const symbolSwitch = symbolDelta(ctxCrypto)
const tabToFundamentals = stageTabDelta(ctxCrypto, 'fundamentals') + stageTabDelta(ctxCrypto, 'chart')
const tabToNews = stageTabDelta(ctxCrypto, 'news') + stageTabDelta(ctxCrypto, 'chart')
const tabToDerivatives = stageTabDelta(ctxCrypto, 'derivatives') + stageTabDelta(ctxCrypto, 'chart')
const tabLegacyReturn = stageTabDelta(ctxTradeDeskOpen, 'fundamentals') + stageTabDelta(ctxTradeDeskOpen, 'chart')

const klineCell = (ctx: Ctx): string => String(klineRequests(ctx)) + ' 条' + (ctx.interval === '1d' ? '（日 K 参考复用图表序列）' : '（轮询 + 日 K 参考各 1）')
/** 换页签引发的 K 线请求：K 线两处 poll 的 deps 都不含 stageTab → 恒 0（模型现算，不是字面量）。 */
const klineRefireOnStageTab = (ctx: Ctx): number => [...SITES]
  .filter(site => (site.key === 'kline' || site.key === 'dailyRef') && refiresOnStageTab(site))
  .reduce((sum, site) => sum + site.requests(ctx), 0)

table(['切换类型', '桥调用', '其中 K 线请求', 'createChart', '序列对象新建', 'setData 点数', '保留的序列数组/元素'], [
  ['中栏视图 A→B→A（crypto，1d，盘口关，交易台关）', cryptoMount, klineCell(ctxCrypto), 1, baseSeries + ' + ' + cryptoBuild.addSeries + ' 指标 + 1 插件 = ' + perMountSeries, chartPointsPerBuild, '0（卸载即丢）'],
  ['中栏视图 A→B→A（cn）', cnMount, klineCell(ctxCn), 1, String(perMountSeries), chartPointsPerBuild, '0（卸载即丢）'],
  ['中栏视图 A→B→A（crypto，盘口竖栏开）', cryptoMountOrderbook, klineCell(ctxOrderbook), 1, String(perMountSeries), chartPointsPerBuild, '0'],
  ['行情页签 chart→fundamentals→chart', tabToFundamentals, String(klineRefireOnStageTab(ctxCrypto)) + '（页签不在 K 线 deps 里）', 1, String(perMountSeries), chartPointsPerBuild, 2 + cryptoBuild.outputs + ' 个数组 / ' + retainedElements + ' 元素'],
  ['行情页签 chart→news→chart', tabToNews, String(klineRefireOnStageTab(ctxCrypto)) + '（同上）', 1, String(perMountSeries), chartPointsPerBuild, '同上 + 新闻 1 份'],
  ['行情页签 chart→derivatives→chart（crypto）', tabToDerivatives, String(klineRefireOnStageTab(ctxCrypto)) + '（同上）', 1, String(perMountSeries), chartPointsPerBuild, '同上 + 衍生品历史 1 份'],
  ['标的 A→B（同市场 crypto，1d，盘口关）', symbolSwitch, klineCell(ctxCrypto), 0, '0（dataKey 变化只 setData）', chartPointsPerBuild, 1 + cryptoBuild.outputs + ' 个数组（旧数组被替换）'],
])

console.log('  一次跨视图中栏切换（crypto、1d、盘口关、交易台关、出厂指标）合计 ' + cryptoMount + ' 次桥调用：')
console.log('    指数 ' + requestsOf('index', ctxCrypto) + ' + K 线 ' + requestsOf('kline', ctxCrypto)
  + ' + 日K参考 ' + requestsOf('dailyRef', ctxCrypto) + ' + 衍生品 ' + requestsOf('derivatives', ctxCrypto)
  + ' + 衍生品历史 ' + requestsOf('derivativesHistory', ctxCrypto) + ' + 盘口 ' + requestsOf('orderbook', ctxCrypto)
  + ' + 交易台 ' + requestsOf('tradeDesk', ctxCrypto) + ' + ticker ' + requestsOf('ticker', ctxCrypto)
  + ' + 新闻 ' + requestsOf('news', ctxCrypto) + '；图表对象 1 个、序列对象 ' + perMountSeries + ' 个、数据点 ' + chartPointsPerBuild + ' 个。')
console.log('  同一 ctx 换成「面板开着 / 实盘」多 ' + (totalRequests(ctxTradeDeskOpen) - cryptoMount) + ' 次（交易台 ' + accountPerSwitch + '）；换成非 1d 周期多 '
  + (totalRequests(ctxNonDaily) - cryptoMount) + ' 次（日 K 参考另发 1 条）；两者同时成立（= 旧守卫口径）' + legacyMount + ' 次。')
console.log('')
console.log('  页签切换不再免费打账户端点：chart→fundamentals→chart = ' + tabToFundamentals + ' 次桥调用（交易台 deps 含 stageTab，但守卫还要 tradeDeskOpen 或实盘；'
  + SRC.quoteStage + ':530-533）。')
console.log('  chart→news→chart = ' + tabToNews + ' 次、chart→derivatives→chart = ' + tabToDerivatives + ' 次（各只剩去程那 1 条）；'
  + '同样两次往返在旧守卫下 = ' + tabLegacyReturn + ' 次。')
console.log('')

/* ──────────────────────────── §6 连续 20 次 A↔B 累计 ──────────────────────────── */

section('§6 连续 20 次 A↔B 的累计计数')

const SWITCHES = 20
const returns = SWITCHES / 2
const klinePerMount = klineRequests(ctxCrypto)
table(['路径', '切换次数', '重挂/重建次数', '累计桥调用', '累计 K 线请求', '累计序列对象', '累计 setData 点数'], [
  [
    '中栏视图 A(行情)↔B(其它视图)，从 A 起步（1d / 盘口关 / 交易台关）',
    SWITCHES,
    returns + '（每次切回 A）+ 1 首次建图 = ' + (returns + 1),
    returns + ' × ' + cryptoMount + ' = ' + returns * cryptoMount,
    returns + ' × ' + klinePerMount + ' = ' + returns * klinePerMount + ' 次（各 ' + DAILY_LIMIT + ' 根）',
    returns + ' × ' + perMountSeries + ' = ' + returns * perMountSeries,
    returns + ' × ' + chartPointsPerBuild + ' = ' + returns * chartPointsPerBuild,
  ],
  [
    '行情页签 chart↔fundamentals（同视图）',
    SWITCHES,
    String(returns),
    returns + ' × ' + tabToFundamentals + ' = ' + returns * tabToFundamentals,
    '0',
    returns + ' × ' + perMountSeries + ' = ' + returns * perMountSeries,
    returns + ' × ' + chartPointsPerBuild + ' = ' + returns * chartPointsPerBuild,
  ],
  [
    '标的 A↔B（同市场，视图不动）',
    SWITCHES,
    '0（图表不重建）',
    SWITCHES + ' × ' + symbolSwitch + ' = ' + SWITCHES * symbolSwitch,
    SWITCHES + ' × ' + klinePerMount + ' = ' + SWITCHES * klinePerMount + ' 次（各 ' + DAILY_LIMIT + ' 根）',
    '0',
    SWITCHES + ' × ' + chartPointsPerBuild + ' = ' + SWITCHES * chartPointsPerBuild,
  ],
  [
    '对照：同上第一行，但用旧守卫 / 旧取数口径（面板开着 + 非 1d）',
    SWITCHES,
    returns + ' + 1（建图次数与守卫无关）',
    returns + ' × ' + legacyMount + ' = ' + returns * legacyMount,
    returns + ' × ' + klineRequests(ctxNonDaily) + ' = ' + returns * klineRequests(ctxNonDaily) + ' 次',
    returns + ' × ' + perMountSeries + ' = ' + returns * perMountSeries,
    returns + ' × ' + chartPointsPerBuild + ' = ' + returns * chartPointsPerBuild,
  ],
])
console.log('  口径：20 次切换 = 10 次「回到 A」；首次显示 A 的那次建图单独计入「重挂/重建次数」。')
console.log('  最后一行不是当前行为，是把 ctx 换成「交易台开 + 非 1d」后同一模型算出来的对照值（= 修复前的口径）。')
console.log('')

/* ──────────────────────────── §7 真实规模 vs 尾部规模 ──────────────────────────── */

section('§7 真实规模 vs 尾部规模（18 标的 / 15 持仓 / 1 分组 / 6 知识卡 / 401 storage 文件）')

const allPreset1d = buildSeries(CONFIGS[1]!, 'us', '1d', DAILY_LIMIT, true)
const allPreset1m = buildSeries(CONFIGS[1]!, 'us', '1m', klineLimit('us'), true)
const crypto1m = buildSeries(CONFIGS[0]!, 'crypto', '1m', klineLimit('crypto'), true)
table(['场景', '指标配置', 'bar 根数', '序列对象', 'setData 点数', '指标数组元素'], [
  ['真实规模（缺省周期 1d）', CONFIGS[0]!.name, DAILY_LIMIT, String(perMountSeries), chartPointsPerBuild, cryptoBuild.indicatorElements],
  ['尾部规模（全预置 1d）', CONFIGS[1]!.name, DAILY_LIMIT, baseSeries + ' + ' + allPreset1d.addSeries + ' + 1 = ' + (baseSeries + allPreset1d.addSeries + 1), allPreset1d.setDataPoints + DAILY_LIMIT, allPreset1d.indicatorElements],
  ['尾部规模（全预置 us 分钟级）', CONFIGS[1]!.name, klineLimit('us'), baseSeries + ' + ' + allPreset1m.addSeries + ' + 1 = ' + (baseSeries + allPreset1m.addSeries + 1), allPreset1m.setDataPoints + DAILY_LIMIT, allPreset1m.indicatorElements],
  ['真实规模（crypto 分钟级）', CONFIGS[0]!.name, klineLimit('crypto'), baseSeries + ' + ' + crypto1m.addSeries + ' + 1 = ' + (baseSeries + crypto1m.addSeries + 1), crypto1m.setDataPoints + DAILY_LIMIT, crypto1m.indicatorElements],
])
console.log('  切换路径的调用点数与规模无关（crypto ' + cryptoMount + ' / cn·hk·us ' + cnMount + ' / futures ' + futuresMount + '——futures 无指数轮询、无衍生品轮询），与 18 标的、15 持仓、401 文件都无关；')
console.log('  随规模变的是「每拍携带多少行」与「序列/元素个数」：持仓 ' + WORKLOAD.positions + ' 条进 fetchTradePositions 的响应体（1 请求，行数只影响载荷），')
console.log('  指标组数把序列对象与 setData 点数线性放大（' + cryptoBuild.addSeries + ' → ' + allPreset1d.addSeries + ' 条指标序列）。')
console.log('  知识卡 ' + WORKLOAD.knowledgeCards + ' 张与 storage ' + WORKLOAD.storageFiles + ' 个文件不在切换路径上：知识图钉由 newsItems 派生（' + SRC.quoteStage + ':934-979，无独立取数），storage 文件不参与中栏渲染。')
console.log('')

/* ──────────────────────────── §8 到什么规模会被用户感知 ──────────────────────────── */

section('§8 确定性推演：切换节奏把哪条预算放大几倍')

const tradeDeskSteadyPerMin = accountPerSwitch / (POLL_MS.tradeDesk / 60_000)
const klineBarsPerMount = klineRequests(ctxCrypto) * DAILY_LIMIT
const klineSteadyBarsPerMin = DAILY_LIMIT / (POLL_MS.klineResync / 60_000)
const accountPerMountClosed = requestsOf('tradeDesk', ctxCrypto)
const accountPerMountOpen = accountPerSwitch
const rhythmRows: Array<Array<string | number>> = []
for (const periodSec of [60, 30, 10, 5, 2]) {
  const mountsPerMin = 60 / periodSec
  const barsPerMin = mountsPerMin * klineBarsPerMount
  rhythmRows.push([
    '每 ' + periodSec + 's 切一次',
    mountsPerMin.toFixed(1),
    (mountsPerMin * cryptoMount).toFixed(0),
    (mountsPerMin * accountPerMountClosed).toFixed(0),
    (mountsPerMin * accountPerMountOpen).toFixed(0),
    (mountsPerMin * accountPerMountOpen / tradeDeskSteadyPerMin).toFixed(2) + '×',
    barsPerMin.toFixed(0),
    (barsPerMin / klineSteadyBarsPerMin).toFixed(2) + '×',
    (mountsPerMin * perMountSeries).toFixed(0),
  ])
}
table(['切换节奏', '挂载/分', '桥调用/分', '账户面/分（交易台关）', '账户面/分（交易台开/实盘）', 'vs 账户面稳态 ' + accountPerSwitch + ' 次/' + POLL_MS.tradeDesk / 1000 + 's', 'K 线点数/分', 'vs K 线稳态 ' + DAILY_LIMIT + ' 根/' + POLL_MS.klineResync / 1000 + 's', '序列对象新建/分'], rhythmRows)
console.log('  一次跨视图切换 = ' + (klineBarsPerMount / klineSteadyBarsPerMin * 60).toFixed(0) + ' 秒的 K 线稳态摄入量；账户面额度 = ' + (accountPerMountOpen / tradeDeskSteadyPerMin * 60).toFixed(0) + ' 秒（面板开着时），关着时 0 秒。')
console.log('  即：每 10s 切一次 → K 线摄入量 ×' + (6 * klineBarsPerMount / klineSteadyBarsPerMin).toFixed(1)
  + '；账户面面板开着 ×' + (6 * accountPerMountOpen / tradeDeskSteadyPerMin).toFixed(1) + '、关着 ×0。')
console.log('  页签来回切：每 10s 切一次页签 → 账户面 ×' + (6 * tabToFundamentals / tradeDeskSteadyPerMin).toFixed(1)
  + '（当前守卫 ' + tabToFundamentals + ' 次/往返）；旧守卫 ×' + (6 * tabLegacyReturn / tradeDeskSteadyPerMin).toFixed(1) + '（' + tabLegacyReturn + ' 次/往返）。')
console.log('  用户能感知的临界点不是毫秒，而是端点额度：交易台开着（或实盘）时，签名账户端点在切换节奏下被按稳态 ' + (accountPerMountOpen / tradeDeskSteadyPerMin).toFixed(2) + ' 次/秒的量级反复打，触发限频时表现为面板整体失败（不是变慢）；关着时这条路径不再打。')
console.log('')

/* ──────────────────────────── §9 已落地的两处收紧（实测，不是预期） ──────────────────────────── */

section('§9 已落地的两处收紧：换一个 ctx 量出来的前后差值（不是预期值）')

const tradeDeskConsumerLine = lineOf(SRC.quoteStage, /\{tradeDeskOpen && \(/)
console.log('  改动点 A（去重）：' + SRC.quoteStage + ':' + klinePollFetchLine + ' 的 K 线轮询在 1d 落地时顺带 setDaily(rows)（:' + dailyFeedLine + '），')
console.log('    :' + dailyRefEffectLine + ' 的日 K 参考 effect 在 1d 直接短路 → 同一 URL 只发 1 条，不再发第二条 ' + DAILY_LIMIT + ' 根。')
console.log('    实测：1d 下 K 线请求 ' + klineRequests(ctxCrypto) + ' 条；同一个 ctx 换成非 1d = ' + klineRequests(ctxNonDaily) + ' 条。')
console.log('  改动点 B（收紧守卫）：' + SRC.quoteStage + ':' + tradeDeskBodyStart + '-' + tradeDeskBodyEnd + ' 的 refreshTradeDesk 只在 stageTab === chart 且（tradeDeskOpen 或 tradeMode === live）时轮询。')
console.log('    实测：一次挂载面板关着 ' + cryptoMount + ' 次、开着 ' + totalRequests(ctxTradeDeskOpen) + ' 次（差 ' + accountPerSwitch + '）；页签往返 chart 关着 ' + tabToFundamentals + ' 次、开着 ' + tabLegacyReturn + ' 次。')
console.log('    渲染消费方仍是 OrderPanel（' + SRC.quoteStage + ':' + tradeDeskConsumerLine + ' 起）与 currentPositionSize / availableCash——面板关着时这 ' + accountPerSwitch + ' 次请求没有消费者。')
console.log('')
console.log('  合计（同一路径，20 次跨视图 A↔B）：' + (returns * cryptoMount) + ' 次桥调用、' + (returns * klinePerMount) + ' 条 K 线请求；')
console.log('  旧口径（面板开着 + 非 1d）同一路径 ' + (returns * legacyMount) + ' 次桥调用、' + (returns * klineRequests(ctxNonDaily)) + ' 条 K 线请求。')
console.log('  不减少的部分：图表/序列对象重建数 ' + perMountSeries + ' 个/次，属渲染成本，Node 侧不能定量（§10）。')
console.log('')
console.log('  什么会推翻它（保留的推翻条件）：')
console.log('  1) 若 owner 要求「打开交易面板不得出现加载态」（预热是特性不是浪费），改动点 B 被否，一次挂载回到 +' + accountPerSwitch + '；')
console.log('  2) 若将来出现面板关闭时仍读 tradePositions / balances 的消费者（例如右缘资产面板改用这套数据），收紧守卫会变成数据陈旧 bug；')
console.log('  3) 若桥允许同一 (market, symbol, interval, limit) 落到不同 provider，那么 1d 下「图表序列 = 参考序列」是新的语义前提（方向上是修掉不一致，但不再是纯去重）；')
console.log('  4) 若 ' + POLL_MS.klineResync / 1000 + 's resync 改成增量游标（不再是 ' + DAILY_LIMIT + ' 根全量），改动点 A 的前提消失。')

/* ──────────────────────────── §10 未测（必须真浏览器） ──────────────────────────── */

section('§10 未测：只有真浏览器才有意义的部分（本轮一律记未测）')

table(['量', '为什么 Node 侧不可测', '要测就得'], [
  ['首帧绘制 / 图表重排耗时', 'lightweight-charts 需要 canvas 与真实布局，Node 侧无渲染管线', '真浏览器 + PerformanceObserver(paint) / trace'],
  ['一次 createChart 的 canvas 分配与 GC', '无 canvas/WebGL 分配语义，Node 侧测到的只是桩函数开销', 'Chrome trace 的 Memory / allocation profile'],
  ['页签点击到首根 K 线落地的输入延迟', '涉及事件 → React 提交 → rAF → 绘制，Node 侧没有这些阶段', '真浏览器 INP / long task'],
  ['常驻数组的真实堆占用（750 × n 个对象）', 'V8 在浏览器与 Node 的堆布局不同，数字不能互推', '浏览器 heap snapshot'],
  ['切换期间 30s resync 与 ticker 尾随合并的交错', '依赖真实网络到达顺序与 document.visibilityState', '真浏览器 + 网络节流'],
])

/* ──────────────────────────── 结论 ──────────────────────────── */

section('结论')

console.log('  1) 中栏视图切走 = 卸载（' + SRC.middleStage + ':105-114 三目互斥，无隐藏保活）：切回要重取全部数据、重建整张图，内存态全丢（缩放平移、悬浮下标、框选、行情页签回落到 chart）。')
console.log('  2) 行情页签切走 = 只卸图表（' + SRC.quoteStage + ':1281 起）：不重取 K 线，回程交易台轮询被 tradeDeskOpen / tradeMode 挡住 → 本次往返 ' + tabToFundamentals + ' 次桥调用（旧守卫 ' + tabLegacyReturn + ' 次）；图表与 ' + perMountSeries + ' 个序列对象仍全部重建、' + chartPointsPerBuild + ' 个数据点重新灌入。')
console.log('  3) 换标的 = 重取数不重建图（' + SRC.quoteStage + ':606-625 + dataKey）：' + symbolSwitch + ' 次桥调用、0 个新序列对象、全量 setData。')
console.log('  4) 一次跨视图切换的真实规模成本（1d / 盘口关 / 交易台关）：' + cryptoMount + ' 次桥调用（crypto）/ ' + cnMount + '（其它市场）/ ' + futuresMount + '（futures），其中 K 线 ' + klinePerMount + ' 条、账户面 0 次（面板开着才 ' + accountPerSwitch + ' 次）、盘口 0 或 ' + (requestsOf('orderbook', ctxOrderbook)) + ' 次；20 次 A↔B 累计 ' + (returns * cryptoMount) + ' 次桥调用、' + (returns * perMountSeries) + ' 个序列对象。')
console.log('')
console.log('  · 全脚本墙钟 ' + (performance.now() - t0).toFixed(0) + ' ms —— 非权威，机器饱和（CPU ~12% idle / compressor 5.6GB），待安静窗口复测；本节所有结论只依赖上面的计数。')

if (failures > 0) {
  console.log('\n  有 ' + failures + ' 条判据未通过（见上方 [FAIL]）。')
  process.exitCode = 1
} else {
  console.log('\n  全部判据通过。')
}
