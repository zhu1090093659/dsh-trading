/**
 * Bybit 账户读面的失败关闭语义：连接器没有签名私有读实现，读面必须显式拒绝，
 * 不得用常量余额、空数组或编造订单冒充交易所账户真值——base 的 <market>_get_*
 * 工具与 GUI 桥按「交易所账户真值」消费同一注册面（packages/base/src/market-tools.ts、
 * packages/bot-api/src/bridge.ts），见 docs/guides/connectors-guide.md 的 Bybit 行。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { BybitTradeService, type Config } from '../src/index.js'

function bybitTrade(overrides: Partial<Config> = {}): BybitTradeService {
  const config: Config = {
    enabled: true,
    env: 'demo',
    dryRun: true,
    liveTrading: false,
    apiKeyRef: 'BYBIT_API_KEY',
    secretRef: 'BYBIT_SECRET_KEY',
    ...overrides,
  }
  return new BybitTradeService(new CordisContext() as never, { apiKey: 'k', apiSecret: 's', config })
}

describe('BybitTradeService 账户读面（无签名实现 ⇒ 失败关闭）', () => {
  it('运营者读取 Bybit 余额：可选方法缺席，消费方按 TRADING_NOT_IMPLEMENTED 处理', () => {
    // Given: 一个按契约装配的 Bybit 交易服务（无签名私有读实现）
    const trade = bybitTrade()
    // When: 消费方探测可选读方法是否存在
    // Then: getBalances 缺席——不是返回常量 100000 USDT 的假余额
    const probe = trade as unknown as Record<string, unknown>
    expect(probe.getBalances).toBeUndefined()
    expect('getBalances' in trade).toBe(false)
  })

  it('运营者读取 Bybit 挂单与成交：可选方法缺席，不得用空数组冒充没有挂单', () => {
    // Given: 一个按契约装配的 Bybit 交易服务
    const trade = bybitTrade()
    // When: 消费方探测可选读方法是否存在
    // Then: listOpenOrders / listTradeFills 都缺席，消费方走「可选方法缺席」语义
    const probe = trade as unknown as Record<string, unknown>
    expect(probe.listOpenOrders).toBeUndefined()
    expect(probe.listTradeFills).toBeUndefined()
  })

  it('运营者读取 Bybit 持仓：必需方法显式拒绝，不得返回空数组', async () => {
    // Given: 一个按契约装配的 Bybit 交易服务
    const trade = bybitTrade()
    // When: 消费方按 TradeService 契约请求持仓
    // Then: 抛 TRADING_NOT_IMPLEMENTED，且文案说明不可用不等于没有持仓
    await expect(trade.getPositions()).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(trade.getPositions()).rejects.toThrow(/NOT "no positions"/)
  })

  it('运营者按订单号查询 Bybit 订单：显式拒绝，不得编造状态为 new 的订单', async () => {
    // Given: 一个按契约装配的 Bybit 交易服务
    const trade = bybitTrade()
    // When: 消费方按 (symbol, orderId) 查询单笔订单
    // Then: 抛 TRADING_NOT_IMPLEMENTED，且文案说明不可用不等于订单不存在
    await expect(trade.getOrder('BTCUSDT', 'ord-1')).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(trade.getOrder('BTCUSDT', 'ord-1')).rejects.toThrow(/NOT "order not found"/)
  })

  it('运营者以 dry-run 下单：本地模拟回执与三态闸门保持不变', async () => {
    // Given: 一个缺省配置（dryRun=true、liveTrading=false）的 Bybit 交易服务
    const trade = bybitTrade()
    // When: 直调服务缝下单（模拟动态包注入的调用面）
    const order = await trade.placeOrder({ symbol: 'BTCUSDT', side: 'buy', type: 'market', quantity: 1 })
    // Then: 仍返回标注 dryRun 的本地回执，不触网、不改变闸门语义
    expect(order.dryRun).toBe(true)
    expect(order.status).toBe('filled')
  })
})
