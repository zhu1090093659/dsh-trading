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
    const symbol = String(payload.s ?? '')
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
    const symbol = String(candle.s ?? payload.s ?? '')
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
