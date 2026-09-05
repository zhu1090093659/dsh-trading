/**
 * 统一资产台账聚合引擎（Issue #65，设计契约 §6.2）——纯函数，vitest 重点。
 *
 * 输入 TaggedPosition[]（paper/live/imported 三源）+ 盯市价格表（键
 * `${market}:${symbol}`，drawer 展开时按市场批量 fetchTickers 填充）+ FX 快照，
 * 输出明细行 / 按 market:symbol 汇总行 / 顶部小计（分来源、分币种、总资产）。
 *
 * 语义定稿：
 * - markPrice：批量盯市价格优先，缺位回退持仓自带 markPrice（paper 旧链路
 *   updatePrices / live 连接器快照）；
 * - uPnL：有成本价且有现价 → 重算 (mark − entry) × size；缺成本价 → 回退持仓自带
 *   unrealizedPnl（live 连接器可能已算好）；都没有 → undefined（不显示）；
 * - 币种：position.currency 优先，缺省按 market 推导（§2 推导表）；market 也未知
 *   （旧 paper 数据）→ undefined，进未折算分区（币种桶 'UNKNOWN'）；
 * - 折算：rates[currency] × 原币；currency === fx.base 恒按 1（基准恒等，不依赖
 *   rates 是否回带基准项）；fx 缺席 → 全部不折算；
 * - FX stale：仍折算（过期缓存/恒等兜底也是最佳可得），但 approximate=true——
 *   「总资产仍给出但标注近似」（§6.2）；缺汇率的币种进「未折算小计」分区，
 *   不计入总资产，approximate 同为 true。
 */
import type { FxSnapshot, HoldingsBaseCurrency, HoldingCurrency, PositionOrigin, TaggedPosition } from './holdings-types.ts'
import { DEFAULT_HOLDINGS_BASE_CURRENCY, MARKET_DEFAULT_CURRENCY, holdingsPriceKey } from './holdings-types.ts'
import type { MarketId } from './types.ts'

/** 明细行：单个 TaggedPosition 的盯市与折算结果。 */
export interface HoldingDetailRow {
  readonly position: TaggedPosition
  /** 结算币种（position.currency ?? market 推导）；皆缺 → undefined。 */
  readonly currency: HoldingCurrency | undefined
  readonly markPrice: number | undefined
  /** 市值（原币）= markPrice × size；无现价 → undefined。 */
  readonly marketValue: number | undefined
  /** 市值（折算基准币）；无汇率/无现价 → undefined。 */
  readonly marketValueBase: number | undefined
  /** 浮动盈亏（原币）；无成本价且无预计算 → undefined。 */
  readonly unrealizedPnl: number | undefined
  readonly unrealizedPnlBase: number | undefined
  /** 市值是否已折算进总资产。 */
  readonly converted: boolean
}

/** 汇总行：按 `market:symbol` 聚合（market 未知的旧 paper 数据键为 `unknown:<symbol>`）。 */
export interface HoldingSummaryRow {
  readonly key: string
  readonly market: MarketId | undefined
  readonly symbol: string
  readonly totalSize: number
  /** 组内共同币种；混合/未知 → undefined（此时原币合计无意义，看折算列）。 */
  readonly currency: HoldingCurrency | undefined
  /** 加权成本（只计有成本价且同币种的行；分母为那些行的 size 合计）。 */
  readonly weightedCost: number | undefined
  readonly markPrice: number | undefined
  /** 总市值（原币，组内同币种才有）。 */
  readonly marketValue: number | undefined
  /** 总市值（折算）；仅当组内所有有市值的行都可折算时给出，否则 undefined。 */
  readonly marketValueBase: number | undefined
  readonly unrealizedPnl: number | undefined
  readonly unrealizedPnlBase: number | undefined
  /** 来源分布（首次出现序）。 */
  readonly origins: readonly PositionOrigin[]
  /** 账户分布（首次出现序）。 */
  readonly accounts: readonly string[]
  /** 组内明细行（UI 展开分账户明细）。 */
  readonly members: readonly HoldingDetailRow[]
}

/** 币种小计；amountBase 仅可折算时给出（未折算分区条目没有）。 */
export interface CurrencySubtotal {
  readonly currency: string
  readonly amount: number
  readonly amountBase?: number
}

/** 分来源小计（真实导入/实盘/模拟各自的折算市值与未折算分区）。 */
export interface OriginSubtotal {
  readonly origin: PositionOrigin
  readonly count: number
  readonly totalBase: number
  readonly unconverted: readonly CurrencySubtotal[]
}

