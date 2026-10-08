import { describe, expect, it, vi } from 'vitest'
import {
  derivativesFailure,
  fetchCryptoDerivatives,
  renderDerivativesData,
  normalizeBinanceFuturesSymbol,
  extractBaseAsset,
} from '../src/derivatives.ts'
import { createGetDerivativesTool } from '../src/index.ts'

describe('crypto_get_derivatives', () => {
  it('normalizes symbols correctly', () => {
    expect(normalizeBinanceFuturesSymbol('BTCUSDT')).toBe('BTCUSDT')
    expect(normalizeBinanceFuturesSymbol('btcusdt')).toBe('BTCUSDT')
    expect(normalizeBinanceFuturesSymbol('BTCUSDT-SWAP')).toBe('BTCUSDT')
    expect(normalizeBinanceFuturesSymbol('BTC-USDT-SWAP')).toBe('BTCUSDT')
    expect(extractBaseAsset('BTCUSDT')).toBe('BTC')
    expect(extractBaseAsset('ETHUSDT-SWAP')).toBe('ETH')
    expect(extractBaseAsset('SOLUSDC')).toBe('SOL')
  })

  it('fetches and aggregates derivatives indicators from mock responses', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/fapi/v1/openInterest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ openInterest: '72540.123', symbol: 'BTCUSDT', time: 1772390400000 }),
        } as Response
      }
      if (url.includes('/futures/data/globalLongShortAccountRatio')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ longShortRatio: '1.85', longAccount: '0.65', shortAccount: '0.35', timestamp: 1772390400000 }],
        } as Response
      }
      if (url.includes('/futures/data/topLongShortPositionRatio')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ longShortRatio: '1.42', longPosition: '0.587', shortPosition: '0.413', timestamp: 1772390400000 }],
        } as Response
      }
      if (url.includes('/futures/data/takerlongshortRatio')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ buySellRatio: '1.15', buyVol: '1500.5', sellVol: '1304.7', timestamp: 1772390400000 }],
        } as Response
      }
      if (url.includes('/fapi/v1/fundingRate')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ symbol: 'BTCUSDT', fundingRate: '0.00010000', fundingTime: 1772390400000 }],
        } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    const result = await fetchCryptoDerivatives({ symbol: 'BTCUSDT-SWAP', fetch: mockFetch as unknown as typeof globalThis.fetch })
    expect(result.data).toBeDefined()
    expect(result.data?.symbol).toBe('BTCUSDT-SWAP')
    expect(result.data?.openInterest).toBe(72540.123)
    expect(result.data?.longShortRatio).toBe(1.85)
    expect(result.data?.topTraderLongShortRatio).toBe(1.42)
    expect(result.data?.takerBuySellRatio).toBe(1.15)
    expect(result.data?.fundingRate).toBe(0.0001)

    const rendered = renderDerivativesData(result, 'BTCUSDT-SWAP')
    expect(rendered).toContain('Open Interest (OI): 72,540.123')
    expect(rendered).toContain('Global Long/Short Account Ratio: 1.85')
    expect(rendered).toContain('Top Trader Position L/S Ratio: 1.42')
    expect(rendered).toContain('Taker Buy/Sell Volume Ratio: 1.15')
    expect(rendered).toContain('Latest Funding Rate: 0.0001 (0.0100%)')
  })

  it('tolerates partial failures and reports unavailable sub-queries', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/fapi/v1/openInterest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ openInterest: '50000', symbol: 'BTCUSDT', time: 1772390400000 }),
        } as Response
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response
    })

    const tool = createGetDerivativesTool({ fetch: mockFetch as unknown as typeof globalThis.fetch })
    const output = await tool.execute({ symbol: 'BTCUSDT' })
    expect(output).toContain('Open Interest (OI): 50,000')
    expect(output).toContain('partially unavailable sub-queries')
  })
})

