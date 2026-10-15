/**
 * 特殊指标 agent 工具面契约测试（五只只读工具）。
 *
 * 零 mock：上游为契约化 fake fetch（真实 Response 对象），FinanceClient 注入 fake
 * 上游与假时钟；时钟推进 = 直接改注入的 counter，不睡不轮询。断言对着**出参 JSON**
 * 与**真实打出的上游 URL**，不碰内部实现。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { fakeHttpRes } from '@dshtrading/test-support'
import { FinanceClient } from '../src/finance-client.ts'
import { INDICATOR_TOOL_NAMES, MOUNT, apply, createSpecialIndicatorTools, type Config, type IndicatorToolConfig } from '../src/index.ts'

const BASE_CONFIG: IndicatorToolConfig = {
  baseUrl: 'https://finance.example.test',
  sentimentMethodology: 3,
  snapshotCacheMs: 60_000,
  historyCacheMs: 300_000,
}

/* --------------------------------- 上游替身 --------------------------------- */

interface UpstreamRoute {
  status?: number
  body?: unknown
}

/** 契约化 fake 上游：按「路径?查询」精确匹配，退化到「仅路径」；记录每次请求 URL。 */
function fakeUpstream(routes: Record<string, UpstreamRoute>) {
  const calls: string[] = []
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input))
    calls.push(url.pathname + url.search)
    const route = routes[url.pathname + url.search] ?? routes[url.pathname] ?? { status: 404, body: { error: 'unexpected upstream path' } }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { impl: impl as typeof globalThis.fetch, calls }
}

/* --------------------------------- 载荷夹具 --------------------------------- */

const basisSnapshot = {
  ready: true,
  products: [
    { key: 'IF', name: '沪深300', last_spot: 4166.19, last_fut: 4085.9, last_dt: '2026-10-15 14:59:59' },
    { key: 'IM', name: '中证1000', last_spot: 6201.5, last_fut: 6058.6, last_dt: '2026-10-15 14:59:58' },
  ],
  stats: { IF: { min: 56.07, max: 84.1, mean: 72.96, last: 80.29, pct: 1.927, p25: 69.41, p75: 76.29, n: 240 } },
}

const sentimentSnapshot = {
  market: 'cn',
  score: 26.29,
  label: 'fear',
  label_text: '恐惧',
  date: '2026-10-14',
  expected_data_date: '2026-10-14',
  stale: false,
  missing_components: [],
  average_5d: 28.3,
  vs_5d: -2.01,
  components: Array.from({ length: 8 }, (_unused, index) => ({ key: 'slot' + index, name: '槽' + index, score: 20 + index })),
  coverage: { valid: 8, total: 8, partial: false },
  methodology_version: 3,
  source_version: '4668dee745fb5ba8',
}

const sentimentHistory = {
  market: 'cn',
  methodology_version: 3,
  formula_version: 'margin-streak-added-to-v2-v3',
  expected_data_date: '2026-10-14',
  source_version: '4668dee745fb5ba8',
  overlay_name: '中证全指',
  series: [
    { date: '2026-10-13', score: 28.9, label: 'fear', label_text: '恐惧', valid_components: 8, total_components: 8 },
    { date: '2026-10-14', score: 26.29, label: 'fear', label_text: '恐惧', valid_components: 8, total_components: 8 },
  ],
}

const hkShortSnapshot = {
  last_update: '2026-10-15 17:22',
  data_date: '2026-10-15',
  index_data_date: '2026-10-15',
  short_data_date: '2026-10-15',
  data_version: 'd3e8c35a736b41f2',
  updating: false,
  ready: true,
  n_days: 98,
  n_stocks: 10,
  top10: [
    { code: '00700', name: '腾讯', weight: 8.0 },
    { code: '09988', name: '阿里巴巴', weight: 7.5 },
  ],
  five_day: { current_pct: 22.988, average_pct: 22.589, pct_difference: 0.399, current_value: 63.593, average_value: 56.759, value_difference: 6.834, index_5d_pct: -0.3 },
}

