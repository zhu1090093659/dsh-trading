/**
 * 行情 HTTP 桥的纯逻辑层：请求解析 → 市场服务分发 → 统一 JSON 形状。
 *
 * 设计约束：
 * - 铁律 #5（数据合规）：本桥是无状态透传，不做任何缓存/落盘；频率由客户端轮询
 *   节奏控制，symbols 数量服务端封顶（MAX_SYMBOLS）。
 * - 服务解析 registry-first（2026-08-30 注册表模式，架构评审整改 #1）：每请求经
 *   tradingMarketDataRegistry 按路由当前值惰性解析——settings 切换交易所即刻生效
 *   （GUI 热切换，无 watch 无重启）；注册表缺席或无对应注册项时回退旧的市场键
 *   直读（老部署/连接器未升级）。preset 平面不经本桥（会话隔离）。
 * - 业务错误一律 HTTP 200 + { ok:false, code, message }（错误词汇沿用
 *   TradingErrorCode 惯例）；仅协议层错误用 4xx。
 */
import type { Interval, Kline, MarketDataService, Ticker } from '@dsh-trading/api'

/** 本桥支持的市场（与连接器服务键一一对应）。 */
export type MarketId = 'crypto' | 'us' | 'cn' | 'hk'

export const MARKET_IDS: readonly MarketId[] = ['crypto', 'us', 'cn', 'hk']

/** market → Context 服务键（@dsh-trading/api 的 Context 增强）。 */
export const MARKET_SERVICE_KEYS: Record<MarketId, string> = {
  crypto: 'tradingCryptoMarketData',
  us: 'tradingUsMarketData',
  cn: 'tradingCnMarketData',
  hk: 'tradingHkMarketData',
}

/** 注册表服务的最小形状（鸭式，与 @dsh-trading/router 的 MarketDataRegistryLike 同构）。 */
export interface MarketDataRegistryLike {
  active(market: string): { provider: string; service: MarketDataService } | undefined
}

/**
 * 桥宿主工厂（registry-first 解析的唯一实现，node 半与单测共用）：
 * - getMarketService：注册表有激活注册项 → 用之；否则回退 legacy 市场键直读
 *   （2026-08-30 前形态：连接器老 dataplane 互斥 provide 市场键的部署）。
 * - activeProvider：优先报告实际供数的注册项 provider；注册表未裁决时回退 router 值
 *   （选中但未注册 → 用户能在 GUI 看到设置目标，行情区报「未安装/未激活」）。
 */
export function createBridgeHost(services: {
  registry?: MarketDataRegistryLike
  router?: { activeProvider(market: string): string | undefined }
  legacy(market: MarketId): MarketDataService | undefined
}): BridgeHost {
  return {
    getMarketService: market => {
      const active = services.registry?.active(market)
      if (active !== undefined) return active.service
      return services.legacy(market)
    },
    activeProvider: market => services.registry?.active(market)?.provider ?? services.router?.activeProvider(market),
  }
}

/** 单次批量报价的 symbols 封顶（保护公共端点，超出部分直接拒绝）。 */
export const MAX_SYMBOLS = 32

/** 单次 K 线 limit 封顶。 */
export const MAX_KLINE_LIMIT = 500

/** 宿主面：桥对 cordis ctx 的最小依赖（便于单测注入假件）。 */
export interface BridgeHost {
  /** 取市场行情服务；未安装/未激活返回 undefined。 */
  getMarketService(market: MarketId): MarketDataService | undefined
  /** 该市场当前激活的 provider slug（router 设置；可能 undefined）。 */
  activeProvider(market: MarketId): string | undefined
}

export interface MarketInfoWire {
  id: MarketId
  provider?: string
}

export type TickerOutcome =
  | { ok: true; ticker: Ticker }
  | { ok: false; code: string; message: string }

export interface MarketsWire {
  markets: MarketInfoWire[]
}

export interface TickersWire {
  tickers: Record<string, TickerOutcome>
}

export interface KlinesWire {
  klines: Kline[]
}

