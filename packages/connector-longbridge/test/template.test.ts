/**
 * 长桥连接器 REST 层测试：符号归一、周期词汇与映射、签名、行情与交易面。
 *
 * 零 mock 纪律：HTTP 面用**注入的 fetchImpl 真实函数**（连接器自带的依赖注入缝
 * `LongbridgeRestOptions.fetchImpl`，见 `packages/connector-xysz/test/rest.test.ts:1-6`），
 * 不是通用 mock 工具；断言的是连接器对外契约。
 */
import { describe, expect, it } from 'vitest'
import {
  assertSupportedInterval,
  generateLongbridgeSignature,
  INTERVAL_VOCABULARY,
  LongbridgeRestClient,
  parseIntervalMs,
  toLongbridgePeriod,
  toLongbridgeSymbol,
} from '../src/rest.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body, route.status)
  }) as typeof fetch
  return { impl, urls }
}

describe('LongbridgeRestClient 符号与周期映射', () => {
  it('用户给裸港股代码或带 .HK 形态时都补零为 5 位规范形', () => {
    // Given 用户给 '700'、'00700.HK'、'9988' 三种写法
    // When 转长桥代码
    // Then 都补零到 5 位并带 .HK，symbol 与 canonical 同形
    expect(toLongbridgeSymbol('700')).toEqual({ symbol: '00700.HK', canonical: '00700.HK' })
    expect(toLongbridgeSymbol('00700.HK')).toEqual({ symbol: '00700.HK', canonical: '00700.HK' })
    expect(toLongbridgeSymbol('9988')).toEqual({ symbol: '09988.HK', canonical: '09988.HK' })
  })

  it('用户读周期词汇表与 Longbridge period 时受支持档位在表内且映射到位', () => {
    // Given 本包导出的周期词汇表与 period 映射函数
    // When 查 5m/1h 是否在表内并逐档映射 5m/1h/1d/1w
    // Then 在表内且依次映射为 5m/60m/day/week
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(toLongbridgePeriod('5m')).toBe('5m')
    expect(toLongbridgePeriod('1h')).toBe('60m')
    expect(toLongbridgePeriod('1d')).toBe('day')
    expect(toLongbridgePeriod('1w')).toBe('week')
  })

  it('用户读到的 Longbridge 周期词汇表恰好是这 8 档', () => {
    // Given: 本包声明的 Longbridge K 线周期词汇
    // When: 读取 INTERVAL_VOCABULARY
    // Then: 只有 8 档，且不含长桥任何口径下都不存在的周期
    expect(INTERVAL_VOCABULARY).toEqual(['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'])
    expect(INTERVAL_VOCABULARY as readonly string[]).not.toContain('4h')
    expect(INTERVAL_VOCABULARY as readonly string[]).not.toContain('3d')
  })

  it('用户把 8 档周期逐档映射为 Longbridge period', () => {
    // Given: INTERVAL_VOCABULARY 的 8 档受支持周期
    // When: 逐档调用 toLongbridgePeriod
    // Then: 每档都给出确定的上游 period，无 undefined
    expect(toLongbridgePeriod('1m')).toBe('1m')
    expect(toLongbridgePeriod('5m')).toBe('5m')
    expect(toLongbridgePeriod('15m')).toBe('15m')
    expect(toLongbridgePeriod('30m')).toBe('30m')
    expect(toLongbridgePeriod('1h')).toBe('60m')
    expect(toLongbridgePeriod('1d')).toBe('day')
    expect(toLongbridgePeriod('1w')).toBe('week')
    expect(toLongbridgePeriod('1M')).toBe('month')
  })

  it('用户把 8 档周期逐档换算为毫秒步长', () => {
    // Given: INTERVAL_VOCABULARY 的 8 档受支持周期
    // When: 逐档调用 parseIntervalMs
    // Then: 每档都给出确定的正毫秒数，无 NaN
    expect(parseIntervalMs('1m')).toBe(60 * 1000)
    expect(parseIntervalMs('5m')).toBe(5 * 60 * 1000)
    expect(parseIntervalMs('15m')).toBe(15 * 60 * 1000)
    expect(parseIntervalMs('30m')).toBe(30 * 60 * 1000)
    expect(parseIntervalMs('1h')).toBe(60 * 60 * 1000)
    expect(parseIntervalMs('1d')).toBe(24 * 60 * 60 * 1000)
    expect(parseIntervalMs('1w')).toBe(7 * 24 * 60 * 60 * 1000)
    expect(parseIntervalMs('1M')).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('用户请求表外周期时映射函数逐档显式抛码', () => {
    // Given: 不属于 8 档词汇表的 7 个 API 周期
    // When: 逐档调用 toLongbridgePeriod 与 parseIntervalMs
    // Then: 每一档都抛 TRADING_UNSUPPORTED_INTERVAL，而不是返回 undefined
    expect(() => toLongbridgePeriod('3m')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => toLongbridgePeriod('2h')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => toLongbridgePeriod('4h')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => toLongbridgePeriod('6h')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => toLongbridgePeriod('8h')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => toLongbridgePeriod('12h')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => toLongbridgePeriod('3d')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => parseIntervalMs('3m')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => parseIntervalMs('2h')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => parseIntervalMs('4h')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => parseIntervalMs('6h')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => parseIntervalMs('8h')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => parseIntervalMs('12h')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => parseIntervalMs('3d')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    expect(() => toLongbridgePeriod('4h')).toThrowError(/does not serve interval "4h"; supported: 1m, 5m, 15m, 30m, 1h, 1d, 1w, 1M/)
  })

  it('用户直接调用周期闸门时按词汇表放行并拒绝表外周期', () => {
    // Given: 8 档受支持周期中的代表值与表外值
    // When: 直接调用 assertSupportedInterval
    // Then: 表内不抛，表外抛码
    expect(() => assertSupportedInterval('1m')).not.toThrow()
    expect(() => assertSupportedInterval('1M')).not.toThrow()
    expect(() => assertSupportedInterval('4h')).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
  })
})

describe('LongbridgeRestClient.getKlines', () => {
  it('用户直调服务传表外周期时不出网即被拒绝', async () => {
    // Given: 一个记录全部出站 URL 的注入式 fetch 与表外周期 4h
    const { impl, urls } = stubFetch([
      { match: '/v1/quote/candlesticks', body: { code: 0, data: { candlesticks: [] } } },
    ])
    const client = new LongbridgeRestClient({ fetchImpl: impl, accessToken: 'token-xyz' })
    // When: 服务直调 getKlines('00700.HK', '4h')
    // Then: 抛 TRADING_UNSUPPORTED_INTERVAL，且一个请求都没发出（不降级成 period=undefined）
    await expect(client.getKlines('00700.HK', '4h')).rejects.toThrowError(
      expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }),
    )
    expect(urls).toHaveLength(0)
  })

  it('用户拉取受支持周期的 K 线时按秒转毫秒并算出 closeTime', async () => {
    // Given: 上游返回 10 位秒级 timestamp 的一根 1h K 线
    const { impl, urls } = stubFetch([
      {
        match: '/v1/quote/candlesticks',
        body: {
          code: 0,
          data: {
            candlesticks: [
              { open: '385.0', close: '386.5', high: '387.0', low: '384.5', volume: '12000', timestamp: 1725000000 },
            ],
          },
        },
      },
    ])
    const client = new LongbridgeRestClient({ fetchImpl: impl, accessToken: 'token-xyz' })
    // When: 拉取 1h K 线
    const klines = await client.getKlines('00700.HK', '1h')
    // Then: 请求带 period=60m，时间戳从秒转成毫秒，closeTime 为开盘时刻加一个周期减 1 ms
    expect(urls[0]).toContain('period=60m')
    expect(klines).toHaveLength(1)
    expect(klines[0].openTime).toBe(1725000000000)
    expect(klines[0].closeTime).toBe(1725000000000 + 60 * 60 * 1000 - 1)
    expect(klines[0].close).toBe(386.5)
  })
})

describe('LongbridgeRestClient.getTicker', () => {
  it('用户取港股实时行情时按 /v1/quote/realtime 解析并带出规范形符号', async () => {
    // Given 注入式 fetch 返回 /v1/quote/realtime 一行（last_done 为字符串）
    // When 取该标的实时行情
    // Then 请求带 symbol=00700.HK，price/volume/timestamp 按契约取回
    const { impl, urls } = stubFetch([
      {
        match: '/v1/quote/realtime',
        body: {
          code: 0,
          data: [
            {
              symbol: '00700.HK',
              last_done: '385.4',
              volume: '1500000',
              timestamp: 1725000000,
            },
          ],
        },
      },
    ])
    const client = new LongbridgeRestClient({ fetchImpl: impl, accessToken: 'token-xyz' })
    const ticker = await client.getTicker('00700.HK')

    expect(urls[0]).toContain('symbol=00700.HK')
    expect(ticker).toEqual({
      symbol: '00700.HK',
      price: 385.4,
      volume: 1500000,
      timestamp: 1725000000000,
    })
  })
})

describe('LongbridgeRestClient 签名算法与交易接口', () => {
  it('用户发起交易时生成的签名头符合 LongPort 规范的形状', () => {
    // Given 固定 appSecret、方法、路径与三个签名头
    // When 生成签名
    // Then 形状为 HMAC-SHA256 SignedHeaders=authorization;x-api-key;x-timestamp, Signature=<64 位十六进制>
    const sig = generateLongbridgeSignature(
      'secret123',
      'POST',
      '/v1/trade/order',
      {
        authorization: 'Bearer token-abc',
        'x-api-key': 'key-123',
        'x-timestamp': '1725000000000',
      },
      '{"symbol":"00700.HK"}',
    )
    expect(sig).toMatch(/^HMAC-SHA256 SignedHeaders=authorization;x-api-key;x-timestamp, Signature=[0-9a-f]{64}$/)
  })

  it('用户查资产时按 /v1/asset/account 解析为可用资金与总资产', async () => {
    // Given 注入式 fetch 返回 /v1/asset/account 的资金列表
    // When 查资产
    // Then 打到该端点并把可用资金与总资产按契约字段取回
    const { impl, urls } = stubFetch([
      {
        match: '/v1/asset/account',
        body: {
          code: 0,
          data: {
            list: [
              {
                total_cash: '620000.5',
                net_assets: '1350000.0',
                currency: 'HKD',
              },
            ],
          },
        },
      },
    ])
    const client = new LongbridgeRestClient({
      fetchImpl: impl,
      appKey: 'key-123',
      appSecret: 'secret-123',
      accessToken: 'token-abc',
    })
    const bal = await client.getBalance()

    expect(urls[0]).toContain('/v1/asset/account')
    expect(bal).toEqual({
      asset: 'HKD',
      free: 620000.5,
      locked: 729999.5,
    })
  })

  it('用户查持仓时显式拒绝：上游没有方向与持仓时间，绝不猜 side', async () => {
    // Given 一个会记录出站请求的注入式 fetch（真发请求就会抛 unexpected request）
    // When 查持仓
    // Then 抛 TRADING_NOT_IMPLEMENTED，且一个请求都不发出（不拿 quantity 推方向）
    const { impl, urls } = stubFetch([])
    const client = new LongbridgeRestClient({
      fetchImpl: impl,
      appKey: 'key-123',
      appSecret: 'secret-abc',
      accessToken: 'token-abc',
    })
    await expect(client.getPositions()).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(client.getPositions()).rejects.toThrow(/NOT "no positions"/)
    expect(urls).toHaveLength(0)
  })

  it('用户提交港股委托时按 /v1/trade/order 取回订单号与字段', async () => {
    // Given 注入式 fetch 返回 /v1/trade/order 的成功回执
    // When 提交港股委托
    // Then 打到交易端点，订单号与符号取回且 dryRun 为 false
    const { impl, urls } = stubFetch([
      {
        match: '/v1/trade/order',
        body: {
          code: 0,
          data: { order_id: 'lb-ord-999' },
        },
      },
    ])
    const client = new LongbridgeRestClient({
      fetchImpl: impl,
      appKey: 'key-123',
      appSecret: 'secret-123',
      accessToken: 'token-abc',
    })
    const order = await client.placeOrder(undefined, {
      symbol: '00700.HK',
      side: 'buy',
      type: 'limit',
      quantity: 100,
      price: 385.0,
    })

    expect(urls[0]).toContain('/v1/trade/order')
    expect(order.id).toBe('lb-ord-999')
    expect(order.symbol).toBe('00700.HK')
    expect(order.dryRun).toBe(false)
  })

  it('用户撤单时按订单号打 /v1/trade/order 并得到 canceled', async () => {
    // Given 注入式 fetch 返回撤单成功回执
    // When 撤销 lb-ord-999
    // Then 请求带 order_id=lb-ord-999，结果为 canceled
    const { impl, urls } = stubFetch([
      {
        match: '/v1/trade/order',
        body: { code: 0, message: 'success' },
      },
    ])
    const client = new LongbridgeRestClient({
      fetchImpl: impl,
      appKey: 'key-123',
      appSecret: 'secret-123',
      accessToken: 'token-abc',
    })
    const res = await client.cancelOrder(undefined, 'lb-ord-999')
    expect(urls[0]).toContain('order_id=lb-ord-999')
    expect(res).toEqual({ orderId: 'lb-ord-999', status: 'canceled' })
  })

  it('用户未配置凭证时查资产抛出 TRADING_AUTH_FAILED', async () => {
    // Given 一个未配置任何凭证的客户端
    // When 查资产
    // Then 抛错并指明 appKey 与 accessToken 必需
    const client = new LongbridgeRestClient({})
    await expect(client.getBalance()).rejects.toThrowError(/appKey and accessToken are required/)
  })
})
