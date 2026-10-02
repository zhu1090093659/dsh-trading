/**
 * OKX 公共行情冒烟：一条连接订阅 trades + tickers，跑 15 秒看是否进 aligned。
 * 不需要任何凭据；不下任何单。
 * 跑法：node packages/tradectl/drill/okx-smoke.ts
 * 参数：drill/alignment-params.ts 的**单一来源**（明确标注未标定，不变量 #23）。
 */
import { createAlignment, createStreamingFeed } from '../lib/index.js'
import { OKX_PUBLIC_WS, okxSubscribePayload, parseOkxFrame } from '../lib/adapters/okx.js'
import { createNodeWebSocketTransport } from '../lib/transport/node-ws.js'
import { DRILL_ALIGNMENT_PARAMS } from './alignment-params.ts'

const NL = String.fromCharCode(10)
const SYMBOLS = ['BTC/USDT', 'ETH/USDT']
const alignment = createAlignment(DRILL_ALIGNMENT_PARAMS, Date.now())
const feed = createStreamingFeed({
  transport: createNodeWebSocketTransport(),
  scheduler: { schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  } },
  sink: alignment,
  now: () => Date.now(),
  url: OKX_PUBLIC_WS,
  symbols: SYMBOLS,
  subscribePayload: (symbol) => okxSubscribePayload(symbol),
  decode: (text, epoch) => parseOkxFrame(text, epoch),
  heartbeatTimeoutMs: 25_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 8_000,
  subscribeTokenCapacity: 5,
  subscribeRefillPerSec: 0.5,
  onEvent: (event) => process.stdout.write('[feed] ' + event.kind + ': ' + event.detail + NL),
})

process.stdout.write('connecting: ' + OKX_PUBLIC_WS + NL)
feed.start()

setTimeout(() => {
  const stats = feed.stats()
  const atMs = Date.now()
  process.stdout.write(NL + '=== 15s OKX 冒烟结果 ===' + NL)
  process.stdout.write('统计: ' + JSON.stringify(stats) + NL)
  // 对齐态是**标的级**的：逐标的打印，不再有一个"全局对齐态"
  process.stdout.write('对齐态（逐标的）: ' + JSON.stringify(SYMBOLS.map((symbol) => alignment.state(atMs, symbol))) + NL)
  feed.stop()
  process.exit(0)
}, 15_000)