const hkShortChart = {
  ratio_stats: { current_pct: 22.988, history_days: 98, avg_5d_pct: 22.589 },
  data_version: 'd3e8c35a736b41f2',
  stale: false,
  top10: [
    { code: '00700', name: '腾讯', weight: 8.0, latest_pct: 11.661, vs_5d_pct: 1.547, history_days: 97, latest_value: 10.09 },
    { code: '09988', name: '阿里巴巴', weight: 7.5, latest_pct: 13.402, vs_5d_pct: -0.8, history_days: 95, latest_value: 12.5 },
  ],
}

const sectorsSnapshot = {
  sectors: [
    { code: '801737', name: '电池', type: 'sw' },
    { code: '801095', name: '汽车', type: 'sw' },
  ],
  last_update: '2026-10-15 08:54',
  data_date: '2026-10-14',
  expected_data_date: '2026-10-14',
  index_data_date: '2026-10-14',
  data_version: 'fc8cebdf30e408df',
  updating: false,
  n_ready: 18,
  n_total: 18,
  missing_margin: [],
  stale_sectors: [],
  five_day: { current_change: -26.69, average_change: -15.5, difference: -11.19, total_flow: -77.51, unit: '亿元' },
}

const sectorsRanking = [
  { code: '801095', name: '汽车', type: 'sw', chg_pct: 0.02, latest_margin: 260.63, latest_close: 13130.55, daily_change: 0.31, avg_5d_change: 0.54, vs_5d_change: -0.23, total_5d_flow: 2.72, index_5d_pct: -2.42 },
  { code: '801737', name: '电池', type: 'sw', chg_pct: -1.4, latest_margin: 846.6, latest_close: 20159.71, daily_change: -1.1, avg_5d_change: -0.9, vs_5d_change: -0.5, total_5d_flow: -12.3, index_5d_pct: -3.1 },
]

const sectorDetail = {
  code: '801737',
  name: '电池',
  type: 'sw',
  schema_version: 2,
  stale: false,
  index: [{ date: '2026-10-13', close: 20100.2 }, { date: '2026-10-14', close: 20159.71 }],
  margin: [{ date: '2026-10-13', rzye: 84_659_633_806 }, { date: '2026-10-14', rzye: 84_812_345_678 }],
}

/** 全绿上游：五只工具的默认夹具（单测按需覆盖单条路由）。 */
const ALL_ROUTES: Record<string, UpstreamRoute> = {
  '/api/snapshot': { body: basisSnapshot },
  '/api/sentiment/snapshot?market=cn&methodology=3': { body: sentimentSnapshot },
  '/api/sentiment/history': { body: sentimentHistory },
  '/api/hk-short/snapshot': { body: hkShortSnapshot },
  '/api/hk-short/chart': { body: hkShortChart },
  '/api/sectors/snapshot': { body: sectorsSnapshot },
  '/api/sectors/ranking': { body: sectorsRanking },
  '/api/v2/sectors/801737': { body: sectorDetail },
}

function makeHarness(overrides: { routes?: Record<string, UpstreamRoute>; password?: string } = {}) {
  const upstream = fakeUpstream(overrides.routes ?? ALL_ROUTES)
  let clock = 1_000_000
  const client = new FinanceClient({
    baseUrl: BASE_CONFIG.baseUrl,
    username: () => 'api',
    password: () => overrides.password ?? 'secret',
    fetchImpl: upstream.impl,
    now: () => clock,
  })
  const tools = createSpecialIndicatorTools(client, BASE_CONFIG)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return {
    upstream,
    tools,
    advance: (ms: number) => { clock += ms },
    /** 跑一只工具并把出参 JSON 解析回来（execute 的 canonical 值是字符串）。 */
    async run(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const tool = byName.get(name)
      if (tool === undefined) throw new Error('未注册的工具：' + name)
      const text = await tool.execute(args, {} as never) as string
      return JSON.parse(text) as Record<string, unknown>
    },
  }
}

function group(result: Record<string, unknown>, name: string): Record<string, unknown> {
  const groups = result.groups as Record<string, Record<string, unknown>> | undefined
  const value = groups?.[name]
  if (value === undefined) throw new Error('出参缺组：' + name)
  return value
}

