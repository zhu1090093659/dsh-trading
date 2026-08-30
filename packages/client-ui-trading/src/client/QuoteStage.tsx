/**
 * 行情面板主体（中栏 quote 视图）：富途式报价头 + K线图 + 周期页签 +
 * 技术指标选择器（OKX 式单按钮，3.1 起取代 preset chips 指标条）。
 * 3.0 起图表为 TradingView lightweight-charts v5（TvChart）：
 * 主图蜡烛+叠加指标（MA/EMA/BOLL），副图成交量+指标（MACD/RSI/KDJ）。
 *
 * 数据经 /dshtrading/api 桥：K线由 usePoll 拉取（挂载/切换立即 + 30s
 * resync，后台标签页冻结）；ticker 5s 轮询，价格尾随合并进最后一根
 * K 线（图表走 update 增量，30s resync 兜底校正量/开高低）。
 * 指标定义来自 indicators/registry.ts，本组件只做 compute 调度与 UI。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchKlines, fetchTickers } from './api.ts'
import { TvChart, toBar, toVolume } from './TvChart.tsx'
import type { TvIndicatorGroup } from './TvChart.tsx'
import { IconIndicators } from './icons.tsx'
import type { MarketLocaleKey } from './contract.ts'
import {
  INTRADAY_INTERVALS, changePercent, directionColor,
  fmtChange, fmtClock, fmtCompact, fmtPercent, fmtPrice,
} from './format.ts'
import { getIndicator, instanceKey, listIndicators } from './indicators/registry.ts'
import type { IndicatorDefinition, IndicatorInstance } from './indicators/registry.ts'
import { MARKET_INTERVALS } from './store.ts'
import type { SelectionState } from './store.ts'
import type { ChartState } from './chart-state.ts'
import type { Kline, MarketId, Ticker } from './types.ts'
import { usePoll } from './usePoll.ts'
import css from './quote-stage.module.css'

const INTERVAL_KEY_PREFIX = 'dshtrading.interval.'
const TICKER_POLL_MS = 5000
const KLINE_RESYNC_MS = 30000
const KLINE_LIMIT = 160
const DAILY_LIMIT = 60

const INTERVAL_KEY: Record<string, MarketLocaleKey> = {
  '15m': 'interval.15m',
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
}

export function QuoteStage({ t, useSelection, useChart, toggleIndicator, setIndicatorParams }: QuoteStageProps) {
  const instrument = useSelection(value => value.instrument)
  const market: MarketId | undefined = instrument?.market
  const symbol = instrument?.symbol

  const instances = useChart(state => state.instances)

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

  // 周期记忆（每市场独立）；切标的时读该市场的上次周期。
  useEffect(() => {
    if (market !== undefined) setIntervalFor(readInterval(market))
  }, [market])

  // K线取数 = poll：挂载/换标的/换周期立即触发，此后 30s resync。
  // requestRef 丢弃切换后的过期响应（旧代码 cancelled flag 的等价物）。
  const requestRef = useRef('')
  usePoll(async () => {
    if (market === undefined || symbol === undefined) return
    const request = `${market}:${symbol}:${chartInterval}`
    requestRef.current = request
    try {
      const rows = await fetchKlines(market, symbol, chartInterval, KLINE_LIMIT)
      if (requestRef.current !== request) return
      setKlines(rows)
      setKError(null)
    } catch (error) {
      if (requestRef.current !== request) return
      setKError(String(error?.message ?? error))
    }
  }, KLINE_RESYNC_MS, [market, symbol, chartInterval])

  // 日K参考（头部涨跌/昨收）：每标的只拉一次。
  useEffect(() => {
    if (market === undefined || symbol === undefined) return
    let cancelled = false
    fetchKlines(market, symbol, '1d', DAILY_LIMIT)
      .then((rows) => { if (!cancelled) setDaily(rows) })
      .catch(() => { /* 头部统计缺省 */ })
    return () => { cancelled = true }
  }, [market, symbol])

  // 换标的：立即清场（不留旧标的的图/头部），数据由上面 poll 重取。
  useEffect(() => {
    setKlines(null)
    setDaily(null)
    setTicker(null)
    setHoverIndex(null)
    setKError(null)
  }, [market, symbol])

  // ticker 轮询：头部价格 + 尾随合并最后一根 K 线（图表增量 update）。
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
    const prevClose = daily !== null && daily.length >= 2 ? daily[daily.length - 2]?.close : undefined
    const price = ticker?.price ?? klines?.[klines.length - 1]?.close
    const change = price !== undefined && prevClose !== undefined ? price - prevClose : undefined
    const pct = changePercent(price, prevClose)
    return { last, prevClose, price, change, pct }
  }, [daily, ticker, klines])

  // 指标调度：klines × 激活实例 → 渲染输入（compute 是注册表纯函数）。
  const indicatorGroups = useMemo(() => {
    if (klines === null) return []
    const groups: Array<TvIndicatorGroup & { id: string; pane: 'main' | 'sub' }> = []
    for (const instance of instances) {
      const definition = getIndicator(instance.id)
      if (definition === undefined) continue
      groups.push({
        id: instance.id,
        pane: definition.pane,
        key: instanceKey(instance),
        outputs: definition.compute(klines, instance.params),
      })
    }
    return groups
  }, [klines, instances])

  const mainOverlays = useMemo(() => indicatorGroups.filter(group => group.pane === 'main'), [indicatorGroups])
  const subIndicators = useMemo(() => indicatorGroups.filter(group => group.pane === 'sub'), [indicatorGroups])

  const bars = useMemo(() => klines?.map(toBar) ?? [], [klines])
  const volumes = useMemo(() => klines?.map(toVolume) ?? [], [klines])

  const readoutIndex = hoverIndex ?? (klines !== null && klines.length > 0 ? klines.length - 1 : null)
  const readoutCandle = klines !== null && readoutIndex !== null ? klines[readoutIndex] : undefined

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
  const color = directionColor(stats.pct ?? 0)

  return (
    <div className={css.root} data-dshtrading-quote-stage="">
      <div className={css.header}>
        <div className={css.ident}>
          <span className={css.name}>{instrument?.name ?? symbol}</span>
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

      <div className={css.stats}>
        <span className={css.stat}><label>{t('quote.prevClose')}</label>{fmtPrice(stats.prevClose)}</span>
        <span className={css.stat}><label>{t('quote.open')}</label>{fmtPrice(readoutCandle?.open)}</span>
        <span className={css.stat}><label>{t('quote.high')}</label>{fmtPrice(readoutCandle?.high)}</span>
        <span className={css.stat}><label>{t('quote.low')}</label>{fmtPrice(readoutCandle?.low)}</span>
        <span className={css.stat}><label>{t('quote.volume')}</label>{fmtCompact(readoutCandle?.volume)}</span>
      </div>

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

        {/* 技术指标入口（OKX 式）：全部指标折叠进一个按钮，点开勾选面板。 */}
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
              onClose={() => {
                setPickerOpen(false)
                setEditingIndicator(null)
              }}
            />
          )}
        </div>
      </div>

      <div className={css.indicatorReadout}>
        {indicatorGroups.flatMap(group => outputReadouts(group, readoutIndex))}
      </div>

      {kError !== null && <div className={css.error}>{t('quote.loadFailed')}：{kError}</div>}

      <div className={css.chartBox}>
        {klines !== null && bars.length > 0 && (
          <TvChart
            bars={bars}
            volumes={volumes}
            dataKey={`${market}:${symbol}:${chartInterval}`}
            intraday={INTRADAY_INTERVALS.has(chartInterval)}
            mainOverlays={mainOverlays}
            subIndicators={subIndicators}
            onHoverIndex={setHoverIndex}
          />
        )}
      </div>
    </div>
  )
}

