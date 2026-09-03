import { useEffect, useMemo, useState } from 'react'
import type {
  FinancialIndicatorRow,
  FinancialReportGroup,
  FundamentalsPackage,
  StockFundamentals,
} from '@dsh-trading/api'
import { fetchFundamentals } from './api.ts'
import { readJson, type SelectionState } from './store.ts'
import { scaleLocaleOf } from './format.ts'
import type { Instrument, MarketId } from './types.ts'
import type { MarketLocaleKey } from './contract.ts'
import css from './fundamentals-stage.module.css'

export type UseStoreState<TState> = <TSelected>(selector: (state: TState) => TSelected) => TSelected

export interface FundamentalsStageProps {
  /** 行情词典翻译函数（dshtrading.market，shell 注入）。 */
  t: (key: MarketLocaleKey, params?: Record<string, unknown>) => string
  useSelection?: UseStoreState<SelectionState>
}

/** 数值紧凑单位（zh = 亿/万 中文惯例；en = B/M/K）。 */
export type NumberScaleLocale = 'zh' | 'en'

/** locale-aware 大数缩写：formatVal/formatCompact 等共用（en 走 B/M/K，与
 * format.ts fmtCompact 的 zh 分支同口径换算基准）。 */
export function formatScaled(value: number | undefined, locale: NumberScaleLocale, decimals = 2): string {
  if (value === undefined || Number.isNaN(value)) return '--'
  const abs = Math.abs(value)
  const trim = (text: string): string => text.includes('.') ? text.replace(/\.?0+$/, '') : text
  if (locale === 'zh') {
    if (abs >= 1e12) return `${(value / 1e12).toFixed(decimals)} 万亿` // i18n-allow: zh 数值单位常量（locale 数据）
    if (abs >= 1e8) return `${(value / 1e8).toFixed(decimals)} 亿` // i18n-allow: zh 数值单位常量（locale 数据）
    if (abs >= 1e4) return `${(value / 1e4).toFixed(decimals)} 万` // i18n-allow: zh 数值单位常量（locale 数据）
    return Number.isInteger(value) ? String(value) : value.toFixed(decimals)
  }
  if (abs >= 1e12) return `${trim((value / 1e12).toFixed(decimals))}T`
  if (abs >= 1e9) return `${trim((value / 1e9).toFixed(decimals))}B`
  if (abs >= 1e6) return `${trim((value / 1e6).toFixed(decimals))}M`
  if (abs >= 1e3) return `${trim((value / 1e3).toFixed(decimals))}K`
  return Number.isInteger(value) ? String(value) : value.toFixed(decimals)
}

function formatVal(val: number | undefined, unit?: string, isRatio = false, locale: NumberScaleLocale = 'zh'): string {
  if (val === undefined || Number.isNaN(val)) return '--'
  if (isRatio || unit === '%') return `${val.toFixed(2)}%`
  return formatScaled(val, locale)
}

export type NavSubCategory =
  | 'financials_key'
  | 'financials_income'
  | 'financials_balance'
  | 'financials_cashflow'
  | 'forecast'
  | 'reports'
  | 'valuation'
  | 'biz_segments'
  | 'biz_efficiency'
  | 'smart_shareholders'
  | 'smart_insider'
  | 'smart_institutional'
  | 'profile_overview'
  | 'profile_executives'
  | 'action_dividends'
  | 'action_buybacks'
  | 'action_splits'

function formatChange(change: number | undefined): { text: string; cls: string } {
  if (change === undefined || Number.isNaN(change)) return { text: '--', cls: css.valNeutral }
  const sign = change > 0 ? '+' : ''
  const text = `${sign}${change.toFixed(2)}%`
  if (change > 0) return { text, cls: css.valUp }
  if (change < 0) return { text, cls: css.valDown }
  return { text, cls: css.valNeutral }
}