/* ---------------------------------- 用例 ---------------------------------- */

describe('特殊指标工具面注册面', () => {
  it('用户加载插件时拿到五只只读工具，名字与清单一致', () => {
    // Given: 一个共用的 FinanceClient 与工具面配置
    const { tools } = makeHarness()
    // When: 工厂产出工具集合
    const names = tools.map((tool: ToolDefinition) => tool.name)
    // Then: 名字集合与冻结清单逐字一致，且都在 special_indicators_ 前缀下
    expect(names).toEqual([...INDICATOR_TOOL_NAMES])
    expect(names.every((name) => name.startsWith('special_indicators_'))).toBe(true)
  })
})

describe('special_indicators_get_snapshot', () => {
  it('用户不指定分组时读到四组快照，出参带 as_of/stale/source', async () => {
    // Given: 四组上游都快照就绪
    const harness = makeHarness()
    // When: 不带 group 调用工具
    const result = await harness.run('special_indicators_get_snapshot')
    // Then: 四组都在，各自关键字段来自上游，信封字段齐备
    expect(Object.keys(result.groups as Record<string, unknown>)).toEqual(['basis', 'sentiment', 'hk_short', 'sectors'])
    expect(result.groups_read).toEqual(['basis', 'sentiment', 'hk_short', 'sectors'])
    expect((group(result, 'basis').stats as Record<string, Record<string, number>>).IF.last).toBe(80.29)
    expect(group(result, 'sentiment').score).toBe(26.29)
    expect(group(result, 'sentiment').components_count).toBe(8)
    expect(group(result, 'hk_short').data_date).toBe('2026-10-15')
    expect(group(result, 'hk_short').five_day).toEqual(hkShortSnapshot.five_day)
    expect(group(result, 'sectors').n_ready).toBe(18)
    expect(group(result, 'sectors').five_day).toEqual(sectorsSnapshot.five_day)
    expect(typeof result.as_of).toBe('string')
    expect(new Date(result.as_of as string).toISOString()).toBe(result.as_of)
    expect(result.stale).toBe(false)
    expect(result.cache_stale).toBe(false)
    expect(String(result.source)).toContain('/api/snapshot')
    expect(harness.upstream.calls).toHaveLength(4)
  })

  it('用户只读一组时只打该组的上游路径', async () => {
    // Given: 四组路由都在
    const harness = makeHarness()
    // When: 指定 group=sentiment
    const result = await harness.run('special_indicators_get_snapshot', { group: 'sentiment' })
    // Then: 只有一组出参，且只打了一次上游（方法学版本来自配置）
    expect(Object.keys(result.groups as Record<string, unknown>)).toEqual(['sentiment'])
    expect(harness.upstream.calls).toEqual(['/api/sentiment/snapshot?market=cn&methodology=3'])
  })

  it('用户读基差快照时上游没有数据日，expected_data_date 标注为派生来源', async () => {
    // Given: 基差快照只有产品日内行情时间 last_dt
    const harness = makeHarness()
    // When: 读 basis 组
    const result = await harness.run('special_indicators_get_snapshot', { group: 'basis' })
    // Then: 日期取各产品 last_dt 最大日，并写明是推出来的而非上游声明
    const basis = group(result, 'basis')
    expect(basis.expected_data_date).toBe('2026-10-15')
    expect(String(basis.expected_data_date_source)).toContain('derived')
    expect(String(basis.expected_data_date_source)).toContain('last_dt')
    expect(basis.stale).toBe(false)
    expect(String(basis.stale_source)).toContain('no upstream stale/date signal')
  })

  it('用户读基差快照而产品没有行情时间时省略 expected_data_date 并留说明', async () => {
    // Given: 上游 products 缺 last_dt，推不出日期
    const harness = makeHarness({ routes: { ...ALL_ROUTES, '/api/snapshot': { body: { ready: true, products: [{ key: 'IF' }], stats: {} } } } })
    // When: 读 basis 组
    const result = await harness.run('special_indicators_get_snapshot', { group: 'basis' })
    // Then: 字段省略（不编造），note 说明原因
    const basis = group(result, 'basis')
    expect('expected_data_date' in basis).toBe(false)
    expect(JSON.stringify(result.notes)).toContain('expected_data_date 已省略')
  })

  it('用户请求越界分组时工具在参数校验阶段拒绝且不发请求', async () => {
    // Given: 一个正常上游
    const harness = makeHarness()
    // When: group 传了枚举外的值
    const error = await harness.run('special_indicators_get_snapshot', { group: 'volatility' }).catch((e: unknown) => e)
    // Then: 参数校验直接拒绝（工具体未执行），零上游调用
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).toContain('group')
    expect(String((error as Error).message)).toContain('must be one of')
    expect(harness.upstream.calls).toHaveLength(0)
  })
})

