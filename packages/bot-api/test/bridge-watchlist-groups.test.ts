/**
 * 自定义分组端点单测（issue #82，离线）：/watchlist-groups CRUD、
 * /watchlist-group-members 增删（含行物化）、groups 字段经 PUT/POST /watchlists
 * 保真、协议校验 400、store 缺席降级。
 */
import { describe, expect, it, vi } from 'vitest'
import type { MarketDataService } from '@dshtrading/api'
import { MARKET_SERVICE_KEYS, TradingBridge, createBridgeHost, dispatchBridgeRequest } from '../src/bridge.ts'

vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error('bridge-watchlist-groups.test must not hit network')
}))

function fakeService(): MarketDataService {
  return {
    getTicker: async symbol => ({ symbol, price: 100, timestamp: 1234 }),
    getKlines: async () => [{ openTime: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, closeTime: 2 }],
    subscribeTicker: () => ({ dispose() {} }),
  }
}

function makeBridge() {
  const host = createBridgeHost({
    legacy: market => (market === 'us' ? fakeService() : undefined),
  })
  return { host, bridge: new TradingBridge(host) }
}

describe('watchlist group endpoints（issue #82）', () => {
  it('分组 CRUD：创建 → GET 可见 → 改名 → 同名拒绝 → 删除', async () => {
    const { bridge } = makeBridge()
    const created = await dispatchBridgeRequest(bridge, 'POST', '/watchlist-groups', new URLSearchParams(), { name: '核心仓' })
    expect(created.payload).toMatchObject({ ok: true, created: true, group: { name: '核心仓' } })
    const id = (created.payload as { group: { id: string } }).group.id

    const list = await dispatchBridgeRequest(bridge, 'GET', '/watchlist-groups', new URLSearchParams())
    expect(list.payload).toMatchObject({ ok: true, groups: [{ id, name: '核心仓' }] })

    const dup = await dispatchBridgeRequest(bridge, 'POST', '/watchlist-groups', new URLSearchParams(), { name: '核心仓' })
    expect(dup.payload).toMatchObject({ ok: false, created: false })

    const renamed = await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-groups', new URLSearchParams(), { id, name: '观察仓' })
    expect(renamed.payload).toMatchObject({ ok: true, renamed: true, group: { name: '观察仓' } })

    const notFound = await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-groups', new URLSearchParams(), { id: 'g_missing', name: 'x' })
    expect(notFound.payload).toMatchObject({ ok: false, renamed: false })

    const del = await dispatchBridgeRequest(bridge, 'DELETE', '/watchlist-groups', new URLSearchParams({ id }))
    expect(del.payload).toMatchObject({ ok: true, removed: true })
    await expect(dispatchBridgeRequest(bridge, 'DELETE', '/watchlist-groups', new URLSearchParams()))
      .rejects.toThrowError(/id is required/)
  })

  it('名字校验：空名/超长 400', async () => {
    const { bridge } = makeBridge()
    await expect(dispatchBridgeRequest(bridge, 'POST', '/watchlist-groups', new URLSearchParams(), { name: '  ' }))
      .rejects.toThrowError(/non-empty string name/)
    await expect(dispatchBridgeRequest(bridge, 'POST', '/watchlist-groups', new URLSearchParams(), { name: 'x'.repeat(25) }))
      .rejects.toThrowError(/24 chars max/)
  })

  it('成员增删：入组（行缺席自动物化）→ GET /watchlists 行带 groups → 移出（行保留）', async () => {
    const { bridge } = makeBridge()
    const created = await dispatchBridgeRequest(bridge, 'POST', '/watchlist-groups', new URLSearchParams(), { name: '波段' })
    const id = (created.payload as { group: { id: string } }).group.id

    const add = await dispatchBridgeRequest(bridge, 'POST', '/watchlist-group-members', new URLSearchParams(), {
      id, market: 'us', symbol: 'AAPL', name: '苹果',
    })
    expect(add.payload).toMatchObject({ ok: true, added: true, materialized: true })

    // 审查 H2：未定制市场整体物化种子基线（不能只物化目标行——「键存在 = 已定制」
    // 会让该市场其余默认行被判删），目标行落分组归属。
    const list = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    const us = (list.payload as { watchlists: { us: Array<{ symbol: string; name?: string; groups?: string[] }> } }).watchlists.us
    expect(us.map(row => row.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA', 'GOOGL'])
    expect(us.find(row => row.symbol === 'AAPL')?.groups).toEqual([id])
    expect(us.filter(row => row.symbol !== 'AAPL').every(row => row.groups === undefined)).toBe(true)

    // 已在基线里的标的入组不物化
    const add2 = await dispatchBridgeRequest(bridge, 'POST', '/watchlist-group-members', new URLSearchParams(), { id, market: 'us', symbol: 'MSFT' })
    expect(add2.payload).toMatchObject({ ok: true, added: true, materialized: false })

    const remove = await dispatchBridgeRequest(bridge, 'DELETE', '/watchlist-group-members', new URLSearchParams({ id, market: 'us', symbol: 'AAPL' }))
    expect(remove.payload).toMatchObject({ ok: true, removed: true })
    const after = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    const afterUs = (after.payload as { watchlists: { us: Array<{ symbol: string; groups?: string[] }> } }).watchlists.us
    expect(afterUs.map(row => row.symbol)).toEqual(['AAPL', 'MSFT', 'NVDA', 'GOOGL'])
    expect(afterUs.find(row => row.symbol === 'AAPL')?.groups).toBeUndefined()
    expect(afterUs.find(row => row.symbol === 'MSFT')?.groups).toEqual([id])
    await expect(dispatchBridgeRequest(bridge, 'DELETE', '/watchlist-group-members', new URLSearchParams({ id, market: 'us' })))
      .rejects.toThrowError(/id, market and symbol are required/)
  })

  it('删分组清成员关系：行上的 groups 被剥离，自选行保留', async () => {
    const { bridge } = makeBridge()
    const created = await dispatchBridgeRequest(bridge, 'POST', '/watchlist-groups', new URLSearchParams(), { name: '武库' })
    const id = (created.payload as { group: { id: string } }).group.id
    await dispatchBridgeRequest(bridge, 'POST', '/watchlist-group-members', new URLSearchParams(), { id, market: 'us', symbol: 'AAPL' })
    await dispatchBridgeRequest(bridge, 'POST', '/watchlist-group-members', new URLSearchParams(), { id, market: 'us', symbol: 'MSFT' })

    await dispatchBridgeRequest(bridge, 'DELETE', '/watchlist-groups', new URLSearchParams({ id }))
    const list = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    const us = (list.payload as { watchlists: { us: Array<{ symbol: string; groups?: string[] }> } }).watchlists.us
    // 种子基线（审查 H2）保留，成员关系被剥离。
    expect(us.map(row => row.symbol).sort()).toEqual(['AAPL', 'GOOGL', 'MSFT', 'NVDA'])
    expect(us.every(row => row.groups === undefined)).toBe(true)
  })

  it('POST/PUT /watchlists 携带 groups 字段保真（已注册 id；坏项与未注册 id 被清洗）', async () => {
    const { bridge } = makeBridge()
    const g1 = (await dispatchBridgeRequest(bridge, 'POST', '/watchlist-groups', new URLSearchParams(), { name: '甲组' }))
      .payload as { group: { id: string } }
    const g2 = (await dispatchBridgeRequest(bridge, 'POST', '/watchlist-groups', new URLSearchParams(), { name: '乙组' }))
      .payload as { group: { id: string } }

    await dispatchBridgeRequest(bridge, 'POST', '/watchlists', new URLSearchParams(), {
      market: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin', groups: [g1.group.id, g2.group.id, ''],
    })
    const list = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    // 坏项（空串）被清洗，已注册 id 保序保留
    expect(list.payload).toMatchObject({ ok: true, watchlists: { crypto: [{ symbol: 'BTCUSDT', groups: [g1.group.id, g2.group.id] }] } })

    // 审查 L4：注册表里不存在的 id 一律丢弃（删组清理覆盖不到的悬挂归属）。
    await dispatchBridgeRequest(bridge, 'PUT', '/watchlists', new URLSearchParams(), {
      watchlists: { hk: [{ market: 'hk', symbol: '00700', groups: ['g_ghost'] }] },
    })
    const dropped = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    expect(dropped.payload).toMatchObject({ ok: true, watchlists: { hk: [{ symbol: '00700' }] } })

    await dispatchBridgeRequest(bridge, 'PUT', '/watchlists', new URLSearchParams(), {
      watchlists: { hk: [{ market: 'hk', symbol: '00700', groups: [g1.group.id] }] },
    })
    const after = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    expect(after.payload).toMatchObject({ ok: true, watchlists: { hk: [{ symbol: '00700', groups: [g1.group.id] }] } })
  })

  it('成员入组协议校验：缺 id/market/symbol 400', async () => {
    const { bridge } = makeBridge()
    await expect(dispatchBridgeRequest(bridge, 'POST', '/watchlist-group-members', new URLSearchParams(), { market: 'us', symbol: 'AAPL' }))
      .rejects.toThrowError(/id, market and symbol/)
  })

  it('未知分组 id 入组被拒：不物化行、不写悬挂归属（审查补充）', async () => {
    const { bridge } = makeBridge()
    const rejected = await dispatchBridgeRequest(bridge, 'POST', '/watchlist-group-members', new URLSearchParams(), {
      id: 'g_ghost', market: 'us', symbol: 'AAPL', name: '苹果',
    })
    expect(rejected.payload).toMatchObject({ ok: false, added: false, materialized: false })
    expect((rejected.payload as { reason: string }).reason).toContain('no such group id')
    // 行未被物化（悬挂 id 会以 '?' chip 出现在管理弹窗）
    const list = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    expect(list.payload).toMatchObject({ ok: true, watchlists: {} })
  })
})
