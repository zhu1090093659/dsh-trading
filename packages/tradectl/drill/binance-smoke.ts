/**
 * 真实行情冒烟（P3 步骤 4）：连 Binance 公共流，跑 15 秒，打印统计与几条解码后的消息。
 * 跑法：node packages/tradectl/drill/binance-smoke.ts
 * 说明：公共市场流无需任何交易凭据；本脚本不下任何单。
 * 参数：drill/alignment-params.ts 的**单一来源**（明确标注未标定，不变量 #23）。
 */
import { createAlignment, createStreamingFeed } from '../lib/index.js'
import { binanceStreamUrl, fetchBinanceSnapshot, parseBinanceFrame } from '../lib/adapters/binance.js'
import { createNodeWebSocketTransport } from '../lib/transport/node-ws.js'
import { DRILL_ALIGNMENT_PARAMS, SNAPSHOT_REFRESH_MS } from './alignment-params.ts'

const NL = String.fromCharCode(10)
const SYMBOLS = ['BTC/USDT', 'ETH/USDT']
const T0 = Date.now()
const alignment = createAlignment(DRILL_ALIGNMENT_PARAMS, T0)
const url = binanceStreamUrl(SYMBOLS, 'aggTrade')
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
  bootstrapSymbols: SYMBOLS,
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
  onEvent: (event) => process.stdout.write('[feed] ' + event.kind + ': ' + event.detail + NL),
})

// 周期刷新基准快照：刷新节奏必须快于年龄预算（drill/alignment-params.ts 加载时断言这条自洽性）
const refresh = setInterval(() => {
  void Promise.all(SYMBOLS.map((symbol) => fetchBinanceSnapshot(symbol, 1)))
    .then((snapshots) => {
      for (const snapshot of snapshots) {
        if (snapshot === undefined) continue
        feed.deliverSnapshot(snapshot)
      }
    })
}, SNAPSHOT_REFRESH_MS)

process.stdout.write('connecting: ' + url + NL)
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
  const atMs = Date.now()
  process.stdout.write(NL + '=== 15s 冒烟结果 ===' + NL)
  process.stdout.write('统计: ' + JSON.stringify(stats) + NL)
  // 对齐态是**标的级**的：逐标的打印，不再有一个"全局对齐态"
  process.stdout.write('对齐态（逐标的）: ' + JSON.stringify(SYMBOLS.map((symbol) => alignment.state(atMs, symbol))) + NL)
  process.stdout.write('原始帧样本（供离线测试用）:' + NL)
  for (const sample of samples) process.stdout.write('  ' + sample.slice(0, 220) + NL)
  clearInterval(refresh)
  feed.stop()
  probe.close()
  process.exit(0)
}, 15_000)
