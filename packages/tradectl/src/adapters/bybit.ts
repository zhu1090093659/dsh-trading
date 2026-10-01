/**
 * Bybit 公共行情适配器（P3 步骤 4：Binance → OKX → Bybit 的第三家）。
 *
 * 第三家值得做的理由是**第三种帧形状**：
 *   - Binance：combined 包裹，data 是对象（e/s/p/T）；
 *   - OKX：%%arg.channel%% 决定语义，%%data%% 是**数组**；
 *   - Bybit：%%topic%% 决定语义，tickers 的 %%data%% 是**对象**、publicTrade 的是**数组**。
 * 三种形状都走通了，"解码钩子 + 逐标的订阅帧"这个端口设计才算真的被验证过。
 *
 * 订阅与保活都走 %%op%% 字段的 JSON 帧（%%{"op":"subscribe"}%% / %%{"op":"ping"}%%），
 * 与 OKX 的文本 ping 又不同。
 *
 * 用公共频道，不需要任何 API key。
 *
 * @module @dshtrading/tractl/adapters/bybit
 */
import type { FeedMessage } from '../ws-feed.ts'

/** 公共现货 WS 地址。 */
export const BYBIT_PUBLIC_WS = 'wss://stream.bybit.com/v5/public/spot'

/** 公共 REST 快照（兜底）。 */
export const BYBIT_PUBLIC_REST = 'https://api.bybit.com/v5/market/tickers'

/** Bybit 的 symbol 写法：BTC/USDT -> BTCUSDT。 */
export function bybitSymbol(symbol: string): string {
  return symbol.replace('/', '').toUpperCase()
}

/** 订阅帧（按标的）：成交 + 行情两个 topic。 */
export function bybitSubscribePayload(symbol: string): string {
  return JSON.stringify({ op: 'subscribe', args: ['publicTrade.' + bybitSymbol(symbol), 'tickers.' + bybitSymbol(symbol)] })
}

/** 保活帧（Bybit 要求 JSON ping，约 20s 一次）。 */
export const BYBIT_PING = JSON.stringify({ op: 'ping' })

/**
 * 把一帧 Bybit 文本映射成 FeedMessage。
 * publicTrade ⇒ tick（seq 取成交 id 的数字部分）；tickers ⇒ snapshot（持续刷新基准）。
 * 订阅确认（%%success%%）/ pong / 不认识的 topic 一律返回 undefined。
 * @param text - 原始帧。
 * @param epoch - 连接世代号。
 */
export function parseBybitFrame(text: string, epoch: number): FeedMessage | 'ignored' | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const frame = parsed as { topic?: unknown; ts?: unknown; data?: unknown; op?: unknown; success?: unknown }
  // 订阅确认（{success:true, op:'subscribe'}）与 pong 是事件帧
  if (typeof frame.op === 'string' || frame.success !== undefined) return 'ignored'
  const topic = frame.topic
  if (typeof topic !== 'string') return undefined
  const atMsDefault = Number(frame.ts)
  if (topic.startsWith('publicTrade.')) {
    const rows = Array.isArray(frame.data) ? frame.data : []
    const first = rows[0]
    if (first === null || typeof first !== 'object') return undefined
    const row = first as Record<string, unknown>
    const price = Number(row.p)
    const atMs = Number(row.T ?? atMsDefault)
    const symbol = String(row.s ?? '').replace(/^([A-Z]+)(USDT|USDC|BTC|ETH)$/, '$1/$2')
    if (!Number.isFinite(price) || !Number.isFinite(atMs) || symbol === '') return undefined
    const seq = Number(String(row.i ?? '').replace(/[^0-9]/g, '').slice(-9)) || 0
    return { kind: 'tick', epoch, symbol, price, atMs, seq }
  }
  if (topic.startsWith('tickers.')) {
    // 注意：Bybit 的 tickers data 是**对象**，不是数组——第三种形状。
    const row = (Array.isArray(frame.data) ? frame.data[0] : frame.data) as Record<string, unknown> | undefined
    if (row === undefined || row === null) return undefined
    const price = Number(row.lastPrice)
    const rawSymbol = String(row.symbol ?? '')
    const symbol = rawSymbol.replace(/^([A-Z]+)(USDT|USDC|BTC|ETH)$/, '$1/$2')
    if (!Number.isFinite(price) || symbol === '') return undefined
    return { kind: 'snapshot', epoch, symbol, price, atMs: Number.isFinite(atMsDefault) ? atMsDefault : Date.now() }
  }
  return undefined
}

/**
 * REST 兜底快照。拿不到返回 undefined，不抛。
 * @param symbol - BTC/USDT 形态。
 * @param epoch - 连接世代号。
 * @param fetchImpl - 注入的 fetch。
 * @param nowMs - 注入时钟。
 */
export async function fetchBybitSnapshot(
  symbol: string,
  epoch: number,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<FeedMessage | undefined> {
  try {
    const response = await fetchImpl(BYBIT_PUBLIC_REST + '?category=spot&symbol=' + bybitSymbol(symbol))
    if (!response.ok) return undefined
    const body = (await response.json()) as { result?: { list?: { lastPrice?: unknown }[] } }
    const price = Number(body.result?.list?.[0]?.lastPrice)
    if (!Number.isFinite(price)) return undefined
    return { kind: 'snapshot', epoch, symbol, price, atMs: nowMs }
  } catch {
    return undefined
  }
}
