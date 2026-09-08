/**
 * screener_run 扫描调度单测（issue #86 / 缺口卡 G4，离线）：
 * 命中/数据不足/失败计数、扫描池上限、结果截断、参数覆盖、自定义选股器源码执行、
 * 名册缺席与未知 id 的显式失败语义。
 */
import { describe, expect, it } from 'vitest'
import type { MarketDataService } from '@dshtrading/api'
import { createMemoryBuiltinTombstonesStore } from '../src/builtin-tombstones.ts'
import { createMemoryCustomScreenerStore } from '../src/custom-screener.ts'
import { createScreenerRunTool } from '../src/plugin.ts'

function risingBars(count: number): Array<{ openTime: number; open: number; high: number; low: number; close: number; volume: number }> {
  return Array.from({ length: count }, (_, i) => ({
    openTime: 1700000000000 + i * 86_400_000,
    open: 100 + i,
    high: 100 + i,
    low: 100 + i,
    close: 100 + i,
    volume: 1000,
  }))
}

type RunWire = {
  ok: boolean
  code?: string
  provider?: string
  universeSize?: number
  scanPool?: number
  scanned?: number
  failed?: number
  insufficient?: number
  matched?: number
  returned?: number
  truncated?: boolean
  budgetMs?: number
  deadlineExceeded?: boolean
  resultLimit?: number
  params?: { requested: Record<string, number>; effective: Record<string, number> }
  results?: Array<{ symbol: string; name?: string; price: number | null; metrics: Record<string, number>; reason: string }>
}

function service(options: {
  symbols: Array<{ symbol: string; name?: string }>
  bars?: (symbol: string) => Promise<unknown>
  listInstruments?: boolean
}): MarketDataService {
  const base = {
    getTicker: async (symbol: string) => ({ symbol, price: 100, timestamp: 1 }),
    getKlines: async (symbol: string) => (options.bars !== undefined
      ? await options.bars(symbol)
      : risingBars(300)) as never,
    subscribeTicker: () => ({ dispose() {} }),
  }
  if (options.listInstruments === false) return base as unknown as MarketDataService
  return { ...base, listInstruments: async () => options.symbols } as unknown as MarketDataService
}

function makeTool(overrides: Partial<Parameters<typeof createScreenerRunTool>[0]> = {}) {
  return createScreenerRunTool({
    store: createMemoryCustomScreenerStore(),
    active: () => ({ provider: 'fake', service: service({ symbols: [{ symbol: 'AAA', name: '甲公司' }, { symbol: 'BBB' }] }) }),
    ...overrides,
  })
}

