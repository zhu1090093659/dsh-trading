/**
 * 自选分组 client HTTP 封装单测（issue #82 契约，离线）：
 * 六个 wrapper 的 HTTP 方法 / 路径 / 查询串 / 请求体 + host 响应 → 返回形状映射
 * （非 2xx / 缺 group → 'unavailable'；同名冲突 → 'duplicate'；组不存在 → 'not-found'，
 * 判据优先取 host 的 code，旧桥按 reason 文案兜底）。
 * 全程 fetch 桩，不触网。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  addHostWatchlistGroupMember,
  createHostWatchlistGroup,
  deleteHostWatchlistGroup,
  fetchHostWatchlistGroups,
  removeHostWatchlistGroupMember,
  renameHostWatchlistGroup,
} from '../src/client/api.ts'
import type { HostWatchlistGroup } from '../src/client/api.ts'

const realFetch = globalThis.fetch

interface CapturedRequest {
  readonly url: string
  readonly method: string | undefined
  readonly headers: Record<string, string> | undefined
  readonly body: string | undefined
}

/** 装 fetch 桩：记录每次请求（url/method/headers/body），由 handler 决定响应。 */
function stubFetchOnce(handler: (request: CapturedRequest) => Response | Promise<Response>): CapturedRequest[] {
  const calls: CapturedRequest[] = []
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input),
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(request)
    return handler(request)
  }) as unknown as typeof globalThis.fetch
  return calls
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const GROUP: HostWatchlistGroup = { id: 'g_1', name: '核心仓', createdAt: 1_700_000_000_000 }

afterAll(() => {
  globalThis.fetch = realFetch
})

describe('fetchHostWatchlistGroups（GET /watchlist-groups）', () => {
  it('GET 路径 + accept 头；groups 数组原样透传', async () => {
    const calls = stubFetchOnce(async () => jsonResponse({ ok: true, groups: [GROUP] }))
    expect(await fetchHostWatchlistGroups()).toEqual([GROUP])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/dshtrading/api/watchlist-groups')
    expect(calls[0]?.method).toBeUndefined() // 未显式 method = GET
    expect(calls[0]?.headers).toEqual({ accept: 'application/json' })
    expect(calls[0]?.body).toBeUndefined()
  })

  it('groups 缺席或非数组 → []（桥在、注册表为空）', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: true }))
    expect(await fetchHostWatchlistGroups()).toEqual([])
    stubFetchOnce(async () => jsonResponse({ ok: true, groups: null }))
    expect(await fetchHostWatchlistGroups()).toEqual([])
  })

  it('非 2xx（桥缺席 404 / 未鉴权 401）/ 业务错误（HTTP 200 + ok:false）/ 网络失败 → null 静默降级', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: false, code: 'TRADING_PROTOCOL', message: 'no such endpoint' }, 404))
    expect(await fetchHostWatchlistGroups()).toBeNull()
    stubFetchOnce(async () => jsonResponse({ ok: false, code: 'TRADING_AUTH', message: 'unauthorized' }, 401))
    expect(await fetchHostWatchlistGroups()).toBeNull()
    stubFetchOnce(async () => jsonResponse({ ok: false, code: 'TRADING_WATCHLIST_GROUP_INVALID', message: 'groups store unavailable' }))
    expect(await fetchHostWatchlistGroups()).toBeNull()
    stubFetchOnce(async () => Promise.reject(new Error('network down')))
    expect(await fetchHostWatchlistGroups()).toBeNull()
  })
})

