/**
 * Bridge client: same-origin fetch wrappers over /dshtrading/api (the node
 * half registers the route behind the browser-auth fence; same-origin fetch
 * carries the auth cookie by default).
 */
import type { AccountBalance, DerivativesData, DerivativesHistory, Kline, MarketId, MarketInfo, Order, Orderbook, Position, TickerOutcome, TradeFill, TradeTick } from './types.ts'
import type { FundamentalsPackage, InstrumentAssetClass, InstrumentForm, SouthboundHoldingHistory } from '@dshtrading/api'
import type { CustomIndicatorRecord, IndicatorApplyScope, IndicatorInstance } from '@dshtrading/indicators'
import type { KnowledgeCard } from '@dshtrading/knowledge'
import type { CustomStrategyRecord, CustomScreenerRecord } from '@dshtrading/strategies'
import type { FxSnapshot, HoldingsBaseCurrency, HoldingsBookSnapshot, NewHolding, NewHoldingInput } from './holdings-types.ts'
import type { GuiOrderApprovalContext } from './gui-approval.ts'

export class BridgeError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' }, ...(signal === undefined ? {} : { signal }) })
  if (response.status === 401) throw new BridgeError(401, 'unauthorized')
  if (response.status === 403) throw new BridgeError(403, 'forbidden')
  if (!response.ok) {
    // 非 2xx 也读 body（2026-09-04）：桥的协议错误带 code（如 TRADING_NO_TRADE_SERVICE），
    // 调用方据此区分「服务未挂」与「凭证缺失」；body 非 JSON 时静默回退状态码信息。
    const body = await response.json().catch(() => undefined) as { code?: string; message?: string } | undefined
    const detail = typeof body?.message === 'string' && body.message !== '' ? `: ${body.message}` : ''
    throw new BridgeError(response.status, `bridge ${path} failed: ${response.status}${detail}`, body?.code)
  }
  const wire = await response.json() as T
  // 桥的业务错误信封是 HTTP 200 + { ok:false, code, message }；必须转成 rejection，
  // 否则调用方拿到 undefined 当成功值（会以 .map-of-undefined 之类的次生错误炸开）。
  if (wire !== null && typeof wire === 'object' && (wire as { ok?: unknown }).ok === false) {
    const business = wire as { code?: string; message?: string }
    throw new BridgeError(200, `${business.code ?? 'TRADING_UNKNOWN'}: ${business.message ?? 'bridge business error'}`, business.code)
  }
  return wire
}

/** Installed markets + active provider slugs (drives the sidebar tab strip). */
export async function fetchMarkets(): Promise<MarketInfo[]> {
  const wire = await getJson<{ markets: MarketInfo[] }>('/dshtrading/api/markets')
  return wire.markets ?? []
}

/** Batched tickers; per-symbol outcomes are independent (bad codes don't sink the batch). */
export async function fetchTickers(market: MarketId, symbols: string[], provider?: string): Promise<Record<string, TickerOutcome>> {
  const query = new URLSearchParams({ market, symbols: symbols.join(',') })
  // 只在显式指定源时带上：未注册的源由桥以 400 拒绝，不静默换源。
  if (provider !== undefined && provider !== '') query.set('provider', provider)
  const wire = await getJson<{ tickers: Record<string, TickerOutcome> }>(`/dshtrading/api/tickers?${query.toString()}`)
  return wire.tickers ?? {}
}

export async function fetchKlines(market: MarketId, symbol: string, interval: string, limit: number): Promise<Kline[]> {
  const query = new URLSearchParams({ market, symbol, interval, limit: String(limit) })
  const wire = await getJson<{ klines: Kline[] }>(`/dshtrading/api/klines?${query.toString()}`)
  return Array.isArray(wire.klines) ? wire.klines : []
}

/**
 * 与 fetchKlines 同一条路径，另外回报**本次实际供数的 provider slug**（桥未标注时
 * 缺席）。只给需要知道「这根 bar 是谁给的」的路径用（五日级别的跨源合流判定）；
 * fetchKlines 的签名与返回值保持不动，策略/契约依赖它只拿 bar 序列。
 */
export async function fetchKlinesFrom(market: MarketId, symbol: string, interval: string, limit: number): Promise<{ klines: Kline[]; provider?: string }> {
  const query = new URLSearchParams({ market, symbol, interval, limit: String(limit) })
  const wire = await getJson<{ klines: Kline[]; provider?: string }>(`/dshtrading/api/klines?${query.toString()}`)
  const klines = Array.isArray(wire.klines) ? wire.klines : []
  return typeof wire.provider === 'string' && wire.provider !== '' ? { klines, provider: wire.provider } : { klines }
}

/**
 * 衍生品指标快照（issue #38，crypto 专属）。连接器未实现 getDerivatives（现货/股票
 * 数据源）或取数失败 → null：面板整体隐藏，不报错横幅。
 */
export async function fetchDerivatives(market: MarketId, symbol: string): Promise<DerivativesData | null> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const wire = await getJson<{ ok: boolean; derivatives: DerivativesData }>(`/dshtrading/api/derivatives?${query.toString()}`)
    return wire.derivatives ?? null
  } catch {
    return null
  }
}

/**
 * 衍生品历史序列（issue #54，「衍生品」页签趋势卡）。连接器未实现
 * getDerivativesHistory 或取数失败 → null：趋势卡隐藏、快照读数保留。
 */
export async function fetchDerivativesHistory(market: MarketId, symbol: string): Promise<DerivativesHistory | null> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const wire = await getJson<{ ok: boolean; history: DerivativesHistory }>(`/dshtrading/api/derivatives/history?${query.toString()}`)
    return wire.history ?? null
  } catch {
    return null
  }
}

/**
 * 盘口快照（issue #39）。连接器未实现 getOrderbook（yahoo/stooq/腾讯 r_hk）或
 * 取数失败 → null：竖栏降级为「未提供盘口」提示，不报错横幅。
 */
export async function fetchOrderbook(market: MarketId, symbol: string): Promise<Orderbook | null> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const wire = await getJson<{ ok: boolean; orderbook: Orderbook }>(`/dshtrading/api/orderbook?${query.toString()}`)
    return wire.orderbook ?? null
  } catch {
    return null
  }
}

/**
 * 最近逐笔成交（issue #39，时间升序）。连接器未实现 getRecentTrades 或失败 → null：
 * 流水段隐藏；成功但空数组 → []（展示空态由调用方判断 length）。
 */
