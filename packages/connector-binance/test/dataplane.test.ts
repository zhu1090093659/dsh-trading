/**
 * 数据面行单测：routeAllows 三态驱动 provide 与否；不注册任何工具
 * （工具面在 preset 平面，本行只服务 GUI 行情桥）。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/dataplane.ts'

const CONFIG = { enabled: true, dryRun: true, liveTrading: false }

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

describe('connector-binance dataplane', () => {
  it('enabled=true 且无 router（老部署）→ provide tradingCryptoMarketData', () => {
    const { ctx, provided } = makeCtx(undefined)
    apply(ctx, CONFIG)
    expect(provided.tradingCryptoMarketData).toBeDefined()
  })

  it('router 选中 binance → provide；选中 okx/未设置 → 拒绝', () => {
    const router = (active: string | undefined) => ({ activeProvider: () => active })
    const selBin = makeCtx(router('binance'))
    apply(selBin.ctx, CONFIG)
    expect(selBin.provided.tradingCryptoMarketData).toBeDefined()

    const selOkx = makeCtx(router('okx'))
    apply(selOkx.ctx, CONFIG)
    expect(selOkx.provided.tradingCryptoMarketData).toBeUndefined()

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

describe('connector-binance dataplane（注册表模式，2026-08-30 整改 #1）', () => {
  function makeRegistryCtx() {
    const provided: Record<string, unknown> = {}
    const registrations: Array<{ market: string; provider: string; service: unknown }> = []
    const registry = {
      register: (market: string, provider: string, service: unknown) => {
        registrations.push({ market, provider, service })
        return () => { registrations.splice(registrations.findIndex((r) => r.service === service), 1) }
      },
    }
    const ctx = {
      get: (key: string) => (key === 'tradingMarketDataRegistry' ? registry : undefined),
      isolate: () => ({ reflect: { provide: () => {} } }), // isolate realm 内 provide 不落根
      effect: (fn: () => () => void) => { fn() },
      reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    } as unknown as Context
    return { ctx, provided, registrations }
  }

  it('有注册表 → 注册 (crypto, binance)，不占 host 根市场键', () => {
    const { ctx, provided, registrations } = makeRegistryCtx()
    apply(ctx, CONFIG)
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.market).toBe('crypto')
    expect(registrations[0]?.provider).toBe('binance')
    expect(registrations[0]?.service).toBeDefined()
    expect(provided.tradingCryptoMarketData).toBeUndefined() // 根键不被占用（与 okx 并存无冲突）
  })

  it('有注册表但 enabled=false → 不注册', () => {
    const { ctx, registrations } = makeRegistryCtx()
    apply(ctx, { ...CONFIG, enabled: false })
    expect(registrations).toHaveLength(0)
  })
})
