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
