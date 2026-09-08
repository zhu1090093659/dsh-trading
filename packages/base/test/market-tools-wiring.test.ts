/**
 * host 平面工具族接线集成测试（issue #86）：真实 cordis Context 上把
 * router + base/market-tools + watchlist + strategies + holdings 一起 apply，
 * 断言「同一 tools 注册表里最终有哪些工具」与关键执行路径——单测各自过、
 * 合起来撞名或漏注册才是真风险（service-wiring 同款先例）。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { beforeAll, describe, expect, it } from 'vitest'
import { apply as applyHoldings } from '../../holdings/src/plugin.ts'
import { apply as applyRouter } from '../../router/src/index.ts'
import { apply as applyStrategies } from '../../strategies/src/plugin.ts'
import { apply as applyWatchlist } from '../../watchlist/src/plugin.ts'
import { apply as applyMarketTools } from '../src/market-tools.ts'

interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

interface Harness {
  ctx: CordisContext
  tools: Map<string, RegisteredTool>
  register: (market: string, service: unknown) => void
  registerTrade: (market: string, service: unknown) => void
}

async function makeHarness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-market-tools-'))
  process.env.DSH_HOME = home
  const ctx = new CordisContext()
  const tools = new Map<string, RegisteredTool>()
  ctx.provide('tools', {
    register: (tool: RegisteredTool) => {
      if (tools.has(tool.name)) throw new Error('duplicate tool registration: ' + tool.name)
      tools.set(tool.name, tool)
    },
    get: (name: string) => tools.get(name),
  })
  applyRouter(ctx as never, { markets: { crypto: { provider: 'fake' }, us: { provider: 'fake' } } } as never)
  applyMarketTools(ctx as never, { markets: ['crypto', 'us', 'cn', 'hk'] })
  applyWatchlist(ctx as never)
  applyStrategies(ctx as never)
  applyHoldings(ctx as never)
  await new Promise(resolve => setImmediate(resolve))
  const marketRegistry = ctx.get('tradingMarketDataRegistry') as { register(market: string, provider: string, service: unknown): () => void }
  const tradeRegistry = ctx.get('tradingTradeRegistry') as { register(market: string, provider: string, service: unknown): () => void }
  return {
    ctx,
    tools,
    register: (market, service) => { marketRegistry.register(market, 'fake', service) },
    registerTrade: (market, service) => { tradeRegistry.register(market, 'fake', service) },
  }
}

const BARS = Array.from({ length: 300 }, (_, i) => ({
  openTime: 1700000000000 + i * 86_400_000,
  open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1000,
}))

describe('host 平面工具族接线（真实 registry）', () => {
  let h: Harness
  beforeAll(async () => { h = await makeHarness() })

  it('28 个市场/账户只读工具 + 能力包工具同表注册，无重名冲突', () => {
    const names = [...h.tools.keys()]
    for (const market of ['crypto', 'us', 'cn', 'hk']) {
      for (const suffix of ['get_orderbook', 'get_trades', 'get_positions', 'get_orders', 'get_fills', 'get_balance', 'get_order']) {
        expect(names, `${market}_${suffix}`).toContain(`${market}_${suffix}`)
      }
    }
    // 能力包新增工具同批可见（G3/G4/G5/G7）。
    expect(names).toEqual(expect.arrayContaining([
      'routing_get', 'instruments_search',
      'strategy_list', 'screener_list', 'screener_run', 'strategy_backtest',
      'watchlist_list', 'watchlist_group_create', 'watchlist_group_rename', 'watchlist_group_delete', 'watchlist_group_assign',
      'fx_get', 'holdings_list',
    ]))
    // 零下单/撤单命名族（铁律 #3）。
    expect(names.some(name => /_(?:place|cancel)_order$/.test(name))).toBe(false)
  })

  it('行情服务注册后盘口/逐笔可用；未实现方法报 TRADING_NOT_IMPLEMENTED', async () => {
    h.register('crypto', {
      getOrderbook: async () => ({ bids: [[100, 1]], asks: [[101, 1]], timestamp: 7 }),
      getKlines: async () => BARS,
      listInstruments: async () => [{ symbol: 'BTCUSDT', name: 'Bitcoin' }, { symbol: 'ETHUSDT' }],
    })
    const book = JSON.parse(String(await h.tools.get('crypto_get_orderbook')!.execute({ symbol: 'BTCUSDT' }))) as Record<string, unknown>
    expect(book).toMatchObject({ ok: true, market: 'crypto', provider: 'fake', symbol: 'BTCUSDT' })
    expect(book.orderbook).toMatchObject({ timestamp: 7 })
    await expect(h.tools.get('crypto_get_trades')!.execute({ symbol: 'BTCUSDT' })).rejects.toThrow(/TRADING_NOT_IMPLEMENTED/)
  })

  it('交易服务注册后账户读面可用；无交易连接器时 TRADING_NO_TRADE_SERVICE', async () => {
    h.registerTrade('us', {
      getPositions: async () => [{ symbol: 'AAPL', size: 3 }],
      listOpenOrders: async () => [{ id: 'o1', symbol: 'AAPL' }],
      environment: () => ({ env: 'demo', simulated: true }),
    })
    const positions = JSON.parse(String(await h.tools.get('us_get_positions')!.execute({}))) as Record<string, unknown>
    expect(positions).toMatchObject({ ok: true, provider: 'fake', environment: { simulated: true } })
    await expect(h.tools.get('us_get_fills')!.execute({})).rejects.toThrow(/TRADING_NOT_IMPLEMENTED/)
    await expect(h.tools.get('cn_get_positions')!.execute({})).rejects.toThrow(/TRADING_NO_TRADE_SERVICE/)
  })

  it('screener_run 走真实 registry 名册与行情服务', async () => {
    const wire = JSON.parse(String(await h.tools.get('screener_run')!.execute({
      screenerId: 'scr.near-high', market: 'crypto', paramsJson: '{"window":60}',
    }))) as Record<string, unknown>
    expect(wire).toMatchObject({ ok: true, provider: 'fake', universeSize: 2, scanned: 2 })
    expect((wire.results as unknown[]).length).toBe(2)
  })

  it('自选分组工具写读闭环（真实 file store，隔离 home）', async () => {
    const created = JSON.parse(String(await h.tools.get('watchlist_group_create')!.execute({ name: '接线组' }))) as Record<string, unknown>
    expect(created.ok).toBe(true)
    await h.tools.get('watchlist_group_assign')!.execute({ id: created.id, market: 'us', symbol: 'AAPL', member: true })
    const list = JSON.parse(String(await h.tools.get('watchlist_list')!.execute({}))) as { groups: Array<Record<string, unknown>> }
    expect(list.groups).toEqual([{ id: created.id, name: '接线组', createdAt: expect.any(Number), members: 1 }])
  })

  it('重复 apply 幂等（同名先到先得，不触发 dsh-tools 重名抛错）', () => {
    const before = [...h.tools.keys()]
    applyMarketTools(h.ctx as never, { markets: ['crypto', 'us', 'cn', 'hk'] })
    expect([...h.tools.keys()]).toEqual(before)
  })
})
