import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { EtfRescueService, groupSzseWindows, lastSettledDate, shanghaiDate } from '../src/etf-rescue-service.js'

/** 固定时钟：上海墙钟 2026-11-23 10:00（周一上午，已结算上界 = 2026-11-22）。 */
const NOW = new Date('2026-11-23T10:00:00+08:00')
/** 已结算的交易日（周一取上周四、周五）。 */
const TRADING_DAYS = ['2026-11-19', '2026-11-20']
const SSE_CODES = ['510050', '510300', '510310', '510330', '563360', '512050', '510500', '512100', '588000', '588080']
const SZSE_CODES = ['159919', '159338', '159922', '159845', '159915']
const SHARES = 1e9
const NAV = 1
const CLOSE = 4000
/** k = 1e10 元/点 → 每个指数流通市值 4e13 元。 */
const K = 1e10

interface FakeFetchOptions {
  readonly closes?: readonly string[] | undefined
  readonly failAll?: boolean | undefined
  readonly failCalibration?: boolean | undefined
}

function sheetOf(rows: readonly (readonly string[])[]): string {
  const header = ['日期', '基金代码', '基金简称', '基金规模(份)']
  const columns = ['A', 'B', 'C', 'D']
  const all: (readonly string[])[] = [header, ...rows]
  let body = ''
  for (let index = 0; index < all.length; index += 1) {
    const row = all[index] as readonly string[]
    const rowNumber = index + 1
    let cells = ''
    for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
      const ref = (columns[cellIndex] as string) + rowNumber
      cells += '<c r="' + ref + '" s="2" t="inlineStr"><is><t>' + (row[cellIndex] as string) + '</t></is></c>'
    }
    body += '<row r="' + rowNumber + '">' + cells + '</row>'
  }
  return '<worksheet><sheetData>' + body + '</sheetData></worksheet>'
}

/**
 * 契约化取数假面：按真实端点形态回应（SSE JSON / SZSE zip(xlsx) / 基金净值翻页 /
 * 腾讯 K 线 / 东财两个快照端点），并记录每个被请求的 URL 供断言「有没有重取」。
 * 不是通用 mock：每个分支都是上游真实响应骨架。
 */
function fakeUpstream(options: FakeFetchOptions = {}): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const days = options.closes ?? TRADING_DAYS
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const isCalibration = url.includes('/api/qt/stock/get') || url.includes('/api/qt/ulist.np/get')
    if (isCalibration) {
      if (options.failCalibration === true) return new Response('gone', { status: 502 })
      if (url.includes('/api/qt/stock/get')) return new Response('transport-empty', { status: 502 })
      return json({ data: { total: 1, diff: [{ f2: CLOSE * 100, f12: '000300', f21: CLOSE * K }] } })
    }
    if (options.failAll === true) return new Response('boom', { status: 500 })
    if (url.includes('query.sse.com.cn')) {
      const date = /STAT_DATE=(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? ''
      const rows = TRADING_DAYS.includes(date)
        ? SSE_CODES.map((code) => ({ STAT_DATE: date, SEC_CODE: code, TOT_VOL: String(SHARES / 10_000) }))
        : []
      return json({ result: rows, pageHelp: { total: rows.length } })
    }
    if (url.includes('www.szse.cn')) {
      const start = /txtStart=(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? ''
      const end = /txtEnd=(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? ''
      const rows: string[][] = []
      for (const day of TRADING_DAYS.filter((value) => value >= start && value <= end)) {
        for (const code of SZSE_CODES) rows.push([day, code + ' ', 'ETF', String(SHARES) + '.00'])
      }
      return new Response(zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheetOf(rows)) }), { status: 200 })
    }
    if (url.includes('fund.eastmoney.com')) {
      const page = Number(/pageIndex=(\d+)/.exec(url)?.[1] ?? '1')
      const startDate = /startDate=([^&]*)/.exec(url)?.[1] ?? ''
      const available = TRADING_DAYS.filter((day) => day >= startDate)
      const rows = page === 1
        ? available.slice().reverse().map((day) => ({ FSRQ: day, DWJZ: String(NAV) + '.0000' }))
        : []
      return json({
        Data: rows.length === 0 ? null : { LSJZList: rows },
        ErrCode: 0,
        TotalCount: available.length,
      })
    }
    if (url.includes('ifzq.gtimg.cn')) {
      const key = /param=([a-z]{2}\d{6})/.exec(url)?.[1] ?? 'sh000300'
      const start = /day,(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})/.exec(url)
      const from = start?.[1] ?? ''
      const to = start?.[2] ?? ''
      const rows = days
        .filter((day) => day >= from && day <= to)
        .map((day) => [day, String(CLOSE) + '.000', String(CLOSE) + '.000', '4010.000', '3990.000', '1'])
      return json({ code: 0, msg: '', data: { [key]: { day: rows } } })
    }
    return new Response('unexpected ' + url, { status: 404 })
  }) as typeof fetch
  return { impl, urls }
}

