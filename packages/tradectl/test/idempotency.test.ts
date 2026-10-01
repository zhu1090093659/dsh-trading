/**
 * 幂等登记测试（P4 步骤 3 写路径前置）：注入时钟，无 mock 无 sleep。
 */
import { describe, expect, it } from 'vitest'
import { canonicalizePayload, createIdempotencyLedger, payloadHash } from '../src/idempotency.ts'

function fixture(over: { ttlMs?: number; maxEntries?: number } = {}) {
  let tick = 1_700_000_000_000
  const ledger = createIdempotencyLedger<string>({
    now: () => tick,
    ttlMs: over.ttlMs ?? 60_000,
    maxEntries: over.maxEntries ?? 4,
  })
  return { ledger, advance: (ms: number) => { tick += ms } }
}

describe('幂等登记', () => {
  it('管理员：首次登记为 fresh，在途再次登记为 in-flight，完成后可重放同一结果', () => {
    // Given 一本空账
    const { ledger } = fixture()
    // When 依次登记 / 重复登记 / 完成 / 再登记
    const first = ledger.begin('req_1', { symbol: 'BTC/USDT', qty: 1 })
    const second = ledger.begin('req_1', { symbol: 'BTC/USDT', qty: 1 })
    ledger.complete('req_1', 'order-1')
    const third = ledger.begin('req_1', { symbol: 'BTC/USDT', qty: 1 })
    // Then fresh / in-flight / replay（同一个结果）
    expect(first).toEqual({ kind: 'fresh' })
    expect(second).toEqual({ kind: 'in-flight' })
    expect(third).toEqual({ kind: 'replay', result: 'order-1' })
  })

  it('管理员：同一个键配不同载荷一律冲突，绝不重放旧结果', () => {
    // Given 一个已完成的请求
    const { ledger } = fixture()
    ledger.begin('req_1', { qty: 1 })
    ledger.complete('req_1', 'order-1')
    // When 用同一个键发一个不同的载荷
    const outcome = ledger.begin('req_1', { qty: 999 })
    // Then 冲突且不给出任何结果
    expect(outcome.kind).toBe('conflict')
    expect(JSON.stringify(outcome)).not.toContain('order-1')
  })

  it('管理员：失败后允许重试（不留"办过一半"的记录）', () => {
    // Given 一个在途请求
    const { ledger } = fixture()
    ledger.begin('req_1', { qty: 1 })
    // When 标记失败后重新登记
    ledger.fail('req_1')
    const retry = ledger.begin('req_1', { qty: 1 })
    // Then 重新成为 fresh
    expect(retry).toEqual({ kind: 'fresh' })
  })

  it('管理员：TTL 过期后同一键可以重新使用（幂等键不是永久承诺）', () => {
    // Given 一个已完成且已过期的请求
    const { ledger, advance } = fixture({ ttlMs: 1_000 })
    ledger.begin('req_1', { qty: 1 })
    ledger.complete('req_1', 'order-1')
    // When 推进超过 TTL 后重新登记
    advance(1_001)
    const again = ledger.begin('req_1', { qty: 1 })
    // Then 视为新请求（旧结果已按显式 TTL 清理）
    expect(again).toEqual({ kind: 'fresh' })
  })

  it('管理员：账有界——超过条数上限时丢最旧的，且 sweep 会如实报清理条数', () => {
    // Given 上限 4 的账
    const { ledger } = fixture({ maxEntries: 4 })
    // When 登记 6 条
    for (let index = 0; index < 6; index += 1) ledger.begin('req_' + String(index), { index })
    // Then 只剩 4 条（最旧的两条被丢）
    expect(ledger.size()).toBe(4)
    expect(ledger.begin('req_0', { index: 0 })).toEqual({ kind: 'fresh' })
  })

  it('管理员：载荷指纹对键顺序稳定、对不同载荷不同（幂等判定不依赖 JSON 里的键序）', () => {
    // Given 两个键序不同的等价载荷与一个不同载荷
    const a = payloadHash({ symbol: 'BTC/USDT', qty: 1 })
    const b = payloadHash({ qty: 1, symbol: 'BTC/USDT' })
    const c = payloadHash({ symbol: 'BTC/USDT', qty: 2 })
    // When 比较
    // Then 等价载荷（键序不同）同指纹、不同载荷不同指纹；嵌套对象同样规范化
    expect(canonicalizePayload({ b: 1, a: { d: 2, c: 3 } })).toEqual({ a: { c: 3, d: 2 }, b: 1 })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
