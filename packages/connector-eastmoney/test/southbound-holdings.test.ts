/**
 * 港股通持股历史（冻结契约 A 的连接器侧，2026-10-13）。
 *
 * 两层证据，缺一不可：
 * 1. 真实网络：直连东财数据中心 datacenter-web 跑真实响应。探测在模块加载时做一次
 *    （顶层 await 一次裸 fetch，不经过被测代码——否则代码自身的 bug 会被误判成
 *    「网络不可用」而假绿）。不可达时整块 describe.skip 并打印原因。
 * 2. 契约解析：内联**真实捕获**的响应原文（捕获命令见下），覆盖去重、UTC 口径、
 *    空序列与上游故障码；比例列缺失等历史中未出现的分支用显式标注的边界样例。
 *    注入 fetchImpl 是函数缝（本仓既有手法），不是 mock 库。
 *
 * 捕获命令（2026-10-13，本文件夹具即其返回值摘录）：
 *   curl -sS -H 'Referer: https://data.eastmoney.com/' \
 *     -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)' \
 *     'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_MUTUAL_STOCK_HOLDRANKS&columns=ALL&filter=(SECURITY_CODE%3D%2200700%22)(MUTUAL_TYPE%3D%22002%22)&pageSize=1000&pageNumber=1&sortColumns=HOLD_DATE&sortTypes=1&source=WEB&client=WEB'
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import { apply as applyDataplane } from '../src/dataplane.js'
import { EastmoneyMarketDataService } from '../src/index.js'
import { EastmoneyRestClient } from '../src/rest.js'
import { createFakeClock } from './support/fake-clock.js'

/* ------------------------------------------------------------------ */
/* 真实网络探测（不经被测代码）                                          */
/* ------------------------------------------------------------------ */

/** 探针 URL 与被测代码同参，但独立书写：它只回答「这个端点现在通不通」。 */
const PROBE_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
  + '?reportName=RPT_MUTUAL_STOCK_HOLDRANKS&columns=ALL'
  + `&filter=${encodeURIComponent('(SECURITY_CODE="00700")(MUTUAL_TYPE="002")')}`
  + '&pageSize=1&pageNumber=1&sortColumns=HOLD_DATE&sortTypes=1&source=WEB&client=WEB'

interface LiveProbe { ok: boolean; reason: string }

async function probeDatacenter(): Promise<LiveProbe> {
  try {
    const res = await globalThis.fetch(PROBE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Referer': 'https://data.eastmoney.com/',
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    const body = await res.json() as { result?: { data?: unknown } }
    const rows = body.result?.data
    return Array.isArray(rows) && rows.length > 0
      ? { ok: true, reason: 'ok' }
      : { ok: false, reason: '端点可达但未返回数据行' }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

const liveProbe = await probeDatacenter()
const liveDescribe = liveProbe.ok ? describe : describe.skip
if (!liveProbe.ok) {
  console.warn(`[skip] 东财数据中心不可达（${liveProbe.reason}）：真实网络用例已显式跳过，本轮未做联网验证。`)
}

/* ------------------------------------------------------------------ */
/* 真实捕获的响应夹具（原文摘录：只保留本解析读取的列）                   */
/* ------------------------------------------------------------------ */

/** 实测 00700 / MUTUAL_TYPE=002 首行（2024-10-14）：比例列取自 HOLD_SHARES_RATIO。 */
const CAPTURED_FIRST_ROW = {
  MUTUAL_TYPE: '002',
  HOLD_DATE: '2024-10-14 00:00:00',
  SECURITY_NAME: '腾讯控股',
  SECURITY_CODE: '00700',
  HOLD_MARKET_CAP: 395302987408,
  HOLD_SHARES: 906658228,
  TOTAL_SHARES_RATIO: 1.8133,
  HOLD_SHARES_RATIO: 9.76,
}

/**
 * 实测同一日 002/004 两行并存（2026-10-08、2026-10-09 各两行，数值完全相同）——
 * 这是「必须按交易日去重」的真实证据，来自不带 MUTUAL_TYPE 的同一端点查询。
 */
const CAPTURED_DUPLICATE_ROWS = [
  { MUTUAL_TYPE: '002', HOLD_DATE: '2026-10-08 00:00:00', HOLD_SHARES_RATIO: 11.9, HOLD_SHARES: 1082672910, HOLD_MARKET_CAP: 445411635174 },
  { MUTUAL_TYPE: '004', HOLD_DATE: '2026-10-08 00:00:00', HOLD_SHARES_RATIO: 11.9, HOLD_SHARES: 1082672910, HOLD_MARKET_CAP: 445411635174 },
  { MUTUAL_TYPE: '002', HOLD_DATE: '2026-10-09 00:00:00', HOLD_SHARES_RATIO: 11.9, HOLD_SHARES: 1082672910, HOLD_MARKET_CAP: 459919452168 },
  { MUTUAL_TYPE: '004', HOLD_DATE: '2026-10-09 00:00:00', HOLD_SHARES_RATIO: 11.9, HOLD_SHARES: 1082672910, HOLD_MARKET_CAP: 459919452168 },
]

/** 实测非港股通标的（08083）原文：**不是** 0，也不是故障码。 */
const CAPTURED_EMPTY_BODY = { version: null, result: null, success: false, message: '返回数据为空', code: 9201 }

/** 实测上游协议错误原文（报表名/列名不存在时）。 */
const CAPTURED_PROTOCOL_ERROR_BODY = { version: null, result: null, success: false, message: '报表配置不存在,RPT_NO_SUCH_REPORT', code: 9501 }

function okBody(rows: unknown[]): Record<string, unknown> {
  return { version: 'test', result: { pages: 1, count: rows.length, data: rows }, success: true, message: 'ok', code: 0 }
}

/** 注入式函数缝：记录请求 URL 与请求头，返回给定报文（或抛错）。 */
function recordingFetch(body: unknown, status = 200): {
  impl: typeof fetch
  requests: Array<{ url: string; headers: Record<string, string> }>
} {
  const requests: Array<{ url: string; headers: Record<string, string> }> = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    requests.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { impl, requests }
}

function failingFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message)
  }) as typeof fetch
}

