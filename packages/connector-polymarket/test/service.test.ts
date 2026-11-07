/**
 * 取数服务与插件行用例：**真实本地 HTTP 上游**（node:http）+ 真实文件系统，零 mock。
 *
 * 覆盖验收要求的三条硬判据：
 * - 一次 GET 拿全量（含 fetchedAt 数据时间戳）；
 * - 上游失败时**响亮抛错**，绝不回 `{ meetings: [] }`（失败不产生空数据假象）；
 * - 插件行 provide 的服务键与缺席语义（enabled=false 零注册）。
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Config, apply, createPolymarketService } from '../src/plugin.ts'
import { MEETING_LOOKUP_TTL_MS, TRADING_PREDICTION_FEED_KEY, createPolymarketPredictionFeed } from '../src/service.ts'
import { PRICE_HISTORY_MAX_WINDOW_MS } from '../src/clob.ts'
import { SNAPSHOT_VERSION, SnapshotStore } from '../src/snapshot.ts'
import { discoverFomcMeetings } from '../src/discovery.ts'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'fomc-open-2026-10-11.json')
const FIXTURE_BODY = readFileSync(FIXTURE, 'utf8')

let server: Server | undefined
const requests: string[] = []
const dirs: string[] = []

async function serve(handler: (url: string, res: Parameters<Parameters<typeof createServer>[0]>[1]) => void): Promise<string> {
  requests.length = 0
  server = createServer((req, res) => {
    requests.push(req.url ?? '')
    handler(req.url ?? '', res)
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return `http://127.0.0.1:${port}`
}

function tempSnapshotPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-poly-service-'))
  dirs.push(dir)
  return join(dir, 'polymarket', 'snapshots.json')
}

afterEach(async () => {
  if (server !== undefined) {
    const closing = server
    server = undefined
    // closeAllConnections：历史回填的失败用例会让其余档位的 keep-alive 连接留在池里，
    // 只 close() 要等 keepAliveTimeout 自然过期（实测多花 3s）。销毁空闲连接不动任何断言。
    closing.closeAllConnections()
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NO_SNAPSHOT = { snapshots: false, timeoutMs: 5_000, enabled: true, snapshotPath: '' } as const

/**
 * 假宿主面：只记 `reflect.provide` / `tools.register` 调用（不是 mock 库，是注入的宿主面）。
 * `claimed` 用来模拟「宿主上已经有同名工具」——注册侧因此必须走先到先得。
 */
function fakeHostContext(claimed: readonly string[] = []): {
  ctx: Context
  provided: { key: string; value: unknown }[]
  registered: string[]
} {
  const provided: { key: string; value: unknown }[] = []
  const registered: string[] = []
  const taken = new Set(claimed)
  const ctx = {
    reflect: { provide: (key: string, value: unknown) => { provided.push({ key, value }) } },
    tools: {
      get: (toolName: string) => (taken.has(toolName) ? {} : undefined),
      register: (definition: { name: string }) => { registered.push(definition.name) },
    },
  } as unknown as Context
  return { ctx, provided, registered }
}

