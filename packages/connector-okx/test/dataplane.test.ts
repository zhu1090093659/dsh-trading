/**
 * 数据面行单测：enabled + router consult 三态；只 provide 行情服务、不 provide
 * 交易服务（交易面留 preset 平面）。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/dataplane.ts'

const CONFIG = { enabled: true, env: 'demo', dryRun: true, liveTrading: false }

function makeCtx(router: unknown): { ctx: Context; provided: Record<string, unknown> } {
  const provided: Record<string, unknown> = {}
  const ctx = {
    get: (key: string) => (key === 'tradingMarketRouter' ? router : undefined),
    reflect: {
      provide: (name: string, value: unknown) => { provided[name] = value },
    },
  } as unknown as Context
  return { ctx, provided }
}

describe('connector-okx dataplane', () => {
  it('enabled=true 且无 router → provide tradingCryptoMarketData，且不 provide tradingCryptoTrade', () => {
    const { ctx, provided } = makeCtx(undefined)
    apply(ctx, CONFIG)
    expect(provided.tradingCryptoMarketData).toBeDefined()
    expect(provided.tradingCryptoTrade).toBeUndefined()
  })

  it('router 选中 okx → provide；选中 binance/未设置 → 拒绝', () => {
    const router = (active: string | undefined) => ({ activeProvider: () => active })

    const selOkx = makeCtx(router('okx'))
    apply(selOkx.ctx, CONFIG)
    expect(selOkx.provided.tradingCryptoMarketData).toBeDefined()

    const selBin = makeCtx(router('binance'))
    apply(selBin.ctx, CONFIG)
    expect(selBin.provided.tradingCryptoMarketData).toBeUndefined()

    const unset = makeCtx(router(undefined))
    apply(unset.ctx, CONFIG)
    expect(unset.provided.tradingCryptoMarketData).toBeUndefined()
  })

  it('enabled=false → 永不 provide', () => {
    const { ctx, provided } = makeCtx(undefined)
    apply(ctx, { ...CONFIG, enabled: false })
    expect(provided.tradingCryptoMarketData).toBeUndefined()
  })
})

describe('connector-okx dataplane（注册表模式，2026-08-30 整改 #1）', () => {
  it('有注册表 → 注册 (crypto, okx)，不占 host 根市场键；enabled=false → 不注册', () => {
    const registrations: Array<{ market: string; provider: string; service: unknown }> = []
    const provided: Record<string, unknown> = {}
    const registry = {
      register: (market: string, provider: string, service: unknown) => {
        registrations.push({ market, provider, service })
        return () => {}
      },
    }
    const makeRegistryCtx = () => ({
      get: (key: string) => (key === 'tradingMarketDataRegistry' ? registry : undefined),
      isolate: () => ({ reflect: { provide: () => {} } }),
      effect: (fn: () => () => void) => { fn() },
      reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    }) as unknown as Context

    apply(makeRegistryCtx(), CONFIG)
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.market).toBe('crypto')
    expect(registrations[0]?.provider).toBe('okx')
    expect(provided.tradingCryptoMarketData).toBeUndefined()
    expect(provided.tradingCryptoTrade).toBeUndefined() // 交易面永不进 host 数据面

    apply(makeRegistryCtx(), { ...CONFIG, enabled: false })
    expect(registrations).toHaveLength(1)
  })
})
