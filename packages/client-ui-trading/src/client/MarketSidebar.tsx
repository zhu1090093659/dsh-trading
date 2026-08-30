/**
 * 富途式市场/自选面板（内容组件，由 MarketDock 停靠在左缘）：市场页签 +
 * 自选/默认标的列表。点击行 = 选中标的并切到行情模式（QuotePane 消费）；
 * 行内嵌迷你走势 + 最新价 + 涨跌幅（红涨绿跌）。行情批量轮询、页面隐藏时暂停。
 *
 * 注入面约定（官方模式）：可观察状态走 hooks（渲染器合成 use* hook），
 * 动作走 inject 直接 props（对照 settings 的 controller/setProvider 拆分）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchKlines, fetchMarkets, fetchTickers } from './api.ts'
import { searchAllMarkets } from './symbol-catalog.ts'
import type { MarketLocaleKey } from './contract.ts'
import { changePercent, directionColor, fmtPercent, fmtPrice } from './format.ts'
import { Sparkline } from './Sparkline.tsx'
import { DEFAULT_WATCHLISTS, rowsFor, type Observable, type SelectionState, type Watchlists } from './store.ts'
import type { Instrument, MarketId, MarketInfo, ReferenceSeries, Ticker } from './types.ts'
import { usePoll } from './usePoll.ts'
import css from './market-sidebar.module.css'

export type MarketTab = MarketId | 'watch'

/** Registration-side business face. */
export interface MarketSidebarInjected {
  hooks: {
    selection: Observable<SelectionState>
    watchlists: Observable<Watchlists>
  }
  /** 写路径：加入某市场自选。 */
  addInstrument(market: MarketId, instrument: Instrument): void
  /** 写路径：移除。 */
  removeInstrument(market: MarketId, symbol: string): void
  /** 写路径：选中标的（中栏 QuotePane 消费）。 */
  selectInstrument(instrument: Instrument): void
}

export type MarketSidebarProps =
  PropsLocale<'dshtrading.market'>
  & InjectFace<MarketSidebarInjected>

const SERIES_TTL_MS = 10 * 60 * 1000
const PRICE_POLL_MS = 8000
const SPARK_INTERVAL = '1d'
const SPARK_LIMIT = 32

const TAB_KEY: Record<MarketId, MarketLocaleKey> = {
  crypto: 'tab.crypto',
  us: 'tab.us',
  cn: 'tab.cn',
  hk: 'tab.hk',
}

/** 标的行键（market:symbol）。 */
export function rowKey(market: string, symbol: string): string {
  return `${market}:${symbol}`
}

