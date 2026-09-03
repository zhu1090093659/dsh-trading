import { describe, expect, it, vi } from 'vitest'
import { placeGuiOrder, placeGuiDryRunOrder } from '../src/client/api.ts'

describe('Trade UI API & Real Trading', () => {
  it('placeGuiOrder: 默认带 dryRun: false 实盘报单', async () => {
    let capturedBody: string | undefined
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string
      return new Response(JSON.stringify({
        ok: true,
        order: {
          id: 'ord-real-999',
          symbol: '601318',
          side: 'buy',
          type: 'limit',
          quantity: 100,
          price: 45.2,
          dryRun: false,
          status: 'pending',
          timestamp: Date.now(),
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof globalThis.fetch

    const res = await placeGuiOrder('cn', {
      symbol: '601318',
      side: 'buy',
      type: 'limit',
      quantity: 100,
      price: 45.2,
    })

    expect(capturedBody).toBeDefined()
    const parsed = JSON.parse(capturedBody!)
    expect(parsed.dryRun).toBe(false)
    expect(res.order).toBeDefined()
    expect(res.order?.id).toBe('ord-real-999')
    expect(res.order?.dryRun).toBe(false)
  })

  it('placeGuiOrder: 遇到报错返回 error 消息而非静默 null', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({
        ok: false,
        code: 'TRADING_LIVE_TRADING_DISABLED',
        message: 'liveTrading is disabled for this connector',
      }), { status: 400, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof globalThis.fetch

    const res = await placeGuiOrder('cn', {
      symbol: '601318',
      side: 'buy',
      type: 'limit',
      quantity: 100,
      price: 45.2,
    })

    expect(res.order).toBeUndefined()
    expect(res.error).toContain('liveTrading is disabled')
  })

  it('placeGuiDryRunOrder: 兼容旧调用', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({
        ok: true,
        order: {
          id: 'ord-123',
          symbol: 'BTCUSDT',
          side: 'buy',
          type: 'market',
          quantity: 1,
          dryRun: false,
          status: 'filled',
          timestamp: Date.now(),
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof globalThis.fetch

    const order = await placeGuiDryRunOrder('crypto', {
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'market',
      quantity: 1,
    })
    expect(order?.id).toBe('ord-123')
  })
})