describe('special_indicators_get_sentiment_history', () => {
  it('用户读恐慌指数历史时拿到序列首尾与最新一条，版本字段原样透传', async () => {
    // Given: 上游历史两条已评分点
    const harness = makeHarness()
    // When: 用默认窗口读历史
    const result = await harness.run('special_indicators_get_sentiment_history')
    // Then: 条数/首尾日/最新元素/版本与上游一致，默认 days=750 进 URL
    expect(result.methodology_version).toBe(3)
    expect(result.formula_version).toBe('margin-streak-added-to-v2-v3')
    expect(result.source_version).toBe('4668dee745fb5ba8')
    expect(result.points).toBe(2)
    expect(result.first_date).toBe('2026-10-13')
    expect(result.last_date).toBe('2026-10-14')
    expect(result.latest).toEqual(sentimentHistory.series[1])
    expect(result.expected_data_date).toBe('2026-10-14')
    expect(result.stale).toBe(false)
    expect(harness.upstream.calls).toEqual(['/api/sentiment/history?market=cn&methodology=3&days=750'])
  })

  it('用户请求超范围窗口时按契约夹取到上下界', async () => {
    // Given: 上游接受任意查询串
    const tooBig = makeHarness()
    const tooSmall = makeHarness()
    // When: days 超出 30..800
    await tooBig.run('special_indicators_get_sentiment_history', { days: 99_999 })
    await tooSmall.run('special_indicators_get_sentiment_history', { days: 1 })
    // Then: 分别夹到 800 与 30（与白名单子路由的夹取口径一致）
    expect(tooBig.upstream.calls).toEqual(['/api/sentiment/history?market=cn&methodology=3&days=800'])
    expect(tooSmall.upstream.calls).toEqual(['/api/sentiment/history?market=cn&methodology=3&days=30'])
  })

  it('用户读历史而序列尾日早于应有数据日时派生 stale 并写明依据', async () => {
    // Given: 上游声明应有数据日 2026-10-15，序列只到 2026-10-14 且没有 stale 字段
    const harness = makeHarness({
      routes: {
        ...ALL_ROUTES,
        '/api/sentiment/history': { body: { ...sentimentHistory, expected_data_date: '2026-10-15', series: [sentimentHistory.series[1]] } },
      },
    })
    // When: 读历史
    const result = await harness.run('special_indicators_get_sentiment_history')
    // Then: stale 为真，来源写明是派生而非上游声明
    expect(result.stale).toBe(true)
    expect(String(result.stale_source)).toContain('derived')
    expect(String(result.stale_source)).toContain('expected_data_date')
  })

  it('用户读历史而上游声明 stale 时原样透传上游声明', async () => {
    // Given: 上游历史载荷自带 stale=true
    const harness = makeHarness({ routes: { ...ALL_ROUTES, '/api/sentiment/history': { body: { ...sentimentHistory, stale: true } } } })
    // When: 读历史
    const result = await harness.run('special_indicators_get_sentiment_history')
    // Then: stale 透传为 true，stale_source 标明来自上游字段
    expect(result.stale).toBe(true)
    expect(String(result.stale_source)).toContain('upstream')
  })

  it('用户读历史而上游失败时工具响亮抛错并带 FinanceError 错误码', async () => {
    // Given: 上游历史返回 502
    const harness = makeHarness({ routes: { ...ALL_ROUTES, '/api/sentiment/history': { status: 502, body: { error: 'upstream down' } } } })
    // When: 读历史
    const error = await harness.run('special_indicators_get_sentiment_history').catch((e: unknown) => e)
    // Then: 报错写明「没拿到数据」、上游路径与错误码，而不是返回空序列
    const message = String((error as Error).message)
    expect(message).toContain('没拿到数据')
    expect(message).toContain('FINANCE_UPSTREAM_ERROR')
    expect(message).toContain('/api/sentiment/history')
  })
})

