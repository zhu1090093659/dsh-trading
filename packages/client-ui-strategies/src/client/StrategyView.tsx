/**
 * 策略板块主视图（对齐 docs/design/strategy-tab.md §3.4 与 Review 规范）。
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
  validateCustomStrategy,
  type StrategyHorizon,
  type StrategyDefinition,
  type BacktestResult,
  type Kline,
} from '@dsh-trading/strategies'
import { readJson, writeJson, type SelectionState } from './shell-faces.ts'
import { IconStrategy } from './icons.tsx'
import type { StrategyLocaleKey } from './contract.ts'
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

export type UseStoreState<TState> = <TSelected>(selector: (state: TState) => TSelected) => TSelected

export interface StrategyViewProps {
  t: (key: StrategyLocaleKey) => string
  /** 桥面（shell 的 tradingBridge 服务；未注入时空跑——视图静默空态）。 */
  bridge: {
    fetchKlines: (market: string, symbol: string, interval: string, limit: number) => Promise<Kline[]>
    fetchCustomStrategies: () => Promise<Array<{ id: string; title: string; horizon: string; summary: string; paramsJson: string; computeSource: string }>>
    subscribeTradingEvents: (handlers: { strategies?: () => void }) => () => void
  }
  useSelection?: UseStoreState<SelectionState>
}

