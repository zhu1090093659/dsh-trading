/**
 * Futu (富途 OpenD) REST 客户端 —— 港股 (hk) + 美股 (us) 行情数据面，交易面仅港股。
 *
 * 通过本地或远程 FutuOpenD 网关进行交互（默认 http://127.0.0.1:11111，生产经
 * scripts/futu-openapi-bridge.py 的 HTTP 桥 11112）。
 *
 * @module @dshtrading/connector-futu/rest
 */

import type {
  AccountBalance,
  Interval,
  Kline,
  Order,
  Position,
  Ticker,
  TradingErrorCode,
} from '@dshtrading/api'

export class TradingServiceError extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'TradingServiceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/** 本连接器服务的市场（行情面双市场；交易面仅 hk）。 */
export type FutuMarket = 'hk' | 'us'

/** OpenD 的交易环境。**没有"默认实盘"**：缺省一律 SIMULATE。 */
export type FutuTrdEnv = 'SIMULATE' | 'REAL'

export interface FutuRestOptions {
  gatewayUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 实例市场（决定 listInstruments 的标的来源；缺省 hk）。 */
  market?: FutuMarket
  /** 交易面环境（缺省 `SIMULATE`）。 */
  trdEnv?: FutuTrdEnv
  /** OpenD 账户 id（accId）。0 / 缺省 = 不发这一格，由 OpenD 用它的默认账户。 */
  accId?: number
}

export interface FutuCredentials {
  readonly unlockPwd?: string
  /** 本次调用的交易环境（缺省用构造时的值，再缺省 SIMULATE）。 */
  readonly trdEnv?: FutuTrdEnv
  /** 本次调用用的账户 id（缺省用构造时的值）。 */
  readonly accId?: number
}

/**
 * 挂单快照里的一行（`POST /api/trd/get-orders`）。
 *
 * 前四个字段是**执行核的启动对账**要的：它按 `remark`（= `clientOrderId`）严格匹配本地意图，
 * 认不出锚就抛错（存活挂单因此撤不掉）；`orderStatus` 是 OpenD 的状态串**原文**，
 * 映射归消费方的 `stateOf`。其余是同一行上的附加列（GUI 挂单列表用）。
 */
export interface FutuPendingOrder {
  readonly orderId: string
  readonly code: string
  readonly orderStatus: string
  readonly remark: string
  readonly stockName?: string
  readonly trdSide?: string
  readonly orderType?: string
  readonly qty?: number
  readonly price?: number
  readonly dealtQty?: number
  readonly createTime?: string
}

/** 富途 K 线周期映射枚举 */
export const INTERVAL_TO_FUTU: Record<Interval, number> = {
  '1m': 1,
  '5m': 2,
  '15m': 3,
  '30m': 4,
  '1h': 5,
  '4h': 5, // Futu 无 4h 原生档，映射到 60m
  '1d': 6,
  '1w': 7,
  '1M': 8,
}

const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 1000,
  '1M': 30 * 24 * 60 * 1000,
}

export const INTERVAL_VOCABULARY = Object.keys(INTERVAL_TO_FUTU) as Interval[]

/** 归一化港股代码为规范形（如 00700.HK） */
export function normalizeHkSymbol(raw: string): string {
  const trimmed = raw.trim().toUpperCase()
  let code = trimmed
  if (code.startsWith('HK.')) code = code.slice(3)
  if (code.endsWith('.HK')) code = code.slice(0, -3)
  if (/^\d{1,5}$/.test(code)) {
    return `${code.padStart(5, '0')}.HK`
  }
  throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Futu: malformed HK symbol ${JSON.stringify(raw)}`)
}

/** 归一化美股代码为规范形（如 AAPL；接受 AAPL / us.aapl / US.AAPL / US.BRK.B） */
export function normalizeUsSymbol(raw: string): string {
  const trimmed = raw.trim().toUpperCase()
  let code = trimmed
  if (code.startsWith('US.')) code = code.slice(3)
  if (code.endsWith('.US')) code = code.slice(0, -3)
  // 美股代码为字母主体（类别股如 BRK.B 允许一个点分段）；纯数字是港股形态，不在此受理
  if (/^[A-Z]{1,6}(\.[A-Z]{1,3})?$/.test(code)) {
    return code
  }
  throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Futu: malformed US symbol ${JSON.stringify(raw)}`)
}

