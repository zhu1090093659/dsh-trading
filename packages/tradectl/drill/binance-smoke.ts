/**
 * 真实行情冒烟（P3 步骤 4）：连 Binance 公共流，跑 15 秒，打印统计与几条解码后的消息。
 * 跑法：node packages/tradectl/drill/binance-smoke.ts
 * 说明：公共市场流无需任何交易凭据；本脚本不下任何单。
 */
import { createAlignment, createStreamingFeed, type AlignmentParams } from '../lib/index.js'
import { binanceStreamUrl, fetchBinanceSnapshot, parseBinanceFrame } from '../lib/adapters/binance.js'
import { createNodeWebSocketTransport } from '../lib/transport/node-ws.js'

const params: AlignmentParams = {
  snapshotAgeBudgetMs: 10_000,
  bufferMaxTicks: 512,
  bufferMaxBytes: 512 * 128,
  realignTokenCapacity: 8,
  realignRefillPerSec: 1,
  divergenceBps: 50,
  divergenceStrikes: 2,
  orderTokenCapacity: 8,
  orderRefillPerSec: 1,
}

const T0 = Date.now()
const alignment = createAlignment(params, T0)
const url = binanceStreamUrl(['BTC/USDT', 'ETH/USDT'], 'aggTrade')
const feed = createStreamingFeed({
  transport: createNodeWebSocketTransport(),
  scheduler: { schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  } },
  sink: alignment,
  now: () => Date.now(),
  url,
  symbols: [],
  decode: (text, epoch) => parseBinanceFrame(text, epoch),
  bootstrapSymbols: ['BTC/USDT', 'ETH/USDT'],
  bootstrap: async (symbols) => {
    const snapshots = await Promise.all(symbols.map((symbol) => fetchBinanceSnapshot(symbol, 1)))
    return snapshots.filter((snapshot) => snapshot !== undefined)
  },
  subscribePayload: () => '',
  heartbeatTimeoutMs: 20_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 8_000,
  subscribeTokenCapacity: 5,
  subscribeRefillPerSec: 0.5,
  onEvent: (event) => process.stdout.write('[feed] ' + event.kind + ': ' + event.detail + String.fromCharCode(10)),
})

// 周期刷新基准快照：年龄预算 10s ⇒ 刷新节奏 5s（预算必须 ≥ 刷新节奏，否则永远 stale）
const refresh = setInterval(() => {
  void Promise.all(['BTC/USDT', 'ETH/USDT'].map((symbol) => fetchBinanceSnapshot(symbol, 1)))
    .then((snapshots) => {
      for (const snapshot of snapshots) {
        if (snapshot === undefined) continue
        feed.deliverSnapshot(snapshot)
      }
    })
}, 5_000)

process.stdout.write('connecting: ' + url + String.fromCharCode(10))
feed.start()
const samples: string[] = []
const rawTransport = createNodeWebSocketTransport()
// 另起一条连接只为抓原始帧样本（用于离线测试的真实样本）
const probe = new WebSocket(url)
probe.onmessage = (event) => {
  if (samples.length < 3) samples.push(String(event.data))
}

setTimeout(() => {
  const stats = feed.stats()
  process.stdout.write(String.fromCharCode(10) + '=== 15s 冒烟结果 ===' + String.fromCharCode(10))
  process.stdout.write('统计: ' + JSON.stringify(stats) + String.fromCharCode(10))
  process.stdout.write('对齐态: ' + JSON.stringify(alignment.state(Date.now())) + String.fromCharCode(10))
  process.stdout.write('原始帧样本（供离线测试用）:' + String.fromCharCode(10))
  for (const sample of samples) process.stdout.write('  ' + sample.slice(0, 220) + String.fromCharCode(10))
  clearInterval(refresh)
  feed.stop()
  probe.close()
  process.exit(0)
}, 15_000)