/* ── registry-first（P6，2026-10-08）：数据源跟随路由，不再硬编码 Binance ───────── */

interface RoutedEntry {
  provider: string
  service: Record<string, unknown>
}

interface ToolLike {
  execute(raw: unknown): Promise<unknown>
}

/** 最小注册表替身（与 MarketDataRegistryService.active 同形）。 */
function registryWith(entry: RoutedEntry | undefined) {
  return { active: (market: string) => (market === 'crypto' ? entry : undefined) }
}

/** 直接以注入的注册表/fetch 构造工具（绕过 apply，测 execute 语义）。 */
function routedTool(options: { registry?: unknown; fetch?: typeof globalThis.fetch } = {}): ToolLike {
  return createGetDerivativesTool({
    getRegistry: () => options.registry as never,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }) as unknown as ToolLike
}

/** 契约化 fake fetch：普通函数 + 数组记录请求 URL（非通用 mock 工具）。 */
function recordingFetch(respond: (url: string) => Response): { fetchImpl: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    return respond(url)
  }) as unknown as typeof globalThis.fetch
  return { fetchImpl, urls }
}

const OKX_READING = {
  symbol: 'BTCUSDT-SWAP',
  source: 'okx',
  openInterest: 800.5,
  fundingRate: 0.0001,
  nextFundingRate: 0.0002,
  nextFundingTime: 1_700_000_200_000,
  markPrice: 42_001.5,
  indexPrice: 42_000.25,
  timestamp: 1_700_000_001_000,
}

