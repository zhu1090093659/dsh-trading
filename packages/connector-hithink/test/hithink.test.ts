import { describe, expect, it, vi } from 'vitest'
import {
  HiThinkRestClient,
  normalizeThsCode,
  TradingServiceError,
} from '../src/rest.js'
import { Config, name } from '../src/index.js'

describe('HiThink 连接器与代码规范化', () => {
  it('normalizeThsCode: 正确将纯数字或带前缀代码转换为标准 thscode', () => {
    expect(normalizeThsCode('600519')).toBe('600519.SH')
    expect(normalizeThsCode('688981')).toBe('688981.SH')
    expect(normalizeThsCode('000001')).toBe('000001.SZ')
    expect(normalizeThsCode('300750')).toBe('300750.SZ')
    expect(normalizeThsCode('830946')).toBe('830946.BJ')
    expect(normalizeThsCode('sh600519')).toBe('600519.SH')
    expect(normalizeThsCode('SZ000001')).toBe('000001.SZ')
    expect(normalizeThsCode('600519.SH')).toBe('600519.SH')
  })

  it('插件元数据与 Config schema', () => {
    expect(name).toBe('dsh-trading-cn-connector-hithink')
    expect(Config).toBeDefined()
  })
})

describe('HiThinkRestClient', () => {
  it('getTicker: 成功请求并解析行情快照为标准 Ticker', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        message: 'success',
        data: {
          timestamp: 1725345600000,
          total: 1,
          item: [
            {
              thscode: '600519.SH',
              ticker: '600519',
              last_price: 1680.5,
              prev_price: 1670.0,
              price_change_ratio_pct: 0.63,
              volume: 2500000,
            },
          ],
        },
      }),
    })

    const client = new HiThinkRestClient({
      apiKey: 'test-api-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const ticker = await client.getTicker('600519')
    expect(ticker.symbol).toBe('600519.SH')
    expect(ticker.price).toBe(1680.5)
    expect(ticker.prevClose).toBe(1670.0)
    expect(ticker.changePercent).toBe(0.63)
    expect(ticker.volume).toBe(2500000)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callUrl = mockFetch.mock.calls[0][0]
    const callOptions = mockFetch.mock.calls[0][1]
    expect(callUrl).toContain('/api/a-share/prices/snapshot?thscodes=600519.SH')
    expect(callOptions.headers['X-api-key']).toBe('test-api-key')
  })

  it('getStockFundamentals: 聚合行情与估值快照', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/prices/snapshot')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            message: 'success',
            data: {
              timestamp: 1725345600000,
              total: 1,
              item: [{ thscode: '600519.SH', ticker: '600519', last_price: 1680.5 }],
            },
          }),
        }
      }
      if (url.includes('/valuations/snapshot')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            message: 'success',
            data: {
              timestamp: 1725345600000,
              total: 1,
              item: [{ thscode: '600519.SH', ticker: '600519', pe_ttm: 28.5, pe_mrq: 27.2, pb_mrq: 8.5, ps_ttm: 11.2 }],
            },
          }),
        }
      }
      return { ok: false, status: 404 }
    })

    const client = new HiThinkRestClient({
      apiKey: 'test-api-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const fund = await client.getStockFundamentals('600519.SH')
    expect(fund.symbol).toBe('600519.SH')
    expect(fund.peTtm).toBe(28.5)
    expect(fund.peDynamic).toBe(27.2)
    expect(fund.pb).toBe(8.5)
    expect(fund.ps).toBe(11.2)
  })

  it('getLimitUpPool: 成功获取涨停池并映射为 LimitUpPoolItem 列表', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        message: 'success',
        data: {
          timestamp: 1725345600000,
          pagination: { total: 1, pages: 1, size: 50, page: 1 },
          item: [
            {
              thscode: '000001.SZ',
              ticker: '000001',
              name: '平安银行',
              last_price: 11.55,
              price_change_ratio_pct: 10.0,
              limit_up_time: '09:35:00',
              limit_up_reason: '大金融+高股息',
              continue_day_cnt: 2,
              seal_money: 150000000,
            },
          ],
        },
      }),
    })

    const client = new HiThinkRestClient({
      apiKey: 'test-api-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const pool = await client.getLimitUpPool()
    expect(pool).toHaveLength(1)
    expect(pool[0]?.symbol).toBe('000001.SZ')
    expect(pool[0]?.name).toBe('平安银行')
    expect(pool[0]?.consecutiveBoards).toBe(2)
    expect(pool[0]?.sectorConcept).toBe('大金融+高股息')
    expect(pool[0]?.limitOrderAmount).toBe(150000000)
  })

  it('getAuctionSnapshot: 成功获取集合竞价快照', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        message: 'success',
        data: {
          timestamp: 1725345600000,
          item: [
            {
              thscode: '600519.SH',
              ticker: '600519',
              match_price: 1680.0,
              match_volume: 50000,
              unmatched_volume: 12000,
              unmatched_side: 'buy',
              strength_index: 85.5,
              stage: 'final',
            },
          ],
        },
      }),
    })

    const client = new HiThinkRestClient({
      apiKey: 'test-api-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const auction = await client.getAuctionSnapshot('600519.SH')
    expect(auction).toBeDefined()
    expect(auction?.matchPrice).toBe(1680.0)
    expect(auction?.unmatchedSide).toBe('buy')
    expect(auction?.strengthIndex).toBe(85.5)
    expect(auction?.stage).toBe('final')
  })

  it('错误处理：401 映射为 AUTH_FAILED，429 映射为 RATE_LIMITED', async () => {
    const authErrorFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 })
    const clientAuth = new HiThinkRestClient({ fetchImpl: authErrorFetch as unknown as typeof fetch })
    await expect(clientAuth.getTicker('600519')).rejects.toThrow(TradingServiceError)
    await expect(clientAuth.getTicker('600519')).rejects.toMatchObject({ code: 'AUTH_FAILED' })

    const rateLimitFetch = vi.fn().mockResolvedValue({ ok: false, status: 429 })
    const clientRate = new HiThinkRestClient({ fetchImpl: rateLimitFetch as unknown as typeof fetch })
    await expect(clientRate.getTicker('600519')).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  })
})
