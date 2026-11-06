/**
 * 自选置顶端点单测（2026-11-05「按涨跌幅排序 + 标的置顶」，离线）：GET /watchlist-groups
 * 的载荷带 pinned、PUT /watchlist-pins 的写读往返与协议校验 400、删行时清掉该行置顶键
 * 的防僵尸钩子，以及写路由声明表里 PUT /watchlist-pins 的失效 store（客户端靠它重拉
 * 面板，声明漏了会「写成功但界面不刷新」）。
 *
 * 与 bridge-watchlist-groups.test.ts 同款：真实 createBridgeHost（分组 store 缺席时兜底
 * 内存实现）+ dispatchBridgeRequest 分发，不触网。
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  BRIDGE_WRITE_ROUTES,
  BridgeProtocolError,
  TradingBridge,
  createBridgeHost,
  dispatchBridgeRequest,
  resolveWriteRoute,
  type BridgeRouteResult,
} from '../src/bridge.ts'

/** 真实 fetch 收尾复原：本文件任何一步都不该走网络。 */
const realFetch = globalThis.fetch
globalThis.fetch = async () => {
  throw new Error('bridge-watchlist-pins.test must not hit network')
}
afterAll(() => {
  globalThis.fetch = realFetch
})

function makeBridge(): TradingBridge {
  return new TradingBridge(createBridgeHost({ legacy: () => undefined }))
}

/** 读回面板（GET /watchlist-groups）的载荷：注册表 + 置顶键集一次取回。 */
async function readPanel(bridge: TradingBridge): Promise<{ groups: unknown; pinned: string[] }> {
  const result = await dispatchBridgeRequest(bridge, 'GET', '/watchlist-groups', new URLSearchParams())
  expect(result.status).toBe(200)
  return result.payload as { groups: unknown; pinned: string[] }
}

/** 写路由声明里的失效 store（GET 结果没有该字段；写路由一定有）。 */
function invalidatesOf(result: BridgeRouteResult): readonly string[] {
  if (!('invalidates' in result)) throw new Error('写路由结果缺 invalidates 声明')
  return result.invalidates
}

/** 断言该次调用以协议错误被拒，返回错误本身（用于再断言 status/message）。 */
async function protocolError(call: Promise<unknown>): Promise<BridgeProtocolError> {
  const error = await call.then(() => null, (err: unknown) => err)
  expect(error).toBeInstanceOf(BridgeProtocolError)
  return error as BridgeProtocolError
}

describe('GET /watchlist-groups（置顶键集随注册表返回）', () => {
  it('用户打开自选面板时，载荷带空的 pinned 数组（无置顶的初始态）', async () => {
    // Given 一个刚起、还没有任何分组与置顶的宿主桥
    const bridge = makeBridge()
    // When 客户端拉面板
    const result = await dispatchBridgeRequest(bridge, 'GET', '/watchlist-groups', new URLSearchParams())
    // Then 注册表与置顶键集同时返回，置顶为空数组（不是缺字段）
    expect(result.payload).toEqual({ ok: true, groups: [], pinned: [] })
    expect(result.status).toBe(200)
  })
})

