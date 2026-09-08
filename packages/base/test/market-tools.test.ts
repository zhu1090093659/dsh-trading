/**
 * host 平面只读市场/账户工具单测（issue #86 / 审计缺口卡 G1+G2，离线）：
 * registry 驱动的 7 工具 × 市场展开、可选方法缺席 → TRADING_NOT_IMPLEMENTED
 * （绝不冒充空数据）、无名册/无交易连接器的显式错误码、同名先到先得、
 * 下单闸门命名族零命中。
 */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { isOrderGateTool } from '../src/index.js'
import {
  apply,
  createAccountTools,
  createMarketReadTools,
  createMarketTools,
  MAX_TRADES_LIMIT,
  type MarketDataRegistryLike,
  type TradeRegistryLike,
} from '../src/market-tools.js'

type Json = Record<string, unknown>

function marketRegistry(entry: { provider: string; service: unknown } | undefined): MarketDataRegistryLike {
  return { active: () => entry as never }
}

function tradeRegistry(entry: { provider: string; service: unknown } | undefined): TradeRegistryLike {
  return { active: () => entry as never }
}

const ORDERBOOK = { bids: [[100, 1]], asks: [[101, 1]], timestamp: 1 }

describe('market read tools（G2）', () => {
  it('盘口/逐笔走路由行情服务，回显 provider；limit 越界拒绝', async () => {
    const service = {
      getOrderbook: vi.fn(async () => ORDERBOOK),
      getRecentTrades: vi.fn(async () => [{ price: 100, size: 1, side: 'buy', ts: 1 }]),
    }
    const [orderbook, trades] = createMarketReadTools('us', () => marketRegistry({ provider: 'alpaca', service }))
    const book = JSON.parse(String(await orderbook.execute({ symbol: 'AAPL' }))) as Json
    expect(book).toMatchObject({ ok: true, market: 'us', provider: 'alpaca', symbol: 'AAPL', orderbook: ORDERBOOK })
    const tape = JSON.parse(String(await trades.execute({ symbol: 'AAPL', limit: 10 }))) as Json
    expect(tape.ok).toBe(true)
    expect(service.getRecentTrades).toHaveBeenCalledWith('AAPL', 10)
    await expect(trades.execute({ symbol: 'AAPL', limit: MAX_TRADES_LIMIT + 1 })).rejects.toThrow(/limit must be an integer/)
    await expect(orderbook.execute({})).rejects.toThrow(/missing required property/)
    await expect(orderbook.execute({ symbol: '   ' })).rejects.toThrow(/symbol is required/)
  })

  it('可选方法缺席 → TRADING_NOT_IMPLEMENTED（不是空盘口/空逐笔）', async () => {
    const [orderbook, trades] = createMarketReadTools('cn', () => marketRegistry({ provider: 'tencent', service: {} }))
    await expect(orderbook.execute({ symbol: '600519.SH' })).rejects.toThrow(/TRADING_NOT_IMPLEMENTED: cn provider "tencent" does not implement getOrderbook/)
    await expect(trades.execute({ symbol: '600519.SH' })).rejects.toThrow(/TRADING_NOT_IMPLEMENTED/)
  })

  it('无激活行情 provider → TRADING_NO_PROVIDER', async () => {
    const [orderbook] = createMarketReadTools('hk', () => marketRegistry(undefined))
    await expect(orderbook.execute({ symbol: '00700.HK' })).rejects.toThrow(/TRADING_NO_PROVIDER/)
    const [noRegistry] = createMarketReadTools('hk', () => undefined)
    await expect(noRegistry.execute({ symbol: '00700.HK' })).rejects.toThrow(/TRADING_NO_PROVIDER/)
  })
})