/** 港股形态（规范形 00700.HK / 裸数字 700 / Futu 原生形 HK.00700）。 */
const HK_FORM = /^(HK\.)?\d{1,5}(\.HK)?$/

/** 按形态分派归一：港股形态走港股，其余走美股（行情面双市场入口）。 */
export function normalizeSymbol(raw: string): string {
  const trimmed = raw.trim().toUpperCase()
  if (HK_FORM.test(trimmed)) {
    return normalizeHkSymbol(trimmed)
  }
  return normalizeUsSymbol(trimmed)
}

/** 将规范形转换为 FutuOpenD 所需格式（HK.00700 / US.AAPL） */
export function toFutuSecurity(canonicalSymbol: string): string {
  const trimmed = canonicalSymbol.trim().toUpperCase()
  if (HK_FORM.test(trimmed)) {
    const digits = normalizeHkSymbol(trimmed).slice(0, 5)
    return `HK.${digits}`
  }
  return `US.${normalizeUsSymbol(trimmed)}`
}

export class FutuRestClient {
  private readonly gatewayUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  /** 实例市场（2026-09-08 审查 M3：行情面按市场各建实例，标的来源不跨市场串味）。 */
  readonly market: FutuMarket
  /** 交易面环境（缺省 SIMULATE）。 */
  readonly trdEnv: FutuTrdEnv
  /** OpenD 账户 id；0 / 缺省 = 由 OpenD 用默认账户。 */
  readonly accId: number | undefined

  constructor(options: FutuRestOptions = {}) {
    this.gatewayUrl = (options.gatewayUrl ?? 'http://127.0.0.1:11111').replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.market = options.market ?? 'hk'
    this.trdEnv = options.trdEnv ?? 'SIMULATE'
    this.accId = options.accId
  }

