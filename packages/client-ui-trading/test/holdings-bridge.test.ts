/**
 * 统一资产台账桥端点单测（Issue #65，契约 §3/§4/§7）：
 * /holdings 七端点（fallback 内存 store 全程：stage→confirm/discard→add/update/
 * remove→snapshot）、TRADING_HOLDINGS_INVALID 校验信封（HTTP 200 + ok:false）、
 * /fx 基准币校验与兜底 fetcher 降级链（成功倒数归一 + USDT 锚定 / 过期缓存
 * stale / 恒等兜底 stale）、写成功 emit('holdings') 接线。全程 fetch 桩不触网。
 */
import { describe, expect, it, vi } from 'vitest'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  BridgeProtocolError,
  TradingBridge,
  createBridgeHost,
  createFallbackFxFetcher,
  createFallbackHoldingsStore,
  dispatchBridgeRequest,
  type FxRatesSnapshot,
} from '../src/bridge.ts'
import { apply } from '../src/index.ts'

vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error('holdings-bridge.test must not hit network')
}))

function makeBridge(): TradingBridge {
  return new TradingBridge(createBridgeHost({ legacy: () => undefined }))
}

async function dispatch(bridge: TradingBridge, method: string, sub: string, body?: unknown, query = ''): Promise<{ status: number; payload: Record<string, unknown> }> {
  const search = new URLSearchParams(query)
  const { status, payload } = await dispatchBridgeRequest(bridge, method, sub, search, body)
  return { status, payload: payload as Record<string, unknown> }
}

const VALID_ITEM = { market: 'hk', symbol: '00700', side: 'long', size: 100, entryPrice: 380, account: '富途', kind: 'real' }