describe('createHostWatchlistGroup（POST /watchlist-groups）', () => {
  it('POST + JSON body {name}；ok:true 回 group', async () => {
    const calls = stubFetchOnce(async () => jsonResponse({ ok: true, created: true, group: GROUP }))
    expect(await createHostWatchlistGroup('核心仓')).toEqual({ ok: true, group: GROUP })
    expect(calls[0]?.url).toBe('/dshtrading/api/watchlist-groups')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(calls[0]?.body ?? '{}')).toStrictEqual({ name: '核心仓' })
  })

  it('同名业务拒绝（HTTP 200 + ok:false）→ duplicate', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: false, created: false, reason: 'group name "核心仓" already exists' }))
    expect(await createHostWatchlistGroup('核心仓')).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('HTTP 200 + ok:true 但缺 group（host 无分组 store 的 created:false）→ unavailable', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: true, created: false, code: 'unavailable' }))
    expect(await createHostWatchlistGroup('核心仓')).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('非 2xx（桥缺席）/ 网络失败 → unavailable', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: false, code: 'TRADING_PROTOCOL', message: 'bridge missing' }, 404))
    expect(await createHostWatchlistGroup('核心仓')).toEqual({ ok: false, reason: 'unavailable' })
    stubFetchOnce(async () => jsonResponse({ ok: false }, 500))
    expect(await createHostWatchlistGroup('核心仓')).toEqual({ ok: false, reason: 'unavailable' })
    stubFetchOnce(async () => Promise.reject(new Error('offline')))
    expect(await createHostWatchlistGroup('核心仓')).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('renameHostWatchlistGroup（PUT /watchlist-groups）', () => {
  it('PUT + JSON body {id,name}；ok:true 回 group', async () => {
    const calls = stubFetchOnce(async () => jsonResponse({ ok: true, renamed: true, group: { ...GROUP, name: '观察仓' } }))
    expect(await renameHostWatchlistGroup('g_1', '观察仓')).toEqual({ ok: true, group: { ...GROUP, name: '观察仓' } })
    expect(calls[0]?.url).toBe('/dshtrading/api/watchlist-groups')
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(calls[0]?.body ?? '{}')).toStrictEqual({ id: 'g_1', name: '观察仓' })
  })

  it('审查 L4：not-found 与同名冲突分开映射（host code 判据 + 旧桥 reason 文案兜底）', async () => {
    // 新桥：host 回机器可读 code。
    stubFetchOnce(async () => jsonResponse({ ok: false, renamed: false, code: 'not-found', reason: 'no such group id "g_missing"' }))
    expect(await renameHostWatchlistGroup('g_missing', '新名')).toEqual({ ok: false, reason: 'not-found' })
    stubFetchOnce(async () => jsonResponse({ ok: false, renamed: false, code: 'duplicate', reason: 'group name "观察仓" already exists' }))
    expect(await renameHostWatchlistGroup('g_1', '观察仓')).toEqual({ ok: false, reason: 'duplicate' })
    // 旧桥（无 code）：按 reason 文案兜底，仍能区分两者。
    stubFetchOnce(async () => jsonResponse({ ok: false, renamed: false, reason: 'no such group id "g_missing"' }))
    expect(await renameHostWatchlistGroup('g_missing', '新名')).toEqual({ ok: false, reason: 'not-found' })
    stubFetchOnce(async () => jsonResponse({ ok: false, renamed: false, reason: 'group name "观察仓" already exists' }))
    expect(await renameHostWatchlistGroup('g_1', '观察仓')).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('非 2xx / 网络失败 → unavailable', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: false, code: 'TRADING_PROTOCOL', message: 'bridge missing' }, 404))
    expect(await renameHostWatchlistGroup('g_1', '观察仓')).toEqual({ ok: false, reason: 'unavailable' })
    stubFetchOnce(async () => Promise.reject(new Error('offline')))
    expect(await renameHostWatchlistGroup('g_1', '观察仓')).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('deleteHostWatchlistGroup（DELETE /watchlist-groups?id=）', () => {
  it('DELETE + 查询串 id，无请求体；ok:true → true', async () => {
    const calls = stubFetchOnce(async () => jsonResponse({ ok: true, removed: true }))
    expect(await deleteHostWatchlistGroup('g_1')).toBe(true)
    expect(calls[0]?.url).toBe('/dshtrading/api/watchlist-groups?id=g_1')
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.headers).toEqual({ accept: 'application/json' })
    expect(calls[0]?.body).toBeUndefined()
  })

  it('ok:false（组不存在）/ 非 2xx / 网络失败 → false', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: false, removed: false, reason: 'no such group id "g_missing"' }))
    expect(await deleteHostWatchlistGroup('g_missing')).toBe(false)
    stubFetchOnce(async () => jsonResponse({ ok: true, removed: true }, 404))
    expect(await deleteHostWatchlistGroup('g_1')).toBe(false)
    stubFetchOnce(async () => Promise.reject(new Error('offline')))
    expect(await deleteHostWatchlistGroup('g_1')).toBe(false)
  })
})