const tempDirs: string[] = []

async function tempCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'etf-rescue-cache-'))
  tempDirs.push(dir)
  return dir
}

function serviceWith(cacheDir: string, impl: typeof fetch, extra: Record<string, unknown> = {}): EtfRescueService {
  return new EtfRescueService({
    cacheDir,
    fetchImpl: impl,
    now: () => NOW,
    calibrationDelayMs: 0,
    sleep: async () => {},
    timeoutMs: 5_000,
    ...extra,
  })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('getEtfRescue 端到端（契约化假上游）', () => {
  it('用户首次调用 000300.SH 拿到升序去重的深度/广度序列，并落盘缓存', async () => {
    // Given: 空缓存目录 + 五个端点都按真实形态响应的上游
    const cacheDir = await tempCacheDir()
    const upstream = fakeUpstream()
    const service = serviceWith(cacheDir, upstream.impl)

    // When: 调 getEtfRescue('000300.SH')
    const history = await service.getEtfRescue('000300.SH')

    // Then: 两个升序点；深度 = 4e9/4e13×100 = 0.01；广度 = 11e9/2.4e14×100
    expect(history.symbol).toBe('000300.SH')
    expect(history.indexCode).toBe('000300')
    expect(history.depthLabel).toBe('沪深300ETF')
    expect(history.points).toHaveLength(2)
    expect(history.points[0]?.date).toBe(Date.UTC(2026, 10, 19))
    expect(history.points[1]?.date).toBe(Date.UTC(2026, 10, 20))
    expect(history.points[0]?.depthPct).toBeCloseTo(0.01, 12)
    expect(history.points[0]?.breadthPct).toBeCloseTo((11e9 / (6 * 4e13)) * 100, 12)
    expect(upstream.urls.some((url) => url.includes('query.sse.com.cn'))).toBe(true)
    expect(upstream.urls.some((url) => url.includes('www.szse.cn'))).toBe(true)
    expect(upstream.urls.some((url) => url.includes('fund.eastmoney.com'))).toBe(true)
    expect(upstream.urls.some((url) => url.includes('ifzq.gtimg.cn'))).toBe(true)
    const sharesFile = JSON.parse(await readFile(join(cacheDir, 'shares', 'sse', '2026-11-20.json'), 'utf8')) as {
      shares: Record<string, number>
    }
    expect(sharesFile.shares['510300']).toBe(SHARES)
  })

  it('用户第二次调用命中全部缓存，一个上游请求都不发', async () => {
    // Given: 同一缓存目录先跑一遍，第二遍的上游对任何请求都回 500
    const cacheDir = await tempCacheDir()
    const warm = await serviceWith(cacheDir, fakeUpstream().impl).getEtfRescue('000300.SH')
    const upstream = fakeUpstream({ failAll: true })

    // When: 第二次调用
    const cached = await serviceWith(cacheDir, upstream.impl).getEtfRescue('000300.SH')

    // Then: 点数与读数一致，且没有任何 HTTP 请求
    expect(cached.points).toEqual(warm.points)
    expect(upstream.urls).toEqual([])
  })

  it('用户遇到 k 标定失败时沿用缓存里的上次 k，照常出点', async () => {
    // Given: 缓存已有一轮标定；第二遍 TTL 归零强制重标定，且东财两个端点都失败
    const cacheDir = await tempCacheDir()
    const warm = await serviceWith(cacheDir, fakeUpstream().impl).getEtfRescue('000300.SH')
    const upstream = fakeUpstream({ failAll: true, failCalibration: true })

    // When: 用 TTL=0 的服务重算（份额/净值/收盘缓存都在，标定必失败）
    const history = await serviceWith(cacheDir, upstream.impl, { calibrationTtlMs: 0 }).getEtfRescue('000300.SH')

    // Then: 读数完全一致（用的是上次 k），且只碰过东财标定端点
    expect(history.points).toEqual(warm.points)
    expect(upstream.urls.length).toBeGreaterThan(0)
    expect(upstream.urls.every((url) => url.includes('eastmoney.com'))).toBe(true)
  })

  it('用户遇到上游整体故障时拿到可诊断的 TRADING_UPSTREAM_ERROR，而不是空序列或 0', async () => {
    // Given: 空缓存 + 所有端点都回 500
    const cacheDir = await tempCacheDir()
    const service = serviceWith(cacheDir, fakeUpstream({ failAll: true }).impl)

    // When: 调 getEtfRescue
    const outcome = await service.getEtfRescue('000300.SH').catch((error: unknown) => error as { code?: string; message?: string })

    // Then: 抛 TRADING_UPSTREAM_ERROR 且消息里带 HTTP 500（不静默补 0、不返回空 points）
    expect(outcome).toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
    expect((outcome as { message: string }).message).toContain('HTTP 500')
  })

  it('用户传不在宽基白名单的个股时拿到空 points 且不发任何请求', async () => {
    // Given: 空缓存 + 任何请求都会被记录并按 404 失败的上游
    const cacheDir = await tempCacheDir()
    const upstream = fakeUpstream({ failAll: true })

    // When: 调 getEtfRescue('600519.SH')
    const history = await serviceWith(cacheDir, upstream.impl).getEtfRescue('600519.SH')

    // Then: 空 points、空指数映射，且零请求（空 ≠ 0）
    expect(history).toEqual({ symbol: '600519.SH', indexCode: '', depthLabel: '', points: [] })
    expect(upstream.urls).toEqual([])
  })

  it('用户用 SH000300 前缀形态调用时命中同一篮子并复用缓存', async () => {
    // Given: 已按 000300.SH 暖过的缓存
    const cacheDir = await tempCacheDir()
    const warm = await serviceWith(cacheDir, fakeUpstream().impl).getEtfRescue('000300.SH')
    const upstream = fakeUpstream({ failAll: true })

    // When: 换成 SH000300
    const history = await serviceWith(cacheDir, upstream.impl).getEtfRescue('SH000300')

    // Then: 规范形与读数与暖缓存一致
    expect(history.indexCode).toBe('000300')
    expect(history.symbol).toBe('000300.SH')
    expect(history.points).toEqual(warm.points)
    expect(upstream.urls).toEqual([])
  })
})

describe('时间与窗口工具', () => {
  it('用户看到当日 16:00 之前只认前一天为已结算上界', () => {
    // Given: 上海墙钟 15:59 与 16:01 两个时刻
    const before = new Date('2026-11-23T15:59:00+08:00')
    const after = new Date('2026-11-23T16:01:00+08:00')

    // When/Then: 16:00 是收盘披露的分界
    expect(shanghaiDate(before)).toBe('2026-11-23')
    expect(lastSettledDate(before)).toBe('2026-11-22')
    expect(lastSettledDate(after)).toBe('2026-11-23')
  })

  it('用户看到深交所缺失日按 ≤3 个月切窗，跨度只覆盖缺失日期', () => {
    // Given: 跨 7 个月的缺失交易日
    const days = ['2023-01-03', '2023-02-01', '2023-04-03', '2023-07-03']

    // When: 切窗
    const windows = groupSzseWindows(days)

    // Then: 每窗跨度不超过 3 个月（4 月 3 日正好落在边界内），窗口端点就是首末缺失日
    expect(windows.map((window) => window.start)).toEqual(['2023-01-03', '2023-07-03'])
    expect(windows.map((window) => window.end)).toEqual(['2023-04-03', '2023-07-03'])
    expect(windows.flatMap((window) => window.dates)).toEqual(days)
  })
})
