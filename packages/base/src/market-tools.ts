/**
 * @dshtrading/base/market-tools —— host 平面只读市场/账户工具（issue #86 / 审计 G1+G2）。
 *
 * 为什么在 base 而不是逐连接器接线（审计原文建议「工具工厂 + 各连接器接线」）：
 * - 两个契约方法族都是**可选方法**（api getOrderbook?/getRecentTrades?/listOpenOrders?/
 *   listTradeFills?/getBalances?），逐连接器接线会让同一能力在 30 个连接器里漂移
 *   （审计自己记录过 get_indicators 只在 binance/okx 注册的先例），且第三方连接器
 *   永远补不齐。这里改为 **registry 驱动**：工具名固定、实现由路由选中的连接器提供，
 *   零连接器改动即覆盖全部 provider（含第三方）。
 * - host 平面（全会话可见）而非 preset 平面：trader/master 预设挂连接器、专家角色
 *   预设挂 base/research-tools，两侧都需要这些只读工具。
 *
 * 语义纪律（审计 G1/G2 的核心风险）：
 * - **未实现 ≠ 无数据**：连接器没实现可选方法时抛 TRADING_NOT_IMPLEMENTED，
 *   绝不返回空数组冒充「无持仓 / 无挂单 / 空盘口」。
 * - **账户数据是券商/交易所真实状态**，与资产台账（holdings，导入型记账）无关；
 *   核对真实持仓必须用本族工具。
 * - 纯只读：不命中 ORDER_GATE_PATTERN（/^(?:crypto|us|cn|hk)_(?:place|cancel)_order$/），
 *   无交易语义，不进审批闸门（铁律 #3 不涉及）。
 *
 * @module @dshtrading/base/market-tools
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MarketDataService, TradeService } from '@dshtrading/api'

/** Cordis 插件名 = patch 行 id（TEMPLATES §8），市场无关共享行命名空间。 */
export const name = 'dsh-trading-market-tools'

/** 工具注册需要 tools 服务；两个注册表经 ctx.get 惰性解析（可能缺席的老部署）。 */
export const inject = ['tools']

export const MARKETS = ['crypto', 'us', 'cn', 'hk'] as const
export type MarketSlug = (typeof MARKETS)[number]

export interface Config {
  markets: MarketSlug[]
}

export const Config: Schema<Config> = Schema.object({
  markets: Schema.array(Schema.union([...MARKETS])).default([...MARKETS]),
})

/** 逐笔成交条数上限（与桥 MAX_TRADES_LIMIT 同口径）。 */
export const MAX_TRADES_LIMIT = 100

export interface MarketDataRegistryLike {
  active(market: string): { provider: string; service: MarketDataService } | undefined
}

export interface TradeRegistryLike {
  active(market: string): { provider: string; service: TradeService } | undefined
  /** 已注册的交易 provider（用于区分「未注册」与「未路由」，可选面）。 */
  list?(market: string): ReadonlyArray<{ provider: string }>
}

/** 未实现可选方法（与「无数据」严格区分）。 */
function notImplementedError(market: string, provider: string, method: string, label: string): Error {
  return new Error(
    `TRADING_NOT_IMPLEMENTED: ${market} provider "${provider}" does not implement ${method} (${label}). `
    + 'No data was returned — never report this as "none"/"empty"; tell the user this provider does not expose it.',
  )
}

function noMarketProviderError(market: string): Error {
  return new Error(
    `TRADING_NO_PROVIDER: no active market-data provider for market "${market}" — market keys are lowercase slugs `
    + '(crypto | us | cn | hk); if the key is right, check routing_get and installed connectors.',
  )
}

/**
 * 无可用交易服务：**区分「该市场没注册交易连接器」与「注册了但当前路由指不到」**
 * （2026-09-08 审查 P1：us 数据面 yahoo + 交易面 alpaca 时，旧文案会误报成「没装
 * 交易连接器」，把用户引向错误的排查方向）。
 */