function makeCtx(): Context {
  return { reflect: { provide: () => {} } } as unknown as Context
}

/* ------------------------------------------------------------------ */
/* 真实网络：端到端取数                                                  */
/* ------------------------------------------------------------------ */

// 真实网络的边界不受用例控制：东财数据中心一次 1000 行响应在 CI runner 上
// 常常超过 vitest 默认的 5s（2026-10-21 在 ubuntu / windows 各红过一次），
// 超时被读成「取数逻辑坏了」是假红。这里给显式上限，仍是有界等待。
const LIVE_TIMEOUT_MS = 30_000

/**
 * 真实网络用例的客户端：单枪与整通预算按「跨洋 runner + 报表大报文」给。
 *
 * 2026-10-27 CI 实测：runner 到 data.eastmoney.com 首枪就吃满 2000ms 单枪上限，剩下
 * 772ms 的第二枪又超时，ubuntu 与 windows 同点红（同文件模块级探针用 20s 预算已确认
 * 端点可达）。缺省预算（2000/3000）是「快速判别空回」的硬上界，不该在真实网络用例里
 * 拿去卡 runner 的 RTT——预算这套契约由假时钟用例断言，这里要验的是真实报文的解析与语义。
 */
const LIVE_REQUEST_OPTIONS = { market: 'hk' as const, timeoutMs: 10_000, requestBudgetMs: 20_000 }

function liveClient(): EastmoneyRestClient {
  return new EastmoneyRestClient(LIVE_REQUEST_OPTIONS)
}