describe('crypto_get_derivatives registry-first（P6）', () => {
  it('用户：provider=okx 时取数走路由的 OKX 服务，Binance 直连端点零命中', async () => {
    // Given: 注册表选中 provider=okx，其 getDerivatives 返回 OKX 规范形读数
    const calls: Array<{ symbol: string }> = []
    const registry = registryWith({
      provider: 'okx',
      service: {
        getDerivatives: async (symbol: string) => {
          calls.push({ symbol })
          return OKX_READING
        },
      },
    })
    const legacy = recordingFetch(() => {
      throw new Error('legacy direct endpoint must not be reached when a provider is routed')
    })
    // When: 调用工具
    const output = (await routedTool({ registry, fetch: legacy.fetchImpl }).execute({ symbol: 'BTCUSDT-SWAP' })) as string
    // Then: 读数来自 OKX（provider/source 回显），请求原样透传，直连端点没有发出任何请求
    expect(output).toContain('crypto_get_derivatives BTCUSDT-SWAP (provider: okx, source: okx,')
    expect(output).toContain('Open Interest (OI): 800.5')
    expect(calls).toEqual([{ symbol: 'BTCUSDT-SWAP' }])
    expect(legacy.urls).toEqual([])
  })

  it('用户：provider 读数里的下期资金费率、标记价与指数价一并回显', async () => {
    // Given: 路由到 OKX，读数含快照之外的扩展字段
    const registry = registryWith({ provider: 'okx', service: { getDerivatives: async () => OKX_READING } })
    // When: 调用工具
    const output = (await routedTool({ registry }).execute({ symbol: 'BTCUSDT-SWAP' })) as string
    // Then: 扩展字段逐项可见（下期费率同时给小数与百分比）
    expect(output).toContain('- Next Funding Rate: 0.0002 (0.0200%)')
    expect(output).toContain('- Next Funding Time: 2023-11-14T22:16:40.000Z')
    expect(output).toContain('- Mark Price: 42001.5')
    expect(output).toContain('- Index Price: 42000.25')
  })

  it('用户：路由到的 provider 未实现 getDerivatives 时报 TRADING_NOT_IMPLEMENTED，不回退 Binance 冒充路由源', async () => {
    // Given: provider=ccxt 只有行情能力，没有衍生品快照
    const legacy = recordingFetch(() => ({ ok: false, status: 404 }) as Response)
    const tool = routedTool({ registry: registryWith({ provider: 'ccxt', service: { getTicker: async () => ({}) } }), fetch: legacy.fetchImpl })
    // When / Then: 结构化失败，且直连端点未被触碰（不静默换源）
    await expect(tool.execute({ symbol: 'BTCUSDT-SWAP' })).rejects.toThrow('TRADING_NOT_IMPLEMENTED')
    expect(legacy.urls).toEqual([])
  })

  it('管理员：provider 取数失败按既有 fail-soft 契约输出报错文本（含 provider 与错误码），不抛裸异常', async () => {
    // Given: OKX 服务聚合全失败（连接器抛结构化错误）
    const failure = Object.assign(new Error('derivatives for BTC-USDT-SWAP: all sub-queries failed'), { code: 'TRADING_EXCHANGE_ERROR' })
    const registry = registryWith({
      provider: 'okx',
      service: {
        getDerivatives: async () => {
          throw failure
        },
      },
    })
    // When: 调用工具
    const output = (await routedTool({ registry }).execute({ symbol: 'BTCUSDT-SWAP' })) as string
    // Then: 无读数但报错可溯源（provider + 错误码 + 原文）
    expect(output).toContain('crypto_get_derivatives BTCUSDT-SWAP: no derivative data available.')
    expect(output).toContain('okx-getDerivatives: TRADING_EXCHANGE_ERROR: derivatives for BTC-USDT-SWAP: all sub-queries failed')
  })

  it('管理员：derivativesFailure 对带错误码、无错误码与非 Error 载荷都给出可读来源', () => {
    // Given: 连接器抛出的结构化错误、普通 Error、以及非 Error 载荷
    const coded = Object.assign(new Error('all sub-queries failed'), { code: 'TRADING_EXCHANGE_ERROR' })
    // When: 逐个转成降级结果
    const fromCoded = derivativesFailure('okx', coded)
    const fromPlain = derivativesFailure('okx', new Error('socket hang up'))
    const fromPayload = derivativesFailure('okx', 'string failure')
    // Then: 三种都能读出 provider 与原始原因，且不出现 undefined
    expect(fromCoded.unavailable).toEqual(['okx-getDerivatives: TRADING_EXCHANGE_ERROR: all sub-queries failed'])
    expect(fromPlain.unavailable).toEqual(['okx-getDerivatives: socket hang up'])
    expect(fromPayload.unavailable).toEqual(['okx-getDerivatives: string failure'])
  })

  it('用户：provider 返回非法载荷（缺 symbol）时报错，不伪造读数', async () => {
    // Given: provider 返回形状不合契约的载荷
    const registry = registryWith({ provider: 'okx', service: { getDerivatives: async () => ({ source: 'okx' }) } })
    // When / Then: 拒绝并说明是 provider 载荷问题
    await expect(routedTool({ registry }).execute({ symbol: 'BTCUSDT-SWAP' })).rejects.toThrow('invalid derivatives payload')
  })

  it('管理员：注册表服务缺席（老部署）时保持既有直连 Binance 行为与渲染格式', async () => {
    // Given: 无注册表服务，直连端点返回实时 OI
    const legacy = recordingFetch((url) =>
      url.includes('/fapi/v1/openInterest')
        ? ({ ok: true, status: 200, json: async () => ({ openInterest: '1000.5', time: 1_700_000_000_000 }) } as Response)
        : ({ ok: false, status: 404 } as Response),
    )
    // When: 调用工具（无 registry）
    const output = (await routedTool({ fetch: legacy.fetchImpl }).execute({ symbol: 'BTCUSDT' })) as string
    // Then: 打到 fapi 直连，输出沿用既有格式且不回显 provider
    expect(legacy.urls[0]).toContain('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT')
    expect(output).toContain('crypto_get_derivatives BTCUSDT-SWAP (source: binance-futures-public,')
    expect(output).toContain('Open Interest (OI): 1,000.5')
  })
})