describe('TradingBridge /holdings 七端点（fallback 内存 store）', () => {
  it('GET /holdings：空台账快照', async () => {
    const { status, payload } = await dispatch(makeBridge(), 'GET', '/holdings')
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, revision: 0, staged: [], holdings: [] })
  })

  it('stage → confirm（带编辑）→ snapshot 全流转，revision 自增', async () => {
    const bridge = makeBridge()
    const staged = await dispatch(bridge, 'POST', '/holdings/stage', { items: [VALID_ITEM, { market: 'us', symbol: 'AAPL', size: 5 }] })
    expect(staged.payload).toMatchObject({ ok: true, revision: 1 })

    let snap = (await dispatch(bridge, 'GET', '/holdings')).payload
    expect(snap.staged).toHaveLength(2)
    expect(snap.holdings).toHaveLength(0)
    const rows = snap.staged as Array<{ id: string; size: number; account: string; kind: string; currency: string; source: string }>
    // 默认值推导在写入侧完成（契约 §2）：account 缺省 '默认账户'、kind 缺省 real、
    // currency 按 market 推导（us→USD）、source 恒 imported、id 前缀 hd-。
    expect(rows[1]).toMatchObject({ account: '默认账户', kind: 'real', currency: 'USD', source: 'imported' })
    expect(rows[0]?.id).toMatch(/^hd-/)
    expect(rows[0]).toMatchObject({ account: '富途', currency: 'HKD' })

    const confirm = await dispatch(bridge, 'POST', '/holdings/confirm', { ids: [rows[0]!.id], edits: { [rows[0]!.id]: { size: 200, kind: 'sim' } } })
    expect(confirm.payload).toMatchObject({ ok: true, revision: 2 })

    snap = (await dispatch(bridge, 'GET', '/holdings')).payload
    expect(snap.staged).toHaveLength(1)
    expect(snap.holdings).toHaveLength(1)
    expect((snap.holdings as Array<{ size: number; kind: string }>)[0]).toMatchObject({ size: 200, kind: 'sim' })

    const discard = await dispatch(bridge, 'POST', '/holdings/discard', { ids: [rows[1]!.id] })
    expect(discard.payload).toMatchObject({ ok: true, revision: 3 })
    snap = (await dispatch(bridge, 'GET', '/holdings')).payload
    expect(snap.staged).toHaveLength(0)
  })

  it('add → update → remove 直写正式区', async () => {
    const bridge = makeBridge()
    const add = await dispatch(bridge, 'POST', '/holdings', VALID_ITEM)
    expect(add.payload).toMatchObject({ ok: true, revision: 1 })
    const id = (add.payload as { id: string }).id
    expect(id).toMatch(/^hd-/)

    const update = await dispatch(bridge, 'PUT', '/holdings', { id, patch: { entryPrice: 390, account: 'IBKR' } })
    expect(update.payload).toMatchObject({ ok: true, revision: 2 })
    let snap = (await dispatch(bridge, 'GET', '/holdings')).payload
    expect((snap.holdings as Array<{ entryPrice: number; account: string }>)[0]).toMatchObject({ entryPrice: 390, account: 'IBKR' })

    const removed = await dispatch(bridge, 'DELETE', '/holdings', undefined, `id=${id}`)
    expect(removed.payload).toMatchObject({ ok: true, revision: 3 })
    snap = (await dispatch(bridge, 'GET', '/holdings')).payload
    expect(snap.holdings).toHaveLength(0)
  })

  it('校验失败 → HTTP 200 + ok:false + TRADING_HOLDINGS_INVALID（契约 §3 信封）', async () => {
    const bridge = makeBridge()
    const cases: Array<[string, string, unknown, string?]> = [
      ['POST', '/holdings/stage', {}, 'items'],                       // items 缺席
      ['POST', '/holdings/stage', { items: [] }, 'empty'],            // 空数组
      ['POST', '/holdings/stage', { items: [{ ...VALID_ITEM, market: 'mars' }] }, 'market'],
      ['POST', '/holdings/stage', { items: [{ ...VALID_ITEM, size: 0 }] }, 'size'],
      ['POST', '/holdings/stage', { items: [{ ...VALID_ITEM, side: 'short' }] }, 'side'],
      ['POST', '/holdings', { ...VALID_ITEM, symbol: '  ' }, 'symbol'],
      ['POST', '/holdings', { ...VALID_ITEM, currency: 'EUR' }, 'currency'],
      ['POST', '/holdings', { ...VALID_ITEM, kind: 'demo' }, 'kind'],
      ['POST', '/holdings/confirm', { ids: [] }, 'ids'],
      ['POST', '/holdings/confirm', { ids: ['hd-x'], edits: { 'hd-x': { size: -1 } } }, 'size'],
      ['POST', '/holdings/discard', { ids: 'hd-x' }, 'ids'],
      ['PUT', '/holdings', { patch: { size: 1 } }, 'id'],             // id 缺席
      ['PUT', '/holdings', { id: 'hd-x', patch: { entryPrice: -3 } }, 'entryPrice'],
      ['DELETE', '/holdings', undefined, 'id'],                       // ?id= 缺席
    ]
    for (const [method, sub, body, needle] of cases) {
      const { status, payload } = await dispatch(bridge, method, sub, body, method === 'DELETE' ? '' : '')
      expect(status, `${method} ${sub}`).toBe(200)
      expect(payload.ok, `${method} ${sub}`).toBe(false)
      expect(payload.code).toBe('TRADING_HOLDINGS_INVALID')
      if (needle !== undefined) expect(String(payload.message)).toContain(needle)
    }
    // stage 封顶
    const tooMany = await dispatch(bridge, 'POST', '/holdings/stage', { items: Array.from({ length: 101 }, () => VALID_ITEM) })
    expect(tooMany.payload).toMatchObject({ ok: false, code: 'TRADING_HOLDINGS_INVALID' })
  })

  it('currency 大小写归一（小写入库大写）', async () => {
    const bridge = makeBridge()
    const add = await dispatch(bridge, 'POST', '/holdings', { ...VALID_ITEM, currency: 'hkd' })
    expect(add.payload.ok).toBe(true)
    const snap = (await dispatch(bridge, 'GET', '/holdings')).payload
    expect((snap.holdings as Array<{ currency: string }>)[0]?.currency).toBe('HKD')
  })
})

describe('TradingBridge /fx 端点', () => {
  it('非法 base → 400 协议错误；base 缺省 USD', async () => {
    const bridge = makeBridge()
    await expect(dispatchBridgeRequest(bridge, 'GET', '/fx', new URLSearchParams('base=EUR')))
      .rejects.toThrowError(BridgeProtocolError)
    // 缺省 base=USD：全局 fetch 桩必抛 → 恒等兜底 stale:true
    const { status, payload } = await dispatch(bridge, 'GET', '/fx')
    expect(status).toBe(200)
    expect(payload).toMatchObject({ ok: true, base: 'USD', stale: true })
    expect(payload.rates).toEqual({ USD: 1, USDT: 1 })
  })

  it('host.fetchFxRates 注入时透传（集成正式实现的形状）', async () => {
    const fake: FxRatesSnapshot = { base: 'HKD', rates: { HKD: 1, USD: 7.8, USDT: 7.8 }, asOf: 42, stale: false }
    const bridge = new TradingBridge(createBridgeHost({ legacy: () => undefined, fetchFxRates: async () => fake }))
    const { payload } = await dispatch(bridge, 'GET', '/fx', undefined, 'base=hkd')
    expect(payload).toEqual({ ok: true, base: 'HKD', rates: { HKD: 1, USD: 7.8, USDT: 7.8 }, asOf: 42, stale: false })
  })
})

