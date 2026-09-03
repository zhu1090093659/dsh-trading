/**
 * 行情面板主体（中栏 quote 视图）：富途牛牛视觉风格。
 * 顶部报价头 + K线图 + 周期胶囊条 + 技术指标选择器 +
 * 主图指标读数行（副图指标读数在 TvChart 各自 pane 内）+
 * 底部横向指标快捷词条带 + 底部市场指数状态栏。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  fetchKlines, fetchTickers, fetchDerivatives, fetchDerivativesHistory, fetchOrderbook, fetchRecentTrades,
  fetchTradePositions, fetchTradeBalances, fetchTradeOpenOrders, fetchTradeFills, placeGuiOrder,
  cancelGuiOrder,
} from './api.ts'
import { TvChart, toBar, toVolume } from './TvChart.tsx'
import type { TvChartCapture, TvIndicatorGroup } from './TvChart.tsx'
import { composeQuoteMessage } from './compose-quote.ts'
import type { QuoteMessageCopy } from './compose-quote.ts'
import type { SendImageInput } from './fill-composer.ts'
import { FundamentalsStage } from './FundamentalsStage.tsx'
import { DerivativesPane } from './DerivativesPane.tsx'
import { DerivativesStage } from './DerivativesStage.tsx'
import { OrderbookPane } from './OrderbookPane.tsx'
import { OrderPanel } from './OrderPanel.tsx'
import { TradeDrawer } from './TradeDrawer.tsx'
import { computeRangeStats } from './range-stats.ts'
import { IconIndicators, IconSend } from './icons.tsx'
import type { MarketLocaleKey } from './contract.ts'
import {
  INTRADAY_INTERVALS, changePercent, directionColor,
  fmtChange, fmtClock, fmtCompact, fmtFundingRate, fmtPercent, fmtPrice, scaleLocaleOf,
} from './format.ts'
import { indicators, isCustomIndicator } from './indicator-registry.ts'
import type { IndicatorDefinition, IndicatorInstance } from '@dsh-trading/indicators'
import { MARKET_INTERVALS } from './store.ts'
import type { SelectionState } from './store.ts'
import type { ChartState } from './chart-state.ts'
import type { AccountBalance, DerivativesData, DerivativesHistory, Order, Orderbook, Position, TradeFill, TradeTick } from './types.ts'
import { colorModeStore } from './color-mode.ts'
import { MARKET_INDICES, getMarketSessionStatus } from './market-status.ts'
import type { Kline, MarketId, Ticker } from './types.ts'
import { usePoll } from './usePoll.ts'
import { fetchNews } from './api.ts'
import type { ClientNewsItem } from './api.ts'
import { NewsFeedPane } from './NewsFeedPane.tsx'
import { MarkerTooltip } from './MarkerTooltip.tsx'
import type { MarkerHoverInfo } from './TvChart.tsx'
import { createMarkerStateStore } from './marker-state.ts'
import { isAnnouncementSource } from './news-source.ts'
import type { ChartSignalMarkerInput, ChartKnowledgeMarkerInput } from './TvChart.tsx'
import css from './quote-stage.module.css'

const INTERVAL_KEY_PREFIX = 'dshtrading.interval.'
const ORDERBOOK_OPEN_KEY = 'dshtrading.orderbook.open'
const TRADE_DESK_OPEN_KEY = 'dshtrading.tradeDesk.open'
const TICKER_POLL_MS = 5000
const KLINE_RESYNC_MS = 30000
// 衍生品指标快照轮询（issue #38）：一次刷新 = 2~5 个上游公共端点调用，取 30s
// 对齐 K 线 resync 节奏，避免放大限频消耗（funding 8h 才变，OI 30s 粒度够看）。
const DERIVATIVES_POLL_MS = 30000
// 衍生品历史序列（issue #54，页签趋势卡）：8h 一期的费率与 1D OI 变化极慢，
// 5min 节奏足够；仅页签激活时拉取，省上游配额。
const DERIVATIVES_HISTORY_POLL_MS = 300000
// 盘口/分笔轮询（issue #39）：竖栏打开才拉；一次刷新 = depth + trades 两请求，
// 4s 在「盯盘时效」与公共端点限频之间取衡。
const ORDERBOOK_POLL_MS = 4000
// 交易台只读轮询（issue #40）：15s 慢节奏（签名端点 + 个人账户面，无盯盘时效要求）。
const TRADE_DESK_POLL_MS = 15000
// 盘中周期 K 线根数按市场区分：crypto 取 300——OKX 单请求上限 300，图表每 30s
// resync 一次，不触发游标翻页、不放大限频消耗；其余市场取 500。日 K 深度需求由
// 1d 分支单独走 DAILY_LIMIT。
const KLINE_LIMIT_DEFAULT = 500
const KLINE_LIMIT_BY_MARKET: Partial<Record<MarketId, number>> = { crypto: 300 }
const klineLimit = (market: MarketId): number => KLINE_LIMIT_BY_MARKET[market] ?? KLINE_LIMIT_DEFAULT
// 日 K（头部参考 + 日线图表）：750 根 ≈ 三年交易日；OKX 超出单请求 300 的部分由连接器 after 游标翻页补足。
const DAILY_LIMIT = 750

const INTERVAL_KEY: Record<string, MarketLocaleKey> = {
  '1m': 'interval.1m',
  '3m': 'interval.3m',
  '5m': 'interval.5m',
  '10m': 'interval.10m',
  '15m': 'interval.15m',
  '30m': 'interval.30m',
  '1h': 'interval.1h',
  '4h': 'interval.4h',
  '1d': 'interval.1d',
  '1w': 'interval.1w',
  '1M': 'interval.1M',
}

export type Translate = (key: MarketLocaleKey, params?: Record<string, unknown>) => string

export type UseStoreState<TState> = <TSelected>(selector: (state: TState) => TSelected) => TSelected

export interface QuoteStageProps {
  t: Translate
  useSelection: UseStoreState<SelectionState>
  useChart: UseStoreState<ChartState>
  toggleIndicator: (id: string) => void
  setIndicatorParams: (id: string, params: Record<string, number>) => void
  /** 删除自定义指标（issue #30 删除入口；仅自定义行渲染按钮）。 */
  deleteIndicator: (id: string) => Promise<boolean>
  /** 行情上下文 → 会话输入框（只填入不发送；shell 注入，缺席时按钮不渲染）。 */
  fillComposer?: (text: string, image?: SendImageInput) => Promise<void>
}

function inferMarketFromSymbol(symbol?: string): MarketId | undefined {
  if (!symbol) return undefined
  const sym = symbol.toUpperCase()
  if (sym.endsWith('.SH') || sym.endsWith('.SZ') || /^\d{6}$/.test(sym)) return 'cn'
  if (sym.endsWith('.HK') || /^\d{5}$/.test(sym)) return 'hk'
  if (sym.includes('USDT') || sym.includes('BTC') || sym.includes('ETH')) return 'crypto'
  return 'us'
}

type SendState = 'idle' | 'sending' | 'sent' | 'error'

