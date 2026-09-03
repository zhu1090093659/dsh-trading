import { describe, expect, it } from 'vitest'
import { calculateOrderRatioQuantity } from '../src/client/OrderPanel.js'

describe('calculateOrderRatioQuantity 仓位比例数量计算', () => {
  describe('A 股股票场景 (100股一手，整百取整)', () => {
    // 对应用户截图实际场景：可用资金 100,000，单价 433 元
    it('买入 100%：预算 100,000 / 433 = 230.94 股，向下取整为 200 股 (金额 86,600 <= 100,000)', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'buy',
        ratio: 1.0,
        availableCash: 100_000,
        currentPositionSize: 0,
        referencePrice: 433,
        isSharesUnit: true,
        market: 'cn',
        symbol: '000033.SZ',
      })
      expect(qty).toBe('200')
    })

    it('买入 50%：预算 50,000 / 433 = 115.47 股，向下取整为 100 股 (金额 43,300 <= 50,000)', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'buy',
        ratio: 0.5,
        availableCash: 100_000,
        currentPositionSize: 0,
        referencePrice: 433,
        isSharesUnit: true,
        market: 'cn',
        symbol: '000033.SZ',
      })
      expect(qty).toBe('100')
    })

    it('买入 25%：预算 25,000 / 433 = 57.7 股，不足 100 股(一手)，安全返回 0', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'buy',
        ratio: 0.25,
        availableCash: 100_000,
        currentPositionSize: 0,
        referencePrice: 433,
        isSharesUnit: true,
        market: 'cn',
        symbol: '000033.SZ',
      })
      expect(qty).toBe('0')
    })

    it('卖出 100%：持有 500 股整手，100% 清仓卖出 500 股', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'sell',
        ratio: 1.0,
        availableCash: 50_000,
        currentPositionSize: 500,
        referencePrice: 433,
        isSharesUnit: true,
        market: 'cn',
        symbol: '000033.SZ',
      })
      expect(qty).toBe('500')
    })

    it('卖出 100%：持有 150 股(含50股零股)，100% 清仓一次性全出 150 股', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'sell',
        ratio: 1.0,
        availableCash: 50_000,
        currentPositionSize: 150,
        referencePrice: 433,
        isSharesUnit: true,
        market: 'cn',
        symbol: '000033.SZ',
      })
      expect(qty).toBe('150')
    })

    it('卖出 50%：持有 500 股，50% 减仓卖出 200 股 (向下整百取整)', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'sell',
        ratio: 0.5,
        availableCash: 50_000,
        currentPositionSize: 500,
        referencePrice: 433,
        isSharesUnit: true,
        market: 'cn',
        symbol: '000033.SZ',
      })
      expect(qty).toBe('200')
    })
  })

  describe('美股场景 (按 1 股整数向下取整)', () => {
    it('买入 100%：预算 10,000 / 185.5 = 53.9 股，向下取整为 53 股', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'buy',
        ratio: 1.0,
        availableCash: 10_000,
        currentPositionSize: 0,
        referencePrice: 185.5,
        isSharesUnit: true,
        market: 'us',
        symbol: 'AAPL',
      })
      expect(qty).toBe('53')
    })

    it('卖出 100%：持有 88 股，100% 卖出 88 股', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'sell',
        ratio: 1.0,
        availableCash: 0,
        currentPositionSize: 88,
        referencePrice: 185.5,
        isSharesUnit: true,
        market: 'us',
        symbol: 'AAPL',
      })
      expect(qty).toBe('88')
    })
  })

  describe('加密货币场景 (小数位向下截断防溢出)', () => {
    it('买入 100%：预算 10,000 / 88,000 BTC，截断 4 位小数返回 0.1136 BTC', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'buy',
        ratio: 1.0,
        availableCash: 10_000,
        currentPositionSize: 0,
        referencePrice: 88_000,
        isSharesUnit: false,
        market: 'crypto',
        symbol: 'BTCUSDT',
      })
      expect(qty).toBe('0.1136')
      expect(Number(qty) * 88_000).toBeLessThanOrEqual(10_000)
    })

    it('卖出 100%：持有 1.5432 BTC，100% 卖出 1.5432 BTC', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'sell',
        ratio: 1.0,
        availableCash: 0,
        currentPositionSize: 1.5432,
        referencePrice: 88_000,
        isSharesUnit: false,
        market: 'crypto',
        symbol: 'BTCUSDT',
      })
      expect(qty).toBe('1.5432')
    })
  })

  describe('边界安全防护', () => {
    it('可用资金为 0 时买入返回 0', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'buy',
        ratio: 1.0,
        availableCash: 0,
        currentPositionSize: 0,
        referencePrice: 100,
        isSharesUnit: true,
        market: 'cn',
        symbol: '600519.SH',
      })
      expect(qty).toBe('0')
    })

    it('持有仓位为 0 时卖出返回 0', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'sell',
        ratio: 1.0,
        availableCash: 100_000,
        currentPositionSize: 0,
        referencePrice: 100,
        isSharesUnit: true,
        market: 'cn',
        symbol: '600519.SH',
      })
      expect(qty).toBe('0')
    })

    it('参考价格非法 (<=0) 时买入返回 0', () => {
      const qty = calculateOrderRatioQuantity({
        side: 'buy',
        ratio: 1.0,
        availableCash: 100_000,
        currentPositionSize: 0,
        referencePrice: 0,
        isSharesUnit: true,
        market: 'cn',
        symbol: '600519.SH',
      })
      expect(qty).toBe('0')
    })
  })
})
