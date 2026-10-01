/**
 * OKX 公共行情冒烟：一条连接订阅 trades + tickers，跑 15 秒看是否进 aligned。
 * 不需要任何凭据；不下任何单。
 * 跑法：node packages/tradectl/drill/okx-smoke.ts
 */
import { createAlignment, createStreamingFeed, type AlignmentParams } from '../lib/index.js'
import { OKX_PUBLIC_WS, okxSubscribePayload, parseOkxFrame } from '../lib/adapters/okx.js'
import { createNodeWebSocketTransport } from '../lib/transport/node-ws.js'

const params: AlignmentParams = {
  snapshotAgeBudgetMs: 15_000,
  bufferMaxTicks: 2048,
  bufferMaxBytes: 2048 * 128,
  realignTokenCapacity: 8,
  realignRefillPerSec: 1,
  divergenceBps: 50,
  divergenceStrikes: 2,
  orderTokenCapacity: 8,
  orderRefillPerSec: 1,
}

const alignment = createAlignment(params, Date.now())
const feed = createStreamingFeed({
  transport: createNodeWebSocketTransport(),
  scheduler: { schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  } },
  sink: alignment,
  now: () => Date.now(),
  url: OKX_PUBLIC_WS,
  symbols: ['BTC/USDT', 'ETH/USDT'],
  subscribePayload: (symbol) => okxSubscribePayload(symbol),
  decode: (text, epoch) => parseOkxFrame(text, epoch),
  heartbeatTimeoutMs: 25_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 8_000,
  subscribeTokenCapacity: 5,
  subscribeRefillPerSec: 0.5,
  onEvent: (event) => process.stdout.write('[feed] ' + event.kind + ': ' + event.detail + String.fromCharCode(10)),
})

process.stdout.write('connecting: ' + OKX_PUBLIC_WS + String.fromCharCode(10))
feed.start()

setTimeout(() => {
  const stats = feed.stats()
  process.stdout.write(String.fromCharCode(10) + '=== 15s OKX 冒烟结果 ===' + String.fromCharCode(10))
  process.stdout.write('统计: ' + JSON.stringify(stats) + String.fromCharCode(10))
  process.stdout.write('对齐态: ' + JSON.stringify(alignment.state(Date.now())) + String.fromCharCode(10))
  feed.stop()
  process.exit(0)
}, 15_000)
