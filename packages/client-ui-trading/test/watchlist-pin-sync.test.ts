/**
 * 自选置顶的客户端同步单测（2026-11-05「按涨跌幅排序 + 标的置顶」，离线）：
 * - 启动同步：host 返回的 `pinned` 落到分组镜像 `groups.getSnapshot().pinned`，并经
 *   `applyHost` 写进 localStorage 缓存镜像（桥降级重载不回落旧键集）。
 * - host-first 写：`groups.setPinned` 走 PUT /watchlist-pins，成功才把镜像换成 host
 *   返回的权威键集（含别处写入的键）；非 2xx / 业务错误 / 网络失败一律 fail-closed
 *   ——返回 false 且本地键集一字不动。
 * - SSE：`store.changed(watchlists)` 信号触发的重拉把镜像覆盖为 host 权威值。
 *
 * 手法沿用仓内既有做法（host-watchlist-sync / watchlist-groups-api / trading-bridge-ready）：
 * 全局 fetch 换成手写路由桩（真实 api.ts 解析路径），EventSource 用手写契约替身推一帧，
 * 不用通用 mock 工具、不等待固定时长——每个异步接点都用一个可 await 的落地探针来同步。
 *
 * @vitest-environment jsdom
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSelectionStore, createWatchlistGroupsStore, createWatchlistStore, type WatchlistGroupsStoreApi } from '../src/client/store.ts'
import type { WatchlistGroupMeta } from '../src/client/types.ts'
import { wireHostWatchlistSync } from '../src/client/host-watchlist-sync.ts'

/* ------------------------------------------------------------------ */
/* 手写契约替身（不用通用 mock 工具）                                    */
/* ------------------------------------------------------------------ */

type FrameHandler = (event: { data?: string }) => void

/** 浏览器 EventSource 的最小替身：只保留桥失效信号用到的部分。 */
class FakeEventSource {
  static readonly created: FakeEventSource[] = []
  readonly url: string
  onerror: (() => void) | undefined
  private readonly listeners = new Map<string, FrameHandler[]>()
  constructor(url: string) {
    this.url = url
    FakeEventSource.created.push(this)
  }
  addEventListener(type: string, handler: FrameHandler): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  close(): void {}
  /** 模拟桥推送一帧 store.changed（总线只发 JSON 信号）。 */
  emitStoreChanged(store: string): void {
    const frame = { data: JSON.stringify({ store }) }
    for (const handler of this.listeners.get('store.changed') ?? []) handler(frame)
  }
}

interface FakeResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

/** 桥响应信封替身：只实现 api.ts 读到的三个成员（ok / status / json）。 */
function reply(payload: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly body: string | undefined
}

type PinFault = 'none' | 'not-ok' | 'business-error' | 'network'

/** host 侧面板状态（= 桥的真实 store；用例按需改它来模拟「别处写入」与故障）。 */
interface HostPanel {
  watchlists: Record<string, Array<{ market: string; symbol: string; name?: string }>>
  groups: WatchlistGroupMeta[]
  pinned: string[]
  pinFault: PinFault
}

function createPanel(overrides: Partial<HostPanel> = {}): HostPanel {
  return { watchlists: {}, groups: [], pinned: [], pinFault: 'none', ...overrides }
}

interface HostStub {
  readonly calls: CapturedRequest[]
  /** 启动同步的最后一步（GET /selection）已被服务：可 await 它再断言「启动只读」。 */
  readonly bootServed: Promise<void>
}