describe('special_indicators_get_sector_ranking', () => {
  it('用户读板块排行时拿到排序行与五日内变化摘要及单位', async () => {
    // Given: 排行与快照都就绪
    const harness = makeHarness()
    // When: 默认窗口读排行
    const result = await harness.run('special_indicators_get_sector_ranking')
    // Then: 行字段、单位、快照摘要与数据日齐备
    const list = result.list as Array<Record<string, unknown>>
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual(sectorsRanking[0])
    expect(result.units).toMatchObject({ latest_margin: '亿元', total_5d_flow: '亿元', chg_pct: '%' })
    expect(result.data_date).toBe('2026-10-14')
    expect(result.expected_data_date).toBe('2026-10-14')
    expect(result.n_ready).toBe(18)
    expect(result.five_day).toEqual(sectorsSnapshot.five_day)
    expect(result.stale).toBe(false)
    expect(harness.upstream.calls).toEqual(['/api/sectors/ranking?window=20', '/api/sectors/snapshot'])
  })

  it('用户请求越界窗口与条数时按契约夹取并标记截断', async () => {
    // Given: 上游只有两行排行
    const harness = makeHarness()
    // When: window 与 limit 都超上界
    const result = await harness.run('special_indicators_get_sector_ranking', { window: 9_999, limit: 999 })
    // Then: window 夹到 120，limit 夹到 60（行数少于上限时不算截断）
    expect(harness.upstream.calls).toContain('/api/sectors/ranking?window=120')
    expect(result.window).toBe(120)
    expect(result.limit).toBe(60)
    expect(result.list_count).toBe(2)
    expect('truncated' in result).toBe(false)
  })

  it('用户请求条数少于上游行数时标记 truncated', async () => {
    // Given: 上游两行排行
    const harness = makeHarness()
    // When: limit=1
    const result = await harness.run('special_indicators_get_sector_ranking', { limit: 1 })
    // Then: 只回一行并显式标记截断
    expect((result.list as unknown[]).length).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.ranking_rows_upstream).toBe(2)
  })

  it('用户读排行而快照数据日落后时派生 stale', async () => {
    // Given: 快照数据日 2026-10-14，应有数据日 2026-10-15
    const harness = makeHarness({ routes: { ...ALL_ROUTES, '/api/sectors/snapshot': { body: { ...sectorsSnapshot, expected_data_date: '2026-10-15' } } } })
    // When: 读排行
    const result = await harness.run('special_indicators_get_sector_ranking')
    // Then: stale 为真且来源写明是快照日期派生
    expect(result.stale).toBe(true)
    expect(String(result.stale_source)).toContain('snapshot data_date < expected_data_date')
  })

  it('用户读排行而桥缓存条目过期时数据面 stale 与 cache_stale 分开上报', async () => {
    // Given: 首读把排行与快照灌进缓存（TTL 60s）后时钟推进过期窗口
    const harness = makeHarness()
    await harness.run('special_indicators_get_sector_ranking')
    harness.advance(120_000)
    // When: 再读一次
    const result = await harness.run('special_indicators_get_sector_ranking')
    // Then: cache_stale=true 说明读到的是过期缓存条目，而数据面 stale 仍为 false（数据日本身没落后）
    expect(result.cache_stale).toBe(true)
    expect(result.stale).toBe(false)
    expect(String(result.stale_source)).toContain('bridge cache served an expired entry')
  })

  it('用户连续两次读同一排行时第二次命中同一 client 的缓存，不再打上游', async () => {
    // Given: 首读完成
    const harness = makeHarness()
    await harness.run('special_indicators_get_sector_ranking')
    const afterFirst = harness.upstream.calls.length
    // When: TTL 窗口内再读
    const result = await harness.run('special_indicators_get_sector_ranking')
    // Then: 上游调用数不变（工具面与桥共用同一 FinanceClient 缓存）
    expect(harness.upstream.calls).toHaveLength(afterFirst)
    expect((result.list as unknown[]).length).toBe(2)
    expect(result.cache_stale).toBe(false)
  })
})

