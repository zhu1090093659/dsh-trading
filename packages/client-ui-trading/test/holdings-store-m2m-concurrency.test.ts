/**
 * 台账批量盯市的分块并发（用户可见路径：打开资产面板时的价格刷新）。
 *
 * 覆盖：
 *   - 同一市场内多块并行发出（原实现逐块串行 await）；
 *   - 在途块数受上限约束（不向桥突发）；
 *   - 单块失败不拖垮整批，其余块价格照常落表；
 *   - 空目标集清空价格表且不发请求。
 *
 * 无 mock/无 sleep：fetch 用真实 Response 桩，并发用 setImmediate 让出观察。
 */
import { describe, expect, it } from 'vitest'
import { holdingsDataStore, refreshM2mPrices } from '../src/client/holdings-store.ts'

/** 桥单次批量报价封顶（镜像 holdings-store.ts 的 TICKERS_CHUNK）。 */
const CHUNK = 32
/** 单市场分块并发上限（镜像 holdings-store.ts 的 TICKERS_MARKET_CONCURRENCY）。 */
const MARKET_CONCURRENCY = 4
const MARKETS = ['crypto', 'us', 'cn', 'hk'] as const

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 让出若干轮，使同一批并行发出的 fetch 都能进入桩内（不依赖任何计时器）。 */
async function letSiblingsEnter(rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
}

/** 目标键：单市场 count 个标的；market 省略时为四市场各 count 个。 */
function targetsKey(count: number, market?: string): string {
  const markets = market === undefined ? MARKETS : [market]
  const keys: string[] = []
  for (const m of markets) {
    // 零填充：目标键按字典序拼接后，同一市场的相邻下标仍落在同一块内
    for (let i = 0; i < count; i += 1) keys.push(`${m}:SYM${String(i).padStart(3, '0')}`)
  }
  return [...keys].sort().join(',')
}

interface StubObservation { peak: number; requests: number }

/** 真实 Response 桩：统计同时在途的请求数（峰值即实际块并发度）。 */
function stubTickers(options: { failChunkContaining?: string; failMarket?: string } = {}): StubObservation {
  const observation: StubObservation = { peak: 0, requests: 0 }
  let inFlight = 0
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost')
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean)
    observation.requests += 1
    inFlight += 1
    if (inFlight > observation.peak) observation.peak = inFlight
    await letSiblingsEnter()
    inFlight -= 1
    const market = url.searchParams.get('market') ?? ''
    if (
      options.failChunkContaining !== undefined
      && symbols.includes(options.failChunkContaining)
      && (options.failMarket === undefined || options.failMarket === market)
    ) {
      // 非 2xx：桥的协议层拒绝；单块失败不拖垮整批
      return new Response('boom', { status: 500 })
    }
    const tickers: Record<string, unknown> = {}
    for (const symbol of symbols) tickers[symbol] = { ok: true, ticker: { symbol, price: 12 } }
    return jsonResponse({ tickers })
  }) as unknown as typeof globalThis.fetch
  return observation
}

describe('用户打开资产面板时的批量盯市分块并发', () => {
  it('用户单个市场持仓跨多块时，分块并行发出（串行实现下峰值恒为 1）', async () => {
    // Given：单市场 96 个标的 = 3 块
    const observation = stubTickers()

    // When：一次盯市刷新
    await refreshM2mPrices(targetsKey(96, 'crypto'))

    // Then：3 块并发在途（优化前同一市场内逐块 await，峰值只能是 1）
    expect(observation.requests).toBe(96 / CHUNK)
    expect(observation.peak).toBe(96 / CHUNK)
  })

  it('用户单市场持仓远超上限时，在途块数仍被上限约束（不向桥突发）', async () => {
    // Given：单市场 288 个标的 = 9 块，上限 4
    const observation = stubTickers()

    // When：一次盯市刷新
    await refreshM2mPrices(targetsKey(288, 'crypto'))

    // Then：并行但不超过上限，且确实并行
    expect(observation.requests).toBe(288 / CHUNK)
    expect(observation.peak).toBe(MARKET_CONCURRENCY)
  })

  it('用户盯市时某一块被上游拒绝，其余块的价格照常落表且整体不抛错', async () => {
    // Given：crypto 的第一块（含 SYM0）会被拒绝；四市场各 96 个标的
    stubTickers({ failChunkContaining: 'SYM000', failMarket: 'crypto' })

    // When：一次盯市刷新（不抛错即通过）
    await refreshM2mPrices(targetsKey(96))

    // Then：只有失败块（32 个 crypto 键）缺席，其余 352 个键全部落表
    const prices = holdingsDataStore.getSnapshot().prices
    expect(Object.keys(prices)).toHaveLength(MARKETS.length * 96 - CHUNK)
    expect(prices['crypto:SYM000']).toBeUndefined()
    expect(prices['crypto:SYM031']).toBeUndefined()
    expect(prices['crypto:SYM032']).toBe(12)
    expect(prices['us:SYM000']).toBe(12)
    expect(prices['hk:SYM095']).toBe(12)
  })

  it('用户清空盯市目标时，价格表被清空且不发任何请求', async () => {
    // Given：上一拍留下的价格表
    const observation = stubTickers()
    await refreshM2mPrices(targetsKey(1, 'crypto'))
    expect(Object.keys(holdingsDataStore.getSnapshot().prices)).toHaveLength(1)

    // When：目标集为空
    const requestsBefore = observation.requests
    await refreshM2mPrices('')

    // Then：价格表清空、零新增请求
    expect(holdingsDataStore.getSnapshot().prices).toEqual({})
    expect(observation.requests).toBe(requestsBefore)
  })
})
