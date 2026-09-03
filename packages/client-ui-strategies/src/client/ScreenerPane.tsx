/**
 * 选股策略面板（一级「选股策略」分区的内容视图）：
 *   1. 选股器卡列表（内置名册，@dshtrading/strategies 纯函数）
 *   2. 参数 + 扫描池上限 + 运行/停止条
 *   3. 扫描进度条 + 命中结果表（代码/名称/现价/动态指标列/信号说明）
 *
 * 扫描调度在本层：名册 fetchSymbols（桥 30min 缓存）→ 截断到扫描池上限 →
 * 受限并发逐标的拉 500 根日 K → 纯函数 evaluate。数据不足的标的由契约
 * 返回 null 静默跳过；单标的失败（含空 K 线响应）只计数不中断扫描。
 */
import { useMemo, useRef, useState } from 'react'
import {
  screenerParadigms,
  type Kline,
  type ScreenerDefinition,
} from '@dshtrading/strategies'
import { readJson, writeJson } from './shell-faces.ts'
import { screenerName, screenerSummary, screenerParamLabel, screenerColumnLabel, screenerReason } from './strategy-locale.ts'
import type { StrategyLocaleKey } from './contract.ts'
import css from './StrategyView.module.css'

interface ScreenerStateStored {
  screenerId: string
  paramsMap: Record<string, Record<string, number>>
  scanLimit: number
}

const SCREENER_STORE_KEY = 'dshtrading.screener.v1'

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

  const currentScreener = useMemo<ScreenerDefinition>(() => {
    return screenerParadigms.find((s) => s.id === selectedId) ?? screenerParadigms[0]!
  }, [selectedId])

  const currentParams = useMemo<Record<string, number>>(() => {
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

  // 扫描状态；runId 作为取消/过期令牌（自增即作废上一轮，worker 循环自查）
  const runIdRef = useRef(0)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, hits: 0, failed: 0 })
  const [universeSize, setUniverseSize] = useState<number | null>(null)
  const [rows, setRows] = useState<ScanRow[]>([])
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleStop = () => {
    runIdRef.current += 1
    setScanning(false)
  }

  const handleRun = async () => {
    const runId = runIdRef.current + 1
    runIdRef.current = runId
    setScanning(true)
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

      const worker = async () => {
        while (cursor < capped.length && runIdRef.current === runId) {
          const inst = capped[cursor]!
          cursor += 1
          try {
            const bars = await bridge.fetchKlines(market, inst.symbol, '1d', SCAN_KLINE_LIMIT)
            if (runIdRef.current !== runId) return
            if (bars && bars.length > 0) {
              const match = currentScreener.evaluate(bars, currentParams)
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

  return (
    <>
      {/* 选股器卡片（扫描中锁定：行数据按运行时捕获的选股器评估，
          中途切换会造成表头/指标列/信号说明与行内容错位） */}
      <div className={css.strategyCards}>
        {screenerParadigms.map((screener) => (
          <div
            key={screener.id}
            className={css.strategyCard}
            data-active={screener.id === selectedId ? 'true' : undefined}
            data-disabled={scanning ? 'true' : undefined}
            onClick={() => { if (!scanning) setSelectedId(screener.id) }}
          >
            <div className={css.cardTitle}>{screenerName(screener, t)}</div>
            <div className={css.cardSummary}>{screenerSummary(screener, t)}</div>
          </div>
        ))}
      </div>

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

      {/* 命中结果表 */}
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
                {currentScreener.columns.map((col) => (
                  <th key={col.key}>{screenerColumnLabel(currentScreener, col, t)}</th>
                ))}
                <th>{t('sv.screener.col.reason')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4 + currentScreener.columns.length} className={css.tableEmptyCell}>
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
                    <td>{row.price.toFixed(2)}</td>
                    {currentScreener.columns.map((col) => (
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
  )
}
