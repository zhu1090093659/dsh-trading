/**
 * agent 工具面用例：**真实本地 HTTP 上游**（node:http）+ 真实文件系统，零 mock、零 sleep。
 *
 * 两条硬判据：
 * - 每个工具的返回值同时过两关——dsh-tools 自己的 `validateJsonSchemaValue` 按**声明
 *   的 value schema** 校验（等于把宿主运行时的校验请进单测），并断言三件套
 *   `observedAt` / `source` / `stale` 齐备；
 * - 上游失败（403 Cloudflare 1010 的 text/plain 体、契约破损）在工具面上**响亮抛错**，
 *   与「上游 200 但真的没有这个事件/没有命中」区分开，绝不回落成空数据。
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { Config, createPolymarketService } from '../src/plugin.ts'
import { createPolymarketPredictionFeed, type PolymarketService } from '../src/service.ts'
import { createPolymarketTools } from '../src/tools.ts'

const FOMC_FIXTURE = join(import.meta.dirname, 'fixtures', 'fomc-open-2026-10-11.json')
const FOMC_BODY = readFileSync(FOMC_FIXTURE, 'utf8')
const SEARCH_FIXTURE = join(import.meta.dirname, 'fixtures', 'events-search-page-2026-10-15.json')
const SEARCH_BODY = readFileSync(SEARCH_FIXTURE, 'utf8')
const DETAIL_FIXTURE = join(import.meta.dirname, 'fixtures', 'event-detail-fomc-2026-10-15.json')
const DETAIL_BODY = readFileSync(DETAIL_FIXTURE, 'utf8')

const NOW = Date.parse('2026-10-11T01:55:19Z')
const NO_SNAPSHOT = { ...Config({}), snapshots: false }
const DETAIL_SLUG = 'fed-decision-in-october-20260617190323537'

/**
 * 工具的定义面（只用到测试真正断言的那几项；类型边界一次 cast）。
 *
 * `parameters` / `output.schema` 在 `defineTool` 里**已经是编译后的 JSON Schema**
 * （作者面 spec 不会出现在定义对象上），所以这里直接用宿主会用的校验器校验它们。
 */
interface ToolLike {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchemaNode
  readonly output: { readonly schema: JsonSchemaNode; render(args: never, value: never): { type: string; text: string }[] }
  execute(args: Record<string, unknown>): Promise<unknown>
}

let server: Server | undefined
const requests: { method: string; url: string }[] = []
const dirs: string[] = []

async function serve(handler: (url: string, res: ServerResponse) => void): Promise<string> {
  requests.length = 0
  server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' })
    handler(req.url ?? '', res)
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return `http://127.0.0.1:${port}`
}

function jsonBody(res: ServerResponse, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'application/json', ...headers })
  res.end(body)
}

function tempSnapshotPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-poly-tools-'))
  dirs.push(dir)
  return join(dir, 'polymarket', 'snapshots.json')
}

