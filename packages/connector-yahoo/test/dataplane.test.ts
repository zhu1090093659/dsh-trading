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
