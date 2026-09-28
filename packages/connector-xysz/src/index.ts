/**
 * @dshtrading/connector-xysz
 * 银河星耀数智（AmazingData / tgw）A 股连接器插件。
 *
 * 数据面-only：提供 tradingCnMarketData 与 cn_* 行情工具。上游是本机/局域网里的
 * FastAPI 封装服务（xysz-api，包住 AmazingData Python SDK）——本插件不直连券商，
 * 也不提供任何交易/下单能力（星耀数智是行情与资讯数据服务）。
 *
 * 契约要点：
 *   - 符号：入参接受 A 股规范形与裸 6 位，输出一律规范形（docs/symbol-vocabulary.md）。
 *   - 周期：INTERVAL_VOCABULARY 内的规范 interval 直接映射上游 AmazingData Period。
 *   - 凭证：无（数据服务账号由 xysz-api 侧持有，本插件只认 XYSZ_API_URL / apiUrl）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type {
  Disposable,
  Interval,
  Kline,
  MarketDataService,
  Orderbook,
  StockFundamentals,
  Ticker,
} from '@dshtrading/api'
import {
  INTERVAL_VOCABULARY,
  XyszRestClient,
  type XyszRestOptions,
} from './rest.js'

export * from './rest.js'

/** 插件名 = preset 行 id（全仓唯一，insert-only 铁律 #1）。 */
export const name = 'dsh-trading-cn-connector-xysz'

export interface Config {
  /** 互斥激活总开关（默认 false）：false 时本插件不注册任何服务/工具。 */
  enabled: boolean
  /** 星耀数智 FastAPI 封装服务地址（局域网 192.168.31.50:8191 或本机 SSH 隧道 127.0.0.1:8191）。 */
  apiUrl?: string
  /** 单次上游请求超时（ms）。 */
  timeoutMs?: number
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(false).description('是否激活星耀数智连接器（同一市场同一时刻至多一个数据源激活）'),
  apiUrl: Schema.string().default('http://127.0.0.1:8191').description('星耀数智 AmazingData REST 封装服务地址'),
  timeoutMs: Schema.number().default(60000).description('上游请求超时（毫秒）'),
})

/** 需要宿主提供的 Cordis 服务。 */
export const inject = ['tools']

/** 行情服务键（@dshtrading/api 的 Context 增强：tradingCnMarketData）。 */
export const TRADING_CN_MARKET_DATA_KEY = 'tradingCnMarketData'

/** 路由 provider slug（开放词汇 = 数据源 slug）。 */
export const ROUTER_PROVIDER = 'xysz'

const SUBSCRIBE_MIN_MS = 1000
const SUBSCRIBE_DEFAULT_MS = 5000

export class XyszMarketDataService extends Service implements MarketDataService {
  // TS 编译期 private，禁 ECMAScript # 私有字段（cordis 跨 realm 代理按类身份校验会炸）。
  private readonly client: XyszRestClient

  constructor(
    ctx: Context,
    options: XyszRestOptions = {},
    serviceName: string = TRADING_CN_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new XyszRestClient(options)
  }

  async getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit)
  }

  async getOrderbook(symbol: string): Promise<Orderbook> {
    return this.client.getOrderbook(symbol)
  }

  async listInstruments(query?: string): Promise<Array<{ symbol: string; name?: string }>> {
    return this.client.listInstruments(query)
  }

  async getFundamentals(symbol: string): Promise<StockFundamentals> {
    return this.client.getFundamentals(symbol)
  }

  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void, options?: { intervalMs?: number }): Disposable {
    const ms = Math.max(options?.intervalMs ?? SUBSCRIBE_DEFAULT_MS, SUBSCRIBE_MIN_MS)
    const tick = (): void => {
      // 轮询失败静默跳过（下一 tick 重试）；不产生未处理 rejection。
      void this.getTicker(symbol).then(cb, () => {})
    }
    tick()
    const timer = setInterval(tick, ms)
    return { dispose: () => clearInterval(timer) }
  }
}

/** 路由闸门：选中的 provider 不是本连接器时让位（老部署无路由则放行）。 */
export function routeAllows(ctx: Context, config: Config, market: string = 'cn'): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'cn')) return

  // exactOptionalPropertyTypes：只透传已定义的可选字段（undefined 不进 options 对象）。
  const options: XyszRestOptions = {}
  if (config.apiUrl !== undefined) options.apiUrl = config.apiUrl
  if (config.timeoutMs !== undefined) options.timeoutMs = config.timeoutMs
  const marketData = new XyszMarketDataService(ctx, options)

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'cn_get_ticker',
      description:
        'Get the latest Level-1 quote for an A-share stock from 中国银河证券星耀数智 (AmazingData). '
        + 'Symbol accepts the canonical A-share form (600519.SH) or a bare 6-digit code (600519). '
        + 'Returns last price, previous close, change percent and bid/ask-1 from the authoritative exchange feed.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'A-share symbol, e.g. 600519.SH (or 600519)' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol))
      },
    }))

    register(defineTool({
      name: 'cn_get_klines',
      description:
        'Get historical K-lines for A-share stocks from 中国银河证券星耀数智 (AmazingData). '
        + 'Intervals: ' + INTERVAL_VOCABULARY.join('/') + ' (dsh-trading vocabulary; upstream serves the full A-share history since 2013). '
        + 'Returns up to limit most recent candles in ascending time order.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'A-share symbol, e.g. 600519.SH (or 600519)' },
        interval: { type: 'string', enum: [...INTERVAL_VOCABULARY], default: '1d', description: 'K-line interval' },
        limit: { type: 'integer', default: 100, description: 'Number of most recent candles (ascending)' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const klines = await marketData.getKlines(args.symbol, (args.interval ?? '1d') as Interval, args.limit ?? 100)
        return JSON.stringify(klines)
      },
    }))

    register(defineTool({
      name: 'cn_get_orderbook',
      description:
        'Get the 5-level order book (bid/ask prices and sizes) for an A-share stock from 中国银河证券星耀数智 (AmazingData). '
        + 'Derived from the latest exchange Level-1 snapshot row of the current trading day.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'A-share symbol, e.g. 600519.SH (or 600519)' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getOrderbook(args.symbol))
      },
    }))

    register(defineTool({
      name: 'cn_list_instruments',
      description:
        'List the A-share instrument universe (Shanghai/Shenzhen/Beijing, about 5500 symbols with Chinese short names) from '
        + '中国银河证券星耀数智 (AmazingData). Optional query filters by code or name substring.',
      parameters: {
        query: { type: 'string', description: 'Optional code or name filter, e.g. 茅台 or 6005' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.listInstruments(args.query))
      },
    }))

    register(defineTool({
      name: 'cn_get_fundamentals',
      description:
        'Get an A-share fundamental snapshot from 中国银河证券星耀数智 (AmazingData): company short name, listing board/date '
        + 'and the 52-week high/low derived from weekly K-lines.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'A-share symbol, e.g. 600519.SH (or 600519)' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getFundamentals(args.symbol))
      },
    }))
  })
}
