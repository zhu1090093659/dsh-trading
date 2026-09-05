/**
 * 统一资产台账（Issue #65）client 半类型——设计契约 docs/design/holdings-ledger.md §6.1。
 *
 * Holding/NewHolding/HoldingCurrency 来自 @dshtrading/holdings（type-only import，
 * 打包期擦除，与 types.ts 的 client 半纪律一致）；本模块同时作为 client 半对
 * 该包类型的唯一 import 点并 re-export，其余 client 模块一律从本模块取型。
 *
 * 偏差说明（已回报设计契约）：契约 §6.1 字面上 `TaggedPosition extends Position`，
 * 但 @dshtrading/api 的 Position.entryPrice 是必填 number，而契约 §2/§6.2 要求
 * imported 持仓允许缺成本价（uPnL 不显示）——必填字段无法表达「缺省」，
 * 故实现改为 `extends Omit<Position, 'entryPrice'>` + 可选 entryPrice，语义不变。
 */
import type { Holding, HoldingCurrency, NewHolding, NewHoldingInput } from '@dshtrading/holdings'
import type { MarketId, Position } from './types.ts'

export type { Holding, HoldingCurrency, NewHolding, NewHoldingInput }

/** 持仓血缘（§1）：创建后不可变。 */
export type PositionOrigin = 'paper' | 'live' | 'imported'

/** 用户面向标签（§1）：paper 恒 sim、live 恒 real；imported 缺省 real、可改标。 */
export type PositionKind = 'real' | 'sim'

/**
 * 三来源统一持仓行（§6.1）：结构扩展 Position，@dshtrading/api 契约不改。
 */
export interface TaggedPosition extends Omit<Position, 'entryPrice'> {
  /** 成本价；imported 截图无成本时缺省（uPnL 不显示）。 */
  readonly entryPrice?: number
  readonly origin: PositionOrigin
  readonly kind: PositionKind
  /** paper 旧数据可能未知 → undefined（不参与批量盯市，汇总显示「未知市场」）。 */
  readonly market: MarketId | undefined
  /** paper→模拟账户；live→provider 名；imported→用户命名。 */
  readonly account: string
  /** origin==='imported' 时回指 store 记录（编辑/删除入口）。 */
  readonly holdingId?: string
  readonly currency?: HoldingCurrency
}

/** 汇总基准币（§4 FX 服务只支持 USD/CNY/HKD；USDT 恒定锚定 USD 不作基准）。 */
export type HoldingsBaseCurrency = 'USD' | 'CNY' | 'HKD'

export const HOLDINGS_BASE_CURRENCIES: readonly HoldingsBaseCurrency[] = ['USD', 'CNY', 'HKD']

/** 基准币选择持久化键（§6.3，缺省 USD）。 */
export const HOLDINGS_BASE_CURRENCY_KEY = 'dshtrading:holdings:baseCurrency'

export const DEFAULT_HOLDINGS_BASE_CURRENCY: HoldingsBaseCurrency = 'USD'

/**
 * FX 快照（§3 /fx 应答形状）：rates[c] = 1 单位 c 折合多少 base
 * （USD 基准时 {USD:1, USDT:1, CNY:0.14, HKD:0.128}）。
 * stale:true 表示过期缓存或恒等兜底（首拉失败且无缓存）。
 */
export interface FxSnapshot {
  readonly base: HoldingsBaseCurrency
  readonly rates: Record<string, number>
  readonly asOf: number
  readonly stale: boolean
}

/** 持仓台账快照（§3 GET /holdings 应答的有效载荷）。 */
export interface HoldingsBookSnapshot {
  readonly revision: number
  readonly staged: Holding[]
  readonly holdings: Holding[]
}

/** 市场缺省币种推导（§2：crypto→USDT, us→USD, cn→CNY, hk→HKD）。 */
export const MARKET_DEFAULT_CURRENCY: Record<MarketId, HoldingCurrency> = {
  crypto: 'USDT',
  us: 'USD',
  cn: 'CNY',
  hk: 'HKD',
}

/** 盯市价格表的键（§6.2：`${market}:${symbol}`）。 */
export function holdingsPriceKey(market: MarketId, symbol: string): string {
  return `${market}:${symbol}`
}

/** 全部持仓市场（四市场 live 拉取/盯市分组的迭代序，§6.4）。 */
export const HOLDINGS_MARKETS: readonly MarketId[] = ['crypto', 'us', 'cn', 'hk']