describe('PolymarketService 取数（真实本地上游 + 真实网络夹具）', () => {
  it('运营取一次数就拿到三场会议的档位与数据时间戳', async () => {
    // Given 上游按实测响应回三场会议
    const baseUrl = await serve((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(FIXTURE_BODY)
    })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl, now: () => Date.parse('2026-10-11T01:55:19Z') })

    // When 取数
    const feed = await service.listFomcMeetings()

    // Then 三场会议、fetchedAt 是取数时刻、只发了一次请求
    expect(feed.fetchedAt).toBe('2026-10-11T01:55:19.000Z')
    expect(feed.meetings.map((meeting) => meeting.title)).toEqual([
      'Fed Decision in October?', 'Fed Decision in December?', 'Fed Decision in January?',
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toBe('/events?series_id=35&limit=100&closed=false')
  })

  it('运营看到已结算会议也一并返回（面板可展示最终结果）', async () => {
    // Given 上游把一场已结算会议（closed + 各档接受订单已关，概率变 0/1）与开放会议一起回
    const open = JSON.parse(FIXTURE_BODY) as Record<string, unknown>[]
    const resolved = {
      ...open[0],
      id: '999',
      slug: 'fed-decision-in-september',
      title: 'Fed Decision in September?',
      endDate: '2026-09-17T00:00:00Z',
      closed: true,
      markets: (open[0]?.markets as Record<string, unknown>[]).map((market, index) => ({
        ...market,
        outcomePrices: index === 3 ? '["1","0"]' : '["0","1"]',
        bestBid: index === 3 ? 0.999 : null,
        bestAsk: 0.001,
        closed: true,
        acceptingOrders: false,
      })),
    }
    const baseUrl = await serve((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([resolved, ...open]))
    })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl })

    // When 取数
    const feed = await service.listFomcMeetings()

    // Then 四场按 endDate 升序，已结算的在最前且逐档都不再可下单
    // （判据用 market 级 closed/acceptingOrders，不用 active——证据 Q4.3）
    expect(feed.meetings).toHaveLength(4)
    expect(feed.meetings[0]).toMatchObject({ title: 'Fed Decision in September?', closed: true })
    expect(feed.meetings[0]?.buckets.every((bucket) => bucket.acceptingOrders === false)).toBe(true)
  })

  it('运营请求真实时值时 cache-bust 参数确实发给上游', async () => {
    // Given 上游记录 query
    const baseUrl = await serve((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
    })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl, now: () => 1791684236000 })

    // When 打开 cacheBust
    await service.listFomcMeetings({ cacheBust: true })

    // Then query 里带 _cb
    expect(requests[0]).toBe('/events?series_id=35&limit=100&closed=false&_cb=1791684236000')
  })

  it('运营遇到上游 403 准入拦截时取数失败，而不是拿到一场空会议列表', async () => {
    // Given 上游回真实 403 形态
    const baseUrl = await serve((_url, res) => {
      res.writeHead(403, { 'content-type': 'text/plain; charset=UTF-8' })
      res.end('error code: 1010\n')
    })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl })

    // When / Then 抛错（不返回 {meetings: []}——那正是「把失败画成没有数据」）
    await expect(service.listFomcMeetings()).rejects.toMatchObject({
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'polymarket gamma /events: HTTP 403 — error code: 1010',
    })
  })

  it('运营遇到上游 500 或响应体不是 JSON 时同样取数失败', async () => {
    // Given 两种上游故障
    const body = JSON.parse(FIXTURE_BODY) as unknown[]
    const failing = await serve((url, res) => {
      if (url.includes('_cb')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>oops</html>')
        return
      }
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('internal error')
    })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl: failing })

    // When / Then 两条路径都抛结构化错误
    await expect(service.listFomcMeetings()).rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
    await expect(service.listFomcMeetings({ cacheBust: true })).rejects.toMatchObject({
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'polymarket gamma /events: HTTP 200 but the body is not JSON — <html>oops</html>',
    })
    expect(body).toHaveLength(3)
  })

  it('运营遇到上游超时时取数失败，不会一直转圈', async () => {
    // Given 一个挂起的上游
    const baseUrl = await serve(() => { /* 不响应 */ })
    const service = createPolymarketService({ ...NO_SNAPSHOT, timeoutMs: 40 }, { baseUrl })

    // When / Then 结构化网络错误
    await expect(service.listFomcMeetings()).rejects.toMatchObject({ code: 'TRADING_NETWORK' })
  })

  it('运营看到每档都缺盘口报价的开放会议被标 quality 提示（报价缺失不静默）', async () => {
    // Given 上游回一场所有档位都没有 bestBid/bestAsk 的开放会议
    const stripped = (JSON.parse(FIXTURE_BODY) as Record<string, unknown>[]).map((event, index) => index !== 0
      ? event
      : {
        ...event,
        markets: (event.markets as Record<string, unknown>[]).map((market) => {
          const { bestBid, bestAsk, ...rest } = market
          void bestBid
          void bestAsk
          return rest
        }),
      })
    const baseUrl = await serve((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(stripped))
    })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl })

    // When 取数
    const feed = await service.listFomcMeetings()

    // Then October 被标记缺报价，其余两场仍健康
    expect(feed.meetings[0]?.degraded).toEqual(['bucket-quote-missing'])
    expect(feed.meetings[0]?.buckets.every((bucket) => bucket.bestBid === undefined && bucket.spread === undefined)).toBe(true)
    expect(feed.meetings[1]?.degraded).toEqual([])
  })

  it('运营看到 status 200 但体不是数组时服务层响亮失败（契约破损不当成没有数据）', async () => {
    // Given 上游回一个对象体（不是事件数组）
    const baseUrl = await serve((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"events":[]}')
    })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl })

    // When / Then 抛 TypeError（形状破损），调用方不会拿到空会议列表
    await expect(service.listFomcMeetings()).rejects.toThrow('expected a JSON array of events')
  })

  it('运营看到上游真的没有会议时得到空列表（这是唯一的合法空态）', async () => {
    // Given 上游回合法空数组
    const baseUrl = await serve((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
    })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl })

    // When 取数
    const feed = await service.listFomcMeetings()

    // Then 空会议 + 仍有 fetchedAt（成功与失败可区分）
    expect(feed.meetings).toEqual([])
    expect(feed.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('运营连续两次取数在真实文件上得到概率变动标注', async () => {
    // Given 两次响应概率不同（第二次 No change 从 0.835 降到 0.825）
    const snapshotPath = tempSnapshotPath()
    const second = JSON.parse(FIXTURE_BODY) as { markets: { groupItemTitle: string; outcomePrices: string }[] }[]
    const target = second[0]?.markets.find((market) => market.groupItemTitle === 'No change')
    if (target !== undefined) target.outcomePrices = '["0.825","0.175"]'
    let call = 0
    const baseUrl = await serve((_url, res) => {
      call += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(call === 1 ? FIXTURE_BODY : JSON.stringify(second))
    })
    const service = createPolymarketService(
      { enabled: true, timeoutMs: 5_000, snapshots: true, snapshotPath },
      { baseUrl, now: () => Date.parse('2026-10-11T02:00:00Z') },
    )

    // When 取两次
    const first = await service.listFomcMeetings()
    const later = await service.listFomcMeetings()

    // Then 第一次无 Δ、第二次 No change 档 −0.01，且盘上留下第二次读数
    expect(first.meetings[0]?.buckets.find((bucket) => bucket.key === 'no_change')?.changeSincePrevious).toBeUndefined()
    expect(later.meetings[0]?.buckets.find((bucket) => bucket.key === 'no_change')?.changeSincePrevious).toBe(-0.01)
    const onDisk = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { version: number; meetings: Record<string, Record<string, { probability: number }>> }
    expect(onDisk.version).toBe(SNAPSHOT_VERSION)
    expect(onDisk.meetings['606422']?.no_change?.probability).toBe(0.825)
  })

  it('运营遇到快照不可写时仍拿到完整概率，只是没有 Δ 标注（缺省而不是 0）', async () => {
    // Given 快照路径落在一个不可写的文件下（父路径是普通文件），但上游正常
    const dir = mkdtempSync(join(tmpdir(), 'dsh-poly-bad-'))
    dirs.push(dir)
    const blocked = join(dir, 'blocked-file')
    writeFileSync(blocked, 'x', 'utf8')
    const baseUrl = await serve((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(FIXTURE_BODY)
    })
    const service = createPolymarketService(
      { enabled: true, timeoutMs: 5_000, snapshots: true, snapshotPath: join(blocked, 'nested', 'snapshots.json') },
      { baseUrl, now: () => Date.parse('2026-10-11T02:00:00Z') },
    )

    // When 取数（快照读写都会失败）
    const feed = await service.listFomcMeetings()

    // Then 概率依然完整正确，Δ 缺省（不填 0 冒充「确知没变」）
    expect(feed.meetings).toHaveLength(3)
    expect(feed.meetings[0]?.buckets.find((bucket) => bucket.key === 'no_change')).toMatchObject({ probability: 0.835 })
    expect(feed.meetings[0]?.buckets.every((bucket) => !('changeSincePrevious' in bucket))).toBe(true)
  })

  it('运营看到快照存储自身在坏路径上读盘也失败（判据存在，不是靠运气）', async () => {
    // Given 同上坏路径
    const dir = mkdtempSync(join(tmpdir(), 'dsh-poly-bad2-'))
    dirs.push(dir)
    const blocked = join(dir, 'blocked-file')
    writeFileSync(blocked, 'x', 'utf8')
    const store = new SnapshotStore({ filePath: join(blocked, 'nested', 'snapshots.json') })

    // When / Then 快照层抛错（由服务层捕获降级），错误是文件系统层面的真实失败
    await expect(store.annotate([], '2026-10-11T00:00:00.000Z')).rejects.toThrow()
  })
})