  /** 出站：GET + query（行情面）。 */
  private async request<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    const url = new URL(path.startsWith('/') ? path : '/' + path, this.gatewayUrl)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }
    return this.send<T>(url, { headers: { accept: 'application/json' } })
  }

  /**
   * 出站：POST + JSON（交易面）。三条 `/api/trd/*` **只有这一种传输**——owner 2026-10-08 裁决，
   * 桥侧同批按 POST 实现（此前客户端发的是 GET + query）。
   */
  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = new URL(path.startsWith('/') ? path : '/' + path, this.gatewayUrl)
    return this.send<T>(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** 交易环境：本次调用 > 构造时；两处都缺省 `SIMULATE`（**没有默认实盘**）。 */
  private trdEnvOf(credentials?: FutuCredentials): FutuTrdEnv {
    return credentials?.trdEnv ?? this.trdEnv
  }

  /** 账户 id：0 / 缺省都不发这一格（= 让 OpenD 用默认账户，不猜账户）。 */
  private accIdOf(credentials?: FutuCredentials): number | undefined {
    const value = credentials?.accId ?? this.accId
    return value === undefined || value <= 0 ? undefined : value
  }

  /** 发一次请求，把 `{retType, retMsg, data}` 信封折成契约语义（GET / POST 共用）。 */
  private async send<T>(url: URL, init: { method?: string; headers: Record<string, string>; body?: string }): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url.toString(), {
        ...init,
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `FutuOpenD HTTP ${res.status}: ${res.statusText}`)
      }
      const data = await res.json() as { retType?: number; retMsg?: string; sErr?: string; data?: unknown }
      if (typeof data === 'object' && data !== null && 'retType' in data && data.retType !== 0) {
        const msg = data.retMsg || data.sErr || 'unknown error'
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `FutuOpenD error (${data.retType}): ${msg}`)
      }
      return (data?.data ?? data) as T
    } catch (error) {
      if (error instanceof TradingServiceError) throw error
      const msg = error instanceof Error ? error.message : String(error)
      if (/ECONNREFUSED|fetch failed|failed to fetch/i.test(msg)) {
        throw new TradingServiceError(
          'TRADING_NETWORK',
          `FutuOpenD gateway is not reachable at ${this.gatewayUrl}. Please ensure FutuOpenD is running and listening on this port.`,
          error,
        )
      }
      throw new TradingServiceError('TRADING_NETWORK', msg, error)
    } finally {
      clearTimeout(timer)
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const canonical = normalizeSymbol(symbol)
    const security = toFutuSecurity(canonical)
    const data = await this.request<{
      curPrice?: number
      price?: number
      bidPrice?: number
      askPrice?: number
      volume?: number
      time?: string | number
    }>('/api/qot/get-ticker', { security })

    const price = Number(data.curPrice ?? data.price ?? 0)
    const bid = typeof data.bidPrice === 'number' && data.bidPrice > 0 ? data.bidPrice : undefined
    const ask = typeof data.askPrice === 'number' && data.askPrice > 0 ? data.askPrice : undefined
    const volume = typeof data.volume === 'number' ? data.volume : undefined
    const timestamp = typeof data.time === 'number'
      ? data.time
      : typeof data.time === 'string' ? new Date(data.time).getTime() : Date.now()

    return {
      symbol: canonical,
      price,
      timestamp,
      ...(bid !== undefined ? { bid } : {}),
      ...(ask !== undefined ? { ask } : {}),
      ...(volume !== undefined ? { volume } : {}),
    }
  }

  async getKlines(symbol: string, interval: Interval, limit = 100): Promise<Kline[]> {
    const canonical = normalizeSymbol(symbol)
    const security = toFutuSecurity(canonical)
    const klType = INTERVAL_TO_FUTU[interval]
    if (!klType) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_INTERVAL', `Futu: unsupported interval ${String(interval)}`)
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000)
    const data = await this.request<{
      klList?: Array<{ time: string | number; open: number; high: number; low: number; close: number; volume: number }>
      bars?: Array<{ time: string | number; open: number; high: number; low: number; close: number; volume: number }>
    }>('/api/qot/get-kl', {
      security,
      klType,
      reqNum: safeLimit,
      rehabType: 1, // 前复权
    })

    const rawList = data.klList ?? data.bars ?? []
    const duration = INTERVAL_MS[interval] ?? 24 * 60 * 60 * 1000

    return rawList.map((row) => {
      const openTime = typeof row.time === 'number' ? row.time : new Date(row.time).getTime()
      return {
        openTime,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
        closeTime: openTime + duration - 1,
      }
    })
  }

  /**
   * 标的名册（GUI 搜索/联想用）。港股面取 HK.BK1000 盘口；**美股面暂无标的清单
   * 来源**（OpenD 该端点无 US 盘口实证）——返回空表 fail-closed，绝不把港股清单
   * 当作美股候选（2026-09-08 审查 M3）。
   */
  async listInstruments(): Promise<Array<{ symbol: string; name?: string }>> {
    if (this.market !== 'hk') return []
    try {
      const data = await this.request<{
        securityList?: Array<{ security: string; name?: string }>
      }>('/api/qot/get-plate-security', { plate: 'HK.BK1000' })
      const list = data.securityList ?? []
      return list.map((item) => ({
        symbol: normalizeHkSymbol(item.security),
        ...(item.name ? { name: item.name } : {}),
      }))
    } catch {
      return []
    }
  }

  async getBalance(_credentials?: FutuCredentials): Promise<AccountBalance> {
    const data = await this.request<{ cash?: number; frozenCash?: number; totalAssets?: number; currency?: string }>('/api/trd/get-funds')
    // 契约形状 AccountBalance { asset, free, locked }（issue #58）：此前返回
    // currency/available/total 三键，消费方按 .free/.locked 读全为 undefined。
    return {
      asset: data.currency ?? 'HKD',
      free: Number(data.cash ?? 0),
      locked: Number(data.frozenCash ?? 0),
    }
  }

  async placeOrder(credentials: FutuCredentials | undefined, req: { symbol: string; side: 'BUY' | 'SELL'; type: 'MARKET' | 'LIMIT'; quantity: number; price?: number }): Promise<Order> {
    // 交易面仅港股（US 订单需美国账户 trd 上下文，未接）：非港股符号在此显式拒绝
    const canonical = normalizeHkSymbol(req.symbol)
    const security = toFutuSecurity(canonical)
    const accId = this.accIdOf(credentials)
    const data = await this.post<{ orderId?: string; orderID?: string }>('/api/trd/place-order', {
      security,
      trdSide: req.side === 'BUY' ? 1 : 2,
      orderType: req.type === 'MARKET' ? 2 : 1,
      qty: req.quantity,
      price: req.price ?? 0,
      // 桥要求显式环境（没有"默认实盘"，也不替你挑环境）
      trdEnv: this.trdEnvOf(credentials),
      ...(accId !== undefined ? { accId } : {}),
    })

    const id = data.orderId ?? data.orderID ?? `futu-${Date.now()}`
    // 真实回执：side/type 落 OrderSide/OrderType 契约词汇，dryRun 显式回带 false
    // （回执必须显式回带，防 dry-run 语义丢失；issue #58）。
    return {
      id,
      symbol: canonical,
      side: req.side === 'SELL' ? 'sell' : 'buy',
      type: req.type === 'LIMIT' ? 'limit' : 'market',
      quantity: req.quantity,
      price: req.price,
      status: 'new',
      dryRun: false,
      timestamp: Date.now(),
    }
  }

  async cancelOrder(credentials: FutuCredentials | undefined, orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    const accId = this.accIdOf(credentials)
    // 桥要求这条请求带 accId：请求里没有 market，而 HK / US 是两套 trd 上下文（桥不猜是哪个市场）。
    await this.post('/api/trd/cancel-order', {
      orderId,
      trdEnv: this.trdEnvOf(credentials),
      ...(accId !== undefined ? { accId } : {}),
    })
    return { orderId, status: 'canceled' }
  }

  /**
   * 挂单快照（`POST /api/trd/get-orders`，只读）。
   *
   * 这是**执行核启动对账**的权威来源（§13 #7：对账权威是 venue，不是本地日志）：
   * 每一行都带 `remark`（核心的对账锚），缺锚的行在消费方一律抛错——桥不替它补。
   */
  async getPendingOrders(credentials?: FutuCredentials): Promise<FutuPendingOrder[]> {
    const accId = this.accIdOf(credentials)
    const data = await this.post<{ orders?: unknown }>('/api/trd/get-orders', {
      market: this.market.toUpperCase(),
      trdEnv: this.trdEnvOf(credentials),
      ...(accId !== undefined ? { accId } : {}),
    })
    const rows = Array.isArray(data.orders) ? data.orders : []
    return rows.map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>
      const text = (key: string): string => (typeof row[key] === 'string' ? row[key] as string : '')
      const num = (key: string): number | undefined => {
        const value = row[key]
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined
      }
      return {
        orderId: text('orderId'),
        code: text('code'),
        orderStatus: text('orderStatus'),
        remark: text('remark'),
        ...(text('stockName') !== '' ? { stockName: text('stockName') } : {}),
        ...(text('trdSide') !== '' ? { trdSide: text('trdSide') } : {}),
        ...(text('orderType') !== '' ? { orderType: text('orderType') } : {}),
        ...(num('qty') !== undefined ? { qty: num('qty') as number } : {}),
        ...(num('price') !== undefined ? { price: num('price') as number } : {}),
        ...(num('dealtQty') !== undefined ? { dealtQty: num('dealtQty') as number } : {}),
        ...(text('createTime') !== '' ? { createTime: text('createTime') } : {}),
      }
    })
  }
}

export type { AccountBalance, Interval, Kline, Order, Position, Ticker }

