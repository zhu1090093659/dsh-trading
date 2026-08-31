/**
 * 策略板块主视图（对齐 docs/design/strategy-tab.md §3.4）。
 *
 * 结构（自上而下）：
 *   1. 周期分段控件（短线 | 波段 | 长线）
 *   2. 策略卡列表（选中高亮）
 *   3. 参数配置与回测控制栏（参数输入 + 标的周期 + 运行回测）
 *   4. 结果区：8 指标卡 + 权益曲线 (lightweight-charts) + 交易明细流水表
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, ColorType, AreaSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import {
  strategyParadigms,
  run,
  type StrategyHorizon,
  type StrategyDefinition,
  type BacktestResult,
  type Kline,
} from '@dsh-trading/strategies'
import { readJson, writeJson, type SelectionState } from './store.ts'
import { fetchKlines } from './api.ts'
import type { MarketLocaleKey } from './contract.ts'
import css from './StrategyView.module.css'

interface StrategyStateStored {
  strategyId: string
  paramsMap: Record<string, Record<string, number>>
  horizon: StrategyHorizon
}

const STRATEGY_STORE_KEY = 'dshtrading.strategy.v1'

const DEFAULT_STORED: StrategyStateStored = {
  strategyId: 'donchian-breakout',
  paramsMap: {},
  horizon: 'short',
}

function formatPercent(val: number, plus = false): string {
  if (!Number.isFinite(val)) return '--'
  const sign = val > 0 && plus ? '+' : ''
  return `${sign}${val.toFixed(2)}%`
}

function formatNum(val: number, decimals = 2): string {
  if (val === Infinity) return '∞'
  if (!Number.isFinite(val)) return '--'
  return val.toFixed(decimals)
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface StrategyViewProps {
  t: (key: MarketLocaleKey) => string
  useSelection?: () => SelectionState
}

export function StrategyView({ t, useSelection }: StrategyViewProps) {
  const selection = useSelection?.() ?? { market: 'crypto', symbol: 'BTCUSDT' }

  // 1. 本地存储持久化状态
  const [stored, setStored] = useState<StrategyStateStored>(() => {
    return readJson<StrategyStateStored>(STRATEGY_STORE_KEY, DEFAULT_STORED)
  })

  const [horizon, setHorizon] = useState<StrategyHorizon>(stored.horizon ?? 'short')
  const [selectedId, setSelectedId] = useState<string>(stored.strategyId ?? 'donchian-breakout')
  const [paramsMap, setParamsMap] = useState<Record<string, Record<string, number>>>(stored.paramsMap ?? {})

  // 2. 当前选中策略
  const currentStrategy = useMemo<StrategyDefinition>(() => {
    return strategyParadigms.find((s) => s.id === selectedId) ?? strategyParadigms[0]!
  }, [selectedId])

  // 当前策略对应的参数
  const currentParams = useMemo<Record<string, number>>(() => {
    const custom = paramsMap[currentStrategy.id] ?? {}
    const res: Record<string, number> = {}
    for (const p of currentStrategy.params) {
      res[p.key] = custom[p.key] ?? p.default
    }
    return res
  }, [currentStrategy, paramsMap])

  // 3. 回测运行状态
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // 4. 图表容器 ref
  const chartContainerRef = useRef<HTMLDivElement | null>(null)
  const chartApiRef = useRef<IChartApi | null>(null)
  const seriesApiRef = useRef<ISeriesApi<'Area'> | null>(null)

  // 同步持久化
  useEffect(() => {
    const nextState: StrategyStateStored = { strategyId: selectedId, paramsMap, horizon }
    writeJson(STRATEGY_STORE_KEY, nextState)
  }, [selectedId, paramsMap, horizon])

  // 切换 horizon 时自动选择该分类下的第一个策略
  const switchHorizon = (h: StrategyHorizon) => {
    setHorizon(h)
    const firstInHorizon = strategyParadigms.find((s) => s.horizon === h)
    if (firstInHorizon) {
      setSelectedId(firstInHorizon.id)
    }
  }

  const handleParamChange = (key: string, value: number) => {
    setParamsMap((prev) => ({
      ...prev,
      [currentStrategy.id]: {
        ...(prev[currentStrategy.id] ?? {}),
        [key]: value,
      },
    }))
  }

  // 运行回测
  const handleRunBacktest = async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      const barsRaw = await fetchKlines(selection.market, selection.symbol, '1d', 300)
      if (!barsRaw || barsRaw.length === 0) {
        setErrorMsg('未能获取到历史 K 线行情数据')
        setResult(null)
        return
      }
      const klines: Kline[] = barsRaw.map((b) => ({
        openTime: b.openTime,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }))
      const backtestResult = run(klines, currentStrategy, currentParams)
      setResult(backtestResult)
    } catch (e) {
      setErrorMsg(`回测执行失败: ${String((e as Error)?.message ?? e)}`)
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  // 挂载与更新权益曲线图表
  useEffect(() => {
    if (!chartContainerRef.current || !result || result.equity.length === 0) {
      return
    }

    const container = chartContainerRef.current
    if (chartApiRef.current) {
      chartApiRef.current.remove()
      chartApiRef.current = null
    }

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(255, 255, 255, 0.6)',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        timeVisible: false,
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
      },
    })

    const areaSeries = chart.addSeries(AreaSeries, {
      topColor: result.metrics.totalReturn >= 0 ? 'rgba(230, 69, 69, 0.4)' : 'rgba(43, 164, 113, 0.4)',
      bottomColor: result.metrics.totalReturn >= 0 ? 'rgba(230, 69, 69, 0.02)' : 'rgba(43, 164, 113, 0.02)',
      lineColor: result.metrics.totalReturn >= 0 ? '#e64545' : '#2ba471',
      lineWidth: 2,
    })

    const chartData = result.equity.map((pt) => ({
      time: Math.floor(pt.time / 1000) as unknown as string,
      value: pt.equity,
    }))

    areaSeries.setData(chartData as never)
    chart.timeScale().fitContent()

    chartApiRef.current = chart
    seriesApiRef.current = areaSeries

    const handleResize = () => {
      if (chartContainerRef.current && chartApiRef.current) {
        chartApiRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        })
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      chartApiRef.current = null
      seriesApiRef.current = null
    }
  }, [result])

  const horizonStrategies = useMemo(() => {
    return strategyParadigms.filter((s) => s.horizon === horizon)
  }, [horizon])

  return (
    <div className={css.root} data-dshtrading-strategy-view="">
      {/* 1. 周期分段与策略选择 */}
      <div className={css.header}>
        <div className={css.horizonSelector} role="tablist">
          <button
            type="button"
            className={css.horizonBtn}
            data-active={horizon === 'short' ? 'true' : undefined}
            onClick={() => switchHorizon('short')}
          >
            {t('strategy.horizon.short' as never) || '短线交易'}
          </button>
          <button
            type="button"
            className={css.horizonBtn}
            data-active={horizon === 'swing' ? 'true' : undefined}
            onClick={() => switchHorizon('swing')}
          >
            {t('strategy.horizon.swing' as never) || '中线波段'}
          </button>
          <button
            type="button"
            className={css.horizonBtn}
            data-active={horizon === 'long' ? 'true' : undefined}
            onClick={() => switchHorizon('long')}
          >
            {t('strategy.horizon.long' as never) || '长线投资'}
          </button>
        </div>

        {/* 策略卡片 */}
        <div className={css.strategyCards}>
          {horizonStrategies.map((strat) => (
            <div
              key={strat.id}
              className={css.strategyCard}
              data-active={strat.id === selectedId ? 'true' : undefined}
              onClick={() => setSelectedId(strat.id)}
            >
              <div className={css.cardTitle}>{strat.name}</div>
              <div className={css.cardSummary}>{strat.summary}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 2. 参数调节与运行条 */}
      <div className={css.configBar}>
        {currentStrategy.params.map((p) => (
          <div key={p.key} className={css.paramGroup}>
            <label className={css.paramLabel}>{p.label}:</label>
            <input
              type="number"
              className={css.paramInput}
              min={p.min}
              max={p.max}
              step={p.step}
              value={currentParams[p.key] ?? p.default}
              onChange={(e) => {
                const numVal = parseFloat(e.target.value)
                if (!Number.isNaN(numVal)) {
                  handleParamChange(p.key, numVal)
                }
              }}
            />
          </div>
        ))}

        <div className={css.paramGroup}>
          <span className={css.paramLabel}>标的:</span>
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-accent)' }}>
            {selection.symbol} (日K)
          </span>
        </div>

        <button
          type="button"
          className={css.runBtn}
          disabled={loading}
          onClick={handleRunBacktest}
        >
          {loading ? '回测计算中...' : '运行回测'}
        </button>
      </div>

      {errorMsg && (
        <div style={{ color: 'var(--color-trend-up)', fontSize: '13px', padding: '8px 0' }}>
          {errorMsg}
        </div>
      )}

      {/* 3. 回测结果展示区 */}
      {result ? (
        <>
          {/* 8 指标卡 */}
          <div className={css.metricsGrid}>
            <div className={css.metricCard}>
              <span className={css.metricLabel}>累计收益率</span>
              <span
                className={`${css.metricValue} ${result.metrics.totalReturn >= 0 ? css.trendUp : css.trendDown}`}
              >
                {formatPercent(result.metrics.totalReturn, true)}
              </span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>年化收益 (CAGR)</span>
              <span
                className={`${css.metricValue} ${result.metrics.cagr >= 0 ? css.trendUp : css.trendDown}`}
              >
                {formatPercent(result.metrics.cagr, true)}
              </span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>最大回撤</span>
              <span className={`${css.metricValue} ${css.trendDown}`}>
                {formatPercent(result.metrics.maxDrawdown)}
              </span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>夏普比率 (Sharpe)</span>
              <span className={css.metricValue}>{formatNum(result.metrics.sharpe)}</span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>胜率 (Win Rate)</span>
              <span className={css.metricValue}>{formatPercent(result.metrics.winRate)}</span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>盈亏比 (Profit Factor)</span>
              <span className={css.metricValue}>{formatNum(result.metrics.profitFactor)}</span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>交易总笔数</span>
              <span className={css.metricValue}>{result.metrics.tradeCount} 笔</span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>市场暴露度</span>
              <span className={css.metricValue}>{formatPercent(result.metrics.exposure)}</span>
            </div>
          </div>

          {/* 权益曲线 */}
          <div className={css.chartContainer}>
            <div ref={chartContainerRef} className={css.chartWrapper} />
          </div>

          {/* 交易明细流水表 */}
          <div className={css.tableSection}>
            <div className={css.tableTitle}>交易明细记录 ({result.trades.length} 笔)</div>
            <div className={css.tradesTableWrapper}>
              <table className={css.tradesTable}>
                <thead>
                  <tr>
                    <th>入场时间</th>
                    <th>出场时间</th>
                    <th>买入价</th>
                    <th>卖出价</th>
                    <th>持仓(K线)</th>
                    <th>净盈亏%</th>
                    <th>平仓原因</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: '16px' }}>
                        回测周期内无完整平仓交易记录
                      </td>
                    </tr>
                  ) : (
                    result.trades.map((t, idx) => (
                      <tr key={idx}>
                        <td>{formatDate(t.entryTime)}</td>
                        <td>{formatDate(t.exitTime)}</td>
                        <td>{t.entryPrice.toFixed(2)}</td>
                        <td>{t.exitPrice.toFixed(2)}</td>
                        <td>{t.holdingBars}</td>
                        <td className={t.returnPercent >= 0 ? css.trendUp : css.trendDown}>
                          {formatPercent(t.returnPercent, true)}
                        </td>
                        <td style={{ color: 'var(--color-text-muted)', maxWidth: '200px' }}>{t.exitReason}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className={css.emptyState}>
          <div className={css.emptyIcon}>📊</div>
          <div>点击「运行回测」计算 {currentStrategy.name} 在 {selection.symbol} 上的历史表现</div>
        </div>
      )}
    </div>
  )
}