export async function fetchRecentTrades(market: MarketId, symbol: string, limit = 50): Promise<TradeTick[] | null> {
  try {
    const query = new URLSearchParams({ market, symbol, limit: String(limit) })
    const wire = await getJson<{ ok: boolean; trades: TradeTick[] }>(`/dshtrading/api/trades?${query.toString()}`)
    return Array.isArray(wire.trades) ? wire.trades : []
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 交易台（issue #40）：只读查询 + 强制 dry-run 下单                        */
/* ------------------------------------------------------------------ */

/**
 * 交易只读面的不可用原因（2026-09-04）：此前 400（服务未挂）与 TRADING_CREDENTIALS_MISSING
 * 都被吞成 null，分区一律显示「凭证未配置」——把服务缺失误导成配置问题。
 */
export type TradeRowsReason = 'ok' | 'no-trade-service' | 'credentials-missing' | 'unavailable'

export interface TradeRowsResult<Row> {
  /** 行数据；null = 不可用（原因见 reason）。 */
  rows: Row[] | null
  reason: TradeRowsReason
}

/** BridgeError → 分区语义原因映射（老部署无 code 时按 400 状态回退判服务未挂）。 */
export function tradeRowsReasonOf(error: unknown): TradeRowsReason {
  if (error instanceof BridgeError) {
    if (error.code === 'TRADING_NO_TRADE_SERVICE' || error.status === 400) return 'no-trade-service'
    if (error.code === 'TRADING_CREDENTIALS_MISSING') return 'credentials-missing'
  }
  return 'unavailable'
}

/** 持仓快照。交易服务未挂（400）→ no-trade-service；凭证缺失 → credentials-missing。 */
export async function fetchTradePositions(market: MarketId): Promise<TradeRowsResult<Position>> {
  try {
    const wire = await getJson<{ ok: boolean; positions: Position[] }>(`/dshtrading/api/trade/positions?market=${market}`)
    return { rows: Array.isArray(wire.positions) ? wire.positions : [], reason: 'ok' }
  } catch (error) {
    return { rows: null, reason: tradeRowsReasonOf(error) }
  }
}

/** 余额快照（可选面）。未实现/失败 → unavailable；服务未挂/凭证缺失同持仓语义。 */
export async function fetchTradeBalances(market: MarketId): Promise<TradeRowsResult<AccountBalance>> {
  try {
    const wire = await getJson<{ ok: boolean; balances: AccountBalance[] }>(`/dshtrading/api/trade/balances?market=${market}`)
    return { rows: Array.isArray(wire.balances) ? wire.balances : [], reason: 'ok' }
  } catch (error) {
    return { rows: null, reason: tradeRowsReasonOf(error) }
  }
}

/** 当前挂单（可选面）。未实现/失败 → unavailable（rows null）。 */
export async function fetchTradeOpenOrders(market: MarketId): Promise<TradeRowsResult<Order>> {
  try {
    const wire = await getJson<{ ok: boolean; orders: Order[] }>(`/dshtrading/api/trade/orders?market=${market}`)
    return { rows: Array.isArray(wire.orders) ? wire.orders : [], reason: 'ok' }
  } catch (error) {
    return { rows: null, reason: tradeRowsReasonOf(error) }
  }
}

/** 最近成交流水（可选面）。未实现/失败 → unavailable（rows null）。 */
export async function fetchTradeFills(market: MarketId): Promise<TradeRowsResult<TradeFill>> {
  try {
    const wire = await getJson<{ ok: boolean; fills: TradeFill[] }>(`/dshtrading/api/trade/fills?market=${market}`)
    return { rows: Array.isArray(wire.fills) ? wire.fills : [], reason: 'ok' }
  } catch (error) {
    return { rows: null, reason: tradeRowsReasonOf(error) }
  }
}

export interface GuiOrderInput {
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  quantity: number
  price?: number | undefined
}

export interface GuiOrderResult {
  order?: Order
  error?: string
  /**
   * 宿主回带的稳定业务错误码（如 TRADING_APPROVAL_DENIED）。UI 与意图追踪据此
   * 区分「动作已定论（审批拒绝/参数被拒）」与「结果未知（网关/网络失败）」。
   */
  code?: string
}

/**
 * GUI 实盘下单（只做真交易）：直接打到连接器报单，但**先过宿主逐动作审批**。
 * 请求体带提交身份（`sessionId` 审批绑定 + `intentId` 稳定意图）；宿主没批就没有
 * 订单，回执里的稳定错误码（如 TRADING_APPROVAL_DENIED）原样带回 UI。
 * @param market - 市场。
 * @param input - 订单参数。
 * @param context - 提交身份（官方当前会话 + 稳定意图）。
 * @returns 订单或失败原因（含错误码）。
 */
export async function placeGuiOrder(market: MarketId, input: GuiOrderInput, context: GuiOrderApprovalContext): Promise<GuiOrderResult> {
  try {
    const response = await fetch(`/dshtrading/api/trade/order?market=${market}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...input,
        dryRun: false,
        // 无会话时显式送空串：让宿主给出权威拒绝（客户端不自行放行/拒绝）。
        sessionId: context.sessionId ?? '',
        intentId: context.intentId,
      }),
    })
    const wire = await response.json().catch(() => ({})) as { ok?: boolean; order?: Order; code?: string; message?: string }
    if (!response.ok || wire.ok !== true || wire.order === undefined) {
      const msg = wire.message || wire.code || 'Order rejected or service not mounted'
      console.warn('[dsh-trading] gui order rejected:', wire.code, wire.message)
      return { error: msg, ...(wire.code === undefined ? {} : { code: wire.code }) }
    }
    return { order: wire.order }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network request failed' }
  }
}

/** 兼容别名（历史命名；同样走实盘 + 审批路径，必须带提交身份）。 */
export async function placeGuiDryRunOrder(market: MarketId, input: GuiOrderInput, context: GuiOrderApprovalContext): Promise<Order | null> {
  const res = await placeGuiOrder(market, input, context)
  return res.order ?? null
}

/**
 * GUI 撤单（issue #40）：DELETE /trade/order?market&id&symbol——与下单同门槛，
 * 同样带会话与稳定意图走宿主逐动作审批。
 * @param market - 市场。
 * @param orderId - 订单 id。
 * @param symbol - 可选（按 (symbol, id) 双键定位订单的交易所必填）。
 * @param context - 提交身份（官方当前会话 + 稳定意图）。
 * @returns 是否撤单成功（拒绝归因由宿主决定，前端只显示失败）。
 */
export async function cancelGuiOrder(
  market: MarketId,
  orderId: string,
  symbol: string | undefined,
  context: GuiOrderApprovalContext,
): Promise<boolean> {
  try {
    const query = new URLSearchParams({
      market,
      id: orderId,
      ...(symbol ? { symbol } : {}),
      sessionId: context.sessionId ?? '',
      intentId: context.intentId,
    })
    const response = await fetch(`/dshtrading/api/trade/order?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    const wire = await response.json().catch(() => ({})) as { ok?: boolean; canceled?: boolean; code?: string; message?: string }
    if (!response.ok || wire.ok !== true || wire.canceled !== true) {
      console.warn('[dsh-trading] gui cancel rejected:', wire.code, wire.message)
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * 动态全集标的名册（Issue #15）：可传 q 进行上游在线检索。未支持或失败时回退空数组。
 * 形态/资产类别随 wire 透传（2026-10-08 加密永续；P4 已在 `SymbolInfoWire` 落地），
 * 客户端据此渲染形态徽标与 TradFi 归属——**不按符号猜资产类别**。
 */
export type SymbolInfo = { symbol: string; name?: string; form?: InstrumentForm; assetClass?: InstrumentAssetClass }

export async function fetchSymbols(market: MarketId, q?: string): Promise<SymbolInfo[]> {
  const query = new URLSearchParams({ market, ...(q ? { query: q } : {}) })
  const wire = await getJson<{ symbols: SymbolInfo[] }>(`/dshtrading/api/symbols?${query.toString()}`)
  return Array.isArray(wire.symbols) ? wire.symbols : []
}

/**
 * 拉取自定义指标列表（Issue #19）。失败必须 reject：空数组只表示「确实没有
 * 自定义指标」，桥不可达是另一回事。把失败吞成空数组会让「桥挂了」和「没有
 * 自定义指标」变成同一个状态——2026-10-14 KDAS「自建指标不见了」正是这条路径
 * （一次性 fetch 静默空数组 + 只在 SSE 失效信号时重拉 = 瞬时失败即永久缺失且
 * 界面不可见）。失败分类与重试见 indicator-load.ts。
 */
export async function fetchCustomIndicators(): Promise<CustomIndicatorRecord[]> {
  const wire = await getJson<{ ok: boolean; indicators: CustomIndicatorRecord[] }>('/dshtrading/api/indicators/custom')
  return Array.isArray(wire.indicators) ? wire.indicators : []
}

/** 删除自定义指标。 */
export async function deleteCustomIndicator(id: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/indicators/custom?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean; removed?: boolean }
    return wire.ok === true && wire.removed === true
  } catch {
    return false
  }
}

/** 拉取知识库卡片全集列表（Issue #24）。 */
export async function fetchKnowledgeCards(): Promise<KnowledgeCard[]> {
  try {
    const wire = await getJson<{ ok: boolean; cards: KnowledgeCard[] }>('/dshtrading/api/knowledge/cards')
    return Array.isArray(wire.cards) ? wire.cards : []
  } catch (err) {
    console.warn('[dsh-trading] fetchKnowledgeCards failed, fallback to empty:', err)
    return []
  }
}

/** 知识库导入结果（桥 POST /dshtrading/api/knowledge/import 的响应镜像）。 */
export interface KnowledgeImportResult {
  ok: boolean
  created: number
  updated: number
  skipped: number
  dropped: number
  invalid: number
  remapped: number
  skippedItems: Array<{ id: string; title: string; url: string; reason: string }>
  invalidItems: Array<{ index: number; title?: string; error: string }>
  error?: string
}

/** 失败态：全 0 计数 + 可直接显示的一条错误文案（导入是点击动作，需要文案不需要异常）。 */
function importFailure(error: string): KnowledgeImportResult {
  return {
    ok: false,
    created: 0,
    updated: 0,
    skipped: 0,
    dropped: 0,
    invalid: 0,
    remapped: 0,
    skippedItems: [],
    invalidItems: [],
    error,
  }
}

const importNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0
const importText = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback

function importSkippedItems(value: unknown): KnowledgeImportResult['skippedItems'] {
  if (!Array.isArray(value)) return []
  const items: KnowledgeImportResult['skippedItems'] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    items.push({
      id: importText(row.id, ''),
      title: importText(row.title, ''),
      url: importText(row.url, ''),
      reason: importText(row.reason, ''),
    })
  }
  return items
}

/**
 * 失败响应里挑出给用户看的那句话。三个字段各来自一种拒绝：
 * error = 网关/业务自述的失败文本；reason = 能力未挂载（导入类先例：host 没挂 store
 * 时是 HTTP 200 + { ok:false, reason }，见 bridge 的 importKnowledge /
 * importChartActivations）；message = 协议拒绝（BridgeProtocolError 序列化为
 * { ok:false, code, message }）。三样都没有才退 HTTP 状态码。
 */
function importFailureDetail(wire: Record<string, unknown> | undefined, status: number): string {
  for (const field of ['error', 'reason', 'message'] as const) {
    const text = importText(wire?.[field], '')
    if (text !== '') return text
  }
  return `HTTP ${status}`
}

function importInvalidItems(value: unknown): KnowledgeImportResult['invalidItems'] {
  if (!Array.isArray(value)) return []
  const items: KnowledgeImportResult['invalidItems'] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const title = importText(row.title, '')
    items.push({
      index: importNumber(row.index),
      error: importText(row.error, ''),
      // exactOptionalPropertyTypes：没有标题时不带这个键，而不是给一个 undefined。
      ...(title === '' ? {} : { title }),
    })
  }
  return items
}

/**
 * 导入知识库 bundle（写路由；成功后桥广播 'knowledge' 失效信号，视图重拉卡片）。
 *
 * 不走 getJson：那条路径把非 2xx 与业务错误一律转成 rejection，而导入失败要的是
 * 「一句话 + 全 0 计数」让面板就地显示。响应体里的错误文本按桥的协议信封取
 * （BridgeProtocolError 序列化为 { ok:false, code, message }，见 bot-api 的
 * 路由错误分支），取不到才退化成 HTTP 状态码。
 */
export async function importKnowledgeBundle(input: {
  mode: 'skip' | 'overwrite'
  bundle: string
}): Promise<KnowledgeImportResult> {
  let response: Response
  try {
    response = await fetch('/dshtrading/api/knowledge/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ mode: input.mode, bundle: input.bundle }),
    })
  } catch (error) {
    return importFailure(error instanceof Error ? error.message : String(error))
  }

  const wire = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
  if (!response.ok || wire === undefined || wire.ok !== true) {
    return importFailure(importFailureDetail(wire, response.status))
  }

  return {
    ok: true,
    created: importNumber(wire.created),
    updated: importNumber(wire.updated),
    skipped: importNumber(wire.skipped),
    dropped: importNumber(wire.dropped),
    invalid: importNumber(wire.invalid),
    remapped: importNumber(wire.remapped),
    skippedItems: importSkippedItems(wire.skippedItems),
    invalidItems: importInvalidItems(wire.invalidItems),
  }
}

/* ------------------------------------------------------------------ */
/* 新闻情报流（issue #37）                                                */
/* ------------------------------------------------------------------ */

export interface ClientNewsItem {
  source: string
  title: string
  url: string
  publishedAt: string
}

export interface ClientNewsResult {
  items: ClientNewsItem[]
  unavailable: string[]
}

/**
 * 标的新闻（issue #37）。Kit 未注册或会话不活跃 → null：面板显示空态提示。
 * 只返回与标的相关的条目；无相关内容即空列表，无市场要闻兜底。
 */
export async function fetchNews(market: MarketId, symbol?: string, limit = 20, signal?: AbortSignal): Promise<ClientNewsResult | null> {
  try {
    const query = new URLSearchParams({ market, ...(symbol ? { symbol } : {}), limit: String(limit) })
    const wire = await getJson<{ ok: boolean; items: ClientNewsItem[]; unavailable: string[] }>(
      `/dshtrading/api/news?${query.toString()}`, signal,
    )
    return { items: wire.items ?? [], unavailable: wire.unavailable ?? [] }
  } catch {
    return null
  }
}

/**
 * 市场快讯（金十接入，2026-09-13；桥 /flash）：光标翻页 + 可选关键词搜索。
 * 失败（未装数据源/凭证缺失/上游故障）返回 null，由视图显示可操作提示——
 * 不回落成空列表冒充「没有快讯」。
 */
export async function fetchFlash(options: { cursor?: string; keyword?: string; limit?: number; hot?: readonly string[] } = {}, signal?: AbortSignal): Promise<ClientFlashPage | null> {
  try {
    const query = new URLSearchParams({ limit: String(options.limit ?? 30) })
    if (options.cursor !== undefined && options.cursor !== '') query.set('cursor', options.cursor)
    if (options.keyword !== undefined && options.keyword !== '') query.set('keyword', options.keyword)
    if (options.hot !== undefined && options.hot.length > 0) query.set('hot', options.hot.join(','))
    const wire = await getJson<{ ok: boolean; items: ClientNewsItem[]; nextCursor?: string; hasMore?: boolean }>(
      '/dshtrading/api/flash?' + query.toString(), signal,
    )
    return {
      items: wire.items ?? [],
      hasMore: wire.hasMore === true,
      ...(wire.nextCursor !== undefined ? { nextCursor: wire.nextCursor } : {}),
    }
  } catch {
    return null
  }
}

export interface ClientFlashPage {
  items: ClientNewsItem[]
  nextCursor?: string
  hasMore: boolean
}

/* ------------------------------------------------------------------ */
/* 宏观/利率（金十接入，2026-09-15）                                        */
/* ------------------------------------------------------------------ */

/** 当周经济数据条目（数值为上游快照原样字符串；actual 缺省 = 未公布）。 */
export interface ClientMacroCalendarEntry {
  publishedAt: string
  star: number
  /** 地区（标题前缀推断；空串 = 未识别，仅「全部」视图可见）。 */
  region: string
  title: string
  previous?: string
  consensus?: string
  actual?: string
  revised?: string
  affect?: string
}

/** 央行最新利率条目。 */
export interface ClientMacroRateEntry {
  region: string
  bankName: string
  rate: string
  publishedAt: string
  indicatorName?: string
}

/**
 * 当周经济日历（桥 /macro/calendar；官方 MCP list_calendar）。失败（未装金十连接器/
 * 上游故障）返回 null，由视图显示可操作提示——不回落成空列表冒充「没有数据」。
 */
export async function fetchMacroCalendar(limit: number, signal?: AbortSignal): Promise<ClientMacroCalendarEntry[] | null> {
  try {
    const wire = await getJson<{ ok: boolean; items: ClientMacroCalendarEntry[] }>(`/dshtrading/api/macro/calendar?limit=${limit}`, signal)
    return Array.isArray(wire.items) ? wire.items : []
  } catch {
    return null
  }
}

/** 央行最新利率（桥 /macro/rates；网页版接口全量，地区过滤在面板）。失败 → null。 */
export async function fetchMacroRates(signal?: AbortSignal): Promise<ClientMacroRateEntry[] | null> {
  try {
    const wire = await getJson<{ ok: boolean; items: ClientMacroRateEntry[] }>('/dshtrading/api/macro/rates', signal)
    return Array.isArray(wire.items) ? wire.items : []
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 预测市场（Polymarket 接入，2026-10-11）                                  */
/* ------------------------------------------------------------------ */

/** 档位条目（概率口径与归一化键由连接器实现，客户端只读不改写）。 */
export interface ClientPredictionBucket {
  /** 稳定档位键（如 `no_change`；服务端归一化，客户端不重算）。 */
  key: string
  /** 上游标签原文（展示用）。 */
  label: string
  /** 利率变动（bps；降息为负）。未识别形态 = undefined。 */
  changeBps?: number
  /** 隐含概率（0..1）。 */
  probability: number
  bestBid?: number
  bestAsk?: number
  spread?: number
  /** 盘口深度（美元）。 */
  liquidity?: number
  volume?: number
  volume24h?: number
  /** 仍可下单（上游 market 级 acceptingOrders）。 */
  acceptingOrders: boolean
  closed: boolean
  /** 与上次观察的差值；**首次观察缺省**（不是 0）。 */
  changeSincePrevious?: number
}

/** 一场 FOMC 决议会议。 */
export interface ClientPredictionMeeting {
  id: string
  slug: string
  title: string
  endDate: string
  meetingWindow?: string
  closed: boolean
  buckets: ClientPredictionBucket[]
  /** 各档概率之和（健康检查用，实测正常区间约 [0.98, 1.03]）。 */
  probabilitySum: number
  /** 数据质量提示（空数组 = 全部健康）。 */
  degraded: string[]
}

/**
 * 预测市场取数结果。
 *
 * **刻意不用 `null` 表示失败**（与 macro 两个 fetcher 的差异，理由在验收要求）：
 * 「连接器没装」（TRADING_NOT_IMPLEMENTED）、「上游失败」与「真的没有会议」是三种
 * 不同的事实，面板要分别提示。返回 `null` 会把前两者压成同一个值，正是
 * 「把失败画成没有数据」的形态。
 */
export type ClientPredictionResult =
  | { status: 'ok'; fetchedAt: string; meetings: ClientPredictionMeeting[] }
  | { status: 'error'; code: string; message: string }

/**
 * FOMC 决议档位与隐含概率（桥 /prediction/fomc）。失败 → 明确错误状态
 * （`status: 'error'` 带 code），由 UI 决定提示；绝不回落成空数组。
 */
export async function fetchPredictionFomc(signal?: AbortSignal): Promise<ClientPredictionResult> {
  try {
    const wire = await getJson<{ ok: boolean; fetchedAt: string; meetings: ClientPredictionMeeting[] }>('/dshtrading/api/prediction/fomc', signal)
    if (!Array.isArray(wire.meetings)) {
      return { status: 'error', code: 'TRADING_PROTOCOL', message: 'bridge returned no meetings array' }
    }
    return { status: 'ok', fetchedAt: wire.fetchedAt, meetings: wire.meetings }
  } catch (error) {
    if (error instanceof BridgeError) {
      return { status: 'error', code: error.code ?? 'TRADING_PROTOCOL', message: error.message }
    }
    return { status: 'error', code: 'TRADING_NETWORK', message: error instanceof Error ? error.message : String(error) }
  }
}

/* ------------------------------------------------------------------ */
/* SSE 失效信号订阅（issue #30 / P1）                                        */
/* ------------------------------------------------------------------ */

/** 拉取自定义策略名册（issue #31，桥 /strategies/custom；前端校验后并入名册）。 */
export async function fetchCustomStrategies(): Promise<CustomStrategyRecord[]> {
  try {
    const wire = await getJson<{ ok: boolean; strategies: CustomStrategyRecord[] }>('/dshtrading/api/strategies/custom')
    return Array.isArray(wire.strategies) ? wire.strategies : []
  } catch (err) {
    console.warn('[dsh-trading] fetchCustomStrategies failed, fallback to empty:', err)
    return []
  }
}

/** 删除策略（策略管理）：自定义移除 / 内置落墓碑，均返回是否生效。 */
export async function deleteCustomStrategy(id: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/strategies/custom?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean; removed?: boolean }
    return wire.ok === true && wire.removed === true
  } catch {
    return false
  }
}

/** 保存（新增/覆盖）自定义策略（策略管理）：桥侧 vm 沙箱校验通过才落盘。 */
export async function saveCustomStrategy(input: {
  id: string
  title: string
  horizon: string
  summary: string
  paramsJson: string
  computeSource: string
  overridesBuiltin?: boolean
}): Promise<{ ok: true; overridesBuiltin: boolean } | { ok: false; reason: string } | null> {
  try {
    const response = await fetch('/dshtrading/api/strategies/custom', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!response.ok) return null
    const wire = await response.json() as { ok?: boolean; message?: string; overridesBuiltin?: boolean }
    if (wire.ok === true) return { ok: true, overridesBuiltin: wire.overridesBuiltin === true }
    return { ok: false, reason: wire.message ?? 'validation failed' }
  } catch (err) {
    console.warn('[dsh-trading] saveCustomStrategy failed:', err)
    return null
  }
}

/** 恢复内置策略出厂默认（策略管理）：清覆盖记录与墓碑。 */
export async function resetStrategy(id: string): Promise<{ ok: boolean; changed: boolean } | null> {
  try {
    const response = await fetch('/dshtrading/api/strategies/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!response.ok) return null
    const wire = await response.json() as { ok?: boolean; changed?: boolean }
    return { ok: wire.ok === true, changed: wire.changed === true }
  } catch (err) {
    console.warn('[dsh-trading] resetStrategy failed:', err)
    return null
  }
}

/** 内置删除墓碑清单（策略管理）：GUI 据此展示灰卡与恢复入口。 */
export async function fetchStrategyTombstones(): Promise<string[]> {
  try {
    const wire = await getJson<{ ok: boolean; deleted: string[] }>('/dshtrading/api/strategies/tombstones')
    return Array.isArray(wire.deleted) ? wire.deleted : []
  } catch (err) {
    console.warn('[dsh-trading] fetchStrategyTombstones failed, fallback to empty:', err)
    return []
  }
}

/* ------------------------------------------------------------------ */
/* 自定义选股器（选股器管理，2026-09-07）                                     */
/* ------------------------------------------------------------------ */

/** 拉取自定义选股器名册（含内置覆盖记录；前端校验后并入名册）。 */
export async function fetchCustomScreeners(): Promise<CustomScreenerRecord[]> {
  try {
    const wire = await getJson<{ ok: boolean; screeners: CustomScreenerRecord[] }>('/dshtrading/api/strategies/screeners')
    return Array.isArray(wire.screeners) ? wire.screeners : []
  } catch (err) {
    console.warn('[dsh-trading] fetchCustomScreeners failed, fallback to empty:', err)
    return []
  }
}

/** 保存（新增/覆盖）自定义选股器：桥侧 vm 沙箱校验通过才落盘。 */
export async function saveCustomScreener(input: {
  id: string
  title: string
  summary: string
  paramsJson: string
  columnsJson: string
  evaluateSource: string
  overridesScreener?: boolean
}): Promise<{ ok: true; overridesScreener: boolean } | { ok: false; reason: string } | null> {
  try {
    const response = await fetch('/dshtrading/api/strategies/screeners', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!response.ok) return null
    const wire = await response.json() as { ok?: boolean; message?: string; overridesScreener?: boolean }
    if (wire.ok === true) return { ok: true, overridesScreener: wire.overridesScreener === true }
    return { ok: false, reason: wire.message ?? 'validation failed' }
  } catch (err) {
    console.warn('[dsh-trading] saveCustomScreener failed:', err)
    return null
  }
}

/** 删除选股器（选股器管理）：自定义移除 / 内置落墓碑，均返回是否生效。 */
export async function deleteCustomScreener(id: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/strategies/screeners?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean; removed?: boolean }
    return wire.ok === true && wire.removed === true
  } catch {
    return false
  }
}