describe('account tools（G1）', () => {
  const fullService = {
    getPositions: vi.fn(async () => [{ symbol: 'AAPL', size: 10 }]),
    listOpenOrders: vi.fn(async () => [{ id: 'o1' }]),
    listTradeFills: vi.fn(async () => [{ id: 'f1' }]),
    getBalances: vi.fn(async () => [{ currency: 'USD', available: 1000 }]),
    getOrder: vi.fn(async (symbol: string, id: string) => ({ symbol, id })),
    environment: () => ({ env: 'demo', simulated: true }),
  }

  it('五个账户工具全部可用，回显 provider 与 environment 自述', async () => {
    const tools = createAccountTools('us', () => tradeRegistry({ provider: 'alpaca', service: fullService }))
    expect(tools.map(tool => tool.name)).toEqual([
      'us_get_positions', 'us_get_orders', 'us_get_fills', 'us_get_balance', 'us_get_order',
    ])
    const positions = JSON.parse(String(await tools[0]!.execute({}))) as Json
    expect(positions).toMatchObject({ ok: true, provider: 'alpaca', environment: { env: 'demo', simulated: true } })
    const orders = JSON.parse(String(await tools[1]!.execute({ symbol: 'AAPL' }))) as Json
    expect(orders).toMatchObject({ ok: true, symbol: 'AAPL' })
    expect(fullService.listOpenOrders).toHaveBeenCalledWith('AAPL')
    const fills = JSON.parse(String(await tools[2]!.execute({ limit: 5 }))) as Json
    expect(fills.ok).toBe(true)
    expect(fullService.listTradeFills).toHaveBeenCalledWith(undefined, 5)
    const balance = JSON.parse(String(await tools[3]!.execute({}))) as Json
    expect(balance.ok).toBe(true)
    const order = JSON.parse(String(await tools[4]!.execute({ symbol: 'AAPL', orderId: 'o1' }))) as Json
    expect(order).toMatchObject({ ok: true, symbol: 'AAPL', orderId: 'o1', order: { symbol: 'AAPL', id: 'o1' } })
    await expect(tools[4]!.execute({ symbol: 'AAPL' })).rejects.toThrow(/missing required property/)
  })

  it('可选方法缺席 → TRADING_NOT_IMPLEMENTED（不是无挂单/零余额）', async () => {
    const partial = { getPositions: vi.fn(async () => []), getOrder: vi.fn(async () => ({})) }
    const tools = createAccountTools('cn', () => tradeRegistry({ provider: 'qmt', service: partial }))
    await expect(tools[1]!.execute({})).rejects.toThrow(/TRADING_NOT_IMPLEMENTED: cn provider "qmt" does not implement listOpenOrders/)
    await expect(tools[2]!.execute({})).rejects.toThrow(/TRADING_NOT_IMPLEMENTED/)
    await expect(tools[3]!.execute({})).rejects.toThrow(/TRADING_NOT_IMPLEMENTED/)
    // 已实现的必需方法照常可用。
    expect(JSON.parse(String(await tools[0]!.execute({}))) as Json).toMatchObject({ ok: true, positions: [] })
  })

  it('无交易连接器 → TRADING_NO_TRADE_SERVICE', async () => {
    const tools = createAccountTools('hk', () => tradeRegistry(undefined))
    await expect(tools[0]!.execute({})).rejects.toThrow(/TRADING_NO_TRADE_SERVICE/)
    const [noRegistry] = createAccountTools('hk', () => undefined)
    await expect(noRegistry!.execute({})).rejects.toThrow(/TRADING_NO_TRADE_SERVICE/)
  })
})

describe('apply 注册面', () => {
  it('四市场 × 7 工具，同名先到先得，零下单/撤单命名族', () => {
    const names: string[] = []
    const existing = new Set(['crypto_get_positions'])
    const ctx = {
      tools: {
        get: (name: string) => (existing.has(name) ? { name } : undefined),
        register: (tool: { name: string }) => names.push(tool.name),
      },
      get: () => undefined,
    } as unknown as Context
    apply(ctx, { markets: ['crypto', 'us', 'cn', 'hk'] })
    expect(names).toHaveLength(28 - 1)
    expect(names).not.toContain('crypto_get_positions')
    expect(names).toContain('crypto_get_orderbook')
    expect(names).toContain('hk_get_balance')
    expect(names.every(name => !isOrderGateTool(name))).toBe(true)
  })

  it('markets 配置去重且可缩面', () => {
    const names: string[] = []
    const ctx = {
      tools: { get: () => undefined, register: (tool: { name: string }) => names.push(tool.name) },
      get: () => undefined,
    } as unknown as Context
    apply(ctx, { markets: ['us', 'us'] })
    expect(names).toHaveLength(7)
    expect(names.every(name => name.startsWith('us_'))).toBe(true)
  })

  it('createMarketTools 对未知市场也按前缀展开（新市场零代码改动）', () => {
    const tools = createMarketTools(['jp'], () => undefined, () => undefined)
    expect(tools.map(tool => tool.name)).toEqual([
      'jp_get_orderbook', 'jp_get_trades', 'jp_get_positions', 'jp_get_orders', 'jp_get_fills', 'jp_get_balance', 'jp_get_order',
    ])
  })
})
