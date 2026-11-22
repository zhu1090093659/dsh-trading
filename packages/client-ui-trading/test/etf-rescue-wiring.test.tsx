/**
 * 「ETF 托底」副图的客户端接线（2026-11-22）：两条冻结 aux 键
 * （cn-etf-rescue-depth 深度 / cn-etf-rescue-breadth 广度）从**同一次**宿主应答取数，
 * 接到图表副图，并在缺数据时按既有 aux 语义整体不出 pane。
 *
 * 为什么两种环境手法并存：取数缝与就绪判定是纯逻辑（真实预置 definition + 真实调度），
 * 而「一次刷新只发一次请求」是 hook 的批次行为——用真实 renderHook 打在真实 HTTP 上游上
 * （本仓禁用通用 mock 工具：替换的是 fetch 的目标地址，不是行为）。
 *
 * @vitest-environment jsdom
 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { createIndicatorRegistry, presetDefinitions } from '@dshtrading/indicators'
import type { EtfRescueHistory } from '@dshtrading/api'
import type { IndicatorDefinition, IndicatorInstance, Kline } from '@dshtrading/indicators'
import { QuoteStage } from '../src/client/QuoteStage.tsx'
import { indicators } from '../src/client/indicator-registry.ts'
import { useAuxSeries } from '../src/client/useAuxSeries.ts'
import { dispatchIndicatorGroups } from '../src/client/indicator-dispatch.ts'
import {
  CN_ETF_RESCUE_BREADTH_KEY,
  CN_ETF_RESCUE_DEPTH_KEY,
  auxEmptyNoticeKey,
  auxSeriesReady,
  etfRescueToAuxPoints,
  requiredAuxKeys,
} from '../src/client/aux-series.ts'
import { fetchEtfRescue } from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'
import type { ChartState } from '../src/client/chart-state.ts'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import type { SelectionState } from '../src/client/store.ts'

const DAY = 86_400_000
const ETF_RESCUE_ID = 'cn-etf-rescue'
const SYMBOL = '510300.SH'

/** 两条冻结键就是预置 definition 声明的 aux（顺序无关，按集合断言）。 */
const FROZEN_KEYS = [CN_ETF_RESCUE_DEPTH_KEY, CN_ETF_RESCUE_BREADTH_KEY]

/** 真实注册表 + 真实预置名册（参数 clamp 与实例 key 都走生产实现）。 */
const registry = createIndicatorRegistry()
for (const definition of presetDefinitions()) registry.register(definition)

const deps = {
  getDefinition: (id: string): IndicatorDefinition | undefined => registry.get(id),
  clampParams: (definition: IndicatorDefinition, params: Record<string, number>): Record<string, number> => registry.clampParams(definition, params),
  instanceKey: (instance: IndicatorInstance): string => registry.instanceKey(instance),
}

/** 三个连续交易日（2026-10-05/06/07）。 */
function dailyBars(): Kline[] {
  return [0, 1, 2].map(offset => {
    const openTime = Date.UTC(2026, 9, 5 + offset)
    return { openTime, closeTime: openTime + DAY - 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100 }
  })
}

/** 桥上应答形状（口径见 api 契约：date/depthPct/breadthPct）。 */
function historyOf(symbol = SYMBOL): EtfRescueHistory {
  return {
    symbol,
    indexCode: '000300',
    depthLabel: '沪深300ETF',
    points: [
      { date: Date.UTC(2026, 9, 5), depthPct: 0.83, breadthPct: 1.13 },
      { date: Date.UTC(2026, 9, 6), depthPct: 0.86, breadthPct: 1.2 },
    ],
  }
}

let server: Server
let baseUrl = ''
/** 收到的请求路径清单（断言客户端确实按需请求了宿主序列、且只请求一次）。 */
let requests: string[] = []
/** 桥上应答：可切换成业务拒绝 / HTTP 失败。 */
let downstream: 'history' | 'rejected' | 'error' = 'history'
/** 真实 fetch 引用（在替换 globalThis.fetch 之前抓住，否则替换品会调用自己）。 */
const realFetch = globalThis.fetch