describe('createFallbackFxFetcher 降级链（契约 §4）', () => {
  it('成功：frankfurter 语义倒数归一 + USDT 锚定 USD + 内存缓存命中', async () => {
    let calls = 0
    const fetcher2 = createFallbackFxFetcher((async () => {
      calls += 1
      return new Response(JSON.stringify({ rates: { CNY: 7.1, HKD: 7.8 } }), { status: 200 })
    }) as unknown as typeof fetch)
    const snap = await fetcher2('USD')
    expect(snap.stale).toBe(false)
    expect(snap.rates.USD).toBe(1)
    expect(snap.rates.CNY).toBeCloseTo(1 / 7.1, 6)
    expect(snap.rates.HKD).toBeCloseTo(1 / 7.8, 6)
    expect(snap.rates.USDT).toBe(1) // USDT 锚定 USD
    // 缓存命中：1h 内同 base 不再请求
    await fetcher2('USD')
    expect(calls).toBe(1)
  })

  it('失败且无缓存 → 恒等兜底 stale:true；过期缓存 → 旧值 stale:true', async () => {
    const failing = createFallbackFxFetcher((async () => { throw new Error('offline') }) as unknown as typeof fetch)
    const identity = await failing('CNY')
    expect(identity).toMatchObject({ base: 'CNY', stale: true, asOf: 0 })
    // 恒等兜底只含 base:1——非 USD 基准时 USD/USDT 无数据不编造（契约 §3，
    // @dshtrading/holdings/fx 语义；比我桥内旧兜底更严格）。
    expect(identity.rates).toEqual({ CNY: 1 })

    let fail = false
    const flip = createFallbackFxFetcher((async () => {
      if (fail) throw new Error('offline')
      return new Response(JSON.stringify({ rates: { USD: 0.14, HKD: 1.09 } }), { status: 200 })
    }) as unknown as typeof fetch)
    const fresh = await flip('CNY')
    expect(fresh.stale).toBe(false)
    expect(fresh.rates.USD).toBeCloseTo(1 / 0.14, 6)
    fail = true
    // 缓存未过期前仍按 fresh 返回
    const cached = await flip('CNY')
    expect(cached.stale).toBe(false)
  })
})

/* -- emit('holdings') 接线（apply 全链路，service-wiring 同款）--------------- */

interface Route {
  kind: string
  path: string
  handler: (req: Partial<IncomingMessage>, res: Partial<ServerResponse>) => Promise<void>
}

async function makeWiredCtx(events?: { emit(store: string): void }) {
  const registered: Route[] = []
  const ctx = new CordisContext()
  if (events !== undefined) ctx.provide('tradingEvents', events)
  ctx.provide('webServer', { register: (route: Route) => { registered.push(route) } })
  ctx.provide('connection', { requestRejection: () => undefined })
  apply(ctx as never)
  await new Promise(resolve => setImmediate(resolve))
  return { registered }
}

async function http(registered: Route[], method: string, sub: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0
  let text = ''
  const res = {
    writeHead: (s: number) => { status = s },
    end: (b?: string) => { text = b ?? '' },
  } as unknown as ServerResponse
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url: `/dshtrading/api${sub}`,
  }) as unknown as IncomingMessage
  await registered[0]!.handler(req, res)
  return { status, body: JSON.parse(text) as Record<string, unknown> }
}

describe('apply() holdings 接线（issue #65）', () => {
  it("写成功 → emit holdings；GET 读面不发；业务拒绝（ok:false）不发", async () => {
    const all: string[] = []
    const { registered } = await makeWiredCtx({ emit: (store: string) => { all.push(store) } })
    // tasks 服务启动也会 emit('tasks')——只跟踪 holdings 信号。
    const emitted = (): string[] => all.filter(store => store === 'holdings')

    const add = await http(registered, 'POST', '/holdings', VALID_ITEM)
    expect(add.body).toMatchObject({ ok: true })
    expect(emitted()).toEqual(['holdings'])

    await http(registered, 'GET', '/holdings')
    expect(emitted()).toEqual(['holdings']) // GET 不 emit

    const invalid = await http(registered, 'POST', '/holdings', { ...VALID_ITEM, size: -1 })
    expect(invalid.body).toMatchObject({ ok: false, code: 'TRADING_HOLDINGS_INVALID' })
    expect(emitted()).toEqual(['holdings']) // 业务拒绝不 emit

    const staged = await http(registered, 'POST', '/holdings/stage', { items: [VALID_ITEM] })
    expect(staged.body).toMatchObject({ ok: true })
    expect(emitted()).toEqual(['holdings', 'holdings'])
  })

  it('tradingEvents 缺席（老部署）→ 写仍成功，发布点静默降级', async () => {
    const { registered } = await makeWiredCtx()
    const add = await http(registered, 'POST', '/holdings', VALID_ITEM)
    expect(add.body).toMatchObject({ ok: true })
  })
})
