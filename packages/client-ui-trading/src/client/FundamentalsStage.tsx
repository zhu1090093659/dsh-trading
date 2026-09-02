import { useEffect, useMemo, useState } from 'react'
import type {
  FinancialIndicatorRow,
  FinancialReportGroup,
  FundamentalsPackage,
  StockFundamentals,
} from '@dsh-trading/api'
import { fetchFundamentals } from './api.ts'
import { readJson, type SelectionState } from './store.ts'
import type { Instrument, MarketId } from './types.ts'
import type { MarketLocaleKey } from './contract.ts'
import css from './fundamentals-stage.module.css'

export type UseStoreState<TState> = <TSelected>(selector: (state: TState) => TSelected) => TSelected

export interface FundamentalsStageProps {
  /** 预留：本页签文案暂为内置中文（富途工作台语义密集，先不进 locale 词典）。 */
  t?: (key: MarketLocaleKey) => string
  useSelection?: UseStoreState<SelectionState>
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

function formatVal(val: number | undefined, unit?: string, isRatio = false): string {
  if (val === undefined || Number.isNaN(val)) return '--'
  if (isRatio || unit === '%') return `${val.toFixed(2)}%`
  if (Math.abs(val) >= 100_000_000_000) return `${(val / 100_000_000_000).toFixed(2)} 千亿`
  if (Math.abs(val) >= 100_000_000) return `${(val / 100_000_000).toFixed(2)} 亿`
  if (Math.abs(val) >= 10_000) return `${(val / 10_000).toFixed(2)} 万`
  return Number.isInteger(val) ? String(val) : val.toFixed(2)
}

function formatChange(change: number | undefined): { text: string; cls: string } {
  if (change === undefined || Number.isNaN(change)) return { text: '--', cls: css.valNeutral }
  const sign = change > 0 ? '+' : ''
  const text = `${sign}${change.toFixed(2)}%`
  if (change > 0) return { text, cls: css.valUp }
  if (change < 0) return { text, cls: css.valDown }
  return { text, cls: css.valNeutral }
}

export function FundamentalsStage({ useSelection }: FundamentalsStageProps) {
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
        <span>请在左侧自选栏选择标的以查看基本面与多期财报档案</span>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className={css.loadingState}>
        <div className={css.spinner} />
        <span>正在从官方数据源动态拉取 {symbol} 财务与估值矩阵...</span>
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
              <span className={css.pillLabel}>PE(TTM):</span>
              <span className={css.pillValue}>{stock.peTtm.toFixed(2)}</span>
            </div>
          )}
          {stock?.peDynamic !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>动态PE:</span>
              <span className={css.pillValue}>{stock.peDynamic.toFixed(2)}</span>
            </div>
          )}
          {stock?.pb !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>PB:</span>
              <span className={css.pillValue}>{stock.pb.toFixed(2)}</span>
            </div>
          )}
          {stock?.marketCap !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>总市值:</span>
              <span className={css.pillValue}>{formatVal(stock.marketCap)}</span>
            </div>
          )}
          {stock?.dividendYield !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>股息率:</span>
              <span className={css.pillValue}>{(stock.dividendYield * (stock.dividendYield < 1 ? 100 : 1)).toFixed(2)}%</span>
            </div>
          )}
          {stock?.turnoverRate !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>换手:</span>
              <span className={css.pillValue}>{stock.turnoverRate.toFixed(2)}%</span>
            </div>
          )}
          {crypto?.marketCapUsd !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>流通市值:</span>
              <span className={css.pillValue}>${formatVal(crypto.marketCapUsd)}</span>
            </div>
          )}
          {crypto?.rank !== undefined && (
            <div className={css.pillItem}>
              <span className={css.pillLabel}>全球排名:</span>
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
            <span>财务</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'financials_key'}
            onClick={() => switchNav('financials_key')}
          >
            {activeNav === 'financials_key' && <span className={css.navDotActive} />}
            <span>关键指标</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'financials_income'}
            onClick={() => switchNav('financials_income')}
          >
            {activeNav === 'financials_income' && <span className={css.navDotActive} />}
            <span>利润表</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'financials_balance'}
            onClick={() => switchNav('financials_balance')}
          >
            {activeNav === 'financials_balance' && <span className={css.navDotActive} />}
            <span>资产负债表</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'financials_cashflow'}
            onClick={() => switchNav('financials_cashflow')}
          >
            {activeNav === 'financials_cashflow' && <span className={css.navDotActive} />}
            <span>现金流量表</span>
          </button>

          {/* 2. 预测 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>预测</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'forecast'}
            onClick={() => switchNav('forecast')}
          >
            {activeNav === 'forecast' && <span className={css.navDotActive} />}
            <span>盈利预测</span>
          </button>

          {/* 3. 晨星研报 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>晨星研报</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'reports'}
            onClick={() => switchNav('reports')}
          >
            {activeNav === 'reports' && <span className={css.navDotActive} />}
            <span>机构研报</span>
          </button>

          {/* 4. 估值 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>估值</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'valuation'}
            onClick={() => switchNav('valuation')}
          >
            {activeNav === 'valuation' && <span className={css.navDotActive} />}
            <span>估值分析</span>
          </button>

          {/* 5. 经营分析 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>经营分析</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'biz_segments'}
            onClick={() => switchNav('biz_segments')}
          >
            {activeNav === 'biz_segments' && <span className={css.navDotActive} />}
            <span>主营构成</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'biz_efficiency'}
            onClick={() => switchNav('biz_efficiency')}
          >
            {activeNav === 'biz_efficiency' && <span className={css.navDotActive} />}
            <span>经营效率</span>
          </button>

          {/* 6. 聪明钱 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>聪明钱</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'smart_shareholders'}
            onClick={() => switchNav('smart_shareholders')}
          >
            {activeNav === 'smart_shareholders' && <span className={css.navDotActive} />}
            <span>股东持股</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'smart_insider'}
            onClick={() => switchNav('smart_insider')}
          >
            {activeNav === 'smart_insider' && <span className={css.navDotActive} />}
            <span>股东增减持</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'smart_institutional'}
            onClick={() => switchNav('smart_institutional')}
          >
            {activeNav === 'smart_institutional' && <span className={css.navDotActive} />}
            <span>机构持股</span>
          </button>

          {/* 7. 简况 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>简况</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'profile_overview'}
            onClick={() => switchNav('profile_overview')}
          >
            {activeNav === 'profile_overview' && <span className={css.navDotActive} />}
            <span>公司概况</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'profile_executives'}
            onClick={() => switchNav('profile_executives')}
          >
            {activeNav === 'profile_executives' && <span className={css.navDotActive} />}
            <span>公司高管</span>
          </button>

          {/* 8. 公司行动 */}
          <div className={css.navGroupTitle} style={{ marginTop: 6 }}>
            <span className={css.navGroupDot} />
            <span>公司行动</span>
          </div>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'action_dividends'}
            onClick={() => switchNav('action_dividends')}
          >
            {activeNav === 'action_dividends' && <span className={css.navDotActive} />}
            <span>分红派息</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'action_buybacks'}
            onClick={() => switchNav('action_buybacks')}
          >
            {activeNav === 'action_buybacks' && <span className={css.navDotActive} />}
            <span>回购</span>
          </button>
          <button
            type="button"
            className={css.navItem}
            data-active={activeNav === 'action_splits'}
            onClick={() => switchNav('action_splits')}
          >
            {activeNav === 'action_splits' && <span className={css.navDotActive} />}
            <span>拆股并股</span>
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
                      <span>{matrix.latestReportTitle ?? `${matrix.periods[matrix.periods.length - 1]} 财报`} &gt;</span>
                    </div>
                    <div className={css.chartControls}>
                      <div
                        className={css.controlBadge}
                        onClick={() => setShowYoY(v => !v)}
                        role="button"
                        tabIndex={0}
                      >
                        <span>显示同比: {showYoY ? '开' : '关'}</span>
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
                        <span>同比增长率 (%)</span>
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
                    <span>币种: {matrix.currency}</span>
                    <span>点击指标行可在上方图表联动查看趋势</span>
                  </div>
                  <div className={css.tableScrollWrap}>
                    <table className={css.matrixTable}>
                      <thead>
                        <tr>
                          <th>指标名称</th>
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
                  <span className={css.cardTitle}>财务数据提示</span>
                  <p className={css.descText}>
                    当前标的暂未生成多期标准财报矩阵（可能为加密数字资产或该市场未提供公开季报端点），请参考估值与公司简况面板。
                  </p>
                </div>
              )}
            </>
          )}

          {/* 2. 预测 Tab */}
          {activeNav === 'forecast' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>机构盈利预测与评级一致预期</span>
                <span className={css.cardSubNote}>聚合券商研报盈利预测（EPS/营收/净利）与评级统计</span>
              </div>

              {forecast?.items && forecast.items.length > 0 ? (
                <>
                  <div className={css.forecastGrid}>
                    <div className={css.forecastStatBox}>
                      <span className={css.gridLabel}>当年预期 EPS</span>
                      <span className={css.pillValue} style={{ fontSize: 18, color: 'var(--futu-accent)' }}>
                        {forecast.epsCurrentYear !== undefined ? `¥${forecast.epsCurrentYear.toFixed(2)}` : '--'}
                      </span>
                    </div>
                    <div className={css.forecastStatBox}>
                      <span className={css.gridLabel}>次年预期 EPS</span>
                      <span className={css.pillValue} style={{ fontSize: 18, color: 'var(--futu-orange)' }}>
                        {forecast.epsNextYear !== undefined ? `¥${forecast.epsNextYear.toFixed(2)}` : '--'}
                      </span>
                    </div>
                    <div className={css.forecastStatBox}>
                      <span className={css.gridLabel}>一致预期目标价</span>
                      <span className={css.pillValue} style={{ fontSize: 18 }}>
                        {forecast.targetPriceAvg !== undefined ? `¥${forecast.targetPriceAvg.toFixed(2)}` : '--'}
                      </span>
                    </div>
                    <div className={css.forecastStatBox}>
                      <span className={css.gridLabel}>覆盖机构数</span>
                      <span className={css.pillValue} style={{ fontSize: 18 }}>
                        {forecast.totalOrgs ?? forecast.items.length} 家
                      </span>
                    </div>
                  </div>

                  <div className={css.tableScrollWrap} style={{ marginTop: 14 }}>
                    <table className={css.matrixTable}>
                      <thead>
                        <tr>
                          <th>预测年度</th>
                          <th>每股收益 EPS (元)</th>
                          <th>营业收入 (亿元)</th>
                          <th>归母净利润 (亿元)</th>
                          <th>预测机构数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {forecast.items.map(item => (
                          <tr key={item.year} className={css.indicatorRow}>
                            <td><strong>{item.year}</strong></td>
                            <td style={{ color: 'var(--futu-accent)', fontWeight: 600 }}>¥{item.eps.toFixed(2)}</td>
                            <td>{formatVal(item.revenue * 100_000_000)}</td>
                            <td>{formatVal(item.netProfit * 100_000_000)}</td>
                            <td>{item.orgCount ?? '--'} 家</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <p className={css.descText}>
                  当前标的暂未公开主流券商一致盈利预测数据，请关注公司定期公告与业绩快报。
                </p>
              )}
            </div>
          )}

          {/* 3. 晨星研报 / 研报 Tab */}
          {activeNav === 'reports' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>机构研究报告精选</span>
                <span className={css.cardSubNote}>券商机构最新深度调研、盈利预测与投资评级</span>
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
                      {rep.author && <div className={css.reportAuthor}>分析师: {rep.author}</div>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className={css.descText}>
                  暂未检索到该标的的公开机构研报，您可在对话框向 Agent 提问进行个股深度财务核查。
                </p>
              )}
            </div>
          )}

          {/* 4. 估值 Tab */}
          {activeNav === 'valuation' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>估值核心诊断与历史分位</span>
                <span className={css.cardSubNote}>基于多周期市盈率、市净率与价格区间综合诊断</span>
              </div>

              {/* 52 周区间与 PE 评注：价格未进入本组件（基本面快照无现价字段），
                  不渲染位置指针——不做 PE 分档假水位（2026-09-02 审查整改）。 */}
              {stock?.fiftyTwoWeekLow !== undefined && stock?.fiftyTwoWeekHigh !== undefined && (
                <div className={css.rangeGaugeWrap}>
                  <div className={css.rangePointerInfo}>
                    <span>52 周价格区间</span>
                    <span>
                      {stock.fiftyTwoWeekLow.toFixed(2)} ~ {stock.fiftyTwoWeekHigh.toFixed(2)}
                    </span>
                  </div>
                  <div className={css.rangeGaugeLabels}>
                    <span>52周最低: {stock.fiftyTwoWeekLow.toFixed(2)}</span>
                    <span>
                      估值评注: {stock.peTtm !== undefined ? (stock.peTtm < 15 ? '🟢 相对低估' : stock.peTtm < 30 ? '🟡 估值合理' : '🔴 相对偏高') : '评估中'}
                    </span>
                    <span>52周最高: {stock.fiftyTwoWeekHigh.toFixed(2)}</span>
                  </div>
                </div>
              )}

              <div className={css.gridCols}>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>滚动市盈率 PE (TTM)</span>
                  <span className={css.gridValue}>{stock?.peTtm !== undefined ? stock.peTtm.toFixed(2) : '--'}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>动态市盈率 PE (动)</span>
                  <span className={css.gridValue}>{stock?.peDynamic !== undefined ? stock.peDynamic.toFixed(2) : '--'}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>静态市盈率 PE (静)</span>
                  <span className={css.gridValue}>{stock?.peStatic !== undefined ? stock.peStatic.toFixed(2) : '--'}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>市净率 PB</span>
                  <span className={css.gridValue}>{stock?.pb !== undefined ? stock.pb.toFixed(2) : '--'}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>总市值</span>
                  <span className={css.gridValue}>{formatVal(stock?.marketCap)}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>流通市值</span>
                  <span className={css.gridValue}>{formatVal(stock?.floatMarketCap)}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>股息率 (TTM)</span>
                  <span className={css.gridValue}>{stock?.dividendYield !== undefined ? `${(stock.dividendYield * (stock.dividendYield < 1 ? 100 : 1)).toFixed(2)}%` : '--'}</span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>换手率</span>
                  <span className={css.gridValue}>{stock?.turnoverRate !== undefined ? `${stock.turnoverRate.toFixed(2)}%` : '--'}</span>
                </div>
              </div>
            </div>
          )}

          {/* 5. 经营分析 - 主营构成 */}
          {activeNav === 'biz_segments' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>主营业务构成分析</span>
                <span className={css.cardSubNote}>按产品、行业及地区分类拆解业务收入与毛利率结构</span>
              </div>

              <div className={css.tabButtonGroup} style={{ marginBottom: 12 }}>
                <button
                  type="button"
                  className={css.segmentFilterBtn}
                  data-active={segmentFilter === 'all'}
                  onClick={() => setSegmentFilter('all')}
                >
                  全部
                </button>
                <button
                  type="button"
                  className={css.segmentFilterBtn}
                  data-active={segmentFilter === 'product'}
                  onClick={() => setSegmentFilter('product')}
                >
                  按产品
                </button>
                <button
                  type="button"
                  className={css.segmentFilterBtn}
                  data-active={segmentFilter === 'industry'}
                  onClick={() => setSegmentFilter('industry')}
                >
                  按行业
                </button>
                <button
                  type="button"
                  className={css.segmentFilterBtn}
                  data-active={segmentFilter === 'region'}
                  onClick={() => setSegmentFilter('region')}
                >
                  按地区
                </button>
              </div>

              {filteredSegments.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th>主营分类 / 项目</th>
                        <th>主营收入 (元)</th>
                        <th>收入占比</th>
                        <th>主营利润 (元)</th>
                        <th>毛利率</th>
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
                  暂未获取到当期详细主营构成拆解明细，请参考利润表营业收入科目。
                </p>
              )}
            </div>
          )}

          {/* 5. 经营分析 - 经营效率 */}
          {activeNav === 'biz_efficiency' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>运营与周转效率</span>
                <span className={css.cardSubNote}>存货周转天数、应收账款周转天数、营业周期与盈利质量</span>
              </div>
              <div className={css.gridCols}>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>存货周转天数</span>
                  <span className={css.gridValue} style={{ color: 'var(--futu-accent)', fontWeight: 600 }}>
                    {efficiency?.inventoryTurnoverDays ? `${efficiency.inventoryTurnoverDays.toFixed(1)} 天` : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>应收账款周转天数</span>
                  <span className={css.gridValue} style={{ color: 'var(--futu-accent)', fontWeight: 600 }}>
                    {efficiency?.accountsReceivableTurnoverDays ? `${efficiency.accountsReceivableTurnoverDays.toFixed(1)} 天` : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>净营业周期</span>
                  <span className={css.gridValue}>
                    {efficiency?.operatingCycleDays ? `${efficiency.operatingCycleDays.toFixed(1)} 天` : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>总资产周转率</span>
                  <span className={css.gridValue}>
                    {efficiency?.totalAssetTurnover ? `${efficiency.totalAssetTurnover.toFixed(2)} 次` : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>销售毛利率</span>
                  <span className={css.gridValue}>
                    {efficiency?.grossProfitMargin ? `${efficiency.grossProfitMargin.toFixed(2)}%` : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>销售净利率</span>
                  <span className={css.gridValue}>
                    {efficiency?.netProfitMargin ? `${efficiency.netProfitMargin.toFixed(2)}%` : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>流动比率</span>
                  <span className={css.gridValue}>
                    {efficiency?.currentRatio ? efficiency.currentRatio.toFixed(2) : '--'}
                  </span>
                </div>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>速动比率</span>
                  <span className={css.gridValue}>
                    {efficiency?.quickRatio ? efficiency.quickRatio.toFixed(2) : '--'}
                  </span>
                </div>
              </div>
              <p className={css.descText} style={{ marginTop: 14 }}>
                {efficiency?.inventoryTurnoverDays !== undefined && efficiency?.accountsReceivableTurnoverDays !== undefined ? (
                  `本期存货周转天数约为 ${efficiency.inventoryTurnoverDays.toFixed(1)} 天，应收账款周转天数约为 ${efficiency.accountsReceivableTurnoverDays.toFixed(1)} 天，净营业周期为 ${efficiency.operatingCycleDays !== undefined ? efficiency.operatingCycleDays.toFixed(1) : '--'} 天。`
                ) : (
                  '经营效率明细数据暂未获取到（数据源未覆盖该报告期），不做推断性描述。'
                )}
              </p>
            </div>
          )}

          {/* 6. 聪明钱 - 股东持股 */}
          {activeNav === 'smart_shareholders' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>十大流通股东穿透表</span>
                <span className={css.cardSubNote}>核心机构、战略股东、股东户数与筹码集中度</span>
              </div>

              {holderSummary && (
                <div className={css.forecastGrid} style={{ marginBottom: 14 }}>
                  <div className={css.forecastStatBox}>
                    <span className={css.gridLabel}>股东总户数</span>
                    <span className={css.pillValue} style={{ fontSize: 16, color: 'var(--futu-accent)' }}>
                      {holderSummary.totalHolders ? `${(holderSummary.totalHolders / 10_000).toFixed(2)} 万户` : '--'}
                    </span>
                  </div>
                  <div className={css.forecastStatBox}>
                    <span className={css.gridLabel}>户均持股数</span>
                    <span className={css.pillValue} style={{ fontSize: 16 }}>
                      {holderSummary.avgFreeShares ? `${holderSummary.avgFreeShares.toLocaleString()} 股` : '--'}
                    </span>
                  </div>
                  <div className={css.forecastStatBox}>
                    <span className={css.gridLabel}>户均持股市值</span>
                    <span className={css.pillValue} style={{ fontSize: 16 }}>
                      {holderSummary.avgHoldAmount ? `¥${(holderSummary.avgHoldAmount / 10_000).toFixed(2)} 万元` : '--'}
                    </span>
                  </div>
                  <div className={css.forecastStatBox}>
                    <span className={css.gridLabel}>筹码集中度</span>
                    <span className={css.pillValue} style={{ fontSize: 16, color: 'var(--futu-orange)' }}>
                      {holderSummary.concentration ?? '适中'}
                    </span>
                  </div>
                </div>
              )}
              {shareholders && shareholders.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}>排名</th>
                        <th>股东名称</th>
                        <th>持股数 (股)</th>
                        <th>占流通股比</th>
                        <th>持股变动</th>
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
                            <td>{sh.shares !== undefined ? formatVal(sh.shares) : '--'}</td>
                            <td>{sh.ratio !== undefined ? `${sh.ratio.toFixed(2)}%` : '--'}</td>
                            <td>
                              {isUp ? (
                                <span className={css.changeTagUp}>{sh.change}</span>
                              ) : isDown ? (
                                <span className={css.changeTagDown}>{sh.change}</span>
                              ) : (
                                <span className={css.changeTagFlat}>{sh.change || '不变'}</span>
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
                  当前标的暂未公开当期十大流通股东穿透名录，可参考流通市值与换手率变动。
                </p>
              )}
            </div>
          )}

          {/* 6. 聪明钱 - 股东增减持 */}
          {activeNav === 'smart_insider' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>重要股东及高管持股变动明细</span>
                <span className={css.cardSubNote}>主要股东、董监高近期持股变动与交易记录</span>
              </div>
              {insiderTrades && insiderTrades.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th>股东全称</th>
                        <th>变动类型</th>
                        <th>持股数量 (股)</th>
                        <th>持股比例</th>
                        <th>披露日期</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insiderTrades.map((it, idx) => {
                        const isUp = it.changeType.includes('+') || it.changeType === '新进' || it.changeType.includes('增')
                        const isDown = it.changeType.includes('-') || it.changeType.includes('减')
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
                            <td>{it.changeShares ? formatVal(it.changeShares) : '--'}</td>
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
                  暂无股东增减持明细数据（数据源未覆盖或该报告期无披露记录）。
                </p>
              )}
            </div>
          )}

          {/* 6. 聪明钱 - 机构持股 */}
          {activeNav === 'smart_institutional' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>机构投资者持仓分布</span>
                <span className={css.cardSubNote}>投资公司、公募基金、外资QFII、保险资管等机构持股汇总</span>
              </div>
              {institutionalHoldings && institutionalHoldings.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th>机构全称</th>
                        <th>机构类型</th>
                        <th>持股数 (股)</th>
                        <th>占流通股比</th>
                        <th>持股市值 (元)</th>
                        <th>本期变动</th>
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
                            <td>{inst.holdingShares ? formatVal(inst.holdingShares) : '--'}</td>
                            <td>{inst.holdingRatio ? `${inst.holdingRatio.toFixed(2)}%` : '--'}</td>
                            <td>{inst.marketCap ? `¥${(inst.marketCap / 100_000_000).toFixed(2)} 亿` : '--'}</td>
                            <td>
                              {isUp ? (
                                <span className={css.changeTagUp}>{inst.change}</span>
                              ) : isDown ? (
                                <span className={css.changeTagDown}>{inst.change}</span>
                              ) : (
                                <span className={css.changeTagFlat}>{inst.change || '不变'}</span>
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
                  机构持股总数与持仓明细已在十大流通股东穿透中体现，涵盖主流公募及指数基金。
                </p>
              )}
            </div>
          )}

          {/* 7. 简况 - 公司概况 */}
          {activeNav === 'profile_overview' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>标的档案与公司基本概况</span>
                <span className={css.cardSubNote}>法定代表、管理团队、注册资本与官方渠道</span>
              </div>
              <div className={css.gridCols}>
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>公司全称</span>
                  <span className={css.gridValue}>{profile?.fullName ?? profile?.name ?? stock?.name ?? symbol}</span>
                </div>
                {profile?.nameEn && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>英文名称</span>
                    <span className={css.gridValue}>{profile.nameEn}</span>
                  </div>
                )}
                {profile?.industry && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>所属行业</span>
                    <span className={css.gridValue}>{profile.industry}</span>
                  </div>
                )}
                {profile?.registeredCapital && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>注册资本</span>
                    <span className={css.gridValue}>{profile.registeredCapital}</span>
                  </div>
                )}
                {profile?.employeeCount && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>员工规模</span>
                    <span className={css.gridValue}>{profile.employeeCount}</span>
                  </div>
                )}
                {profile?.address && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>办公 / 注册地址</span>
                    <span className={css.gridValue} style={{ fontSize: 12 }}>{profile.address}</span>
                  </div>
                )}
                <div className={css.gridItem}>
                  <span className={css.gridLabel}>官方网站</span>
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
                <span className={css.gridLabel} style={{ display: 'block', marginBottom: 6 }}>公司简介与历史沿革:</span>
                <p className={css.descText}>
                  {profile?.description ?? `${symbol} 公司详细业务介绍与产业历史。`}
                </p>
              </div>
            </div>
          )}

          {/* 7. 简况 - 公司高管 */}
          {activeNav === 'profile_executives' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>管理团队与高管名录</span>
                <span className={css.cardSubNote}>董事长、总经理、财务总监及核心董监高</span>
              </div>
              <div className={css.gridCols}>
                {profile?.chairman && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>董事长</span>
                    <span className={css.gridValue} style={{ fontWeight: 600 }}>{profile.chairman}</span>
                  </div>
                )}
                {profile?.generalManager && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>总经理 / CEO</span>
                    <span className={css.gridValue} style={{ fontWeight: 600 }}>{profile.generalManager}</span>
                  </div>
                )}
                {profile?.legalRepresentative && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>法定代表人</span>
                    <span className={css.gridValue}>{profile.legalRepresentative}</span>
                  </div>
                )}
                {profile?.boardSecretary && (
                  <div className={css.gridItem}>
                    <span className={css.gridLabel}>董事会秘书</span>
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
                <span>历年分红派息记录</span>
                <span className={css.cardSubNote}>历次利润分配方案、除权除息日与股息分红</span>
              </div>
              {dividends && dividends.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th>方案年度</th>
                        <th>分配方案</th>
                        <th>每股派现 (元)</th>
                        <th>除权除息日</th>
                        <th>股权登记日</th>
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
                  暂未获取到公开历史分红派息方案记录。
                </p>
              )}
            </div>
          )}

          {/* 8. 公司行动 - 回购 */}
          {activeNav === 'action_buybacks' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>股份回购方案与股本管理</span>
                <span className={css.cardSubNote}>公司股份回购方案、回购资金规模、股本结构与实施状态</span>
              </div>
              {buybacks && buybacks.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th>公告日期</th>
                        <th>回购规模 / 金额</th>
                        <th>回购股份 (股)</th>
                        <th>价格区间</th>
                        <th>当前状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {buybacks.map((bb, idx) => (
                        <tr key={bb.date + idx} className={css.indicatorRow}>
                          <td><strong>{bb.date}</strong></td>
                          <td>{bb.buybackAmount ? `¥${(bb.buybackAmount / 100_000_000).toFixed(2)} 亿元` : '--'}</td>
                          <td>{bb.buybackShares ? formatVal(bb.buybackShares) : '--'}</td>
                          <td>{bb.priceRange ?? '--'}</td>
                          <td><span className={css.reportRating}>{bb.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={css.descText}>
                  暂无回购记录数据（数据源未覆盖或该标的确实未公告回购），以下字段留空以待数据补齐；不做推测性描述。
                </p>
              )}
            </div>
          )}

          {/* 8. 公司行动 - 拆股并股 / 送转 */}
          {activeNav === 'action_splits' && (
            <div className={css.infoCard}>
              <div className={css.cardTitle}>
                <span>拆股、并股与送转股历史</span>
                <span className={css.cardSubNote}>历次股本拆分、送股与公积金转增股本记录</span>
              </div>
              {splits && splits.length > 0 ? (
                <div className={css.tableScrollWrap}>
                  <table className={css.matrixTable}>
                    <thead>
                      <tr>
                        <th>除权除息日</th>
                        <th>送转股方案</th>
                        <th>实施说明与进度</th>
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
                  暂无拆股并股或送转股记录数据（数据源未覆盖或该标的确实无相关事件）。
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