describe('插件行（provide tradingPredictionFeed）', () => {
  it('运营看到服务键固定为 tradingPredictionFeed（桥按该键解析）', () => {
    // Given / When / Then 键名是跨包契约，改动会静默让桥拿不到服务
    expect(TRADING_PREDICTION_FEED_KEY).toBe('tradingPredictionFeed')
  })

  it('运营安装并启用连接器时拿到一份可用的服务对象', () => {
    // Given 一个假 ctx（只记 provide / register 调用；不是 mock 库，是注入的宿主面）+ 真实上游不可达亦不影响挂载
    const { ctx, provided, registered } = fakeHostContext()

    // When 按配置 apply（apply 只注册服务与工具，不发请求——上游故障不该阻止挂载）
    apply(ctx, { ...Config({}), enabled: true, snapshots: false })

    // Then provide 了服务键、注册了三个只读工具，且服务面暴露取数方法
    expect(provided).toHaveLength(1)
    expect(provided[0]?.key).toBe(TRADING_PREDICTION_FEED_KEY)
    const service = provided[0]?.value as { listFomcMeetings(): Promise<unknown> }
    expect(typeof service.listFomcMeetings).toBe('function')
    expect(registered).toEqual(['prediction_fomc_meetings', 'prediction_search_events', 'prediction_event_detail'])
  })

  it('运营看到已注册的同名工具不被覆盖（先到先得，不抛错）', () => {
    // Given 宿主上已经有人占了第一个工具名
    const { ctx, registered } = fakeHostContext(['prediction_fomc_meetings'])

    // When apply
    apply(ctx, { ...Config({}), enabled: true, snapshots: false })

    // Then 只注册了剩下两个（同名先到先得，绝不重复注册）
    expect(registered).toEqual(['prediction_search_events', 'prediction_event_detail'])
  })

  it('运营把连接器 enabled 设为 false 时零 provide 零注册（服务缺席由桥报 TRADING_NOT_IMPLEMENTED）', () => {
    // Given 禁用配置
    const { ctx, provided, registered } = fakeHostContext()

    // When apply
    apply(ctx, { ...Config({}), enabled: false })

    // Then 一个服务、一个工具都没注册
    expect(provided).toEqual([])
    expect(registered).toEqual([])
  })

  it('运营看到服务面只暴露会议面与历史面两个只读方法（不含任何交易/下单面）', async () => {
    // Given 上游按实测响应回包
    const baseUrl = await serve((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(FIXTURE_BODY)
    })

    // When 构造服务面
    const feed = createPolymarketPredictionFeed(createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl }))

    // Then 只有两个只读方法（PredictionFeedService 的两个必填面），返回契约形状
    expect(Object.keys(feed)).toEqual(['listFomcMeetings', 'listPriceHistory'])
    const snapshot = await feed.listFomcMeetings()
    expect(snapshot.meetings[0]?.buckets[0]).toMatchObject({ key: 'dec_50plus', probability: 0.0015 })
  })

  it('运营看到解析出的档位与另一次独立解析完全一致（同一响应两次解析不漂移）', async () => {
    // Given 同一份实测响应
    const baseUrl = await serve((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(FIXTURE_BODY)
    })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl, now: () => Date.parse('2026-10-11T01:55:19Z') })

    // When 一条走服务、一条走纯函数
    const viaService = await service.listFomcMeetings()
    const viaPure = discoverFomcMeetings(JSON.parse(FIXTURE_BODY)).meetings

    // Then 逐字段相同（服务层没有第二套判据）
    expect(viaService.meetings).toEqual(viaPure)
  })
})