/** 信号 reason 的币种符号（按市场；crypto 以 USD 计价近似）。 */
const CURRENCY_SYMBOL: Record<MarketId, string> = { cn: '¥', hk: 'HK$', us: '$', crypto: '$' }

export function QuoteStage({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, deleteIndicator, fillComposer }: QuoteStageProps) {
  const instrument = useSelection(value => value.instrument)
  const market: MarketId | undefined = (instrument?.market && ['crypto', 'us', 'cn', 'hk'].includes(instrument.market))
    ? (instrument.market as MarketId)
    : inferMarketFromSymbol(instrument?.symbol)
  const symbol = instrument?.symbol
  const activeMarket: MarketId = market ?? 'crypto'

  const colorMode = useSyncExternalStore(colorModeStore.subscribe, colorModeStore.getSnapshot)
  // 数值紧凑单位 locale（亿/万 vs K/M/B）：词典哨兵键判定，随语言切换响应。
  const numLocale = scaleLocaleOf(t)

  const instances = useChart(state => state.instances)
  // 指标名册修订号：插件晚于首帧合并 definition 时触发重渲染。
  const rosterVersion = useSyncExternalStore(indicators.subscribe, indicators.getVersion)

  const [chartInterval, setIntervalFor] = useState<string>(() => {
    if (market === undefined) return '1d'
    return readInterval(market)
  })
  const [daily, setDaily] = useState<Kline[] | null>(null)
  const [klines, setKlines] = useState<Kline[] | null>(null)
  const [kError, setKError] = useState<string | null>(null)
  const [ticker, setTicker] = useState<Ticker | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [editingIndicator, setEditingIndicator] = useState<string | null>(null)
  const [sendState, setSendState] = useState<SendState>('idle')
  /** 行情板块页签（图表 | 基本面 | 新闻 | 公告）：跨标的保持。 */
  const [stageTab, setStageTab] = useState<'chart' | 'derivatives' | 'fundamentals' | 'news' | 'announcements'>('chart')
  // 渲染期页签归一（issue #54 评审 L3）：衍生品页签是 crypto 专属，切到非 crypto
  // 市场时渲染直接按图表页签处理——不等 useEffect 纠偏（paint 后才跑会闪一帧公告）。
  const viewTab = stageTab === 'derivatives' && market !== 'crypto' ? 'chart' : stageTab
  /** 衍生品指标快照（issue #38，crypto 专属；null = 未实现/失败 → 面板整体隐藏）。 */
  const [derivatives, setDerivatives] = useState<DerivativesData | null>(null)
  /** 衍生品历史序列（issue #54；页签激活才拉；null = 未实现/失败 → 趋势卡隐藏）。 */
  const [derivativesHistory, setDerivativesHistory] = useState<DerivativesHistory | null>(null)
  /** 历史首个应答是否已落地（区分「加载中」与「不可用」，评审 L2）。 */
  const [derivativesHistoryLoaded, setDerivativesHistoryLoaded] = useState(false)
  /** 盘口竖栏（issue #39）：开关跨标的/会话记忆；数据 null = 数据源未提供（降级提示）。 */
  const [orderbookOpen, setOrderbookOpen] = useState<boolean>(() => readOrderbookOpen())
  const [orderbook, setOrderbook] = useState<Orderbook | null>(null)
  const [orderbookLoading, setOrderbookLoading] = useState(false)
  const [trades, setTrades] = useState<TradeTick[] | null>(null)
  /** 交易工作台（issue #40）：默认关（安全敏感面）；只读数据 null = 服务未挂载/凭证缺失。 */
  const [tradeDeskOpen, setTradeDeskOpen] = useState<boolean>(() => readTradeDeskOpen())
  /** 底部全宽资产与委托抽屉：默认折叠状态栏，支持展开与切换 Tabs。 */
  const [tradeDrawerOpen, setTradeDrawerOpen] = useState<boolean>(false)
  const [tradePositions, setTradePositions] = useState<Position[] | null>(null)
  const [tradeBalances, setTradeBalances] = useState<AccountBalance[] | null>(null)
  const [tradeOrders, setTradeOrders] = useState<Order[] | null>(null)
  const [tradeFills, setTradeFills] = useState<TradeFill[] | null>(null)
  /** 区间统计：框选模式开 + 已选逻辑下标区间（TvChart 上报，面板消费）。 */
  const [rangeMode, setRangeMode] = useState(false)
  const [rangeSelection, setRangeSelection] = useState<{ start: number; end: number } | null>(null)
  /** TvChart 注册的截图回调（图表未渲染/已卸载 = null）。 */
  const captureRef = useRef<(() => TvChartCapture | null) | null>(null)

  // ── 新闻与公告（issue #37）────────────────────────────────────
  const [newsItems, setNewsItems] = useState<ClientNewsItem[] | null>(null)
  const [newsUnavailable, setNewsUnavailable] = useState<string[]>([])

  // ── K 线标记（issue #41）──────────────────────────────────────
  const [markerStore] = useState(() => createMarkerStateStore())
  const markerState = useSyncExternalStore(markerStore.subscribe, markerStore.getSnapshot)
  const [markerHover, setMarkerHover] = useState<MarkerHoverInfo | null>(null)

  const [clock, setClock] = useState(() => formatStatusBarClock(Date.now()))
  const [indexTickers, setIndexTickers] = useState<Record<string, Ticker>>({})

  // 状态栏秒级时钟
  useEffect(() => {
    const timer = setInterval(() => { setClock(formatStatusBarClock(Date.now())) }, 1000)
    return () => clearInterval(timer)
  }, [])

  // 市场时段状态（随秒钟与激活市场自动刷新）
  const sessionStatus = useMemo(() => {
    return getMarketSessionStatus(activeMarket, Date.now())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMarket, clock])

  const indexDefs = MARKET_INDICES[activeMarket] ?? []

  // 底部大盘指数轮询：按当前激活市场拉取对应核心指数
  usePoll(async () => {
    if (indexDefs.length === 0) return
    try {
      const symbols = indexDefs.map(def => def.symbol)
      const outcome = await fetchTickers(activeMarket, symbols)
      const next: Record<string, Ticker> = {}
      for (const sym of symbols) {
        const res = outcome[sym]
        if (res?.ok) next[sym] = res.ticker
      }
      setIndexTickers(next)
    } catch {
      /* 下轮重试 */
    }
  }, TICKER_POLL_MS, [activeMarket])

  // 周期记忆（每市场独立）；切标的时读该市场的上次周期。
  useEffect(() => {
    if (market !== undefined) setIntervalFor(readInterval(market))
  }, [market])

  // K线取数 = poll：挂载/换标的/换周期立即触发，此后 30s resync。
  const requestRef = useRef('')
  usePoll(async () => {
    if (!market || !symbol) return
    const request = `${market}:${symbol}:${chartInterval}`
    requestRef.current = request
    try {
      const rows = await fetchKlines(market, symbol, chartInterval, chartInterval === '1d' ? DAILY_LIMIT : klineLimit(market))
      if (requestRef.current !== request) return
      setKlines(rows)
      setKError(null)
    } catch (error) {
      if (requestRef.current !== request) return
      setKError(String((error as { message?: string })?.message ?? error))
    }
  }, KLINE_RESYNC_MS, [market, symbol, chartInterval])

  // 日K参考（头部涨跌/昨收）：每标的只拉一次。
  useEffect(() => {
    if (!market || !symbol) return
    let cancelled = false
    fetchKlines(market, symbol, '1d', DAILY_LIMIT)
      .then((rows) => { if (!cancelled) setDaily(rows) })
      .catch(() => { /* 头部统计缺省 */ })
    return () => { cancelled = true }
  }, [market, symbol])

  // 衍生品指标轮询（issue #38，仅 crypto；现货输入由连接器升到对应永续）。
  // 竞态守卫（issue #54 评审 M3）：换标的后在途响应丢弃，不覆盖新标的 state。
  const derivativesRequestRef = useRef('')
  usePoll(async () => {
    if (market !== 'crypto' || symbol === undefined) return
    const request = `${market}:${symbol}`
    derivativesRequestRef.current = request
    const data = await fetchDerivatives(market, symbol)
    if (derivativesRequestRef.current !== request) return
    setDerivatives(data)
  }, DERIVATIVES_POLL_MS, [market, symbol])

  // 衍生品历史序列轮询（issue #54，仅 crypto + 衍生品页签激活）。
  // 竞态守卫同款：5min 周期下旧标的慢响应可挂很久，必须丢弃（评审 M3）。
  const derivativesHistoryRequestRef = useRef('')
  usePoll(async () => {
    if (stageTab !== 'derivatives' || market !== 'crypto' || symbol === undefined) return
    const request = `${market}:${symbol}`
    derivativesHistoryRequestRef.current = request
    const history = await fetchDerivativesHistory(market, symbol)
    if (derivativesHistoryRequestRef.current !== request) return
    setDerivativesHistory(history)
    // L2：首个应答落地（无论成败）即离开「加载中」，null 从此可读作「不可用」。
    setDerivativesHistoryLoaded(true)
  }, DERIVATIVES_HISTORY_POLL_MS, [stageTab, market, symbol])

  // 盘口/分笔轮询（issue #39）：竖栏打开 + 图表页签时才拉，省上游配额。
  usePoll(async () => {
    if (!orderbookOpen || stageTab !== 'chart' || market === undefined || symbol === undefined) return
    setOrderbookLoading(true)
    try {
      const [book, recentTrades] = await Promise.all([
        fetchOrderbook(market, symbol),
        fetchRecentTrades(market, symbol, 50),
      ])
      setOrderbook(book)
      setTrades(recentTrades)
    } finally {
      setOrderbookLoading(false)
    }
  }, ORDERBOOK_POLL_MS, [orderbookOpen, stageTab, market, symbol])

  // 交易台只读轮询（issue #40，面板打开时）：positions 为主探针——
  // 服务未注册（400）或凭证缺失（ok:false）都置 null，分区按语义降级。
  const refreshTradeDesk = async (m: MarketId = activeMarket) => {
    const [positionRows, balanceRows, orderRows, fillRows] = await Promise.all([
      fetchTradePositions(m),
      fetchTradeBalances(m),
      fetchTradeOpenOrders(m),
      fetchTradeFills(m),
    ])
    setTradePositions(positionRows)
    setTradeBalances(balanceRows)
    setTradeOrders(orderRows)
    setTradeFills(fillRows)
  }

  usePoll(async () => {
    if (stageTab !== 'chart') return
    await refreshTradeDesk(activeMarket)
  }, TRADE_DESK_POLL_MS, [stageTab, activeMarket])

  const onSubmitGuiOrder = (input: Parameters<typeof placeGuiOrder>[1]) =>
    placeGuiOrder(activeMarket, input).then((res) => {
      // 下单成功（真交易）→ 自动展开底栏看最新委托，并立即刷新账户面。
      if (res.order) {
        setTradeDrawerOpen(true)
        void refreshTradeDesk(activeMarket)
      }
      return res
    })

  // 衍生品页签是 crypto 专属：切到非 crypto 市场时自动回图表页签（issue #54）。
  useEffect(() => {
    if (stageTab === 'derivatives' && market !== 'crypto') setStageTab('chart')
  }, [stageTab, market])

  // 「分析资金面」（issue #54）：把衍生品快照上下文填进会话输入框（只填不发）。
  // 骨架走词典（derivatives.analyzeBody + 各行标签键）；行值为纯数字/代码，无文案。
  const onAnalyzeDerivatives = (): void => {
    if (fillComposer === undefined || derivatives === null || symbol === undefined) return
    const d = derivatives
    const parts = [
      d.openInterest !== undefined
        ? `- ${t('derivatives.oi')} ${fmtCompact(d.openInterest, numLocale)}${d.openInterestValue !== undefined ? ` (${fmtCompact(d.openInterestValue, numLocale)} USD)` : ''}`
        : undefined,
      d.fundingRate !== undefined
        ? `- ${t('derivatives.funding')} ${fmtFundingRate(d.fundingRate)}${d.nextFundingRate !== undefined ? ` (${t('derivatives.predicted')} ${fmtFundingRate(d.nextFundingRate)})` : ''}`
        : undefined,
      d.longShortRatio !== undefined ? `- ${t('derivatives.longShort')} ${d.longShortRatio.toFixed(2)}` : undefined,
      d.topTraderLongShortRatio !== undefined ? `- ${t('derivatives.topLongShort')} ${d.topTraderLongShortRatio.toFixed(2)}` : undefined,
      d.takerBuySellRatio !== undefined ? `- ${t('derivatives.taker')} ${d.takerBuySellRatio.toFixed(2)}` : undefined,
      d.markPrice !== undefined && d.indexPrice !== undefined && d.indexPrice > 0
        ? `- ${t('derivatives.basis')} ${fmtPercent((d.markPrice - d.indexPrice) / d.indexPrice * 100)} (${t('derivatives.markPrice')} ${fmtPrice(d.markPrice)} / ${t('derivatives.indexPrice')} ${fmtPrice(d.indexPrice)})`
        : undefined,
    ].filter((line): line is string => line !== undefined)
    const body = t('derivatives.analyzeBody', { symbol: d.symbol, source: d.source, lines: parts.join('\n') })
    void fillComposer(body)
  }

  const onCancelGuiOrder = async (orderId: string, sym?: string): Promise<boolean> => {
    const ok = await cancelGuiOrder(activeMarket, orderId, sym)
    if (ok) {
      void refreshTradeDesk(activeMarket)
    }
    return ok
  }

  // 换标的：立即清场
  useEffect(() => {
    setKlines(null)
    setDaily(null)
    setTicker(null)
    setHoverIndex(null)
    setKError(null)
    setDerivatives(null)
    setDerivativesHistory(null)
    setDerivativesHistoryLoaded(false)
    setOrderbook(null)
    setTrades(null)
    setNewsItems(null)
    setNewsUnavailable([])
    setMarkerHover(null)
  }, [market, symbol])

  // ticker 轮询：头部价格 + 尾随合并最后一根 K 线
  usePoll(async () => {
    if (market === undefined || symbol === undefined) return
    try {
      const outcome = await fetchTickers(market, [symbol])
      const result = outcome[symbol]
      if (result?.ok) {
        setTicker(result.ticker)
        setKlines(prev => prev === null ? prev : withTickerBar(prev, result.ticker))
      }
    } catch { /* 下轮再试 */ }
  }, TICKER_POLL_MS, [market, symbol])

  // 新闻情报流轮询（issue #37）：处于 news/announcements 或开启事件图钉时 60s 轮询；symbol/market 变化时立即重拉。
  const NEWS_POLL_MS = 60000
  const newsRequestRef = useRef('')
  usePoll(async () => {
    if ((stageTab !== 'news' && stageTab !== 'announcements' && !markerState.showKnowledgeEvents) || market === undefined || symbol === undefined) return
    const request = `${market}:${symbol}`
    newsRequestRef.current = request
    try {
      const result = await fetchNews(market, symbol, 50)
      // 竞态守卫：慢响应回来时已切标的 → 丢弃，旧新闻不得覆盖新标的（对齐 klines poll 的 requestRef 模式）。
      if (newsRequestRef.current !== request) return
      if (result !== null) {
        setNewsItems(result.items)
        setNewsUnavailable(result.unavailable)
      }
    } catch { /* 下轮重试 */ }
  }, NEWS_POLL_MS, [market, symbol, stageTab, markerState.showKnowledgeEvents])

  const stats = useMemo(() => {
    const last = daily !== null && daily.length > 0 ? daily[daily.length - 1] : undefined
    const klinePrevClose = daily !== null && daily.length >= 2 ? daily[daily.length - 2]?.close : undefined
    // 昨收/涨跌优先用快照官方锚点（ticker.prevClose/changePercent）：
    // 日 K 序列可能缺最新收盘 bar（Yahoo 补齐滞后，见 connector-yahoo），倒数第二根
    // 会错位一个交易日（2026-09-01 AAPL 实证：显示 314.58 而非 319.70）。
    const prevClose = ticker?.prevClose ?? klinePrevClose
    const price = ticker?.price ?? klines?.[klines.length - 1]?.close
    const change = price !== undefined && prevClose !== undefined ? price - prevClose : undefined
    const pct = ticker?.changePercent ?? changePercent(price, prevClose)
    return { last, prevClose, price, change, pct }
  }, [daily, ticker, klines])

  // 区间统计：框选模式 ESC 退出（连同清空选区）。
  useEffect(() => {
    if (!rangeMode) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setRangeMode(false)
      setRangeSelection(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rangeMode])

  const rangeStats = useMemo(
    () => (rangeSelection !== null && klines !== null ? computeRangeStats(klines, rangeSelection.start, rangeSelection.end) : null),
    [rangeSelection, klines],
  )

  // 指标调度：klines × 激活实例 → 渲染输入
  const indicatorGroups = useMemo(() => {
    if (klines === null) return []
    const groups: Array<TvIndicatorGroup & { id: string; pane: 'main' | 'sub'; title: string }> = []
    for (const instance of instances) {
      const definition = indicators.get(instance.id)
      if (definition === undefined) continue
      groups.push({
        id: instance.id,
        title: definition.title,
        pane: definition.pane,
        key: indicators.instanceKey(instance),
        outputs: definition.compute(klines, instance.params),
      })
    }
    return groups
  }, [klines, instances, rosterVersion])

  const mainOverlays = useMemo(() => indicatorGroups.filter(group => group.pane === 'main'), [indicatorGroups])
  const subIndicators = useMemo(() => indicatorGroups.filter(group => group.pane === 'sub'), [indicatorGroups])

  const bars = useMemo(() => klines?.map(toBar) ?? [], [klines])
  const volumes = useMemo(() => klines?.map(k => toVolume(k, colorMode)) ?? [], [klines, colorMode])

  const readoutIndex = hoverIndex ?? (klines !== null && klines.length > 0 ? klines.length - 1 : null)
  const readoutCandle = klines !== null && readoutIndex !== null ? klines[readoutIndex] : undefined
  // 读数行昨收跟随十字光标：悬停历史K线取当前周期序列的前一根收盘价（日K下即该日
  // 昨收）；未悬停或悬停最新一根沿用官方锚点 ticker.prevClose（日K补齐滞后时序列
  // 倒数第二根会错位一个交易日，见上方 stats 注释）；序列首根无前一根则留空。
  const readoutPrevClose = klines === null || readoutIndex === null
    ? stats.prevClose
    : readoutIndex <= 0
      ? undefined
      : readoutIndex >= klines.length - 1
        ? stats.prevClose
        : klines[readoutIndex - 1]?.close

  // 所有可用指标（供底部词条栏横向快捷展示）
  const allDefinitions = useMemo(() => indicators.list(), [rosterVersion])

  // 策略信号标记数据（issue #41）：在当前 K 线序列上实时计算 EMA(12, 26) 交叉信号（过滤预热期与边缘噪音）。
  const signalMarkers = useMemo<readonly ChartSignalMarkerInput[] | undefined>(() => {
    if (!bars || bars.length < 30) return undefined
    const cur = CURRENCY_SYMBOL[activeMarket]
    const k12 = 2 / (12 + 1)
    const k26 = 2 / (26 + 1)
    let ema12 = bars[0]?.close ?? 0
    let ema26 = bars[0]?.close ?? 0
    const signals: ChartSignalMarkerInput[] = []
    let prevDiff: number | null = null

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]
      if (!bar) continue
      ema12 = bar.close * k12 + ema12 * (1 - k12)
      ema26 = bar.close * k26 + ema26 * (1 - k26)
      const diff = ema12 - ema26
      if (i >= 26 && prevDiff !== null) {
        if (prevDiff <= 0 && diff > 0) {
          signals.push({
            time: bar.time,
            action: 'entry',
            price: bar.close,
            reason: t('marker.signal.entryReason', { cur, price: bar.close.toFixed(2) }),
          })
        } else if (prevDiff >= 0 && diff < 0) {
          signals.push({
            time: bar.time,
            action: 'exit',
            price: bar.close,
            reason: t('marker.signal.exitReason', { cur, price: bar.close.toFixed(2) }),
          })
        }
      }
      prevDiff = diff
    }
    return signals.length > 0 ? signals : undefined
  }, [bars, t])

  // 知识事件标记数据（issue #41）：从当前标的的官方公告与知识事件中提取，按时间柱精准锚定（同 K 线柱去重聚合，避免边缘挤压）。
  const knowledgeMarkers = useMemo<readonly ChartKnowledgeMarkerInput[] | undefined>(() => {
    if (!newsItems || newsItems.length === 0 || !bars || bars.length === 0) return undefined
    // 仅针对属于该标的的官方公告/交易所公报打图钉，排除泛财经媒体与宏观回退要闻
    const announcements = newsItems.filter(it => isAnnouncementSource(it.source))
    if (announcements.length === 0) return undefined

    // 计算当前 K 线的平均周期步长（如日 K=86400s，周 K=604800s，月 K≈2592000s）
    const barStep = bars.length > 1 ? Math.abs((bars[bars.length - 1]?.time ?? 0) - (bars[0]?.time ?? 0)) / (bars.length - 1) : 86400
    const tolerance = Math.max(barStep * 0.8, 43200)
    const barMap = new Map<number, { title: string; count: number; url: string }>()

    for (const item of announcements) {
      const ts = Math.floor(new Date(item.publishedAt).getTime() / 1000)
      if (Number.isNaN(ts)) continue

      let bestBarTime: number | null = null
      let minDiff = Infinity
      for (const bar of bars) {
        const diff = Math.abs(bar.time - ts)
        if (diff < minDiff && diff <= tolerance) {
          minDiff = diff
          bestBarTime = bar.time
        }
      }

      if (bestBarTime !== null) {
        const existing = barMap.get(bestBarTime)
        if (existing) {
          existing.count += 1
        } else {
          barMap.set(bestBarTime, { title: item.title, count: 1, url: item.url })
        }
      }
    }

    const markers: ChartKnowledgeMarkerInput[] = []
    for (const [time, info] of barMap.entries()) {
      markers.push({
        time,
        title: info.count > 1 ? t('marker.knowledge.batched', { title: info.title, count: String(info.count) }) : info.title,
        cardId: info.url,
        credibility: 'high',
      })
    }
    return markers.length > 0 ? markers : undefined
  }, [newsItems, bars, t])

  // 发给 Agent：先截图（画布只在图表挂载期间可取），再把文本 + PNG 填入
  // 会话输入框（不自动发送——用户大概率还要补自己的 prompt）。
  // market/symbol 在函数体内收窄（闭包对 TS 不透传 narrowing），先落成常量。
  const onSendToAgent = (): void => {
    if (fillComposer === undefined || sendState === 'sending') return
    if (market === undefined || symbol === undefined) return
    const activeMarket: MarketId = market
    const activeSymbol: string = symbol
    const capture = captureRef.current?.() ?? null
    const input = {
      name: instrument?.name,
      symbol: activeSymbol,
      marketLabel: t(TAB_KEY[activeMarket]),
      intervalLabel: t(INTERVAL_KEY[chartInterval] ?? 'interval.1d'),
      price: stats.price,
      change: stats.change,
      pct: stats.pct,
      prevClose: stats.prevClose,
      candle: readoutCandle,
      indicatorTitles: instances.map(instance => indicators.get(instance.id)?.title ?? instance.id),
      withScreenshot: capture !== null,
    }
    // exactOptionalPropertyTypes：undefined 字段直接剔除而非显式传 undefined。
    // deltaWrap 用 '|' 作分隔哨兵拆包裹符对（词典值单字符串无法表达成对括号）。
    const [deltaOpen = '(', deltaClose = ')'] = t('compose.deltaWrap').split('|')
    const copy: QuoteMessageCopy = {
      opener: t('compose.opener'),
      prevClose: t('compose.prevClose'),
      priceLine: t('compose.priceLine'),
      candleLine: t('compose.candleLine'),
      indicatorsLine: t('compose.indicatorsLine'),
      listSeparator: t('compose.listSeparator'),
      deltaWrap: [deltaOpen, deltaClose],
      prevSep: t('compose.prevSep'),
      volumeLocale: numLocale,
      withScreenshotTail: t('compose.withScreenshot'),
      withoutScreenshotTail: t('compose.withoutScreenshot'),
    }
    const text = composeQuoteMessage(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as unknown as Parameters<typeof composeQuoteMessage>[0], copy)
    setSendState('sending')
    void fillComposer(text, capture === null ? undefined : {
      dataUrl: capture.dataUrl,
      name: `${activeSymbol}-${chartInterval}.png`,
      width: capture.width,
      height: capture.height,
    })
      .then(() => {
        setSendState('sent')
        window.setTimeout(() => { setSendState('idle') }, 2000)
      })
      .catch((error: unknown) => {
        console.warn('[dsh-trading] fill composer from quote failed:', error)
        setSendState('error')
        window.setTimeout(() => { setSendState('idle') }, 2600)
      })
  }

  // 空态：未选择标的（空态之后的渲染路径依赖 market/symbol 非空，提前收窄）。
  if (market === undefined || symbol === undefined) {
    return (
      <div className={css.root}>
        <div className={css.empty}>
          <div className={css.emptyMain}>{t('quote.empty')}</div>
          <div>{t('quote.emptyHint')}</div>
        </div>
      </div>
    )
  }

  const intervals = MARKET_INTERVALS[market] ?? ['1d']
  const color = directionColor(stats.pct ?? 0, colorMode)

  const rawName = instrument?.name
  const isPlaceholderName = !rawName || rawName === symbol || /\(A股\)|\(港股\)/.test(rawName) // i18n-allow: 数据源占位名匹配谓词（"xx (A股)"），非 UI 文案
  const tickerName = (ticker as { name?: string })?.name
  const displayName = (!isPlaceholderName ? rawName : (tickerName || rawName || symbol))

  return (
    <div className={css.root} data-dshtrading-quote-stage="">
      {/* 顶部报价头与二级 Sub-Tab 导航（图表 | 基本面） */}
      <div className={css.header}>
        <div className={css.ident}>
          <span className={css.name}>{displayName}</span>
          <span className={css.code}>{symbol}</span>
          <span className={css.marketTag}>{t(TAB_KEY[market])}</span>
        </div>
        <span className={css.price} style={{ color }}>{fmtPrice(stats.price)}</span>
        <span className={css.changes} style={{ color }}>
          <span>{fmtChange(stats.change)}</span>
          <span>{fmtPercent(stats.pct)}</span>
        </span>
        {/* 行情板块页签：图表 | 基本面 | 新闻 | 公告（富途牛牛式，页签随报价头同行） */}
        <div className={css.stageTabs} role="tablist" aria-label="quote section">
          <button
            type="button"
            role="tab"
            aria-selected={stageTab === 'chart'}
            className={css.stageTab}
            data-active={stageTab === 'chart' ? 'true' : undefined}
            onClick={() => { setStageTab('chart') }}
          >
            {t('quote.tab.chart')}
          </button>
          {market === 'crypto' && (
            <button
              type="button"
              role="tab"
              aria-selected={stageTab === 'derivatives'}
              className={css.stageTab}
              data-active={stageTab === 'derivatives' ? 'true' : undefined}
              onClick={() => { setStageTab('derivatives') }}
            >
              {t('quote.tab.derivatives')}
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={stageTab === 'fundamentals'}
            className={css.stageTab}
            data-active={stageTab === 'fundamentals' ? 'true' : undefined}
            onClick={() => { setStageTab('fundamentals') }}
          >
            {t('quote.tab.fundamentals')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={stageTab === 'news'}
            className={css.stageTab}
            data-active={stageTab === 'news' ? 'true' : undefined}
            onClick={() => { setStageTab('news') }}
          >
            {t('quote.tab.news')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={stageTab === 'announcements'}
            className={css.stageTab}
            data-active={stageTab === 'announcements' ? 'true' : undefined}
            onClick={() => { setStageTab('announcements') }}
          >
            {t('quote.tab.announcements')}
          </button>
        </div>
        <span className={css.meta}>
          {ticker !== null && <span>{t('quote.updated')} {fmtClock(ticker.timestamp)}</span>}
        </span>
      </div>

      {/* 统计行情概览（图表页签专属：基本面页签有自己的信息网格） */}
      {viewTab === 'chart' && (
        <div className={css.stats}>
          <span className={css.stat}><label>{t('quote.prevClose')}</label>{fmtPrice(readoutPrevClose)}</span>
          <span className={css.stat}><label>{t('quote.open')}</label>{fmtPrice(readoutCandle?.open)}</span>
          <span className={css.stat}><label>{t('quote.high')}</label>{fmtPrice(readoutCandle?.high)}</span>
          <span className={css.stat}><label>{t('quote.low')}</label>{fmtPrice(readoutCandle?.low)}</span>
          <span className={css.stat}><label>{t('quote.volume')}</label>{fmtCompact(readoutCandle?.volume, numLocale)}</span>
          {market === 'crypto' && derivatives !== null && (
            <DerivativesPane
              t={t}
              derivatives={derivatives}
              colorMode={colorMode}
              onOpenStage={() => { setStageTab('derivatives') }}
              {...(fillComposer !== undefined ? { onAnalyze: onAnalyzeDerivatives } : {})}
            />
          )}
        </div>
      )}

      {/* 周期胶囊条 + 指标弹层按钮（图表页签） */}
      {viewTab === 'chart' && (
        <div className={css.toolbar}>
          <div className={css.intervalTabs} role="tablist" aria-label="interval">
            {intervals.map(entry => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={entry === chartInterval}
                className={css.intervalTab}
                data-active={entry === chartInterval ? 'true' : undefined}
                onClick={() => {
                  setIntervalFor(entry)
                  writeInterval(market, entry)
                }}
              >
                {t(INTERVAL_KEY[entry] ?? 'interval.1d')}
              </button>
            ))}
          </div>

        <div className={css.toolbarActions}>
          {fillComposer !== undefined && (
            <button
              type="button"
              className={css.sendButton}
              data-state={sendState === 'idle' ? undefined : sendState}
              disabled={sendState === 'sending'}
              title={t('quote.sendToAgentHint')}
              onClick={onSendToAgent}
            >
              <IconSend size={13} />
              {sendState === 'sent'
                ? t('quote.sendSent')
                : sendState === 'error'
                  ? t('quote.sendFailed')
                  : sendState === 'sending'
                    ? t('quote.sendSending')
                    : t('quote.sendToAgent')}
            </button>
          )}
          {/* 交易工作台开关（issue #40；支持接入了交易注册面的各市场） */}
          <button
            type="button"
            className={css.pickerButton}
            data-active={tradeDeskOpen ? 'true' : undefined}
            aria-pressed={tradeDeskOpen}
            onClick={() => {
              setTradeDeskOpen((open) => {
                writeTradeDeskOpen(!open)
                return !open
              })
            }}
          >
            {t('trade.toggle')}
          </button>
          {/* 盘口竖栏开关（issue #39；紧挨区间统计左侧） */}
          <button
            type="button"
            className={css.pickerButton}
            data-active={orderbookOpen ? 'true' : undefined}
            aria-pressed={orderbookOpen}
            onClick={() => {
              setOrderbookOpen((open) => {
                writeOrderbookOpen(!open)
                return !open
              })
            }}
          >
            {t('orderbook.toggle')}
          </button>
          {/* 策略信号标记开关（issue #41） */}
          <button
            type="button"
            className={css.pickerButton}
            data-active={markerState.showSignals ? 'true' : undefined}
            aria-pressed={markerState.showSignals}
            title={t('marker.signal.toggleTitle')}
            onClick={() => markerStore.toggleSignals()}
          >
            {t('marker.signal.toggle')}
          </button>
          {/* 知识事件图钉开关（issue #41） */}
          <button
            type="button"
            className={css.pickerButton}
            data-active={markerState.showKnowledgeEvents ? 'true' : undefined}
            aria-pressed={markerState.showKnowledgeEvents}
            title={t('marker.knowledge.toggleTitle')}
            onClick={() => markerStore.toggleKnowledgeEvents()}
          >
            {t('marker.knowledge.toggle')}
          </button>
          {/* 区间统计（同花顺式框选统计；紧挨「技术指标」按钮左侧） */}
            <button
              type="button"
              className={css.pickerButton}
              data-active={rangeMode ? 'true' : undefined}
              aria-pressed={rangeMode}
              title={t('quote.rangeStatsHint')}
              onClick={() => {
                setRangeMode((open) => {
                  if (open) setRangeSelection(null)
                  return !open
                })
              }}
            >
              {t('quote.rangeStats')}
            </button>
            <div className={css.indicatorAnchor}>
              <button
                type="button"
                className={css.pickerButton}
                aria-expanded={pickerOpen}
                aria-haspopup="dialog"
                onClick={() => { setPickerOpen(open => !open) }}
              >
                <IconIndicators size={13} />
                {t('indicator.picker')}
              </button>
              {pickerOpen && (
                <IndicatorPicker
                  t={t}
                  instances={instances}
                  editingIndicator={editingIndicator}
                  onToggle={(id) => {
                    toggleIndicator(id)
                    setEditingIndicator(null)
                  }}
                  onEdit={(id) => { setEditingIndicator(current => current === id ? null : id) }}
                  onApply={(id, params) => {
                    setIndicatorParams(id, params)
                    setEditingIndicator(null)
                  }}
                  onDelete={(id) => { void deleteIndicator(id) }}
                  onClose={() => {
                    setPickerOpen(false)
                    setEditingIndicator(null)
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* 主图指标悬停/最新读数分量（各分量独立着色）。VOL/MACD 等副图指标
          的读数在 TvChart 各自 pane 内渲染，不进主图读数行。 */}
      {viewTab === 'chart' && mainOverlays.length > 0 && (
        <div className={css.indicatorReadout}>
          {mainOverlays.flatMap(group => outputReadouts(group, readoutIndex))}
        </div>
      )}

      {viewTab === 'chart' && kError !== null && <div className={css.error}>{t('quote.loadFailedColon', { error: kError })}</div>}

      {/* 图表主舞台 / 基本面页签（互斥挂载）；crypto 图表下方挂衍生品指标条（issue #38），
          右侧可折叠盘口竖栏（issue #39） */}
      {viewTab === 'chart' ? (
        <div className={css.chartRow}>
          <div className={css.chartColumn}>
            <div className={css.chartBox}>
            {klines !== null && bars.length > 0 && (
              <TvChart
                bars={bars}
                volumes={volumes}
                dataKey={`${market}:${symbol}:${chartInterval}`}
                intraday={INTRADAY_INTERVALS.has(chartInterval)}
                colorMode={colorMode}
                mainOverlays={mainOverlays}
                subIndicators={subIndicators}
                readoutIndex={readoutIndex}
                onHoverIndex={setHoverIndex}
                onCaptureReady={(capture) => { captureRef.current = capture }}
                rangeSelectionMode={rangeMode}
                selection={rangeSelection}
                onRangeSelect={setRangeSelection}
                signalMarkers={markerState.showSignals ? signalMarkers : undefined}
                knowledgeMarkers={markerState.showKnowledgeEvents ? knowledgeMarkers : undefined}
                onMarkerHover={setMarkerHover}
                markerTexts={{ entry: t('trade.buy'), exit: t('trade.sell') }}
                numLocale={numLocale}
              />
            )}
            {rangeMode && rangeStats !== null && (
              <div className={css.rangePanel} role="dialog" aria-label={t('quote.rangeStats')}>
                <div className={css.rangePanelHead}>
                  <span>{t('quote.rangeStats')}</span>
                  <button
                    type="button"
                    className={css.rangePanelClose}
                    aria-label={t('range.closePanel')}
                    onClick={() => { setRangeSelection(null) }}
                  >
                    ×
                  </button>
                </div>
                <div className={css.rangePanelSpan}>
                  {fmtDay(rangeStats.startTime)} ~ {fmtDay(rangeStats.endTime)}
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.change')}</span>
                  <span style={{ color: directionColor(rangeStats.changePercent, colorMode) }}>
                    {fmtPercent(rangeStats.changePercent)}
                  </span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.changeAbs')}</span>
                  <span style={{ color: directionColor(rangeStats.change, colorMode) }}>
                    {fmtChange(rangeStats.change)}
                  </span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.high')}</span>
                  <span>{fmtPrice(rangeStats.rangeHigh)}</span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.low')}</span>
                  <span>{fmtPrice(rangeStats.rangeLow)}</span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.amplitude')}</span>
                  <span>{fmtPercent(rangeStats.amplitudePercent)}</span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.volume')}</span>
                  <span>{fmtCompact(rangeStats.volume, numLocale)}</span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.bars')}</span>
                  <span>{rangeStats.bars}</span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.upDays')}</span>
                  <span>{rangeStats.upBars}</span>
                </div>
                <div className={css.rangePanelRow}>
                  <span>{t('range.downDays')}</span>
                  <span>{rangeStats.downBars}</span>
                </div>
              </div>
            )}
            {/* 标记悬停 Tooltip：绝对定位在 chartBox（position:relative）内，
                坐标系与 TvChart 回报的容器坐标一致 */}
            {markerHover !== null && (
              <MarkerTooltip
                x={markerHover.x}
                y={markerHover.y}
                containerWidth={markerHover.containerWidth}
                containerHeight={markerHover.containerHeight}
                t={t}
                signal={markerHover.signal ? {
                  action: markerHover.signal.action,
                  price: markerHover.signal.price,
                  reason: markerHover.signal.reason,
                  time: markerHover.signal.time,
                } : undefined}
                knowledge={markerHover.knowledge ? {
                  title: markerHover.knowledge.title,
                  credibility: markerHover.knowledge.credibility,
                  cardId: markerHover.knowledge.cardId,
                } : undefined}
              />
            )}
            </div>
          </div>
          {(orderbookOpen || tradeDeskOpen) && (
            <div className={css.rightSidebar}>
              {orderbookOpen && (
                <OrderbookPane
                  t={t}
                  orderbook={orderbook}
                  trades={trades}
                  orderbookLoading={orderbookLoading}
                  colorMode={colorMode}
                  onClose={() => {
                    setOrderbookOpen(false)
                    writeOrderbookOpen(false)
                  }}
                />
              )}
              {tradeDeskOpen && (
                <OrderPanel
                  t={t}
                  symbol={symbol ?? ''}
                  market={activeMarket}
                  suggestedPrice={ticker?.price}
                  colorMode={colorMode}
                  onSubmit={onSubmitGuiOrder}
                  onClose={() => {
                    setTradeDeskOpen(false)
                    writeTradeDeskOpen(false)
                  }}
                />
              )}
            </div>
          )}
        </div>
      ) : viewTab === 'derivatives' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <DerivativesStage t={t} derivatives={derivatives} history={derivativesHistory} historyLoaded={derivativesHistoryLoaded} colorMode={colorMode} />
        </div>
      ) : viewTab === 'fundamentals' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <FundamentalsStage t={t} useSelection={useSelection} />
        </div>
      ) : viewTab === 'news' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <NewsFeedPane
            items={newsItems}
            unavailable={newsUnavailable}
            fullHeight
            filterType="media"
            t={t}
            fillComposer={fillComposer}
          />
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <NewsFeedPane
            items={newsItems}
            unavailable={newsUnavailable}
            fullHeight
            filterType="exchange"
            t={t}
            fillComposer={fillComposer}
          />
        </div>
      )}

      {/* 底部全宽资产与委托抽屉（图表页签专属，支持一键折叠展开） */}
      {viewTab === 'chart' && (
        <TradeDrawer
          t={t}
          positions={tradePositions}
          balances={tradeBalances}
          orders={tradeOrders}
          fills={tradeFills}
          colorMode={colorMode}
          isOpen={tradeDrawerOpen}
          onToggle={setTradeDrawerOpen}
          onCancelOrder={onCancelGuiOrder}
        />
      )}

      {/* 底部横向指标词条带（图表页签） */}
      {stageTab === 'chart' && (
        <div className={css.quickIndicatorBar} role="toolbar" aria-label="Quick indicators">
          {allDefinitions.map(def => {
            const active = instances.some(inst => inst.id === def.id)
            return (
              <button
                key={def.id}
                type="button"
                className={css.quickIndicatorTag}
                data-active={active ? 'true' : undefined}
                onClick={() => toggleIndicator(def.id)}
                title={`${def.title} (${def.pane === 'main' ? t('indicator.group.main') : t('indicator.group.sub')})`}
              >
                {def.title}
              </button>
            )
          })}
        </div>
      )}

      {/* 底部富途式市场状态栏 */}
      <div className={css.statusBar} role="status">
        <span className={css.statusSession}>
          <span className={css.statusDot} style={{ background: sessionStatus.color }} />
          {t(sessionStatus.statusKey)}
        </span>
        {indexDefs.map(def => {
          const indexTicker = indexTickers[def.symbol]
          const price = indexTicker?.price
          const prevClose = (indexTicker as { prevClose?: number })?.prevClose
          const pct = (indexTicker as { changePercent?: number })?.changePercent ?? changePercent(price, prevClose)
          const color = directionColor(pct ?? 0, colorMode)
          return (
            <span key={def.symbol} className={css.indexGroup}>
              <span className={css.indexName}>{t(def.nameKey)}</span>
              {price !== undefined ? (
                <span style={{ color, fontWeight: 600 }}>
                  {fmtPrice(price)} {fmtPercent(pct)}
                </span>
              ) : (
                <span style={{ color: 'var(--dsw-futu-text-muted, #8e95a3)' }}>—</span>
              )}
            </span>
          )
        })}
        <span className={css.statusClock}>{clock}</span>
      </div>
    </div>
  )
}

function IndicatorPicker(props: {
  t: Translate
  instances: IndicatorInstance[]
  editingIndicator: string | null
  onToggle: (id: string) => void
  onEdit: (id: string) => void
  onApply: (id: string, params: Record<string, number>) => void
  onDelete: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t, instances, editingIndicator, onToggle, onEdit, onApply, onDelete, onClose } = props
  const definitions = indicators.list()
  const empty = definitions.length === 0
  return (
    <>
      <div className={css.pickerBackdrop} onClick={onClose} aria-hidden="true" />
      <div className={css.pickerPanel} role="dialog" aria-label={t('indicator.picker')}>
        <div className={css.pickerTitle}>{t('indicator.picker')}</div>
        {empty ? (
          <div className={css.pickerGroupTitle}>{t('indicator.empty')}</div>
        ) : (
          <>
            <PickerGroup
              title={t('indicator.group.main')}
              definitions={definitions.filter(definition => definition.pane === 'main')}
              instances={instances}
              editingIndicator={editingIndicator}
              t={t}
              onToggle={onToggle}
              onEdit={onEdit}
              onApply={onApply}
              onDelete={onDelete}
            />
            <PickerGroup
              title={t('indicator.group.sub')}
              definitions={definitions.filter(definition => definition.pane === 'sub')}
              instances={instances}
              editingIndicator={editingIndicator}
              t={t}
              onToggle={onToggle}
              onEdit={onEdit}
              onApply={onApply}
              onDelete={onDelete}
            />
          </>
        )}
      </div>
    </>
  )
}

function PickerGroup(props: {
  title: string
  definitions: readonly IndicatorDefinition[]
  instances: readonly IndicatorInstance[]
  editingIndicator: string | null
  t: Translate
  onToggle: (id: string) => void
  onEdit: (id: string) => void
  onApply: (id: string, params: Record<string, number>) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const { title, definitions, instances, editingIndicator, t, onToggle, onEdit, onApply, onDelete } = props
  return (
    <div className={css.pickerGroup}>
      <div className={css.pickerGroupTitle}>{title}</div>
      {definitions.map(definition => {
        const instance = instances.find(candidate => candidate.id === definition.id) ?? null
        const editing = editingIndicator === definition.id
        return (
          <div key={definition.id} className={css.pickerRow}>
            <label className={css.pickerLabel}>
              <input
                type="checkbox"
                checked={instance !== null}
                onChange={() => onToggle(definition.id)}
              />
              <span>{definition.title}</span>
            </label>
            {instance !== null && (
              <button
                type="button"
                className={css.pickerParams}
                data-open={editing ? 'true' : undefined}
                onClick={() => onEdit(definition.id)}
              >
                {t('indicator.params')}
              </button>
            )}
            {isCustomIndicator(definition.id) && (
              <button
                type="button"
                className={css.pickerParams}
                title={t('indicator.delete')}
                aria-label={t('indicator.delete')}
                onClick={() => {
                  if (window.confirm(t('indicator.deleteConfirm'))) onDelete(definition.id)
                }}
              >
                {t('indicator.delete')}
              </button>
            )}
            {editing && instance !== null && (
              <IndicatorParamEditor
                definition={definition}
                initial={instance.params}
                t={t}
                onCancel={() => onEdit(definition.id)}
                onApply={(params) => onApply(definition.id, params)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function IndicatorParamEditor(props: {
  definition: IndicatorDefinition
  initial: Record<string, number>
  t: Translate
  onCancel: () => void
  onApply: (params: Record<string, number>) => void
}): React.JSX.Element {
  const { definition, initial, t } = props
  const [draft, setDraft] = useState<Record<string, number>>(() => {
    const out: Record<string, number> = {}
    for (const spec of definition.params) out[spec.key] = initial[spec.key] ?? spec.default
    return out
  })

  return (
    <div className={css.paramEditor}>
      {definition.params.map(spec => (
        <label key={spec.key} className={css.paramRow}>
          <span>{spec.label}</span>
          <input
            type="number"
            min={spec.min}
            max={spec.max}
            value={Number.isFinite(draft[spec.key]) ? draft[spec.key] : spec.default}
            onChange={(event) => {
              const next = Number(event.target.value)
              setDraft(prev => ({ ...prev, [spec.key]: Number.isFinite(next) ? next : spec.default }))
            }}
          />
        </label>
      ))}
      <div className={css.paramActions}>
        <button type="button" className={css.paramButton} onClick={props.onCancel}>{t('indicator.cancel')}</button>
        <button type="button" className={`${css.paramButton} ${css.paramApply}`} onClick={() => props.onApply(draft)}>{t('indicator.apply')}</button>
      </div>
    </div>
  )
}

function outputReadouts(
  group: TvIndicatorGroup & { id: string; pane: 'main' | 'sub'; title: string },
  readoutIndex: number | null,
): Array<React.JSX.Element | null> {
  if (readoutIndex === null) return []
  return group.outputs.map((output) => {
    const value = output.values[readoutIndex]
    if (value === undefined || !Number.isFinite(value)) return null
    return (
      <span key={`${group.key}.${output.key}`} style={{ color: output.color, fontWeight: 500 }}>
        {group.title} {output.key}: {value.toFixed(2)}
      </span>
    )
  })
}

function withTickerBar(prev: Kline[], ticker: Ticker): Kline[] {
  const last = prev[prev.length - 1]
  if (last === undefined) return prev
  const price = ticker.price
  if (!Number.isFinite(price) || price <= 0) return prev
  if (last.close === price && last.high >= price && last.low <= price) return prev
  const merged: Kline = {
    ...last,
    close: price,
    high: Math.max(last.high, price),
    low: Math.min(last.low, price),
  }
  return [...prev.slice(0, -1), merged]
}

function formatStatusBarClock(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** YYYY-MM-DD（区间统计面板的日期跨度）。 */
function fmtDay(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function readInterval(market: MarketId): string {
  try {
    const raw = localStorage.getItem(INTERVAL_KEY_PREFIX + market)
    if (raw !== null && (MARKET_INTERVALS[market] ?? []).includes(raw)) return raw
  } catch { /* 忽略 */ }
  return '1d'
}

function writeInterval(market: MarketId, interval: string): void {
  try {
    localStorage.setItem(INTERVAL_KEY_PREFIX + market, interval)
  } catch { /* 忽略 */ }
}

/** 盘口竖栏开关记忆（issue #39；跨会话，坏值/隐私模式回退默认开）。 */
function readOrderbookOpen(): boolean {
  try {
    return localStorage.getItem(ORDERBOOK_OPEN_KEY) !== '0'
  } catch { /* 忽略 */ }
  return true
}

function writeOrderbookOpen(open: boolean): void {
  try {
    localStorage.setItem(ORDERBOOK_OPEN_KEY, open ? '1' : '0')
  } catch { /* 忽略 */ }
}

/** 交易台开关记忆（issue #40；默认关——安全敏感面）。 */
function readTradeDeskOpen(): boolean {
  try {
    return localStorage.getItem(TRADE_DESK_OPEN_KEY) === '1'
  } catch { /* 忽略 */ }
  return false
}

function writeTradeDeskOpen(open: boolean): void {
  try {
    localStorage.setItem(TRADE_DESK_OPEN_KEY, open ? '1' : '0')
  } catch { /* 忽略 */ }
}

const TAB_KEY: Record<MarketId, MarketLocaleKey> = {
  crypto: 'tab.crypto',
  us: 'tab.us',
  cn: 'tab.cn',
  hk: 'tab.hk',
}
