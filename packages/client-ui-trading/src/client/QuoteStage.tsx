/**
 * 行情面板主体（中栏 quote 视图）：富途牛牛视觉风格。
 * 顶部报价头 + K线图 + 周期胶囊条 + 技术指标选择器 +
 * 主图指标读数行（副图指标读数在 TvChart 各自 pane 内）+
 * 底部横向指标快捷词条带 + 底部市场指数状态栏。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { fetchKlines, fetchTickers } from './api.ts'
import { TvChart, toBar, toVolume } from './TvChart.tsx'
import type { TvIndicatorGroup } from './TvChart.tsx'
import { IconIndicators } from './icons.tsx'
import type { MarketLocaleKey } from './contract.ts'
import {
  INTRADAY_INTERVALS, changePercent, directionColor,
  fmtChange, fmtClock, fmtCompact, fmtPercent, fmtPrice,
} from './format.ts'
import { indicators, isCustomIndicator } from './indicator-registry.ts'
import type { IndicatorDefinition, IndicatorInstance } from '@dsh-trading/indicators'
import { MARKET_INTERVALS } from './store.ts'
import type { SelectionState } from './store.ts'
import type { ChartState } from './chart-state.ts'
import { colorModeStore, type ColorMode } from './color-mode.ts'
import { MARKET_INDICES, getMarketSessionStatus } from './market-status.ts'
import type { Kline, MarketId, Ticker } from './types.ts'
import { usePoll } from './usePoll.ts'
import css from './quote-stage.module.css'

const INTERVAL_KEY_PREFIX = 'dshtrading.interval.'
const TICKER_POLL_MS = 5000
const KLINE_RESYNC_MS = 30000
const KLINE_LIMIT = 500
const DAILY_LIMIT = 60

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

export type Translate = (key: MarketLocaleKey) => string

export type UseStoreState<TState> = <TSelected>(selector: (state: TState) => TSelected) => TSelected

export interface QuoteStageProps {
  t: Translate
  useSelection: UseStoreState<SelectionState>
  useChart: UseStoreState<ChartState>
  toggleIndicator: (id: string) => void
  setIndicatorParams: (id: string, params: Record<string, number>) => void
  /** 删除自定义指标（issue #30 删除入口；仅自定义行渲染按钮）。 */
  deleteIndicator: (id: string) => Promise<boolean>
}

function inferMarketFromSymbol(symbol?: string): MarketId | undefined {
  if (!symbol) return undefined
  const sym = symbol.toUpperCase()
  if (sym.endsWith('.SH') || sym.endsWith('.SZ') || /^\d{6}$/.test(sym)) return 'cn'
  if (sym.endsWith('.HK') || /^\d{5}$/.test(sym)) return 'hk'
  if (sym.includes('USDT') || sym.includes('BTC') || sym.includes('ETH')) return 'crypto'
  return 'us'
}

export function QuoteStage({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, deleteIndicator }: QuoteStageProps) {
  const instrument = useSelection(value => value.instrument)
  const market: MarketId | undefined = (instrument?.market && ['crypto', 'us', 'cn', 'hk'].includes(instrument.market))
    ? (instrument.market as MarketId)
    : inferMarketFromSymbol(instrument?.symbol)
  const symbol = instrument?.symbol
  const activeMarket: MarketId = market ?? 'crypto'

  const colorMode = useSyncExternalStore(colorModeStore.subscribe, colorModeStore.getSnapshot)

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
      const rows = await fetchKlines(market, symbol, chartInterval, KLINE_LIMIT)
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

  // 换标的：立即清场
  useEffect(() => {
    setKlines(null)
    setDaily(null)
    setTicker(null)
    setHoverIndex(null)
    setKError(null)
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

  return (
    <div className={css.root} data-dshtrading-quote-stage="">
      {/* 顶部报价头 */}
      <div className={css.header}>
        <div className={css.ident}>
          <span className={css.name}>{instrument?.name ?? (ticker as { name?: string })?.name ?? symbol}</span>
          <span className={css.code}>{symbol}</span>
          <span className={css.marketTag}>{t(TAB_KEY[market])}</span>
        </div>
        <span className={css.price} style={{ color }}>{fmtPrice(stats.price)}</span>
        <span className={css.changes} style={{ color }}>
          <span>{fmtChange(stats.change)}</span>
          <span>{fmtPercent(stats.pct)}</span>
        </span>
        <span className={css.meta}>
          {ticker !== null && <span>{t('quote.updated')} {fmtClock(ticker.timestamp)}</span>}
        </span>
      </div>

      {/* 统计行情概览 */}
      <div className={css.stats}>
        <span className={css.stat}><label>{t('quote.prevClose')}</label>{fmtPrice(readoutPrevClose)}</span>
        <span className={css.stat}><label>{t('quote.open')}</label>{fmtPrice(readoutCandle?.open)}</span>
        <span className={css.stat}><label>{t('quote.high')}</label>{fmtPrice(readoutCandle?.high)}</span>
        <span className={css.stat}><label>{t('quote.low')}</label>{fmtPrice(readoutCandle?.low)}</span>
        <span className={css.stat}><label>{t('quote.volume')}</label>{fmtCompact(readoutCandle?.volume)}</span>
      </div>

      {/* 周期胶囊条 + 指标弹层按钮 */}
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

      {/* 主图指标悬停/最新读数分量（各分量独立着色）。VOL/MACD 等副图指标
          的读数在 TvChart 各自 pane 内渲染，不进主图读数行。 */}
      {mainOverlays.length > 0 && (
        <div className={css.indicatorReadout}>
          {mainOverlays.flatMap(group => outputReadouts(group, readoutIndex))}
        </div>
      )}

      {kError !== null && <div className={css.error}>{t('quote.loadFailed')}：{kError}</div>}

      {/* 图表主舞台 */}
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
          />
        )}
      </div>

      {/* 底部横向指标词条带 */}
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
              <span className={css.indexName}>{def.name}</span>
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

const TAB_KEY: Record<MarketId, MarketLocaleKey> = {
  crypto: 'tab.crypto',
  us: 'tab.us',
  cn: 'tab.cn',
  hk: 'tab.hk',
}