describe('addHostWatchlistGroupMember（POST /watchlist-group-members）', () => {
  it('POST + JSON body {id,market,symbol}；name 缺席时不写键，带 name 时补键', async () => {
    const calls = stubFetchOnce(async () => jsonResponse({ ok: true, added: true, materialized: false }))
    expect(await addHostWatchlistGroupMember('g_1', 'us', 'AAPL')).toBe(true)
    expect(calls[0]?.url).toBe('/dshtrading/api/watchlist-group-members')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(calls[0]?.body ?? '{}')).toStrictEqual({ id: 'g_1', market: 'us', symbol: 'AAPL' })

    const withName = stubFetchOnce(async () => jsonResponse({ ok: true, added: true, materialized: true }))
    expect(await addHostWatchlistGroupMember('g_1', 'us', 'AAPL', '苹果')).toBe(true)
    expect(JSON.parse(withName[0]?.body ?? '{}')).toStrictEqual({ id: 'g_1', market: 'us', symbol: 'AAPL', name: '苹果' })
  })

  it('ok:false（未知组 id）/ 非 2xx / 网络失败 → false', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: false, added: false, materialized: false, reason: 'no such group id "g_missing"' }))
    expect(await addHostWatchlistGroupMember('g_missing', 'us', 'AAPL')).toBe(false)
    stubFetchOnce(async () => jsonResponse({ ok: true, added: true }, 404))
    expect(await addHostWatchlistGroupMember('g_1', 'us', 'AAPL')).toBe(false)
    stubFetchOnce(async () => Promise.reject(new Error('offline')))
    expect(await addHostWatchlistGroupMember('g_1', 'us', 'AAPL')).toBe(false)
  })
})

describe('removeHostWatchlistGroupMember（DELETE /watchlist-group-members）', () => {
  it('DELETE + 查询串 id&market&symbol，无请求体；ok:true → true', async () => {
    const calls = stubFetchOnce(async () => jsonResponse({ ok: true, removed: true }))
    expect(await removeHostWatchlistGroupMember('g_1', 'us', 'AAPL')).toBe(true)
    expect(calls[0]?.url).toBe('/dshtrading/api/watchlist-group-members?id=g_1&market=us&symbol=AAPL')
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.headers).toEqual({ accept: 'application/json' })
    expect(calls[0]?.body).toBeUndefined()
  })

  it('查询串走 URLSearchParams 编码（特殊字符不裸拼）', async () => {
    const calls = stubFetchOnce(async () => jsonResponse({ ok: true, removed: true }))
    expect(await removeHostWatchlistGroupMember('g 1', 'us', 'BRK/B')).toBe(true)
    expect(calls[0]?.url).toBe('/dshtrading/api/watchlist-group-members?id=g+1&market=us&symbol=BRK%2FB')
  })

  it('ok:false / 非 2xx / 网络失败 → false', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: false, removed: false, reason: 'no such group id "g_missing"' }))
    expect(await removeHostWatchlistGroupMember('g_missing', 'us', 'AAPL')).toBe(false)
    stubFetchOnce(async () => jsonResponse({ ok: true, removed: true }, 500))
    expect(await removeHostWatchlistGroupMember('g_1', 'us', 'AAPL')).toBe(false)
    stubFetchOnce(async () => Promise.reject(new Error('offline')))
    expect(await removeHostWatchlistGroupMember('g_1', 'us', 'AAPL')).toBe(false)
  })
})
