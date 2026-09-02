/**
 * 行情桥单测：市场清单、批量报价（逐 symbol 独立成败 + 封顶）、K线透传与
 * 参数校验、请求分发路由与协议错误。宿主面全部用假件（不触网）。
 */
import { describe, expect, it } from 'vitest'
import type { MarketDataService } from '@dsh-trading/api'
import { createMemoryCustomStrategyStore } from '@dsh-trading/strategies'
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

describe('TradingBridge.fundamentals（2026-09-02 基本面页签）', () => {
  it('透传注册表解析出服务的 getFundamentals', async () => {
    const service = fakeService({
      getFundamentals: async (symbol: string) => ({
        symbol, name: '贵州茅台', marketCap: 1_621_856_000_000, peTtm: 19.7,
        fiftyTwoWeekHigh: 1539.98, fiftyTwoWeekLow: 1151.01, timestamp: 1234,
      }),
    })
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: service }))
    const search = new URLSearchParams({ market: 'cn', symbol: '600519.SH' })
    const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', '/fundamentals', search)
    expect(status).toBe(200)
    expect(payload).toMatchObject({ ok: true, fundamentals: { symbol: '600519.SH', peTtm: 19.7 } })
  })

  it('连接器未实现 getFundamentals → TRADING_NOT_IMPLEMENTED 业务错误（前端降级派生数据）', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingUsMarketData: fakeService() }))
    const search = new URLSearchParams({ market: 'us', symbol: 'AAPL' })
    await expect(dispatchBridgeRequest(bridge, 'GET', '/fundamentals', search))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
  })

  it('未知市场 400；缺 symbol 400', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: fakeService() }))
    await expect(dispatchBridgeRequest(bridge, 'GET', '/fundamentals', new URLSearchParams({ market: 'jp', symbol: 'X' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
    await expect(dispatchBridgeRequest(bridge, 'GET', '/fundamentals', new URLSearchParams({ market: 'cn' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
  })
})

describe('TradingBridge.derivatives（issue #38 衍生品面板）', () => {
  it('透传注册表解析出服务的 getDerivatives', async () => {
    const service = fakeService({
      getDerivatives: async (symbol: string) => ({
        symbol: `${symbol}-SWAP`, source: 'binance', openInterest: 80_000.5,
        fundingRate: 0.0001, longShortRatio: 1.1, timestamp: 1234,
      }),
    })
    const bridge = new TradingBridge(fakeHost({ tradingCryptoMarketData: service }))
    const search = new URLSearchParams({ market: 'crypto', symbol: 'BTCUSDT' })
    const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', '/derivatives', search)
    expect(status).toBe(200)
    expect(payload).toMatchObject({ ok: true, derivatives: { symbol: 'BTCUSDT-SWAP', source: 'binance', openInterest: 80_000.5 } })
  })

  it('连接器未实现 getDerivatives（现货/股票数据源）→ TRADING_NOT_IMPLEMENTED（前端隐藏面板）', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingUsMarketData: fakeService() }))
    const search = new URLSearchParams({ market: 'us', symbol: 'AAPL' })
    await expect(dispatchBridgeRequest(bridge, 'GET', '/derivatives', search))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
  })

  it('未知市场 400；缺 symbol 400', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingCryptoMarketData: fakeService() }))
    await expect(dispatchBridgeRequest(bridge, 'GET', '/derivatives', new URLSearchParams({ market: 'jp', symbol: 'X' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
    await expect(dispatchBridgeRequest(bridge, 'GET', '/derivatives', new URLSearchParams({ market: 'crypto' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
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

  it('未知端点 404；未支持的 HTTP 方法 405（issue #32 起支持 GET/PUT/POST/DELETE）', async () => {
    await expect(dispatchBridgeRequest(bridge, 'GET', '/nope', new URLSearchParams()))
      .rejects.toThrowError(/no such endpoint/)
    await expect(dispatchBridgeRequest(bridge, 'POST', '/markets', new URLSearchParams()))
      .rejects.toThrowError(/no such endpoint/)
    await expect(dispatchBridgeRequest(bridge, 'PATCH', '/markets', new URLSearchParams()))
      .rejects.toThrowError(/only GET\/PUT\/POST\/DELETE/)
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

describe('TradingBridge.knowledgeCards', () => {
  it('GET /knowledge/cards 端点返回知识卡片列表', async () => {
    const bridge = new TradingBridge(fakeHost({}))
    const res = await dispatchBridgeRequest(bridge, 'GET', '/knowledge/cards', new URLSearchParams())
    expect(res.status).toBe(200)
    expect(res.payload).toMatchObject({ ok: true, cards: [] })
  })
})

describe('TradingBridge.customStrategies（issue #31 / P2）', () => {
  const RECORD = {
    id: 'demo-fs',
    title: '演示策略',
    horizon: 'swing',
    summary: '演示用',
    paramsJson: '[]',
    computeSource: '(bars) => []',
    createdAt: 1700000000000,
  }

  it('GET /strategies/custom 返回自定义策略名册', async () => {
    const host = createBridgeHost({ legacy: () => undefined, strategyStore: createMemoryCustomStrategyStore([RECORD]) })
    const res = await dispatchBridgeRequest(new TradingBridge(host), 'GET', '/strategies/custom', new URLSearchParams())
    expect(res.status).toBe(200)
    expect(res.payload).toMatchObject({ ok: true, strategies: [RECORD] })
  })

  it('DELETE /strategies/custom?id= 删除并回执 removed；缺 id → 400', async () => {
    const host = createBridgeHost({ legacy: () => undefined, strategyStore: createMemoryCustomStrategyStore([RECORD]) })
    const bridge = new TradingBridge(host)
    const del = await dispatchBridgeRequest(bridge, 'DELETE', '/strategies/custom', new URLSearchParams({ id: 'demo-fs' }))
    expect(del.payload).toMatchObject({ ok: true, removed: true })
    const after = await dispatchBridgeRequest(bridge, 'GET', '/strategies/custom', new URLSearchParams())
    expect((after.payload as { strategies: unknown[] }).strategies).toHaveLength(0)
    await expect(dispatchBridgeRequest(bridge, 'DELETE', '/strategies/custom', new URLSearchParams()))
      .rejects.toThrowError(/id is required/)
  })

  it('strategyStore 缺席 → 空名册 + removed:false（老部署降级）', async () => {
    const bridge = new TradingBridge(fakeHost({}))
    const list = await dispatchBridgeRequest(bridge, 'GET', '/strategies/custom', new URLSearchParams())
    expect(list.payload).toMatchObject({ ok: true, strategies: [] })
    const del = await dispatchBridgeRequest(bridge, 'DELETE', '/strategies/custom', new URLSearchParams({ id: 'x' }))
    expect(del.payload).toMatchObject({ ok: true, removed: false })
  })
})

describe('watchlist + selection endpoints（issue #32 / P3）', () => {
  function makeWatchlistHost() {
    const host = createBridgeHost({ legacy: () => undefined })
    return { host, bridge: new TradingBridge(host) }
  }

  it('POST /watchlists 追加行（幂等 added）→ GET 可见 → DELETE 移除', async () => {
    const { bridge } = makeWatchlistHost()
    const add = await dispatchBridgeRequest(bridge, 'POST', '/watchlists', new URLSearchParams(), { market: 'us', symbol: 'AAPL', name: '苹果' })
    expect(add.payload).toMatchObject({ ok: true, added: true, instrument: { market: 'us', symbol: 'AAPL' } })
    const dup = await dispatchBridgeRequest(bridge, 'POST', '/watchlists', new URLSearchParams(), { market: 'us', symbol: 'AAPL' })
    expect((dup.payload as { added: boolean }).added).toBe(false)

    const list = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    expect(list.payload).toMatchObject({ ok: true, watchlists: { us: [{ market: 'us', symbol: 'AAPL', name: '苹果' }] } })

    const del = await dispatchBridgeRequest(bridge, 'DELETE', '/watchlists', new URLSearchParams({ market: 'us', symbol: 'AAPL' }))
    expect(del.payload).toMatchObject({ ok: true, removed: true })
    await expect(dispatchBridgeRequest(bridge, 'DELETE', '/watchlists', new URLSearchParams({ market: 'us' })))
      .rejects.toThrowError(/market and symbol are required/)
  })

  it('PUT /watchlists 全量替换 + 形状校验 400', async () => {
    const { bridge } = makeWatchlistHost()
    const put = await dispatchBridgeRequest(bridge, 'PUT', '/watchlists', new URLSearchParams(), {
      watchlists: { hk: [{ market: 'hk', symbol: '00700', name: '腾讯控股' }] },
    })
    expect(put.payload).toMatchObject({ ok: true, watchlists: { hk: [{ symbol: '00700' }] } })
    await expect(dispatchBridgeRequest(bridge, 'PUT', '/watchlists', new URLSearchParams(), {
      watchlists: { us: [{ symbol: '' }] },
    })).rejects.toThrowError(/string symbol/)
  })

  it('POST /watchlists/import：host 为空导入成功；非空拒绝（幂等）', async () => {
    const { bridge } = makeWatchlistHost()
    const first = await dispatchBridgeRequest(bridge, 'POST', '/watchlists/import', new URLSearchParams(), {
      watchlists: { crypto: [{ market: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin' }] },
    })
    expect(first.payload).toMatchObject({ ok: true, imported: true })
    const second = await dispatchBridgeRequest(bridge, 'POST', '/watchlists/import', new URLSearchParams(), {
      watchlists: { us: [{ market: 'us', symbol: 'AAPL' }] },
    })
    expect(second.payload).toMatchObject({ ok: false, imported: false })
    const list = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    expect((list.payload as { watchlists: { us?: unknown } }).watchlists.us).toBeUndefined()
  })

  it('PUT/GET /selection：设置与读取；非字符串字段容错', async () => {
    const { bridge } = makeWatchlistHost()
    await dispatchBridgeRequest(bridge, 'PUT', '/selection', new URLSearchParams(), {
      instrument: { market: 'cn', symbol: '600519', name: '贵州茅台' },
    })
    const got = await dispatchBridgeRequest(bridge, 'GET', '/selection', new URLSearchParams())
    expect(got.payload).toMatchObject({ ok: true, instrument: { market: 'cn', symbol: '600519', name: '贵州茅台' } })
    const nulled = await dispatchBridgeRequest(bridge, 'PUT', '/selection', new URLSearchParams(), { instrument: null })
    expect(nulled.payload).toMatchObject({ ok: true, instrument: null })
  })

  it('store 缺席（老部署）→ 全部端点空降级', async () => {
    const bridge = new TradingBridge(fakeHost({}))
    const list = await dispatchBridgeRequest(bridge, 'GET', '/watchlists', new URLSearchParams())
    expect(list.payload).toMatchObject({ ok: true, watchlists: {} })
    const sel = await dispatchBridgeRequest(bridge, 'GET', '/selection', new URLSearchParams())
    expect(sel.payload).toMatchObject({ ok: true, instrument: null })
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