export class BridgeProtocolError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function isMarketId(value: string): value is MarketId {
  return (MARKET_IDS as readonly string[]).includes(value)
}

/** 从 Error 上提取结构化错误词汇（连接器按 TradingError 形状附加 code）。 */
export function errorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code = typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'TRADING_UNKNOWN'
    return { code, message: error.message }
  }
  return { code: 'TRADING_UNKNOWN', message: String(error) }
}

export class TradingBridge {
  constructor(private readonly host: BridgeHost) {}

  /** 已安装（有行情服务）的市场清单 + 当前 provider slug。 */
  markets(): MarketsWire {
    const markets: MarketInfoWire[] = []
    for (const id of MARKET_IDS) {
      if (this.host.getMarketService(id) === undefined) continue
      const provider = this.host.activeProvider(id)
      markets.push(provider === undefined ? { id } : { id, provider })
    }
    return { markets }
  }

  /** 批量报价：逐 symbol 独立成功/失败（一个坏代码不拖垮整批）。 */
  async tickers(market: string, symbols: string[]): Promise<TickersWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const unique = [...new Set(symbols.map(symbol => symbol.trim()).filter(Boolean))]
    if (unique.length === 0) throw new BridgeProtocolError(400, 'tickers: symbols is required')
    if (unique.length > MAX_SYMBOLS) {
      throw new BridgeProtocolError(400, `tickers: too many symbols (${unique.length} > ${MAX_SYMBOLS})`)
    }
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    const outcomes = await Promise.all(unique.map(async (symbol): Promise<TickerOutcome> => {
      try {
        return { ok: true, ticker: await service.getTicker(symbol) }
      } catch (error) {
        return { ok: false, ...errorPayload(error) }
      }
    }))
    const tickers: Record<string, TickerOutcome> = {}
    unique.forEach((symbol, index) => { tickers[symbol] = outcomes[index] as TickerOutcome })
    return { tickers }
  }

  /** K 线：透传 interval（连接器自行校验各自支持集）。 */
  async klines(market: string, symbol: string, interval: string, rawLimit: string | null): Promise<KlinesWire> {
    if (!isMarketId(market)) throw new BridgeProtocolError(400, `unknown market ${JSON.stringify(market)}`)
    const trimmed = symbol.trim()
    if (trimmed === '') throw new BridgeProtocolError(400, 'klines: symbol is required')
    const limit = rawLimit === null || rawLimit === undefined ? undefined : Number(rawLimit)
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_KLINE_LIMIT)) {
      throw new BridgeProtocolError(400, `klines: limit must be an integer in 1..${MAX_KLINE_LIMIT}`)
    }
    const service = this.host.getMarketService(market)
    if (service === undefined) throw new BridgeProtocolError(400, `market ${market} is not installed`)
    const klines = await service.getKlines(trimmed, interval as Interval, limit)
    return { klines }
  }
}

/** 请求分发：把 (method, pathname, searchParams) 路由到桥方法，返回 (status, payload)。 */
export async function dispatchBridgeRequest(
  bridge: TradingBridge,
  method: string,
  pathname: string,
  search: URLSearchParams,
): Promise<{ status: number; payload: unknown }> {
  if (method !== 'GET') throw new BridgeProtocolError(405, 'only GET is supported')
  switch (pathname) {
    case '/markets':
      return { status: 200, payload: bridge.markets() }
    case '/tickers': {
      const market = search.get('market') ?? ''
      const symbols = (search.get('symbols') ?? '').split(',')
      return { status: 200, payload: await bridge.tickers(market, symbols) }
    }
    case '/klines': {
      const market = search.get('market') ?? ''
      const symbol = search.get('symbol') ?? ''
      const interval = search.get('interval') ?? '1d'
      const limit = search.get('limit')
      return { status: 200, payload: await bridge.klines(market, symbol, interval, limit) }
    }
    default:
      throw new BridgeProtocolError(404, `no such endpoint: ${pathname}`)
  }
}
