/**
 * OKX 公共行情适配器（P3 步骤 4：Binance → OKX 的第二家）。
 *
 * 与 Binance 的关键差异（也是它值得做的原因）：**OKX 的订阅是连上之后发订阅帧**，
 * 而 Binance 是写在 URL 里。两条路径都要有人走通，端口设计才算被验证过。
 *
 * 另一个更有价值的差异：OKX 的 %%tickers%% 频道**持续推送最新价**，而 Binance 的
 * aggTrade 只有成交没有基准。于是这里可以不用 REST 轮询就把"基准刷新"解决掉：
 * 同一连接订阅 %%trades%%（tick）+ %%tickers%%（快照），基准随行情自动刷新——这正是
 * "快照年龄预算必须 ≥ 刷新节奏"那条实测约束的正解。
 *
 * 用公共频道，不需要任何 API key，不涉及私有接口。
 *
 * @module @dshtrading/tractl/adapters/okx
 */
import type { FeedMessage } from '../ws-feed.ts'

/** 公共 WS 地址。 */
export const OKX_PUBLIC_WS = 'wss://ws.okx.com:8443/ws/v5/public'

/** 公共 REST 快照地址（tickers 频道不可用时的兜底）。 */
export const OKX_PUBLIC_REST = 'https://www.okx.com/api/v5/market/ticker'

/** OKX 的 instId 写法：BTC/USDT -> BTC-USDT。 */
export function okxInstrument(symbol: string): string {
  return symbol.replace('/', '-').toUpperCase()
}

/**
 * 订阅帧（**按标的**）：一个标的一帧，含 trades（tick）与 tickers（基准刷新）两个 arg。
 * 之所以按标的而不是一次性发全部：ws-feed 的 subscribePayload 就是逐标的调的，
 * 适配器顺着端口的形状走，比让端口为某一家交易所改形更划算。
 */
export function okxSubscribePayload(symbol: string): string {
  return JSON.stringify({ op: 'subscribe', args: [
    { channel: 'trades', instId: okxInstrument(symbol) },
    { channel: 'tickers', instId: okxInstrument(symbol) },
  ] })
}

/** 心跳：OKX 要求文本 ping（服务端回 pong），否则连接会被断开。 */
export const OKX_PING = 'ping'

/**
 * 把一帧 OKX 文本映射成 FeedMessage。
 * trades ⇒ tick（seq 用 tradeId 的数值部分）；tickers ⇒ snapshot（持续刷新基准）。
 * 事件/错误帧与不认识的频道返回 undefined（由上层计数，不打断流）。
 * @param text - 原始帧。
 * @param epoch - 连接世代号。
 */
export function parseOkxFrame(text: string, epoch: number): FeedMessage | 'ignored' | undefined {
  if (text === 'pong') return 'ignored'
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const frame = parsed as { event?: unknown; arg?: { channel?: unknown; instId?: unknown }; data?: unknown }
  // 订阅/退订确认是事件帧：认识它，但无需处理
  if (typeof frame.event === 'string') return 'ignored'
  const channel = frame.arg?.channel
  const instId = frame.arg?.instId
  if (typeof channel !== 'string' || typeof instId !== 'string' || !Array.isArray(frame.data)) return undefined
  const symbol = instId.replace('-', '/')
  const first = frame.data[0]
  if (first === null || typeof first !== 'object') return undefined
  const row = first as Record<string, unknown>
  if (channel === 'trades') {
    const price = Number(row.px)
    const atMs = Number(row.ts)
    const tradeId = String(row.tradeId ?? '')
    if (!Number.isFinite(price) || !Number.isFinite(atMs)) return undefined
    const seq = Number(tradeId.replace(/[^0-9]/g, '').slice(-9)) || 0
    return { kind: 'tick', epoch, symbol, price, atMs, seq }
  }
  if (channel === 'tickers') {
    const price = Number(row.last)
    const atMs = Number(row.ts)
    if (!Number.isFinite(price) || !Number.isFinite(atMs)) return undefined
    return { kind: 'snapshot', epoch, symbol, price, atMs }
  }
  return undefined
}

/**
 * REST 兜底快照（tickers 频道不推时用）。拿不到返回 undefined，不抛。
 * @param symbol - BTC/USDT 形态。
 * @param epoch - 连接世代号。
 * @param fetchImpl - 注入的 fetch。
 * @param nowMs - 注入时钟。
 */
export async function fetchOkxSnapshot(
  symbol: string,
  epoch: number,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<FeedMessage | undefined> {
  try {
    const response = await fetchImpl(OKX_PUBLIC_REST + '?instId=' + okxInstrument(symbol))
    if (!response.ok) return undefined
    const body = (await response.json()) as { data?: { last?: unknown }[] }
    const price = Number(body.data?.[0]?.last)
    if (!Number.isFinite(price)) return undefined
    return { kind: 'snapshot', epoch, symbol, price, atMs: nowMs }
  } catch {
    return undefined
  }
}
