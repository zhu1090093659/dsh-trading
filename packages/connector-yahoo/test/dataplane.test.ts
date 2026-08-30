/**
 * 数据面行单测：us 数据面直接 provide（无第二候选，无路由裁决面）。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/dataplane.ts'

describe('connector-yahoo dataplane', () => {
  it('apply → provide tradingUsMarketData', () => {
    const provided: Record<string, unknown> = {}
    const ctx = {
      reflect: {
        provide: (name: string, value: unknown) => { provided[name] = value },
      },
    } as unknown as Context
    apply(ctx)
    expect(provided.tradingUsMarketData).toBeDefined()
  })
})

describe('connector-yahoo dataplane（注册表模式，2026-08-30 整改 #1）', () => {
  it('有注册表 → 注册 (us, yahoo)，不占 host 根市场键', () => {
    const registrations: Array<{ market: string; provider: string; service: unknown }> = []
    const provided: Record<string, unknown> = {}
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
    apply(ctx)
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.market).toBe('us')
    expect(registrations[0]?.provider).toBe('yahoo')
    expect(provided.tradingUsMarketData).toBeUndefined()
  })
})