describe('screener_run', () => {
  it('命中结果带 metrics/reason/name；扫描池与护栏字段显式回显', async () => {
    const wire = JSON.parse(String(await makeTool().execute({ screenerId: 'scr.near-high', market: 'us' }))) as RunWire
    expect(wire.ok).toBe(true)
    expect(wire.provider).toBe('fake')
    expect(wire.universeSize).toBe(2)
    expect(wire.scanPool).toBe(2)
    expect(wire.scanned).toBe(2)
    expect(wire.failed).toBe(0)
    expect(wire.results).toHaveLength(2)
    expect(wire.results?.[0]).toMatchObject({ symbol: 'AAA', name: '甲公司' })
    expect(wire.results?.[0]?.metrics.offHighPct).toBe(0)
    expect(typeof wire.results?.[0]?.reason).toBe('string')
  })

  it('窗口不足 → insufficient 静默跳过；空 K 线/异常 → failed 计数不中断', async () => {
    const wire = JSON.parse(String(await makeTool({
      active: () => ({
        provider: 'fake',
        service: service({
          symbols: [{ symbol: 'SHORT' }, { symbol: 'EMPTY' }, { symbol: 'BOOM' }],
          bars: async (symbol) => {
            if (symbol === 'SHORT') return risingBars(10)
            if (symbol === 'EMPTY') return []
            throw new Error('upstream down')
          },
        }),
      }),
    }).execute({ screenerId: 'scr.near-high', market: 'us' }))) as RunWire
    expect(wire.ok).toBe(true)
    expect(wire.scanned).toBe(3)
    expect(wire.insufficient).toBe(1)
    expect(wire.failed).toBe(2)
    expect(wire.results).toEqual([])
  })

  it('limit 截断扫描池；结果上限截断并置 truncated', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ symbol: 'S' + i }))
    const capped = JSON.parse(String(await makeTool({
      active: () => ({ provider: 'fake', service: service({ symbols: many }) }),
    }).execute({ screenerId: 'scr.near-high', market: 'us', limit: 3 }))) as RunWire
    expect(capped.scanPool).toBe(3)
    expect(capped.universeSize).toBe(60)

    const truncated = JSON.parse(String(await makeTool({
      active: () => ({ provider: 'fake', service: service({ symbols: many }) }),
    }).execute({ screenerId: 'scr.near-high', market: 'us', limit: 60 }))) as RunWire
    expect(truncated.matched).toBe(60)
    expect(truncated.returned).toBe(50)
    expect(truncated.resultLimit).toBe(50)
    expect(truncated.truncated).toBe(true)
    expect(truncated.results).toHaveLength(50)
  })

  it('paramsJson 覆盖参数并回显 effective（clamp 生效）', async () => {
    const wire = JSON.parse(String(await makeTool().execute({
      screenerId: 'scr.near-high', market: 'us', paramsJson: '{"withinPct":9999}',
    }))) as RunWire
    expect(wire.params?.requested.withinPct).toBe(9999)
    expect(wire.params?.effective.withinPct).toBe(30)
    await expect(makeTool().execute({ screenerId: 'scr.near-high', market: 'us', paramsJson: '{"nope":1}' }))
      .rejects.toThrow(/unknown param "nope"/)
  })

  it('自定义选股器走源码执行（vm 熔断 runner）', async () => {
    const store = createMemoryCustomScreenerStore([{
      id: 'scr.demo-all', title: '全部命中', horizon: 'swing', summary: '演示',
      paramsJson: '[]', columnsJson: '[]',
      evaluateSource: '(bars) => ({ metrics: { n: bars.length }, reason: "always" })',
      createdAt: 1,
    }])
    const wire = JSON.parse(String(await makeTool({ store }).execute({ screenerId: 'scr.demo-all', market: 'us' }))) as RunWire
    expect(wire.results).toHaveLength(2)
    expect(wire.results?.[0]?.metrics.n).toBe(300)
  })


  it('总预算耗尽 → deadlineExceeded=true 且不再领取新标的（注入假时钟，确定性）', async () => {
    let clock = 0
    const tool = createScreenerRunTool({
      store: createMemoryCustomScreenerStore(),
      budgetMs: 1000,
      now: () => clock,
      active: () => ({
        provider: 'fake',
        service: service({
          symbols: Array.from({ length: 10 }, (_, i) => ({ symbol: 'S' + i })),
          bars: async () => { clock = 5000; return risingBars(300) },
        }),
      }),
    })
    const wire = JSON.parse(String(await tool.execute({ screenerId: 'scr.near-high', market: 'us' }))) as RunWire
    expect(wire.ok).toBe(true)
    expect(wire.deadlineExceeded).toBe(true)
    expect(wire.budgetMs).toBe(1000)
    // 首个 worker 领取 1 个标的（此时钟被推过预算），其余 worker 在领取前即退出。
    expect(wire.scanned).toBe(1)
    expect(wire.scanPool).toBe(10)
  })

  it('未知 id / 墓碑删除 / 无名册 / 无服务 → 显式失败，不返回空结果冒充无命中', async () => {
    await expect(makeTool().execute({ screenerId: 'scr.nope', market: 'us' })).rejects.toThrow(/unknown screenerId/)
    await expect(makeTool({ tombstones: createMemoryBuiltinTombstonesStore(['scr.near-high']) })
      .execute({ screenerId: 'scr.near-high', market: 'us' })).rejects.toThrow(/has been deleted by the user/)

    const noUniverse = JSON.parse(String(await makeTool({
      active: () => ({ provider: 'fake', service: service({ symbols: [], listInstruments: false }) }),
    }).execute({ screenerId: 'scr.near-high', market: 'us' }))) as RunWire
    expect(noUniverse).toMatchObject({ ok: false, code: 'TRADING_NO_UNIVERSE' })

    await expect(makeTool({ active: () => undefined }).execute({ screenerId: 'scr.near-high', market: 'us' }))
      .rejects.toThrow(/no market data service/)
  })
})
