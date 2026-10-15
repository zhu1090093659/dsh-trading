/**
 * 行情桥单测：市场清单、批量报价（逐 symbol 独立成败 + 封顶）、K线透传与
 * 参数校验、请求分发路由与协议错误。宿主面全部用假件（不触网）。
 */
import { fakeMarketService } from '@dshtrading/test-support'
import type { GuiApprovalSeat } from '../src/gui-approval.ts'
import { describe, expect, it, vi } from 'vitest'
import type { MarketDataService, NewsAggregator, Ticker } from '@dshtrading/api'
import { createMemoryCustomStrategyStore } from '@dshtrading/strategies'
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

// 基本面 pkg 下钻（kit-cn/hk/us/crypto）在单测里绝不触网：全局 fetch 桩，
// kit 层 fetchJsonUpstream 拿到 rejection 后按契约静默降级（snapshot 兜底）。
vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error('bridge.test must not hit network')
}))

const fakeService = (overrides: Partial<MarketDataService> = {}): MarketDataService => fakeMarketService({
  getTicker: async (symbol) => ({ symbol, price: 100, timestamp: 1234 }),
  getKlines: async () => [{ openTime: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, closeTime: 2 }],
  ...overrides,
})

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

  it('用户自选栏一拍取五只标的时桥只调一次 getTickers 且入参是去重后的全部符号', async () => {
    // Given 一个记录批量/逐只入参的行情服务（五只标的批量都能拿到）
    const batchCalls: string[][] = []
    const singleCalls: string[] = []
    const service = fakeService({
      getTicker: async (symbol) => {
        singleCalls.push(symbol)
        return { symbol, price: 1, timestamp: 2 }
      },
      getTickers: async (symbols) => {
        batchCalls.push([...symbols])
        return Object.fromEntries(symbols.map(symbol => [symbol, { symbol, price: 9, timestamp: 8 }]))
      },
    })
    const bridge = new TradingBridge(fakeHost({ tradingUsMarketData: service }))

    // When 客户端一拍请求五只（带重复项与空白项）
    const wire = await bridge.tickers('us', ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'AAPL', ' '])

    // Then 上游只被请求一次，入参是去重后的五个符号，逐只路径一次也没走
    expect(batchCalls).toEqual([['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN']])
    expect(singleCalls).toEqual([])
    expect(Object.keys(wire.tickers)).toEqual(['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN'])
    expect(wire.tickers.AMZN).toEqual({ ok: true, ticker: { symbol: 'AMZN', price: 9, timestamp: 8 } })
  })

  it('管理员看到的标的中批量未收录的那只回落单取并保住它自己的错误码', async () => {
    // Given 批量端点只认得 AAPL，MSFT/BAD 缺行；单取对 BAD 抛市场错误码
    const singleCalls: string[] = []
    const service = fakeService({
      getTicker: async (symbol) => {
        singleCalls.push(symbol)
        if (symbol === 'BAD') throw Object.assign(new Error('unknown symbol'), { code: 'TRADING_UNSUPPORTED_SYMBOL' })
        return { symbol, price: 3, timestamp: 4 }
      },
      getTickers: async () => ({ AAPL: { symbol: 'AAPL', price: 9, timestamp: 8 } }),
    })
    const bridge = new TradingBridge(fakeHost({ tradingUsMarketData: service }))

    // When 客户端请求 AAPL / MSFT / BAD 三只
    const wire = await bridge.tickers('us', ['AAPL', 'MSFT', 'BAD'])

    // Then 只有缺行的两只走单取，且各自成败独立、错误码与顺序原样保留
    expect(singleCalls).toEqual(['MSFT', 'BAD'])
    expect(Object.keys(wire.tickers)).toEqual(['AAPL', 'MSFT', 'BAD'])
    expect(wire.tickers.AAPL).toEqual({ ok: true, ticker: { symbol: 'AAPL', price: 9, timestamp: 8 } })
    expect(wire.tickers.MSFT).toEqual({ ok: true, ticker: { symbol: 'MSFT', price: 3, timestamp: 4 } })
    expect(wire.tickers.BAD).toEqual({ ok: false, code: 'TRADING_UNSUPPORTED_SYMBOL', message: 'unknown symbol' })
  })

  it('管理员遇到上游整批故障时全批记同一份错误信封且不再逐只重试', async () => {
    // Given 批量端点整批抛网络错误，单取路径可被记录
    const singleCalls: string[] = []
    const service = fakeService({
      getTicker: async (symbol) => {
        singleCalls.push(symbol)
        return { symbol, price: 1, timestamp: 1 }
      },
      getTickers: async () => {
        throw Object.assign(new Error('upstream unavailable'), { code: 'TRADING_UPSTREAM_ERROR' })
      },
    })
    const bridge = new TradingBridge(fakeHost({ tradingUsMarketData: service }))

    // When 客户端一拍请求三只
    const wire = await bridge.tickers('us', ['AAPL', 'MSFT', 'NVDA'])

    // Then 三只记同一份信封，一只都没有回落单取（故障期不放大请求）
    expect(singleCalls).toEqual([])
    const envelope = { ok: false, code: 'TRADING_UPSTREAM_ERROR', message: 'upstream unavailable' }
    expect(wire.tickers).toEqual({ AAPL: envelope, MSFT: envelope, NVDA: envelope })
  })

  it('客户遇到的连接器未实现批量能力时逐只取数：入参去重透传、逐 symbol 独立成败', async () => {
    // Given 一个只有 getTicker 的连接器服务（无 getTickers），BAD 抛错码
    const singleCalls: string[] = []
    const service = fakeService({
      getTicker: async (symbol) => {
        singleCalls.push(symbol)
        if (symbol === 'BAD') throw Object.assign(new Error('unknown symbol'), { code: 'TRADING_SYMBOL_NOT_FOUND' })
        return { symbol, price: 5, timestamp: 6 }
      },
    })
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: service }))

    // When 客户端请求 AAPL / BAD / AAPL
    const wire = await bridge.tickers('cn', ['AAPL', 'BAD', 'AAPL'])

    // Then 无批量能力可走：单取拿到去重后的两只，成败各自成信封
    expect('getTickers' in service).toBe(false)
    expect(singleCalls).toEqual(['AAPL', 'BAD'])
    expect(wire.tickers).toEqual({
      AAPL: { ok: true, ticker: { symbol: 'AAPL', price: 5, timestamp: 6 } },
      BAD: { ok: false, code: 'TRADING_SYMBOL_NOT_FOUND', message: 'unknown symbol' },
    })
  })

  it('管理员遇到批量端点返回空值时该符号回落单取，空值不会当成行情上行', async () => {
    // Given 记录调用入参的连接器：getTickers 对两只符号都返回空值（契约外实现），
    //       getTicker 对 AAPL 正常返回、对 BAD 抛 TRADING_SYMBOL_NOT_FOUND
    const batchCalls: string[][] = []
    const singleCalls: string[] = []
    const service = fakeService({
      getTicker: async (symbol) => {
        singleCalls.push(symbol)
        if (symbol === 'BAD') throw Object.assign(new Error('unknown symbol'), { code: 'TRADING_SYMBOL_NOT_FOUND' })
        return { symbol, price: 11, timestamp: 12 }
      },
      getTickers: async (symbols) => {
        batchCalls.push([...symbols])
        return { AAPL: null, BAD: null } as unknown as Record<string, Ticker>
      },
    })
    const bridge = new TradingBridge(fakeHost({ tradingUsMarketData: service }))

    // When 客户端一拍请求这两只
    const wire = await bridge.tickers('us', ['AAPL', 'BAD'])

    // Then 走的确实是批量路径（不是「未实现 getTickers」路径），且两只符号全部回落单取
    expect(batchCalls).toEqual([['AAPL', 'BAD']])
    expect(singleCalls).toEqual(['AAPL', 'BAD'])
    // Then AAPL 从单取拿到真值，BAD 拿到它自己的错误信封（空值一律不当作行情上行）
    expect(wire.tickers).toEqual({
      AAPL: { ok: true, ticker: { symbol: 'AAPL', price: 11, timestamp: 12 } },
      BAD: { ok: false, code: 'TRADING_SYMBOL_NOT_FOUND', message: 'unknown symbol' },
    })
    // Then wire 里不存在任何 ticker:null / ticker:undefined：成功信封的 ticker 必为非空对象，失败信封无 ticker 键
    for (const outcome of Object.values(wire.tickers)) {
      if (outcome.ok) {
        expect(typeof outcome.ticker).toBe('object')
        expect(outcome.ticker).not.toBeNull()
      } else {
        expect(outcome).not.toHaveProperty('ticker')
      }
    }
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

  it('用户按五日 1m 窗口取数时桥放行 2500 并把 limit 原样透传给服务', async () => {
    // Given 一个记录入参的行情服务
    const seen: Array<{ symbol: string; interval: string; limit: number | undefined }> = []
    const service = fakeService({
      getKlines: async (symbol, interval, limit) => {
        seen.push({ symbol, interval, limit })
        return [{ openTime: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, closeTime: 2 }]
      },
    })
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: service }))

    // When 客户端请求五日 1m 窗口（2500 = MAX_KLINE_LIMIT）
    const wire = await bridge.klines('cn', '600519', '1m', '2500')

    // Then 请求通过并且 limit 未被改写
    expect(wire.klines).toHaveLength(1)
    expect(seen).toEqual([{ symbol: '600519', interval: '1m', limit: 2500 }])
  })

  it('用户请求超过封顶的 limit 时桥以 400 拒绝（不静默截断）', async () => {
    // Given 桥安装行情服务
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: fakeService() }))

    // When 客户端请求 2501 与 1000.5
    // Then 两者都被拒绝，且错误信息给出新上限
    await expect(bridge.klines('cn', '600519', '1m', '2501')).rejects.toThrowError(/limit must be an integer in 1\.\.2500/)
    await expect(bridge.klines('cn', '600519', '1m', '1000.5')).rejects.toThrowError(/limit must be an integer in 1\.\.2500/)
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
      { symbol: 'BTCUSDT', name: 'BTC/USDT', form: 'spot' },
      { symbol: 'ETHUSDT', form: 'spot' },
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

  it('用户拉名册时每行带形态与资产类别（现货行按符号裁决、永续行透传元数据）', async () => {
    // Given 名册里现货行未标注形态、TradFi 永续行带交易所元数据
    const rows = [
      { symbol: 'BTCUSDT', name: 'BTC/USDT' },
      { symbol: 'TSLAUSDT-SWAP', name: 'TSLA/USDT', form: 'perp' as const, assetClass: 'equity' as const },
    ]
    const bridge = new TradingBridge(fakeHost({ tradingCryptoMarketData: fakeService({ listInstruments: async () => rows }) }))
    // When 用户拉全量名册与带 query 的名册
    const all = await bridge.symbols('crypto')
    const filtered = await bridge.symbols('crypto', 'tsla')
    // Then 现货行补 spot、永续行 form/assetClass 原样，两条路径形状一致
    expect(all.symbols).toEqual([
      { symbol: 'BTCUSDT', name: 'BTC/USDT', form: 'spot' },
      { symbol: 'TSLAUSDT-SWAP', name: 'TSLA/USDT', form: 'perp', assetClass: 'equity' },
    ])
    expect(filtered.symbols).toEqual([
      { symbol: 'TSLAUSDT-SWAP', name: 'TSLA/USDT', form: 'perp', assetClass: 'equity' },
    ])
  })
})