/** 恢复内置选股器出厂默认（选股器管理）：清覆盖记录与墓碑。 */
export async function resetScreener(id: string): Promise<{ ok: boolean; changed: boolean } | null> {
  try {
    const response = await fetch('/dshtrading/api/strategies/screeners/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!response.ok) return null
    const wire = await response.json() as { ok?: boolean; changed?: boolean }
    return { ok: wire.ok === true, changed: wire.changed === true }
  } catch (err) {
    console.warn('[dsh-trading] resetScreener failed:', err)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 自选股 + 选中标的（issue #32 / P3）：host store 为 SSOT                  */
/* ------------------------------------------------------------------ */

/** host 侧自选行（WatchlistsMap：market → 行数组；不含客户端种子回退；groups = 分组 id 多归属）。 */
export type HostWatchlistRow = {
  market: string
  symbol: string
  name?: string
  form?: InstrumentForm
  assetClass?: InstrumentAssetClass
  groups?: string[]
}
export type HostWatchlists = Record<string, HostWatchlistRow[]>

/** host 侧自定义分组（issue #82 wire 形状）。 */
export interface HostWatchlistGroup {
  id: string
  name: string
  createdAt: number
}

/** 读取 host 自选全量（启动同步与 SSE 重拉）。 */
export async function fetchHostWatchlists(): Promise<HostWatchlists> {
  try {
    const wire = await getJson<{ ok: boolean; watchlists: HostWatchlists }>('/dshtrading/api/watchlists')
    return wire.watchlists ?? {}
  } catch (err) {
    console.warn('[dsh-trading] fetchHostWatchlists failed, fallback to local mirror:', err)
    throw err instanceof BridgeError ? err : new BridgeError(0, 'watchlists unavailable')
  }
}

/** 追加一行（POST /watchlists；groups 供分组视图下添加直落归属）。 */
export async function addHostWatchlistRow(instrument: { market: string; symbol: string; name?: string; form?: InstrumentForm; assetClass?: InstrumentAssetClass; groups?: string[] }): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/watchlists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(instrument),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 移除一行（DELETE /watchlists?market&symbol）。 */
export async function removeHostWatchlistRow(market: string, symbol: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const response = await fetch(`/dshtrading/api/watchlists?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 一次性迁移导入（POST /watchlists/import；host 非空时服务端拒绝，幂等）。 */
export async function importHostWatchlists(rows: HostWatchlists): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/watchlists/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watchlists: rows }),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 读取 host 选中标的（GET /selection）。 */
export async function fetchHostSelection(): Promise<HostWatchlistRow | null> {
  try {
    const wire = await getJson<{ ok: boolean; instrument: HostWatchlistRow | null }>('/dshtrading/api/selection')
    return wire.instrument ?? null
  } catch {
    return null
  }
}

/** 设置 host 选中标的（PUT /selection；watchlist_select 工具与左栏点击同源）。 */
export async function putHostSelection(instrument: { market: string; symbol: string; name?: string; form?: InstrumentForm; assetClass?: InstrumentAssetClass } | null): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/selection', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instrument }),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 自定义分组（issue #82）：注册表 CRUD + 行级 membership                   */
/* ------------------------------------------------------------------ */

/** 读取分组注册表 + 置顶键集（GET /watchlist-groups；桥缺席/失败 → null，调用方维持现状）。 */
export async function fetchHostWatchlistGroups(): Promise<{ groups: HostWatchlistGroup[]; pinned: string[] } | null> {
  try {
    const wire = await getJson<{ ok: boolean; groups: HostWatchlistGroup[]; pinned?: string[] }>('/dshtrading/api/watchlist-groups')
    return {
      groups: Array.isArray(wire.groups) ? wire.groups : [],
      // 老桥没有 pinned 字段：按空集处理（升级前行为不变）。
      pinned: Array.isArray(wire.pinned) ? wire.pinned.filter((key): key is string => typeof key === 'string' && key !== '') : [],
    }
  } catch {
    return null
  }
}

/** 置顶/取消置顶（PUT /watchlist-pins）；成功返回 host 权威键集，失败 null（本地不动）。 */
export async function putHostWatchlistPin(key: string, pinned: boolean): Promise<string[] | null> {
  try {
    const response = await fetch('/dshtrading/api/watchlist-pins', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, pinned }),
    })
    if (!response.ok) return null
    const wire = await response.json() as { ok?: boolean; pinned?: unknown }
    if (wire.ok !== true) return null
    return Array.isArray(wire.pinned) ? wire.pinned.filter((entry): entry is string => typeof entry === 'string') : null
  } catch {
    return null
  }
}

/** 创建分组（POST /watchlist-groups）；同名业务拒绝 → 'duplicate'。 */
export async function createHostWatchlistGroup(name: string): Promise<{ ok: true; group: HostWatchlistGroup } | { ok: false; reason: 'duplicate' | 'unavailable' }> {
  try {
    const response = await fetch('/dshtrading/api/watchlist-groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!response.ok) return { ok: false, reason: 'unavailable' }
    const wire = await response.json() as { ok?: boolean; group?: HostWatchlistGroup; code?: string; reason?: string }
    if (wire.ok === true && wire.group !== undefined) return { ok: true, group: wire.group }
    // code 是机器可读判据（审查 L4）；缺 code 的旧桥按 reason 文案兜底。
    if (wire.code === 'duplicate' || (wire.reason ?? '').includes('already exists')) return { ok: false, reason: 'duplicate' }
    return { ok: false, reason: 'unavailable' }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

/** 重命名分组（PUT /watchlist-groups）。 */
export async function renameHostWatchlistGroup(id: string, name: string): Promise<{ ok: true; group: HostWatchlistGroup } | { ok: false; reason: 'duplicate' | 'not-found' | 'unavailable' }> {
  try {
    const response = await fetch('/dshtrading/api/watchlist-groups', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name }),
    })
    if (!response.ok) return { ok: false, reason: 'unavailable' }
    const wire = await response.json() as { ok?: boolean; group?: HostWatchlistGroup; code?: string; reason?: string }
    if (wire.ok === true && wire.group !== undefined) return { ok: true, group: wire.group }
    // 审查 L4：not-found（组已被别处删除）与同名冲突此前同形，一律显示「名称已存在」。
    if (wire.code === 'not-found' || (wire.reason ?? '').includes('no such group id')) return { ok: false, reason: 'not-found' }
    if (wire.code === 'duplicate' || (wire.reason ?? '').includes('already exists')) return { ok: false, reason: 'duplicate' }
    return { ok: false, reason: 'unavailable' }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

/** 删除分组（DELETE /watchlist-groups?id=；host 同步剥离所有行上的归属）。 */
export async function deleteHostWatchlistGroup(id: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/watchlist-groups?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 加入分组（POST /watchlist-group-members；行缺席 host 自动物化）。 */
export async function addHostWatchlistGroupMember(id: string, market: string, symbol: string, name?: string): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/watchlist-group-members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, market, symbol, ...(name !== undefined ? { name } : {}) }),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 移出分组（DELETE /watchlist-group-members?id&market&symbol）。 */
export async function removeHostWatchlistGroupMember(id: string, market: string, symbol: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id, market, symbol })
    const response = await fetch(`/dshtrading/api/watchlist-group-members?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 图表激活名册 host SSOT（issue #63）                                      */
/* ------------------------------------------------------------------ */

/** 全量读取 host 激活名册（GET /chart/indicators）。 */
export async function fetchChartActivations(): Promise<IndicatorInstance[]> {
  try {
    const wire = await getJson<{ ok: boolean; instances: IndicatorInstance[] }>('/dshtrading/api/chart/indicators')
    return Array.isArray(wire.instances) ? wire.instances : []
  } catch {
    return []
  }
}

/**
 * 挂载/更新一个激活实例（PUT /chart/indicators；未知 id → ok:false，转 false）。
 * issue #72：带 scope（market+symbol）时写该标的的参数覆盖，不动全局 params。
 * symbol visibility：scope 带 visible 时为可见性写（market 必带，symbol 可选——
 * 缺省即整市场），params 缺省。
 * applyScope：传该实例的完整适用范围表（整表替换；空表清空该字段，落回全部应用）。
 */
export async function putChartActivation(
  id: string,
  params?: Record<string, number>,
  scope?: { market: string; symbol?: string; visible?: boolean },
  applyScope?: IndicatorApplyScope,
): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/chart/indicators', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        ...(params !== undefined ? { params } : {}),
        ...(applyScope !== undefined ? { applyScope } : {}),
        ...(scope !== undefined ? {
          market: scope.market,
          ...(scope.symbol !== undefined ? { symbol: scope.symbol } : {}),
          ...(scope.visible !== undefined ? { visible: scope.visible } : {}),
        } : {}),
      }),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 摘除一个激活实例（DELETE /chart/indicators?id=）。 */
export async function removeChartActivation(id: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/chart/indicators?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean }
    return wire.ok === true
  } catch {
    return false
  }
}

/** 一次性迁移导入本地激活名册（POST /chart/indicators/import；host 非空拒绝 → false）。 */
export async function importChartActivations(instances: IndicatorInstance[]): Promise<boolean> {
  try {
    const response = await fetch('/dshtrading/api/chart/indicators/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instances }),
    })
    if (!response.ok) return false
    const wire = await response.json() as { ok?: boolean; imported?: boolean }
    return wire.ok === true && wire.imported === true
  } catch {
    return false
  }
}

