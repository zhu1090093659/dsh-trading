import { describe, expect, it, vi } from 'vitest'
import {
  fetchCnAuctionStrength,
  fetchCnLimitUpLadder,
  fetchCnLimitUpPool,
} from '../src/sentiment.ts'
import {
  createGetAuctionStrengthTool,
  createGetLimitUpPoolTool,
} from '../src/index.ts'

describe('A 股特色短线情绪与资金面数据 (sentiment)', () => {
  it('未配置 HITHINK_FINANCE_API_KEY 时，fetchCnLimitUpPool 抛出友好提示', async () => {
    const originalEnv = process.env.HITHINK_FINANCE_API_KEY
    delete process.env.HITHINK_FINANCE_API_KEY
    try {
      await expect(fetchCnLimitUpPool({}, {})).rejects.toThrow('HITHINK_FINANCE_API_KEY is not configured')
    } finally {
      process.env.HITHINK_FINANCE_API_KEY = originalEnv
    }
  })

  it('配置 Key 时，fetchCnLimitUpPool 成功解析涨停池', async () => {
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
              name: '贵州茅台',
              last_price: 1680.5,
              price_change_ratio_pct: 10.0,
              continue_day_cnt: 1,
              seal_money: 500000000,
              limit_up_reason: '白酒+绩优',
            },
          ],
        },
      }),
    })

    const pool = await fetchCnLimitUpPool({}, {
      apiKey: 'test-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    expect(pool).toHaveLength(1)
    expect(pool[0]?.symbol).toBe('600519.SH')
    expect(pool[0]?.name).toBe('贵州茅台')
    expect(pool[0]?.consecutiveBoards).toBe(1)
    expect(pool[0]?.sectorConcept).toBe('白酒+绩优')
  })

  it('cn_get_limit_up_pool 工具正确格式化文本输出', async () => {
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
              thscode: '000001.SZ',
              ticker: '000001',
              name: '平安银行',
              last_price: 12.0,
              price_change_ratio_pct: 10.0,
              continue_day_cnt: 2,
              seal_money: 300000000,
              limit_up_reason: '银行降息红利',
            },
          ],
        },
      }),
    })

    const originalEnv = process.env.HITHINK_FINANCE_API_KEY
    process.env.HITHINK_FINANCE_API_KEY = 'mock-key'
    try {
      const tool = createGetLimitUpPoolTool({ fetch: mockFetch as unknown as typeof fetch })
      const text = await tool.execute({})
      expect(text).toContain('A 股涨停池共 1 只股票')
      expect(text).toContain('平安银行 (000001.SZ)')
      expect(text).toContain('2 连板')
      expect(text).toContain('封单 ￥3.00 亿')
      expect(text).toContain('原因: 银行降息红利')
    } finally {
      process.env.HITHINK_FINANCE_API_KEY = originalEnv
    }
  })

  it('cn_get_auction_strength 工具在无 Key 时优雅返回提示', async () => {
    const originalEnv = process.env.HITHINK_FINANCE_API_KEY
    delete process.env.HITHINK_FINANCE_API_KEY
    try {
      const tool = createGetAuctionStrengthTool()
      const text = await tool.execute({ symbol: '600519' })
      expect(text).toContain('暂无 600519 集合竞价快照数据')
    } finally {
      process.env.HITHINK_FINANCE_API_KEY = originalEnv
    }
  })
})
