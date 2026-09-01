/**
 * strategy_author / strategy_backtest 工具单测（离线）：三段链路（校验 → 落盘 →
 * 事件回调）、范式∪自定义解析、行情缺席/空 K 线/未知策略的可读错误。
 */
import { describe, expect, it, vi } from 'vitest'
import type { MarketDataService } from '@dsh-trading/api'
import { strategyParadigms } from '../src/index.ts'
import { createMemoryCustomStrategyStore } from '../src/custom.ts'
import {
  createStrategyAuthorTool,
  createStrategyBacktestTool,
  resolveStrategyDefinition,
} from '../src/plugin.ts'

const VALID_SOURCE = `(bars) => {
  const out = []
  let long = false
  for (let i = 1; i < bars.length; i++) {
    if (!long && i % 2 === 1) { out.push({ index: i, time: bars[i].openTime, action: 'entry', direction: 'long', price: bars[i].close, reason: 'demo entry' }); long = true }
    else if (long && i % 2 === 0) { out.push({ index: i, time: bars[i].openTime, action: 'exit', direction: 'flat', price: bars[i].close, reason: 'demo exit' }); long = false }
  }
  return out
}`

function fakeService(): MarketDataService {
  return {
    getTicker: async (symbol) => ({ symbol, price: 100, timestamp: 1 }),
    getKlines: async () => Array.from({ length: 60 }, (_, i) => ({
      openTime: 1700000000000 + i * 86_400_000,
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000,
      closeTime: 1700000000000 + (i + 1) * 86_400_000 - 1,
    })),
    subscribeTicker: () => ({ dispose() {} }),
  }
}

async function makeDeps() {
  const store = createMemoryCustomStrategyStore()
  const author = createStrategyAuthorTool({ store })
  await author.execute({
    id: 'demo-alternating',
    title: '演示交替策略',
    horizon: 'swing',
    summary: '演示用',
    computeSource: VALID_SOURCE,
  })
  return { store }
}

describe('strategy_author', () => {
  it('合法提交 → 落盘 + onWritten 回调 + 成功文案', async () => {
    const store = createMemoryCustomStrategyStore()
    const onWritten = vi.fn()
    const tool = createStrategyAuthorTool({ store, onWritten })
    const result = await tool.execute({
      id: 'demo-alternating',
      title: '演示交替策略',
      horizon: 'swing',
      summary: '演示用',
      computeSource: VALID_SOURCE,
    })
    expect(String(result)).toContain('Successfully authored')
    expect(onWritten).toHaveBeenCalledTimes(1)
    expect(await store.get('demo-alternating')).toMatchObject({ id: 'demo-alternating', horizon: 'swing' })
  })

  it('非法提交（范式保留 id）→ 结构化失败文案，不落盘不回调', async () => {
    const store = createMemoryCustomStrategyStore()
    const onWritten = vi.fn()
    const tool = createStrategyAuthorTool({ store, onWritten })
    const result = await tool.execute({
      id: 'ema-crossover',
      title: '撞名',
      horizon: 'short',
      summary: 'x',
      computeSource: VALID_SOURCE,
    })
    expect(String(result)).toContain('Validation failed')
    expect(onWritten).not.toHaveBeenCalled()
    expect(await store.get('ema-crossover')).toBeUndefined()
  })
})

describe('strategy_backtest', () => {
  it('自定义策略回测 → 8 指标 + 交易流水 + 净值曲线', async () => {
    const { store } = await makeDeps()
    const tool = createStrategyBacktestTool({ store, marketData: () => fakeService() })
    const result = JSON.parse(String(await tool.execute({
      strategyId: 'demo-alternating', market: 'crypto', symbol: 'BTCUSDT', interval: '1d', limit: 60,
    }))) as { ok: boolean; metrics: Record<string, number>; trades: unknown[]; equity: unknown[]; barsTested: number }
    expect(result.ok).toBe(true)
    expect(result.barsTested).toBe(60)
    expect(Object.keys(result.metrics).sort()).toEqual([
      'cagr', 'exposure', 'maxDrawdown', 'profitFactor', 'sharpe', 'totalReturn', 'tradeCount', 'winRate',
    ])
    expect(result.trades.length).toBeGreaterThan(0)
    expect(result.equity.length).toBe(60)
  })

  it('范式 id 也可直接回测（策略 ∪ 范式解析）', async () => {
    const { store } = await makeDeps()
    const tool = createStrategyBacktestTool({ store, marketData: () => fakeService() })
    const result = JSON.parse(String(await tool.execute({
      strategyId: strategyParadigms[0]!.id, market: 'us', symbol: 'AAPL', interval: '1d', limit: 120,
    }))) as { ok: boolean; strategy: { id: string } }
    expect(result.ok).toBe(true)
    expect(result.strategy.id).toBe(strategyParadigms[0]!.id)
  })

  it('未知策略 → 错误提示 author 先行或改用范式 id', async () => {
    const { store } = await makeDeps()
    const tool = createStrategyBacktestTool({ store, marketData: () => fakeService() })
    await expect(tool.execute({ strategyId: 'nope', market: 'us', symbol: 'AAPL' }))
      .rejects.toThrow(/strategy_author/)
  })

  it('行情缺席 / 空 K 线 → 可读错误', async () => {
    const { store } = await makeDeps()
    const absent = createStrategyBacktestTool({ store, marketData: () => undefined })
    await expect(absent.execute({ strategyId: 'demo-alternating', market: 'cn', symbol: '600519.SH' }))
      .rejects.toThrow(/no market data service/)

    const empty = createStrategyBacktestTool({
      store,
      marketData: () => ({ ...fakeService(), getKlines: async () => [] }),
    })
    await expect(empty.execute({ strategyId: 'demo-alternating', market: 'us', symbol: 'AAPL' }))
      .rejects.toThrow(/no klines returned/)
  })
})

describe('resolveStrategyDefinition', () => {
  it('自定义优先；范式回退；双缺失 undefined', async () => {
    const { store } = await makeDeps()
    const custom = await resolveStrategyDefinition(store, 'demo-alternating')
    expect(custom).toMatchObject({ id: 'demo-alternating', horizon: 'swing' })

    const paradigm = await resolveStrategyDefinition(store, 'ema-crossover')
    expect(paradigm).toMatchObject({ id: 'ema-crossover' })
    expect(typeof paradigm?.compute).toBe('function')

    expect(await resolveStrategyDefinition(store, 'nope')).toBeUndefined()
  })
})