/**
 * store 词汇（v1）：镜像 host 半 @dshtrading/eventbus 的 TradingEventStore.
 * 浏览器半不 import node 包（避免把 cordis 拖进 client bundle）——词汇是封闭
 * 小集合，镜像漂移的代价是 handler 不触发（降级为现状），可接受。
 */
export type TradingEventStoreName =
  | 'indicators'
  | 'strategies'
  | 'knowledge'
  | 'watchlists'
  | 'selection'
  | 'routing'
  | 'chart'
  | 'tasks'
  | 'holdings'

type TradingEventHandlers = Partial<Record<TradingEventStoreName, () => void>>

/** 模块级单例：多视图共享一条 EventSource 连接（多标签页各自一条，天然隔离）。 */
let tradingEventSource: EventSource | null = null
const tradingEventListeners = new Set<(store: TradingEventStoreName) => void>()
/** 桥就绪监听者（EventSource `open`）：首连与每次自动重连都触发一次。 */
const tradingBridgeReadyListeners = new Set<() => void>()

function ensureTradingEventSource(): void {
  if (tradingEventSource !== null) return
  // 无 EventSource（老浏览器/非 web 环境）→ 一次性 fetch 的现状兜底。
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return
  const source = new EventSource('/dshtrading/api/events')
  // `open` 是「桥可达」的唯一客户端证据（onerror 只说明连接断了，原生重连成功
  // 与否没有别的回调）：挂载期拉取若发生在桥就绪之前，这里是唯一能自愈的触发点。
  source.addEventListener('open', () => {
    for (const listener of [...tradingBridgeReadyListeners]) listener()
  })
  source.addEventListener('store.changed', (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data as string) as { store?: string }
      if (typeof data.store !== 'string') return
      for (const listener of [...tradingEventListeners]) listener(data.store as TradingEventStoreName)
    } catch {
      /* 坏帧忽略（总线只发 JSON 信号，正常不会发生） */
    }
  })
  source.onerror = () => {
    /* EventSource 原生自动重连；桥未挂载（503）时持续失败 = 降级现状，不打扰用户 */
  }
  tradingEventSource = source
}