function noTradeServiceError(market: string, registered: string[]): Error {
  if (registered.length === 0) {
    return new Error(
      `TRADING_NO_TRADE_SERVICE: no trade connector is registered for market "${market}" — the routed provider has no account/trading '
      + 'capability (routing_get shows the market-data provider; trade connectors register separately).`,
    )
  }
  return new Error(
    `TRADING_TRADE_PROVIDER_NOT_ROUTED: market "${market}" has trade connector(s) registered (${registered.join(', ')}), but the routed `
    + `provider exposes no trade service, so none is active. Set dshtrading.markets.${market}.tradeProvider to one of them to enable `
    + 'account reads. This is "not routed", NOT "not installed" — do not tell the user the connector is missing.',
  )
}

function parseSymbol(raw: unknown, tool: string): string {
  const symbol = typeof raw === 'string' ? raw.trim() : ''
  if (!symbol) throw new Error(`${tool}: symbol is required (market-canonical vocabulary, e.g. BTCUSDT / AAPL / 600519.SH / 00700.HK)`)
  return symbol
}

function parseLimit(raw: unknown, tool: string): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_TRADES_LIMIT) {
    throw new Error(`${tool}: limit must be an integer in 1..${MAX_TRADES_LIMIT}`)
  }
  return raw
}

/** 连接器可选的运行环境自述（鸭式；okx 的 demo/live 头等安全信号，缺席即省略）。 */
function environmentOf(service: TradeService): { env?: string; simulated?: boolean } | undefined {
  const probe = (service as unknown as { environment?: unknown }).environment
  if (typeof probe !== 'function') return undefined
  try {
    const value = (probe as () => unknown).call(service)
    if (value === null || typeof value !== 'object') return undefined
    const record = value as { env?: unknown; simulated?: unknown }
    return {
      ...(typeof record.env === 'string' ? { env: record.env } : {}),
      ...(typeof record.simulated === 'boolean' ? { simulated: record.simulated } : {}),
    }
  } catch {
    return undefined
  }
}

const textOutput = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * 市场面只读工具（G2）：盘口快照与最近逐笔。
 * 数据源 = 路由选中的行情服务；未实现可选方法 → TRADING_NOT_IMPLEMENTED。
 */
export function createMarketReadTools(market: string, getRegistry: () => MarketDataRegistryLike | undefined) {
  const active = () => {
    const entry = getRegistry()?.active(market)
    if (entry === undefined) throw noMarketProviderError(market)
    return entry
  }
  const symbolParam = {
    type: 'string' as const,
    required: true as const,
    description: 'Market-canonical symbol, e.g. BTCUSDT / AAPL / 600519.SH / 00700.HK',
  }
  return [
    defineTool({
      name: `${market}_get_orderbook`,
      description:
        `Read-only ${market} orderbook snapshot (bids/asks) from the currently routed market-data provider. `
        + 'This is a snapshot, not a live stream. If the provider does not implement orderbook the call fails with '
        + 'TRADING_NOT_IMPLEMENTED — that is "not available", NOT an empty book; never report it as no liquidity.',
      parameters: { symbol: symbolParam },
      output: textOutput,
      async execute(raw) {
        const entry = active()
        const symbol = parseSymbol(((raw ?? {}) as Record<string, unknown>).symbol, `${market}_get_orderbook`)
        const getOrderbook = entry.service.getOrderbook
        if (typeof getOrderbook !== 'function') {
          throw notImplementedError(market, entry.provider, 'getOrderbook', 'orderbook snapshot')
        }
        const orderbook = await getOrderbook.call(entry.service, symbol)
        return JSON.stringify({ ok: true, market, provider: entry.provider, symbol, orderbook })
      },
    }),
    defineTool({
      name: `${market}_get_trades`,
      description:
        `Read-only ${market} recent tick-by-tick trades from the currently routed market-data provider, oldest first. `
        + `limit defaults to the provider value and is capped at ${MAX_TRADES_LIMIT}. If the provider does not implement recent trades `
        + 'the call fails with TRADING_NOT_IMPLEMENTED — that is "not available", NOT an empty tape.',
      parameters: {
        symbol: symbolParam,
        limit: {
          type: 'number' as const,
          description: `Number of most recent trades to return (integer 1..${MAX_TRADES_LIMIT}; default provider value)`,
        },
      },
      output: textOutput,
      async execute(raw) {
        const entry = active()
        const args = (raw ?? {}) as Record<string, unknown>
        const symbol = parseSymbol(args.symbol, `${market}_get_trades`)
        const limit = parseLimit(args.limit, `${market}_get_trades`)
        const getRecentTrades = entry.service.getRecentTrades
        if (typeof getRecentTrades !== 'function') {
          throw notImplementedError(market, entry.provider, 'getRecentTrades', 'recent trades')
        }
        const trades = await getRecentTrades.call(entry.service, symbol, limit)
        return JSON.stringify({ ok: true, market, provider: entry.provider, symbol, trades })
      },
    }),
  ]
}

