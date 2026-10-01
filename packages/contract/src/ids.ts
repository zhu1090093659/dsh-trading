/**
 * id 冻结面（P4 步骤 1）：**哪些 id 可以给客户端看、哪些永远不能**。
 *
 * 三条不许妥协的规则（卡片原文）：
 *   1. %%clientRequestId%% **可见**——它是幂等键，客户端必须能带上它重试；
 *   2. %%clientOrderId%% **永不可见**——它能被用来绕开核心直接对 venue 讲话（很多交易所
 *      支持按 clientOrderId 撤单/查询）。一旦下发，客户端就拥有了"绕过执行核"的能力，
 *      而执行核的所有限额、mandate、风险闸门都是建立在"只有核心能对 venue 讲话"之上；
 *   3. %%orderId% = %%ord_%% + UUID——**只比较不解析**、不含 venue slug、禁止写死字面量，
 *      一律 factory 生成。禁止写死是为了防"某处硬编码一个 orderId 当常量用"，那会让
 *      "只比较"退化成"有语义"，进而有人开始从里面解析信息。
 *
 * %%venueOrderId%% 只是**字段**、永不作句柄：它属于 venue，随时可能变格式或被复用，
 * 拿它当句柄就等于把内部路由权交给外部编号。
 *
 * @module @dshtrading/contract/ids
 */
/**
 * 随机 UUID（Web Crypto）。
 * **为什么不用 node:crypto**：契约包要同时被服务端、网页 SPA 与移动 App 引用（卡片原文），
 * 而浏览器 bundle 里没有 node:crypto —— 2026-10-01 驾驶舱首次构建时正是被这一点挡下的
 * （rollup: "randomUUID" is not exported by "__vite-browser-external"）。
 * globalThis.crypto 在 Node >=19 与所有现代浏览器里都存在，于是这条依赖整个消失。
 */
function randomUuid(): string {
  return globalThis.crypto.randomUUID()
}

/** orderId 前缀（唯一允许出现该字面量的地方就是这里）。 */
export const ORDER_ID_PREFIX = 'ord_'

/** 可见的请求幂等键前缀。 */
export const CLIENT_REQUEST_ID_PREFIX = 'req_'

/** 生成一个 orderId。**只在执行核里调用**；客户端永远收不到 clientOrderId。 */
export function newOrderId(): string {
  return ORDER_ID_PREFIX + randomUuid()
}

/** 生成一个 clientRequestId（幂等键，客户端可见可重试）。 */
export function newClientRequestId(): string {
  return CLIENT_REQUEST_ID_PREFIX + randomUuid()
}

/** 形如 ord_<uuid> 的判定（**只用于比较与校验，不解析出任何语义**）。 */
export function isOrderId(value: unknown): value is string {
  return typeof value === 'string' && /^ord_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

/** 客户端可见的订单视图（**没有 clientOrderId**）。 */
export interface ClientOrderView {
  readonly orderId: string
  readonly clientRequestId: string
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly quantity: number
  readonly state: string
  /** venue 侧编号：只是字段，**不是句柄**。 */
  readonly venueOrderId?: string | undefined
}

/**
 * 把内部订单投影成客户端视图。**这是唯一的下发路径**：%%clientOrderId%% 在这里被丢掉，
 * 想加它回来就必须改这个函数（而不是某个调用点顺手带上）。
 * @param order - 内部订单（含 clientOrderId）。
 */
export function toClientOrderView(order: {
  orderId: string
  clientOrderId: string
  clientRequestId: string
  symbol: string
  side: 'buy' | 'sell'
  quantity: number
  state: string
  venueOrderId?: string | undefined
}): ClientOrderView {
  return {
    orderId: order.orderId,
    clientRequestId: order.clientRequestId,
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    state: order.state,
    ...(order.venueOrderId === undefined ? {} : { venueOrderId: order.venueOrderId }),
  }
}

/** 断言一个对象里没有 clientOrderId（下发给客户端前的最后一道闸）。 */
export function assertNoClientOrderId(payload: unknown): void {
  const seen = new Set<unknown>()
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, path + '[' + String(index) + ']'))
      return
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'clientOrderId') {
        throw new Error('clientOrderId must never reach a client (found at ' + (path === '' ? key : path + '.' + key) + ')')
      }
      walk(item, path === '' ? key : path + '.' + key)
    }
  }
  walk(payload, '')
}
