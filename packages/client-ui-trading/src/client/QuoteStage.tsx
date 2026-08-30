/**
 * 行情面板主体：富途式报价头（最新价/涨跌幅/开高低昨收/量）+ K线主图
 * （candle + MA5/10/20 + 成交量）+ 周期页签。曾挂 conversation.view
 * （id 'quote'），2.4 起由中栏 QuotePane 直接复用（不再注册 view tab）。
 * 数据经 /dshtrading/api 桥拉连接器行情；ticker 5s 轮询（页面隐藏暂停）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchKlines, fetchTickers } from './api.ts'
import { CandleChart } from './CandleChart.tsx'
import type { MarketLocaleKey } from './contract.ts'
import {
  MA_COLORS, INTRADAY_INTERVALS, changePercent, directionColor,
  fmtChange, fmtClock, fmtCompact, fmtPercent, fmtPrice,
} from './format.ts'
import { MARKET_INTERVALS, type Observable, type SelectionState } from './store.ts'
import type { Kline, MarketId, Ticker } from './types.ts'
import { usePoll } from './usePoll.ts'
import css from './quote-stage.module.css'

const INTERVAL_KEY_PREFIX = 'dshtrading.interval.'
const TICKER_POLL_MS = 5000
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

/** Registration-side business face. */
export interface QuoteStageInjected {
  hooks: {
    selection: Observable<SelectionState>
  }
}

export type QuoteStageProps =
  PropsRuntime<'conversation.view'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<QuoteStageInjected>

export function QuoteStage({ t, useSelection }: QuoteStageProps) {
  const instrument = useSelection(value => value.instrument)
  const market: MarketId | undefined = instrument?.market
  const symbol = instrument?.symbol

  const [chartInterval, setIntervalFor] = useState<string>(() => {
    if (market === undefined) return '1d'
    return readInterval(market)
  })
  const [daily, setDaily] = useState<Kline[] | null>(null)
  const [klines, setKlines] = useState<Kline[] | null>(null)
  const [kError, setKError] = useState<string | null>(null)
  const [ticker, setTicker] = useState<Ticker | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [chartSize, setChartSize] = useState<{ width: number; height: number }>({ width: 760, height: 380 })
  const chartBox = useRef<HTMLDivElement | null>(null)

  // 周期记忆（每市场独立）；切标的时读该市场的上次周期。
  useEffect(() => {
    if (market !== undefined) setIntervalFor(readInterval(market))
  }, [market])

  useEffect(() => {
    if (chartBox.current === null) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect !== undefined && rect.width > 0) {
        setChartSize({ width: Math.floor(rect.width), height: Math.max(280, Math.floor(rect.height)) })
      }
    })
    observer.observe(chartBox.current)
    return () => { observer.disconnect() }
  }, [])

  const load = useCallback((targetInterval: string): void => {
    if (market === undefined || symbol === undefined) return
    let cancelled = false
    setKError(null)
    fetchKlines(market, symbol, targetInterval, KLINE_LIMIT)
      .then((rows) => { if (!cancelled) setKlines(rows) })
      .catch((error) => { if (!cancelled) setKError(String(error?.message ?? error)) })
    if (daily === null) {
      fetchKlines(market, symbol, '1d', DAILY_LIMIT)
        .then((rows) => { if (!cancelled) setDaily(rows) })
        .catch(() => { /* 头部统计缺省 */ })
    }
    return () => { cancelled = true }
    // daily 有意不在依赖：日K 每标的只拉一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, symbol])

  useEffect(() => {
    if (market === undefined || symbol === undefined) return
    setKlines(null)
    setDaily(null)
    setTicker(null)
    setHoverIndex(null)
    const cleanup = load(readInterval(market))
    return cleanup
  }, [market, symbol, load])

  usePoll(async () => {
    if (market === undefined || symbol === undefined) return
    try {
      const outcome = await fetchTickers(market, [symbol])
      const result = outcome[symbol]
      if (result?.ok) setTicker(result.ticker)
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

  const hoverCandle = klines !== null && hoverIndex !== null ? klines[hoverIndex] : undefined
  const readout = hoverCandle ?? (klines !== null && klines.length > 0 ? klines[klines.length - 1] : undefined)

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
        <span className={css.stat}><label>{t('quote.open')}</label>{fmtPrice(readout?.open)}</span>
        <span className={css.stat}><label>{t('quote.high')}</label>{fmtPrice(readout?.high)}</span>
        <span className={css.stat}><label>{t('quote.low')}</label>{fmtPrice(readout?.low)}</span>
        <span className={css.stat}><label>{t('quote.volume')}</label>{fmtCompact(readout?.volume)}</span>
      </div>

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
              load(entry)
            }}
          >
            {t(INTERVAL_KEY[entry] ?? 'interval.1d')}
          </button>
        ))}
        <div className={css.maLegend}>
          {Object.entries(MA_COLORS).map(([label, maColor]) => (
            <span key={label} style={{ color: maColor }}>{label}</span>
          ))}
        </div>
      </div>

      {kError !== null && <div className={css.error}>{t('quote.loadFailed')}：{kError}</div>}

      <div className={css.chartBox} ref={chartBox}>
        {klines === null
          ? null
          : (
              <CandleChart
                klines={klines}
                width={chartSize.width}
                height={chartSize.height}
                intraday={INTRADAY_INTERVALS.has(chartInterval)}
                onHoverIndex={setHoverIndex}
              />
            )}
      </div>
    </div>
  )
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
