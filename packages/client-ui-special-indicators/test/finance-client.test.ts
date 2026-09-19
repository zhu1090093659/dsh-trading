/**
 * FinanceClient 契约测试（docs/api.md 口径）：
 * 凭据链惰性解析、Basic 认证头、限流/401 错误映射、TTL 缓存、失败不缓存
 * 与陈旧回源（stale-while-revalidate）。
 * 零 mock：上游为契约化 fake fetch（真实 Response 对象，可选闸门 Promise
 * 模拟慢上游），时钟为注入假时钟；等待一律 await 测试持有的闸门，不睡不轮询。
 */
import { describe, expect, it } from 'vitest'
import { FinanceClient, FinanceError } from '../src/finance-client.ts'

interface CapturedCall {
  url: string
  authorization: string | undefined
  userAgent: string | undefined
}

/** 契约化 fake fetch：按状态档回真实 Response（可选闸门模拟慢上游），记录调用面供断言。 */
function fakeFetch(sequence: Array<{ status?: number; body?: unknown; hold?: Promise<void> }>) {
  const calls: CapturedCall[] = []
  let cursor = 0
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    calls.push({ url: String(input), authorization: headers.get('authorization') ?? undefined, userAgent: headers.get('user-agent') ?? undefined })
    const step = sequence[Math.min(cursor, sequence.length - 1)]
    cursor += 1
    if (step.hold !== undefined) await step.hold
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { impl: impl as typeof globalThis.fetch, calls, count: () => cursor }
}

function makeClient(overrides: {
  password?: string
  username?: string
  sequence?: Array<{ status?: number; body?: unknown; hold?: Promise<void> }>
  now?: () => number
}) {
  const upstream = fakeFetch(overrides.sequence ?? [{ body: { ready: true } }])
  let clock = 1_000_000
  const client = new FinanceClient({
    baseUrl: 'https://finance.example.test',
    username: () => overrides.username ?? 'api',
    password: () => overrides.password ?? 'secret',
    fetchImpl: upstream.impl,
    now: overrides.now ?? (() => clock),
  })
  return { client, upstream, advance: (ms: number) => { clock += ms } }
}

describe('FinanceClient 凭据与请求面', () => {
  it('用户未配置凭据时请求被拒为 FINANCE_NOT_CONFIGURED 且不触网', async () => {
    // Given: 凭据链解析为空密码
    const { client, upstream } = makeClient({ password: '' })
    // When: 用户请求任意上游路径
    const error = await client.get('/api/snapshot', 1000).catch((e: unknown) => e)
    // Then: 业务错误码 NOT_CONFIGURED，且零网络调用（不内置密钥、不伪装请求）
    expect(error).toBeInstanceOf(FinanceError)
    expect((error as FinanceError).code).toBe('FINANCE_NOT_CONFIGURED')
    expect(upstream.count()).toBe(0)
  })

  it('用户凭据就绪时请求携带 Basic 认证头与标识 User-Agent', async () => {
    // Given: 用户名 api + 密码 secret
    const { client, upstream } = makeClient({ password: 'secret' })
    // When: 用户请求上游
    const payload = await client.get('/api/snapshot', 1000)
    // Then: 一次调用，Authorization 为 Basic base64(api:secret)，UA 标识客户端
    expect(payload).toEqual({ ready: true })
    expect(upstream.count()).toBe(1)
    expect(upstream.calls[0].authorization).toBe('Basic ' + Buffer.from('api:secret').toString('base64'))
    expect(upstream.calls[0].userAgent).toContain('dsh-trading-special-indicators')
    expect(upstream.calls[0].url).toBe('https://finance.example.test/api/snapshot')
  })

  it('用户遭遇上游 401 时映射 FINANCE_AUTH_FAILED 且不自动重试', async () => {
    // Given: 上游一律 401
    const { client, upstream } = makeClient({ sequence: [{ status: 401, body: 'unauthorized' }] })
    // When: 用户请求
    const error = await client.get('/api/snapshot', 1000).catch((e: unknown) => e)
    // Then: 认证失败错误码，调用次数恒为 1（docs/api.md：密码错误不应触发无限自动重试）
    expect((error as FinanceError).code).toBe('FINANCE_AUTH_FAILED')
    expect(upstream.count()).toBe(1)
  })

  it('用户遭遇 429 限流时映射 FINANCE_RATE_LIMITED', async () => {
    // Given: 上游 429
    const { client } = makeClient({ sequence: [{ status: 429 }] })
    // When: 用户请求
    const error = await client.get('/api/snapshot', 1000).catch((e: unknown) => e)
    // Then: 限流错误码
    expect((error as FinanceError).code).toBe('FINANCE_RATE_LIMITED')
  })

  it('用户遭遇 HTTP 200 + error 业务形态时映射 FINANCE_BUSINESS_ERROR', async () => {
    // Given: 上游 200 但负载含 error 字段（未知板块等形态）
    const { client } = makeClient({ sequence: [{ body: { error: 'unknown sector' } }] })
    // When: 用户请求
    const error = await client.get('/api/v2/sectors/999999', 1000).catch((e: unknown) => e)
    // Then: 业务错误透出，不按成功消费
    expect((error as FinanceError).code).toBe('FINANCE_BUSINESS_ERROR')
  })
})

