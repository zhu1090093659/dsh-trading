/**
 * 数据面行单测：config.market 分流（cn → tradingCnMarketData / hk →
 * tradingHkMarketData），同包双行互不冲突。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/dataplane.ts'

function makeCtx(): { ctx: Context; provided: Record<string, unknown> } {
  const provided: Record<string, unknown> = {}
  const ctx = {
    reflect: {
      provide: (name: string, value: unknown) => { provided[name] = value },
    },
  } as unknown as Context
  return { ctx, provided }
}

describe('connector-tencent dataplane', () => {
  it('market=cn → provide tradingCnMarketData（不写 hk 键）', () => {
    const { ctx, provided } = makeCtx()
    apply(ctx, { market: 'cn', dryRun: true, liveTrading: false })
    expect(provided.tradingCnMarketData).toBeDefined()
    expect(provided.tradingHkMarketData).toBeUndefined()
  })

  it('market=hk → provide tradingHkMarketData（不写 cn 键）', () => {
    const { ctx, provided } = makeCtx()
    apply(ctx, { market: 'hk', dryRun: true, liveTrading: false })
    expect(provided.tradingHkMarketData).toBeDefined()
    expect(provided.tradingCnMarketData).toBeUndefined()
  })
})

describe('connector-tencent dataplane（注册表模式，2026-08-30 整改 #1）', () => {
  function makeRegistryCtx() {
    const provided: Record<string, unknown> = {}
    const registrations: Array<{ market: string; provider: string; service: unknown }> = []
    const registry = {
      register: (market: string, provider: string, service: unknown) => {
        registrations.push({ market, provider, service })
        return () => {}
      },
    }
    const ctx = {
      get: (key: string) => (key === 'tradingMarketDataRegistry' ? registry : undefined),
      isolate: () => ({ reflect: { provide: () => {} } }),
      effect: (fn: () => () => void) => { fn() },
      reflect: { provide: (name: string, value: unknown) => { provided[name] = value } },
    } as unknown as Context
    return { ctx, provided, registrations }
  }

  it('market=cn → 注册 (cn, tencent)；market=hk → 注册 (hk, tencent)；根键均不占', () => {
    const cn = makeRegistryCtx()
    apply(cn.ctx, { market: 'cn', dryRun: true, liveTrading: false })
    expect(cn.registrations).toHaveLength(1)
    expect(cn.registrations[0]?.market).toBe('cn')
    expect(cn.registrations[0]?.provider).toBe('tencent')
    expect(cn.provided.tradingCnMarketData).toBeUndefined()

    const hk = makeRegistryCtx()
    apply(hk.ctx, { market: 'hk', dryRun: true, liveTrading: false })
    expect(hk.registrations[0]?.market).toBe('hk')
    expect(hk.provided.tradingHkMarketData).toBeUndefined()
  })
})
