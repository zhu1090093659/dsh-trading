/**
 * 公共面单测（mock fetch，不出网）：ticker/klines/funding-rate 解析、bar 映射、
 * envelope 错误码映射（调研 §5 表）、对时偏移缓存。
 */
import { describe, expect, it } from 'vitest'
import { OkxRestClient, TradingServiceError, toBar } from '../src/rest.js'

interface RecordedRequest {
  readonly url: string
  readonly init: RequestInit
}

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 按断言路由的 mock fetch：记录请求并按注册顺序返回响应。 */
function routeMock(handler: (req: RecordedRequest) => Response): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const fetchImpl = (async (input, init) => {
    const req: RecordedRequest = { url: String(input), init: init ?? {} }
    requests.push(req)
    return handler(req)
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

function client(fetchImpl: typeof fetch, extra = {}): OkxRestClient {
  return new OkxRestClient({ baseUrl: 'https://okx.test', fetchImpl, clockSync: false, clockOffsetMs: 0, ...extra })
}

describe('getTicker', () => {
  it('解析 last/bid/ask/vol24h（SPOT 的 24h 量取 vol24h=base 币量）', async () => {
    const { fetchImpl, requests } = routeMock(() => okResponse({
      code: '0',
      data: [{ instId: 'BTC-USDT', last: '42000.5', bidPx: '42000.1', askPx: '42000.4', vol24h: '123.4', ts: '1700000000000' }],
    }))
    const ticker = await client(fetchImpl).getTicker('btc-usdt')
    // 输出一律规范形（docs/symbol-vocabulary.md）：下游看到 BTCUSDT 而非 BTC-USDT
    expect(ticker).toMatchObject({ symbol: 'BTCUSDT', price: 42000.5, bid: 42000.1, ask: 42000.4, volume: 123.4 })
    expect(requests[0]?.url).toBe('https://okx.test/api/v5/market/ticker?instId=BTC-USDT')
  })

  it('SWAP 的 24h 量取 volCcy24h（vol24h 是张数，不是币量）', async () => {
    const { fetchImpl } = routeMock(() => okResponse({
      code: '0',
      data: [{ instId: 'BTC-USDT-SWAP', last: '42000.5', vol24h: '45678', volCcy24h: '456.78', ts: '1700000000000' }],
    }))
    const ticker = await client(fetchImpl).getTicker('BTC-USDT-SWAP')
    expect(ticker.volume).toBe(456.78)
  })

  it('规范形互译（2026-08-31 规范词汇）：BTCUSDT → BTC-USDT；BTCUSDT-SWAP → BTC-USDT-SWAP；无法解析才报错', async () => {
    const { fetchImpl, requests } = routeMock(() =>
      okResponse({ code: '0', data: [{ instId: 'BTC-USDT', last: '42000.5', vol24h: '1', ts: '1700000000000' }] }))
    await client(fetchImpl).getTicker('BTCUSDT')
    expect(requests[0]?.url).toContain('instId=BTC-USDT') // 规范形互译为原生形
    await client(fetchImpl).getTicker('ethusdt-swap')
    expect(requests[1]?.url).toContain('instId=ETH-USDT-SWAP') // 小写规范衍生品形同样互译
    await expect(client(fetchImpl).getTicker('!!!')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    await expect(client(fetchImpl).getTicker('FOOXX')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' }) // 未知 quote 后缀
  })
})

describe('getKlines 与 bar 映射', () => {
  it('1d → bar=1Dutc（UTC 日界，与 Binance 日线对齐——见 rest.ts BAR_MAP 注释）', async () => {
    const { fetchImpl, requests } = routeMock(() => okResponse({ code: '0', data: [] }))
    await client(fetchImpl).getKlines('BTC-USDT', '1d', 3)
    expect(requests[0]?.url).toBe('https://okx.test/api/v5/market/candles?instId=BTC-USDT&bar=1Dutc&limit=3')
  })

  it('1h → 1H；8h → TRADING_UNSUPPORTED_INTERVAL（OKX bar 词汇无 8 小时档）', async () => {
    const { fetchImpl, requests } = routeMock(() => okResponse({ code: '0', data: [] }))
    await client(fetchImpl).getKlines('BTC-USDT', '1h', 2)
    expect(requests[0]?.url).toContain('bar=1H')
    expect(() => toBar('8h')).toThrowError(/8h/)
    await expect(client(fetchImpl).getKlines('BTC-USDT', '8h')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
  })

  it('响应新→旧，翻转为旧→新；closeTime = openTime + bar 时长 - 1；confirm=0 的未收盘 bar 保留', async () => {
    const step = 3_600_000
    const { fetchImpl } = routeMock(() => okResponse({
      code: '0',
      data: [
        ['1700003600000', '42100', '42200', '42050', '42150', '10', '421000', '421000', '0'],
        ['1700000000000', '42000', '42100', '41950', '42100', '11', '463100', '463100', '1'],
      ],
    }))
    const klines = await client(fetchImpl).getKlines('BTC-USDT', '1h', 2)
    expect(klines).toHaveLength(2)
    expect(klines[0]).toEqual({ openTime: 1_700_000_000_000, open: 42000, high: 42100, low: 41950, close: 42100, volume: 11, closeTime: 1_700_000_000_000 + step - 1 })
    expect(klines[1]?.openTime).toBe(1_700_003_600_000)
  })

  it('limit > 300 拒绝（OKX candles 上限 300，与 Binance 的 1000 不同）', async () => {
    const { fetchImpl } = routeMock(() => okResponse({ code: '0', data: [] }))
    await expect(client(fetchImpl).getKlines('BTC-USDT', '1m', 301)).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })
})

describe('getFundingRate', () => {
  it('解析 fundingRate/nextFundingRate/fundingTime（仅 SWAP）', async () => {
    const { fetchImpl, requests } = routeMock(() => okResponse({
      code: '0',
      data: [{ instId: 'BTC-USDT-SWAP', fundingRate: '0.00012', nextFundingRate: '0.00011', fundingTime: '1700006400000', nextFundingTime: '1700035200000' }],
    }))
    const funding = await client(fetchImpl).getFundingRate('BTC-USDT-SWAP')
    expect(funding).toEqual({
      instId: 'BTC-USDT-SWAP',
      fundingRate: 0.00012,
      nextFundingRate: 0.00011,
      fundingTime: 1_700_006_400_000,
      nextFundingTime: 1_700_035_200_000,
    })
    expect(requests[0]?.url).toBe('https://okx.test/api/v5/public/funding-rate?instId=BTC-USDT-SWAP')
  })

  it('现货 instId → TRADING_UNSUPPORTED_SYMBOL（funding rate 只对永续定义）', async () => {
    const { fetchImpl } = routeMock(() => okResponse({ code: '0', data: [] }))
    await expect(client(fetchImpl).getFundingRate('BTC-USDT')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })
})

describe('错误映射（调研 §5 表）', () => {
  const CASES: ReadonlyArray<{ name: string; status: number; body: unknown; expected: string }> = [
    { name: '51008 余额不足（HTTP 200 envelope 失败）', status: 200, body: { code: '1', msg: '', data: [{ sCode: '51008', sMsg: 'Order failed. Insufficient USDT funds' }] }, expected: 'TRADING_INSUFFICIENT_BALANCE' },
    { name: '50011 限频', status: 200, body: { code: '50011', msg: 'Rate limit reached', data: [] }, expected: 'TRADING_RATE_LIMITED' },
    { name: '50111 无效 key（HTTP 401）', status: 401, body: { code: '50111', msg: 'Invalid OK-ACCESS-KEY', data: [] }, expected: 'TRADING_CREDENTIALS_MISSING' },
    { name: '50113 签名错误（HTTP 401）', status: 401, body: { code: '50113', msg: 'Invalid Sign', data: [] }, expected: 'TRADING_AUTH_FAILED' },
    { name: '50102 时差（HTTP 401）', status: 401, body: { code: '50102', msg: 'Timestamp request expired', data: [] }, expected: 'TRADING_AUTH_FAILED' },
    { name: '51000 参数错误', status: 200, body: { code: '51000', msg: 'Parameter error', data: [] }, expected: 'TRADING_EXCHANGE_ERROR' },
    { name: 'HTTP 429 限频', status: 429, body: { code: '50011', msg: 'Too Many Requests', data: [] }, expected: 'TRADING_RATE_LIMITED' },
    { name: 'HTTP 5xx 非法响应体 → 网络', status: 502, body: 'Bad Gateway', expected: 'TRADING_NETWORK' },
  ]
  for (const c of CASES) {
    it(c.name, async () => {
      const { fetchImpl } = routeMock(() => okResponse(c.body, c.status))
      await expect(client(fetchImpl).getTicker('BTC-USDT')).rejects.toMatchObject({ code: c.expected })
    })
  }
})

describe('对时与 50102 重试', () => {
  it('clockSync 开启时先打 /api/v5/public/time 并缓存偏移', async () => {
    const localNow = 1_700_000_000_000
    const { fetchImpl, requests } = routeMock(() =>
      // 服务器快 2500ms（time 与 balance 共用该响应体，balance 只取 data 形状）。
      okResponse({ code: '0', data: [{ ts: String(localNow + 2500), details: [] }] }))
    const c = new OkxRestClient({ baseUrl: 'https://okx.test', fetchImpl, now: () => localNow })
    await c.getBalance({ credentials: { key: 'k', secret: 's', passphrase: 'p' }, simulated: true })
    expect(requests[0]?.url).toBe('https://okx.test/api/v5/public/time')
    const timeCalls = () => requests.filter((r) => r.url.includes('/api/v5/public/time')).length
    expect(timeCalls()).toBe(1)
    // 第二次签名请求不再对时（偏移已缓存）。
    await c.getBalance({ credentials: { key: 'k', secret: 's', passphrase: 'p' }, simulated: true })
    expect(timeCalls()).toBe(1)
    expect(requests.some((r) => r.url.includes('/api/v5/account/balance'))).toBe(true)
  })

  it('签名请求头携带对时后的 timestamp（偏移 = server - local）', async () => {
    const localNow = 1_700_000_000_000
    const { fetchImpl, requests } = routeMock(() => okResponse({ code: '0', data: [{ ts: String(localNow + 2500) }] }))
    const c = new OkxRestClient({ baseUrl: 'https://okx.test', fetchImpl, now: () => localNow })
    await c.getBalance({ credentials: { key: 'k', secret: 's', passphrase: 'p' }, simulated: false })
    const signed = requests[1]
    expect(signed).toBeDefined()
    const ts = (signed?.init.headers as Record<string, string>)['OK-ACCESS-TIMESTAMP']
    expect(ts).toBe(new Date(localNow + 2500).toISOString())
  })

  it('50102 失败后重对时并重试一次', async () => {
    const localNow = 1_700_000_000_000
    let signedCalls = 0
    const { fetchImpl, requests } = routeMock((req) => {
      if (req.url.includes('/api/v5/public/time')) return okResponse({ code: '0', data: [{ ts: String(localNow) }] })
      signedCalls += 1
      if (signedCalls === 1) return okResponse({ code: '50102', msg: 'Timestamp request expired', data: [] }, 401)
      return okResponse({ code: '0', data: [{ details: [] }] })
    })
    const c = new OkxRestClient({ baseUrl: 'https://okx.test', fetchImpl, now: () => localNow })
    const result = await c.getBalance({ credentials: { key: 'k', secret: 's', passphrase: 'p' }, simulated: false })
    expect(result).toEqual([{ details: [] }])
    expect(signedCalls).toBe(2)
    // 对时被打了 3 次（初始 1 次 + 失效后重对 1 次 + …… 实际 = 初次 + 重试前各 1）。
    const timeCalls = requests.filter((r) => r.url.includes('/api/v5/public/time')).length
    expect(timeCalls).toBe(2)
  })
})

describe('网络层', () => {
  it('超时 → TRADING_NETWORK', async () => {
    const fetchImpl = (async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }) as unknown as typeof fetch
    const c = new OkxRestClient({ baseUrl: 'https://okx.test', fetchImpl, timeoutMs: 20, clockSync: false, clockOffsetMs: 0 })
    await expect(c.getTicker('BTC-USDT')).rejects.toMatchObject({ code: 'TRADING_NETWORK' })
  })

  it('非 TradingServiceError 的未知错误直通（保 cause）', async () => {
    const { fetchImpl } = routeMock(() => okResponse({ code: '0', data: [{}] }))
    const err = new TradingServiceError('TRADING_EXCHANGE_ERROR', 'probe')
    expect(err.code).toBe('TRADING_EXCHANGE_ERROR')
    expect(err.name).toBe('TradingServiceError')
  })
})

describe('listInstruments', () => {
  it('拉取 SPOT instruments 并转换为规范形 symbol 与 base/quote name', async () => {
    const { fetchImpl, requests } = routeMock(() => okResponse({
      code: '0',
      data: [
        { instId: 'BTC-USDT', instType: 'SPOT', lotSz: '0.00001', minSz: '0.00001', tickSz: '0.1', baseCcy: 'BTC', quoteCcy: 'USDT' },
        { instId: 'ETH-USDT', instType: 'SPOT', lotSz: '0.001', minSz: '0.001', tickSz: '0.01', baseCcy: 'ETH', quoteCcy: 'USDT' },
      ],
    }))
    const instruments = await client(fetchImpl).listInstruments()
    expect(requests[0]?.url).toBe('https://okx.test/api/v5/public/instruments?instType=SPOT')
    expect(instruments).toEqual([
      { symbol: 'BTCUSDT', name: 'BTC/USDT' },
      { symbol: 'ETHUSDT', name: 'ETH/USDT' },
    ])
  })
})