/** 装 fetch 路由桩：记录每次请求，按 URL/method 回 host 面板的真实形状。 */
function installHostPanel(panel: HostPanel): HostStub {
  const calls: CapturedRequest[] = []
  let markBootServed = (): void => {}
  const bootServed = new Promise<void>((resolve) => { markBootServed = resolve })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<FakeResponse> => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ url, method, body })
    if (method === 'GET' && url === '/dshtrading/api/watchlists') return reply({ ok: true, watchlists: panel.watchlists })
    if (method === 'GET' && url === '/dshtrading/api/watchlist-groups') {
      return reply({ ok: true, groups: panel.groups, pinned: panel.pinned })
    }
    if (method === 'GET' && url === '/dshtrading/api/selection') {
      markBootServed()
      return reply({ ok: true, instrument: null })
    }
    if (method === 'PUT' && url === '/dshtrading/api/watchlist-pins') {
      if (panel.pinFault === 'network') throw new Error('host unreachable')
      if (panel.pinFault === 'not-ok') return reply({ ok: false, code: 'TRADING_PROTOCOL', message: 'internal error' }, 500)
      if (panel.pinFault === 'business-error') {
        return reply({ ok: false, code: 'TRADING_WATCHLIST_PIN_INVALID', message: 'bad pin key' })
      }
      const parsed = JSON.parse(body ?? '{}') as { key?: string; pinned?: boolean }
      const key = parsed.key ?? ''
      const want = parsed.pinned === true
      const had = panel.pinned.includes(key)
      panel.pinned = want
        ? (had ? panel.pinned : [...panel.pinned, key])
        : panel.pinned.filter(entry => entry !== key)
      return reply({ ok: true, changed: had !== want, pinned: panel.pinned })
    }
    return reply({ ok: false, code: 'TRADING_PROTOCOL', message: `no such endpoint: ${url}` }, 404)
  }) as unknown as typeof globalThis.fetch
  return { calls, bootServed }
}

/* ------------------------------------------------------------------ */
/* 落地探针：把「host 权威值落到镜像」变成可 await 的接点（零等待）        */
/* ------------------------------------------------------------------ */

interface PanelLanding {
  groups: WatchlistGroupMeta[]
  pinned: string[] | undefined
}

/** 包一层 applyHost：每次 host 落地都排队，`next()` 取下一次（含已落地未取的那次）。 */
function probePanelLandings(groups: WatchlistGroupsStoreApi): { next(): Promise<PanelLanding> } {
  const buffered: PanelLanding[] = []
  const waiters: Array<(landing: PanelLanding) => void> = []
  const applyHost = groups.applyHost.bind(groups)
  groups.applyHost = (next, pinned) => {
    applyHost(next, pinned)
    const landing: PanelLanding = { groups: next, pinned }
    const waiter = waiters.shift()
    if (waiter === undefined) buffered.push(landing)
    else waiter(landing)
  }
  return {
    next() {
      const landed = buffered.shift()
      if (landed !== undefined) return Promise.resolve(landed)
      return new Promise<PanelLanding>((resolve) => { waiters.push(resolve) })
    },
  }
}

/* ------------------------------------------------------------------ */
/* 用例夹具                                                           */
/* ------------------------------------------------------------------ */

const realFetch = globalThis.fetch
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource
;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource

const disposers: Array<() => void> = []

interface Harness {
  panel: HostPanel
  calls: CapturedRequest[]
  bootServed: Promise<void>
  groups: WatchlistGroupsStoreApi
  probe: { next(): Promise<PanelLanding> }
}

/** 起一个接好线（启动同步已发起）的客户端。 */
function boot(panel: HostPanel): Harness {
  const stub = installHostPanel(panel)
  const watchlists = createWatchlistStore()
  const selection = createSelectionStore()
  const groups = createWatchlistGroupsStore()
  const probe = probePanelLandings(groups)
  disposers.push(wireHostWatchlistSync({ watchlists, selection, groups }))
  return { panel, calls: stub.calls, bootServed: stub.bootServed, groups, probe }
}

/** 本文件发起的置顶写请求（按 URL 取，不依赖它与启动同步其它读请求的先后）。 */
function pinCalls(calls: readonly CapturedRequest[]): CapturedRequest[] {
  return calls.filter(call => call.url === '/dshtrading/api/watchlist-pins')
}

function clearLocalStorage(): void {
  const storage = (globalThis as { localStorage?: { clear?: () => void } }).localStorage
  storage?.clear?.()
}

beforeEach(() => {
  // 从仓库根跑 vitest 不会加载包内 setup.ts：本文件自己清浏览器存储，用例之间不串镜像。
  clearLocalStorage()
  FakeEventSource.created.length = 0
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

afterAll(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { EventSource?: unknown }).EventSource = realEventSource
})

