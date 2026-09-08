/**
 * 富途式市场/自选面板（内容组件，由 MarketDock 停靠在左缘）：
 * 顶部自选分组与折叠按钮 + 胶囊市场页签 + 表头 + 三段式自选标的列表 +
 * 底部设置入口（3.0 自右缘竖条迁入，MarketDock 注入 openSettings）。
 * 点击行 = 选中标的并切到行情模式（QuotePane 消费）；
 * 行内嵌迷你面积走势（当日/最近交易日分钟线，分钟线不可用时降级日 K）+ 最新价 + 涨跌幅
 * （红涨绿跌）。行情批量轮询、页面隐藏时暂停。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchKlines, fetchMarkets, fetchSymbols, fetchTickers } from './api.ts'
import { searchAllMarkets, searchSymbols, setDynamicCatalog, updateDynamicCatalog } from './symbol-catalog.ts'
import type { MarketLocaleKey } from './contract.ts'
import { changePercent, directionColor, fmtPercent, fmtPrice } from './format.ts'
import { intradayCandidates, intradayRequest, selectIntradayCloses } from './intraday-series.ts'
import { colorModeStore } from './color-mode.ts'
import { Sparkline } from './Sparkline.tsx'
import { IconChevronDown, IconFoldPanel, IconSettings } from './icons.tsx'
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
  /** 打开官方设置弹层（3.0 起入口在本面板底部；MarketDock 注入转发）。 */
  openSettings(): void
}

export type MarketSidebarProps =
  PropsLocale<'dshtrading.market'>
  & InjectFace<MarketSidebarInjected>
  & { onFold?: () => void; updateAvailable?: boolean }

/** 日 K 降级序列的复用窗口：分钟内不重复打必失败的分钟线，TTL 过后重试。 */
const SERIES_TTL_MS = 10 * 60 * 1000
const PRICE_POLL_MS = 8000
/** 日内走势序列轮询节拍：分钟 bar 粒度下 60s 足够「活」，又对公共端温和。 */
const SERIES_POLL_MS = 60 * 1000
const DAILY_FALLBACK_LIMIT = 32

const TAB_KEY: Record<MarketId, MarketLocaleKey> = {
  crypto: 'tab.crypto',
  us: 'tab.us',
  cn: 'tab.cn',
  hk: 'tab.hk',
}

const KNOWN_SH_INDICES = new Set(['000688', '000300', '000016', '000905', '000852'])

/** 标的行键（market:symbol）。 */
export function rowKey(market: string, symbol: string): string {
  return `${market}:${symbol}`
}

