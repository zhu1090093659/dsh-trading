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