describe('wireHostWatchlistSync · 启动同步（pinned 镜像）', () => {
  it('用户重启客户端时，host 置顶键集落到分组镜像并写进 localStorage 镜像', async () => {
    // Given host 侧已有一个分组、并把美股苹果置顶
    const panel = createPanel({
      watchlists: { us: [{ market: 'us', symbol: 'AAPL', name: '苹果' }] },
      groups: [{ id: 'g_1', name: '核心仓', createdAt: 42 }],
      pinned: ['us:AAPL'],
    })
    // When 客户端启动同步（GET /watchlists → GET /watchlist-groups → GET /selection）
    const harness = boot(panel)
    const landing = await harness.probe.next()
    await harness.bootServed
    // Then 落地的正是 host 的注册表与置顶键集，快照与本地镜像逐字段一致
    expect(landing).toEqual({ groups: [{ id: 'g_1', name: '核心仓', createdAt: 42 }], pinned: ['us:AAPL'] })
    expect(harness.groups.getSnapshot().pinned).toEqual(['us:AAPL'])
    expect(createWatchlistGroupsStore().getSnapshot().pinned).toEqual(['us:AAPL'])
    expect(createWatchlistGroupsStore().getSnapshot().groups).toEqual([{ id: 'g_1', name: '核心仓', createdAt: 42 }])
    // And 启动同步只读：一次写请求都没发
    expect(harness.calls.filter(call => call.method !== 'GET')).toEqual([])
  })
})

describe('wireHostWatchlistSync · setPinned host-first 接管', () => {
  it('用户点置顶且 host 接受时，本地镜像等于 host 返回的权威键集', async () => {
    // Given 启动同步完成的客户端（host 键集当前为空）
    const harness = boot(createPanel())
    await harness.probe.next()
    // When 另一客户端先在 host 侧置顶了港股腾讯，随后本客户端置顶美股苹果
    harness.panel.pinned = ['hk:00700']
    const ok = await harness.groups.setPinned('us:AAPL', true)
    // Then 这次写走 PUT（请求体就是本次变更），本地键集取 host 返回值（含别处写入的键）
    expect(ok).toBe(true)
    expect(pinCalls(harness.calls)).toEqual([{
      url: '/dshtrading/api/watchlist-pins',
      method: 'PUT',
      body: JSON.stringify({ key: 'us:AAPL', pinned: true }),
    }])
    expect(harness.groups.getSnapshot().pinned).toEqual(['hk:00700', 'us:AAPL'])
    expect(createWatchlistGroupsStore().getSnapshot().pinned).toEqual(['hk:00700', 'us:AAPL'])
  })

  it('用户取消置顶且 host 接受时，本地键集同样取 host 返回值', async () => {
    // Given host 侧置顶了两个标的（美股苹果、港股腾讯）
    const harness = boot(createPanel({ pinned: ['us:AAPL', 'hk:00700'] }))
    await harness.probe.next()
    // When 客户端取消置顶美股苹果
    const ok = await harness.groups.setPinned('us:AAPL', false)
    // Then 请求体带 pinned:false，本地只剩腾讯
    expect(ok).toBe(true)
    expect(pinCalls(harness.calls)).toEqual([{
      url: '/dshtrading/api/watchlist-pins',
      method: 'PUT',
      body: JSON.stringify({ key: 'us:AAPL', pinned: false }),
    }])
    expect(harness.groups.getSnapshot().pinned).toEqual(['hk:00700'])
    expect(createWatchlistGroupsStore().getSnapshot().pinned).toEqual(['hk:00700'])
  })

  it('用户点置顶但 host 拒绝（非 2xx / 业务错误 / 网络失败）时，本地键集保持不变', async () => {
    // Given 启动同步后本地镜像已有美股苹果置顶
    const harness = boot(createPanel({ pinned: ['us:AAPL'] }))
    await harness.probe.next()
    // When host 依次以 500、HTTP 200 + ok:false、连接中断三种方式拒绝这次置顶
    harness.panel.pinFault = 'not-ok'
    const serverError = await harness.groups.setPinned('hk:00700', true)
    harness.panel.pinFault = 'business-error'
    const businessError = await harness.groups.setPinned('hk:00700', true)
    harness.panel.pinFault = 'network'
    const offline = await harness.groups.setPinned('hk:00700', true)
    // Then 三次都返回 false（fail-closed），快照与本地镜像都还是原来那一个键
    expect([serverError, businessError, offline]).toEqual([false, false, false])
    expect(harness.groups.getSnapshot().pinned).toEqual(['us:AAPL'])
    expect(createWatchlistGroupsStore().getSnapshot().pinned).toEqual(['us:AAPL'])

    // And 反向同样 fail-closed：取消置顶被拒时原键不被摘掉
    const unpin = await harness.groups.setPinned('us:AAPL', false)
    expect(unpin).toBe(false)
    expect(harness.groups.getSnapshot().pinned).toEqual(['us:AAPL'])
    expect(createWatchlistGroupsStore().getSnapshot().pinned).toEqual(['us:AAPL'])

    // And 四次请求都真的发出去了（失败方向也在写，只是本地不认）
    expect(pinCalls(harness.calls).map(call => call.body)).toEqual([
      JSON.stringify({ key: 'hk:00700', pinned: true }),
      JSON.stringify({ key: 'hk:00700', pinned: true }),
      JSON.stringify({ key: 'hk:00700', pinned: true }),
      JSON.stringify({ key: 'us:AAPL', pinned: false }),
    ])
  })
})