export interface HoldingsAggregation {
  readonly base: HoldingsBaseCurrency
  /** FX 快照是否为过期缓存/恒等兜底（fx 缺席视为 false——那时一切进未折算分区）。 */
  readonly fxStale: boolean
  readonly rows: readonly HoldingDetailRow[]
  readonly summaries: readonly HoldingSummaryRow[]
  /** 总资产 = Σ 折算市值（不含未折算分区）。 */
  readonly totalBase: number
  /** FX stale 或存在未折算分区 → 总资产为近似值。 */
  readonly approximate: boolean
  /** 未折算小计分区（缺汇率/缺币种的原币市值合计，按币种聚合）。 */
  readonly unconverted: readonly CurrencySubtotal[]
  /** 分来源小计（固定 paper/live/imported 序，只含出现的来源）。 */
  readonly byOrigin: readonly OriginSubtotal[]
  /** 分币种小计（原币市值合计，按币种代码升序）。 */
  readonly byCurrency: readonly CurrencySubtotal[]
}

/** 无有效市值持仓落入的未折算币种桶。 */
export const UNKNOWN_CURRENCY_BUCKET = 'UNKNOWN'

const ORIGIN_ORDER: readonly PositionOrigin[] = ['paper', 'live', 'imported']

function convert(value: number | undefined, currency: string | undefined, fx: FxSnapshot | undefined): number | undefined {
  if (value === undefined || currency === undefined || fx === undefined) return undefined
  if (currency === fx.base) return value
  const rate = fx.rates[currency]
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? value * rate : undefined
}

/** 单持仓 → 明细行（导出供 UI 单行场景复用；聚合主入口是 aggregateHoldings）。 */
export function detailRowOf(
  position: TaggedPosition,
  prices: Readonly<Record<string, number>>,
  fx: FxSnapshot | undefined,
): HoldingDetailRow {
  const key = position.market === undefined ? undefined : holdingsPriceKey(position.market, position.symbol)
  const batch = key === undefined ? undefined : prices[key]
  const markPrice = batch !== undefined && batch > 0 ? batch : position.markPrice
  const marketValue = markPrice !== undefined ? markPrice * position.size : undefined
  const unrealizedPnl =
    position.entryPrice !== undefined && markPrice !== undefined
      ? (markPrice - position.entryPrice) * position.size
      : position.unrealizedPnl
  const currency = position.currency ?? (position.market === undefined ? undefined : MARKET_DEFAULT_CURRENCY[position.market])
  const marketValueBase = convert(marketValue, currency, fx)
  return {
    position,
    currency,
    markPrice,
    marketValue,
    marketValueBase,
    unrealizedPnl,
    unrealizedPnlBase: convert(unrealizedPnl, currency, fx),
    converted: marketValueBase !== undefined,
  }
}

function pushAmount(map: Map<string, number>, currency: string, amount: number): void {
  map.set(currency, (map.get(currency) ?? 0) + amount)
}

function subtotalsOf(map: Map<string, number>, fx: FxSnapshot | undefined): CurrencySubtotal[] {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => {
      const amountBase = convert(amount, currency, fx)
      return amountBase === undefined ? { currency, amount } : { currency, amount, amountBase }
    })
}

/**
 * 聚合主入口。positions 顺序保留在 rows；summaries 按折算市值降序（无市值者按键名
 * 字典序殿后）；byOrigin 固定 paper/live/imported 序，只含出现的来源。
 */
