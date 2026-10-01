/**
 * 一元写的幂等登记（P4 步骤 3 写路径的前置）。
 *
 * 为什么幂等键必须由**服务端**记账：客户端在超时后会重试，而"这条请求到底执行了没有"
 * 只有服务端知道。没有这张账，重试要么变成重复下单，要么变成"客户端以为没成功、其实成功了"
 * 的静默不一致——后者更危险，因为它会让客户端去做补偿动作。
 *
 * 三条不许妥协的规则：
 *   1. **同一 clientRequestId 携带不同载荷 ⇒ 冲突（拒绝），绝不重放旧结果**。重放等于把
 *      一个完全不同的意图当成"已经办过了"，是幂等设计里最容易被忽略也最危险的一条。
 *   2. **只有完成态可重放**；在途（in-flight）返回"正在处理"，失败态**允许重试**。
 *   3. **账有界**：TTL + 条数上限，过期条目被清掉——幂等键不是永久承诺（客户端不应无限重试
 *      一个小时前的请求），但清理必须是**显式策略**，不是"内存压力到了就丢"。
 *
 * @module @dshtrading/tractl/idempotency
 */
import { createHash } from 'node:crypto'

/** 一个已完成的登记。 */
export interface IdempotencyEntry<T> {
  readonly clientRequestId: string
  readonly payloadHash: string
  readonly state: 'in-flight' | 'done'
  readonly result?: T | undefined
  readonly atMs: number
}

/** 登记结果。 */
export type BeginOutcome<T> =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'in-flight' }
  | { readonly kind: 'replay'; readonly result: T }
  | { readonly kind: 'conflict'; readonly message: string }

export interface IdempotencyOptions {
  readonly now: () => number
  readonly ttlMs: number
  readonly maxEntries: number
}

/**
 * 载荷规范化：**递归按键排序**后再取指纹。
 * 为什么必须做：JSON 的键序在语义上无关，但 JSON.stringify 的输出对键序敏感——
 * 不规范化的话，客户端把同样的请求写成 {a,b} 与 {b,a} 会被判成"同一个键配了不同载荷"
 * 而遭到冲突拒绝；反过来，语义相同却被判不同的指纹也让幂等判定失去意义。
 */
export function canonicalizePayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map((item) => canonicalizePayload(item))
  if (payload !== null && typeof payload === "object") {
    const source = payload as Record<string, unknown>
    const ordered: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) ordered[key] = canonicalizePayload(source[key])
    return ordered
  }
  return payload
}

/** 载荷指纹：同一键配不同载荷必须能被发现；键序无关。 */
export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalizePayload(payload ?? null))).digest('hex').slice(0, 32)
}

/**
 * 建一本幂等账。
 * @param options - 时钟、TTL 与条数上限。
 */
export function createIdempotencyLedger<T>(options: IdempotencyOptions): {
  begin(clientRequestId: string, payload: unknown): BeginOutcome<T>
  complete(clientRequestId: string, result: T): void
  fail(clientRequestId: string): void
  size(): number
  /** 清理过期条目（显式调用，便于测试与审计；begin 时也会顺手清一次）。 */
  sweep(): number
} {
  const entries = new Map<string, IdempotencyEntry<T>>()
  const sweep = (): number => {
    const atMs = options.now()
    let removed = 0
    for (const [key, entry] of entries) {
      if (atMs - entry.atMs >= options.ttlMs) {
        entries.delete(key)
        removed += 1
      }
    }
    return removed
  }
  const enforceBound = (): void => {
    // 账有界：超出上限时丢**最旧**的（Map 保持插入序）。
    while (entries.size > options.maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done === true) return
      entries.delete(oldest.value)
    }
  }
  return {
    begin(clientRequestId, payload) {
      sweep()
      const hash = payloadHash(payload)
      const existing = entries.get(clientRequestId)
      if (existing !== undefined) {
        if (existing.payloadHash !== hash) {
          return { kind: 'conflict', message: 'clientRequestId ' + clientRequestId + ' was already used with a different payload' }
        }
        if (existing.state === 'in-flight') return { kind: 'in-flight' }
        return { kind: 'replay', result: existing.result as T }
      }
      entries.set(clientRequestId, { clientRequestId, payloadHash: hash, state: 'in-flight', atMs: options.now() })
      enforceBound()
      return { kind: 'fresh' }
    },
    complete(clientRequestId, result) {
      const existing = entries.get(clientRequestId)
      if (existing === undefined) return
      entries.set(clientRequestId, { ...existing, state: 'done', result, atMs: options.now() })
    },
    fail(clientRequestId) {
      // 失败态直接删掉：允许重试，且不留下"办过一半"的记录
      entries.delete(clientRequestId)
    },
    size: () => entries.size,
    sweep,
  }
}