export function MarketSidebar({
  t, useSelection, useWatchlists, addInstrument, removeInstrument, selectInstrument,
}: MarketSidebarProps) {
  const selection = useSelection(value => value.instrument)
  const watchlists = useWatchlists(value => value)
  const [tab, setTab] = useState<MarketTab>('watch')
  const [markets, setMarkets] = useState<MarketInfo[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [prices, setPrices] = useState<Record<string, Ticker>>({})
  const [series, setSeries] = useState<Record<string, ReferenceSeries>>({})
  const [draft, setDraft] = useState('')
  const [addMarket, setAddMarket] = useState<MarketId>('crypto')

  const reloadMarkets = useRef((): void => {})
  reloadMarkets.current = () => {
    fetchMarkets()
      .then((infos) => { setMarkets(infos); setLoadError(false) })
      .catch(() => { setLoadError(true) })
  }
  useEffect(() => { reloadMarkets.current() }, [])

  const availableMarkets = markets ?? []
  const rows = useMemo(() => {
    if (tab === 'watch') {
      const all: Instrument[] = []
      for (const info of availableMarkets) all.push(...rowsFor(watchlists, info.id))
      return all
    }
    return rowsFor(watchlists, tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, markets, watchlists])

  const rowsKey = rows.map(row => rowKey(row.market, row.symbol)).join('|')

  // 联想候选：仅自选页签的添加表单；跨市场全局搜索（候选项自带市场）。
  const suggestions = useMemo(
    () => (tab === 'watch' ? searchAllMarkets(draft) : []),
    [tab, draft],
  )

  // 参考序列（日K收盘 → 迷你走势 + 昨收）：逐标的惰性拉一次，TTL 内复用。
  useEffect(() => {
    if (rows.length === 0) return
    let cancelled = false
    const now = Date.now()
    for (const row of rows) {
      const key = rowKey(row.market, row.symbol)
      const cached = series[key]
      if (cached !== undefined && now - cached.fetchedAt < SERIES_TTL_MS) continue
      fetchKlines(row.market, row.symbol, SPARK_INTERVAL, SPARK_LIMIT)
        .then((klines) => {
          if (cancelled) return
          setSeries((current) => ({
            ...current,
            [key]: {
              closes: klines.map(candle => candle.close),
              prevClose: klines.length >= 2 ? klines[klines.length - 2]?.close : undefined,
              fetchedAt: Date.now(),
            },
          }))
        })
        .catch(() => { /* 序列失败不影响报价行 */ })
    }
    return () => { cancelled = true }
    // series 有意不在依赖里（TTL 缓存自判断）；rowsKey 变化即重查。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey])

  // 最新价批量轮询：按市场分组，每市场每拍一次请求。
  usePoll(async () => {
    if (rows.length === 0) return
    const byMarket = new Map<MarketId, string[]>()
    for (const row of rows) {
      const list = byMarket.get(row.market) ?? []
      list.push(row.symbol)
      byMarket.set(row.market, list)
    }
    const next: Record<string, Ticker> = {}
    await Promise.all([...byMarket.entries()].map(async ([market, symbols]) => {
      try {
        const outcome = await fetchTickers(market, symbols)
        for (const [symbol, result] of Object.entries(outcome)) {
          if (result.ok) next[rowKey(market, symbol)] = result.ticker
        }
      } catch { /* 桥暂不可用，下轮再试 */ }
    }))
    if (Object.keys(next).length > 0) setPrices(current => ({ ...current, ...next }))
  }, PRICE_POLL_MS, [rowsKey])

  const tabs: { id: MarketTab; label: string }[] = [
    { id: 'watch', label: t('tab.watch') },
    ...availableMarkets.map(info => ({ id: info.id as MarketTab, label: t(TAB_KEY[info.id]) })),
  ]

  return (
    <div className={css.root} data-dshtrading-market-sidebar="">
      <div className={css.tabs} role="tablist" aria-label={t('sidebar.markets')}>
        {tabs.map(entry => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={entry.id === tab}
            className={css.tab}
            data-active={entry.id === tab ? 'true' : undefined}
            onClick={() => { setTab(entry.id); setDraft('') }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {loadError && (
        <div className={css.error}>
          <div>{t('sidebar.loadFailed')}</div>
          <button type="button" onClick={() => { reloadMarkets.current() }}>{t('sidebar.retry')}</button>
        </div>
      )}

      {(() => {
        // 自选 tab 也提供添加入口（2026-08-31 用户反馈）：自选跨市场，加一个
        // 市场轮换按钮（crypto→us→cn→hk 循环）+ 输入框；市场页签维持原表单。
        const target: MarketId | null = tab === 'watch' ? addMarket : tab
        if (target === null) return null
        return (
          <form className={css.addRow} onSubmit={(event) => {
            event.preventDefault()
            const symbol = draft.trim()
            if (symbol === '') return
            addInstrument(target, { market: target, symbol })
            setDraft('')
          }}>
            {tab === 'watch' && (
              <button
                type="button"
                className={css.addMarketToggle}
                title={t('sidebar.addMarketHint')}
                onClick={() => {
                  const order: MarketId[] = ['crypto', 'us', 'cn', 'hk']
                  const index = order.indexOf(addMarket)
                  setAddMarket(order[(index + 1) % order.length] ?? 'crypto')
                }}
              >
                {t(TAB_KEY[addMarket])}
              </button>
            )}
            <input
              className={css.addInput}
              value={draft}
              placeholder={t('sidebar.addPlaceholder')}
              onChange={event => { setDraft(event.target.value) }}
            />
            <button className={css.addButton} type="submit" disabled={draft.trim() === ''}>{t('sidebar.add')}</button>
            {tab === 'watch' && suggestions.length > 0 && (
              <div className={css.suggestions} role="listbox" aria-label={t('sidebar.addPlaceholder')}>
                {suggestions.map(entry => (
                  <button
                    key={entry.market + ':' + entry.symbol}
                    type="button"
                    role="option"
                    aria-selected="true"
                    className={css.suggestion}
                    onClick={() => {
                      addInstrument(entry.market, { market: entry.market, symbol: entry.symbol, name: entry.name })
                      setDraft('')
                    }}
                  >
                    <span className={css.suggestionSymbol}>{entry.symbol}</span>
                    <span className={css.suggestionName}>{entry.name}</span>
                    <span className={css.suggestionMarket}>{t(TAB_KEY[entry.market])}</span>
                  </button>
                ))}
              </div>
            )}
          </form>
        )
      })()}

      {rows.length === 0 && !loadError
        ? (
            <div className={css.empty}>
              {tab === 'watch' ? t('sidebar.emptyHint') : t('sidebar.empty')}
            </div>
          )
        : (
            <div className={css.list} role="listbox" aria-label={t('sidebar.markets')}>
              {rows.map((row) => {
                const key = rowKey(row.market, row.symbol)
                const ticker = prices[key]
                const ref = series[key]
                const price = ticker?.price
                const pct = changePercent(price, ref?.prevClose)
                const up = (pct ?? 0) >= 0
                const selected = selection !== null && selection.market === row.market && selection.symbol === row.symbol
                return (
                  <button
                    key={key}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={css.row}
                    data-selected={selected ? 'true' : undefined}
                    title={t('row.select')}
                    onClick={() => { selectInstrument(row) }}
                  >
                    <span className={css.idents}>
                      <span className={css.name}>{row.name ?? row.symbol}</span>
                      <span className={css.codeRow}>
                        <span className={css.code}>{row.symbol}</span>
                        {tab === 'watch' && <span className={css.marketTag}>{t(TAB_KEY[row.market])}</span>}
                      </span>
                    </span>
                    <span className={css.spark}>
                      <Sparkline values={ref?.closes ?? []} width={56} height={22} up={up} />
                    </span>
                    <span className={css.quote}>
                      <span className={css.price} style={{ color: directionColor(pct ?? 0) }}>{fmtPrice(price)}</span>
                      <span className={css.pct} style={{ color: directionColor(pct ?? 0) }}>{fmtPercent(pct)}</span>
                    </span>
                    <span
                      role="button"
                      aria-label={t('row.remove')}
                      className={css.remove}
                      onClick={(event) => {
                        event.stopPropagation()
                        removeInstrument(row.market, row.symbol)
                      }}
                    >
                      ✕
                    </span>
                  </button>
                )
              })}
            </div>
          )}
    </div>
  )
}