afterEach(async () => {
  if (server !== undefined) {
    const closing = server
    server = undefined
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function toolsOf(service: PolymarketService): Map<string, ToolLike> {
  return new Map(createPolymarketTools(service).map((tool) => [tool.name, tool as unknown as ToolLike]))
}

function toolOf(tools: Map<string, ToolLike>, name: string): ToolLike {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no such tool: ${name}`)
  return tool
}

/**
 * 执行一个工具并取回**模型可见的那份文本**（`render` 与 `schema` 同源的紧凑 JSON）：
 * 顺带用它跑一遍宿主会跑的 schema 校验，返回值不合声明就在这里红。
 */
async function callTool(tools: Map<string, ToolLike>, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`no such tool: ${name}`)
  const value = await tool.execute(args)
  expect(validateJsonSchemaValue(tool.output.schema, value)).toEqual([])
  const blocks = tool.output.render(args as never, value as never)
  return JSON.parse(blocks.map((block) => block.text).join('')) as Record<string, unknown>
}

describe('预测市场 agent 工具面（真实本地上游）', () => {
  it('运营调用 prediction_fomc_meetings 拿到档位概率、取数时刻与缓存新鲜度三件套', async () => {
    // Given 本地上游回实测 FOMC 响应，且这次响应由共享 CDN 直接命中
    const baseUrl = await serve((_url, res) => jsonBody(res, FOMC_BODY, { 'cf-cache-status': 'HIT' }))
    const tools = toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW }))

    // When 调用工具
    const output = await callTool(tools, 'prediction_fomc_meetings')

    // Then 三件套齐备，档位是规范化键 + 上游原文标签 + 上游 outcomePrices[0]
    expect(output.observedAt).toBe('2026-10-11T01:55:19.000Z')
    expect(output.source).toContain('gamma-api.polymarket.com')
    expect(output.stale).toBe(true)
    const meetings = output.meetings as { id: string; title: string; closed: boolean; buckets: Record<string, unknown>[] }[]
    expect(meetings.map((meeting) => meeting.id)).toEqual(['606422', '770450', '770451'])
    expect(meetings[0]?.buckets[2]).toMatchObject({ key: 'no_change', label: 'No change', probability: 0.835, bestBid: 0.83, bestAsk: 0.84 })
    // 只请求了一次（一次 GET 拿全量），带的是自有 UA 与 no-key 只读面
    expect(requests).toEqual([{ method: 'GET', url: '/events?series_id=35&limit=100&closed=false' }])
  })

  it('运营看到共享缓存未命中时 stale=false（false 是没有缓存命中的证据，不是宣称实时）', async () => {
    // Given 上游不返回 cf-cache-status（源站直出 / 非 Cloudflare 部署）
    const baseUrl = await serve((_url, res) => jsonBody(res, FOMC_BODY))
    const tools = toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW }))

    // When / Then stale 为 false
    expect((await callTool(tools, 'prediction_fomc_meetings')).stale).toBe(false)
  })

  it('运营按 meetingId 收窄到一场会议（event id 与 slug 都接受，仍只请求一次）', async () => {
    // Given 本地上游回三场会议
    const baseUrl = await serve((_url, res) => jsonBody(res, FOMC_BODY))
    const tools = toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW }))

    // When 分别按 id 与 slug 收窄
    const byId = await callTool(tools, 'prediction_fomc_meetings', { meetingId: '770450' })
    const bySlug = await callTool(tools, 'prediction_fomc_meetings', { meetingId: 'fed-decision-in-december-20260729232808632' })

    // Then 各回一场，且两次都只是同一次全量取数（不额外请求、不按 id 打上游）
    expect((byId.meetings as { id: string }[]).map((meeting) => meeting.id)).toEqual(['770450'])
    expect((bySlug.meetings as { id: string }[]).map((meeting) => meeting.id)).toEqual(['770450'])
    expect(requests.map((request) => request.url)).toEqual([
      '/events?series_id=35&limit=100&closed=false',
      '/events?series_id=35&limit=100&closed=false',
    ])
  })

  it('运营给一个不存在的 meetingId 时看到 TRADING_SYMBOL_NOT_FOUND，而不是一场空会议', async () => {
    // Given 上游只有三场会议
    const baseUrl = await serve((_url, res) => jsonBody(res, FOMC_BODY))
    const tool = toolOf(toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW })), 'prediction_fomc_meetings')

    // When / Then 「上游说查不到」是显式错误，不是空列表（空列表只在真的没有会议时出现）
    await expect(tool.execute({ meetingId: 'no-such-meeting' })).rejects.toMatchObject({
      code: 'TRADING_SYMBOL_NOT_FOUND',
      message: 'polymarket gamma /events?series_id=35: no FOMC meeting matches "no-such-meeting" (accepted: event id or slug)',
    })
  })

  it('运营遇到 Cloudflare 403 准入拦截时工具响亮失败，绝不回落成空数据', async () => {
    // Given 复刻真实 403：text/plain 的 `error code: 1010`（不是 JSON）
    const baseUrl = await serve((_url, res) => {
      res.writeHead(403, { 'content-type': 'text/plain; charset=UTF-8' })
      res.end('error code: 1010\n')
    })
    const tools = toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW }))

    // When / Then 三个工具都抛结构化错误，原文就是 Cloudflare 那句
    const expected = {
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'polymarket gamma /events: HTTP 403 — error code: 1010',
    }
    await expect(toolOf(tools, 'prediction_fomc_meetings').execute({})).rejects.toMatchObject(expected)
    await expect(toolOf(tools, 'prediction_search_events').execute({ keyword: 'fed' })).rejects.toMatchObject(expected)
    await expect(toolOf(tools, 'prediction_event_detail').execute({ eventId: '606422' })).rejects.toMatchObject(expected)
  })

  it('运营做关键词检索时看到「本地过滤」标记与扫描页统计（上游没有检索参数）', async () => {
    // Given 上游回一页真实事件（6 条，其中 2 条标题含 Fed）
    const baseUrl = await serve((_url, res) => jsonBody(res, SEARCH_BODY))
    const tools = toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW }))

    // When 以 fed 检索
    const output = await callTool(tools, 'prediction_search_events', { keyword: 'fed' })

    // Then 结果是「一页 ∩ 关键词」：扫描 6 条、命中 2 条，并显式标注本地过滤
    expect(output.filtering).toBe('local-page-filter')
    expect(output.pageLimit).toBe(100)
    expect(output.scanned).toBe(6)
    expect(output.matched).toBe(2)
    const events = output.events as { id: string; title: string; closed: boolean; buckets: Record<string, unknown>[] }[]
    expect(events.map((event) => event.id)).toEqual(['606422', '770450'])
    expect(events[0]?.buckets[0]).toMatchObject({ key: 'dec_50plus', label: '50+ bps decrease', probability: 0.0015 })
    expect(requests).toEqual([{ method: 'GET', url: '/events?closed=false&order=volume24hr&ascending=false&limit=100' }])
  })

  it('运营看到检索条数封顶在声明上限内，且命中数报的是截断前的值', async () => {
    // Given 上游回一页（含 2 条 Fed 命中）
    const baseUrl = await serve((_url, res) => jsonBody(res, SEARCH_BODY))
    const tools = toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW }))

    // When 只要 1 条，以及要一个远超上限的条数
    const one = await callTool(tools, 'prediction_search_events', { keyword: 'fed', limit: 1 })
    const huge = await callTool(tools, 'prediction_search_events', { keyword: 'fed', limit: 999 })

    // Then 命中数不变（2），返回条数分别被请求值与声明上限约束住
    expect(one.matched).toBe(2)
    expect(one.events).toHaveLength(1)
    expect(huge.matched).toBe(2)
    expect(huge.events).toHaveLength(2)
  })

  it('运营看到「关键词没命中」是零命中而不是故障（真正的空态只有一个来源）', async () => {
    // Given 上游正常回一页
    const baseUrl = await serve((_url, res) => jsonBody(res, SEARCH_BODY))
    const tools = toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW }))

    // When 用一个必然不命中的词检索
    const output = await callTool(tools, 'prediction_search_events', { keyword: 'zzz-no-such-market' })

    // Then 零命中、扫描数照报（不是空数据假象，也不是异常）
    expect(output.matched).toBe(0)
    expect(output.scanned).toBe(6)
    expect(output.events).toEqual([])
  })

  it('运营看到检索只匹配标题与 slug，不匹配档位标签（人名不制造假阳性）', async () => {
    // Given 巴西大选那条事件的档位是人名（Tarcisio de Freitas），标题与 slug 里都没有这个名字
    const baseUrl = await serve((_url, res) => jsonBody(res, SEARCH_BODY))
    const tools = toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW }))

    // When 用这个只出现在档位标签里的名字检索，再用标题词检索
    const byLabel = await callTool(tools, 'prediction_search_events', { keyword: 'tarcisio' })
    const byTitle = await callTool(tools, 'prediction_search_events', { keyword: 'brazil' })

    // Then 档位标签不参与命中；标题命中照常返回，且档位仍随事件回给调用方
    expect(byLabel.matched).toBe(0)
    const hits = byTitle.events as { id: string; buckets: { label: string }[] }[]
    expect(hits[0]?.id).toBe('45915')
    expect(hits[0]?.buckets[0]?.label).toBe('Tarcisio de Freitas')
  })

  it('运营给空关键词时零请求响亮失败（空串会匹配一切，不能冒充检索命中）', async () => {
    // Given 上游可达
    const baseUrl = await serve((_url, res) => jsonBody(res, SEARCH_BODY))
    const tool = toolOf(toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW })), 'prediction_search_events')

    // When / Then 空串与纯空白都在发请求之前就失败
    await expect(tool.execute({ keyword: '' })).rejects.toThrow('polymarket /events: keyword must be a non-empty string')
    await expect(tool.execute({ keyword: '   ' })).rejects.toThrow('polymarket /events: keyword must be a non-empty string')
    expect(requests).toEqual([])
  })

  it('运营查事件详情时拿到解析后的 outcomes/outcomePrices 与全部报价维度', async () => {
    // Given 上游按 id 精确匹配回一条事件
    const baseUrl = await serve((_url, res) => jsonBody(res, DETAIL_BODY))
    const tools = toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW }))

    // When 用 event id 查详情
    const output = await callTool(tools, 'prediction_event_detail', { eventId: '606422' })

    // Then 事件级字段 + 每个市场的解析结果（字符串化数组被拆成数组，不是原样透传）
    const event = output.event as {
      id: string
      slug: string
      negRisk: boolean
      closed: boolean
      endDate: string
      markets: Record<string, unknown>[]
    }
    expect(event.id).toBe('606422')
    expect(event.slug).toBe(DETAIL_SLUG)
    expect(event.negRisk).toBe(true)
    expect(event.closed).toBe(false)
    expect(event.endDate).toBe('2026-10-29T03:59:00Z')
    expect(event.markets).toHaveLength(5)
    expect(event.markets[0]).toMatchObject({
      key: 'dec_50plus',
      label: '50+ bps decrease',
      outcomes: ['Yes', 'No'],
      outcomePrices: [0.0015, 0.9985],
      bestBid: 0.001,
      bestAsk: 0.002,
      spread: 0.001,
      liquidity: 1603214.98317,
      volume: 6459086.367547005,
      closed: false,
      acceptingOrders: true,
    })
    expect(requests).toEqual([{ method: 'GET', url: '/events?id=606422' }])
  })

  it('运营用 slug 查详情时走同一条详情路径（id 与 slug 两个入口）', async () => {
    // Given 上游按 slug 精确匹配回同一条事件
    const baseUrl = await serve((url, res) => (url.includes(`slug=${DETAIL_SLUG}`) ? jsonBody(res, DETAIL_BODY) : jsonBody(res, '[]')))
    const tools = toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW }))

    // When 用 slug 查
    const output = await callTool(tools, 'prediction_event_detail', { eventId: DETAIL_SLUG })

    // Then 命中的是同一条事件，且请求参数确实是 slug
    expect((output.event as { id: string }).id).toBe('606422')
    expect(requests).toEqual([{ method: 'GET', url: `/events?slug=${DETAIL_SLUG}` }])
  })

  it('运营查一个上游不认识的事件时看到 TRADING_SYMBOL_NOT_FOUND（200 空集不等于上游故障）', async () => {
    // Given 上游对未知 id 回 200 + 空数组（实测形态）
    const baseUrl = await serve((_url, res) => jsonBody(res, '[]'))
    const tool = toolOf(toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW })), 'prediction_event_detail')

    // When / Then 「上游说查不到」不是空市场列表，也不是基础设施错误
    await expect(tool.execute({ eventId: '999999999' })).rejects.toMatchObject({
      code: 'TRADING_SYMBOL_NOT_FOUND',
      message: 'polymarket gamma /events: no event matches "999999999" (HTTP 200 with an empty result set)',
    })
  })

  it('运营看到工具面的 Δ 标注与桥面共用同一条基线（一个 service 实例两处消费）', async () => {
    // Given 上游连着三次回同一场会议、但档位概率中途变了（0.835 → 0.840 → 0.835）
    const bodies = [FOMC_BODY, withNoChangeProbability(FOMC_BODY, '0.840'), FOMC_BODY]
    let served = 0
    const baseUrl = await serve((_url, res) => jsonBody(res, bodies[served++] ?? '[]'))
    const service = createPolymarketService({ ...Config({}), snapshots: true, snapshotPath: tempSnapshotPath() }, { baseUrl, now: () => NOW })
    const tools = toolsOf(service)

    // When 工具面连取两次，再由桥面（与工具同一个 service 实例）取第三次
    const first = await callTool(tools, 'prediction_fomc_meetings')
    const second = await callTool(tools, 'prediction_fomc_meetings')
    const viaBridge = await createPolymarketPredictionFeed(service).listFomcMeetings()

    // Then 首次没有 Δ（缺省 = 不知道，绝不填 0）；后两次的 Δ 都以另一个面的上一次落盘为基线
    expect(noChangeDelta(meetingsOf(first))).toBe('absent')
    expect(noChangeDelta(meetingsOf(second))).toBe(0.005)
    expect(noChangeDelta(viaBridge.meetings)).toBe(-0.005)
  })

  it('运营看到三个工具都是只读的：只发 GET /events，入参不超过 3 个', async () => {
    // Given 三个工具挂在同一个 service 上
    const baseUrl = await serve((url, res) => jsonBody(res, url.includes('series_id') ? FOMC_BODY : url.includes('id=') ? DETAIL_BODY : SEARCH_BODY))
    const tools = toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl, now: () => NOW }))

    // When 逐个调用
    await callTool(tools, 'prediction_fomc_meetings')
    await callTool(tools, 'prediction_search_events', { keyword: 'fed' })
    await callTool(tools, 'prediction_event_detail', { eventId: '606422' })

    // Then 线上只有读取请求（无 POST/下单面），每个工具入参 ≤3，且自述只读与新鲜度语义
    expect(new Set(requests.map((request) => request.method))).toEqual(new Set(['GET']))
    expect(requests.every((request) => request.url.startsWith('/events?'))).toBe(true)
    for (const name of ['prediction_fomc_meetings', 'prediction_search_events', 'prediction_event_detail']) {
      const tool = toolOf(tools, name)
      expect(Object.keys(tool.parameters).length).toBeLessThanOrEqual(3)
      expect(tool.description).toContain('Read-only')
      expect(tool.description).toContain('observedAt')
    }
  })

  it('运营看到必填参数由声明式 schema 兜住（缺参在到达取数层之前就被拒）', () => {
    // Given 三个工具
    const tools = toolsOf(createPolymarketService(NO_SNAPSHOT, { baseUrl: 'http://127.0.0.1:1', now: () => NOW }))

    // When / Then 声明了 required 的工具对空参给出违规，可选参数的工具有空参合法
    expect(validateJsonSchemaValue(toolOf(tools, 'prediction_fomc_meetings').parameters, {})).toEqual([])
    expect(validateJsonSchemaValue(toolOf(tools, 'prediction_search_events').parameters, {})).not.toEqual([])
    expect(validateJsonSchemaValue(toolOf(tools, 'prediction_event_detail').parameters, {})).not.toEqual([])
    expect(validateJsonSchemaValue(toolOf(tools, 'prediction_search_events').parameters, { keyword: 'fed' })).toEqual([])
  })
})

/** 工具面/桥面共用的会议形状：只取 Δ 断言需要的两个字段。 */
interface MeetingLike {
  readonly buckets: readonly { readonly key: string; readonly changeSincePrevious?: number }[]
}

function meetingsOf(output: Record<string, unknown>): readonly MeetingLike[] {
  return output.meetings as readonly MeetingLike[]
}

/** `no_change` 档的 Δ：'absent' = 没有这个字段（缺省 = 不知道，不是 0）。 */
function noChangeDelta(meetings: readonly MeetingLike[]): number | 'absent' {
  const bucket = meetings[0]?.buckets.find((entry) => entry.key === 'no_change')
  if (bucket === undefined) throw new Error('no_change bucket missing from the meeting')
  return bucket.changeSincePrevious ?? 'absent'
}

/** 把夹具里 October 那场的 `No change` 概率改成指定值（其余字段逐字不动）。 */
function withNoChangeProbability(body: string, probability: string): string {
  const events = JSON.parse(body) as { markets: { groupItemTitle?: string; outcomePrices: string }[] }[]
  for (const market of events[0]?.markets ?? []) {
    if (market.groupItemTitle !== 'No change') continue
    const complement = String(Number((1 - Number(probability)).toFixed(4)))
    market.outcomePrices = JSON.stringify([probability, complement])
  }
  return JSON.stringify(events)
}