/* ------------------------------------------------------------------ */
/* 历史回填面（gamma /events + CLOB /prices-history 同一个本地上游）   */
/* ------------------------------------------------------------------ */

/** 一个上游回包（状态码 + content-type + 体）。 */
interface UpstreamReply {
  readonly status: number
  readonly contentType: string
  readonly body: string
}

function jsonReply(body: string): UpstreamReply {
  return { status: 200, contentType: 'application/json', body }
}

/**
 * 同时服务两个读取面的本地上游：`/events` 回给定会议体，`/prices-history` 按 `market`
 * 逐档回读数（`history` 覆写可让某一档失败或为空）。
 */
async function serveBoth(options: {
  readonly events: UpstreamReply
  readonly history?: (token: string) => UpstreamReply
}): Promise<string> {
  return serve((url, res) => {
    if (url.startsWith('/prices-history')) {
      const token = new URL(url, 'http://local').searchParams.get('market') ?? ''
      const reply = options.history?.(token) ?? jsonReply(historyBody(token))
      res.writeHead(reply.status, { 'content-type': reply.contentType })
      res.end(reply.body)
      return
    }
    res.writeHead(options.events.status, { 'content-type': options.events.contentType })
    res.end(options.events.body)
  })
}

/** 实测夹具 + 按上游顺序给 market 注入 clobTokenIds（undefined = 这个 market 不带该字段）。 */
function eventsWithTokens(tokens: readonly (string | undefined)[]): string {
  const events = JSON.parse(FIXTURE_BODY) as { markets: Record<string, unknown>[] }[]
  const markets = events[0]?.markets ?? []
  markets.forEach((market, index) => {
    const token = tokens[index]
    if (token !== undefined) market.clobTokenIds = JSON.stringify([token, `${token}-complement`])
  })
  return JSON.stringify(events)
}