export function MarketSidebar({
  t, useSelection, useWatchlists, addInstrument, removeInstrument, selectInstrument, onFold, openSettings, updateAvailable,
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

  // 真实在线联想：当用户输入关键词时，防抖向上游真实检索标的
  // 只有上游确认真实存在的股票才会被注入动态字典，彻底杜绝本地盲目推造虚假代码
  useEffect(() => {
    const raw = draft.trim()
    if (raw.length < 1) return

    let cancelled = false
    const timer = setTimeout(() => {
      const targetMarkets: MarketId[] = tab === 'watch' ? ['cn', 'hk', 'us', 'crypto'] : [tab]
      for (const m of targetMarkets) {
        fetchSymbols(m, raw)
          .then((items) => {
            if (cancelled || items.length === 0) return
            const valid = items.filter(it => it.symbol && it.name && !/\(A股\)|\(港股\)/.test(it.name)) // i18n-allow: 数据源占位名匹配谓词，非 UI 文案
            if (valid.length > 0) {
              updateDynamicCatalog(m, valid)
              setCatalogVersion(v => v + 1)
            }
          })
          .catch(() => {})
      }
    }, 200)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [draft, tab])

  // 参考序列（迷你走势 + 昨收兜底）：日内分钟线 60s 轮询；分钟线不可用（如腾讯
  // 公开端港股）降级日 K，TTL 内复用后再重试分钟线。prevClose 仅为快照缺官方锚点
  // 时的兜底，首次缺省时补拉一次日 K（日 K 序列可能缺最新收盘 bar，倒数第二根
  // 会错位一个交易日，故永远让位于 ticker.prevClose）。
  usePoll(async () => {
    if (rows.length === 0) return
    const now = Date.now()
    await Promise.all(rows.map(async (row) => {
      const key = rowKey(row.market, row.symbol)
      const cached = series[key]
      if (cached?.mode === 'daily' && now - cached.fetchedAt < SERIES_TTL_MS) return
      // 粒度自适应：已学过用学过的一档；否则按候选顺序试（腾讯 A 股无 1m 只有 5m）。
      const candidates = cached?.mode === 'intraday' && cached.interval !== undefined
        ? [cached.interval]
        : intradayCandidates(row.market)
      let storedIntraday = false
      for (const interval of candidates) {
        try {
          const req = intradayRequest(row.market, interval)
          const klines = await fetchKlines(row.market, row.symbol, req.interval, req.limit)
          const closes = selectIntradayCloses(row.market, klines)
          if (closes.length === 0) throw new Error('empty intraday series')
          setSeries((current) => ({
            ...current,
            [key]: { closes, prevClose: current[key]?.prevClose, fetchedAt: Date.now(), mode: 'intraday', interval },
          }))
          storedIntraday = true
          break
        } catch { /* 试下一档粒度 */ }
      }
      if (!storedIntraday) {
        try {
          const daily = await fetchKlines(row.market, row.symbol, '1d', DAILY_FALLBACK_LIMIT)
          if (daily.length === 0) return
          setSeries((current) => ({
            ...current,
            [key]: {
              closes: daily.map(candle => candle.close),
              prevClose: daily.length >= 2 ? daily[daily.length - 2]?.close : current[key]?.prevClose,
              fetchedAt: Date.now(),
              mode: 'daily',
            },
          }))
        } catch { /* 序列失败不影响报价行 */ }
      }
      // prevClose 兜底补拉（仅在缺省时；独立于走势成败）
      if (series[key]?.prevClose === undefined) {
        try {
          const pair = await fetchKlines(row.market, row.symbol, '1d', 2)
          const prevClose = pair.length >= 2 ? pair[pair.length - 2]?.close : undefined
          if (prevClose !== undefined) {
            setSeries((current) => current[key] === undefined ? current : ({
              ...current,
              [key]: { ...(current[key] as ReferenceSeries), prevClose },
            }))
          }
        } catch { /* 下轮再试 */ }
      }
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, SERIES_POLL_MS, [rowsKey])

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
            const rawDraft = draft.trim()
            if (rawDraft === '') return
            const raw = rawDraft.toUpperCase()
            const match = suggestions.find(s =>
              s.symbol.toUpperCase() === raw ||
              (s.name && s.name.toUpperCase() === raw)
            ) ?? suggestions.find(s =>
              s.symbol.toUpperCase().startsWith(raw) ||
              (s.name && s.name.toUpperCase().startsWith(raw))
            ) ?? (suggestions.length > 0 ? suggestions[0] : undefined)

            let symbol: string
            let market: MarketId
            let name: string | undefined

            if (match) {
              symbol = match.symbol
              market = match.market ?? target
              name = match.name
            } else {
              // 防呆：若输入包含中文但未在任何市场字典或在线检索中找到标的，杜绝将纯中文当作 symbol 提交导致后端报错
              if (/[\u4e00-\u9fa5]/.test(rawDraft)) return
              market = target
              if (target === 'cn' && /^\d{6}$/.test(raw)) {
                const isSh = raw.startsWith('6') || raw.startsWith('9') || raw.startsWith('5') || KNOWN_SH_INDICES.has(raw)
                symbol = `${raw}.${isSh ? 'SH' : 'SZ'}`
              } else if (target === 'hk' && /^\d{1,5}$/.test(raw)) {
                symbol = `${raw.padStart(5, '0')}.HK`
              } else {
                symbol = raw
              }
            }

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

      {/* 底部设置入口（3.0 自右缘竖条迁入）：沉底栏 + 更新提示点。 */}
      <div className={css.footBar}>
        <button
          type="button"
          className={css.settingsBtn}
          aria-label={t('entry.settings')}
          title={t('entry.settings')}
          onClick={() => { openSettings() }}
        >
          <IconSettings size={15} />
          <span>{t('entry.settings')}</span>
          {updateAvailable === true && <span className={css.badgeDot} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}
