/**
 * Binance 公共行情适配器（P3 步骤 4 的最后一层薄适配）。
 *
 * 只做三件事：拼 URL、把 Binance 帧映射成 FeedMessage、声明"订阅在 URL 里"。
 * 策略（心跳/重连/限频/坏帧）全部在 ws-feed.ts —— 三家交易所共用同一套策略是本模块
 * 存在的理由：各写一份必然出现三份行为不一致的实现。
 *
 * **用的是公共市场流**（不需要 API key、不涉及任何私有接口），所以它可以在没有任何
 * 交易凭据的环境里跑通——这也是为什么先做它。
 *
 * 一处**端口设计上的实证发现**：Binance 的订阅写在 URL 路径里（/ws/btcusdt@aggTrade），
 * 不发 subscribe 帧；而 OKX/Bybit 是连上后发订阅帧。所以 ws-feed 的 subscribePayload
 * 必须允许"不需要发帧"的形态（返回空串即不发），URL 由适配器负责——本轮不动端口，
 * 用 symbols: [] + URL 携带流名实现。
 *
 * @module @dshtrading/tractl/adapters/binance
 */
import type { FeedMessage } from '../ws-feed.ts'

/** 公共现货流地址（combined 形态：一个连接多个流）。 */
export const BINANCE_PUBLIC_WS = 'wss://stream.binance.com:9443/stream'

/**
 * 内部符号 <-> 交易所符号的**唯一转换点**。
 * 真实跑批暴露的坑：交易所帧给 BTCUSDT、REST 快照按 BTC/USDT 查，两种写法在同一条链路里
 * 会导致"按标的"的状态（对齐、乱序、决策）各认各的 —— 所以出口一律归一。
 */
export function binanceSymbolToInternal(exchangeSymbol: string): string {
  return exchangeSymbol.replace(/^([A-Z0-9]+?)(USDT|USDC|FDUSD|BTC|ETH|BNB)$/, "$1/$2")
}

/** Binance 的交易对写法：BTC/USDT -> btcusdt。 */
export function binanceSymbol(symbol: string): string {
  return symbol.replace('/', '').toLowerCase()
}

/** 拼 combined 流 URL（流名进 URL，不发订阅帧——见模块头注）。 */
export function binanceStreamUrl(symbols: readonly string[], kind: 'aggTrade' | 'kline_1m' = 'aggTrade'): string {
  const streams = symbols.map((symbol) => binanceSymbol(symbol) + '@' + kind).join('/')
  return BINANCE_PUBLIC_WS + '?streams=' + streams
}

/**
 * 把一帧 Binance 文本映射成 FeedMessage；不认识/解析失败返回 undefined（坏帧交给上层计数）。
 * 支持的形态：combined 包裹（{stream,data}）、aggTrade、trade、kline（用收盘价）。
 * @param text - 原始帧。
 * @param epoch - 本次连接/世代的编号（由传输层给，Binance 自己不提供世代号）。
 */
export function parseBinanceFrame(text: string, epoch: number): FeedMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const wrapper = parsed as Record<string, unknown>
  const payload = (wrapper.data !== undefined && typeof wrapper.data === 'object' ? wrapper.data : wrapper) as Record<string, unknown>
  const event = payload.e
  if (event === 'aggTrade' || event === 'trade') {
    const price = Number(payload.p)
    const atMs = Number(payload.T ?? payload.E)
    const symbol = binanceSymbolToInternal(String(payload.s ?? ''))
    const seq = Number(payload.a ?? payload.t ?? 0)
    if (!Number.isFinite(price) || !Number.isFinite(atMs) || symbol === '') return undefined
    return { kind: 'tick', epoch, symbol, price, atMs, seq }
  }
  if (event === 'kline') {
    const kline = payload.k
    if (kline === null || typeof kline !== 'object') return undefined
    const candle = kline as Record<string, unknown>
    const price = Number(candle.c)
    const atMs = Number(candle.T ?? payload.E)
    const symbol = binanceSymbolToInternal(String(candle.s ?? payload.s ?? ''))
    if (!Number.isFinite(price) || !Number.isFinite(atMs) || symbol === '') return undefined
    // K 线收盘（x === true）视为一次快照：它是"官方确认过的价格"，适合作为对齐基准。
    const closed = candle.x === true
    return closed
      ? { kind: 'snapshot', epoch, symbol, price, atMs }
      : { kind: 'tick', epoch, symbol, price, atMs, seq: Number(candle.t ?? 0) }
  }
  return undefined
}

/**
 * 把 Binance 帧解析器包成 ws-feed 期望的形状（带本次世代号）。
 * @param epoch - 连接世代号。
 */
export function binanceDecoder(epoch: number): (text: string) => FeedMessage | undefined {
  return (text) => parseBinanceFrame(text, epoch)
}

/** 公共 REST 快照地址（无需 API key）。 */
export const BINANCE_PUBLIC_REST = 'https://api.binance.com/api/v3/ticker/price'

/**
 * 拉一张基准快照：真实推流只有 tick、没有快照，而"先缓冲后发布"要求先有基准。
 * 返回 undefined 表示这一只没拿到（调用方决定是重试还是先裸奔 tick —— 本函数不抛）。
 * @param symbol - 交易对（BTC/USDT 形态）。
 * @param epoch - 当前连接世代（快照必须带世代号，否则对齐层无从判断新旧）。
 * @param fetchImpl - 注入的 fetch（测试用假件；生产用全局 fetch）。
 * @param nowMs - 注入时钟。
 */
export async function fetchBinanceSnapshot(
  symbol: string,
  epoch: number,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<FeedMessage | undefined> {
  try {
    const response = await fetchImpl(BINANCE_PUBLIC_REST + '?symbol=' + binanceSymbol(symbol).toUpperCase())
    if (!response.ok) return undefined
    const body = (await response.json()) as { price?: unknown }
    const price = Number(body.price)
    if (!Number.isFinite(price)) return undefined
    return { kind: 'snapshot', epoch, symbol, price, atMs: nowMs }
  } catch {
    // 快照拿不到不是致命错误：记录在调用方，流照常缓冲（有 tick 没基准好过什么都不要）
    return undefined
  }
}