describe('special_indicators_get_sector_series', () => {
  it('用户读单板块序列时拿到首尾点、点数与上游 stale', async () => {
    // Given: 板块明细就绪
    const harness = makeHarness()
    // When: 按代码与默认窗口读明细
    const result = await harness.run('special_indicators_get_sector_series', { code: '801737' })
    // Then: 点数、首尾点、派生数据日与上游 stale 齐备
    expect(result.code).toBe('801737')
    expect(result.name).toBe('电池')
    expect(result.points).toEqual({ index: 2, margin: 2 })
    expect(result.index_first).toEqual({ date: '2026-10-13', close: 20100.2 })
    expect(result.margin_last).toEqual({ date: '2026-10-14', rzye: 84_812_345_678 })
    expect(result.data_date).toBe('2026-10-14')
    expect(String(result.data_date_source)).toContain('derived')
    expect(result.stale).toBe(false)
    expect(String(result.stale_source)).toContain('upstream')
    expect('expected_data_date' in result).toBe(false)
    expect(harness.upstream.calls).toEqual(['/api/v2/sectors/801737?days=200'])
  })

  it('用户传入白名单外的板块代码时工具响亮报错且不发请求', async () => {
    // Given: 一个正常上游
    const harness = makeHarness()
    // When: code 含路径分隔符
    const error = await harness.run('special_indicators_get_sector_series', { code: '../etc/passwd' }).catch((e: unknown) => e)
    // Then: 白名单拒绝，零上游调用
    expect(String((error as Error).message)).toContain('不在白名单')
    expect(harness.upstream.calls).toHaveLength(0)
  })

  it('用户读不存在的板块时上游业务错误如实抛出', async () => {
    // Given: 上游对未知板块返回 HTTP 200 + error 信封
    const harness = makeHarness({ routes: { ...ALL_ROUTES, '/api/v2/sectors/801737': { body: { error: '未知板块: 801737' } } } })
    // When: 读该板块明细
    const error = await harness.run('special_indicators_get_sector_series', { code: '801737' }).catch((e: unknown) => e)
    // Then: 业务错误码与上游文案都进错误信息，不返回空序列冒充成功
    const message = String((error as Error).message)
    expect(message).toContain('FINANCE_BUSINESS_ERROR')
    expect(message).toContain('未知板块')
    expect(message).toContain('没拿到数据')
  })

  it('用户请求超范围天数时按契约夹取到上下界', async () => {
    // Given: 板块明细路由接受 days 查询
    const tooBig = makeHarness()
    const tooSmall = makeHarness()
    // When: days 超出 10..500
    await tooBig.run('special_indicators_get_sector_series', { code: '801737', days: 100_000 })
    await tooSmall.run('special_indicators_get_sector_series', { code: '801737', days: 2 })
    // Then: 分别夹到 500 与 10
    expect(tooBig.upstream.calls).toEqual(['/api/v2/sectors/801737?days=500'])
    expect(tooSmall.upstream.calls).toEqual(['/api/v2/sectors/801737?days=10'])
  })
})