/**
 * 订阅失效信号：store 名 → refetch 回调。返回退订函数；最后一个订阅者退订时
 * 关闭连接（视图互斥挂载下 quote/strategy/knowledge 轮流订阅不堆积）。
 */
export function subscribeTradingEvents(handlers: TradingEventHandlers): () => void {
  ensureTradingEventSource()
  const listener = (store: TradingEventStoreName): void => { handlers[store]?.() }
  tradingEventListeners.add(listener)
  return () => {
    tradingEventListeners.delete(listener)
    if (tradingEventListeners.size === 0 && tradingEventSource !== null) {
      tradingEventSource.close()
      tradingEventSource = null
    }
  }
}

/**
 * 订阅「桥就绪」通知（EventSource `open`：首连与每次自动重连）。加载期失败的
 * 自定义指标靠它在桥可用的第一时间重拉（2026-10-14），不必等下一次失效信号。
 */
export function subscribeTradingBridgeReady(handler: () => void): () => void {
  ensureTradingEventSource()
  tradingBridgeReadyListeners.add(handler)
  return () => { tradingBridgeReadyListeners.delete(handler) }
}

/**
 * 更新提示点（自动更新插件 @dshtrading/client-ui-updater 的桥状态）：
 * GET /dshtrading/api/updater/state，仅取 available 布尔。桥缺席（老部署/
 * headless 404）→ null（点永不亮，不报错横幅）。
 */