/** 技术指标选择器（OKX 式）：透明背景层收点闭 + 主/副图两组勾选行，
    激活行可展开行内参数编辑。指标名册 = 注册表快照（含未来外部注册）。 */
function IndicatorPicker(props: {
  t: Translate
  instances: IndicatorInstance[]
  editingIndicator: string | null
  onToggle: (id: string) => void
  onEdit: (id: string) => void
  onApply: (id: string, params: Record<string, number>) => void
  onClose: () => void
}): React.JSX.Element {
  const { t, instances, editingIndicator, onToggle, onEdit, onApply, onClose } = props
  const definitions = listIndicators()
  return (
    <>
      <div className={css.pickerBackdrop} onClick={onClose} aria-hidden="true" />
      <div className={css.pickerPanel} role="dialog" aria-label={t('indicator.picker')}>
        <div className={css.pickerTitle}>{t('indicator.picker')}</div>
        <PickerGroup
          title={t('indicator.group.main')}
          definitions={definitions.filter(definition => definition.pane === 'main')}
          instances={instances}
          editingIndicator={editingIndicator}
          t={t}
          onToggle={onToggle}
          onEdit={onEdit}
          onApply={onApply}
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
        />
      </div>
    </>
  )
}

/** 选择器分组：勾选行 = 开关指标实例；「参数」展开行内编辑块。 */
function PickerGroup(props: {
  title: string
  definitions: readonly IndicatorDefinition[]
  instances: readonly IndicatorInstance[]
  editingIndicator: string | null
  t: Translate
  onToggle: (id: string) => void
  onEdit: (id: string) => void
  onApply: (id: string, params: Record<string, number>) => void
}): React.JSX.Element {
  const { title, definitions, instances, editingIndicator, t, onToggle, onEdit, onApply } = props
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
              <span>{t(definition.titleKey)}</span>
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

/** 参数编辑块（选择器行内展开）：number 输入 + 应用/取消（store 侧最终 clamp）。 */
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
          <span>{t(spec.labelKey)}</span>
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

/** 读数行：每个在场输出一条 `KEY value`（悬停跟随，色同序列）。 */
function outputReadouts(
  group: TvIndicatorGroup & { id: string; pane: 'main' | 'sub' },
  readoutIndex: number | null,
): Array<React.JSX.Element | null> {
  if (readoutIndex === null) return []
  return group.outputs.map((output) => {
    const value = output.values[readoutIndex]
    if (value === undefined || !Number.isFinite(value)) return null
    return (
      <span key={`${group.key}.${output.key}`} style={{ color: output.color }}>
        {output.key} {value.toFixed(2)}
      </span>
    )
  })
}

/** ticker 价格尾随合并最后一根 K 线；无变化返回原数组（避免无效重算）。 */
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

function readInterval(market: MarketId): string {
  try {
    const raw = localStorage.getItem(INTERVAL_KEY_PREFIX + market)
    if (raw !== null && (MARKET_INTERVALS[market] ?? []).includes(raw)) return raw
  } catch { /* 无 localStorage 用默认 */ }
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
