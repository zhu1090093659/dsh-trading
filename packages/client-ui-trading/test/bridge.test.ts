/**
 * 行情桥单测：市场清单、批量报价（逐 symbol 独立成败 + 封顶）、K线透传与
 * 参数校验、请求分发路由与协议错误。宿主面全部用假件（不触网）。
 */
import { describe, expect, it } from 'vitest'
import type { MarketDataService } from '@dsh-trading/api'
import {
  BridgeProtocolError,
  MARKET_SERVICE_KEYS,
  MAX_SYMBOLS,
  TradingBridge,
  createBridgeHost,
  dispatchBridgeRequest,
  errorPayload,
  type BridgeHost,
} from '../src/bridge.ts'

function fakeService(overrides: Partial<MarketDataService> = {}): MarketDataService {
  return {
    getTicker: async (symbol) => ({
      symbol, price: 100, timestamp: 1234,
    }),
    getKlines: async () => [{
      openTime: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, closeTime: 2,
    }],
    subscribeTicker: () => ({ dispose() {} }),
    ...overrides,
  }
}

function fakeHost(services: Partial<Record<string, MarketDataService>>, providers: Record<string, string> = {}): BridgeHost {
  return {
    // 键 = 服务键（真实宿主按 MARKET_SERVICE_KEYS 映射），与 index.ts 行为一致。
    getMarketService: market => services[MARKET_SERVICE_KEYS[market]],
    activeProvider: market => providers[market],
  }
}

describe('TradingBridge.markets', () => {
  it('只列已安装市场并带 provider slug', () => {
    const bridge = new TradingBridge(fakeHost({ tradingCryptoMarketData: fakeService() }, { crypto: 'binance' }))
    expect(bridge.markets()).toEqual({ markets: [{ id: 'crypto', provider: 'binance' }] })
  })

  it('零市场安装 → 空清单（headless/无市场包）', () => {
    expect(new TradingBridge(fakeHost({})).markets()).toEqual({ markets: [] })
  })
})

describe('TradingBridge.tickers', () => {
  it('批量报价：逐 symbol 独立成功/失败', async () => {
    const service = fakeService({
      getTicker: async (symbol) => {
        if (symbol === 'BAD') throw Object.assign(new Error('unknown symbol'), { code: 'TRADING_UNSUPPORTED_SYMBOL' })
        return { symbol, price: 7, timestamp: 9 }
      },
    })
    const bridge = new TradingBridge(fakeHost({ tradingUsMarketData: service }))
    const wire = await bridge.tickers('us', ['AAPL', 'BAD', 'AAPL'])
    expect(Object.keys(wire.tickers).sort()).toEqual(['AAPL', 'BAD'])
    expect(wire.tickers.AAPL).toEqual({ ok: true, ticker: { symbol: 'AAPL', price: 7, timestamp: 9 } })
    expect(wire.tickers.BAD).toEqual({ ok: false, code: 'TRADING_UNSUPPORTED_SYMBOL', message: 'unknown symbol' })
  })

  it('未安装市场 → 400 协议错误；超封顶 → 400；空 symbols → 400', async () => {
    const bridge = new TradingBridge(fakeHost({}))
    await expect(bridge.tickers('cn', ['600519'])).rejects.toThrowError(BridgeProtocolError)
    await expect(bridge.tickers('crypto', Array.from({ length: MAX_SYMBOLS + 1 }, (_, i) => `S${i}`)))
      .rejects.toThrowError(/too many symbols/)
    await expect(bridge.tickers('crypto', [''])).rejects.toThrowError(/symbols is required/)
  })
})

describe('TradingBridge.klines', () => {
  it('透传 interval 与 limit，返回服务结果', async () => {
    const service = fakeService()
    const bridge = new TradingBridge(fakeHost({ tradingHkMarketData: service }))
    const wire = await bridge.klines('hk', '00700', '1w', '40')
    expect(wire.klines).toHaveLength(1)
  })

  it('非法 limit → 400；未安装市场 → 400', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingHkMarketData: fakeService() }))
    await expect(bridge.klines('hk', '00700', '1w', '0')).rejects.toThrowError(/limit/)
    await expect(bridge.klines('us', 'AAPL', '1d')).rejects.toThrowError(/not installed/)
  })
})

describe('TradingBridge.symbols', () => {
  it('服务实现 listInstruments 时返回标的名册并缓存', async () => {
    let callCount = 0
    const service = fakeService({
      listInstruments: async () => {
        callCount++
        return [{ symbol: 'BTCUSDT', name: 'BTC/USDT' }, { symbol: 'ETHUSDT' }]
      },
    })
    const bridge = new TradingBridge(fakeHost({ tradingCryptoMarketData: service }))
    const res1 = await bridge.symbols('crypto')
    expect(res1.symbols).toEqual([
      { symbol: 'BTCUSDT', name: 'BTC/USDT' },
      { symbol: 'ETHUSDT' },
    ])
    expect(callCount).toBe(1)

    // 第二次调用命中进程内 TTL 缓存
    const res2 = await bridge.symbols('crypto')
    expect(res2.symbols).toHaveLength(2)
    expect(callCount).toBe(1)
  })

  it('服务未实现 listInstruments 时静默返回空数组', async () => {
    const service = fakeService()
    const bridge = new TradingBridge(fakeHost({ tradingUsMarketData: service }))
    const res = await bridge.symbols('us')
    expect(res.symbols).toEqual([])
  })

  it('未安装市场 → 400', async () => {
    const bridge = new TradingBridge(fakeHost({}))
    await expect(bridge.symbols('cn')).rejects.toThrowError(BridgeProtocolError)
  })
})

