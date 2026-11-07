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
import { TRADING_PREDICTION_FEED_KEY, createPolymarketPredictionFeed } from '../src/service.ts'
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

  it('运营看到服务面只暴露 listFomcMeetings（不含任何交易/下单面）', async () => {
    // Given 上游按实测响应回包
    const baseUrl = await serve((_url, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(FIXTURE_BODY)
    })

    // When 构造服务面
    const feed = createPolymarketPredictionFeed(createPolymarketService({ ...NO_SNAPSHOT }, { baseUrl }))

    // Then 只有一个只读方法，返回契约形状
    expect(Object.keys(feed)).toEqual(['listFomcMeetings'])
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
