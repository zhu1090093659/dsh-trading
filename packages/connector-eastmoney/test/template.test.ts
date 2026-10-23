import { describe, expect, it } from 'vitest'
import {
  EastmoneyRestClient,
  INTERVAL_VOCABULARY,
  mapIntervalToKlt,
  toEastmoneySecid,
} from '../src/rest.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(routes: Array<{ match: string; body?: unknown; status?: number; networkError?: boolean }>) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`unexpected request: ${url}`)
    // networkError：报价路径在本机被封的真实形态——TCP 通、服务端收到即断，node fetch 抛 TypeError
    // （undici UND_ERR_SOCKET，2026-10-14 实测），requestJson 归为 TRADING_NETWORK。
    if (route.networkError) throw new TypeError('fetch failed')
    return jsonResponse(route.body, route.status)
  }) as typeof fetch
  return { impl, urls }
}

/**
 * 前 failures 枪网络级失败（TCP 通、服务端收到即断 —— node fetch 抛 TypeError
 * `fetch failed` / UND_ERR_SOCKET，curl 报 (52) Empty reply），之后正常回 JSON。
 */
function flakyFetch(failures: number, body: unknown) {
  const urls: string[] = []
  let attempts = 0
  const impl = (async (input: unknown) => {
    urls.push(String(input))
    attempts += 1
    if (attempts <= failures) throw new TypeError('fetch failed')
    return jsonResponse(body)
  }) as typeof fetch
  return { impl, urls }
}