export interface UpdateBadgeState {
  available: boolean
  version?: string
}

export async function fetchUpdateBadge(): Promise<UpdateBadgeState | null> {
  try {
    const wire = await getJson<{
      environment?: { supported?: boolean }
      check?: { available?: boolean, latest?: { version?: string } }
    }>('/dshtrading/api/updater/state')
    if (wire.environment?.supported !== true) return { available: false }
    return {
      available: wire.check?.available === true,
      ...(wire.check?.latest?.version === undefined ? {} : { version: wire.check.latest.version }),
    }
  } catch {
    return null
  }
}

/** 拉取标的综合基本面与多期财务矩阵数据（Issue #36，富途牛牛风格工作台数据源）。 */
export async function fetchFundamentals(market: MarketId, symbol: string, signal?: AbortSignal): Promise<FundamentalsPackage | undefined> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const wire = await getJson<{ ok: boolean; fundamentals?: FundamentalsPackage }>(`/dshtrading/api/fundamentals?${query.toString()}`, signal)
    return wire.fundamentals
  } catch (err) {
    console.warn(`[dsh-trading] fetchFundamentals ${market}/${symbol} failed:`, err)
    return undefined
  }
}

/**
 * 港股通持股历史（GUI「港股通持股比例」副图，2026-10-13；契约 §5 冻结签名）。
 * 信封字段名是 southboundHoldings。宿主未装该端点、标的不在港股通范围或上游
 * 失败 → undefined：副图整体隐藏（空 ≠ 0，不画零线），主图与其它指标不受影响。
 */
