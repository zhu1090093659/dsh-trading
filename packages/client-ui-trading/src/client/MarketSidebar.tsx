/**
 * 富途式市场/自选面板（内容组件，由 MarketDock 停靠在左缘）：
 * 顶部自选分组与折叠按钮 + 胶囊市场页签 + 表头 + 三段式自选标的列表。
 * 点击行 = 选中标的并切到行情模式（QuotePane 消费）；
 * 行内嵌迷你面积走势 + 最新价 + 涨跌幅（红涨绿跌）。行情批量轮询、页面隐藏时暂停。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchKlines, fetchMarkets, fetchSymbols, fetchTickers } from './api.ts'
import { searchAllMarkets, searchSymbols, setDynamicCatalog, updateDynamicCatalog } from './symbol-catalog.ts'
import type { MarketLocaleKey } from './contract.ts'
import { changePercent, directionColor, fmtPercent, fmtPrice } from './format.ts'
import { colorModeStore } from './color-mode.ts'
import { Sparkline } from './Sparkline.tsx'
import { IconChevronDown, IconFoldPanel } from './icons.tsx'
import { rowsFor, type Observable, type SelectionState, type Watchlists } from './store.ts'
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
  & { onFold?: () => void }

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
  t, useSelection, useWatchlists, addInstrument, removeInstrument, selectInstrument, onFold,
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
  const [catalogVersion, setCatalogVersion] = useState(0)
  const colorMode = useSyncExternalStore(colorModeStore.subscribe, colorModeStore.getSnapshot)

  const reloadMarkets = useRef((): void => {})
  reloadMarkets.current = () => {
    fetchMarkets()
      .then((infos) => { setMarkets(infos); setLoadError(false) })
      .catch(() => { setLoadError(true) })
  }
  useEffect(() => { reloadMarkets.current() }, [])

  // 动态标的全集预取（Issue #15）：切页签或挂载时触发，成功后注入 catalog 并刷新联想
  useEffect(() => {
    const targetMarkets: MarketId[] = tab === 'watch' ? ['crypto', 'us', 'cn', 'hk'] : [tab]
    let cancelled = false
    for (const m of targetMarkets) {
      fetchSymbols(m)
        .then((symbols) => {
          if (cancelled || symbols.length === 0) return
          setDynamicCatalog(m, symbols)
          setCatalogVersion((v) => v + 1)
        })
        .catch(() => { /* 桥不可用/无全集静默回退纯静态 */ })
    }
    return () => { cancelled = true }
  }, [tab])

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

  // 联想候选：自选页签跨市场全局搜索（候选自带市场）；市场页签只搜本市场字典（显式注入当前市场）。
  const suggestions = useMemo(
    () => (tab === 'watch' ? searchAllMarkets(draft) : searchSymbols(tab, draft).map(entry => ({ ...entry, market: tab }))),
    [tab, draft, catalogVersion],
  )

  // 智能动态补齐搜索标的真实名称（如 000938 未收录时，异步拉取行情拿到“紫光股份”并刷新联想）
  useEffect(() => {
    const raw = draft.trim().toUpperCase()
    if (!raw) return

    const candidatesToEnrich: Array<{ market: MarketId; symbol: string }> = []
    for (const sug of suggestions) {
      if (sug.name && (sug.name === sug.symbol || /\(A股\)|\(港股\)/.test(sug.name))) { // i18n-allow: 数据源占位名匹配谓词（"xx (A股)"），非 UI 文案
        candidatesToEnrich.push({ market: sug.market, symbol: sug.symbol })
      }
    }

    if (candidatesToEnrich.length === 0) return

    let cancelled = false
    const timer = setTimeout(() => {
      for (const item of candidatesToEnrich) {
        fetchTickers(item.market, [item.symbol])
          .then((res) => {
            if (cancelled) return
            const outcome = res[item.symbol]
            const ticker = outcome && outcome.ok ? outcome.ticker : undefined
            if (ticker?.name && ticker.name !== item.symbol && !/\(A股\)|\(港股\)/.test(ticker.name)) { // i18n-allow: 数据源占位名匹配谓词（"xx (A股)"），非 UI 文案
              updateDynamicCatalog(item.market, [{ symbol: item.symbol, name: ticker.name }])
              setCatalogVersion((v) => v + 1)
            }
          })
          .catch(() => {})
      }
    }, 180)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [draft, suggestions])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey])

  // 最新价批量轮询：按市场分组，每市场每拍一次请求，并自动回填标的真实中文名称。
  usePoll(async () => {
    if (rows.length === 0) return
    const byMarket = new Map<MarketId, string[]>()
    for (const row of rows) {
      const list = byMarket.get(row.market) ?? []
      list.push(row.symbol)
      byMarket.set(row.market, list)
    }
    const next: Record<string, Ticker> = {}
    const dynamicUpdates: Map<MarketId, Array<{ symbol: string; name: string }>> = new Map()

    await Promise.all([...byMarket.entries()].map(async ([market, symbols]) => {
      try {
        const outcome = await fetchTickers(market, symbols)
        for (const [symbol, result] of Object.entries(outcome)) {
          if (result.ok) {
            next[rowKey(market, symbol)] = result.ticker
            if (result.ticker.name && result.ticker.name !== symbol && !/\(A股\)|\(港股\)/.test(result.ticker.name)) { // i18n-allow: 数据源占位名匹配谓词（"xx (A股)"），非 UI 文案
              const list = dynamicUpdates.get(market) ?? []
              list.push({ symbol, name: result.ticker.name })
              dynamicUpdates.set(market, list)

              // 若自选列表中此标的名字为空或为占位符，自动更新自选名称
              const existingRow = rows.find((r) => r.market === market && r.symbol === symbol)
              if (existingRow && (!existingRow.name || existingRow.name === symbol || /\(A股\)|\(港股\)/.test(existingRow.name))) { // i18n-allow: 数据源占位名匹配谓词（"xx (A股)"），非 UI 文案
                addInstrument(market, { market, symbol, name: result.ticker.name })
              }
            }
          }
        }
      } catch { /* 桥暂不可用，下轮再试 */ }
    }))

    if (Object.keys(next).length > 0) setPrices(current => ({ ...current, ...next }))

    if (dynamicUpdates.size > 0) {
      for (const [m, entries] of dynamicUpdates.entries()) {
        updateDynamicCatalog(m, entries)
      }
      setCatalogVersion((v) => v + 1)
    }
  }, PRICE_POLL_MS, [rowsKey])

  const tabs: { id: MarketTab; label: string }[] = [
    { id: 'watch', label: t('tab.watch') },
    ...availableMarkets.map(info => ({ id: info.id as MarketTab, label: t(TAB_KEY[info.id]) })),
  ]

  return (
    <div className={css.root} data-dshtrading-market-sidebar="">
      {/* 顶部标题区：自选下拉组 + 折叠按钮 */}
      <div className={css.topBar}>
        <div className={css.titleGroup} title={t('tab.watch')}>
          <span>{t('tab.watch')}</span>
          <IconChevronDown size={12} />
        </div>
        {onFold !== undefined && (
          <button
            type="button"
            className={css.foldBtn}
            aria-label={t('sidebar.fold')}
            title={t('sidebar.fold')}
            onClick={onFold}
          >
            <IconFoldPanel size={15} />
          </button>
        )}
      </div>

      {/* 市场胶囊 Tab 条 */}
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

      {/* 添加标的表单 */}
      {(() => {
        const target: MarketId | null = tab === 'watch' ? addMarket : tab
        if (target === null) return null
        return (
          <form className={css.addRow} onSubmit={(event) => {
            event.preventDefault()
            const raw = draft.trim().toUpperCase()
            if (raw === '') return
            const match = suggestions.find(s => s.symbol.toUpperCase() === raw || s.symbol.toUpperCase().startsWith(raw))
            const symbol = match ? match.symbol : (
              target === 'cn' && /^\d{6}$/.test(raw)
                ? `${raw}.${raw.startsWith('6') || raw.startsWith('9') ? 'SH' : 'SZ'}`
                : (target === 'hk' && /^\d{1,5}$/.test(raw) ? `${raw.padStart(5, '0')}.HK` : raw)
            )
            const name = match?.name
            const market = match?.market ?? target
            const item: Instrument = { market, symbol, ...(name ? { name } : {}) }
            addInstrument(market, item)
            selectInstrument(item)
            if (tab !== 'watch' && tab !== market) {
              setTab(market)
            }
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
            {suggestions.length > 0 && (
              <div className={css.suggestions} role="listbox" aria-label={t('sidebar.addPlaceholder')}>
                {suggestions.map(entry => (
                  <button
                    key={entry.market + ':' + entry.symbol}
                    type="button"
                    role="option"
                    aria-selected="true"
                    className={css.suggestion}
                    onMouseDown={(e) => { e.preventDefault() }}
                    onClick={() => {
                      const item: Instrument = { market: entry.market, symbol: entry.symbol, name: entry.name }
                      addInstrument(entry.market, item)
                      selectInstrument(item)
                      if (tab !== 'watch' && tab !== entry.market) {
                        setTab(entry.market)
                      }
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

      {/* 列表表头 */}
      <div className={css.listHeader}>
        <span>{t('header.symbol')}</span>
        <span className={css.listHeaderColCenter}>{t('header.trend')}</span>
        <span className={css.listHeaderColRight}>{t('header.priceChange')}</span>
      </div>

      {/* 三段式标的列表 */}
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
                // 涨跌幅昨收优先用快照官方锚点；日 K 推算仅作快照缺 prevClose 时的兜底
                // （日 K 序列可能缺最新收盘 bar，倒数第二根会错位一个交易日）。
                const pct = changePercent(price, ticker?.prevClose ?? ref?.prevClose)
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
                      <span className={css.name}>
                        {(() => {
                          const rowRaw = row.name
                          const isPlaceholder = !rowRaw || rowRaw === row.symbol || /\(A股\)|\(港股\)/.test(rowRaw) // i18n-allow: 数据源占位名匹配谓词（"xx (A股)"），非 UI 文案
                          const tickName = (ticker as { name?: string })?.name
                          return !isPlaceholder ? rowRaw : (tickName || rowRaw || row.symbol)
                        })()}
                      </span>
                      <span className={css.codeRow}>
                        <span className={css.code}>{row.symbol}</span>
                        {tab === 'watch' && <span className={css.marketTag}>{t(TAB_KEY[row.market])}</span>}
                      </span>
                    </span>
                    <span className={css.spark}>
                      <Sparkline values={ref?.closes ?? []} width={56} height={22} up={up} colorMode={colorMode} />
                    </span>
                    <span className={css.quote}>
                      <span className={css.price} style={{ color: directionColor(pct ?? 0, colorMode) }}>{fmtPrice(price)}</span>
                      <span className={css.pct} style={{ color: directionColor(pct ?? 0, colorMode) }}>{fmtPercent(pct)}</span>
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