describe('TradingBridge.fundamentals（2026-09-02 基本面页签，整改后语义）', () => {
  // 整改（2026-09-02）：pkg 下钻不再要求连接器实现 getFundamentals（us/crypto 可达）；
  // 快照与 pkg 并行、各自失败只降级自己；双失败才 TRADING_NOT_IMPLEMENTED；
  // 5min TTL + in-flight 去重。kit 下钻在本测试环境走真实网络语义（无网则 catch 降级），
  // 快照路径断言不依赖 pkg 成败。
  it('快照可用（连接器实现 getFundamentals）→ 直接返回快照', async () => {
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

  it('连接器未实现 getFundamentals 且 pkg 下钻不可用 → TRADING_NOT_IMPLEMENTED（诚实空态）', async () => {
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

  it('TTL 缓存 + in-flight 去重：同键并发/连续调用只打一轮快照上游', async () => {
    let calls = 0
    const service = fakeService({
      getFundamentals: async (symbol: string) => {
        calls++
        return { symbol, peTtm: 20, timestamp: 1 }
      },
    })
    const bridge = new TradingBridge(fakeHost({ tradingCnMarketData: service }))
    const search = new URLSearchParams({ market: 'cn', symbol: '600519.SH' })
    const [a, b] = await Promise.all([
      dispatchBridgeRequest(bridge, 'GET', '/fundamentals', search),
      dispatchBridgeRequest(bridge, 'GET', '/fundamentals', search),
    ])
    await dispatchBridgeRequest(bridge, 'GET', '/fundamentals', search)
    expect(a.payload).toMatchObject({ ok: true })
    expect(b.payload).toMatchObject({ ok: true })
    expect(calls).toBe(1)
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

describe('TradingBridge.orderbook + trades（issue #39 盘口竖栏）', () => {
  it('/orderbook 透传；/trades 透传 limit', async () => {
    const service = fakeService({
      getOrderbook: async (symbol: string) => ({
        symbol, timestamp: 1234,
        bids: [{ price: 99, amount: 5 }, { price: 98, amount: 10 }],
        asks: [{ price: 100, amount: 8 }, { price: 101, amount: 2 }],
      }),
      getRecentTrades: async (symbol: string, limit?: number) => ([
        { id: '1', symbol, price: 99, amount: 1, side: 'sell' as const, timestamp: 100 },
        { id: '2', symbol, price: 100, amount: 2, side: 'buy' as const, timestamp: 1234, ...(limit !== undefined ? {} : {}) },
      ]),
    })
    const bridge = new TradingBridge(fakeHost({ tradingCryptoMarketData: service }))
    const { payload: book } = await dispatchBridgeRequest(bridge, 'GET', '/orderbook', new URLSearchParams({ market: 'crypto', symbol: 'BTCUSDT' }))
    expect(book).toMatchObject({ ok: true, orderbook: { symbol: 'BTCUSDT', bids: [{ price: 99, amount: 5 }, { price: 98, amount: 10 }] } })
    const { payload: trades } = await dispatchBridgeRequest(bridge, 'GET', '/trades', new URLSearchParams({ market: 'crypto', symbol: 'BTCUSDT', limit: '50' }))
    expect(trades).toMatchObject({ ok: true, trades: [{ id: '1' }, { id: '2' }] })
  })

  it('未实现 getOrderbook → TRADING_NOT_IMPLEMENTED；缺 symbol 400', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingUsMarketData: fakeService() }))
    await expect(dispatchBridgeRequest(bridge, 'GET', '/orderbook', new URLSearchParams({ market: 'us', symbol: 'AAPL' })))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(dispatchBridgeRequest(bridge, 'GET', '/trades', new URLSearchParams({ market: 'us', symbol: '' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
  })

  it('/trades 非法 limit → 400', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingCryptoMarketData: fakeService() }))
    await expect(dispatchBridgeRequest(bridge, 'GET', '/trades', new URLSearchParams({ market: 'crypto', symbol: 'BTCUSDT', limit: '0' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
  })
})

/**
 * GUI 实盘路径的审批座位替身：本组用例只关心参数透传与 dry-run 缺省，
 * 「审批没成就没有订单」的完整行为在 test/gui-approval.test.ts（真实
 * ApprovalService + 真实 Session + 真实 cordis ctx）。
 */
const approvingSeat: GuiApprovalSeat = { authorize: async () => {} }

describe('TradingBridge.trade/*（issue #40 交易台：只读 + 强制 dry-run）', () => {
  function tradeService(overrides: Partial<import('@dshtrading/api').TradeService> = {}): import('@dshtrading/api').TradeService {
    return {
      placeOrder: async (req) => ({
        id: 'dry-1', symbol: req.symbol, side: req.side, type: req.type,
        status: 'filled', quantity: req.quantity, dryRun: true, timestamp: 1,
      }),
      cancelOrder: async () => {},
      getOrder: async (_symbol, id) => ({
        id, symbol: _symbol, side: 'buy', type: 'limit', status: 'new', quantity: 1, dryRun: false, timestamp: 1,
      }),
      getPositions: async () => [{ symbol: 'BTCUSDT-SWAP', side: 'long', size: 0.02, entryPrice: 42000, unrealizedPnl: 1.5, timestamp: 1 }],
      ...overrides,
    }
  }

  function tradeHost(
    service: import('@dshtrading/api').TradeService | undefined,
    guiApproval?: GuiApprovalSeat,
  ): BridgeHost {
    return {
      getMarketService: market => market === 'crypto' ? fakeService() : undefined,
      activeProvider: () => 'okx',
      getTradeService: market => market === 'crypto' ? service : undefined,
      ...(guiApproval === undefined ? {} : { guiApproval }),
    }
  }

  it('/trade/positions、/trade/orders、/trade/fills、/trade/balances 只读透传', async () => {
    const service = tradeService({
      getBalances: async () => [{ asset: 'USDT', free: 100, locked: 0 }],
      listOpenOrders: async () => [],
      listTradeFills: async () => [{ id: 'f1', symbol: 'BTCUSDT-SWAP', side: 'buy', price: 42000, amount: 0.02, timestamp: 1 }],
    })
    const bridge = new TradingBridge(tradeHost(service))
    const { payload: positionWire } = await dispatchBridgeRequest(bridge, 'GET', '/trade/positions', new URLSearchParams({ market: 'crypto' }))
    expect(positionWire).toMatchObject({ ok: true, positions: [{ symbol: 'BTCUSDT-SWAP', side: 'long' }] })
    const { payload: balanceWire } = await dispatchBridgeRequest(bridge, 'GET', '/trade/balances', new URLSearchParams({ market: 'crypto' }))
    expect(balanceWire).toMatchObject({ ok: true, balances: [{ asset: 'USDT', free: 100 }] })
    const { payload: orderWire } = await dispatchBridgeRequest(bridge, 'GET', '/trade/orders', new URLSearchParams({ market: 'crypto' }))
    expect(orderWire).toMatchObject({ ok: true, orders: [] })
    const { payload: fillWire } = await dispatchBridgeRequest(bridge, 'GET', '/trade/fills', new URLSearchParams({ market: 'crypto' }))
    expect(fillWire).toMatchObject({ ok: true, fills: [{ id: 'f1' }] })
  })

  it('POST /trade/order：默认发起实盘报单（dryRun: false）；可显式指定', async () => {
    const placeOrder = vi.fn(async (req: { dryRun?: boolean }) => ({
      id: 'ord-live-1', symbol: req.symbol, side: req.side, type: req.type,
      status: 'filled' as const, quantity: req.quantity, dryRun: req.dryRun ?? false, timestamp: 1,
    }))
    const bridge = new TradingBridge(tradeHost(tradeService({ placeOrder: placeOrder as never }), approvingSeat))
    const { payload } = await dispatchBridgeRequest(
      bridge, 'POST', '/trade/order',
      new URLSearchParams({ market: 'crypto' }),
      {
        symbol: 'BTCUSDT-SWAP', side: 'buy', type: 'limit', quantity: 0.02, price: 42000,
        sessionId: 'session-gui-1', intentId: 'intent-gui-1',
      },
    )
    expect(payload).toMatchObject({ ok: true, order: { dryRun: false, symbol: 'BTCUSDT-SWAP' } })
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTCUSDT-SWAP', dryRun: false, price: 42000 }))
  })

  it('limit 单缺价格 → 400；数量非法 → 400；交易服务未注册 → 400', async () => {
    const bridge = new TradingBridge(tradeHost(tradeService()))
    await expect(dispatchBridgeRequest(
      bridge, 'POST', '/trade/order', new URLSearchParams({ market: 'crypto' }),
      { symbol: 'BTCUSDT-SWAP', side: 'buy', type: 'limit', quantity: 0.02 },
    )).rejects.toMatchObject({ status: 400 })
    await expect(dispatchBridgeRequest(
      bridge, 'POST', '/trade/order', new URLSearchParams({ market: 'crypto' }),
      { symbol: 'BTCUSDT-SWAP', side: 'buy', type: 'market', quantity: -1 },
    )).rejects.toMatchObject({ status: 400 })
    await expect(dispatchBridgeRequest(
      bridge, 'GET', '/trade/positions', new URLSearchParams({ market: 'us' }),
    )).rejects.toMatchObject({ status: 400 })
  })

  it('交易服务未注册 → 400 + code TRADING_NO_TRADE_SERVICE（2026-09-04：前端区分服务未挂与凭证缺失）', async () => {
    const bridge = new TradingBridge(tradeHost(undefined))
    await expect(dispatchBridgeRequest(
      bridge, 'GET', '/trade/positions', new URLSearchParams({ market: 'us' }),
    )).rejects.toMatchObject({ status: 400, code: 'TRADING_NO_TRADE_SERVICE' })
    await expect(dispatchBridgeRequest(
      bridge, 'GET', '/trade/balances', new URLSearchParams({ market: 'us' }),
    )).rejects.toMatchObject({ status: 400, code: 'TRADING_NO_TRADE_SERVICE' })
  })

  it('DELETE /trade/order：调用 cancelOrder 成功返回 { ok: true, canceled: true }', async () => {
    const cancelOrder = vi.fn(async (_id: string, _sym?: string) => {})
    const bridge = new TradingBridge(tradeHost(tradeService({ cancelOrder }), approvingSeat))
    const { status, payload } = await dispatchBridgeRequest(
      bridge, 'DELETE', '/trade/order',
      new URLSearchParams({
        market: 'crypto', id: 'ord-123', symbol: 'BTCUSDT',
        sessionId: 'session-gui-1', intentId: 'intent-gui-cancel-1',
      }),
    )
    expect(status).toBe(200)
    expect(payload).toEqual({ ok: true, canceled: true })
    expect(cancelOrder).toHaveBeenCalledWith('ord-123', 'BTCUSDT')
  })

  it('DELETE /trade/order：缺 market 或缺 id → 400', async () => {
    const bridge = new TradingBridge(tradeHost(tradeService()))
    await expect(dispatchBridgeRequest(
      bridge, 'DELETE', '/trade/order', new URLSearchParams({ market: 'crypto' }),
    )).rejects.toMatchObject({ status: 400 })
    await expect(dispatchBridgeRequest(
      bridge, 'DELETE', '/trade/order', new URLSearchParams({ id: 'ord-1' }),
    )).rejects.toMatchObject({ status: 400 })
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
    expect(payload).toEqual({ symbols: [{ symbol: 'BTCUSDT', form: 'spot' }] })
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

describe('TradingBridge.news（issue #37 新闻聚合；2026-09-02 评审 M3/M6 整改）', () => {
  function newsHost(aggregator: NewsAggregator): BridgeHost {
    return {
      getMarketService: () => undefined,
      activeProvider: () => undefined,
      newsRegistry: { register: () => () => {}, get: (market) => market === 'us' ? aggregator : undefined },
      newsKey: () => undefined,
    }
  }

  const item = (source: string, title: string, publishedAt: string) => ({ source, title, url: `https://x/${title}`, publishedAt })

  it('非法 limit → 400（非整数/越界/未知市场）', async () => {
    const bridge = new TradingBridge(newsHost(async () => ({ items: [], unavailable: [] })))
    await expect(bridge.news('us', 'AAPL', '0')).rejects.toThrowError(/limit/)
    await expect(bridge.news('us', 'AAPL', 'abc')).rejects.toThrowError(/limit/)
    await expect(bridge.news('us', 'AAPL', String(51))).rejects.toThrowError(/limit/)
    await expect(bridge.news('jp', 'AAPL', null)).rejects.toThrowError(/unknown market/)
  })

  it('有媒体快讯 → registry 聚合器结果透传', async () => {
    let calls = 0
    const aggregator: NewsAggregator = async () => {
      calls++
      return { items: [item('yahoo', 'Apple beats earnings', '2026-09-02T10:00:00Z')], unavailable: [] }
    }
    const bridge = new TradingBridge(newsHost(aggregator))
    const wire = await bridge.news('us', 'AAPL', '10')
    expect(calls).toBe(1)
    expect(wire.ok).toBe(true)
    expect(wire.items).toHaveLength(1)
    expect(wire.items[0]?.source).toBe('yahoo')
  })

  it('仅剩公告（sec-edgar）→ 原样保留公告，不回退大盘要闻（2026-09-03 owner 裁决）', async () => {
    let calls = 0
    const aggregator: NewsAggregator = async (options) => {
      calls++
      if (options?.symbol !== undefined) {
        return { items: [item('sec-edgar', '8-K filing', '2026-09-01T09:00:00Z')], unavailable: [] }
      }
      return {
        items: [
          item('yahoo', 'macro newest', '2026-09-02T12:00:00Z'),
          item('googlenews', 'macro mid', '2026-09-02T08:00:00Z'),
        ],
        unavailable: [],
      }
    }
    const bridge = new TradingBridge(newsHost(aggregator))
    const wire = await bridge.news('us', 'AAPL', '2')
    expect(calls).toBe(1)
    expect(wire.items.map(it => it.title)).toEqual(['8-K filing'])
  })

  it('无任何相关内容 → 空列表透传（前端展示空态，不兜底市场要闻）', async () => {
    let calls = 0
    const aggregator: NewsAggregator = async () => {
      calls++
      return { items: [], unavailable: [] }
    }
    const bridge = new TradingBridge(newsHost(aggregator))
    const wire = await bridge.news('us', 'AAPL', '10')
    expect(calls).toBe(1)
    expect(wire.items).toEqual([])
    expect(wire.unavailable).toEqual([])
  })

  it('公告源挂掉 → unavailable 注明，不与「暂无公告」混淆', async () => {
    const aggregator: NewsAggregator = async () => ({ items: [], unavailable: ['eastmoney-announcement: HTTP 503'] })
    const bridge = new TradingBridge(newsHost(aggregator))
    const wire = await bridge.news('us', 'AAPL', null)
    expect(wire.unavailable).toEqual(['eastmoney-announcement: HTTP 503'])
    expect(wire.items).toEqual([])
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


describe('TradingBridge.derivativesHistory（issue #54 衍生品页签趋势卡）', () => {
  it('/derivatives/history 透传注册表解析出服务的 getDerivativesHistory', async () => {
    const service = fakeService({
      getDerivativesHistory: async (symbol: string) => ({
        symbol: `${symbol}-SWAP`, source: 'okx',
        fundingRates: [{ time: 1000, value: 0.0001 }, { time: 2000, value: 0.0002 }],
        openInterest: [{ time: 1000, value: 795.3 }, { time: 2000, value: 801.5 }],
      }),
    })
    const bridge = new TradingBridge(fakeHost({ tradingCryptoMarketData: service }))
    const search = new URLSearchParams({ market: 'crypto', symbol: 'BTCUSDT' })
    const { status, payload } = await dispatchBridgeRequest(bridge, 'GET', '/derivatives/history', search)
    expect(status).toBe(200)
    expect(payload).toMatchObject({ ok: true, history: { symbol: 'BTCUSDT-SWAP', source: 'okx' } })
    const history = (payload as { history: { fundingRates: Array<{ time: number; value: number }> } }).history
    expect(history.fundingRates).toEqual([{ time: 1000, value: 0.0001 }, { time: 2000, value: 0.0002 }])
  })

  it('连接器未实现 getDerivativesHistory → TRADING_NOT_IMPLEMENTED（前端隐藏趋势卡）', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingCryptoMarketData: fakeService() }))
    const search = new URLSearchParams({ market: 'crypto', symbol: 'BTCUSDT' })
    await expect(dispatchBridgeRequest(bridge, 'GET', '/derivatives/history', search))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
  })

  it('未知市场 400；缺 symbol 400', async () => {
    const bridge = new TradingBridge(fakeHost({ tradingCryptoMarketData: fakeService() }))
    await expect(dispatchBridgeRequest(bridge, 'GET', '/derivatives/history', new URLSearchParams({ market: 'jp', symbol: 'X' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
    await expect(dispatchBridgeRequest(bridge, 'GET', '/derivatives/history', new URLSearchParams({ market: 'crypto' })))
      .rejects.toBeInstanceOf(BridgeProtocolError)
  })
})