describe('EastmoneyRestClient 符号与周期映射', () => {
  it('A股标准代码转东财 secid 与规范形', () => {
    expect(toEastmoneySecid('600519.SH')).toEqual({ secid: '1.600519', canonical: '600519.SH', market: 'cn' })
    expect(toEastmoneySecid('000001.SZ')).toEqual({ secid: '0.000001', canonical: '000001.SZ', market: 'cn' })
    expect(toEastmoneySecid('600519')).toEqual({ secid: '1.600519', canonical: '600519.SH', market: 'cn' })
    expect(toEastmoneySecid('000001')).toEqual({ secid: '0.000001', canonical: '000001.SZ', market: 'cn' })
    expect(toEastmoneySecid('832023.BJ')).toEqual({ secid: '0.832023', canonical: '832023.BJ', market: 'cn' })
  })

  it('港股代码转东财 secid（market=hk；形态 00700.HK / HK.00700 / HK00700 / 裸 1-5 位）', () => {
    expect(toEastmoneySecid('00700.HK', 'hk')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
    expect(toEastmoneySecid('HK00700', 'hk')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
    expect(toEastmoneySecid('HK.00700', 'hk')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
    expect(toEastmoneySecid('02714.HK', 'hk')).toEqual({ secid: '116.02714', canonical: '02714.HK', market: 'hk' })
    expect(toEastmoneySecid('00700', 'hk')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
    // 审查 H3：裸短码在 hk 上下文是港股（补零），不再落 CN 兜底查深市。
    expect(toEastmoneySecid('700', 'hk')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
    // 跨市场形态显式拒绝（fail-closed，绝不查询另一个市场的证券）。
    expect(() => toEastmoneySecid('600519.SH', 'hk')).toThrowError(/malformed HK symbol/)
    expect(() => toEastmoneySecid('00700.HK', 'cn')).toThrowError(/not an A-share symbol/)
    expect(() => toEastmoneySecid('700', 'cn')).toThrowError(/not an A-share symbol/)
  })

  it('支持的 interval 词汇包含 1m/5m/15m/30m/1h/1d/1w/1M', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('15m')
    expect(INTERVAL_VOCABULARY).toContain('30m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(INTERVAL_VOCABULARY).toContain('1d')
    expect(mapIntervalToKlt('5m')).toBe('5')
    expect(mapIntervalToKlt('1h')).toBe('60')
    expect(mapIntervalToKlt('1d')).toBe('101')
  })
})

describe('EastmoneyRestClient.getTicker', () => {
  it('拉取并解析 A 股 Ticker 快照（按行 f1 小数位数取价，含官方昨收/涨跌幅）', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/ulist.np/get',
        body: {
          data: {
            total: 1,
            diff: [{ f1: 2, f2: 175050, f3: 15, f5: 25000, f12: '600519', f13: 1, f14: '贵州茅台', f18: 174800, f124: 1725000000 }],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('600519.SH')

    expect(urls[0]).toContain('secids=1.600519')
    expect(urls[0]).toContain('f18')
    expect(ticker).toEqual({
      symbol: '600519.SH',
      name: '贵州茅台',
      price: 1750.5,
      volume: 25000,
      timestamp: 1725000000000,
      prevClose: 1748,
      changePercent: 0.15,
    })
  })

  it('处理 "-" 停牌/无数据占位符', async () => {
    const { impl } = stubFetch([
      {
        match: '/api/qt/ulist.np/get',
        body: {
          data: {
            total: 1,
            diff: [{ f1: 2, f2: '-', f5: 0, f14: '退市标的', f124: 1725000000 }],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('600519.SH')
    expect(ticker.price).toBe(0)
  })

  it('防回归断言：茅台 ticker price 与最近 K 线 close 在 ±5% 以内', async () => {
    const klineClose = 1755.0
    const tickerPriceRaw = 175050 // 上游返回 175050 即 1750.50 元
    const { impl } = stubFetch([
      {
        match: '/api/qt/ulist.np/get',
        body: { data: { total: 1, diff: [{ f1: 2, f2: tickerPriceRaw, f5: 25000, f14: '贵州茅台', f124: 1725000000 }] } },
      },
      {
        match: '/api/qt/stock/kline/get',
        body: { data: { klines: [`2026-08-31 09:35,1750.0,${klineClose},1758.0,1748.0,5000,87500000.0,0.57`] } },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('600519.SH')
    const klines = await client.getKlines('600519.SH', '5m', 1)

    const ratio = Math.abs(ticker.price - klines[0].close) / klines[0].close
    expect(ratio).toBeLessThan(0.05)
  })

  it('用户查看 A 股 ETF 自选行时按行 f1=3 取价，不吃市场级 ×100 常数', async () => {
    // Given 上游报价行自带 f1=3（2026-10-14 交叉验证：159869 游戏ETF华夏 f2=1058 即 1.058 元，腾讯 qt.gtimg.cn 同报 1.058）
    const { impl } = stubFetch([
      { match: '/api/qt/ulist.np/get', body: { data: { total: 1, diff: [{ f1: 3, f2: 1058, f3: 95, f5: 4241490, f14: '游戏ETF华夏', f18: 1048, f124: 1791958299 }] } } },
    ])

    // When 用户取该 ETF 的最新报价
    const ticker = await new EastmoneyRestClient({ fetchImpl: impl }).getTicker('159869.SZ')

    // Then 价格按 3 位小数还原，昨收与涨跌幅同档
    expect(ticker.price).toBe(1.058)
    expect(ticker.prevClose).toBe(1.048)
    expect(ticker.changePercent).toBe(0.95)
  })

  it('用户遇到不声明小数位数的报价行时落到市场级倍率', async () => {
    // Given 一行 cn 报价与一行 hk 报价都缺 f1
    const { impl } = stubFetch([
      { match: '/api/qt/ulist.np/get', body: { data: { total: 1, diff: [{ f2: 175050, f14: '贵州茅台' }] } } },
    ])
    const { impl: hkImpl } = stubFetch([
      { match: '/api/qt/ulist.np/get', body: { data: { total: 1, diff: [{ f2: 437600, f14: '腾讯控股' }] } } },
    ])

    // When 分别取两台实例的报价
    const cn = await new EastmoneyRestClient({ fetchImpl: impl }).getTicker('600519.SH')
    const hk = await new EastmoneyRestClient({ fetchImpl: hkImpl, market: 'hk' }).getTicker('00700.HK')

    // Then 回落到 cn ×100 / hk ×1000
    expect(cn.price).toBe(1750.5)
    expect(hk.price).toBe(437.6)
  })

  it('用户查询上游未收录的代码时拿到 not found，而不是一条空报价', async () => {
    // Given 上游对未收录 secid 返回 data:null，混传无效 secid 时只少返回行
    const { impl } = stubFetch([{ match: '/api/qt/ulist.np/get', body: { data: null } }])
    const { impl: emptyImpl } = stubFetch([{ match: '/api/qt/ulist.np/get', body: { data: { total: 0, diff: [] } } }])

    // When 用户分别查询这两种空态
    // Then 都按 not found 抛错
    await expect(new EastmoneyRestClient({ fetchImpl: impl }).getTicker('600519.SH'))
      .rejects.toMatchObject({ code: 'TRADING_SYMBOL_NOT_FOUND' })
    await expect(new EastmoneyRestClient({ fetchImpl: emptyImpl }).getTicker('600519.SH'))
      .rejects.toMatchObject({ code: 'TRADING_SYMBOL_NOT_FOUND' })
  })
})

describe('EastmoneyRestClient.getKlines', () => {
  it('拉取并解析 5m 分钟 K 线', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/kline/get',
        body: {
          data: {
            klines: [
              '2026-08-31 09:35,1750.0,1755.0,1758.0,1748.0,5000,87500000.0,0.57',
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('600519.SH', '5m', 10)

    expect(urls[0]).toContain('secid=1.600519')
    expect(urls[0]).toContain('klt=5')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 1750.0,
      close: 1755.0,
      high: 1758.0,
      low: 1748.0,
      volume: 5000,
    })
  })

  it('用户取 A 股 1m 时走 trends2 五日窗口，open=0 的行按同日前一根 close 重建', async () => {
    // Given 上游 trends2 ndays=5 的真实形态：历史交易日每根的第 2 列为 0.00，
    // 当日那一段带真实开价（2026-10-14 实测，spikes/impl-five-day-1m-probe/p4）
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/trends2/get',
        body: {
          data: {
            trends: [
              '2026-10-13 14:59,0.00,1285.00,1287.80,1280.14,1200,1540000.000,0.00',
              '2026-10-13 15:00,0.00,1286.00,1288.00,1284.00,1300,1670000.000,0.00',
              '2026-10-14 09:30,1287.00,1287.50,1288.20,1286.80,900,1160000.000,0.00',
              '2026-10-14 09:31,1287.50,1290.00,1290.50,1287.20,1100,1420000.000,0.00',
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户以五日窗口的取数上限查询 A 股 1m
    const klines = await client.getKlines('600519.SH', '1m', 2500)

    // Then 请求落在 trends2 且 ndays=5（kline/get 的 klt=1 只有当日，表达不了五日窗口）
    expect(urls[0]).toContain('/api/qt/stock/trends2/get')
    expect(urls[0]).toContain('secid=1.600519')
    expect(urls[0]).toContain('ndays=5')
    // Then 序列升序，closeTime 与 1m 名义时长自洽
    expect(klines.map((k) => k.openTime)).toEqual([
      Date.UTC(2026, 9, 13, 6, 59),
      Date.UTC(2026, 9, 13, 7, 0),
      Date.UTC(2026, 9, 14, 1, 30),
      Date.UTC(2026, 9, 14, 1, 31),
    ])
    expect(klines[0]!.closeTime).toBe(Date.UTC(2026, 9, 13, 6, 59) + 60_000 - 1)
    // Then 开价重建：上游为 0 时同日前一根 close；窗口内某交易日首根用该根自身 close；
    // 当日（上游有真实开价）直接用上游值
    expect(klines.map((k) => k.open)).toEqual([1285.0, 1285.0, 1287.0, 1287.5])
    expect(klines.map((k) => k.close)).toEqual([1285.0, 1286.0, 1287.5, 1290.0])
  })

  it('用户请求的 limit 小于 trends2 窗口时只拿到最近 limit 根', async () => {
    // Given 上游回 3 根（跨两个交易日）
    const { impl } = stubFetch([
      {
        match: '/api/qt/stock/trends2/get',
        body: {
          data: {
            trends: [
              '2026-10-13 15:00,0.00,1286.00,1288.00,1284.00,1300,1670000.000,0.00',
              '2026-10-14 09:30,1287.00,1287.50,1288.20,1286.80,900,1160000.000,0.00',
              '2026-10-14 09:31,1287.50,1290.00,1290.50,1287.20,1100,1420000.000,0.00',
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户只要最近 2 根
    const klines = await client.getKlines('600519.SH', '1m', 2)

    // Then 截尾保留最新两根，跨日首根仍用该根自身 close
    expect(klines).toHaveLength(2)
    expect(klines.map((k) => k.openTime)).toEqual([Date.UTC(2026, 9, 14, 1, 30), Date.UTC(2026, 9, 14, 1, 31)])
    expect(klines.map((k) => k.open)).toEqual([1287.0, 1287.5])
  })

  it('用户取历史 1m 时重建开价被夹进当根高低区间（越界候选收敛到边界）', async () => {
    // Given 上游 4 根全为 0.00 开价，且候选值分别越过当根 high 与 low：
    //   09:30 首根用自身 close（1250.00，落在 1248.00..1252.00 内，不触发 clamp）
    //   09:31 候选=前一根 close 1250.00，但当根 high=1248.50 → 夹到 high
    //   09:32 候选=前一根 close 1247.20，但当根 low=1249.60 → 夹到 low
    //   09:33 候选=前一根 close 1250.60，落在 1249.00..1251.00 内 → 原值
    const { impl } = stubFetch([
      {
        match: '/api/qt/stock/trends2/get',
        body: {
          data: {
            trends: [
              '2026-10-13 09:30,0.00,1250.00,1252.00,1248.00,900,1160000.000,0.00',
              '2026-10-13 09:31,0.00,1247.20,1248.50,1246.80,1100,1420000.000,0.00',
              '2026-10-13 09:32,0.00,1250.60,1251.40,1249.60,1200,1500000.000,0.00',
              '2026-10-13 09:33,0.00,1250.20,1251.00,1249.00,800,1000000.000,0.00',
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户取该段 1m
    const klines = await client.getKlines('600519.SH', '1m', 2500)

    // Then 越界候选被夹到当根边界，未越界的候选保持原值
    expect(klines.map((k) => k.open)).toEqual([1250.0, 1248.5, 1249.6, 1250.6])
    // Then 每根都满足 low <= open <= high（蜡烛实体不戳出影线）
    expect(klines.every((k) => k.low <= k.open && k.open <= k.high)).toBe(true)
    // Then close 不被改写（下一根的候选仍取真实 close）
    expect(klines.map((k) => k.close)).toEqual([1250.0, 1247.2, 1250.6, 1250.2])
  })
})

/**
 * 批量报价 getTickers（2026-10-14 契约）。fixture 直接取自真实响应
 * spikes/impl-eastmoney-quote-endpoint/p1-quote-endpoint-and-scale.raw.json 的
 * ulist_cn / ulist_hk / ulist_mixedValidInvalid 三段，不做任何人为加工。
 */
const ROW_MUYUAN_CN = { f1: 2, f2: 4096, f3: 15, f5: 149927, f12: '002714', f13: 0, f14: '牧原股份', f18: 4090, f124: 1791958479 }
const ROW_DONGRUI_CN = { f1: 2, f2: 1413, f3: -140, f5: 49215, f12: '001201', f13: 0, f14: '东瑞股份', f18: 1433, f124: 1791958479 }
const CN_DIFF_ROWS = [
  ROW_MUYUAN_CN,
  ROW_DONGRUI_CN,
  { f1: 3, f2: 1059, f3: 105, f5: 4251402, f12: '159869', f13: 0, f14: '游戏ETF华夏', f18: 1048, f124: 1791958479 },
  { f1: 3, f2: 1025, f3: 230, f5: 24230556, f12: '513050', f13: 1, f14: '中概互联网ETF易方达', f18: 1002, f124: 1791958481 },
  { f1: 3, f2: 1834, f3: -219, f5: 1896496, f12: '517520', f13: 1, f14: '黄金股ETF永赢', f18: 1875, f124: 1791958480 },
]
const HK_DIFF_ROWS = [
  { f1: 3, f2: 35400, f3: -11, f5: 616400, f12: '02714', f13: 116, f14: '牧原股份', f18: 35440, f124: 1791958476 },
  { f1: 3, f2: 426000, f3: 19, f5: 12698294, f12: '00700', f13: 116, f14: '腾讯控股', f18: 425200, f124: 1791958481 },
]

describe('EastmoneyRestClient.getTickers（批量报价，2026-10-14 契约）', () => {
  it('用户刷新 A 股自选栏时 5 只标的一次请求取全，价格各按本行 f1 还原', async () => {
    // Given 上游 ulist.np/get 一次返回 5 行真实响应（cn 股票 f1=2、cn ETF f1=3 混在同一批）
    const { impl, urls } = stubFetch([
      { match: '/api/qt/ulist.np/get', body: { data: { total: 5, diff: CN_DIFF_ROWS } } },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户批量取这 5 只
    const tickers = await client.getTickers(['002714.SZ', '001201.SZ', '159869.SZ', '513050.SH', '517520.SH'])

    // Then 5 只标的只发 1 次请求，且请求带全部 5 个 secid
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('secids=0.002714,0.001201,0.159869,1.513050,1.517520')
    expect(Object.keys(tickers).sort()).toEqual(['001201.SZ', '002714.SZ', '159869.SZ', '513050.SH', '517520.SH'])
    // Then 每只价格按**本行** f1 取除数：ETF 行 f1=3 → 1.059，若吃市场级 ×100 会错成 10.59
    expect(tickers['159869.SZ']).toEqual({
      symbol: '159869.SZ',
      name: '游戏ETF华夏',
      price: 1.059,
      volume: 4251402,
      timestamp: 1791958479000,
      prevClose: 1.048,
      changePercent: 1.05,
    })
    expect(tickers['002714.SZ']).toMatchObject({ price: 40.96, prevClose: 40.9, changePercent: 0.15 })
    expect(tickers['513050.SH']).toMatchObject({ price: 1.025, prevClose: 1.002, changePercent: 2.3 })
    expect(tickers['517520.SH']).toMatchObject({ name: '黄金股ETF永赢', price: 1.834, changePercent: -2.19 })
  })

  it('用户自选里含未收录代码时只少那一只，整批不失败也不造假行', async () => {
    // Given 上游对「有效 + 未收录」的 secid 列表只回有效那一行
    // （真实 ulist_mixedValidInvalid：secids=0.001201,0.999999 只回 total=1 的 001201 一行）
    const { impl, urls } = stubFetch([
      { match: '/api/qt/ulist.np/get', body: { data: { total: 1, diff: [ROW_DONGRUI_CN] } } },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户批量取一只已收录与一只未收录的标的
    const tickers = await client.getTickers(['001201.SZ', '999999.SZ'])

    // Then 两只 secid 都发在同一次请求里（不因缺行重发），但只返回拿到的那只
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('secids=0.001201,0.999999')
    expect(Object.keys(tickers)).toEqual(['001201.SZ'])
    expect(tickers['001201.SZ']).toMatchObject({ symbol: '001201.SZ', name: '东瑞股份', price: 14.13 })
    // Then 缺行的那只不出现在结果里（由调用方回落单取拿自己的 not found），也绝不补一条假行
    expect('999999.SZ' in tickers).toBe(false)
  })

  it('用户自选为空时批量取价返回空表且不发请求', async () => {
    // Given 一个会记录任何请求的桩上游
    const { impl, urls } = stubFetch([])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户批量取 0 只标的
    const tickers = await client.getTickers([])

    // Then 得到空表，且**一次上游请求都没发**（空自选不该花掉一次取数）
    expect(tickers).toEqual({})
    expect(urls).toHaveLength(0)
  })

  it('用户自选里混入本市场之外的形态时该符号被跳过，可解析的照常批量取', async () => {
    // Given cn 实例的入参里混进港股形态（toEastmoneySecid 会抛 TRADING_UNSUPPORTED_SYMBOL）
    const { impl, urls } = stubFetch([
      { match: '/api/qt/ulist.np/get', body: { data: { total: 1, diff: [ROW_MUYUAN_CN] } } },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户批量取一只 A 股与一只港股形态
    const tickers = await client.getTickers(['002714.SZ', '00700.HK'])

    // Then 只有 A 股进结果，请求里不含港股 secid（不跨市场取数、整批不因畸形符号失败）
    expect(Object.keys(tickers)).toEqual(['002714.SZ'])
    expect(urls).toHaveLength(1)
    expect(urls[0]).not.toContain('116.00700')
    expect(urls[0]).toContain('secids=0.002714')

    // Then 全是外地形态时连请求都不发
    const allForeign = await client.getTickers(['00700.HK', 'HK00700'])
    expect(allForeign).toEqual({})
    expect(urls).toHaveLength(1)
  })

  it('用户自选的写法与上游返回顺序无关地映射回各自原字符串', async () => {
    // Given 上游把 5 行按与入参**相反**的顺序返回（行序不可信，只认 f13+f12）
    const { impl, urls } = stubFetch([
      { match: '/api/qt/ulist.np/get', body: { data: { total: 5, diff: [...CN_DIFF_ROWS].reverse() } } },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户混用带后缀与裸代码写法批量取价
    const tickers = await client.getTickers(['517520.SH', '513050', '159869.SZ', '001201.SZ', '002714.SZ'])

    // Then 每个入参原字符串都拿到**它自己那一行**的快照（键=入参原字符串，symbol 仍规范形）
    expect(Object.keys(tickers).sort()).toEqual(['001201.SZ', '002714.SZ', '159869.SZ', '513050', '517520.SH'])
    expect(tickers['513050']).toMatchObject({ symbol: '513050.SH', name: '中概互联网ETF易方达', price: 1.025 })
    expect(tickers['517520.SH']).toMatchObject({ name: '黄金股ETF永赢', price: 1.834 })
    expect(tickers['002714.SZ']).toMatchObject({ name: '牧原股份', price: 40.96 })
    expect(tickers['001201.SZ']).toMatchObject({ name: '东瑞股份', price: 14.13 })
    expect(urls).toHaveLength(1)
  })

  it('用户批量刷新港股自选栏时两只港股一次请求取全，价格按 f1=3', async () => {
    // Given 上游 hk 报价一次返回 2 行真实响应（真实 ulist_hk）
    const { impl, urls } = stubFetch([
      { match: '/api/qt/ulist.np/get', body: { data: { total: 2, diff: HK_DIFF_ROWS } } },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl, market: 'hk' })

    // When 用户批量取两只港股
    const tickers = await client.getTickers(['02714.HK', '00700.HK'])

    // Then 一次请求带两个港股 secid，两只都按 f1=3 还原
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('secids=116.02714,116.00700')
    expect(tickers['00700.HK']).toEqual({
      symbol: '00700.HK',
      name: '腾讯控股',
      price: 426,
      volume: 12698294,
      timestamp: 1791958481000,
      prevClose: 425.2,
      changePercent: 0.19,
    })
    expect(tickers['02714.HK']).toMatchObject({ symbol: '02714.HK', name: '牧原股份', price: 35.4, prevClose: 35.44 })
  })

  it('运营遇到上游 5xx 时整批抛出，不退化成空表', async () => {
    // Given 上游对批量报价端点返回 502
    const { impl } = stubFetch([{ match: '/api/qt/ulist.np/get', body: { error: 'bad gateway' }, status: 502 }])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户批量取一只标的
    // Then 整批按上游故障抛出（调用方上报整批失败，不做 N 次重试、也不把空表当成功）
    await expect(client.getTickers(['002714.SZ'])).rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
  })
})

/**
 * 报价路径降级派生（2026-10-14 活故障）：东财掐了本机出口的报价快照路径（ulist.np/get 与
 * stock/get 空回），同刻 push2his 的 trends2 正常。fixture 直接取自实测响应
 * spikes/impl-eastmoney-quote-endpoint/p3-derive-fallback.mjs 的原始读数，不做人为加工。
 */
const TRENDS_MUYUAN_CN = {
  data: {
    code: '002714',
    market: 0,
    name: '牧原股份',
    decimal: 2,
    preClose: 40.9,
    trends: [
      '2026-10-14 09:30,40.80,40.80,40.80,40.80,408,1664640.00,40.800',
      '2026-10-14 11:30,41.13,41.18,41.18,41.13,313,1288045.00,41.134',
      '2026-10-14 15:00,41.07,40.89,41.07,40.89,5411,22125210.00,41.081',
    ],
  },
}

const TRENDS_DONGRUI_CN = {
  data: {
    code: '001201',
    market: 0,
    name: '东瑞股份',
    decimal: 2,
    preClose: 14.33,
    trends: [
      '2026-10-14 09:30,14.33,14.33,14.33,14.33,200,286600.00,14.330',
      '2026-10-14 15:00,14.13,14.13,14.13,14.13,796,1124748.00,14.261',
    ],
  },
}

const TRENDS_TENCENT_HK = {
  data: {
    code: '00700',
    market: 116,
    name: '腾讯控股',
    decimal: 3,
    preClose: 425.2,
    trends: [
      '2026-10-14 09:30,421.400,421.400,421.400,421.400,441200,185921680.000,421.4000',
      '2026-10-14 16:00,424.200,423.400,424.200,423.400,2293400,971054384.000,423.5433',
    ],
  },
}

describe('EastmoneyRestClient 报价路径不可用时的降级派生（2026-10-14 活故障）', () => {
  it('用户遇到报价路径空回时从同源分钟序列拿到派生快照', async () => {
    // Given 报价端点 TCP 通但服务端收到即断（curl: (52) Empty reply from server），同刻 trends2 正常
    const { impl, urls } = stubFetch([
      { match: '/api/qt/ulist.np/get', networkError: true },
      { match: '/api/qt/stock/trends2/get', body: TRENDS_MUYUAN_CN },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户取这只 A 股的报价
    const ticker = await client.getTicker('002714.SZ')

    // Then 先打首选取价路径（空回后立即重试一次，两枪同一 URL），再落到同源的当日分钟序列（ndays=1）
    expect(urls[0]).toContain('/api/qt/ulist.np/get')
    expect(urls[1]).toBe(urls[0])
    expect(urls[2]).toContain('/api/qt/stock/trends2/get')
    expect(urls[2]).toContain('secid=0.002714')
    expect(urls[2]).toContain('ndays=1')
    // Then price 取末根第 3 列——该序列的价格已是十进制值，不再除 10^decimal
    expect(ticker.price).toBe(40.89)
    // Then 名称与昨收取自同一条响应，时间按 UTC+8 墙钟锚定（15:00 UTC+8 = 07:00 UTC）
    expect(ticker.name).toBe('牧原股份')
    expect(ticker.prevClose).toBe(40.9)
    expect(ticker.symbol).toBe('002714.SZ')
    expect(ticker.timestamp).toBe(Date.UTC(2026, 9, 14, 7, 0))
    // Then 涨跌幅由同一对 price/prevClose 推出（序列里没有涨跌幅字段），派生值自洽
    expect(ticker.changePercent).toBeCloseTo(((40.89 - 40.9) / 40.9) * 100, 10)
    // Then 不给 volume：窗口合计在 hk 低于当日累计，拿不到的量宁可缺省
    expect('volume' in ticker).toBe(false)
    // Then 请求量 = 首选取价的两枪（首次 + 一次立即重试）+ 一枪分钟序列，有界
    expect(urls).toHaveLength(3)
  })

  it('用户查询未收录代码时降级不掩盖 not found', async () => {
    // Given 上游对未收录 secid 返回 data:null（报价路径本身可用）
    const { impl, urls } = stubFetch([{ match: '/api/qt/ulist.np/get', body: { data: null } }])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户取一个未收录的代码
    // Then 照实上报 not found，且一次分钟序列请求都不发（降级不得掩盖标的确实不存在）
    await expect(client.getTicker('999999.SZ')).rejects.toMatchObject({ code: 'TRADING_SYMBOL_NOT_FOUND' })
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/api/qt/ulist.np/get')
  })

  it('运营刷新侧栏时降级态下同一规范符号每分钟最多一次分钟序列请求', async () => {
    // Given 报价路径空回、trends2 正常，8s 一拍的侧栏在 TTL 内连取两次
    const { impl, urls } = stubFetch([
      { match: '/api/qt/ulist.np/get', networkError: true },
      { match: '/api/qt/stock/trends2/get', body: TRENDS_MUYUAN_CN },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户在同一分钟内分别用 `002714.SZ` 与 `002714` 取价（同一 secid 的两种写法）
    const first = await client.getTicker('002714.SZ')
    const second = await client.getTicker('002714')

    // Then 第二次命中缓存，拿到同一份快照（symbol 仍是规范形）
    expect(second.price).toBe(first.price)
    expect(second.timestamp).toBe(first.timestamp)
    expect(second.symbol).toBe('002714.SZ')
    // Then trends2 只发了 1 次（另四次是首选取价路径的两轮尝试，每轮 = 首次 + 一次立即重试），
    // 降级态自身的请求量有界
    expect(urls.filter((u) => u.includes('/api/qt/stock/trends2/get'))).toHaveLength(1)
    expect(urls.filter((u) => u.includes('/api/qt/ulist.np/get'))).toHaveLength(4)
  })

  it('运营遇到取价路径与分钟序列同时不可用时拿到原始错误码', async () => {
    // Given 报价端点空回，且 trends2 也空回（另一种情形：trends2 回了空窗口）
    const { impl } = stubFetch([
      { match: '/api/qt/ulist.np/get', networkError: true },
      { match: '/api/qt/stock/trends2/get', networkError: true },
    ])
    const { impl: emptyWindowImpl } = stubFetch([
      { match: '/api/qt/ulist.np/get', networkError: true },
      { match: '/api/qt/stock/trends2/get', body: { data: { name: '牧原股份', preClose: 40.9, trends: [] } } },
    ])

    // When 用户在这两种降级都不成立的情况下取价
    // Then 都抛回**原始**错误码（TRADING_NETWORK），不吞成 not found、也不给空快照
    await expect(new EastmoneyRestClient({ fetchImpl: impl }).getTicker('002714.SZ'))
      .rejects.toMatchObject({ code: 'TRADING_NETWORK' })
    await expect(new EastmoneyRestClient({ fetchImpl: emptyWindowImpl }).getTicker('002714.SZ'))
      .rejects.toMatchObject({ code: 'TRADING_NETWORK' })
  })

  it('用户批量自选取价失败时逐只派生，转不成 secid 的写法仍被跳过', async () => {
    // Given 批量报价端点空回，同源 trends2 对两只 A 股正常；入参里另混一个港股形态
    const { impl, urls } = stubFetch([
      { match: '/api/qt/ulist.np/get', networkError: true },
      { match: 'trends2/get?secid=0.002714', body: TRENDS_MUYUAN_CN },
      { match: 'trends2/get?secid=0.001201', body: TRENDS_DONGRUI_CN },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户批量取两只 A 股（其中一只用裸代码写法）与一只港股形态
    const tickers = await client.getTickers(['002714.SZ', '001201', '00700.HK'])

    // Then 整批失败后对请求表里的两只各派生一次，港股形态没进请求表、也没发跨市场请求
    expect(urls.filter((u) => u.includes('/api/qt/stock/trends2/get'))).toHaveLength(2)
    expect(urls.filter((u) => u.includes('116.00700'))).toHaveLength(0)
    // Then 每只按**入参原字符串**回填，symbol 仍是规范形，整批不因畸形符号失败
    expect(Object.keys(tickers).sort()).toEqual(['001201', '002714.SZ'])
    expect(tickers['002714.SZ']).toMatchObject({ symbol: '002714.SZ', name: '牧原股份', price: 40.89, prevClose: 40.9 })
    expect(tickers['001201']).toMatchObject({ symbol: '001201.SZ', name: '东瑞股份', price: 14.13, prevClose: 14.33 })
    expect('volume' in tickers['002714.SZ']!).toBe(false)
  })

  it('用户取港股报价时降级派生同样生效', async () => {
    // Given hk 实例的报价端点同样空回，而同源 trends2 的 hk 响应自带 preClose 与 name
    const { impl, urls } = stubFetch([
      { match: '/api/qt/ulist.np/get', networkError: true },
      { match: '/api/qt/stock/trends2/get', body: TRENDS_TENCENT_HK },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl, market: 'hk' })

    // When 用户取这只港股的报价
    const ticker = await client.getTicker('00700.HK')

    // Then 报价路径两枪（首次 + 一次立即重试）都空回后，派生请求用港股 secid；
    // 价格取末根第 3 列（hk 序列同样已是十进制值，423.4 港元），时间按 UTC+8 墙钟锚定（16:00 UTC+8 = 08:00 UTC）
    expect(urls).toHaveLength(3)
    expect(urls[2]).toContain('secid=116.00700')
    expect(ticker).toMatchObject({
      symbol: '00700.HK',
      name: '腾讯控股',
      price: 423.4,
      prevClose: 425.2,
      timestamp: Date.UTC(2026, 9, 14, 8, 0),
    })
    expect(ticker.changePercent).toBeCloseTo(((423.4 - 425.2) / 425.2) * 100, 10)
    expect('volume' in ticker).toBe(false)
  })
})

describe('EastmoneyRestClient.listInstruments', () => {
  it('搜索股票代码联想', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/suggest/get',
        body: {
          QuotationCodeTable: {
            Data: [
              { Code: '600519', Name: '贵州茅台', SecurityTypeName: '沪A' },
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const results = await client.listInstruments('茅台')

    expect(urls[0]).toContain('input=%E8%8C%85%E5%8F%B0')
    expect(results).toEqual([
      { symbol: '600519.SH', name: '贵州茅台' },
    ])
  })
})


describe('EastmoneyRestClient 港股面（2026-09-08，实证 spikes/impl-eastmoney-hk/）', () => {
  it('港股 ticker：价格字段 ×1000（f1=3），涨跌幅仍 ×100', async () => {
    // 2026-10-14 实测 ulist.np/get：f1=3 f2=426200 → 426.20，f18=425200 → 425.20，f3=24 → 0.24%
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/ulist.np/get',
        body: { data: { total: 1, diff: [{ f1: 3, f2: 426200, f3: 24, f5: 12577994, f12: '00700', f13: 116, f14: '腾讯控股', f18: 425200, f124: 1791958268 }] } },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl, market: 'hk' })
    const ticker = await client.getTicker('00700.HK')
    expect(urls[0]).toContain('secids=116.00700')
    expect(ticker).toEqual({
      symbol: '00700.HK',
      name: '腾讯控股',
      price: 426.2,
      volume: 12577994,
      timestamp: 1791958268000,
      prevClose: 425.2,
      changePercent: 0.24,
    })
  })

  it('用户取港股 1m 时拿到 trends2 五日窗口，时间按 UTC+8 墙钟锚定（与机器时区无关）', async () => {
    // Given 上游 trends2 回五日窗口：前一日全部 0.00 开价，当日带真实开价
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/trends2/get',
        body: {
          data: {
            trends: [
              '2026-09-07 15:59,0.00,436.000,436.400,435.600,100000,43600000.000,436.0000',
              '2026-09-08 09:30,437.000,437.000,437.400,437.000,159900,69876300.000,437.0000',
              '2026-09-08 09:31,437.400,436.200,437.800,435.800,183300,80009040.000,436.7288',
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl, market: 'hk' })

    // When 用户查询港股 1m
    const klines = await client.getKlines('00700.HK', '1m', 500)

    // Then 请求是港股 secid 的五日 trends2 窗口
    expect(urls[0]).toContain('secid=116.00700')
    expect(urls[0]).toContain('ndays=5')
    expect(klines).toHaveLength(3)
    // Then 时间锚定 UTC+8 墙钟（2026-09-08 09:30 UTC+8 = 2026-09-08 01:30 UTC）
    expect(klines[1]!.openTime).toBe(Date.UTC(2026, 8, 8, 1, 30))
    expect(klines[0]!.openTime).toBe(Date.UTC(2026, 8, 7, 7, 59))
    // Then 开价：上游 0 的首根用该根自身 close，当日带真实开价的行用上游值
    expect(klines.map((k) => k.open)).toEqual([436.0, 437.0, 437.4])
    expect(klines[1]).toMatchObject({ open: 437, close: 437, high: 437.4, low: 437, volume: 159900 })
    expect(klines[2]).toMatchObject({ open: 437.4, close: 436.2 })
  })

  it('港股 5m 走 kline/get（klt=5，secid=116）', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/kline/get',
        body: { data: { klines: ['2026-09-08 11:25,437.800,437.600,437.800,437.600,15400,6741180.000,0.05'] } },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl, market: 'hk' })
    const klines = await client.getKlines('00700.HK', '5m', 4)
    expect(urls[0]).toContain('secid=116.00700')
    expect(urls[0]).toContain('klt=5')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({ open: 437.8, close: 437.6, volume: 15400 })
    // 审查 M1：kline/get 也按 UTC+8 墙钟锚定（11:25 UTC+8 = 03:25 UTC），与 1m 同口径。
    expect(klines[0].openTime).toBe(Date.UTC(2026, 8, 8, 3, 25))
  })
})

// 2026-10-23 实测：push2his 属边缘抖动——同一 URL 连打里夹着 curl (52) Empty reply /
// undici UND_ERR_SOCKET（空回），紧接下一枪又 200。故网络级失败重试一次，其余不重试。
describe('EastmoneyRestClient 网络级抖动的重试边界（2026-10-23 实测空回）', () => {
  it('用户拉日 K 时上游首枪网络级失败，立即重试一次后拿到数据', async () => {
    // Given kline/get 第一枪抛 TypeError('fetch failed')（undici UND_ERR_SOCKET），第二枪正常
    const { impl, urls } = flakyFetch(1, {
      data: { klines: ['2026-10-22 00:00,15.970,15.460,16.850,15.350,218498,338000000.00,0.00'] },
    })

    // When 用户拉东瑞股份日 K
    const klines = await new EastmoneyRestClient({ fetchImpl: impl }).getKlines('001201', '1d', 1)

    // Then 两枪打的是同一 URL（同 secid、同 klt），用第二枪的响应解析
    expect(urls).toHaveLength(2)
    expect(urls[1]).toBe(urls[0])
    expect(urls[0]).toContain('/api/qt/stock/kline/get')
    expect(urls[0]).toContain('secid=0.001201')
    expect(urls[0]).toContain('klt=101')
    // Then 解析口径不变：UTC+8 墙钟锚定，行字段序 时间,开,收,高,低,量
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({ open: 15.97, close: 15.46, high: 16.85, low: 15.35, volume: 218498 })
    expect(klines[0].openTime).toBe(Date.UTC(2026, 9, 21, 16, 0))
  })

  it('用户拉 1m 分时序列时 trends2 首枪空回，立即重试一次后拿到分钟序列', async () => {
    // Given trends2 第一枪网络级失败，第二枪回一条分钟序列
    const { impl, urls } = flakyFetch(1, {
      data: { trends: ['2026-10-22 14:59,15.450,15.460,15.470,15.440,1200,1855200.00,15.456'] },
    })

    // When 用户拉东瑞股份 1m 分时
    const klines = await new EastmoneyRestClient({ fetchImpl: impl }).getKlines('001201', '1m', 1)

    // Then 两枪同一 URL，第二枪的序列被解析成单根分钟 K
    expect(urls).toHaveLength(2)
    expect(urls[1]).toBe(urls[0])
    expect(urls[0]).toContain('/api/qt/stock/trends2/get')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({ open: 15.45, close: 15.46, high: 15.47, low: 15.44, volume: 1200 })
  })

  it('运营遇到上游 HTTP 500 时直接抛，不重试（非 2xx 不是抖动）', async () => {
    // Given kline/get 回 HTTP 500
    const { impl, urls } = stubFetch([{ match: '/api/qt/stock/kline/get', body: { rc: 1 }, status: 500 }])

    // When 用户拉日 K
    // Then 保留上游错误语义，且只打一枪
    await expect(new EastmoneyRestClient({ fetchImpl: impl }).getKlines('001201', '1d', 1))
      .rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
    expect(urls).toHaveLength(1)
  })

  it('运营遇到非 JSON 响应（HTML 错误页）时不重试', async () => {
    // Given 上游 200 但 body 是 HTML（解析失败，不是网络抖动）
    const urls: string[] = []
    const impl = (async (input: unknown) => {
      urls.push(String(input))
      return new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }) as typeof fetch

    // When 用户拉日 K
    // Then 只打一枪，解析失败按既有口径以 TRADING_NETWORK 上抛
    await expect(new EastmoneyRestClient({ fetchImpl: impl }).getKlines('001201', '1d', 1))
      .rejects.toMatchObject({ code: 'TRADING_NETWORK' })
    expect(urls).toHaveLength(1)
  })

  it('管理员遇到连续网络级失败时按 TRADING_NETWORK 上报，且请求量有界（两枪）', async () => {
    // Given 每一枪都网络级失败（抖动持续存在）
    const { impl, urls } = flakyFetch(9, { data: { klines: [] } })

    // When 用户拉日 K
    // Then 抛原始错误码，且只重试一次（共两枪），不无限重试、不引退避
    await expect(new EastmoneyRestClient({ fetchImpl: impl }).getKlines('001201', '1d', 1))
      .rejects.toMatchObject({ code: 'TRADING_NETWORK' })
    expect(urls).toHaveLength(2)
  })
})
