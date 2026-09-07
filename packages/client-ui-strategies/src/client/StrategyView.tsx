/**
 * 策略板块主视图（对齐 docs/design/strategy-tab.md §3.4 与 Review 规范）。
 *
 * 结构（自上而下，两级分区）：
 *   1. 分区分段控件（选股策略 | 量化策略）
 *   2a. 选股策略 → ScreenerPane（内置选股器卡 + 参数/扫描池 + 进度 + 命中表）
 *   2b. 量化策略 → 周期分段控件（短线 | 波段 | 长线）+ 策略卡列表
 *       + 参数配置与回测控制栏（参数输入 + 标的周期 + 运行回测）
 *       + 结果区：8 指标卡 + 权益曲线 (lightweight-charts) + 交易明细流水表
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, ColorType, AreaSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import {
  strategyParadigms,
  run,
  validateCustomStrategy,
  applyStrategyManagement,
  isBuiltinStrategyId,
  builtinStrategyRecord,
  type StrategyHorizon,
  type StrategyDefinition,
  type BacktestResult,
  type CustomStrategyRecord,
  type Kline,
} from '@dshtrading/strategies'
import { readJson, writeJson, type SelectionState } from './shell-faces.ts'
import { IconStrategy } from './icons.tsx'
import { ScreenerPane } from './ScreenerPane.tsx'
import { StrategyEditor, type StrategyEditorSaveInput } from './StrategyEditor.tsx'
import type { StrategyLocaleKey } from './contract.ts'
import {
  strategyName, strategySummary, paramLabel,
  exitReasonText,
} from './strategy-locale.ts'
export { strategyName, strategySummary, paramLabel, exitReasonText } from './strategy-locale.ts'
import css from './StrategyView.module.css'

type StrategySection = 'screener' | 'quant'

interface StrategyStateStored {
  section?: StrategySection
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
  t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string
  /** 中栏活动视图 id（tradingStageViews.render 透传；本视图固定 strategy，未用）。 */
  view?: string
  /** 桥面（shell 的 tradingBridge 服务；未注入时空跑——视图静默空态）。
   *  管理方法（策略管理，2026-09-07）为可选：老 shell 缺席时管理动作降级隐藏。 */
  bridge: {
    fetchKlines: (market: string, symbol: string, interval: string, limit: number) => Promise<Kline[]>
    fetchCustomStrategies: () => Promise<Array<{ id: string; title: string; horizon: string; summary: string; paramsJson: string; computeSource: string }>>
    fetchSymbols: (market: string) => Promise<Array<{ symbol: string; name?: string }>>
    subscribeTradingEvents: (handlers: { strategies?: () => void }) => () => void
    saveCustomStrategy?: ((input: StrategyEditorSaveInput) => Promise<{ ok: true } | { ok: false; reason: string } | null>) | undefined
    deleteCustomStrategy?: ((id: string) => Promise<boolean>) | undefined
    resetStrategy?: ((id: string) => Promise<{ ok: boolean; changed: boolean } | null>) | undefined
    fetchStrategyTombstones?: (() => Promise<string[]>) | undefined
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

  // section 白名单：旧存档缺省 quant；手改出的脏值回落 quant，避免渲染出
  // 「头部选择器隐藏但量化内容还在」的半套 UI
  const [section, setSection] = useState<StrategySection>(stored.section === 'screener' ? 'screener' : 'quant')
  const [horizon, setHorizon] = useState<StrategyHorizon>(stored.horizon ?? 'short')
  const [selectedId, setSelectedId] = useState<string>(stored.strategyId ?? 'donchian-breakout')
  const [paramsMap, setParamsMap] = useState<Record<string, Record<string, number>>>(stored.paramsMap ?? {})

  // 2. 自定义策略名册（issue #31 / P2）+ 策略管理（2026-09-07）：桥拉取记录与
  // 墓碑 → 校验（Worker 熔断）→ applyStrategyManagement 合成名册（内置 − 墓碑、
  // 覆盖记录原位替换、自定义追加）；SSE 'strategies' 信号到达时重拉。
  // 桥来自 shell 的 tradingBridge 服务（未注入时跳过拉取，视图空态）。
  const [customDefs, setCustomDefs] = useState<StrategyDefinition[]>([])
  const [records, setRecords] = useState<CustomStrategyRecord[]>([])
  const [tombstones, setTombstones] = useState<string[]>([])
  // 桥引用稳定化（防御）：上游若每次 render 传新 bridge 字面量，[bridge] 依赖会
  // 自激振荡（每帧 loadCards → setState → 新 bridge → …，实证 fetch 风暴）。
  // 锁定首见引用；真换桥实例需重挂视图，语义可接受。
  const bridgeRef = useRef(bridge)
  if (bridgeRef.current === null) bridgeRef.current = bridge
  const stableBridge = bridgeRef.current
  // 编辑器保存后的立即重拉触发器（SSE 缺席的老宿主也能即时上榜）。
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    if (stableBridge === undefined) return
    let cancelled = false
    const load = async () => {
      try {
        const rawRecords = await stableBridge.fetchCustomStrategies()
        const defs: StrategyDefinition[] = []
        const validRecords: CustomStrategyRecord[] = []
        for (const record of rawRecords) {
          const result = await validateCustomStrategy(record as never)
          if (result.ok) {
            defs.push(result.definition)
            validRecords.push(result.record)
          }
        }
        const deleted = stableBridge.fetchStrategyTombstones !== undefined
          ? await stableBridge.fetchStrategyTombstones()
          : []
        if (cancelled) return
        setCustomDefs(defs)
        setRecords(validRecords)
        setTombstones(deleted)
      } catch (e) {
        console.warn('[dsh-trading] failed to load custom strategies:', e)
      }
    }
    void load()
    const unsubscribe = stableBridge.subscribeTradingEvents({ strategies: () => { void load() } })
    return () => { cancelled = true; unsubscribe() }
  }, [stableBridge, reloadKey])

  // 名册 = 内置 − 墓碑，覆盖记录原位替换，自定义追加（策略管理统一合成）。
  const allStrategies = useMemo<StrategyDefinition[]>(
    () => applyStrategyManagement(strategyParadigms, customDefs, tombstones),
    [customDefs, tombstones],
  )

  // 来源徽标词汇：已修改内置（store 有同 id 覆盖记录）/ 自定义。
  const modifiedIds = useMemo(
    () => new Set(records.map((r) => r.id).filter((id) => isBuiltinStrategyId(id))),
    [records],
  )

  // 编辑器状态：null = 关闭；record = null 新建，否则编辑预填（内置经
  // builtinStrategyRecord 导出自包含源码）。
  const [editor, setEditor] = useState<{ initial: CustomStrategyRecord | null } | null>(null)

  const currentStrategy = useMemo<StrategyDefinition | null>(() => {
    // 全部内置被删且无自定义时名册可为空（策略管理边界）：返回 null 走空态。
    return allStrategies.find((s) => s.id === selectedId) ?? allStrategies[0] ?? null
  }, [allStrategies, selectedId])

  // 当前策略对应的参数
  const currentParams = useMemo<Record<string, number>>(() => {
    if (currentStrategy === null) return {}
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
    const nextState: StrategyStateStored = { section, strategyId: selectedId, paramsMap, horizon }
    writeJson(STRATEGY_STORE_KEY, nextState)
  }, [section, selectedId, paramsMap, horizon])

  // 切换 horizon 时自动选择该分类下的第一个策略
  const switchHorizon = (h: StrategyHorizon) => {
    setHorizon(h)
    const firstInHorizon = allStrategies.find((s) => s.horizon === h)
    if (firstInHorizon) {
      setSelectedId(firstInHorizon.id)
    }
  }

  const handleParamChange = (key: string, value: number) => {
    if (currentStrategy === null) return
    setParamsMap((prev) => ({
      ...prev,
      [currentStrategy.id]: {
        ...(prev[currentStrategy.id] ?? {}),
        [key]: value,
      },
    }))
  }

  /* ---------------- 策略管理动作（2026-09-07） ----------------
     老壳（桥无管理方法）时按钮不渲染（管理面缺席降级），动作函数不做兜底。 */

  const forgetLocalParams = (id: string) => {
    setParamsMap((prev) => {
      if (prev[id] === undefined) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const handleDeleteStrategy = async (strat: StrategyDefinition) => {
    if (stableBridge.deleteCustomStrategy === undefined) return
    if (!window.confirm(t('sv.mgmt.confirmDelete'))) return
    await stableBridge.deleteCustomStrategy(strat.id)
    forgetLocalParams(strat.id)
    // 删除对象正被选中 → 回落到名册第一个可用策略（墓碑生效后 currentStrategy 兜底）。
    if (selectedId === strat.id) setSelectedId('')
  }

  const handleRestoreStrategy = async (id: string) => {
    if (stableBridge.resetStrategy === undefined) return
    const result = await stableBridge.resetStrategy(id)
    if (result !== null && result.ok) forgetLocalParams(id)
  }

  const handleEditStrategy = (strat: StrategyDefinition) => {
    // 内置/已修改内置：从代码定义导出自包含源码预填；自定义：用 store 原记录。
    const record = modifiedIds.has(strat.id) || !isBuiltinStrategyId(strat.id)
      ? records.find((r) => r.id === strat.id) ?? null
      : builtinStrategyRecord(strat)
    if (record !== null) setEditor({ initial: record })
  }

  const handleSaveFromEditor = async (input: StrategyEditorSaveInput) => {
    if (stableBridge.saveCustomStrategy === undefined) return null
    return stableBridge.saveCustomStrategy(input)
  }

  // 运行回测（拉取 300 根日 K，对齐各主流交易所如 OKX 单次 300 根上限，并保障 250 根长线策略有充足样本窗口）
  const handleRunBacktest = async () => {
    if (currentStrategy === null) return
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
    // 依赖含 section：图表容器在量化分支内，切到选股分区会卸载容器。
    // 不跟随 section 的话，切回量化后挂载的是新容器而 effect 不重跑——
    // result 还在、权益曲线却空白，旧 chart 实例还挂在 ref 上失联。
  }, [result, section])

  const horizonStrategies = useMemo(() => {
    return allStrategies.filter((s) => s.horizon === horizon)
  }, [allStrategies, horizon])

  // 管理面可用性（老壳无桥管理方法 → 整组管理动作降级隐藏）。
  const mgmtAvailable = stableBridge.deleteCustomStrategy !== undefined
    && stableBridge.saveCustomStrategy !== undefined
    && stableBridge.resetStrategy !== undefined

  // 已删内置（墓碑）：灰卡 + 恢复入口（可发现性——不展示则用户无从知道可恢复）。
  const tombstonedStrategies = useMemo<StrategyDefinition[]>(() => {
    if (!mgmtAvailable) return []
    return strategyParadigms.filter((d) => tombstones.includes(d.id))
  }, [tombstones, mgmtAvailable])

  return (
    <div className={css.root} data-dshtrading-strategy-view="">
      {/* 1. 分区分段控件（选股策略 | 量化策略） */}
      <div className={css.header}>
        <div className={css.horizonSelector} role="tablist">
          <button
            type="button"
            className={css.horizonBtn}
            data-active={section === 'screener' ? 'true' : undefined}
            onClick={() => setSection('screener')}
          >
            {t('sv.section.screener')}
          </button>
          <button
            type="button"
            className={css.horizonBtn}
            data-active={section === 'quant' ? 'true' : undefined}
            onClick={() => setSection('quant')}
          >
            {t('sv.section.quant')}
          </button>
        </div>

        {section === 'quant' && (
          <>
            {/* 2b-1. 周期分段 + 新建策略 */}
            <div className={css.mgmtRow}>
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
              {mgmtAvailable && (
                <button type="button" className={css.newStrategyBtn} onClick={() => setEditor({ initial: null })}>
                  + {t('sv.mgmt.new')}
                </button>
              )}
            </div>

            {/* 策略卡片（来源徽标 + 管理操作） */}
            <div className={css.strategyCards}>
              {horizonStrategies.map((strat) => {
                const modified = modifiedIds.has(strat.id)
                const builtin = isBuiltinStrategyId(strat.id)
                return (
                  <div
                    key={strat.id}
                    className={css.strategyCard}
                    data-active={strat.id === selectedId ? 'true' : undefined}
                    onClick={() => setSelectedId(strat.id)}
                  >
                    <div className={css.cardTitleRow}>
                      <span className={css.cardTitle}>{strategyName(strat, t)}</span>
                      <span
                        className={css.cardBadge}
                        data-kind={modified ? 'modified' : builtin ? 'builtin' : 'custom'}
                      >
                        {t(modified ? 'sv.mgmt.badge.modified' : builtin ? 'sv.mgmt.badge.builtin' : 'sv.mgmt.badge.custom')}
                      </span>
                    </div>
                    <div className={css.cardSummary}>{strategySummary(strat, t)}</div>
                    {mgmtAvailable && (
                      <div className={css.cardActions} onClick={(e) => e.stopPropagation()}>
                        <button type="button" className={css.cardActionBtn} onClick={() => handleEditStrategy(strat)}>
                          {t('sv.mgmt.edit')}
                        </button>
                        {builtin && modified && (
                          <button type="button" className={css.cardActionBtn} onClick={() => { void handleRestoreStrategy(strat.id) }}>
                            {t('sv.mgmt.restore')}
                          </button>
                        )}
                        <button
                          type="button"
                          className={css.cardActionBtn}
                          data-danger="true"
                          onClick={() => { void handleDeleteStrategy(strat) }}
                        >
                          {t('sv.mgmt.delete')}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
              {tombstonedStrategies.map((strat) => (
                <div key={strat.id} className={css.strategyCard} data-deleted="true">
                  <div className={css.cardTitleRow}>
                    <span className={css.cardTitle}>{strategyName(strat, t)}</span>
                    <span className={css.cardBadge} data-kind="deleted">{t('sv.mgmt.deleted')}</span>
                  </div>
                  <div className={css.cardSummary}>{strategySummary(strat, t)}</div>
                  <div className={css.cardActions} onClick={(e) => e.stopPropagation()}>
                    <button type="button" className={css.cardActionBtn} onClick={() => { void handleRestoreStrategy(strat.id) }}>
                      {t('sv.mgmt.restore')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {section === 'screener' ? (
        /* 2a. 选股策略面板 */
        <ScreenerPane t={t} market={market} bridge={stableBridge} />
      ) : currentStrategy === null ? (
        /* 名册为空（全部内置已删且无自定义，策略管理边界）→ 空态 */
        <div className={css.emptyState}>
          <div className={css.emptyIcon}>
            <IconStrategy size={36} />
          </div>
          <div>{t('sv.mgmt.rosterEmpty')}</div>
        </div>
      ) : (
        <>
          {/* 2b-2. 参数调节与运行条 */}
      <div className={css.configBar}>
        {currentStrategy.params.map((p) => (
          <div key={p.key} className={css.paramGroup}>
            <label className={css.paramLabel}>{paramLabel(currentStrategy, p, t)}:</label>
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
                        <td className={css.reasonCell}>{exitReasonText(tr, t)}</td>
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
        </>
      )}

      {/* 策略编辑器（新建/编辑/覆盖内置；模态覆盖层） */}
      {editor !== null && (
        <StrategyEditor
          t={t}
          initial={editor.initial}
          onSave={handleSaveFromEditor}
          onSaved={() => setReloadKey((k) => k + 1)}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  )
}