describe('special_indicators_get_hk_short_top10', () => {
  it('用户读恒科卖空前十大时逐股合并 chart 的卖空比例并透传上游 stale', async () => {
    // Given: 快照给名单权重、chart 给逐股最新卖空比例
    const harness = makeHarness()
    // When: 读前十大
    const result = await harness.run('special_indicators_get_hk_short_top10')
    // Then: 名单顺序按快照、比例按 code 合并且单位写明；stale 来自 chart 声明
    const top10 = result.top10 as Array<Record<string, unknown>>
    expect(top10).toEqual([
      { code: '00700', name: '腾讯', weight: 8.0, latest_pct: 11.661, vs_5d_pct: 1.547, history_days: 97, latest_value: 10.09 },
      { code: '09988', name: '阿里巴巴', weight: 7.5, latest_pct: 13.402, vs_5d_pct: -0.8, history_days: 95, latest_value: 12.5 },
    ])
    expect(result.data_date).toBe('2026-10-15')
    expect(result.short_data_date).toBe('2026-10-15')
    expect(result.index_data_date).toBe('2026-10-15')
    expect(result.n_days).toBe(98)
    expect(result.data_version).toBe('d3e8c35a736b41f2')
    expect(result.five_day).toEqual(hkShortSnapshot.five_day)
    expect(result.stale).toBe(false)
    expect(String(result.stale_source)).toContain('upstream')
    expect((result.units as Record<string, string>).latest_value).toBe('亿港元')
    expect(harness.upstream.calls).toEqual(['/api/hk-short/snapshot', '/api/hk-short/chart'])
  })

  it('用户读前十大而 chart 声明 stale 时原样透传为 true', async () => {
    // Given: chart 载荷自带 stale=true
    const harness = makeHarness({ routes: { ...ALL_ROUTES, '/api/hk-short/chart': { body: { ...hkShortChart, stale: true } } } })
    // When: 读前十大
    const result = await harness.run('special_indicators_get_hk_short_top10')
    // Then: stale 透传为 true 并标明来源
    expect(result.stale).toBe(true)
    expect(String(result.stale_source)).toContain('/api/hk-short/chart.stale')
  })

  it('用户读前十大而 chart 缺某只个股明细时不补零并留下说明', async () => {
    // Given: chart 只回腾讯一只
    const harness = makeHarness({ routes: { ...ALL_ROUTES, '/api/hk-short/chart': { body: { ...hkShortChart, top10: [hkShortChart.top10[0]] } } } })
    // When: 读前十大
    const result = await harness.run('special_indicators_get_hk_short_top10')
    // Then: 缺明细的个股只有名单权重、没有 latest_pct 键，notes 点名该代码
    const top10 = result.top10 as Array<Record<string, unknown>>
    expect(top10[0]).toHaveProperty('latest_pct', 11.661)
    expect('latest_pct' in top10[1]).toBe(false)
    expect(JSON.stringify(result.notes)).toContain('09988')
  })

  it('用户限制条数少于十只时只回指定条数并标记截断', async () => {
    // Given: 快照两只持仓
    const harness = makeHarness()
    // When: limit=1
    const result = await harness.run('special_indicators_get_hk_short_top10', { limit: 1 })
    // Then: 只回一只且标记截断
    expect((result.top10 as unknown[]).length).toBe(1)
    expect(result.limit).toBe(1)
    expect(result.truncated).toBe(true)
  })
})

describe('凭据链与出参信封', () => {
  it('用户未配置凭据时工具上报 FINANCE_NOT_CONFIGURED 且不触网', async () => {
    // Given: 凭据链解析为空密码
    const harness = makeHarness({ password: '' })
    // When: 读任意一组指标
    const error = await harness.run('special_indicators_get_snapshot', { group: 'sentiment' }).catch((e: unknown) => e)
    // Then: 错误码进文案、写明没拿到数据、零上游调用
    const message = String((error as Error).message)
    expect(message).toContain('FINANCE_NOT_CONFIGURED')
    expect(message).toContain('没拿到数据')
    expect(harness.upstream.calls).toHaveLength(0)
  })

  it('用户调用五只工具时出参都带 as_of/source/stale/cache_stale 信封', async () => {
    // Given: 全绿上游与五只工具
    const harness = makeHarness()
    const calls: Array<[string, Record<string, unknown>]> = [
      ['special_indicators_get_snapshot', {}],
      ['special_indicators_get_sentiment_history', {}],
      ['special_indicators_get_sector_ranking', {}],
      ['special_indicators_get_sector_series', { code: '801737' }],
      ['special_indicators_get_hk_short_top10', {}],
    ]
    // When: 逐只调用
    const results = await Promise.all(calls.map(async ([name, args]) => [name, await harness.run(name, args)] as const))
    // Then: 每只都带时间戳、来源路径、布尔 stale 与独立的缓存标记
    for (const [name, result] of results) {
      expect(typeof result.as_of, name).toBe('string')
      expect(new Date(result.as_of as string).toISOString(), name).toBe(result.as_of)
      expect(String(result.source), name).toContain('自有 finance 服务')
      expect(String(result.source), name).toContain('/api/')
      expect(typeof result.stale, name).toBe('boolean')
      expect(typeof result.cache_stale, name).toBe('boolean')
      expect(String(result.stale_source).length, name).toBeGreaterThan(0)
    }
  })
})