liveDescribe('港股通持股历史（真实网络，东财数据中心）', () => {
  it('用户查询腾讯控股的港股通持股历史时应拿到升序去重的多日序列', { timeout: LIVE_TIMEOUT_MS }, async () => {
    // Given: 东财数据中心可达（模块级探针已确认），00700.HK 是港股通标的
    const client = liveClient()

    // When: 港股实例按市场规范形取数
    const history = await client.getSouthboundHoldings('00700.HK')

    // Then: 拿到多年日频序列，按交易日升序、无重复、日期落在 UTC 当日零点、比例在合理区间
    expect(history.symbol).toBe('00700.HK')
    expect(history.points.length).toBeGreaterThan(400)
    const dates = history.points.map((p) => p.date)
    expect(dates).toEqual([...dates].sort((a, b) => a - b))
    expect(new Set(dates).size).toBe(dates.length)
    expect(dates.every((d) => d % 86_400_000 === 0)).toBe(true)
    expect(history.points.every((p) => p.holdRatio > 0 && p.holdRatio <= 100)).toBe(true)
    expect(history.points.at(-1)?.date).toBeGreaterThanOrEqual(Date.UTC(2026, 0, 1))
  })

  it('用户以连接器原生形查询港股通持股时应归一为市场规范形', { timeout: LIVE_TIMEOUT_MS }, async () => {
    // Given: 港股实例，用户传的是东财原生 5 位码（不带后缀）
    const client = liveClient()

    // When: 按裸码取数
    const history = await client.getSouthboundHoldings('700')

    // Then: 输出 symbol 是市场规范词汇，且序列非空（与规范形查询同一条序列）
    expect(history.symbol).toBe('00700.HK')
    expect(history.points.length).toBeGreaterThan(400)
  })

  it('用户查询非港股通标的的持股时应拿到空序列而不是报错', { timeout: LIVE_TIMEOUT_MS }, async () => {
    // Given: 08083.HK 实测不在港股通范围（上游返回 result: null）
    const client = liveClient()

    // When: 取该标的的持股历史
    const history = await client.getSouthboundHoldings('08083.HK')

    // Then: 空序列而不抛错——消费方据此隐藏副图，而不是画一条 0 值假线
    expect(history.symbol).toBe('08083.HK')
    expect(history.points).toEqual([])
  })

  it('用户经港股行情服务取持股时应拿到与 REST 客户端一致的序列', async () => {
    // Given: 港股数据面实例（与 dataplane 注册的是同一个类）
    const service = new EastmoneyMarketDataService(makeCtx(), LIVE_REQUEST_OPTIONS, 'tradingHkMarketData')

    // When: 从服务层取数
    const history = await service.getSouthboundHoldings?.('00700.HK')

    // Then: 可选方法在 hk 实例上存在，且返回真实序列
    expect(history?.symbol).toBe('00700.HK')
    expect(history?.points.length).toBeGreaterThan(400)
  })

  it('用户从数据面注册表取到的港股服务应带港股通持股能力', async () => {
    // Given: 数据面按 hk 注册（宿主桥就是按 registry.list('hk') 找这项能力的）
    const registrations: Array<{ market: string; provider: string; service: MarketDataService }> = []
    const ctx = {
      get: (key: string) => (key === 'tradingMarketDataRegistry'
        ? {
            register: (market: string, provider: string, service: MarketDataService) => {
              registrations.push({ market, provider, service })
              return () => {}
            },
          }
        : undefined),
      isolate: () => ({ reflect: { provide: () => {} } }),
      effect: (fn: () => () => void) => { fn() },
      reflect: { provide: () => {} },
    } as unknown as Context
    applyDataplane(ctx, { enabled: true, market: 'hk' })

    // When: 从注册表取注册出去的那一项
    const registered = registrations[0]
    const service = registered?.service as EastmoneyMarketDataService | undefined

    // Then: 市场是 hk，且注册出去的就是东财服务、上面带着港股通持股能力（cn 实例必须
    // 缺席，见上一组契约用例）。真实取数路径由前两条联网用例覆盖：dataplane 按行配置
    // new 同一个类、同一份 `{ market: 'hk' }` 选项，这里再拉一次全量报文只多一次跨洋
    // 往返、不多验任何一行代码，却要多一份「runner 到东财 3-6s」的抖动面。
    expect(registered?.market).toBe('hk')
    expect(service).toBeInstanceOf(EastmoneyMarketDataService)
    expect(typeof service?.getSouthboundHoldings).toBe('function')
  })
})

/* ------------------------------------------------------------------ */
/* 契约解析（真实捕获响应）                                              */
/* ------------------------------------------------------------------ */