beforeEach(async () => {
  requests = []
  downstream = 'history'
  for (const definition of presetDefinitions()) indicators.register(definition)
  server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.setHeader('content-type', 'application/json')
    if (req.url?.includes('/etf-rescue') !== true) {
      // 其它端点本轮失败：K 线停在 null，TvChart 不挂载（jsdom 无 canvas），
      // 本用例只验接线、去重与就绪判定。
      res.statusCode = 500
      res.end('{}')
      return
    }
    if (downstream === 'error') {
      res.statusCode = 500
      res.end('{}')
      return
    }
    if (downstream === 'rejected') {
      res.end(JSON.stringify({ ok: false, code: 'TRADING_NOT_IMPLEMENTED', message: 'etfRescue: no provider implements getEtfRescue for cn' }))
      return
    }
    res.end(JSON.stringify({ ok: true, etfRescue: historyOf() }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
  const upstream = realFetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input).replace('/dshtrading/api', '') || '/'
    return upstream(baseUrl + (target.startsWith('/') ? target : `/${target}`), init)
  }) as typeof globalThis.fetch
})

afterEach(async () => {
  cleanup()
  globalThis.fetch = realFetch
  // 关掉 keep-alive 连接：否则 server.close() 要等 undici 的空闲 socket 超时（数秒）。
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** key 直出翻译（断言用 key 而非文案，与词典解耦）。 */
const t = (key: MarketLocaleKey): string => key

/** QuoteStage 的最小装配：真实 selection/chart 快照 + 记录适用范围写入。 */
function quoteStageProps(market: 'cn' | 'hk' | 'us', symbol: string, instances: ChartState['instances']) {
  const selection: SelectionState = { instrument: { market, symbol } }
  const chart: ChartState = { instances }
  return {
    props: {
      t,
      useSelection: <T,>(sel: (state: SelectionState) => T): T => sel(selection),
      useChart: <T,>(sel: (state: ChartState) => T): T => sel(chart),
      toggleIndicator: () => {},
      setIndicatorParams: () => {},
      setIndicatorVisible: () => {},
      setIndicatorScope: () => {},
      removeIndicator: () => {},
      deleteIndicator: async () => true,
    },
  }
}

const noHoldings = async () => undefined
const noActiveBuy = async () => undefined
const etfRequests = (): string[] => requests.filter(url => url.includes('/etf-rescue'))

describe('ETF托底客户端接线', () => {
  it('用户取到 ETF 托底历史时，深度与广度两条键从同一次应答里各取自己的口径', async () => {
    // Given 真实 HTTP 桥回冻结信封（一条历史里带 depthPct 与 breadthPct）
    // When 客户端按 A 股标的取数并拆成两条外部序列
    const history = await fetchEtfRescue('cn', SYMBOL)

    // Then 请求打在冻结路径上，两条序列分别取 depthPct / breadthPct（不是同一个数）
    // fetch 缝把 /dshtrading/api 前缀剥成上游路径，故这里断言宿主侧收到的路径与参数
    expect(etfRequests()).toEqual([`/etf-rescue?market=cn&symbol=${SYMBOL}`])
    expect(history).toEqual(historyOf())
    expect(etfRescueToAuxPoints(history, CN_ETF_RESCUE_DEPTH_KEY)).toEqual([
      { date: Date.UTC(2026, 9, 5), value: 0.83 },
      { date: Date.UTC(2026, 9, 6), value: 0.86 },
    ])
    expect(etfRescueToAuxPoints(history, CN_ETF_RESCUE_BREADTH_KEY)).toEqual([
      { date: Date.UTC(2026, 9, 5), value: 1.13 },
      { date: Date.UTC(2026, 9, 6), value: 1.2 },
    ])
  })

  it('用户在宿主没有该能力或上游失败时拿到无数据，而不是把异常抛进主图', async () => {
    // Given 桥先回业务拒绝再回 HTTP 失败
    downstream = 'rejected'
    const rejected = await fetchEtfRescue('cn', SYMBOL)
    downstream = 'error'
    const broken = await fetchEtfRescue('cn', SYMBOL)

    // Then 两次都是 undefined（副图整体隐藏），且拆序列也是 undefined（空 ≠ 0）
    expect([rejected, broken]).toEqual([undefined, undefined])
    expect(etfRescueToAuxPoints(rejected, CN_ETF_RESCUE_DEPTH_KEY)).toBeUndefined()
    expect(etfRescueToAuxPoints(undefined, CN_ETF_RESCUE_BREADTH_KEY)).toBeUndefined()
  })

  it('用户挂载 ETF 托底时，一次图表刷新对两条键只发一次请求且两条序列都非空', async () => {
    // Given 同一个实例声明了深度与广度两条键
    // When 真实 hook 按这两条键加载
    const { result } = renderHook(() => useAuxSeries('cn', SYMBOL, FROZEN_KEYS, noHoldings, noActiveBuy, fetchEtfRescue))

    // Then 宿主只被请求一次（请求级 memo 去重），两条键各自就绪，且都不标盘中
    await waitFor(() => expect(result.current.series[CN_ETF_RESCUE_BREADTH_KEY]?.length).toBe(2))
    expect(etfRequests()).toHaveLength(1)
    expect(result.current.series[CN_ETF_RESCUE_DEPTH_KEY]).toEqual([
      { date: Date.UTC(2026, 9, 5), value: 0.83 },
      { date: Date.UTC(2026, 9, 6), value: 0.86 },
    ])
    expect(result.current.series[CN_ETF_RESCUE_BREADTH_KEY]).toEqual([
      { date: Date.UTC(2026, 9, 5), value: 1.13 },
      { date: Date.UTC(2026, 9, 6), value: 1.2 },
    ])
    expect(result.current.liveKeys).toEqual([])
  })

  it('用户换标的后在途的旧应答不能覆盖新标的序列', async () => {
    // Given 第一条请求被挂在途（真实注入的取数函数，不 mock 行为）
    let release: (value: EtfRescueHistory) => void = () => { throw new Error('request not started') }
    let first = true
    const fetcher = async (_market: string, symbol: string): Promise<EtfRescueHistory> => {
      if (first) {
        first = false
        return await new Promise<EtfRescueHistory>(resolve => { release = resolve })
      }
      return { ...historyOf(symbol), points: [{ date: Date.UTC(2026, 9, 6), depthPct: 3.5, breadthPct: 4.5 }] }
    }
    const { result, rerender } = renderHook(
      ({ symbol }) => useAuxSeries('cn', symbol, FROZEN_KEYS, noHoldings, noActiveBuy, fetcher),
      { initialProps: { symbol: SYMBOL } },
    )

    // When 切到另一个标的并等它落定，最后才释放旧标的的应答
    rerender({ symbol: '159915.SZ' })
    await waitFor(() => expect(result.current.series[CN_ETF_RESCUE_DEPTH_KEY]).toEqual([{ date: Date.UTC(2026, 9, 6), value: 3.5 }]))
    await act(async () => { release(historyOf(SYMBOL)) })

    // Then 新标的的值留在图上，旧应答被丢弃，request 已指向新标的
    expect(result.current.series[CN_ETF_RESCUE_DEPTH_KEY]).toEqual([{ date: Date.UTC(2026, 9, 6), value: 3.5 }])
    expect(result.current.series[CN_ETF_RESCUE_BREADTH_KEY]).toEqual([{ date: Date.UTC(2026, 9, 6), value: 4.5 }])
    expect(result.current.request).toBe('cn:159915.SZ')
  })

  it('用户的两条序列齐备时，副图出渗透与非300渗透两条百分比线', () => {
    // Given 预置定义声明的两条键都有非空序列（前两个交易日有值）
    const definition = registry.get(ETF_RESCUE_ID)
    if (definition === undefined) throw new Error('preset cn-etf-rescue missing')
    const aux = {
      [CN_ETF_RESCUE_DEPTH_KEY]: etfRescueToAuxPoints(historyOf(), CN_ETF_RESCUE_DEPTH_KEY) ?? [],
      [CN_ETF_RESCUE_BREADTH_KEY]: etfRescueToAuxPoints(historyOf(), CN_ETF_RESCUE_BREADTH_KEY) ?? [],
    }

    // When 调度渲染组
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [{ id: ETF_RESCUE_ID, params: {} }], market: 'cn', symbol: SYMBOL, aux, deps,
    })

    // Then 一个副图组、两条 line：图例名/配色/两位小数与冻结契约逐项一致，值按交易日对齐
    expect(groups).toHaveLength(1)
    expect(groups[0]?.pane).toBe('sub')
    expect(groups[0]?.title).toBe('ETF托底')
    expect(groups[0]?.outputs).toEqual([
      { key: 'ETF渗透%', kind: 'line', color: '#e64545', values: [0.83, 0.86, undefined], precision: 2 },
      { key: '非300渗透%', kind: 'line', color: '#3b82f6', values: [1.13, 1.2, undefined], precision: 2 },
    ])
  })

  it('用户只拿到一条序列时，副图整体不出现（不画半块，也不画零线）', () => {
    // Given 只有深度序列有数据（广度取数缺失）
    const definition = registry.get(ETF_RESCUE_ID)
    if (definition === undefined) throw new Error('preset cn-etf-rescue missing')
    const partial = { [CN_ETF_RESCUE_DEPTH_KEY]: [{ date: Date.UTC(2026, 9, 5), value: 0.83 }] }

    // When 判定就绪并调度
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [{ id: ETF_RESCUE_ID, params: {} }], market: 'cn', symbol: SYMBOL, aux: partial, deps,
    })

    // Then 该 definition 未就绪，且调度不产出任何组（副图 pane 不存在）
    expect(auxSeriesReady(definition, partial)).toBe(false)
    expect(groups).toEqual([])
  })

  it('用户两条序列都缺时，副图 pane 只出空态理由，绝不落成零线', () => {
    // Given 桥上没有任何可用数据（能力缺席/上游失败/该标的无记录）
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [{ id: ETF_RESCUE_ID, params: {} }], market: 'cn', symbol: SYMBOL, aux: {}, deps,
    })

    // Then 占位组：零输出、带键位（文案按首个声明键归属），没有伪造的 0 值
    expect(groups).toHaveLength(1)
    expect(groups[0]?.outputs).toEqual([])
    expect(groups[0]?.auxEmptyKey).toBe(CN_ETF_RESCUE_DEPTH_KEY)
  })

  it('用户的 ETF 托底只挂在 A 股：定义白名单与需取数的键在其它市场为零', () => {
    // Given 真实预置 definition
    const definition = registry.get(ETF_RESCUE_ID)
    if (definition === undefined) throw new Error('preset cn-etf-rescue missing')
    const instances: IndicatorInstance[] = [{ id: ETF_RESCUE_ID, params: {} }]

    // When 分别按 cn 与非 cn 收集键
    // Then 声明的是两条冻结键，只有 A 股需要取数（切市场不产生多余上游请求）
    expect([...(definition.aux ?? [])].sort()).toEqual([...FROZEN_KEYS].sort())
    expect(definition.markets).toEqual(['cn'])
    expect(requiredAuxKeys(instances, 'cn', id => registry.get(id))).toEqual(FROZEN_KEYS)
    expect(requiredAuxKeys(instances, 'us', id => registry.get(id))).toEqual([])
  })

  it('用户看到的空态理由按键位区分：深度与广度各有一条中英文文案', () => {
    // Given 两条冻结键与一个未登记的键
    // When 取各自的文案键位与词典原文
    const keys = [auxEmptyNoticeKey(CN_ETF_RESCUE_DEPTH_KEY), auxEmptyNoticeKey(CN_ETF_RESCUE_BREADTH_KEY)]

    // Then 两条键位互不相同、都不回落通用文案，且中英词典都各有对应文案
    expect(keys).toEqual(['indicator.auxEmpty.cnEtfRescueDepth', 'indicator.auxEmpty.cnEtfRescueBreadth'])
    for (const key of keys) {
      expect(zh[key as MarketLocaleKey]).not.toBe('')
      expect(en[key as MarketLocaleKey]).not.toBe('')
      expect(zh[key as MarketLocaleKey]).not.toBe(en[key as MarketLocaleKey])
    }
    expect(zh['indicator.auxEmpty.cnEtfRescueDepth']).not.toBe(zh['indicator.auxEmpty.cnEtfRescueBreadth'])
  })

  it('用户在 A 股挂载 ETF 托底时，行情面板按 market/symbol 请求一次该序列', async () => {
    // Given A 股标的 + 已挂载的 ETF托底（真实预置 definition 已注册）
    const { props } = quoteStageProps('cn', SYMBOL, [{ id: ETF_RESCUE_ID, params: {} }])

    // When 挂载行情面板
    render(<QuoteStage {...props} />)

    // Then 宿主桥按同一次刷新收到一次请求（两条键共享，不重复打上游）
    await waitFor(() => expect(etfRequests().length).toBeGreaterThan(0))
    expect(etfRequests()).toEqual([`/etf-rescue?market=cn&symbol=${SYMBOL}`])
  })

  it('用户切到美股时，行情面板不请求 ETF 托底序列', async () => {
    // Given 美股标的（definition 白名单不含美股）
    const { props } = quoteStageProps('us', 'AAPL', [{ id: ETF_RESCUE_ID, params: {} }])

    // When 挂载行情面板
    render(<QuoteStage {...props} />)

    // Then 有其它请求发生，但没有一次打在 ETF 托底端点上
    await waitFor(() => expect(requests.length).toBeGreaterThan(0))
    expect(etfRequests()).toEqual([])
  })
})