/* ------------------------------- apply 组装面 ------------------------------- */

/** 契约化最小宿主：只提供 webServer/connection/tools，inject 按服务可用性回调。 */
function bootApply(cfg: Config) {
  const registered = new Map<string, ToolDefinition>()
  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined
  const toolsService = {
    get: (name: string) => registered.get(name),
    register: (definition: ToolDefinition) => {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
  const webServer = {
    register(route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) {
      if (route.path === MOUNT) handler = route.handler
      return () => undefined
    },
  }
  const scope: Record<string, unknown> = { webServer, connection: { requestRejection: () => undefined }, tools: toolsService }
  const ctx = {
    get: () => undefined,
    inject: (deps: string[], cb: (inner: unknown) => void) => {
      if (!deps.every((dep) => dep in scope)) return
      cb({ get: (key: string) => scope[key] })
    },
    effect: (fn: () => unknown) => { fn() },
  }
  apply(ctx as never, cfg)
  if (handler === undefined) throw new Error('apply 未注册 webServer 路由')
  return { registered, handler }
}

describe('apply 组装面', () => {
  it('用户启动宿主时 apply 注册五只工具，且工具面与桥共用同一 client 缓存', async () => {
    // Given: 真实 apply 组装 + 真实本地 HTTP 上游（统计命中次数）+ 临时缓存文件
    const dir = mkdtempSync(join(tmpdir(), 'si-tools-apply-'))
    let hits = 0
    const server = createServer((_req, res) => {
      hits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(sectorsSnapshot))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const cfg: Config = {
      baseUrl: 'http://127.0.0.1:' + String(port),
      sentimentMethodology: 3,
      username: 'api',
      password: 'secret',
      usernameEnv: 'FINANCE_API_USER',
      passwordEnv: 'FINANCE_API_PASSWORD',
      timeoutMs: 5_000,
      snapshotCacheMs: 60_000,
      historyCacheMs: 300_000,
      cacheFile: join(dir, 'cache.json'),
    }
    try {
      const host = bootApply(cfg)
      // Then: 五只工具经 ctx.inject(['tools']) 全部注册，名字与清单一致
      expect([...host.registered.keys()].sort()).toEqual([...INDICATOR_TOOL_NAMES].sort())
      // When: 先用工具读板块快照（冷缓存 → 打一次上游），再经桥读同一路径
      const tool = host.registered.get('special_indicators_get_snapshot')
      if (tool === undefined) throw new Error('工具未注册')
      const text = await tool.execute({ group: 'sectors' }, {} as never) as string
      const hitsAfterTool = hits
      const { res, json } = fakeHttpRes('json-response')
      await host.handler({ method: 'GET', url: MOUNT + '/sectors/snapshot', headers: { host: '127.0.0.1' } }, res)
      const body = await json()
      // Then: 桥没有新增上游调用——工具面与桥共用同一个 FinanceClient 与缓存；出参信封齐备
      expect(hitsAfterTool).toBe(1)
      expect(hits).toBe(1)
      expect((body.data as { n_ready: number }).n_ready).toBe(18)
      const result = JSON.parse(text) as Record<string, unknown>
      expect(typeof result.as_of).toBe('string')
      expect(result.stale).toBe(false)
      expect((result.groups as Record<string, Record<string, unknown>>).sectors.data_date).toBe('2026-10-14')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
