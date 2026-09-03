import { beforeEach, describe, expect, it } from 'vitest'
import { paperTradingStore } from '../src/client/paper-trading-store.js'

describe('PaperTradingStore 模拟交易引擎与本地账本', () => {
  beforeEach(() => {
    // 每次测试前重置为默认 100,000 资金
    paperTradingStore.resetAccount(100_000)
  })

  it('初始状态：默认 100,000 虚拟资金，持仓与流水为空', () => {
    const acc = paperTradingStore.getAccount()
    expect(acc.cash).toBe(100_000)
    expect(acc.initialCash).toBe(100_000)
    expect(acc.positions).toEqual([])
    expect(acc.orders).toEqual([])
    expect(acc.fills).toEqual([])

    const balances = paperTradingStore.getBalances()
    expect(balances).toHaveLength(1)
    expect(balances[0]?.free).toBe(100_000)
    expect(balances[0]?.locked).toBe(0)
  })

  it('买入市价单：即刻按现价撮合，扣减资金，生成持仓与成交流水', () => {
    const order = paperTradingStore.placeOrder({
      symbol: 'BTCUSDT',
      side: 'buy',
      type: 'market',
      quantity: 0.5,
      currentPrice: 80_000,
    })

    expect(order.status).toBe('filled')
    expect(order.dryRun).toBe(true)
    expect(order.price).toBe(80_000)
    expect(order.quantity).toBe(0.5)

    const acc = paperTradingStore.getAccount()
    // 扣减 0.5 * 80,000 = 40,000
    expect(acc.cash).toBe(60_000)
    expect(acc.positions).toHaveLength(1)
    expect(acc.positions[0]?.symbol).toBe('BTCUSDT')
    expect(acc.positions[0]?.size).toBe(0.5)
    expect(acc.positions[0]?.entryPrice).toBe(80_000)

    expect(acc.fills).toHaveLength(1)
    expect(acc.fills[0]?.symbol).toBe('BTCUSDT')
    expect(acc.fills[0]?.amount).toBe(0.5)
  })

  it('多次买入同一标的：自动计算加权平均持仓成本', () => {
    // 第一次买入：0.5 个 @ 80,000 (成本 40,000)
    paperTradingStore.placeOrder({
      symbol: 'ETHUSDT',
      side: 'buy',
      type: 'market',
      quantity: 0.5,
      currentPrice: 80_000,
    })

    // 第二次买入：1.5 个 @ 100,000 (成本 150,000) -> 需 150,000 资金，当前剩余 60,000 会不足
    // 我们改用合理数量：0.5 个 @ 60,000 (成本 30,000)
    paperTradingStore.placeOrder({
      symbol: 'ETHUSDT',
      side: 'buy',
      type: 'market',
      quantity: 0.5,
      currentPrice: 60_000,
    })

    const pos = paperTradingStore.getPositions()[0]
    expect(pos?.size).toBe(1.0)
    // 加权均价 = (40,000 + 30,000) / 1.0 = 70,000
    expect(pos?.entryPrice).toBe(70_000)
  })

  it('资金不足保护：购买总额超过可用现金时抛出明确异常', () => {
    expect(() => {
      paperTradingStore.placeOrder({
        symbol: 'BTCUSDT',
        side: 'buy',
        type: 'market',
        quantity: 2,
        currentPrice: 80_000, // 需 160,000 > 100,000
      })
    }).toThrow(/模拟账户可用资金不足/)
  })

  it('卖出平仓：增加可用资金，扣减持仓数量，清空后移除持仓条目', () => {
    // 先买入 1 个 @ 50,000
    paperTradingStore.placeOrder({
      symbol: 'SOLUSDT',
      side: 'buy',
      type: 'market',
      quantity: 1,
      currentPrice: 50_000,
    })
    expect(paperTradingStore.getAccount().cash).toBe(50_000)

    // 卖出 0.4 个 @ 60,000 (回款 24,000)
    paperTradingStore.placeOrder({
      symbol: 'SOLUSDT',
      side: 'sell',
      type: 'market',
      quantity: 0.4,
      currentPrice: 60_000,
    })
    expect(paperTradingStore.getAccount().cash).toBe(74_000)
    expect(paperTradingStore.getPositions()[0]?.size).toBe(0.6)

    // 全部卖出剩余 0.6 个 @ 65,000 (回款 39,000)
    paperTradingStore.placeOrder({
      symbol: 'SOLUSDT',
      side: 'sell',
      type: 'market',
      quantity: 0.6,
      currentPrice: 65_000,
    })
    expect(paperTradingStore.getAccount().cash).toBe(113_000)
    expect(paperTradingStore.getPositions()).toHaveLength(0)
  })

  it('持仓不足保护：无持仓或卖出数量超额时抛出明确异常', () => {
    expect(() => {
      paperTradingStore.placeOrder({
        symbol: 'DOGEUSDT',
        side: 'sell',
        type: 'market',
        quantity: 100,
        currentPrice: 0.2,
      })
    }).toThrow(/模拟账户持仓不足/)
  })

  it('行情跳动联动：updatePrices 动态刷新持仓未实现盈亏 uPnL', () => {
    paperTradingStore.placeOrder({
      symbol: '600519.SH',
      side: 'buy',
      type: 'market',
      quantity: 10,
      currentPrice: 1500,
    })

    // 价格上涨至 1650 (+10%)
    paperTradingStore.updatePrices({ '600519.SH': 1650 })
    const pos = paperTradingStore.getPositions()[0]
    expect(pos?.unrealizedPnl).toBe(1500) // (1650 - 1500) * 10 = 1500
    expect(pos?.markPrice).toBe(1650)
  })

  it('一键重置：恢复出厂初始资金并清空持仓流水', () => {
    paperTradingStore.placeOrder({
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      quantity: 10,
      currentPrice: 200,
    })
    expect(paperTradingStore.getPositions()).toHaveLength(1)

    paperTradingStore.resetAccount(100_000)
    expect(paperTradingStore.getAccount().cash).toBe(100_000)
    expect(paperTradingStore.getPositions()).toHaveLength(0)
    expect(paperTradingStore.getOrders()).toHaveLength(0)
    expect(paperTradingStore.getFills()).toHaveLength(0)
  })
})