export function aggregateHoldings(
  positions: readonly TaggedPosition[],
  prices: Readonly<Record<string, number>> = {},
  fx: FxSnapshot | undefined = undefined,
): HoldingsAggregation {
  const base: HoldingsBaseCurrency = fx?.base ?? DEFAULT_HOLDINGS_BASE_CURRENCY
  const rows = positions.map(position => detailRowOf(position, prices, fx))

  // ── 汇总行（market:symbol 分组，保首次出现序）──────────────────────
  const groups = new Map<string, HoldingDetailRow[]>()
  for (const row of rows) {
    const market = row.position.market
    const key = `${market ?? 'unknown'}:${row.position.symbol}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [row])
    else bucket.push(row)
  }

  const summaries: HoldingSummaryRow[] = []
  for (const [key, members] of groups) {
    const first = members[0] as HoldingDetailRow
    const currencies = new Set(members.map(m => m.currency))
    // 同质组 = 组内同币种（含「全部未知」——同一 paper 账本事实同币）；混合币种时
    // 原币口径的加权成本/市值/浮盈无意义，只留折算列。
    const homogeneous = currencies.size === 1
    const commonCurrency = homogeneous ? first.currency : undefined
    const totalSize = members.reduce((sum, m) => sum + m.position.size, 0)
    let costSum = 0
    let costSize = 0
    if (homogeneous) {
      for (const m of members) {
        if (m.position.entryPrice === undefined) continue
        costSum += m.position.entryPrice * m.position.size
        costSize += m.position.size
      }
    }
    const valued = members.filter(m => m.marketValue !== undefined)
    const marketValue =
      homogeneous && valued.length > 0
        ? valued.reduce((sum, m) => sum + (m.marketValue as number), 0)
        : undefined
    const allConverted = valued.length > 0 && valued.every(m => m.marketValueBase !== undefined)
    const marketValueBase = allConverted
      ? valued.reduce((sum, m) => sum + (m.marketValueBase as number), 0)
      : undefined
    const pnlValued = members.filter(m => m.unrealizedPnl !== undefined)
    const unrealizedPnl =
      homogeneous && pnlValued.length > 0
        ? pnlValued.reduce((sum, m) => sum + (m.unrealizedPnl as number), 0)
        : undefined
    const allPnlConverted = pnlValued.length > 0 && pnlValued.every(m => m.unrealizedPnlBase !== undefined)
    const unrealizedPnlBase = allPnlConverted
      ? pnlValued.reduce((sum, m) => sum + (m.unrealizedPnlBase as number), 0)
      : undefined
    const origins: PositionOrigin[] = []
    const accounts: string[] = []
    for (const m of members) {
      if (!origins.includes(m.position.origin)) origins.push(m.position.origin)
      if (!accounts.includes(m.position.account)) accounts.push(m.position.account)
    }
    summaries.push({
      key,
      market: first.position.market,
      symbol: first.position.symbol,
      totalSize,
      currency: commonCurrency,
      weightedCost: costSize > 0 ? costSum / costSize : undefined,
      markPrice: first.markPrice,
      marketValue,
      marketValueBase,
      unrealizedPnl,
      unrealizedPnlBase,
      origins,
      accounts,
      members,
    })
  }
  summaries.sort((a, b) => {
    const av = a.marketValueBase ?? a.marketValue
    const bv = b.marketValueBase ?? b.marketValue
    if (av === undefined && bv === undefined) return a.key.localeCompare(b.key)
    if (av === undefined) return 1
    if (bv === undefined) return -1
    return bv - av
  })

  // ── 顶部小计 ────────────────────────────────────────────────
  let totalBase = 0
  const unconvertedMap = new Map<string, number>()
  const byCurrencyMap = new Map<string, number>()
  const originBuckets = new Map<PositionOrigin, { count: number; totalBase: number; unconverted: Map<string, number> }>()
  for (const row of rows) {
    const bucketKey = row.currency ?? UNKNOWN_CURRENCY_BUCKET
    if (row.marketValue !== undefined) pushAmount(byCurrencyMap, bucketKey, row.marketValue)
    let originBucket = originBuckets.get(row.position.origin)
    if (originBucket === undefined) {
      originBucket = { count: 0, totalBase: 0, unconverted: new Map() }
      originBuckets.set(row.position.origin, originBucket)
    }
    originBucket.count += 1
    if (row.marketValueBase !== undefined) {
      totalBase += row.marketValueBase
      originBucket.totalBase += row.marketValueBase
    } else if (row.marketValue !== undefined) {
      pushAmount(unconvertedMap, bucketKey, row.marketValue)
      pushAmount(originBucket.unconverted, bucketKey, row.marketValue)
    }
  }
  const fxStale = fx?.stale === true
  const unconverted = [...unconvertedMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ currency, amount }))
  const byOrigin = ORIGIN_ORDER.flatMap(origin => {
    const bucket = originBuckets.get(origin)
    if (bucket === undefined) return []
    return [{
      origin,
      count: bucket.count,
      totalBase: bucket.totalBase,
      unconverted: [...bucket.unconverted.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amount]) => ({ currency, amount })),
    }]
  })
  return {
    base,
    fxStale,
    rows,
    summaries,
    totalBase,
    approximate: fxStale || unconverted.length > 0,
    unconverted,
    byOrigin,
    byCurrency: subtotalsOf(byCurrencyMap, fx),
  }
}