describe('PUT /watchlist-pins（置顶/取消置顶）', () => {
  it('用户把标的置顶时，写入返回 ok/changed 与 host 权威键集，回读可见', async () => {
    // Given 一个空的宿主桥
    const bridge = makeBridge()
    // When 客户端置顶美股苹果
    const result = await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), {
      key: 'us:AAPL',
      pinned: true,
    })
    // Then 响应带权威键集，且下一次读面板能读到它
    expect(result.payload).toEqual({ ok: true, changed: true, pinned: ['us:AAPL'] })
    expect(result.status).toBe(200)
    expect((await readPanel(bridge)).pinned).toEqual(['us:AAPL'])
  })

  it('用户重复置顶同一标的时，第二次返回 changed:false 且键集不变（幂等）', async () => {
    // Given 一个已置顶 us:AAPL 的宿主桥
    const bridge = makeBridge()
    await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), { key: 'us:AAPL', pinned: true })
    // When 再置顶同一标的
    const again = await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), {
      key: 'us:AAPL',
      pinned: true,
    })
    // Then 幂等 no-op：changed false，键集仍只有一条
    expect(again.payload).toEqual({ ok: true, changed: false, pinned: ['us:AAPL'] })
  })

  it('用户取消置顶时只摘掉目标键，再取消一次返回 changed:false', async () => {
    // Given 一个已置顶两个标的（美股苹果、港股腾讯）的宿主桥
    const bridge = makeBridge()
    await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), { key: 'us:AAPL', pinned: true })
    await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), { key: 'hk:00700', pinned: true })
    // When 取消置顶苹果，然后再取消一次
    const unpin = await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), {
      key: 'us:AAPL',
      pinned: false,
    })
    const again = await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), {
      key: 'us:AAPL',
      pinned: false,
    })
    // Then 只剩腾讯，第二次是同状态 no-op
    expect(unpin.payload).toEqual({ ok: true, changed: true, pinned: ['hk:00700'] })
    expect(again.payload).toEqual({ ok: true, changed: false, pinned: ['hk:00700'] })
    expect((await readPanel(bridge)).pinned).toEqual(['hk:00700'])
  })

  it('用户提交非法置顶请求体时，桥以 400 协议错误拒绝且坏值不落盘', async () => {
    // Given 一个空的宿主桥
    const bridge = makeBridge()
    const put = (body?: unknown): Promise<unknown> =>
      dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), body)

    // When 依次提交缺 key / 缺 pinned / pinned 非布尔 / key 非字符串 / key 不成形的请求体
    const missingKey = await protocolError(put({ pinned: true }))
    const missingPinned = await protocolError(put({ key: 'us:AAPL' }))
    const wrongPinnedType = await protocolError(put({ key: 'us:AAPL', pinned: 'yes' }))
    const wrongKeyType = await protocolError(put({ key: 42, pinned: true }))
    const noColon = await protocolError(put({ key: 'nocolon', pinned: true }))
    const emptySegment = await protocolError(put({ key: ':x', pinned: true }))
    const trailingColon = await protocolError(put({ key: 'x:', pinned: true }))
    const emptyBody = await protocolError(put(undefined))

    // Then 全部 400，且报文区分「形状不对」与「键不成形」；坏值一条都没落盘
    for (const error of [missingKey, missingPinned, wrongPinnedType, wrongKeyType, emptyBody]) {
      expect(error.status).toBe(400)
      expect(error.message).toMatch(/requires string key and boolean pinned/)
    }
    for (const error of [noColon, emptySegment, trailingColon]) {
      expect(error.status).toBe(400)
      expect(error.message).toMatch(/invalid watchlist pin key/)
    }
    expect((await readPanel(bridge)).pinned).toEqual([])
  })
})

describe('DELETE /watchlists（删行清置顶，防僵尸置顶）', () => {
  it('用户删掉一条已置顶的自选行时，该行的置顶键被清掉而别的键留下', async () => {
    // Given 一个已置顶美股苹果与港股腾讯的宿主桥
    const bridge = makeBridge()
    await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), { key: 'us:AAPL', pinned: true })
    await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), { key: 'hk:00700', pinned: true })
    // When 客户端删掉美股苹果这一行
    const removed = await dispatchBridgeRequest(bridge, 'DELETE', '/watchlists', new URLSearchParams({ market: 'us', symbol: 'AAPL' }))
    // Then 行被删且它的置顶键同步清掉（重新加回不会自动置顶），腾讯的键不受影响
    expect(removed.payload).toEqual({ ok: true, removed: true })
    expect((await readPanel(bridge)).pinned).toEqual(['hk:00700'])
  })

  it('用户删掉一条从未置顶的行时，置顶键集原样保留', async () => {
    // Given 一个只置顶了美股苹果的宿主桥
    const bridge = makeBridge()
    await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), { key: 'us:AAPL', pinned: true })
    // When 客户端删掉一条从未置顶的行（该行也不在自选里）
    const removed = await dispatchBridgeRequest(bridge, 'DELETE', '/watchlists', new URLSearchParams({ market: 'us', symbol: 'TSLA' }))
    // Then 行未存在（removed false），置顶键集不动
    expect(removed.payload).toEqual({ ok: true, removed: false })
    expect((await readPanel(bridge)).pinned).toEqual(['us:AAPL'])
  })
})