const OPEN_MEETING_ID = '606422'
/** 与上游顺序（= 排序后的档位顺序）一一对应的 5 个 token。 */
const TOKENS: readonly string[] = ['tok-0', 'tok-1', 'tok-2', 'tok-3', 'tok-4']
const BUCKET_ORDER = ['dec_50plus', 'dec_25', 'no_change', 'inc_25', 'inc_50plus'] as const

/** 每个 token 一组可定位的读数（0.10 / 0.20 …）。 */
function historyBody(token: string): string {
  const index = TOKENS.indexOf(token)
  const p = Number((0.1 * (index + 1)).toFixed(2))
  return JSON.stringify({ history: [{ t: 1791000000, p }, { t: 1791000300, p }] })
}

const HISTORY_FROM_MS = Date.parse('2026-10-19T05:00:00Z')
const HISTORY_TO_MS = Date.parse('2026-10-20T05:00:00Z')

describe('历史回填面（PolymarketService.listPriceHistory）', () => {
  it('运营取一场开放会议的一天历史时拿到逐档序列（一档一次请求、顺序与档位一致）', async () => {
    // Given 上游同时服务会议面与历史面，且每个档位都带 clobTokenIds
    const baseUrl = await serveBoth({ events: jsonReply(eventsWithTokens(TOKENS)) })
    const service = createPolymarketService(
      { ...NO_SNAPSHOT },
      { baseUrl, clobBaseUrl: baseUrl, now: () => Date.parse('2026-10-20T05:00:00Z') },
    )

    // When 取这一天（不带 fidelity，走缺省）
    const history = await service.listPriceHistory({ meetingId: OPEN_MEETING_ID, fromMs: HISTORY_FROM_MS, toMs: HISTORY_TO_MS })

    // Then 契约形状回述窗口、缺省粒度 5 分钟、序列按档位顺序
    expect(history.fetchedAt).toBe('2026-10-20T05:00:00.000Z')
    expect(history.meetingId).toBe(OPEN_MEETING_ID)
    expect(history.fromMs).toBe(HISTORY_FROM_MS)
    expect(history.toMs).toBe(HISTORY_TO_MS)
    expect(history.fidelityMinutes).toBe(5)
    expect(history.series.map((series) => series.bucketKey)).toEqual([...BUCKET_ORDER])
    expect(history.series[0]?.points).toEqual([{ t: 1791000000, p: 0.1 }, { t: 1791000300, p: 0.1 }])
    expect(history.series[4]?.points).toEqual([{ t: 1791000000, p: 0.5 }, { t: 1791000300, p: 0.5 }])

    // Then 会议面只打一次，历史面一档一次，且 URL 参数逐项正确
    expect(requests.filter((url) => url.startsWith('/events'))).toHaveLength(1)
    const historyRequests = requests.filter((url) => url.startsWith('/prices-history'))
    expect(historyRequests).toHaveLength(5)
    expect(historyRequests.map((url) => new URL(url, 'http://local').searchParams.get('market'))).toEqual([...TOKENS])
    const firstQuery = new URL(historyRequests[0] ?? '', 'http://local').searchParams
    expect(firstQuery.get('startTs')).toBe(String(Math.floor(HISTORY_FROM_MS / 1000)))
    expect(firstQuery.get('endTs')).toBe(String(Math.floor(HISTORY_TO_MS / 1000)))
    expect(firstQuery.get('fidelity')).toBe('5')
  })

  it('运营请求历史时只对拿到 token 的档位扇出（缺定位键的档位不发请求、也不造空序列）', async () => {
    // Given 五个档位里只有三个带 clobTokenIds
    const baseUrl = await serveBoth({ events: jsonReply(eventsWithTokens(['tok-0', undefined, 'tok-2', undefined, 'tok-4'])) })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl, clobBaseUrl: baseUrl })

    // When 取历史
    const history = await service.listPriceHistory({ meetingId: OPEN_MEETING_ID, fromMs: HISTORY_FROM_MS, toMs: HISTORY_TO_MS })

    // Then 只有三档出现在序列里，且正好三次请求（没有 market= 的空请求）
    expect(history.series.map((series) => series.bucketKey)).toEqual(['dec_50plus', 'no_change', 'inc_50plus'])
    const historyRequests = requests.filter((url) => url.startsWith('/prices-history'))
    expect(historyRequests).toHaveLength(3)
    expect(historyRequests.map((url) => new URL(url, 'http://local').searchParams.get('market'))).toEqual(['tok-0', 'tok-2', 'tok-4'])
  })

  it('运营看到上游 200 空 history 时该档是空序列、整体仍然成功（空不是失败）', async () => {
    // Given No change 档的 token 回了 Q5.2 的静默空体
    const baseUrl = await serveBoth({
      events: jsonReply(eventsWithTokens(TOKENS)),
      history: (token) => token === 'tok-2' ? jsonReply('{"history":[]}') : jsonReply(historyBody(token)),
    })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl, clobBaseUrl: baseUrl })

    // When 取历史
    const history = await service.listPriceHistory({ meetingId: OPEN_MEETING_ID, fromMs: HISTORY_FROM_MS, toMs: HISTORY_TO_MS })

    // Then 该档 points 为空但整体成功，其余四档读数照常（空不等于失败，也不补假点）
    expect(history.series.find((series) => series.bucketKey === 'no_change')?.points).toEqual([])
    expect(history.series.filter((series) => series.points.length > 0)).toHaveLength(4)
    expect(requests.filter((url) => url.startsWith('/prices-history'))).toHaveLength(5)
  })

  it('运营看到任一档取数失败时整体响亮失败（绝不返回少一档的图）', async () => {
    // Given inc_25 档的 token 上游 500
    const baseUrl = await serveBoth({
      events: jsonReply(eventsWithTokens(TOKENS)),
      history: (token) => token === 'tok-3'
        ? { status: 500, contentType: 'text/plain', body: 'internal error' }
        : jsonReply(historyBody(token)),
    })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl, clobBaseUrl: baseUrl })

    // When / Then 整块拒绝，错误里指名是哪一档失败（不悄悄少一档）
    await expect(service.listPriceHistory({ meetingId: OPEN_MEETING_ID, fromMs: HISTORY_FROM_MS, toMs: HISTORY_TO_MS })).rejects.toMatchObject({
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'polymarket prediction price history: bucket inc_25 failed — polymarket clob /prices-history: HTTP 500 — internal error',
    })
  })

  it('运营请求超过 336h 的窗口时连接器本地拒发（上游零请求）', async () => {
    // Given 一个会记录请求的上游 + 超出上游硬边界的窗口（336h + 1h）
    const baseUrl = await serveBoth({ events: jsonReply(eventsWithTokens(TOKENS)) })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl, clobBaseUrl: baseUrl })

    // When / Then 抛 TRADING_UNSUPPORTED_INTERVAL，且 gamma 与 CLOB 一个请求都没发
    await expect(service.listPriceHistory({
      meetingId: OPEN_MEETING_ID,
      fromMs: HISTORY_FROM_MS,
      toMs: HISTORY_FROM_MS + PRICE_HISTORY_MAX_WINDOW_MS + 3600_000,
    })).rejects.toMatchObject({
      code: 'TRADING_UNSUPPORTED_INTERVAL',
      message: `polymarket clob /prices-history: window ${PRICE_HISTORY_MAX_WINDOW_MS + 3600_000}ms exceeds the upstream limit of ${PRICE_HISTORY_MAX_WINDOW_MS}ms (336h) — not sent`,
    })
    expect(requests).toEqual([])
  })

  it('运营请求非法粒度时连接器本地拒发（上游零请求）', async () => {
    // Given 一个会记录请求的上游
    const baseUrl = await serveBoth({ events: jsonReply(eventsWithTokens(TOKENS)) })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl, clobBaseUrl: baseUrl })

    // When / Then fidelity 0 拒发（CLOB 没有「零分钟粒度」这种东西）
    await expect(service.listPriceHistory({
      meetingId: OPEN_MEETING_ID,
      fromMs: HISTORY_FROM_MS,
      toMs: HISTORY_TO_MS,
      fidelityMinutes: 0,
    })).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
    expect(requests).toEqual([])
  })

  it('运营请求不在开放会议集合里的 meetingId 时看到结构性查不到错误（不拿空序列冒充）', async () => {
    // Given 上游回三场开放会议
    const baseUrl = await serveBoth({ events: jsonReply(FIXTURE_BODY) })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl, clobBaseUrl: baseUrl })

    // When / Then 查不到 = TRADING_SYMBOL_NOT_FOUND，只打过一次 gamma、零历史请求
    await expect(service.listPriceHistory({ meetingId: '999999', fromMs: HISTORY_FROM_MS, toMs: HISTORY_TO_MS })).rejects.toMatchObject({
      code: 'TRADING_SYMBOL_NOT_FOUND',
      message: 'polymarket prediction price history: meeting 999999 is not an FOMC decision meeting (looked up 3 open meetings)',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.startsWith('/events')).toBe(true)
  })

  it('运营连续两次要历史时第二次复用短 TTL 内的会议发现（面板换事件不重复打 gamma）', async () => {
    // Given 一个可控时钟与同时服务两个面的上游
    const baseUrl = await serveBoth({ events: jsonReply(eventsWithTokens(TOKENS)) })
    let clock = Date.parse('2026-10-20T05:00:00Z')
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl, clobBaseUrl: baseUrl, now: () => clock })

    // When 同一时刻连取两次，再推进过 TTL 取第三次
    const first = await service.listPriceHistory({ meetingId: OPEN_MEETING_ID, fromMs: HISTORY_FROM_MS, toMs: HISTORY_TO_MS })
    const second = await service.listPriceHistory({ meetingId: OPEN_MEETING_ID, fromMs: HISTORY_FROM_MS, toMs: HISTORY_TO_MS })
    const gammaAfterTwo = requests.filter((url) => url.startsWith('/events')).length
    clock += MEETING_LOOKUP_TTL_MS
    const third = await service.listPriceHistory({ meetingId: OPEN_MEETING_ID, fromMs: HISTORY_FROM_MS, toMs: HISTORY_TO_MS })

    // Then TTL 内只打一次 gamma，过期后重打一次；序列内容不受缓存影响
    expect(gammaAfterTwo).toBe(1)
    expect(requests.filter((url) => url.startsWith('/events'))).toHaveLength(2)
    expect(second.series).toEqual(first.series)
    expect(third.series).toEqual(first.series)
  })

  it('运营看到会议面取数失败时历史面也失败（不降级成空序列）', async () => {
    // Given 会议面被 Cloudflare 拦成 403
    const baseUrl = await serveBoth({
      events: { status: 403, contentType: 'text/plain; charset=UTF-8', body: 'error code: 1010\n' },
    })
    const service = createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl, clobBaseUrl: baseUrl })

    // When / Then 失败向上抛（TRADING_UPSTREAM_ERROR），没有历史请求发出去
    await expect(service.listPriceHistory({ meetingId: OPEN_MEETING_ID, fromMs: HISTORY_FROM_MS, toMs: HISTORY_TO_MS })).rejects.toMatchObject({
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'polymarket gamma /events: HTTP 403 — error code: 1010',
    })
    expect(requests.filter((url) => url.startsWith('/prices-history'))).toEqual([])
  })

  it('运营通过服务面要历史时拿到同一份逐档序列（桥只依赖 PredictionFeedService）', async () => {
    // Given 同时服务两个面的上游 + 服务面对象
    const baseUrl = await serveBoth({ events: jsonReply(eventsWithTokens(TOKENS)) })
    const feed = createPolymarketPredictionFeed(createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl, clobBaseUrl: baseUrl }))

    // When 经服务面取历史
    const history = await feed.listPriceHistory({ meetingId: OPEN_MEETING_ID, fromMs: HISTORY_FROM_MS, toMs: HISTORY_TO_MS })

    // Then 五档序列与 fetchedAt 齐备（PredictionFeedService 的必填方法真的接上了）
    expect(history.series).toHaveLength(5)
    expect(history.series.map((series) => series.bucketKey)).toEqual([...BUCKET_ORDER])
    expect(history.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

