/**
 * 星耀数智连接器 REST 层单测：A 股符号归一、周期词汇、上游错误映射与响应解析。
 *
 * 零 mock 纪律：HTTP 面用**注入的 fetchImpl 真实函数**（连接器依赖注入缝，
 * restartOptions.fetchImpl）而非通用 mock 工具；断言的是连接器对外契约。
 */
import { describe, expect, it } from 'vitest'
import {
  INTERVAL_VOCABULARY,
  XyszRestClient,
  assertSupportedInterval,
  toXyszSymbol,
} from '../src/rest.js'

/** 注入式 HTTP 假实现：按 URL 匹配返回真实 Response（dependency injection，非 mock 工具）。 */
function injectedFetch(routes: Array<{ match: string; body: unknown; status?: number }>): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (route === undefined) throw new Error('unexpected request: ' + url)
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { fetchImpl, urls }
}

describe('星耀数智 A 股符号归一（cn 规范词汇）', () => {
  it('用户给规范形或裸 6 位代码时都归一为 A 股规范形', () => {
    // Given: 上游 SDK 只认 NNNNNN.XX 形（AmazingData code+market）
    // When: 传入规范形 / 裸 6 位
    // Then: 输出一律规范形，交易所按首位判定
    expect(toXyszSymbol('600519.SH')).toEqual({ canonical: '600519.SH', code: '600519', exchange: 'SH' })
    expect(toXyszSymbol('600519')).toEqual({ canonical: '600519.SH', code: '600519', exchange: 'SH' })
    expect(toXyszSymbol('000001')).toEqual({ canonical: '000001.SZ', code: '000001', exchange: 'SZ' })
    expect(toXyszSymbol('300750')).toEqual({ canonical: '300750.SZ', code: '300750', exchange: 'SZ' })
    expect(toXyszSymbol('688981')).toEqual({ canonical: '688981.SH', code: '688981', exchange: 'SH' })
  })

  it('用户给北交所代码或带市场前缀形时都能正确归一', () => {
    // Given: 北交所 4/8 开头；上游名册实测含 348 只 BJ 标的
    // When: 传入 8xxxxx / 4xxxxx / sh600519 前缀形
    // Then: 交易所判定正确、前缀形互译
    expect(toXyszSymbol('832023')).toEqual({ canonical: '832023.BJ', code: '832023', exchange: 'BJ' })
    expect(toXyszSymbol('430047.BJ')).toEqual({ canonical: '430047.BJ', code: '430047', exchange: 'BJ' })
    expect(toXyszSymbol('sh600519')).toEqual({ canonical: '600519.SH', code: '600519', exchange: 'SH' })
    expect(toXyszSymbol('sz000001')).toEqual({ canonical: '000001.SZ', code: '000001', exchange: 'SZ' })
  })

  it('用户给港股或加密符号时显式拒绝，绝不串味到 A 股查询', () => {
    // Given: 本连接器只服务 cn/A 股（星耀数智适配器范围）
    // When: 传入港股、加密形态
    // Then: fail-closed 抛 TRADING_UNSUPPORTED_SYMBOL，不发出跨市场请求
    expect(() => toXyszSymbol('00700.HK')).toThrowError(/not an A-share symbol/)
    expect(() => toXyszSymbol('HK.00700')).toThrowError(/not an A-share symbol/)
    expect(() => toXyszSymbol('BTCUSDT')).toThrowError(/not an A-share symbol/)
    expect(() => toXyszSymbol('')).toThrowError(/empty symbol/)
    expect(() => toXyszSymbol('60051')).toThrowError(/malformed A-share symbol/)
    expect(() => toXyszSymbol('ABCDEF')).toThrowError(/malformed A-share symbol/)
  })

  it('用户给畸形符号时错误码是 TRADING_UNSUPPORTED_SYMBOL 而不仅是消息', () => {
    // Given: 消费方按错误码分支（不解析文案）
    // When: 归一失败
    // Then: 抛出带 code 的结构化错误
    expect(() => toXyszSymbol('700')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_SYMBOL' }))
  })
})

describe('星耀数智周期词汇闸门', () => {
  it('用户请求受支持周期时放行，上游未覆盖的周期被结构化拒绝', () => {
    // Given: 上游 AmazingData 覆盖 1m..1M 的 A 股周期（无 3d/4h 等）
    // When: 校验词汇
    // Then: 受支持周期不抛，未覆盖周期抛 TRADING_UNSUPPORTED_INTERVAL
    expect(() => assertSupportedInterval('1m')).not.toThrow()
    expect(() => assertSupportedInterval('1d')).not.toThrow()
    expect(() => assertSupportedInterval('1M')).not.toThrow()
    expect(() => assertSupportedInterval('4h')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('2h')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('XyszRestClient 上游响应解析', () => {
  it('用户请求日 K 时取回升序 K 线并丢弃缺字段行', async () => {
    // Given: 上游返回 openTime/open/high/low/close/volume，其中一行缺 close
    const { fetchImpl, urls } = injectedFetch([{
      match: '/api/v1/klines',
      body: {
        symbol: '600519.SH', interval: '1d', count: 2,
        klines: [
          { openTime: 1789920000000, open: 1259, high: 1259.95, low: 1250.8, close: 1252.57, volume: 2501689 },
          { openTime: 1790006400000, open: 1252.15, high: 1265.88, low: 1248.1, close: null, volume: 1 },
        ],
      },
    }])
    // When: 拉取 1d K 线
    const client = new XyszRestClient({ apiUrl: 'http://127.0.0.1:8191', fetchImpl })
    const klines = await client.getKlines('600519.SH', '1d', 5)
    // Then: 只保留完整行；请求带上规范符号与周期
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({ open: 1259, close: 1252.57, high: 1259.95, low: 1250.8, volume: 2501689 })
    expect(urls[0]).toContain('symbol=600519.SH')
    expect(urls[0]).toContain('interval=1d')
  })

  it('用户请求行情快照时取回价格、昨收、涨跌幅与买卖一档', async () => {
    // Given: 上游 ticker 返回 last/pre_close 等 SDK 字段
    const { fetchImpl } = injectedFetch([{
      match: '/api/v1/ticker',
      body: {
        symbol: '600519.SH', price: 1243.88, volume: 2821830, timestamp: 1790584189000,
        prevClose: 1237, changePercent: 0.5562, bid: 1243.77, ask: 1243.88,
      },
    }])
    // When: 拉取 ticker（裸 6 位入参）
    const client = new XyszRestClient({ apiUrl: 'http://127.0.0.1:8191', fetchImpl })
    const ticker = await client.getTicker('600519')
    // Then: 规范形 + 官方昨收与派生涨跌幅都在
    expect(ticker).toEqual({
      symbol: '600519.SH', price: 1243.88, volume: 2821830, timestamp: 1790584189000,
      prevClose: 1237, changePercent: 0.5562, bid: 1243.77, ask: 1243.88,
    })
  })

  it('用户请求盘口时按价格过滤空档并保留五档', async () => {
    // Given: 上游返回 5 档买/卖，其中一档价格为 0（无档位）
    const { fetchImpl } = injectedFetch([{
      match: '/api/v1/orderbook',
      body: {
        symbol: '600519.SH', timestamp: 1790584189000,
        bids: [{ price: 1243.77, amount: 100 }, { price: 0, amount: 0 }],
        asks: [{ price: 1243.88, amount: 319 }],
      },
    }])
    // When: 拉取盘口
    const client = new XyszRestClient({ apiUrl: 'http://127.0.0.1:8191', fetchImpl })
    const book = await client.getOrderbook('600519.SH')
    // Then: 零价档位被丢弃，价量保留
    expect(book.bids).toEqual([{ price: 1243.77, amount: 100 }])
    expect(book.asks).toEqual([{ price: 1243.88, amount: 319 }])
    expect(book.symbol).toBe('600519.SH')
  })

  it('用户按名称检索名册时命中中文简称或代码子串', async () => {
    // Given: 上游返回全量 A 股名册（含中文简称）
    const { fetchImpl, urls } = injectedFetch([{
      match: '/api/v1/instruments',
      body: {
        security_type: 'EXTRA_STOCK_A', count: 2,
        items: [{ symbol: '600519.SH', name: '贵州茅台' }, { symbol: '000001.SZ', name: '平安银行' }],
      },
    }])
    // When: 用中文名与代码子串分别过滤
    const client = new XyszRestClient({ apiUrl: 'http://127.0.0.1:8191', fetchImpl })
    const byName = await client.listInstruments('茅台')
    const all = await client.listInstruments()
    // Then: 名称命中；空查询返回全量；请求带 with_names
    expect(byName).toEqual([{ symbol: '600519.SH', name: '贵州茅台' }])
    expect(all).toHaveLength(2)
    expect(urls[0]).toContain('with_names=true')
  })

  it('用户请求基本面时取回简称与 52 周高低', async () => {
    // Given: 上游 fundamentals 返回 stock_basic 字段与周 K 派生高低
    const { fetchImpl } = injectedFetch([{
      match: '/api/v1/fundamentals',
      body: {
        symbol: '600519.SH', name: '贵州茅台', listPlate: '主板', listDate: '20010827',
        fiftyTwoWeekHigh: 1568, fiftyTwoWeekLow: 1151.01, timestamp: 1790592016060,
      },
    }])
    // When: 拉取基本面
    const client = new XyszRestClient({ apiUrl: 'http://127.0.0.1:8191', fetchImpl })
    const fundamentals = await client.getFundamentals('600519.SH')
    // Then: 契约字段就位
    expect(fundamentals).toMatchObject({
      symbol: '600519.SH', name: '贵州茅台', fiftyTwoWeekHigh: 1568, fiftyTwoWeekLow: 1151.01,
    })
  })
})

describe('XyszRestClient 上游错误映射', () => {
  it('用户遇到上游 400 时映射为 TRADING_UNSUPPORTED_SYMBOL', async () => {
    // Given: 上游对非法符号/周期返回 400 与 detail
    const { fetchImpl } = injectedFetch([{ match: '/api/v1/klines', body: { detail: 'unsupported interval' }, status: 400 }])
    // When: 发起请求
    const client = new XyszRestClient({ apiUrl: 'http://127.0.0.1:8191', fetchImpl })
    // Then: 结构化错误码可被消费方分支
    await expect(client.getKlines('600519.SH', '1d', 1))
      .rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })

  it('用户遇到上游 502 时映射为 TRADING_UPSTREAM_ERROR 并带上游 detail', async () => {
    // Given: 封装服务登录失败/上游 SDK 故障时返回 502
    const { fetchImpl } = injectedFetch([{ match: '/api/v1/ticker', body: { detail: '星耀数智上游调用失败' }, status: 502 }])
    // When: 发起请求
    const client = new XyszRestClient({ apiUrl: 'http://127.0.0.1:8191', fetchImpl })
    // Then: 错误码与 detail 都在消息里
    await expect(client.getTicker('600519.SH')).rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
    await expect(client.getTicker('600519.SH')).rejects.toThrowError(/星耀数智上游调用失败/)
  })

  it('用户遇到封装服务不可达时映射为 TRADING_NETWORK 并给出地址', async () => {
    // Given: 封装服务未启动或 SSH 隧道断开（局域网端口未放行时同样表现）
    const unreachable = (async () => { throw new Error('connect ECONNREFUSED') }) as typeof fetch
    // When: 发起请求
    const client = new XyszRestClient({ apiUrl: 'http://127.0.0.1:8191', fetchImpl: unreachable })
    // Then: 网络类错误码 + 地址提示（便于用户识别隧道/防火墙问题）
    await expect(client.getTicker('600519.SH')).rejects.toMatchObject({ code: 'TRADING_NETWORK' })
    await expect(client.getTicker('600519.SH')).rejects.toThrowError(/127\.0\.0\.1:8191/)
  })

  it('用户遇到上游返回非 JSON 时映射为 TRADING_EXCHANGE_ERROR', async () => {
    // Given: 中间层劫持了端口（返回 HTML 而非 JSON）
    const htmlFetch = (async () => new Response('<html>not json</html>', { status: 200 })) as typeof fetch
    // When: 发起请求
    const client = new XyszRestClient({ apiUrl: 'http://127.0.0.1:8191', fetchImpl: htmlFetch })
    // Then: 解析失败被包成结构化错误，不泄露原始 TypeError
    await expect(client.getTicker('600519.SH')).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })

  it('用户配置的 apiUrl 带尾斜杠时不会拼出双斜杠路径', async () => {
    // Given: 用户在设置里填了带尾斜杠的地址
    const { fetchImpl, urls } = injectedFetch([{
      match: '/api/v1/ticker',
      body: { symbol: '600519.SH', price: 1, timestamp: 1 },
    }])
    // When: 发起请求
    const client = new XyszRestClient({ apiUrl: 'http://127.0.0.1:8191///', fetchImpl })
    await client.getTicker('600519.SH')
    // Then: 路径规整为单斜杠
    expect(urls[0]).toBe('http://127.0.0.1:8191/api/v1/ticker?symbol=600519.SH')
  })
})