describe('PUT /watchlists（全量替换清被删行的键）', () => {
  it('用户全量替换自选表时，被删行的置顶键被清掉而保留行的键不动', async () => {
    // Given 自选表是「美股苹果 + 美股微软」，且两行都已置顶
    const bridge = makeBridge()
    await dispatchBridgeRequest(bridge, 'PUT', '/watchlists', new URLSearchParams(), {
      watchlists: { us: [{ market: 'us', symbol: 'AAPL' }, { market: 'us', symbol: 'MSFT' }] },
    })
    await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), { key: 'us:AAPL', pinned: true })
    await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), { key: 'us:MSFT', pinned: true })
    const before = await readPanel(bridge)
    // When 用只含微软（保留）与港股腾讯（新增、未置顶）的表做全量替换
    const replaced = await dispatchBridgeRequest(bridge, 'PUT', '/watchlists', new URLSearchParams(), {
      watchlists: { us: [{ market: 'us', symbol: 'MSFT' }], hk: [{ market: 'hk', symbol: '00700' }] },
    })
    // Then 表换成新表；苹果的键被清掉、微软的键保留、新增行不产生键
    expect(before.pinned).toEqual(['us:AAPL', 'us:MSFT'])
    expect(replaced.payload).toEqual({
      ok: true,
      watchlists: { us: [{ market: 'us', symbol: 'MSFT' }], hk: [{ market: 'hk', symbol: '00700' }] },
    })
    expect((await readPanel(bridge)).pinned).toEqual(['us:MSFT'])

    // When 再全量替换一次，只是把同一批行换了顺序（市场顺序也换）
    const reordered = await dispatchBridgeRequest(bridge, 'PUT', '/watchlists', new URLSearchParams(), {
      watchlists: { hk: [{ market: 'hk', symbol: '00700' }], us: [{ market: 'us', symbol: 'MSFT' }] },
    })
    // Then 没有行被删 → 键集一字不动（按 key 集合比，不按位置）
    expect(reordered.payload).toMatchObject({ ok: true })
    expect((await readPanel(bridge)).pinned).toEqual(['us:MSFT'])
  })
})

describe('写路由失效声明（PUT /watchlist-pins）', () => {
  it('管理员新增置顶写端点时，声明表与分发结果都带 watchlists 失效', async () => {
    // Given 生产写路由表
    // When 解析 PUT /watchlist-pins 这条写路由
    const route = resolveWriteRoute(BRIDGE_WRITE_ROUTES, 'PUT', '/watchlist-pins')
    // Then 声明里恰好失效 watchlists（客户端据此重拉面板与置顶键集）
    expect(route?.invalidates).toEqual(['watchlists'])
    expect(BRIDGE_WRITE_ROUTES.filter(item => item.method === 'PUT' && item.pathname === '/watchlist-pins')).toHaveLength(1)

    // And 运行时同款：分发一次成功写，结果把同一份声明带出去
    const bridge = makeBridge()
    const result = await dispatchBridgeRequest(bridge, 'PUT', '/watchlist-pins', new URLSearchParams(), {
      key: 'us:AAPL',
      pinned: true,
    })
    expect(invalidatesOf(result)).toEqual(['watchlists'])
    expect(result.payload).toMatchObject({ ok: true, changed: true })
  })
})