export async function fetchSouthboundHoldings(market: MarketId, symbol: string, signal?: AbortSignal): Promise<SouthboundHoldingHistory | undefined> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const wire = await getJson<{ ok: boolean; southboundHoldings?: SouthboundHoldingHistory }>(`/dshtrading/api/southbound-holdings?${query.toString()}`, signal)
    return wire.southboundHoldings
  } catch (err) {
    console.warn(`[dsh-trading] fetchSouthboundHoldings ${market}/${symbol} failed:`, err)
    return undefined
  }
}

export interface ActiveBuyHistory {
  symbol: string
  points: readonly {
    date: string
    buySharePct: number
    netSharePct: number
    phase: 'close' | 'manual' | 'live'
    time: string
    source: 'file' | 'live'
  }[]
  live?: { at: string }
}

export async function fetchActiveBuy(market: MarketId, symbol: string, signal?: AbortSignal): Promise<ActiveBuyHistory | undefined> {
  try {
    const query = new URLSearchParams({ market, symbol })
    const wire = await getJson<ActiveBuyHistory & { ok: boolean }>(`/dshtrading/api/active-buy?${query.toString()}`, signal)
    return wire.ok ? wire : undefined
  } catch (err) {
    console.warn(`[dsh-trading] fetchActiveBuy ${market}/${symbol} failed:`, err)
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* 统一资产台账（Issue #65，契约 §3）：导入持仓 CRUD + staged 待确认区 + FX   */
/* ------------------------------------------------------------------ */

/**
 * 持仓台账快照（staged 待确认区 + holdings 正式区 + revision）。
 * 桥缺席/老部署/失败 → null：imported 源静默降级为空，不报错横幅。
 */
export async function fetchHoldings(): Promise<HoldingsBookSnapshot | null> {
  try {
    const wire = await getJson<{ ok: true; revision: number; staged?: unknown[]; holdings?: unknown[] }>('/dshtrading/api/holdings')
    return {
      revision: typeof wire.revision === 'number' ? wire.revision : 0,
      staged: Array.isArray(wire.staged) ? wire.staged as HoldingsBookSnapshot['staged'] : [],
      holdings: Array.isArray(wire.holdings) ? wire.holdings as HoldingsBookSnapshot['holdings'] : [],
    }
  } catch {
    return null
  }
}

/** 写操作统一 POST/PUT 助手：成功 → revision；业务拒绝/网络失败 → null。 */
async function postHoldingsJson(path: string, method: 'POST' | 'PUT', body: unknown): Promise<{ revision: number; id?: string } | null> {
  try {
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const wire = await response.json().catch(() => ({})) as { ok?: boolean; revision?: number; id?: string; code?: string; message?: string }
    if (!response.ok || wire.ok !== true || typeof wire.revision !== 'number') {
      console.warn('[dsh-trading] holdings write rejected:', wire.code, wire.message)
      return null
    }
    return typeof wire.id === 'string'
      ? { revision: wire.revision, id: wire.id }
      : { revision: wire.revision }
  } catch {
    return null
  }
}

/** staged 待确认区入库（Agent 截图解析的唯一写入口；UI 不直接调，agent 工具走宿主）。 */
export async function stageHoldings(items: NewHoldingInput[]): Promise<number | null> {
  const res = await postHoldingsJson('/dshtrading/api/holdings/stage', 'POST', { items })
  return res?.revision ?? null
}

/** 确认 staged 入账（可带逐条编辑）；返回新 revision。 */
export async function confirmHoldings(ids: string[], edits?: Record<string, Partial<NewHolding>>): Promise<number | null> {
  const res = await postHoldingsJson('/dshtrading/api/holdings/confirm', 'POST', edits === undefined ? { ids } : { ids, edits })
  return res?.revision ?? null
}

/** 丢弃 staged 条目。 */
export async function discardHoldings(ids: string[]): Promise<number | null> {
  const res = await postHoldingsJson('/dshtrading/api/holdings/discard', 'POST', { ids })
  return res?.revision ?? null
}

/** 手动新增一条导入持仓（直入正式区）；成功返回 { revision, id }。 */
export async function addHolding(item: NewHoldingInput): Promise<{ revision: number; id: string } | null> {
  const res = await postHoldingsJson('/dshtrading/api/holdings', 'POST', item)
  return res !== null && typeof res.id === 'string' ? { revision: res.revision, id: res.id } : null
}

/** 编辑一条导入持仓。 */
export async function updateHolding(id: string, patch: Partial<NewHolding>): Promise<number | null> {
  const res = await postHoldingsJson('/dshtrading/api/holdings', 'PUT', { id, patch })
  return res?.revision ?? null
}

/** 删除一条导入持仓（DELETE /holdings?id=）。 */
export async function removeHolding(id: string): Promise<number | null> {
  try {
    const query = new URLSearchParams({ id })
    const response = await fetch(`/dshtrading/api/holdings?${query.toString()}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const wire = await response.json() as { ok?: boolean; revision?: number }
    return wire.ok === true && typeof wire.revision === 'number' ? wire.revision : null
  } catch {
    return null
  }
}

/**
 * FX 汇率快照（GET /fx?base=；rates[c] = 1 单位 c 折合多少 base）。
 * 桥缺席/失败 → null：聚合引擎降级为「一切不折算 + 未折算分区」。
 */
export async function fetchFx(base: HoldingsBaseCurrency): Promise<FxSnapshot | null> {
  try {
    const query = new URLSearchParams({ base })
    const wire = await getJson<{ ok: true; base: string; rates: Record<string, number>; asOf: number; stale: boolean }>(
      `/dshtrading/api/fx?${query.toString()}`,
    )
    return {
      base: (wire.base === 'CNY' || wire.base === 'HKD' ? wire.base : 'USD') as HoldingsBaseCurrency,
      rates: wire.rates ?? {},
      asOf: typeof wire.asOf === 'number' ? wire.asOf : 0,
      stale: wire.stale === true,
    }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* tradingBridge client 服务（issue #34 / P5）                              */
/* ------------------------------------------------------------------ */

/**
 * 中栏视图包（client-ui-strategies / client-ui-knowledge 及未来的第三方视图）
 * 对桥的唯一依赖面。收口为 cordis client 服务（provide 'tradingBridge'），
 * 原因有二：
 * 1. 插件间协作必须走服务 inject（一切皆插件裁决——client 插件间不得 import
 *    彼此内部模块）；
 * 2. SSE 单例与 fetch 封装留在 shell 内（本模块），多视图包共享同一条
 *    EventSource 连接——各包自开连接会随拆包数量线性堆积。
 *
 * 视图包不 import 本模块；未安装 shell 时 inject 回调不触发，视图静默不注册
 * （可选依赖语义）。
 */
export interface TradingBridgeService {
  fetchKlines: typeof fetchKlines
  fetchCustomStrategies: typeof fetchCustomStrategies
  saveCustomStrategy: typeof saveCustomStrategy
  deleteCustomStrategy: typeof deleteCustomStrategy
  resetStrategy: typeof resetStrategy
  fetchStrategyTombstones: typeof fetchStrategyTombstones
  fetchCustomScreeners: typeof fetchCustomScreeners
  saveCustomScreener: typeof saveCustomScreener
  deleteCustomScreener: typeof deleteCustomScreener
  resetScreener: typeof resetScreener
  fetchKnowledgeCards: typeof fetchKnowledgeCards
  importKnowledgeBundle: typeof importKnowledgeBundle
  fetchFundamentals: typeof fetchFundamentals
  fetchNews: typeof fetchNews
  fetchFlash: typeof fetchFlash
  fetchSymbols: typeof fetchSymbols
  subscribeTradingEvents: typeof subscribeTradingEvents
}

/** 服务装配（shell apply 时以本模块函数 provide，零转发成本）。 */
export function createTradingBridgeService(): TradingBridgeService {
  return {
    fetchKlines,
    fetchCustomStrategies,
    saveCustomStrategy,
    deleteCustomStrategy,
    resetStrategy,
    fetchStrategyTombstones,
    fetchCustomScreeners,
    saveCustomScreener,
    deleteCustomScreener,
    resetScreener,
    fetchKnowledgeCards,
    importKnowledgeBundle,
    fetchFundamentals,
    fetchNews,
    fetchFlash,
    fetchSymbols,
    subscribeTradingEvents,
  }
}
