/**
 * 基本面页签（2026-09-02）：公司基本信息网格，与「图表」页签在报价头右侧互斥切换。
 *
 * 数据两层：
 * - 桥 /fundamentals（腾讯报价行解析，cn/hk）：市值/PE/PB/换手率/52周区间等；
 * - 行情派生（连接器未实现基本面字段的市场，us/crypto）：日K 52 周高低——
 *   派生模式面板顶部给出降级说明，不报错横幅（fetchFundamentals 失败即 null）。
 *
 * 值缺省的单元格整格隐藏（不留 — 空位）；市场决定市值/价格单位词（元/美元/港元）。
 */
import { fmtCompact, fmtPrice } from './format.ts'
import type { Kline, MarketId, StockFundamentals } from './types.ts'
import type { MarketLocaleKey } from './contract.ts'
import css from './fundamentals-pane.module.css'

export type FundamentalsTranslate = (key: MarketLocaleKey) => string

export interface FundamentalsPaneProps {
  t: FundamentalsTranslate
  market: MarketId
  symbol: string
  name?: string | undefined
  /** 桥 /fundamentals 快照；null = 该市场数据源不带基本面字段（派生模式）。 */
  fundamentals: StockFundamentals | null
  loading: boolean
  /** 日K派生 52 周区间（派生模式或快照缺字段时兜底）。 */
  derivedFiftyTwoWeek: { high?: number; low?: number }
}

const UNIT_KEY: Record<MarketId, MarketLocaleKey> = {
  cn: 'fundamentals.unit.cn',
  us: 'fundamentals.unit.us',
  hk: 'fundamentals.unit.hk',
  crypto: 'fundamentals.unit.crypto',
}

export function FundamentalsPane({ t, market, symbol, name, fundamentals, loading, derivedFiftyTwoWeek }: FundamentalsPaneProps): React.JSX.Element {
  const week52High = fundamentals?.fiftyTwoWeekHigh ?? derivedFiftyTwoWeek.high
  const week52Low = fundamentals?.fiftyTwoWeekLow ?? derivedFiftyTwoWeek.low
  const derivedOnly = fundamentals === null && !loading

  const cells: Array<{ label: string; value: string } | null> = [
    cell(t('fundamentals.peTtm'), num(fundamentals?.peTtm, 2)),
    cell(t('fundamentals.peDynamic'), num(fundamentals?.peDynamic, 2)),
    cell(t('fundamentals.pb'), num(fundamentals?.pb, 2)),
    // 契约语义小数（0.0117 = 1.17%）；腾讯未给（cn）则整格隐藏。
    fundamentals?.dividendYield !== undefined
      ? cell(t('fundamentals.dividendYield'), `${(fundamentals.dividendYield * 100).toFixed(2)}%`)
      : null,
    cell(t('fundamentals.marketCap'), compact(fundamentals?.marketCap, t(UNIT_KEY[market]))),
    cell(t('fundamentals.floatMarketCap'), compact(fundamentals?.floatMarketCap, t(UNIT_KEY[market]))),
    // 腾讯 wire 的换手率就是百分比数值（0.06 = 0.06%）。
    cell(t('fundamentals.turnoverRate'), percentValue(fundamentals?.turnoverRate)),
    cell(t('fundamentals.fiftyTwoWeekHigh'), priceValue(week52High)),
    cell(t('fundamentals.fiftyTwoWeekLow'), priceValue(week52Low)),
  ]
  const visible = cells.filter(entry => entry !== null) as Array<{ label: string; value: string }>

  return (
    <div className={css.root} data-dshtrading-fundamentals="">
      {derivedOnly && <div className={css.degraded}>{t('fundamentals.unavailable')}</div>}
      <div className={css.grid}>
        {visible.length > 0
          ? visible.map(entry => (
            <div key={entry.label} className={css.cell}>
              <span className={css.cellLabel}>{entry.label}</span>
              <span className={css.cellValue}>{entry.value}</span>
            </div>
          ))
          : (
            <div className={css.cell}>
              <span className={css.cellLabel}>{name ?? symbol}</span>
              <span className={css.cellValue}>{loading ? '…' : '—'}</span>
            </div>
          )}
      </div>
      <div className={css.footer}>
        {name !== undefined && <span>{name} · {symbol}</span>}
        {fundamentals !== null && (
          <span>{t('fundamentals.source')}: qt.gtimg.cn · {new Date(fundamentals.timestamp).toLocaleTimeString()}</span>
        )}
      </div>
    </div>
  )
}

function cell(label: string, value: string | undefined): { label: string; value: string } | null {
  if (value === undefined) return null
  return { label, value }
}

function num(value: number | undefined, digits: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return value.toFixed(digits)
}

function compact(value: number | undefined, unit: string): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return `${fmtCompact(value)} ${unit}`
}

function percentValue(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return `${value.toFixed(2)}%`
}

function priceValue(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return fmtPrice(value)
}

/** 日K → 52 周高低（QuoteStage 已拉 260 根日K，直接复用）。 */
export function deriveFiftyTwoWeek(daily: Kline[] | null): { high?: number; low?: number } {
  if (daily === null || daily.length === 0) return {}
  let high: number | undefined
  let low: number | undefined
  for (const bar of daily) {
    if (Number.isFinite(bar.high) && (high === undefined || bar.high > high)) high = bar.high
    if (Number.isFinite(bar.low) && (low === undefined || bar.low < low)) low = bar.low
  }
  return {
    ...(high !== undefined ? { high } : {}),
    ...(low !== undefined ? { low } : {}),
  }
}