describe('wireHostWatchlistSync · SSE watchlists 重拉', () => {
  it('用户经工具或另一标签页改了置顶后，SSE 信号把镜像覆盖为 host 权威值', async () => {
    // Given 启动同步完成（host 键集 us:AAPL）且桥连接已建立
    const harness = boot(createPanel({ pinned: ['us:AAPL'] }))
    await harness.probe.next()
    const source = FakeEventSource.created.at(-1)
    expect(source).toBeDefined()
    expect(source?.url).toBe('/dshtrading/api/events')
    // When host 键集被别处改成只剩港股腾讯，桥推送 store.changed(watchlists)
    harness.panel.pinned = ['hk:00700']
    source?.emitStoreChanged('watchlists')
    const landing = await harness.probe.next()
    // Then 重拉覆盖（不是合并/追加），快照与本地镜像同步成 host 值
    expect(landing.pinned).toEqual(['hk:00700'])
    expect(harness.groups.getSnapshot().pinned).toEqual(['hk:00700'])
    expect(createWatchlistGroupsStore().getSnapshot().pinned).toEqual(['hk:00700'])
    // And 面板读面确实被重拉了一次（启动一次 + 本次一次）
    expect(harness.calls.filter(call => call.url === '/dshtrading/api/watchlist-groups')).toHaveLength(2)
  })
})

describe('createWatchlistGroupsStore · pinned 镜像契约', () => {
  it('用户桥降级期先置顶、启动时 host 回空键集（老桥无置顶能力）时，镜像以 host 为准归零', async () => {
    // Given 一个没接线的分组 store（桥降级路径），先在本地置顶美股苹果
    const groups = createWatchlistGroupsStore()
    const localPinned = await groups.setPinned('us:AAPL', true)
    // When host 权威注册表落地并带回空键集（api 层把「字段缺席」归一成 []，见
    // watchlist-groups-api.test.ts：老桥没有置顶能力 = 空集，不是「保留本地」）
    groups.applyHost([{ id: 'g_1', name: '核心仓', createdAt: 1 }], [])
    // Then 注册表与键集都随 host，localStorage 镜像同源
    expect(localPinned).toBe(true)
    expect(groups.getSnapshot().groups.map(group => group.id)).toEqual(['g_1'])
    expect(groups.getSnapshot().pinned).toEqual([])
    expect(createWatchlistGroupsStore().getSnapshot().pinned).toEqual([])
  })

  it('用户从 host 拿到含空串与重复的置顶键集时，镜像只收非空字符串且去重', () => {
    // Given 一个空的分组 store
    const groups = createWatchlistGroupsStore()
    // When host 落地一组带坏值与重复的键
    groups.applyHost([], ['us:AAPL', '', 'us:AAPL', 'hk:00700'])
    // Then 空串剔除、重复合并，合法键保序（面板不会多出幽灵置顶行）
    expect(groups.getSnapshot().pinned).toEqual(['us:AAPL', 'hk:00700'])
    expect(createWatchlistGroupsStore().getSnapshot().pinned).toEqual(['us:AAPL', 'hk:00700'])
  })
})
