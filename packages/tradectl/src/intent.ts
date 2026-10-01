/**
 * 下单意图：**没有额度字段**（P3 步骤 1 的不变量）。
 *
 * 这不是省略，是设计：额度只存在于 mandate（人类签过名的那份授权）。意图里若能写
 * "我要下 10 万"，那么任何能拼出意图的代码路径都在事实上拥有扩权能力——不可表达即
 * 不可自我扩权。要下更大的单，只能去改 mandate，而那条路必须重新签名。
 *
 * 测试里用 assertIntentHasNoQuotaFields 把这个不变量钉在运行时（类型层的变化会先让
 * 类型检查失败，运行时断言再兜住"有人用 as any 塞进来"这条路）。
 *
 * @module @dshtrading/tractl/intent
 */
import type { MandateDoc } from './mandate.ts'

/** 下单意图允许的键（白名单，逐字列出）。 */
export const INTENT_FIELDS = ['symbol', 'side', 'type', 'quantity', 'limitPrice', 'clientOrderId', 'reason'] as const

export interface TradeIntent {
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly type: 'market' | 'limit'
  readonly quantity: number
  readonly limitPrice?: number | undefined
  readonly clientOrderId: string
  /** 为什么下这一单（人读的原因，不是额度）。 */
  readonly reason: string
}

/** 看起来像额度的键名（用于运行时兜底断言）。 */
const QUOTA_LIKE = /(notional|budget|quota|allowance|max[A-Z]|limit[A-Z]|allocation)/

/**
 * 运行时断言：意图里不得出现额度类字段。
 * @param intent - 待检查的意图（允许是 as any 塞进来的对象）。
 */
export function assertIntentHasNoQuotaFields(intent: unknown): void {
  if (intent === null || typeof intent !== 'object') throw new Error('intent must be an object')
  const record = intent as Record<string, unknown>
  const unknown = Object.keys(record).filter((key) => !(INTENT_FIELDS as readonly string[]).includes(key))
  const quotaLike = unknown.filter((key) => QUOTA_LIKE.test(key))
  if (quotaLike.length > 0) {
    throw new Error('intent must not carry quota fields (they belong to the mandate): ' + quotaLike.join(', '))
  }
  if (unknown.length > 0) {
    throw new Error('intent carries unknown fields: ' + unknown.join(', '))
  }
}

/**
 * 额度只从 mandate 取：这里只做"取"的动作，没有任何写回路径。
 * @param mandate - 人类签名的授权。
 */
export function mandateLimits(mandate: MandateDoc): {
  readonly notionalMax: number
  readonly positionNotionalMax: number
  readonly deskNotionalMax: number
  readonly maxOpenOrders: number
  readonly leverageMax: number
} {
  const { scope } = mandate
  return {
    notionalMax: scope.notionalMax,
    positionNotionalMax: scope.positionNotionalMax,
    deskNotionalMax: scope.deskNotionalMax,
    maxOpenOrders: scope.maxOpenOrders,
    leverageMax: scope.leverageMax,
  }
}
