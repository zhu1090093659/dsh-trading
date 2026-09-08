/**
 * 选股策略面板（一级「选股策略」分区的内容视图）：
 *   1. 选股器卡列表（内置 − 墓碑、覆盖原位替换、自定义追加；来源徽标 + 管理操作）
 *   2. 参数 + 扫描池上限 + 运行/停止条
 *   3. 扫描进度条 + 命中结果表（代码/名称/现价/动态指标列/信号说明）
 *
 * 扫描调度在本层：名册 fetchSymbols（桥 30min 缓存）→ 截断到扫描池上限 →
 * 受限并发逐标的拉 500 根日 K → 纯函数 evaluate。数据不足的标的由契约
 * 返回 null 静默跳过；单标的失败（含空 K 线响应）只计数不中断扫描。
 *
 * 选股器管理（2026-09-07）：名册经 applyScreenerManagement 合成；桥拉取记录
 * 与墓碑，SSE 'strategies' 信号重拉；编辑器（ScreenerEditor）新建/编辑/覆盖。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  screenerParadigms,
  validateCustomScreener,
  applyScreenerManagement,
  isBuiltinScreenerId,
  builtinScreenerRecord,
  workerComputeRunner,
  fmtPrice,
  type Kline,
  type ScreenerDefinition,
  type CustomScreenerRecord,
} from '@dshtrading/strategies'
import { readJson, writeJson } from './shell-faces.ts'
import { screenerName, screenerSummary, screenerParamLabel, screenerColumnLabel, screenerReason } from './strategy-locale.ts'
import { ScreenerEditor, type ScreenerEditorSaveInput } from './ScreenerEditor.tsx'
import type { StrategyLocaleKey } from './contract.ts'
import css from './StrategyView.module.css'

interface ScreenerStateStored {
  screenerId: string
  paramsMap: Record<string, Record<string, number>>
  scanLimit: number
}

const SCREENER_STORE_KEY = 'dshtrading.screener.v1'

/** 自定义选股器扫描时的单符号 Worker 超时（真实 500 根 K 线，较校验样例放宽）。 */
const SCAN_EVAL_TIMEOUT_MS = 1000

const DEFAULT_STORED: ScreenerStateStored = {
  screenerId: 'scr.ma-bull-align',
  paramsMap: {},
  scanLimit: 300,
}

/** 扫描并发上限：保护公共数据源（每标的 1 次日 K 请求），不追求扫描速度。 */
const SCAN_CONCURRENCY = 5

const SCAN_LIMIT_MIN = 50
const SCAN_LIMIT_MAX = 800

/**
 * 单次扫描的日 K 窗口。必须覆盖全部内置选股器在参数上限下的数据需求，
 * 否则 evaluate 对所有标的返回 null（数据不足），扫描会以「零命中」的
 * 假阴性收场：near-high 最长（window 上限 500），above-ma 次之
 * （period 300 + slopeBars 60 - 1 = 359）。
 */
const SCAN_KLINE_LIMIT = 500

interface ScanRow {
  readonly symbol: string
  readonly name?: string
  readonly price: number
  readonly metrics: Readonly<Record<string, number>>
  readonly reason: string
  readonly reasonKey?: string
  readonly reasonParams?: Readonly<Record<string, string | number>>
}

function formatMetric(val: number, format?: 'percent' | 'number'): string {
  if (!Number.isFinite(val)) return '--'
  return format === 'percent' ? `${val.toFixed(2)}%` : val.toFixed(2)
}

export interface ScreenerPaneProps {
  t: (key: StrategyLocaleKey, params?: Record<string, unknown>) => string
  market: string
  bridge: {
    fetchKlines: (market: string, symbol: string, interval: string, limit: number) => Promise<Kline[]>
    fetchSymbols: (market: string) => Promise<Array<{ symbol: string; name?: string }>>
    subscribeTradingEvents?: ((handlers: { strategies?: () => void }) => () => void) | undefined
    fetchCustomScreeners?: (() => Promise<Array<Record<string, unknown>>>) | undefined
    saveCustomScreener?: ((input: ScreenerEditorSaveInput) => Promise<{ ok: true } | { ok: false; reason: string } | null>) | undefined
    deleteCustomScreener?: ((id: string) => Promise<boolean>) | undefined
    resetScreener?: ((id: string) => Promise<{ ok: boolean; changed: boolean } | null>) | undefined
    fetchStrategyTombstones?: (() => Promise<string[]>) | undefined
  }
}