describe('港股通持股历史解析契约（真实捕获响应）', () => {
  it('用户读取持股比例时应取 HOLD_SHARES_RATIO 而不是 TOTAL_SHARES_RATIO', async () => {
    // Given: 实测首行同时带 HOLD_SHARES_RATIO=9.76 与 TOTAL_SHARES_RATIO=1.8133
    const { impl } = recordingFetch(okBody([CAPTURED_FIRST_ROW]))
    const client = new EastmoneyRestClient({ market: 'hk', fetchImpl: impl })

    // When: 取该日持股快照
    const history = await client.getSouthboundHoldings('00700.HK')

    // Then: 比例为 9.76（占总股本口径），日期是 UTC 当日零点而非本地时区偏移
    expect(history.points).toHaveLength(1)
    expect(history.points[0]).toEqual({
      date: Date.UTC(2024, 9, 14),
      holdRatio: 9.76,
      holdShares: 906658228,
      holdMarketCap: 395302987408,
    })
  })

  it('用户查询返回 002/004 两行的交易日时应只拿到一个数据点', async () => {
    // Given: 实测同一交易日 002 与 004 各一行且数值相同
    const { impl } = recordingFetch(okBody(CAPTURED_DUPLICATE_ROWS))
    const client = new EastmoneyRestClient({ market: 'hk', fetchImpl: impl })

    // When: 解析这批重复行
    const history = await client.getSouthboundHoldings('00700.HK')

    // Then: 每交易日至多一条，且按日期升序（旧→新）
    expect(history.points).toHaveLength(2)
    expect(history.points.map((p) => p.date)).toEqual([Date.UTC(2026, 9, 8), Date.UTC(2026, 9, 9)])
    expect(history.points.map((p) => p.holdRatio)).toEqual([11.9, 11.9])
  })

  it('用户查询非港股通标的时应拿到空序列而不是零值点', async () => {
    // Given: 实测非标的报文（result: null、业务码 9201「返回数据为空」）
    const { impl } = recordingFetch(CAPTURED_EMPTY_BODY)
    const client = new EastmoneyRestClient({ market: 'hk', fetchImpl: impl })

    // When: 查询 08083.HK
    const history = await client.getSouthboundHoldings('08083.HK')

    // Then: 空 points、symbol 仍是规范形（空 ≠ 0）
    expect(history).toEqual({ symbol: '08083.HK', points: [] })
  })

  it('用户遇到上游业务错误码时应拿到抛出的错误而不是空序列', async () => {
    // Given: 实测协议错误报文（9000 段业务码 9501：报表配置不存在）
    const { impl } = recordingFetch(CAPTURED_PROTOCOL_ERROR_BODY)
    const client = new EastmoneyRestClient({ market: 'hk', fetchImpl: impl })

    // When: 取数
    const pending = client.getSouthboundHoldings('00700.HK')

    // Then: 抛上游错误（不把故障当成「无数据」静默吞掉）
    await expect(pending).rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
    await expect(pending).rejects.toThrowError(/9501/)
  })

  it('用户遇到 HTTP 失败时应拿到上游错误而不是空序列', async () => {
    // Given: 上游返回 500
    const { impl } = recordingFetch({ message: 'boom' }, 500)
    const client = new EastmoneyRestClient({ market: 'hk', fetchImpl: impl })

    // When: 取数
    const pending = client.getSouthboundHoldings('00700.HK')

    // Then: 抛上游错误
    await expect(pending).rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
  })

  it('用户遇到连接失败时应拿到网络错误而不是空序列', async () => {
    // Given: 传输层直接抛错（DNS/连接失败形态）
    const client = new EastmoneyRestClient({
      market: 'hk',
      fetchImpl: failingFetch('getaddrinfo ENOTFOUND datacenter-web.eastmoney.com'),
      clock: createFakeClock(),
    })

    // When: 取数
    const pending = client.getSouthboundHoldings('00700.HK')

    // Then: 抛网络错误并保留 cause
    await expect(pending).rejects.toMatchObject({ code: 'TRADING_NETWORK' })
  })

  it('用户在单页装不下整段历史时应拿到抛出的错误而不是半截序列', async () => {
    // Given: 报文声明还有第 2 页（pages=2）
    const { impl } = recordingFetch({ version: 'x', result: { pages: 2, count: 1500, data: [CAPTURED_FIRST_ROW] }, success: true, message: 'ok', code: 0 })
    const client = new EastmoneyRestClient({ market: 'hk', fetchImpl: impl })

    // When: 取数
    const pending = client.getSouthboundHoldings('00700.HK')

    // Then: fail-loud（不静默给半截序列让副图画错）
    await expect(pending).rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
    await expect(pending).rejects.toThrowError(/pagination overflow/)
  })

  it('用户在比例列缺失的交易日上不应拿到 0 值点', async () => {
    // Given: 边界样例（历史真实数据未出现比例缺失，为契约兜底构造）：一行比例 null、一行比例正常
    const { impl } = recordingFetch(okBody([
      { MUTUAL_TYPE: '002', HOLD_DATE: '2026-10-08 00:00:00', HOLD_SHARES_RATIO: null, HOLD_SHARES: null, HOLD_MARKET_CAP: null },
      { MUTUAL_TYPE: '002', HOLD_DATE: '2026-10-09 00:00:00', HOLD_SHARES_RATIO: 11.9, HOLD_SHARES: 1082672910, HOLD_MARKET_CAP: 459919452168 },
    ]))
    const client = new EastmoneyRestClient({ market: 'hk', fetchImpl: impl })

    // When: 解析
    const history = await client.getSouthboundHoldings('00700.HK')

    // Then: 只保留有比例的交易日，缺失行整行跳过（绝不补 0）
    expect(history.points).toHaveLength(1)
    expect(history.points[0]?.date).toBe(Date.UTC(2026, 9, 9))
  })

  it('用户取持股时应带上 5 位无后缀代码与 data.eastmoney.com 的 Referer', async () => {
    // Given: 港股实例（报表主键是 5 位港股代码，且该域要求 data.eastmoney.com Referer）
    const { impl, requests } = recordingFetch(okBody([CAPTURED_FIRST_ROW]))
    const client = new EastmoneyRestClient({ market: 'hk', fetchImpl: impl })

    // When: 以规范形查询
    await client.getSouthboundHoldings('00700.HK')

    // Then: 请求打到 datacenter-web 报表端点，filter 用裸码、Referer 指向 data.eastmoney.com
    const request = requests[0]
    expect(request?.url).toContain('datacenter-web.eastmoney.com/api/data/v1/get')
    expect(request?.url).toContain('reportName=RPT_MUTUAL_STOCK_HOLDRANKS')
    expect(request?.url).toContain(`${encodeURIComponent('(SECURITY_CODE="00700")(MUTUAL_TYPE="002")')}`)
    expect(request?.url).not.toContain('00700.HK')
    expect(request?.headers.Referer).toBe('https://data.eastmoney.com/')
  })
})

