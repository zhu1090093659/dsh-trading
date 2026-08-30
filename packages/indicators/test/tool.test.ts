/**
 * <market>_get_indicators 工具工厂单测：mock 行情服务（合成趋势 K 线 close=100+i），
 * 覆盖默认全指标 / 指定子集 / 未知 id / 空序列 / required 框架校验 / 市场前缀。
 * 手算锚点：最新 close=399；MA5=(395+396+397+398+399)/5=397。
 */
import { describe, expect, it, vi } from 'vitest'
import { createGetIndicatorsTool } from '../src/tool.ts'
import type { Kline } from '../src/types.ts'

function syntheticBars(n: number): Kline[] {
  return Array.from({ length: n }, (_, i) => ({
    openTime: 1_700_000_000_000 + i * 60_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 10 + i,
  }))
}

function makeTool(overrides: Record<string, unknown> = {}) {
  const getKlines = vi.fn(async () => syntheticBars(300))
  const tool = createGetIndicatorsTool({
    marketData: { getKlines } as never,
    providerLabel: 'fake',
    ...overrides,
  })
  return { tool, getKlines }
}

describe('crypto_get_indicators 工厂', () => {
  it('默认全指标：6 个 id、15 条序列，MA5 latest 手算=397，取数参数透传', async () => {
    const { tool, getKlines } = makeTool()
    const text = await tool.execute({ symbol: 'BTCUSDT', interval: '1d' }) as string
    expect(text).toContain('6 indicator(s)')
    expect(text).toContain('provider=fake')
    expect(text).toContain('MA5 latest=397')
    expect((text.match(/tail=\[/g) || []).length).toBe(15)
    expect(getKlines).toHaveBeenCalledWith('BTCUSDT', '1d', 300)
  })

  it('指定子集 + points 截尾：ma+rsi 共 4 条序列，tail 长度 = points', async () => {
    const { tool, getKlines } = makeTool()
    const text = await tool.execute({ symbol: 'BTCUSDT', interval: '1h', indicators: 'ma,rsi', points: 5 }) as string
    expect(text).toContain('2 indicator(s)')
    expect(text).toContain('MA5 ')
    expect(text).toContain('RSI14')
    expect(text).not.toContain('MACD')
    expect((text.match(/tail=\[/g) || []).length).toBe(4)
    const tailLine = text.split('\n').find((l) => l.includes('MA5'))!
    expect(tailLine.match(/tail=\[[^\]]*\]/)?.[0]?.split(',')).toHaveLength(5)
    expect(getKlines).toHaveBeenCalledWith('BTCUSDT', '1h', 300)
  })

  it('未知指标 id → 报错并列出可选集', async () => {
    const { tool } = makeTool()
    await expect(tool.execute({ symbol: 'BTCUSDT', interval: '1d', indicators: 'ma,nope' }))
      .rejects.toThrowError(/unknown indicator id/)
  })

  it('空 K 线 → 报错；required 缺失由 dsh-tools 框架校验拦截', async () => {
    const getKlines = vi.fn(async () => [])
    const tool = createGetIndicatorsTool({ marketData: { getKlines } as never })
    await expect(tool.execute({ symbol: 'BTCUSDT', interval: '1d' })).rejects.toThrowError(/no klines/)
    await expect(tool.execute({ interval: '1d' })).rejects.toThrowError(/invalid arguments/)
    await expect(tool.execute({ symbol: 'BTCUSDT' })).rejects.toThrowError(/invalid arguments/)
  })

  it('market 前缀可换：us_get_indicators', () => {
    const { tool } = makeTool({ market: 'us' })
    expect(tool.name).toBe('us_get_indicators')
  })
})