export function ScreenerPane({ t, market, bridge }: ScreenerPaneProps) {
  const [stored] = useState<ScreenerStateStored>(() => readJson<ScreenerStateStored>(SCREENER_STORE_KEY, DEFAULT_STORED))
  const [selectedId, setSelectedId] = useState<string>(stored.screenerId ?? DEFAULT_STORED.screenerId)
  const [paramsMap, setParamsMap] = useState<Record<string, Record<string, number>>>(stored.paramsMap ?? {})
  const [scanLimit, setScanLimit] = useState<number>(() => {
    const raw = stored.scanLimit
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_STORED.scanLimit
    return Math.min(SCAN_LIMIT_MAX, Math.max(SCAN_LIMIT_MIN, raw))
  })

  // 选股器管理名册：桥拉取记录 + 墓碑 → 校验 → applyScreenerManagement 合成；
  // SSE 'strategies' 信号重拉（screener_* 工具/桥写入即时上榜）。
  const [customDefs, setCustomDefs] = useState<ScreenerDefinition[]>([])
  const [records, setRecords] = useState<CustomScreenerRecord[]>([])
  const [tombstones, setTombstones] = useState<string[]>([])
  const [reloadKey, setReloadKey] = useState(0)
  const bridgeRef = useRef(bridge)
  if (bridgeRef.current === null) bridgeRef.current = bridge
  const stableBridge = bridgeRef.current
  const hasManagement = stableBridge.fetchCustomScreeners !== undefined
    && stableBridge.saveCustomScreener !== undefined
    && stableBridge.deleteCustomScreener !== undefined
    && stableBridge.resetScreener !== undefined

  useEffect(() => {
    if (!hasManagement || stableBridge === undefined) return
    let cancelled = false
    // generation 令牌：SSE 突发时同一 effect 内会并发起多个 load()，后完成的
    // 旧响应不得覆盖新状态——只允许最新一代落 setState（与 StrategyView 同款）。
    let generation = 0
    const load = async () => {
      const gen = ++generation
      try {
        const rawRecords = await stableBridge.fetchCustomScreeners!()
        const defs: ScreenerDefinition[] = []
        const validRecords: CustomScreenerRecord[] = []
        for (const record of rawRecords) {
          const result = await validateCustomScreener(record as never)
          if (result.ok) {
            defs.push(result.definition)
            validRecords.push(result.record)
          }
        }
        const deleted = stableBridge.fetchStrategyTombstones !== undefined
          ? await stableBridge.fetchStrategyTombstones()
          : []
        if (cancelled || gen !== generation) return
        setCustomDefs(defs)
        setRecords(validRecords)
        setTombstones(deleted)
      } catch (e) {
        console.warn('[dsh-trading] failed to load custom screeners:', e)
      }
    }
    void load()
    const unsubscribe = stableBridge.subscribeTradingEvents?.({ strategies: () => { void load() } })
    return () => { cancelled = true; unsubscribe?.() }
  }, [stableBridge, hasManagement, reloadKey])

  // 名册 = 内置 − 墓碑，覆盖原位替换，自定义追加（无管理面 = 内置原样，旧行为）。
  const roster = useMemo<ScreenerDefinition[]>(() => (
    hasManagement ? applyScreenerManagement(screenerParadigms, customDefs, tombstones) : [...screenerParadigms]
  ), [customDefs, tombstones, hasManagement])

  const modifiedIds = useMemo(
    () => new Set(records.map((r) => r.id).filter((id) => isBuiltinScreenerId(id))),
    [records],
  )

  const tombstonedScreeners = useMemo<ScreenerDefinition[]>(() => {
    if (!hasManagement) return []
    return screenerParadigms.filter((d) => tombstones.includes(d.id))
  }, [tombstones, hasManagement])

  const currentScreener = useMemo<ScreenerDefinition | null>(() => {
    // 全部内置已删且无自定义时名册可为空（选股器管理边界）：返回 null 走空态。
    return roster.find((s) => s.id === selectedId) ?? roster[0] ?? null
  }, [roster, selectedId])

  const currentParams = useMemo<Record<string, number>>(() => {
    if (currentScreener === null) return {}
    const custom = paramsMap[currentScreener.id] ?? {}
    const res: Record<string, number> = {}
    for (const p of currentScreener.params) {
      res[p.key] = custom[p.key] ?? p.default
    }
    return res
  }, [currentScreener, paramsMap])

  // 同步持久化
  const persist = (next: ScreenerStateStored) => {
    writeJson(SCREENER_STORE_KEY, next)
  }

  const handleParamChange = (key: string, value: number) => {
    if (currentScreener === null) return
    const nextMap = {
      ...paramsMap,
      [currentScreener.id]: { ...(paramsMap[currentScreener.id] ?? {}), [key]: value },
    }
    setParamsMap(nextMap)
    persist({ screenerId: selectedId, paramsMap: nextMap, scanLimit })
  }

  const handleScanLimitChange = (value: number) => {
    if (!Number.isFinite(value)) return
    const clamped = Math.min(SCAN_LIMIT_MAX, Math.max(SCAN_LIMIT_MIN, Math.round(value)))
    setScanLimit(clamped)
    persist({ screenerId: selectedId, paramsMap, scanLimit: clamped })
  }

  /* ---------------- 选股器管理动作（2026-09-07） ---------------- */

  const forgetLocalParams = (id: string) => {
    setParamsMap((prev) => {
      if (prev[id] === undefined) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const handleDeleteScreener = async (screener: ScreenerDefinition) => {
    if (stableBridge.deleteCustomScreener === undefined) return
    if (!window.confirm(t('sv.mgmt.confirmDelete'))) return
    await stableBridge.deleteCustomScreener(screener.id)
    forgetLocalParams(screener.id)
    if (selectedId === screener.id) setSelectedId('')
  }

  const handleRestoreScreener = async (id: string) => {
    if (stableBridge.resetScreener === undefined) return
    // 已修改内置 = 覆盖记录将被清除且不可恢复（出厂代码不受影响），需显式确认。
    if (modifiedIds.has(id) && !window.confirm(t('sv.mgmt.confirmRestore'))) return
    const result = await stableBridge.resetScreener(id)
    if (result !== null && result.ok) forgetLocalParams(id)
  }

  const handleEditScreener = (screener: ScreenerDefinition) => {
    // 内置/已修改内置：从代码定义导出自包含源码预填；自定义：用 store 原记录。
    const record = modifiedIds.has(screener.id) || !isBuiltinScreenerId(screener.id)
      ? records.find((r) => r.id === screener.id) ?? null
      : builtinScreenerRecord(screener)
    if (record !== null) setEditor({ initial: record })
  }

  const handleSaveFromEditor = async (input: ScreenerEditorSaveInput) => {
    if (stableBridge.saveCustomScreener === undefined) return null
    return stableBridge.saveCustomScreener(input)
  }

  // 编辑器状态：null = 关闭；record = null 新建，否则编辑预填。
  const [editor, setEditor] = useState<{ initial: CustomScreenerRecord | null } | null>(null)

  // 扫描状态；runId 作为取消/过期令牌（自增即作废上一轮，worker 循环自查）。
  // scanScreener：扫描开始时冻结的选股器定义——SSE 名册重载可中途换 currentScreener，
  // 结果表（表头列 + 行数据）必须按同一份定义渲染，否则列错位（2026-09-07 审查）。
  const runIdRef = useRef(0)
  const [scanning, setScanning] = useState(false)
  const [scanScreener, setScanScreener] = useState<ScreenerDefinition | null>(null)
  const [progress, setProgress] = useState({ done: 0, total: 0, hits: 0, failed: 0 })
  const [universeSize, setUniverseSize] = useState<number | null>(null)
  const [rows, setRows] = useState<ScanRow[]>([])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleStop = () => {
    runIdRef.current += 1
    setScanning(false)
  }

  const handleRun = async () => {
    if (currentScreener === null) return
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    setScanning(true)
    setScanScreener(currentScreener)
    setRows([])
    setErrorMsg(null)
    setProgress({ done: 0, total: 0, hits: 0, failed: 0 })
    setUniverseSize(null)
    try {
      // 能力预检：宿主 tradingBridge 提供方若为旧版（无 fetchSymbols），
      // 落到「名册不可用」的诚实降级文案，而非泛化的 TypeError 报错。
      if (typeof bridge.fetchSymbols !== 'function') {
        setErrorMsg(t('sv.screener.noUniverse'))
        setScanning(false)
        return
      }
      const universe = await bridge.fetchSymbols(market)
      if (runIdRef.current !== runId) return
      if (!universe || universe.length === 0) {
        setErrorMsg(t('sv.screener.noUniverse'))
        setScanning(false)
        return
      }
      const capped = universe.slice(0, scanLimit)
      setUniverseSize(universe.length)
      setProgress({ done: 0, total: capped.length, hits: 0, failed: 0 })

      const hits: ScanRow[] = []
      let done = 0
      let failed = 0
      let cursor = 0

      // 自定义选股器 = 用户源码 → 扫描时走 Worker 超时熔断（1000ms/符号，
      // 远高于校验样例的 100ms：真实 500 根 K 线计算量更大）。源码从名册
      // 合成时的 store 记录取（builtinScreenerRecord 仅用于编辑预填，不在扫描面）。
      // 内置选股器 = 代码常量（可信任，且无源码形态）→ 维持同步直调用（旧行为）。
      const evaluateSourceById = new Map(records.map((r) => [r.id, r.evaluateSource] as const))
      const evalOne = async (bars: Kline[]): Promise<ReturnType<ScreenerDefinition['evaluate']>> => {
        const source = evaluateSourceById.get(currentScreener.id)
        if (source === undefined) return currentScreener.evaluate(bars, currentParams)
        return (await workerComputeRunner(source, bars, currentParams, SCAN_EVAL_TIMEOUT_MS)) as never
      }

      const worker = async () => {
        while (cursor < capped.length && runIdRef.current === runId) {
          const inst = capped[cursor]!
          cursor += 1
          try {
            const bars = await bridge.fetchKlines(market, inst.symbol, '1d', SCAN_KLINE_LIMIT)
            if (runIdRef.current !== runId) return
            if (bars && bars.length > 0) {
              const match = await evalOne(bars)
              if (match) {
                hits.push({
                  symbol: inst.symbol,
                  ...(inst.name ? { name: inst.name } : {}),
                  price: bars[bars.length - 1]!.close,
                  metrics: match.metrics,
                  reason: match.reason,
                  ...(match.reasonKey !== undefined ? { reasonKey: match.reasonKey } : {}),
                  ...(match.reasonParams !== undefined ? { reasonParams: match.reasonParams } : {}),
                })
              }
            } else {
              // 空响应（如上游静默返回 []）也按失败计：否则整体断供会被
              // 误报成「扫描成功、零命中」。
              failed += 1
            }
          } catch {
            failed += 1
          }
          done += 1
          if (runIdRef.current !== runId) return
          setProgress({ done, total: capped.length, hits: hits.length, failed })
          setRows([...hits])
        }
      }

      await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, capped.length) }, () => worker()))
      if (runIdRef.current !== runId) return
      // 有失败就明示（含空响应计数），不再被「已有命中」掩盖——命中与失败
      // 并存时用户仍需知道覆盖面有缺口。
      if (failed > 0) {
        setErrorMsg(`${t('sv.error.failed')} (${failed}/${capped.length})`)
      }
    } catch (e) {
      if (runIdRef.current !== runId) return
      setErrorMsg(`${t('sv.error.failed')}: ${String((e as Error)?.message ?? e)}`)
    } finally {
      if (runIdRef.current === runId) setScanning(false)
    }
  }

  if (currentScreener === null && tombstonedScreeners.length === 0 && !hasManagement) {
    // 无管理面的老壳 + 空名册：理论不可达（内置名册静态非空），保守空态。
    return (
      <div className={css.emptyState}>
        <div>{t('sv.screener.rosterEmpty')}</div>
      </div>
    )
  }

  return (
    <>
      {/* 工具行：新建选股器（管理面可用时） */}
      {hasManagement && (
        <div className={css.mgmtRow}>
          <span />
          <button type="button" className={css.newStrategyBtn} onClick={() => setEditor({ initial: null })}>
            + {t('sv.mgmt.newScreener')}
          </button>
        </div>
      )}

      {/* 选股器卡片（来源徽标 + 管理操作；扫描中锁定：行数据按运行时捕获的
          选股器评估，中途切换会造成表头/指标列/信号说明与行内容错位） */}
      <div className={css.strategyCards}>
        {roster.map((screener) => {
          const modified = modifiedIds.has(screener.id)
          const builtin = isBuiltinScreenerId(screener.id)
          return (
            <div
              key={screener.id}
              className={css.strategyCard}
              data-active={screener.id === selectedId ? 'true' : undefined}
              data-disabled={scanning ? 'true' : undefined}
              onClick={() => { if (!scanning) setSelectedId(screener.id) }}
            >
              <div className={css.cardTitleRow}>
                <span className={css.cardTitle}>{screenerName(screener, t)}</span>
                <span
                  className={css.cardBadge}
                  data-kind={modified ? 'modified' : builtin ? 'builtin' : 'custom'}
                >
                  {t(modified ? 'sv.mgmt.badge.modified' : builtin ? 'sv.mgmt.badge.builtin' : 'sv.mgmt.badge.custom')}
                </span>
              </div>
              <div className={css.cardSummary}>{screenerSummary(screener, t)}</div>
              {hasManagement && !scanning && (
                <div className={css.cardActions} onClick={(e) => e.stopPropagation()}>
                  <button type="button" className={css.cardActionBtn} onClick={() => handleEditScreener(screener)}>
                    {t('sv.mgmt.edit')}
                  </button>
                  {builtin && modified && (
                    <button type="button" className={css.cardActionBtn} onClick={() => { void handleRestoreScreener(screener.id) }}>
                      {t('sv.mgmt.restore')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={css.cardActionBtn}
                    data-danger="true"
                    onClick={() => { void handleDeleteScreener(screener) }}
                  >
                    {t('sv.mgmt.delete')}
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {tombstonedScreeners.map((screener) => (
          <div key={screener.id} className={css.strategyCard} data-deleted="true">
            <div className={css.cardTitleRow}>
              <span className={css.cardTitle}>{screenerName(screener, t)}</span>
              <span className={css.cardBadge} data-kind="deleted">{t('sv.mgmt.deleted')}</span>
            </div>
            <div className={css.cardSummary}>{screenerSummary(screener, t)}</div>
            <div className={css.cardActions} onClick={(e) => e.stopPropagation()}>
              <button type="button" className={css.cardActionBtn} onClick={() => { void handleRestoreScreener(screener.id) }}>
                {t('sv.mgmt.restore')}
              </button>
            </div>
          </div>
        ))}
      </div>

      {currentScreener === null ? (
        /* 名册为空（全部内置已删且无自定义，选股器管理边界）→ 空态 */
        <div className={css.emptyState}>
          <div>{t('sv.screener.rosterEmpty')}</div>
        </div>
      ) : (
        <>
          {/* 参数 + 扫描池上限 + 运行条 */}
          <div className={css.configBar}>
            {currentScreener.params.map((p) => (
              <div key={p.key} className={css.paramGroup}>
                <label className={css.paramLabel}>{screenerParamLabel(currentScreener, p, t)}:</label>
                <input
                  type="number"
                  className={css.paramInput}
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  disabled={scanning}
                  value={currentParams[p.key] ?? p.default}
                  onChange={(e) => {
                    const numVal = parseFloat(e.target.value)
                    if (!Number.isNaN(numVal)) handleParamChange(p.key, numVal)
                  }}
                />
              </div>
            ))}

            <div className={css.paramGroup}>
              <label className={css.paramLabel}>{t('sv.screener.scanLimit')}:</label>
              <input
                type="number"
                className={css.paramInput}
                min={SCAN_LIMIT_MIN}
                max={SCAN_LIMIT_MAX}
                step={50}
                disabled={scanning}
                value={scanLimit}
                onChange={(e) => {
                  const numVal = parseFloat(e.target.value)
                  if (!Number.isNaN(numVal)) handleScanLimitChange(numVal)
                }}
              />
            </div>

            {scanning ? (
              <button type="button" className={css.runBtn} onClick={handleStop}>
                {t('sv.screener.stop')}
              </button>
            ) : (
              <button type="button" className={css.runBtn} onClick={() => { void handleRun() }}>
                {t('sv.screener.run')}
              </button>
            )}
          </div>

          {/* 进度与名册信息 */}
          {(scanning || universeSize !== null) && (
            <div className={css.scanMeta}>
              <span>
                {t('sv.screener.universePrefix')} {universeSize ?? '--'} · {t('sv.screener.scanned')}{' '}
                {progress.done}/{progress.total} · {t('sv.screener.hits')} {progress.hits} ·{' '}
                {t('sv.screener.failed')} {progress.failed}
              </span>
              <div className={css.progressWrap}>
                <div
                  className={css.progressFill}
                  style={{ width: progress.total > 0 ? `${(progress.done / progress.total) * 100}%` : '0%' }}
                />
              </div>
            </div>
          )}

          {errorMsg && <div className={css.errorMessage}>{errorMsg}</div>}

          {/* 命中结果表（表头按 scanScreener 冻结定义渲染，避免扫描中 SSE 名册
              重载换列后列与行数据错位；非扫描态回落 currentScreener） */}
          <div className={css.tableSection}>
            <div className={css.tableTitle}>
              {t('sv.screener.hits')} ({rows.length})
            </div>
            <div className={css.tradesTableWrapper}>
              <table className={css.tradesTable}>
                <thead>
                  <tr>
                    <th>{t('sv.screener.col.symbol')}</th>
                    <th>{t('sv.screener.col.name')}</th>
                    <th>{t('sv.screener.col.price')}</th>
                    {(scanning ? scanScreener : currentScreener)?.columns.map((col) => (
                      <th key={col.key}>{screenerColumnLabel(scanning ? scanScreener! : currentScreener, col, t)}</th>
                    ))}
                    <th>{t('sv.screener.col.reason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={4 + (scanning ? scanScreener : currentScreener)!.columns.length} className={css.tableEmptyCell}>
                        {scanning
                          ? t('sv.screener.scanning')
                          : progress.total > 0 && progress.failed === 0
                            ? t('sv.screener.noHits')
                            : t('sv.screener.emptyHint')}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr key={row.symbol}>
                        <td>{row.symbol}</td>
                        <td className={css.nameCell}>{row.name ?? '--'}</td>
                        <td>{fmtPrice(row.price)}</td>
                        {(scanning ? scanScreener : currentScreener)!.columns.map((col) => (
                          <td key={col.key}>{formatMetric(row.metrics[col.key] ?? NaN, col.format)}</td>
                        ))}
                        <td className={css.reasonCell}>{screenerReason(row, t)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* 选股器编辑器（新建/编辑/覆盖内置；模态覆盖层） */}
      {editor !== null && (
        <ScreenerEditor
          t={t}
          initial={editor.initial}
          onSave={handleSaveFromEditor}
          onSaved={() => setReloadKey((k) => k + 1)}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  )
}