/**
 * 账户面只读工具（G1）：持仓 / 挂单 / 成交 / 余额 / 单笔查单。
 * 数据源 = 路由选中的交易连接器（tradingTradeRegistry）；账户真实状态，与台账无关。
 */
export function createAccountTools(market: string, getRegistry: () => TradeRegistryLike | undefined) {
  const active = () => {
    const registry = getRegistry()
    const entry = registry?.active(market)
    if (entry === undefined) {
      throw noTradeServiceError(market, (registry?.list?.(market) ?? []).map(item => item.provider))
    }
    return entry
  }
  const symbolParam = {
    type: 'string' as const,
    required: true as const,
    description: 'Market-canonical symbol, e.g. BTCUSDT / AAPL / 600519.SH / 00700.HK',
  }
  const optionalSymbolParam = {
    type: 'string' as const,
    description: 'Optional market-canonical symbol filter; omit for the whole account',
  }
  const accountNote =
    'This reads the broker/exchange account truth (live), not the local holdings ledger — reconcile the ledger with this result.'
  return [
    defineTool({
      name: `${market}_get_positions`,
      description:
        `Read-only ${market} account positions from the currently routed trade connector. ${accountNote} `
        + 'If the connector does not expose positions the call fails with TRADING_NOT_IMPLEMENTED — that is "not available", '
        + 'NOT a flat account; never report it as no positions.',
      parameters: {},
      output: textOutput,
      async execute() {
        const entry = active()
        const getPositions = entry.service.getPositions
        if (typeof getPositions !== 'function') {
          throw notImplementedError(market, entry.provider, 'getPositions', 'account positions')
        }
        const positions = await getPositions.call(entry.service)
        const environment = environmentOf(entry.service)
        return JSON.stringify({ ok: true, market, provider: entry.provider, ...(environment !== undefined ? { environment } : {}), positions })
      },
    }),
    defineTool({
      name: `${market}_get_orders`,
      description:
        `Read-only ${market} open orders from the currently routed trade connector. ${accountNote} `
        + 'If the connector does not expose open orders the call fails with TRADING_NOT_IMPLEMENTED — that is "not available", '
        + 'NOT "no open orders".',
      parameters: { symbol: optionalSymbolParam },
      output: textOutput,
      async execute(raw) {
        const entry = active()
        const symbol = typeof ((raw ?? {}) as Record<string, unknown>).symbol === 'string'
          ? (((raw ?? {}) as Record<string, unknown>).symbol as string).trim() || undefined
          : undefined
        const listOpenOrders = entry.service.listOpenOrders
        if (typeof listOpenOrders !== 'function') {
          throw notImplementedError(market, entry.provider, 'listOpenOrders', 'open orders')
        }
        const orders = await listOpenOrders.call(entry.service, symbol)
        const environment = environmentOf(entry.service)
        return JSON.stringify({
          ok: true, market, provider: entry.provider,
          ...(environment !== undefined ? { environment } : {}),
          ...(symbol !== undefined ? { symbol } : {}),
          orders,
        })
      },
    }),
    defineTool({
      name: `${market}_get_fills`,
      description:
        `Read-only ${market} recent trade fills from the currently routed trade connector, oldest first. ${accountNote} `
        + `limit is capped at ${MAX_TRADES_LIMIT}. If the connector does not expose fills the call fails with TRADING_NOT_IMPLEMENTED — `
        + 'that is "not available", NOT "no fills today".',
      parameters: {
        symbol: optionalSymbolParam,
        limit: {
          type: 'number' as const,
          description: `Number of most recent fills to return (integer 1..${MAX_TRADES_LIMIT}; default provider value)`,
        },
      },
      output: textOutput,
      async execute(raw) {
        const entry = active()
        const args = (raw ?? {}) as Record<string, unknown>
        const symbol = typeof args.symbol === 'string' && args.symbol.trim() ? args.symbol.trim() : undefined
        const limit = parseLimit(args.limit, `${market}_get_fills`)
        const listTradeFills = entry.service.listTradeFills
        if (typeof listTradeFills !== 'function') {
          throw notImplementedError(market, entry.provider, 'listTradeFills', 'trade fills')
        }
        const fills = await listTradeFills.call(entry.service, symbol, limit)
        const environment = environmentOf(entry.service)
        return JSON.stringify({
          ok: true, market, provider: entry.provider,
          ...(environment !== undefined ? { environment } : {}),
          ...(symbol !== undefined ? { symbol } : {}),
          fills,
        })
      },
    }),
    defineTool({
      name: `${market}_get_balance`,
      description:
        `Read-only ${market} account balances from the currently routed trade connector. ${accountNote} `
        + 'If the connector does not expose balances the call fails with TRADING_NOT_IMPLEMENTED — that is "not available", '
        + 'NOT a zero balance.',
      parameters: {},
      output: textOutput,
      async execute() {
        const entry = active()
        const getBalances = entry.service.getBalances
        if (typeof getBalances !== 'function') {
          throw notImplementedError(market, entry.provider, 'getBalances', 'account balances')
        }
        const balances = await getBalances.call(entry.service)
        const environment = environmentOf(entry.service)
        return JSON.stringify({ ok: true, market, provider: entry.provider, ...(environment !== undefined ? { environment } : {}), balances })
      },
    }),
    defineTool({
      name: `${market}_get_order`,
      description:
        `Read-only ${market} single-order lookup by (symbol, orderId) from the currently routed trade connector. ${accountNote} `
        + 'Get orderId from ' + `${market}_get_orders` + ' or ' + `${market}_get_fills` + ' first; an unknown id is reported by the connector as an error, '
        + 'never as an empty order.',
      parameters: {
        symbol: symbolParam,
        orderId: {
          type: 'string' as const,
          required: true as const,
          description: 'Order id from a previous orders/fills query or the user',
        },
      },
      output: textOutput,
      async execute(raw) {
        const entry = active()
        const args = (raw ?? {}) as Record<string, unknown>
        const symbol = parseSymbol(args.symbol, `${market}_get_order`)
        const orderId = typeof args.orderId === 'string' ? args.orderId.trim() : ''
        if (!orderId) throw new Error(`${market}_get_order: orderId is required`)
        const getOrder = entry.service.getOrder
        if (typeof getOrder !== 'function') {
          throw notImplementedError(market, entry.provider, 'getOrder', 'single order lookup')
        }
        const order = await getOrder.call(entry.service, symbol, orderId)
        const environment = environmentOf(entry.service)
        return JSON.stringify({
          ok: true, market, provider: entry.provider,
          ...(environment !== undefined ? { environment } : {}),
          symbol, orderId, order,
        })
      },
    }),
  ]
}