export function StrategyView({ t, bridge, useSelection }: StrategyViewProps) {
  const instrument = useSelection ? useSelection((s) => s.instrument) : null
  const market = instrument?.market ?? 'crypto'
  const symbol = instrument?.symbol ?? 'BTCUSDT'

  // 1. 本地存储持久化状态
  const [stored] = useState<StrategyStateStored>(() => {
    return readJson<StrategyStateStored>(STRATEGY_STORE_KEY, DEFAULT_STORED)
  })

  const [horizon, setHorizon] = useState<StrategyHorizon>(stored.horizon ?? 'short')
  const [selectedId, setSelectedId] = useState<string>(stored.strategyId ?? 'donchian-breakout')
  const [paramsMap, setParamsMap] = useState<Record<string, Record<string, number>>>(stored.paramsMap ?? {})

  // 2. 自定义策略名册（issue #31 / P2）：桥拉取 → 校验（Worker 熔断）→ 并入名册；
  // SSE 'strategies' 失效信号到达时重拉（strategy_author 入库无需刷新即上榜）。
  // 桥来自 shell 的 tradingBridge 服务（未注入时跳过拉取，视图空态）。
  const [customDefs, setCustomDefs] = useState<StrategyDefinition[]>([])
  // 桥引用稳定化（防御）：上游若每次 render 传新 bridge 字面量，[bridge] 依赖会
  // 自激振荡（每帧 loadCards → setState → 新 bridge → …，实证 fetch 风暴）。
  // 锁定首见引用；真换桥实例需重挂视图，语义可接受。
  const bridgeRef = useRef(bridge)
  if (bridgeRef.current === null) bridgeRef.current = bridge
  const stableBridge = bridgeRef.current
  useEffect(() => {
    if (stableBridge === undefined) return
    let cancelled = false
    const load = async () => {
      try {
        const records = await stableBridge.fetchCustomStrategies()
        const defs: StrategyDefinition[] = []
        for (const record of records) {
          const result = await validateCustomStrategy(record as never)
          if (result.ok) defs.push(result.definition)
        }
        if (!cancelled) setCustomDefs(defs)
      } catch (e) {
        console.warn('[dsh-trading] failed to load custom strategies:', e)
      }
    }
    void load()
    const unsubscribe = stableBridge.subscribeTradingEvents({ strategies: () => { void load() } })
    return () => { cancelled = true; unsubscribe() }
  }, [stableBridge])

  // 名册 = 范式 ∪ 自定义合并（issue #31）
  const allStrategies = useMemo<StrategyDefinition[]>(
    () => [...strategyParadigms, ...customDefs],
    [customDefs],
  )

  const currentStrategy = useMemo<StrategyDefinition>(() => {
    return allStrategies.find((s) => s.id === selectedId) ?? allStrategies[0]!
  }, [allStrategies, selectedId])

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
    const firstInHorizon = allStrategies.find((s) => s.horizon === h)
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

  // 运行回测（拉取 300 根日 K，对齐各主流交易所如 OKX 单次 300 根上限，并保障 250 根长线策略有充足样本窗口）
  const handleRunBacktest = async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      const barsRaw = await stableBridge.fetchKlines(market, symbol, '1d', 300)
      if (!barsRaw || barsRaw.length === 0) {
        setErrorMsg(t('sv.error.noKlines'))
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
      setErrorMsg(`${t('sv.error.failed')}: ${String((e as Error)?.message ?? e)}`)
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
        textColor: '#8e95a3',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(0, 0, 0, 0.04)' },
        horzLines: { color: 'rgba(0, 0, 0, 0.04)' },
      },
      timeScale: {
        borderColor: '#e3e6ea',
        timeVisible: false,
      },
      rightPriceScale: {
        borderColor: '#e3e6ea',
      },
    })

    const isPositive = result.metrics.totalReturn >= 0
    const areaSeries = chart.addSeries(AreaSeries, {
      topColor: isPositive ? 'rgba(230, 69, 69, 0.35)' : 'rgba(43, 164, 113, 0.35)',
      bottomColor: isPositive ? 'rgba(230, 69, 69, 0.02)' : 'rgba(43, 164, 113, 0.02)',
      lineColor: isPositive ? '#e64545' : '#2ba471',
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
    return allStrategies.filter((s) => s.horizon === horizon)
  }, [allStrategies, horizon])

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
            {t('sv.horizon.short')}
          </button>
          <button
            type="button"
            className={css.horizonBtn}
            data-active={horizon === 'swing' ? 'true' : undefined}
            onClick={() => switchHorizon('swing')}
          >
            {t('sv.horizon.swing')}
          </button>
          <button
            type="button"
            className={css.horizonBtn}
            data-active={horizon === 'long' ? 'true' : undefined}
            onClick={() => switchHorizon('long')}
          >
            {t('sv.horizon.long')}
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
          <span className={css.paramLabel}>{t('sv.symbolLabel')}</span>
          <span className={css.symbolValue}>
            {symbol} {t('sv.intervalDaily')}
          </span>
        </div>

        <button
          type="button"
          className={css.runBtn}
          disabled={loading}
          onClick={handleRunBacktest}
        >
          {loading ? t('sv.running') : t('sv.run')}
        </button>
      </div>

      {errorMsg && (
        <div className={css.errorMessage}>
          {errorMsg}
        </div>
      )}

      {/* 3. 回测结果展示区 */}
      {result ? (
        <>
          {/* 8 指标卡 */}
          <div className={css.metricsGrid}>
            <div className={css.metricCard}>
              <span className={css.metricLabel}>{t('sv.metrics.totalReturn')}</span>
              <span
                className={`${css.metricValue} ${result.metrics.totalReturn >= 0 ? css.trendUp : css.trendDown}`}
              >
                {formatPercent(result.metrics.totalReturn, true)}
              </span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>{t('sv.metrics.cagr')}</span>
              <span
                className={`${css.metricValue} ${result.metrics.cagr >= 0 ? css.trendUp : css.trendDown}`}
              >
                {formatPercent(result.metrics.cagr, true)}
              </span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>{t('sv.metrics.maxDrawdown')}</span>
              <span className={`${css.metricValue} ${css.trendDown}`}>
                {formatPercent(result.metrics.maxDrawdown)}
              </span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>{t('sv.metrics.sharpe')}</span>
              <span className={css.metricValue}>{formatNum(result.metrics.sharpe)}</span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>{t('sv.metrics.winRate')}</span>
              <span className={css.metricValue}>{formatPercent(result.metrics.winRate)}</span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>{t('sv.metrics.profitFactor')}</span>
              <span className={css.metricValue}>{formatNum(result.metrics.profitFactor)}</span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>{t('sv.metrics.tradeCount')}</span>
              <span className={css.metricValue}>
                {result.metrics.tradeCount} {t('sv.metrics.tradeUnit')}
              </span>
            </div>

            <div className={css.metricCard}>
              <span className={css.metricLabel}>{t('sv.metrics.exposure')}</span>
              <span className={css.metricValue}>{formatPercent(result.metrics.exposure)}</span>
            </div>
          </div>

          {/* 权益曲线 */}
          <div className={css.chartContainer}>
            <div ref={chartContainerRef} className={css.chartWrapper} />
          </div>

          {/* 交易明细流水表 */}
          <div className={css.tableSection}>
            <div className={css.tableTitle}>
              {t('sv.trades.title')} ({result.trades.length} {t('sv.metrics.tradeUnit')})
            </div>
            <div className={css.tradesTableWrapper}>
              <table className={css.tradesTable}>
                <thead>
                  <tr>
                    <th>{t('sv.trades.entryTime')}</th>
                    <th>{t('sv.trades.exitTime')}</th>
                    <th>{t('sv.trades.entryPrice')}</th>
                    <th>{t('sv.trades.exitPrice')}</th>
                    <th>{t('sv.trades.holdingBars')}</th>
                    <th>{t('sv.trades.netReturn')}</th>
                    <th>{t('sv.trades.exitReason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.length === 0 ? (
                    <tr>
                      <td colSpan={7} className={css.tableEmptyCell}>
                        {t('sv.trades.empty')}
                      </td>
                    </tr>
                  ) : (
                    result.trades.map((tr, idx) => (
                      <tr key={idx}>
                        <td>{formatDate(tr.entryTime)}</td>
                        <td>{formatDate(tr.exitTime)}</td>
                        <td>{tr.entryPrice.toFixed(2)}</td>
                        <td>{tr.exitPrice.toFixed(2)}</td>
                        <td>{tr.holdingBars}</td>
                        <td className={tr.returnPercent >= 0 ? css.trendUp : css.trendDown}>
                          {formatPercent(tr.returnPercent, true)}
                        </td>
                        <td className={css.reasonCell}>{tr.exitReason}</td>
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
          <div className={css.emptyIcon}>
            <IconStrategy size={36} />
          </div>
          <div>{t('sv.empty.hint')}</div>
        </div>
      )}
    </div>
  )
}