export function FundamentalsStage({ t, useSelection }: FundamentalsStageProps) {
  // 数值单位 locale 跟随界面语言（词典哨兵键判定）：zh → 亿/万，en → B/M/K。
  const numLocale = scaleLocaleOf(t)
  const fv = (val: number | undefined, unit?: string, isRatio = false): string => formatVal(val, unit, isRatio, numLocale)
  const hookInstrument = useSelection?.(s => s.instrument)
  // localStorage 镜像只在缺失 hook 面时读一次（useEffect 每渲染 JSON.parse 是浪费）。
  const [storedInstrument] = useState(() => readJson<Instrument | null>('dshtrading.selection.v1', null))
  const instrument = hookInstrument ?? storedInstrument
  const market = (instrument?.market || 'cn') as MarketId
  const symbol = instrument?.symbol || ''

  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<FundamentalsPackage | undefined>(undefined)
  /** 请求代号：竞态守卫 + 错误路径归因（慢响应不得覆盖新标的的空态）。 */
  const [activeNav, setActiveNav] = useState<NavSubCategory>('financials_key')
  const [selectedIndicatorId, setSelectedIndicatorId] = useState<string>('bps')
  const [showYoY, setShowYoY] = useState(true)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [segmentFilter, setSegmentFilter] = useState<'all' | 'product' | 'industry' | 'region'>('all')

  useEffect(() => {
    if (!symbol) return
    let cancelled = false
    // 换标的立即清场：错误路径（桥业务错误/网络失败）绝不能保留上一个
    // 标的的数据——交易语境下「B 的代码显示 A 的财务」是致命误导。
    setData(undefined)
    setSelectedIndicatorId('bps')
    setCollapsedGroups({})
    setSegmentFilter('all')
    setLoading(true)

    fetchFundamentals(market, symbol)
      .then((pkg) => {
        if (cancelled) return
        setData(pkg)
        setLoading(false)
        const firstRow = pkg?.matrix?.groups?.[0]?.rows?.[0]
        if (firstRow) setSelectedIndicatorId(firstRow.id)
      })
      .catch(() => {
        // 失败 → 保持空态（setData(undefined) 已在上面执行），只停 spinner。
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [market, symbol])

  const matrix = data?.matrix
  const stock = (data?.stock ?? data) as unknown as StockFundamentals
  const crypto = data?.crypto
  const profile = data?.profile
  const forecast = data?.forecast
  const reports = data?.reports
  const mainOperations = data?.mainOperations
  const shareholders = data?.shareholders
  const dividends = data?.dividends
  const splits = data?.splits
  const buybacks = data?.buybacks
  const holderSummary = data?.holderSummary
  const efficiency = data?.efficiency
  const insiderTrades = data?.insiderTrades
  const institutionalHoldings = data?.institutionalHoldings

  // 财务大类下的 4 个报表科目过滤
  const displayGroups = useMemo<FinancialReportGroup[]>(() => {
    if (!matrix?.groups) return []
    if (activeNav === 'financials_key') return matrix.groups
    if (activeNav === 'financials_income') {
      return matrix.groups.filter(g => g.id === 'growth' || g.id === 'profitability')
    }
    if (activeNav === 'financials_balance') {
      return matrix.groups.filter(g => g.id === 'cash_debt' || g.id === 'per_share')
    }
    if (activeNav === 'financials_cashflow') {
      return matrix.groups.filter(g => g.id === 'cash_debt' || g.id === 'per_share')
        .map(g => ({
          ...g,
          rows: g.rows.filter(r => r.id.includes('cash') || r.id.includes('flow')),
        }))
        .filter(g => g.rows.length > 0)
    }
    return matrix.groups
  }, [matrix, activeNav])

  const switchNav = (nav: NavSubCategory) => {
    setActiveNav(nav)
    if (!matrix?.groups) return
    let targetRows: FinancialIndicatorRow[] = []
    if (nav === 'financials_income') {
      targetRows = matrix.groups.find(g => g.id === 'growth')?.rows ?? []
    } else if (nav === 'financials_balance') {
      targetRows = matrix.groups.find(g => g.id === 'cash_debt')?.rows ?? []
    } else if (nav === 'financials_cashflow') {
      const perShare = matrix.groups.find(g => g.id === 'per_share')
      targetRows = perShare?.rows.filter(r => r.id.includes('cash')) ?? []
    } else if (nav === 'financials_key') {
      targetRows = matrix.groups[0]?.rows ?? []
    }
    if (targetRows.length > 0 && targetRows[0]) {
      setSelectedIndicatorId(targetRows[0].id)
    }
  }

  // 查出当前上方图表正在绘制的指标行
  const activeIndicatorRow = useMemo<FinancialIndicatorRow | undefined>(() => {
    if (!displayGroups || displayGroups.length === 0) return undefined
    for (const group of displayGroups) {
      const found = group.rows.find(r => r.id === selectedIndicatorId)
      if (found) return found
    }
    return displayGroups[0]?.rows[0]
  }, [displayGroups, selectedIndicatorId])

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }))
  }

  // 主营构成过滤
  const filteredSegments = useMemo(() => {
    if (!mainOperations) return []
    if (segmentFilter === 'all') return mainOperations
    return mainOperations.filter(s => s.classification === segmentFilter)
  }, [mainOperations, segmentFilter])

  if (!symbol) {
    return (
      <div className={css.emptyState}>
        <span>{t('fund.page.empty')}</span>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className={css.loadingState}>
        <div className={css.spinner} />
        <span>{t('fund.page.loading', { symbol })}</span>
      </div>
    )
  }

  return (
    <div className={css.root} data-dshtrading-fundamentals="">
      {/* 顶部标的报价与核心估值指标栏 */}
      <div className={css.topBar}>
        <div className={css.symbolInfo}>
          <span className={css.symbolCode}>{symbol}</span>
          <span className={css.symbolName}>{stock?.name ?? profile?.name ?? symbol}</span>
          <span className={css.marketBadge}>{market}</span>
        </div>
        <div className={css.valuationPills}>
          {stock?.peTtm !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>{t('fund.pill.peTtm')}</span>
              <span className={css.pillValue}>{stock.peTtm.toFixed(2)}</span>
            </div>
          )}
          {stock?.peDynamic !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>{t('fund.pill.peDynamic')}</span>
              <span className={css.pillValue}>{stock.peDynamic.toFixed(2)}</span>
            </div>
          )}
          {stock?.pb !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>{t('fund.pill.pb')}</span>
              <span className={css.pillValue}>{stock.pb.toFixed(2)}</span>
            </div>
          )}
          {stock?.marketCap !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>{t('fund.pill.marketCap')}</span>
              <span className={css.pillValue}>{fv(stock.marketCap)}</span>
            </div>
          )}
          {stock?.dividendYield !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>{t('fund.pill.dividendYield')}</span>
              <span className={css.pillValue}>{(stock.dividendYield * (stock.dividendYield < 1 ? 100 : 1)).toFixed(2)}%</span>
            </div>
          )}
          {stock?.turnoverRate !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>{t('fund.pill.turnover')}</span>
              <span className={css.pillValue}>{stock.turnoverRate.toFixed(2)}%</span>
            </div>
          )}
          {crypto?.marketCapUsd !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>{t('fund.pill.floatCap')}</span>
              <span className={css.pillValue}>${fv(crypto.marketCapUsd)}</span>
            </div>
          )}
          {crypto?.rank !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>{t('fund.pill.rank')}</span>
              <span className={css.pillValue}>#{crypto.rank}</span>
            </div>
          )}
        </div>
      </div>

      {/* 主工作台：左侧 8 大分类导航树 + 右侧多视图内容区 */}
      <div className={css.mainContainer}>
        {/* 左侧富途原生 8 大分类导航树 */}
        <div className={css.navTree} role="tablist">
          {/* 1. 财务 */}
          <div className={css.navGroupTitle}>
            <span className={css.navGroupDot} />
            <span>{t('fund.nav.financials')}</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'financials_key'}
            onClick={() => switchNav('financials_key')}
          >
            {activeNav === 'financials_key' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.key')}</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'financials_income'}
            onClick={() => switchNav('financials_income')}
          >
            {activeNav === 'financials_income' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.income')}</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'financials_balance'}
            onClick={() => switchNav('financials_balance')}
          >
            {activeNav === 'financials_balance' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.balance')}</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'financials_cashflow'}
            onClick={() => switchNav('financials_cashflow')}
          >
            {activeNav === 'financials_cashflow' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.cashflow')}</span>
          </button>

          {/* 2. 预测 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>{t('fund.nav.forecast')}</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'forecast'}
            onClick={() => switchNav('forecast')}
          >
            {activeNav === 'forecast' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.forecastItem')}</span>
          </button>

          {/* 3. 晨星研报 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>{t('fund.nav.reports')}</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'reports'}
            onClick={() => switchNav('reports')}
          >
            {activeNav === 'reports' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.reportsItem')}</span>
          </button>

          {/* 4. 估值 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>{t('fund.nav.valuation')}</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'valuation'}
            onClick={() => switchNav('valuation')}
          >
            {activeNav === 'valuation' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.valuationItem')}</span>
          </button>

          {/* 5. 经营分析 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>{t('fund.nav.biz')}</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'biz_segments'}
            onClick={() => switchNav('biz_segments')}
          >
            {activeNav === 'biz_segments' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.bizSegments')}</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'biz_efficiency'}
            onClick={() => switchNav('biz_efficiency')}
          >
            {activeNav === 'biz_efficiency' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.bizEfficiency')}</span>
          </button>

          {/* 6. 聪明钱 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>{t('fund.nav.smartMoney')}</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'smart_shareholders'}
            onClick={() => switchNav('smart_shareholders')}
          >
            {activeNav === 'smart_shareholders' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.shareholders')}</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'smart_insider'}
            onClick={() => switchNav('smart_insider')}
          >
            {activeNav === 'smart_insider' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.insider')}</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'smart_institutional'}
            onClick={() => switchNav('smart_institutional')}
          >
            {activeNav === 'smart_institutional' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.institutional')}</span>
          </button>

          {/* 7. 简况 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>{t('fund.nav.profile')}</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'profile_overview'}
            onClick={() => switchNav('profile_overview')}
          >
            {activeNav === 'profile_overview' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.profileOverview')}</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'profile_executives'}
            onClick={() => switchNav('profile_executives')}
          >
            {activeNav === 'profile_executives' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.profileExecutives')}</span>
          </button>

          {/* 8. 公司行动 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>{t('fund.nav.actions')}</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'action_dividends'}
            onClick={() => switchNav('action_dividends')}
          >
            {activeNav === 'action_dividends' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.dividends')}</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'action_buybacks'}
            onClick={() => switchNav('action_buybacks')}
          >
            {activeNav === 'action_buybacks' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.buybacks')}</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'action_splits'}
            onClick={() => switchNav('action_splits')}
          >
            {activeNav === 'action_splits' && <span className={css.navDotActive} />}
            <span>{t('fund.nav.splits')}</span>
          </button>
        </div>

        {/* 右侧主工作台内容区 */}
        <div className={css.stageContent}>
          {/* 1. 财务大类视图（关键指标 / 利润表 / 资产负债表 / 现金流量表） */}
          {(activeNav === 'financials_key' || activeNav === 'financials_income' || activeNav === 'financials_balance' || activeNav === 'financials_cashflow') && (
            <>
              {/* 上方交互趋势图卡片 */}
              {matrix && matrix.periods.length > 0 && activeIndicatorRow && (
                <div className={css.chartCard}>
                  <div className={css.chartHeader}>
                    <div className={css.reportLink}>
                      <span className={css.reportIcon}>📄</span>
                      <span>{matrix.latestReportTitle ?? t('fund.chart.reportTitle', { period: matrix.periods[matrix.periods.length - 1] ?? '' })} &gt;</span>
                    </div>
                    <div className={css.chartControls}>
                      <div
                        className={css.controlBadge}
                        onClick={() => setShowYoY(v => !v)}
                        role="button"
                        tabIndex={0}
                      >
                        <span>{t('fund.chart.showYoy', { state: showYoY ? t('fund.switch.on') : t('fund.switch.off') })}</span>
                      </div>
                    </div>
                  </div>

                  <div className={css.chartLegend}>
                    <div className={css.legendBar}>
                      <span className={css.legendBarBox} />
                      <span>{activeIndicatorRow.name} {activeIndicatorRow.unit ? `(${activeIndicatorRow.unit})` : ''}</span>
                    </div>
                    {showYoY && (
                      <div className={css.legendLine}>
                        <span className={css.legendLineBox} />
                        <span>{t('fund.chart.yoyLegend')}</span>
                      </div>
                    )}
                  </div>

                  {/* SVG 柱状图 + 同比折线联动 */}
                  <FundamentalsSvgChart
                    row={activeIndicatorRow}
                    periods={matrix.periods}
                    showYoY={showYoY}
                  />
                </div>
              )}

              {/* 下方多期财务指标矩阵表卡片 */}
              {matrix && matrix.periods.length > 0 ? (
                <div className={css.tableCard}>
                  <div className={css.tableHeaderBar}>
                    <span>{t('fund.matrix.currency', { currency: matrix.currency })}</span>
                    <span>{t('fund.matrix.clickHint')}</span>
                  </div>
                  <div className={css.tableScrollWrap}>
                    <table className={css.matrixTable}>
                      <thead>
                        <tr>
                          <th>{t('fund.matrix.indicator')}</th>
                          {matrix.periods.map(p => (
                            <th key={p}>{p}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {displayGroups.map(group => {
                          const isCollapsed = collapsedGroups[group.id] === true
                          return (
                            <GroupFragment
                              key={group.id}
                              group={group}
                              periods={matrix.periods}
                              isCollapsed={isCollapsed}
                              selectedIndicatorId={selectedIndicatorId}
                              onToggleGroup={() => toggleGroup(group.id)}
                              onSelectIndicator={(id) => setSelectedIndicatorId(id)}
                            />
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className={css.infoCard}>
                  <span className={css.cardTitle}>{t('fund.matrix.emptyTitle')}</span>
                  <p className={css.descText}>
                    {t('fund.matrix.emptyHint')}
                  </p>
                </div>
              )}
            </>
          )}

          {/* 2. 预测 Tab */}
          {activeNav === 'forecast' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.forecast.title')}</span>
                <span className={css.cardSubNote}>{t('fund.forecast.subtitle')}</span>
              </div>

              {forecast?.items && forecast.items.length > 0 ? (
                <>
                  <div className={css.forecastGrid}>
                    <div className={css.forecastStatBox}>
                      <span className={css.gridLabel}>{t('fund.forecast.epsCurrent')}</span>
                      <span className={css.pillValue} style={{ fontSize: 18, color: 'var(--futu-accent)' }}>
                        {forecast.epsCurrentYear !== undefined ? `¥${forecast.epsCurrentYear.toFixed(2)}` : '--'}
                      </span>
                    </div>
                    <div className={css.forecastStatBox}>
                      <span className={css.gridLabel}>{t('fund.forecast.epsNext')}</span>
                      <span className={css.pillValue} style={{ fontSize: 18, color: 'var(--futu-orange)' }}>
                        {forecast.epsNextYear !== undefined ? `¥${forecast.epsNextYear.toFixed(2)}` : '--'}
                      </span>
                    </div>
                    <div className={css.forecastStatBox}>
                      <span className={css.gridLabel}>{t('fund.forecast.targetPrice')}</span>
                      <span className={css.pillValue} style={{ fontSize: 18 }}>
                        {forecast.targetPriceAvg !== undefined ? `¥${forecast.targetPriceAvg.toFixed(2)}` : '--'}
                      </span>
                    </div>
                    <div className={css.forecastStatBox}>
                      <span className={css.gridLabel}>{t('fund.forecast.orgCount')}</span>
                      <span className={css.pillValue} style={{ fontSize: 18 }}>
                        {forecast.totalOrgs ?? forecast.items.length} {t('fund.unit.orgs')}
                      </span>
                    </div>
                  </div>

                  <div className={css.tableScrollWrap} style={{ marginTop: 14 }}>
                    <table className={css.matrixTable}>
                      <thead>
                        <tr>
                          <th>{t('fund.forecast.col.year')}</th>
                          <th>{t('fund.forecast.col.eps')}</th>
                          <th>{t('fund.forecast.col.revenue')}</th>
                          <th>{t('fund.forecast.col.netProfit')}</th>
                          <th>{t('fund.forecast.col.orgs')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {forecast.items.map(item => (
                          <tr key={item.year} className={css.indicatorRow}>
                            <td><strong>{item.year}</strong></td>
                            <td style={{ color: 'var(--futu-accent)', fontWeight: 600 }}>¥{item.eps.toFixed(2)}</td>
                            <td>{fv(item.revenue * 100_000_000)}</td>
                            <td>{fv(item.netProfit * 100_000_000)}</td>
                            <td>{item.orgCount ?? '--'} {t('fund.unit.orgs')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <p className={css.descText}>
                  {t('fund.forecast.empty')}
                </p>
              )}
            </div>
          )}

          {/* 3. 晨星研报 / 研报 Tab */}
          {activeNav === 'reports' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.reports.title')}</span>
                <span className={css.cardSubNote}>{t('fund.reports.subtitle')}</span>
              </div>

              {reports && reports.length > 0 ? (
                <div className={css.reportsList}>
                  {reports.map(rep => (
                    <div key={rep.id} className={css.reportItemCard}>
                      <div className={css.reportTopRow}>
                        <span className={css.reportOrg}>{rep.orgName}</span>
                        {rep.rating && <span className={css.reportRating}>{rep.rating}</span>}
                        <span className={css.reportDate}>{rep.publishDate}</span>
                      </div>
                      <div className={css.reportTitle}>
                        {rep.url ? (
                          <a href={rep.url} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
                            {rep.title} ↗
                          </a>
                        ) : rep.title}
                      </div>
                      {rep.summary && <p className={css.reportSummary}>{rep.summary}</p>}
                      {rep.author && <div className={css.reportAuthor}>{t('fund.reports.analyst', { author: rep.author })}</div>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className={css.descText}>
                  {t('fund.reports.empty')}
                </p>
              )}
            </div>
          )}

          {/* 4. 估值 Tab */}
          {activeNav === 'valuation' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.valuation.title')}</span>
                <span className={css.cardSubNote}>{t('fund.valuation.subtitle')}</span>
              </div>

              {/* 52 周区间与 PE 评注：价格未进入本组件（基本面快照无现价字段），
                  不渲染位置指针——不做 PE 分档假水位（2026-09-02 审查整改）。 */}
              {stock?.fiftyTwoWeekLow !== undefined && stock?.fiftyTwoWeekHigh !== undefined && (
                <div className={css.rangeGaugeWrap}>
                  <div className={css.rangePointerInfo}>
                    <span>{t('fund.valuation.range52w')}</span>
                    <span>
                      {stock.fiftyTwoWeekLow.toFixed(2)} ~ {stock.fiftyTwoWeekHigh.toFixed(2)}
                    </span>
                  </div>
                  <div className={css.rangeGaugeLabels}>
                    <span>{t('fund.valuation.low52w', { price: stock.fiftyTwoWeekLow.toFixed(2) })}</span>
                    <span>
                      {t('fund.valuation.peNote', { note: stock.peTtm !== undefined ? (stock.peTtm < 15 ? t('fund.valuation.undervalued') : stock.peTtm < 30 ? t('fund.valuation.fair') : t('fund.valuation.overvalued')) : t('fund.valuation.assessing') })}
                    </span>
                    <span>{t('fund.valuation.high52w', { price: stock.fiftyTwoWeekHigh.toFixed(2) })}</span>
                  </div>
                </div>
              )}

              <div className={css.gridCols}>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.valuation.peTtm')}</span>
                  <span className={css.gridValue}>{stock?.peTtm !== undefined ? stock.peTtm.toFixed(2) : '--'}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.valuation.peDynamic')}</span>
                  <span className={css.gridValue}>{stock?.peDynamic !== undefined ? stock.peDynamic.toFixed(2) : '--'}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.valuation.peStatic')}</span>
                  <span className={css.gridValue}>{stock?.peStatic !== undefined ? stock.peStatic.toFixed(2) : '--'}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.valuation.pb')}</span>
                  <span className={css.gridValue}>{stock?.pb !== undefined ? stock.pb.toFixed(2) : '--'}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.valuation.marketCap')}</span>
                  <span className={css.gridValue}>{fv(stock?.marketCap)}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.valuation.floatCap')}</span>
                  <span className={css.gridValue}>{fv(stock?.floatMarketCap)}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.valuation.dividendYield')}</span>
                  <span className={css.gridValue}>{stock?.dividendYield !== undefined ? `${(stock.dividendYield * (stock.dividendYield < 1 ? 100 : 1)).toFixed(2)}%` : '--'}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.valuation.turnover')}</span>
                  <span className={css.gridValue}>{stock?.turnoverRate !== undefined ? `${stock.turnoverRate.toFixed(2)}%` : '--'}</span>
                </div>
              </div>
            </div>
          )}

          {/* 5. 经营分析 - 主营构成 */}
          {activeNav === 'biz_segments' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.segments.title')}</span>
                <span className={css.cardSubNote}>{t('fund.segments.subtitle')}</span>
              </div>

              <div className={css.tabButtonGroup} style={{ marginBottom: 12 }}>
                <button
                  type="button"
                  className={css.segmentFilterBtn}
                  data-active={segmentFilter === 'all'}
                  onClick={() => setSegmentFilter('all')}
                >
                  {t('fund.segments.all')}
                </button>
                <button
                  type="button"
                  className={css.segmentFilterBtn}
                  data-active={segmentFilter === 'product'}
                  onClick={() => setSegmentFilter('product')}
                >
                  {t('fund.segments.byProduct')}
                </button>
                <button
                  type="button"
                  className={css.segmentFilterBtn}
                  data-active={segmentFilter === 'industry'}
                  onClick={() => setSegmentFilter('industry')}
                >
                  {t('fund.segments.byIndustry')}
                </button>
                <button
                  type="button"
                  className={css.segmentFilterBtn}
                  data-active={segmentFilter === 'region'}
                  onClick={() => setSegmentFilter('region')}
                >
                  {t('fund.segments.byRegion')}
                </button>
              </div>

              {filteredSegments.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th>{t('fund.segments.col.segment')}</th>
                        <th>{t('fund.segments.col.revenue')}</th>
                        <th>{t('fund.segments.col.revenueRatio')}</th>
                        <th>{t('fund.segments.col.profit')}</th>
                        <th>{t('fund.segments.col.grossMargin')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSegments.map(seg => (
                        <tr key={seg.segmentName + seg.classification} className={css.indicatorRow}>
                          <td><strong>{seg.segmentName}</strong></td>
                          <td>{formatVal(seg.revenue)}</td>
                          <td>
                            <div className={css.ratioBarWrap}>
                              <div className={css.ratioBar} style={{ width: `${Math.min(100, Math.max(2, seg.revenueRatio))}%` }} />
                              <span>{seg.revenueRatio.toFixed(2)}%</span>
                            </div>
                          </td>
                          <td>{seg.grossProfit ? formatVal(seg.grossProfit) : '--'}</td>
                          <td style={{ color: seg.grossMargin && seg.grossMargin > 0 ? 'var(--futu-up)' : 'inherit' }}>
                            {seg.grossMargin ? `${seg.grossMargin.toFixed(2)}%` : '--'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={css.descText}>
                  {t('fund.segments.empty')}
                </p>
              )}
            </div>
          )}

          {/* 5. 经营分析 - 经营效率 */}
          {activeNav === 'biz_efficiency' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.efficiency.title')}</span>
                <span className={css.cardSubNote}>{t('fund.efficiency.subtitle')}</span>
              </div>
              <div className={css.gridCols}>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.efficiency.inventoryDays')}</span>
                  <span className={css.gridValue} style={{ color: 'var(--futu-accent)', fontWeight: 600 }}>
                    {efficiency?.inventoryTurnoverDays ? t('fund.unit.days', { n: efficiency.inventoryTurnoverDays.toFixed(1) }) : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.efficiency.receivableDays')}</span>
                  <span className={css.gridValue} style={{ color: 'var(--futu-accent)', fontWeight: 600 }}>
                    {efficiency?.accountsReceivableTurnoverDays ? t('fund.unit.days', { n: efficiency.accountsReceivableTurnoverDays.toFixed(1) }) : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.efficiency.operatingCycle')}</span>
                  <span className={css.gridValue}>
                    {efficiency?.operatingCycleDays ? t('fund.unit.days', { n: efficiency.operatingCycleDays.toFixed(1) }) : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.efficiency.assetTurnover')}</span>
                  <span className={css.gridValue}>
                    {efficiency?.totalAssetTurnover ? t('fund.unit.times', { n: efficiency.totalAssetTurnover.toFixed(2) }) : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.efficiency.grossMargin')}</span>
                  <span className={css.gridValue}>
                    {efficiency?.grossProfitMargin ? `${efficiency.grossProfitMargin.toFixed(2)}%` : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.efficiency.netMargin')}</span>
                  <span className={css.gridValue}>
                    {efficiency?.netProfitMargin ? `${efficiency.netProfitMargin.toFixed(2)}%` : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.efficiency.currentRatio')}</span>
                  <span className={css.gridValue}>
                    {efficiency?.currentRatio ? efficiency.currentRatio.toFixed(2) : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.efficiency.quickRatio')}</span>
                  <span className={css.gridValue}>
                    {efficiency?.quickRatio ? efficiency.quickRatio.toFixed(2) : '--'}
                  </span>
                </div>
              </div>
              <p className={css.descText} style={{ marginTop: 14 }}>
                {efficiency?.inventoryTurnoverDays !== undefined && efficiency?.accountsReceivableTurnoverDays !== undefined ? (
                  t('fund.efficiency.summary', {
                    inventory: efficiency.inventoryTurnoverDays.toFixed(1),
                    receivable: efficiency.accountsReceivableTurnoverDays.toFixed(1),
                    cycle: efficiency.operatingCycleDays !== undefined ? efficiency.operatingCycleDays.toFixed(1) : '--',
                  })
                ) : (
                  t('fund.efficiency.empty')
                )}
              </p>
            </div>
          )}

          {/* 6. 聪明钱 - 股东持股 */}
          {activeNav === 'smart_shareholders' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.holders.title')}</span>
                <span className={css.cardSubNote}>{t('fund.holders.subtitle')}</span>
              </div>

              {holderSummary && (
                <div className={css.forecastGrid} style={{ marginBottom: 14 }}>
                  <div className={css.forecastStatBox}>
                    <span className={css.gridLabel}>{t('fund.holders.totalHolders')}</span>
                    <span className={css.pillValue} style={{ fontSize: 16, color: 'var(--futu-accent)' }}>
                      {holderSummary.totalHolders ? t('fund.unit.holders', { n: (holderSummary.totalHolders / 10_000).toFixed(2) }) : '--'}
                    </span>
                  </div>
                  <div className={css.forecastStatBox}>
                    <span className={css.gridLabel}>{t('fund.holders.avgShares')}</span>
                    <span className={css.pillValue} style={{ fontSize: 16 }}>
                      {holderSummary.avgFreeShares ? t('fund.unit.shares', { n: holderSummary.avgFreeShares.toLocaleString() }) : '--'}
                    </span>
                  </div>
                  <div className={css.forecastStatBox}>
                    <span className={css.gridLabel}>{t('fund.holders.avgValue')}</span>
                    <span className={css.pillValue} style={{ fontSize: 16 }}>
                      {holderSummary.avgHoldAmount ? t('fund.unit.wanCny', { n: (holderSummary.avgHoldAmount / 10_000).toFixed(2) }) : '--'}
                    </span>
                  </div>
                  <div className={css.forecastStatBox}>
                    <span className={css.gridLabel}>{t('fund.holders.concentration')}</span>
                    <span className={css.pillValue} style={{ fontSize: 16, color: 'var(--futu-orange)' }}>
                      {holderSummary.concentration ?? t('fund.holders.moderate')}
                    </span>
                  </div>
                </div>
              )}
              {shareholders && shareholders.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}>{t('fund.holders.col.rank')}</th>
                        <th>{t('fund.holders.col.name')}</th>
                        <th>{t('fund.holders.col.shares')}</th>
                        <th>{t('fund.holders.col.ratio')}</th>
                        <th>{t('fund.holders.col.change')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shareholders.map((sh, idx) => {
                        const isUp = sh.change?.includes('+') || (Number(sh.change) > 0)
                        const isDown = sh.change?.includes('-') || (Number(sh.change) < 0)
                        return (
                          <tr key={sh.name}>
                            <td><span className={css.holderRank}>{idx + 1}</span></td>
                            <td className={css.holderName}>{sh.name}</td>
                            <td>{sh.shares !== undefined ? fv(sh.shares) : '--'}</td>
                            <td>{sh.ratio !== undefined ? `${sh.ratio.toFixed(2)}%` : '--'}</td>
                            <td>
                              {isUp ? (
                                <span className={css.changeTagUp}>{sh.change}</span>
                              ) : isDown ? (
                                <span className={css.changeTagDown}>{sh.change}</span>
                              ) : (
                                <span className={css.changeTagFlat}>{sh.change || t('fund.holders.unchanged')}</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={css.descText}>
                  {t('fund.holders.empty')}
                </p>
              )}
            </div>
          )}

          {/* 6. 聪明钱 - 股东增减持 */}
          {activeNav === 'smart_insider' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.insider.title')}</span>
                <span className={css.cardSubNote}>{t('fund.insider.subtitle')}</span>
              </div>
              {insiderTrades && insiderTrades.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th>{t('fund.insider.col.holder')}</th>
                        <th>{t('fund.insider.col.type')}</th>
                        <th>{t('fund.insider.col.shares')}</th>
                        <th>{t('fund.insider.col.ratio')}</th>
                        <th>{t('fund.insider.col.date')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insiderTrades.map((it, idx) => {
                        const isUp = it.changeType.includes('+') || it.changeType === '新进' || it.changeType.includes('增') // i18n-allow: 数据源中文枚举值匹配谓词，非 UI 文案
                        const isDown = it.changeType.includes('-') || it.changeType.includes('减') // i18n-allow: 数据源中文枚举值匹配谓词，非 UI 文案
                        return (
                          <tr key={it.holderName + idx} className={css.indicatorRow}>
                            <td className={css.holderName}>{it.holderName}</td>
                            <td>
                              {isUp ? (
                                <span className={css.changeTagUp}>{it.changeType}</span>
                              ) : isDown ? (
                                <span className={css.changeTagDown}>{it.changeType}</span>
                              ) : (
                                <span className={css.changeTagFlat}>{it.changeType}</span>
                              )}
                            </td>
                            <td>{it.changeShares ? fv(it.changeShares) : '--'}</td>
                            <td>{it.postHoldingRatio !== undefined ? `${it.postHoldingRatio.toFixed(2)}%` : '--'}</td>
                            <td>{it.date ?? '--'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={css.descText}>
                  {t('fund.insider.empty')}
                </p>
              )}
            </div>
          )}

          {/* 6. 聪明钱 - 机构持股 */}
          {activeNav === 'smart_institutional' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.institutional.title')}</span>
                <span className={css.cardSubNote}>{t('fund.institutional.subtitle')}</span>
              </div>
              {institutionalHoldings && institutionalHoldings.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th>{t('fund.institutional.col.org')}</th>
                        <th>{t('fund.institutional.col.type')}</th>
                        <th>{t('fund.institutional.col.shares')}</th>
                        <th>{t('fund.institutional.col.ratio')}</th>
                        <th>{t('fund.institutional.col.value')}</th>
                        <th>{t('fund.institutional.col.change')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {institutionalHoldings.map((inst, idx) => {
                        const isUp = inst.change?.includes('+') || (Number(inst.change) > 0)
                        const isDown = inst.change?.includes('-') || (Number(inst.change) < 0)
                        return (
                          <tr key={inst.orgName ?? String(idx)} className={css.indicatorRow}>
                            <td className={css.holderName}>{inst.orgName}</td>
                            <td><span className={css.reportRating}>{inst.orgType}</span></td>
                            <td>{inst.holdingShares ? fv(inst.holdingShares) : '--'}</td>
                            <td>{inst.holdingRatio ? `${inst.holdingRatio.toFixed(2)}%` : '--'}</td>
                            <td>{inst.marketCap ? t('fund.unit.yiCny', { n: (inst.marketCap / 100_000_000).toFixed(2) }) : '--'}</td>
                            <td>
                              {isUp ? (
                                <span className={css.changeTagUp}>{inst.change}</span>
                              ) : isDown ? (
                                <span className={css.changeTagDown}>{inst.change}</span>
                              ) : (
                                <span className={css.changeTagFlat}>{inst.change || t('fund.holders.unchanged')}</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={css.descText}>
                  {t('fund.institutional.empty')}
                </p>
              )}
            </div>
          )}

          {/* 7. 简况 - 公司概况 */}
          {activeNav === 'profile_overview' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.profile.title')}</span>
                <span className={css.cardSubNote}>{t('fund.profile.subtitle')}</span>
              </div>
              <div className={css.gridCols}>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.profile.fullName')}</span>
                  <span className={css.gridValue}>{profile?.fullName ?? profile?.name ?? stock?.name ?? symbol}</span>
                </div>
                {profile?.nameEn && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>{t('fund.profile.nameEn')}</span>
                    <span className={css.gridValue}>{profile.nameEn}</span>
                  </div>
                )}
                {profile?.industry && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>{t('fund.profile.industry')}</span>
                    <span className={css.gridValue}>{profile.industry}</span>
                  </div>
                )}
                {profile?.registeredCapital && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>{t('fund.profile.registeredCapital')}</span>
                    <span className={css.gridValue}>{profile.registeredCapital}</span>
                  </div>
                )}
                {profile?.employeeCount && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>{t('fund.profile.employees')}</span>
                    <span className={css.gridValue}>{profile.employeeCount}</span>
                  </div>
                )}
                {profile?.address && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>{t('fund.profile.address')}</span>
                    <span className={css.gridValue} style={{ fontSize: 12 }}>{profile.address}</span>
                  </div>
                )}
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>{t('fund.profile.website')}</span>
                  <span className={css.gridValue}>
                    {profile?.website ? (
                      <a href={profile.website} target="_blank" rel="noreferrer" style={{ color: 'var(--futu-accent)', textDecoration: 'none' }}>
                        {profile.website} ↗
                      </a>
                    ) : '--'}
                  </span>
                </div>
              </div>

              <div>
                <span className={css.gridLabel} style={{ display: 'block', marginBottom: 6 }}>{t('fund.profile.description')}</span>
                <p className={css.descText}>
                  {profile?.description ?? t('fund.profile.descriptionFallback', { symbol })}
                </p>
              </div>
            </div>
          )}

          {/* 7. 简况 - 公司高管 */}
          {activeNav === 'profile_executives' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.executives.title')}</span>
                <span className={css.cardSubNote}>{t('fund.executives.subtitle')}</span>
              </div>
              <div className={css.gridCols}>
                {profile?.chairman && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>{t('fund.executives.chairman')}</span>
                    <span className={css.gridValue} style={{ fontWeight: 600 }}>{profile.chairman}</span>
                  </div>
                )}
                {profile?.generalManager && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>{t('fund.executives.generalManager')}</span>
                    <span className={css.gridValue} style={{ fontWeight: 600 }}>{profile.generalManager}</span>
                  </div>
                )}
                {profile?.legalRepresentative && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>{t('fund.executives.legalRep')}</span>
                    <span className={css.gridValue}>{profile.legalRepresentative}</span>
                  </div>
                )}
                {profile?.boardSecretary && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>{t('fund.executives.boardSecretary')}</span>
                    <span className={css.gridValue}>{profile.boardSecretary}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 8. 公司行动 - 分红派息 */}
          {activeNav === 'action_dividends' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.dividends.title')}</span>
                <span className={css.cardSubNote}>{t('fund.dividends.subtitle')}</span>
              </div>
              {dividends && dividends.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th>{t('fund.dividends.col.year')}</th>
                        <th>{t('fund.dividends.col.plan')}</th>
                        <th>{t('fund.dividends.col.cash')}</th>
                        <th>{t('fund.dividends.col.exDate')}</th>
                        <th>{t('fund.dividends.col.recordDate')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dividends.map((div, i) => (
                        <tr key={div.planYear + i} className={css.indicatorRow}>
                          <td><strong>{div.planYear}</strong></td>
                          <td>{div.dividendPlan}</td>
                          <td style={{ color: 'var(--futu-accent)', fontWeight: 600 }}>
                            {div.cashDividend !== undefined ? `¥${div.cashDividend.toFixed(3)}` : '--'}
                          </td>
                          <td>{div.exDividendDate ?? '--'}</td>
                          <td>{div.recordDate ?? '--'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={css.descText}>
                  {t('fund.dividends.empty')}
                </p>
              )}
            </div>
          )}

          {/* 8. 公司行动 - 回购 */}
          {activeNav === 'action_buybacks' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.buybacks.title')}</span>
                <span className={css.cardSubNote}>{t('fund.buybacks.subtitle')}</span>
              </div>
              {buybacks && buybacks.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th>{t('fund.buybacks.col.date')}</th>
                        <th>{t('fund.buybacks.col.amount')}</th>
                        <th>{t('fund.buybacks.col.shares')}</th>
                        <th>{t('fund.buybacks.col.priceRange')}</th>
                        <th>{t('fund.buybacks.col.status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {buybacks.map((bb, idx) => (
                        <tr key={bb.date + idx} className={css.indicatorRow}>
                          <td><strong>{bb.date}</strong></td>
                          <td>{bb.buybackAmount ? t('fund.unit.yiCny', { n: (bb.buybackAmount / 100_000_000).toFixed(2) }) : '--'}</td>
                          <td>{bb.buybackShares ? fv(bb.buybackShares) : '--'}</td>
                          <td>{bb.priceRange ?? '--'}</td>
                          <td><span className={css.reportRating}>{bb.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={css.descText}>
                  {t('fund.buybacks.empty')}
                </p>
              )}
            </div>
          )}

          {/* 8. 公司行动 - 拆股并股 / 送转 */}
          {activeNav === 'action_splits' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>{t('fund.splits.title')}</span>
                <span className={css.cardSubNote}>{t('fund.splits.subtitle')}</span>
              </div>
              {splits && splits.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th>{t('fund.splits.col.date')}</th>
                        <th>{t('fund.splits.col.ratio')}</th>
                        <th>{t('fund.splits.col.description')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {splits.map((sp, idx) => (
                        <tr key={sp.date + idx} className={css.indicatorRow}>
                          <td><strong>{sp.date}</strong></td>
                          <td style={{ color: 'var(--futu-accent)', fontWeight: 600 }}>{sp.ratio}</td>
                          <td>{sp.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={css.descText}>
                  {t('fund.splits.empty')}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 分组展开渲染行 */
function GroupFragment({
  group,
  periods,
  isCollapsed,
  selectedIndicatorId,
  onToggleGroup,
  onSelectIndicator,
}: {
  group: FinancialReportGroup
  periods: string[]
  isCollapsed?: boolean
  selectedIndicatorId: string
  onToggleGroup: () => void
  onSelectIndicator: (id: string) => void
}) {
  return (
    <>
      <tr className={css.groupRow} onClick={onToggleGroup}>
        <td colSpan={periods.length + 1}>
          <span>{isCollapsed ? '▶' : '▼'} {group.title}</span>
        </td>
      </tr>
      {!isCollapsed && group.rows.map((row) => {
        const isSelected = row.id === selectedIndicatorId
        return (
          <tr
            key={row.id}
            className={css.indicatorRow}
            data-active={isSelected ? 'true' : undefined}
            onClick={() => onSelectIndicator(row.id)}
          >
            <td>
              <div className={css.indicatorName}>
                <span className={css.indicatorDot} />
                <span>{row.name} {row.unit ? `(${row.unit})` : ''}</span>
              </div>
            </td>
            {periods.map((p) => {
              const cell = row.values[p]
              const changeInfo = formatChange(cell?.changePercent)
              return (
                <td key={p}>
                  <div className={css.cellValue}>{formatVal(cell?.value, row.unit)}</div>
                  {cell?.changePercent !== undefined && (
                    <div className={`${css.cellChange} ${changeInfo.cls}`}>{changeInfo.text}</div>
                  )}
                </td>
              )
            })}
          </tr>
        )
      })}
    </>
  )
}

/** 轻量高性能 SVG 柱状图 + 同比增速折线图组件 */
function FundamentalsSvgChart({
  row,
  periods,
  showYoY,
}: {
  row: FinancialIndicatorRow
  periods: string[]
  showYoY: boolean
}) {
  const vals = periods.map(p => row.values[p]?.value ?? 0)
  const yoys = periods.map(p => row.values[p]?.changePercent ?? 0)

  const maxVal = Math.max(...vals, 0.001)
  const minVal = Math.min(...vals, 0)
  const valRange = maxVal - minVal || 1

  const maxYoy = Math.max(...yoys, 10)
  const minYoy = Math.min(...yoys, -10)
  const yoyRange = maxYoy - minYoy || 1

  const width = 600
  const height = 150
  const paddingLeft = 40
  const paddingRight = 40
  const paddingTop = 20
  const paddingBottom = 25
  const chartWidth = width - paddingLeft - paddingRight
  const chartHeight = height - paddingTop - paddingBottom

  const step = periods.length > 1 ? chartWidth / (periods.length - 1) : chartWidth / 2
  const barWidth = Math.min(24, Math.max(12, step * 0.45))

  // 计算折线点
  const points = periods.map((_, i) => {
    const x = paddingLeft + i * step
    const yoy = yoys[i] ?? 0
    const normalizedYoy = (yoy - minYoy) / yoyRange
    const y = paddingTop + chartHeight - normalizedYoy * chartHeight
    return `${x},${y}`
  }).join(' ')

  return (
    <div className={css.svgChartWrap}>
      <svg viewBox={`0 0 ${width} ${height}`} className={css.svgChart} preserveAspectRatio="none">
        {/* 背景轻网格线 */}
        <line x1={paddingLeft} y1={paddingTop + chartHeight} x2={width - paddingRight} y2={paddingTop + chartHeight} stroke="var(--futu-border)" strokeWidth="1" />
        <line x1={paddingLeft} y1={paddingTop + chartHeight / 2} x2={width - paddingRight} y2={paddingTop + chartHeight / 2} stroke="var(--futu-border)" strokeWidth="1" strokeDasharray="3,3" />

        {/* 柱状图 */}
        {periods.map((p, i) => {
          const x = paddingLeft + i * step - barWidth / 2
          const val = vals[i] ?? 0
          const barHeight = Math.max(2, (val / valRange) * chartHeight)
          const y = paddingTop + chartHeight - barHeight
          return (
            <g key={`bar-${p}`}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                fill="var(--futu-accent)"
                rx="3"
                opacity="0.85"
              />
              <text
                x={paddingLeft + i * step}
                y={height - 6}
                fontSize="10"
                textAnchor="middle"
                fill="var(--futu-text-muted)"
              >
                {p}
              </text>
            </g>
          )
        })}

        {/* 同比折线与圆点 */}
        {showYoY && periods.length > 1 && (
          <>
            <polyline
              points={points}
              fill="none"
              stroke="var(--futu-orange)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {periods.map((p, i) => {
              const x = paddingLeft + i * step
              const yoy = yoys[i] ?? 0
              const normalizedYoy = (yoy - minYoy) / yoyRange
              const y = paddingTop + chartHeight - normalizedYoy * chartHeight
              return (
                <circle
                  key={`dot-${p}`}
                  cx={x}
                  cy={y}
                  r="3.5"
                  fill="var(--futu-bg-card)"
                  stroke="var(--futu-orange)"
                  strokeWidth="2"
                />
              )
            })}
          </>
        )}
      </svg>
    </div>
  )
}