/** 全市场工具集合（market 展开；新市场 = 配置加键，schema 零改）。 */
export function createMarketTools(
  markets: readonly string[],
  getMarketRegistry: () => MarketDataRegistryLike | undefined,
  getTradeRegistry: () => TradeRegistryLike | undefined,
) {
  const tools: Array<ReturnType<typeof defineTool>> = []
  for (const market of markets) {
    tools.push(...createMarketReadTools(market, getMarketRegistry))
    tools.push(...createAccountTools(market, getTradeRegistry))
  }
  return tools
}

/**
 * 插件入口：注册全部只读市场/账户工具。
 * 同名工具先到先得（连接器已注册的同名工具优先，例如 okx 的 crypto_get_positions），
 * 绝不重复注册（dsh-tools 对同名重复注册直接抛错）。
 */
export function apply(ctx: Context, config: Config): void {
  const markets = [...new Set(config?.markets ?? [...MARKETS])]
  const getMarketRegistry = () => (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown })
    .get?.('tradingMarketDataRegistry', false) as MarketDataRegistryLike | undefined
  const getTradeRegistry = () => (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown })
    .get?.('tradingTradeRegistry', false) as TradeRegistryLike | undefined
  for (const tool of createMarketTools(markets, getMarketRegistry, getTradeRegistry)) {
    const tools = ctx.tools as unknown as { register(definition: unknown): void; get(name: string): unknown }
    if (tools.get(tool.name) === undefined) tools.register(tool)
  }
}