describe('dispatchBridgeRequest', () => {
  const bridge = new TradingBridge(fakeHost({
    tradingCryptoMarketData: fakeService({
      listInstruments: async () => [{ symbol: 'BTCUSDT' }],
    }),
  }))

  it('GET /markets → 200', async () => {
    const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', '/markets', new URLSearchParams())
    expect(status).toBe(200)
    expect(payload).toEqual({ markets: [{ id: 'crypto' }] })
  })

  it('GET /tickers → 200 批量', async () => {
    const search = new URLSearchParams({ market: 'crypto', symbols: 'BTCUSDT' })
    const { payload } = await dispatchBridgeRequest(bridge, 'GET', '/tickers', search)
    expect(payload).toMatchObject({ tickers: { BTCUSDT: { ok: true } } })
  })

  it('GET /symbols → 200', async () => {
    const search = new URLSearchParams({ market: 'crypto' })
    const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', '/symbols', search)
    expect(status).toBe(200)
    expect(payload).toEqual({ symbols: [{ symbol: 'BTCUSDT' }] })
  })

  it('未知端点 404、非 GET/DELETE 405', async () => {
    await expect(dispatchBridgeRequest(bridge, 'GET', '/nope', new URLSearchParams()))
      .rejects.toThrowError(/no such endpoint/)
    await expect(dispatchBridgeRequest(bridge, 'POST', '/markets', new URLSearchParams()))
      .rejects.toThrowError(/only GET/)
  })

  it('GET /indicators/custom & DELETE /indicators/custom', async () => {
    const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', '/indicators/custom', new URLSearchParams())
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, indicators: [] })

    const delRes = await dispatchBridgeRequest(bridge, 'DELETE', '/indicators/custom', new URLSearchParams({ id: 'test' }))
    expect(delRes.status).toBe(200)
    expect(delRes.payload).toEqual({ ok: true, removed: false })
  })
})


describe('createBridgeHost（registry-first，2026-08-30 整改 #1）', () => {
  it('注册表有激活项 → 用注册表服务；路由切换后即刻解析到新服务（热切换）', async () => {
    const binance = fakeService({ getTicker: async (symbol) => ({ symbol, price: 1, timestamp: 1 }) })
    const okx = fakeService({ getTicker: async (symbol) => ({ symbol, price: 2, timestamp: 2 }) })
    let routed: string | undefined = 'binance'
    const registry = {
      active: (market: string) => {
        if (market !== 'crypto' || routed === undefined) return undefined
        return { provider: routed, service: routed === 'okx' ? okx : binance }
      },
    }
    const host = createBridgeHost({ registry, legacy: () => undefined })
    const bridge = new TradingBridge(host)
    expect(host.activeProvider('crypto')).toBe('binance')
    let wire = await bridge.tickers('crypto', ['BTCUSDT'])
    expect(wire.tickers.BTCUSDT).toMatchObject({ ok: true, ticker: { price: 1 } })
    routed = 'okx' // 模拟 settings 变更（无需重启、无需 watch）
    wire = await bridge.tickers('crypto', ['BTCUSDT'])
    expect(wire.tickers.BTCUSDT).toMatchObject({ ok: true, ticker: { price: 2 } })
    expect(host.activeProvider('crypto')).toBe('okx')
  })

  it('注册表选中但未注册（包未装）→ 400 未安装，不静默降级；activeProvider 回退 router 值', () => {
    const host = createBridgeHost({
      registry: { active: () => undefined },
      router: { activeProvider: () => 'okx' },
      legacy: () => undefined,
    })
    expect(host.getMarketService('crypto')).toBeUndefined()
    expect(host.activeProvider('crypto')).toBe('okx') // 用户能看到设置目标
  })

  it('注册表缺席（老部署）→ 回退 legacy 市场键直读', async () => {
    const legacy = fakeService()
    const host = createBridgeHost({ legacy: () => legacy })
    const wire = await new TradingBridge(host).tickers('crypto', ['BTCUSDT'])
    expect(wire.tickers.BTCUSDT).toMatchObject({ ok: true })
    expect(host.activeProvider('crypto')).toBeUndefined()
  })
})

describe('errorPayload', () => {
  it('带 code 的 Error 提取词汇，普通 Error 落 TRADING_UNKNOWN，非 Error 字符串化', () => {
    expect(errorPayload(Object.assign(new Error('x'), { code: 'TRADING_NETWORK' })))
      .toEqual({ code: 'TRADING_NETWORK', message: 'x' })
    expect(errorPayload(new Error('y')).code).toBe('TRADING_UNKNOWN')
    expect(errorPayload('boom')).toEqual({ code: 'TRADING_UNKNOWN', message: 'boom' })
  })
})