describe('FinanceClient TTL 缓存', () => {
  it('用户缓存窗口内重复请求不再触网，窗口外重新拉取', async () => {
    // Given: 上游正常 + 注入假时钟
    const { client, upstream, advance } = makeClient({})
    // When: 用户同路径连取两次（窗口内），推进时钟过窗后再取
    await client.get('/api/snapshot', 60_000)
    await client.get('/api/snapshot', 60_000)
    advance(61_000)
    await client.get('/api/snapshot', 60_000)
    // Then: 触网 2 次（窗口内第二次走缓存）
    expect(upstream.count()).toBe(2)
  })

  it('用户请求失败后结果不进入缓存，重试仍然触网', async () => {
    // Given: 第一次 500、第二次恢复 200
    const { client, upstream } = makeClient({ sequence: [{ status: 500 }, { body: { ready: true } }] })
    // When: 用户连取两次同路径
    const error = await client.get('/api/snapshot', 60_000).catch((e: unknown) => e)
    const payload = await client.get('/api/snapshot', 60_000)
    // Then: 第一次失败不缓存，第二次真实重试成功
    expect((error as FinanceError).code).toBe('FINANCE_UPSTREAM_ERROR')
    expect(payload).toEqual({ ready: true })
    expect(upstream.count()).toBe(2)
  })

  it('用户并发同路径请求合并为一次上游调用（in-flight 去重）', async () => {
    // Given: 上游正常
    const { client, upstream } = makeClient({})
    // When: 用户并发发起三个同路径请求
    const [a, b, c] = await Promise.all([
      client.get('/api/snapshot', 60_000),
      client.get('/api/snapshot', 60_000),
      client.get('/api/snapshot', 60_000),
    ])
    // Then: 只触网一次，三者同负载（限流纪律：每客户端 10 req/s）
    expect(upstream.count()).toBe(1)
    expect(a).toEqual({ ready: true })
    expect(b).toEqual({ ready: true })
    expect(c).toEqual({ ready: true })
  })
})

describe('FinanceClient 陈旧回源（stale-while-revalidate）', () => {
  it('用户请求落在缓存窗口外时立即得到陈旧值，后台再验证平滑换新', async () => {
    // Given: 首拉已落地；上游第二次响应被闸住（模拟冷缓存上游重算十几秒）
    let openGate = (): void => undefined
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const { client, upstream, advance } = makeClient({
      sequence: [{ body: { v: 1 } }, { body: { v: 2 }, hold: gate }],
    })
    await client.get('/api/snapshot', 60_000)
    advance(61_000)
    // When: 用户在窗口外请求（上游仍被闸住）
    const stale = await client.getWithMeta('/api/snapshot', 60_000)
    // Then: 立即回陈旧值并如实标记 stale（不被慢上游阻塞）
    expect(stale.payload).toEqual({ v: 1 })
    expect(stale.meta.stale).toBe(true)
    expect(upstream.count()).toBe(2)
    // When: 后台再验证放行落定后用户再次请求
    openGate()
    await stale.meta.revalidated
    const fresh = await client.getWithMeta('/api/snapshot', 60_000)
    // Then: 缓存已换新，后续请求回新值且不再标记 stale
    expect(fresh.payload).toEqual({ v: 2 })
    expect(fresh.meta.stale).toBe(false)
    expect(fresh.meta.revalidated).toBeNull()
  })

  it('用户陈旧值服役期间并发请求合并为一次后台再验证', async () => {
    // Given: 窗口外陈旧条目 + 上游第二次响应被闸住
    let openGate = (): void => undefined
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const { client, upstream, advance } = makeClient({
      sequence: [{ body: { v: 1 } }, { body: { v: 2 }, hold: gate }],
    })
    await client.get('/api/snapshot', 60_000)
    advance(61_000)
    // When: 用户连续两次窗口外请求（再验证在途）
    const a = await client.getWithMeta('/api/snapshot', 60_000)
    const b = await client.getWithMeta('/api/snapshot', 60_000)
    // Then: 两者都拿到陈旧值，共享同一次再验证（限流纪律）
    expect(a.payload).toEqual({ v: 1 })
    expect(b.payload).toEqual({ v: 1 })
    expect(a.meta.stale).toBe(true)
    expect(b.meta.stale).toBe(true)
    openGate()
    await Promise.all([a.meta.revalidated, b.meta.revalidated])
    expect(upstream.count()).toBe(2)
  })

  it('用户后台再验证失败时陈旧值继续服役，上游恢复后自动换新', async () => {
    // Given: 首拉落地；窗口外第一次再验证 500、第二次恢复新负载
    const { client, upstream, advance } = makeClient({
      sequence: [{ body: { v: 1 } }, { status: 500 }, { body: { v: 3 } }],
    })
    await client.get('/api/snapshot', 60_000)
    advance(61_000)
    // When: 用户窗口外请求并等后台再验证落定（失败被吞，不抛给调用方）
    const stale = await client.getWithMeta('/api/snapshot', 60_000)
    await stale.meta.revalidated
    const still = await client.getWithMeta('/api/snapshot', 60_000)
    // Then: 陈旧值继续服役且如实标记，下一次再验证已发起
    expect(still.payload).toEqual({ v: 1 })
    expect(still.meta.stale).toBe(true)
    expect(still.meta.revalidated).not.toBeNull()
    // When: 该次再验证成功恢复
    await still.meta.revalidated
    const fresh = await client.getWithMeta('/api/snapshot', 60_000)
    // Then: 缓存换新
    expect(fresh.payload).toEqual({ v: 3 })
    expect(fresh.meta.stale).toBe(false)
    expect(upstream.count()).toBe(3)
  })
})