/* ------------------------------------------------------------------ */
/* 服务层：能力只在 hk 实例上存在                                        */
/* ------------------------------------------------------------------ */

describe('东财行情服务的港股通持股能力', () => {
  it('用户在东财港股实例上应能取到港股通持股历史', async () => {
    // Given: hk 实例，注入的 fetch 返回真实捕获报文
    const { impl, requests } = recordingFetch(okBody([CAPTURED_FIRST_ROW]))
    const service = new EastmoneyMarketDataService(makeCtx(), { market: 'hk', fetchImpl: impl }, 'tradingHkMarketData')

    // When: 走服务层取数
    const history = await service.getSouthboundHoldings?.('700')

    // Then: 拿到规范形 symbol 与解析后的点
    expect(history?.symbol).toBe('00700.HK')
    expect(history?.points[0]?.holdRatio).toBe(9.76)
    expect(requests[0]?.url).toContain(`${encodeURIComponent('(SECURITY_CODE="00700")(MUTUAL_TYPE="002")')}`)
  })

  it('用户在东财 A 股实例上不应看到港股通持股能力', async () => {
    // Given: cn 实例（东财该报表只覆盖港股通标的）
    const cnService = new EastmoneyMarketDataService(makeCtx(), {}, 'tradingCnMarketData')

    // When: 探测该可选能力
    const capability = cnService.getSouthboundHoldings

    // Then: 方法缺席——消费方据此区分「无此能力」与「该标的无数据」
    expect(capability).toBeUndefined()
  })

  it('用户误用 A 股实例取港股通持股时应被显式拒绝', async () => {
    // Given: 直接拿 cn 形态的 REST 客户端调该 hk 专属端点
    const { impl } = recordingFetch(okBody([CAPTURED_FIRST_ROW]))
    const client = new EastmoneyRestClient({ market: 'cn', fetchImpl: impl })

    // When: 以 A 股代码调用
    const pending = client.getSouthboundHoldings('600519.SH')

    // Then: 抛「未实现」而不是拿 A 股代码去查港股报表
    await expect(pending).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
  })
})
