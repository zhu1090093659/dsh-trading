/**
 * 统一资产台账 api 封装单测（Issue #65，契约 §3/§7）：
 * envelope 解析（HTTP 200 + ok:false 业务错误 → null）、写操作 revision/id 提取、
 * fetchFx 的 stale/base 形状归一、桥缺席静默降级。全程 fetch 桩，不触网。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  addHolding,
  confirmHoldings,
  discardHoldings,
  fetchFx,
  fetchHoldings,
  removeHolding,
  stageHoldings,
  updateHolding,
} from '../src/client/api.ts'
import type { NewHolding } from '../src/client/holdings-types.ts'

const NEW_HOLDING: NewHolding = {
  market: 'hk',
  symbol: '00700',
  side: 'long',
  size: 100,
  entryPrice: 380,
  account: '富途',
  kind: 'real',
}

function stubFetchOnce(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(handler) as unknown as typeof globalThis.fetch
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

describe('holdings api 封装（envelope 解析）', () => {
  it('fetchHoldings：返回 revision + 双区；字段缺席按空数组兜底', async () => {
    stubFetchOnce(async () => jsonResponse({
      ok: true,
      revision: 7,
      staged: [{ id: 'hd-1' }],
      holdings: [{ id: 'hd-2' }, { id: 'hd-3' }],
    }))
    const snap = await fetchHoldings()
    expect(snap).toEqual({ revision: 7, staged: [{ id: 'hd-1' }], holdings: [{ id: 'hd-2' }, { id: 'hd-3' }] })

    stubFetchOnce(async () => jsonResponse({ ok: true, revision: 8 }))
    expect(await fetchHoldings()).toEqual({ revision: 8, staged: [], holdings: [] })
  })

  it('fetchHoldings：桥缺席（404）/业务错误（ok:false）→ null 静默降级', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: false, code: 'TRADING_PROTOCOL', message: 'no such endpoint' }, 404))
    expect(await fetchHoldings()).toBeNull()
    stubFetchOnce(async () => Promise.reject(new Error('network down')))
    expect(await fetchHoldings()).toBeNull()
  })

  it('stageHoldings：POST /holdings/stage 带 items，返回 revision', async () => {
    let captured: { url: string; body: string } | undefined
    stubFetchOnce(async (url, init) => {
      captured = { url: String(url), body: String(init?.body) }
      return jsonResponse({ ok: true, revision: 9 })
    })
    const revision = await stageHoldings([NEW_HOLDING])
    expect(revision).toBe(9)
    expect(captured?.url).toBe('/dshtrading/api/holdings/stage')
    expect(JSON.parse(captured?.body ?? '{}')).toEqual({ items: [NEW_HOLDING] })
  })

  it('confirmHoldings：带 edits 与不待 edits 两种形状', async () => {
    let body: string | undefined
    stubFetchOnce(async (_url, init) => { body = String(init?.body); return jsonResponse({ ok: true, revision: 10 }) })
    expect(await confirmHoldings(['hd-1'], { 'hd-1': { size: 200 } })).toBe(10)
    expect(JSON.parse(body ?? '{}')).toEqual({ ids: ['hd-1'], edits: { 'hd-1': { size: 200 } } })

    stubFetchOnce(async (_url, init) => { body = String(init?.body); return jsonResponse({ ok: true, revision: 11 }) })
    expect(await confirmHoldings(['hd-1'])).toBe(11)
    expect(JSON.parse(body ?? '{}')).toEqual({ ids: ['hd-1'] })
  })

  it('discardHoldings / updateHolding / removeHolding：revision 或 null', async () => {
    stubFetchOnce(async () => jsonResponse({ ok: true, revision: 12 }))
    expect(await discardHoldings(['hd-1'])).toBe(12)

    let method: string | undefined
    let url: string | undefined
    stubFetchOnce(async (u, init) => { method = init?.method; url = String(u); return jsonResponse({ ok: true, revision: 13 }) })
    expect(await updateHolding('hd-1', { account: 'IBKR' })).toBe(13)
    expect(method).toBe('PUT')
    expect(url).toBe('/dshtrading/api/holdings')

    stubFetchOnce(async (u, init) => { method = init?.method; url = String(u); return jsonResponse({ ok: true, revision: 14 }) })
    expect(await removeHolding('hd-1')).toBe(14)
    expect(method).toBe('DELETE')
    expect(url).toBe('/dshtrading/api/holdings?id=hd-1')

    // 业务拒绝（TRADING_HOLDINGS_INVALID）→ null
    stubFetchOnce(async () => jsonResponse({ ok: false, code: 'TRADING_HOLDINGS_INVALID', message: 'size must be > 0' }))
    expect(await discardHoldings(['hd-x'])).toBeNull()
    expect(await updateHolding('hd-x', {})).toBeNull()
    expect(await removeHolding('hd-x')).toBeNull()
  })

  it('addHolding：成功返回 { revision, id }；缺 id 视为失败', async () => {
    let body: string | undefined
    stubFetchOnce(async (_url, init) => { body = String(init?.body); return jsonResponse({ ok: true, revision: 15, id: 'hd-new' }) })
    expect(await addHolding(NEW_HOLDING)).toEqual({ revision: 15, id: 'hd-new' })
    expect(JSON.parse(body ?? '{}')).toEqual(NEW_HOLDING)

    stubFetchOnce(async () => jsonResponse({ ok: true, revision: 16 }))
    expect(await addHolding(NEW_HOLDING)).toBeNull()
  })

  it('fetchFx：形状归一（base 白名单 / stale 布尔化 / rates 兜底）', async () => {
    stubFetchOnce(async (url) => {
      expect(String(url)).toBe('/dshtrading/api/fx?base=USD')
      return jsonResponse({ ok: true, base: 'USD', rates: { USD: 1, USDT: 1, CNY: 0.14 }, asOf: 123, stale: false })
    })
    expect(await fetchFx('USD')).toEqual({ base: 'USD', rates: { USD: 1, USDT: 1, CNY: 0.14 }, asOf: 123, stale: false })

    // stale 恒等兜底形状透传
    stubFetchOnce(async () => jsonResponse({ ok: true, base: 'CNY', rates: { CNY: 1 }, asOf: 0, stale: true }))
    expect(await fetchFx('CNY')).toEqual({ base: 'CNY', rates: { CNY: 1 }, asOf: 0, stale: true })

    // 非法 base（400 协议错误）/ 网络失败 → null
    stubFetchOnce(async () => jsonResponse({ ok: false, code: 'TRADING_PROTOCOL', message: 'unsupported base' }, 400))
    expect(await fetchFx('HKD')).toBeNull()
    stubFetchOnce(async () => Promise.reject(new Error('offline')))
    expect(await fetchFx('USD')).toBeNull()
  })
})
