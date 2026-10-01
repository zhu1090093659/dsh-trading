/**
 * shadow 真实行情跑批（P3 步骤 5：把首批报告的行情来源从合成换成真实）。
 *
 * 链路：Binance aggTrade 真推流 → 传输层 → 对齐状态机（epoch/缓冲/发布）→ shadow 装置
 * 决策（零 venue 写）→ 逐张卡 rebuildDecision 校验。
 * 行情来源是**公共流**（无凭据）；本脚本不下任何单。
 *
 * 跑法：node packages/tradectl/drill/shadow-live.ts [秒数]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAlignment,
  createShadowDesk,
  createStreamingFeed,
  openLedgers,
  rebuildDecision,
  type AlignmentParams,
  type FeedMessage,
} from '../lib/index.js'
import { binanceStreamUrl, fetchBinanceSnapshot, parseBinanceFrame } from '../lib/adapters/binance.js'
import { createNodeWebSocketTransport } from '../lib/transport/node-ws.js'

const seconds = Number(process.argv[2] ?? '45')
const params: AlignmentParams = {
  snapshotAgeBudgetMs: 12_000,
  bufferMaxTicks: 4096,
  bufferMaxBytes: 4096 * 128,
  realignTokenCapacity: 8,
  realignRefillPerSec: 1,
  divergenceBps: 50,
  divergenceStrikes: 2,
  orderTokenCapacity: 8,
  orderRefillPerSec: 1,
}

const dir = mkdtempSync(join(tmpdir(), 'shadow-live-'))
const ledgers = openLedgers(dir)
const T0 = Date.now()
let tick = T0
const now = () => (tick += 1)
const alignment = createAlignment(params, T0)

/** 组合 sink：转给对齐层，同时记住**已发布**的最新 tick（决策只能用发布过的价格）。 */
let lastPublished: FeedMessage | undefined
const sink = {
  onSnapshot: (snapshot: { epoch: number; symbol: string; price: number; atMs: number }, atMs: number) => alignment.onSnapshot(snapshot, atMs),
  onTick: (input: { epoch: number; symbol: string; price: number; atMs: number; seq: number }, atMs: number) => {
    const outcome = alignment.onTick(input, atMs as number) as { published: readonly { symbol: string; price: number; atMs: number }[] }
    for (const published of outcome.published) {
      if (published.symbol === 'BTC/USDT') lastPublished = { kind: 'tick', epoch: input.epoch, symbol: published.symbol, price: published.price, atMs: published.atMs }
    }
    return outcome
  },
  state: (atMs: number) => alignment.state(atMs),
}

const limits = { notionalMax: 10_000, positionNotionalMax: 50_000, deskNotionalMax: 200_000, maxOpenOrders: 20, leverageMax: 3 }
const desk = createShadowDesk({ db: ledgers.audit, now, limits, priceAgeBudgetMs: params.snapshotAgeBudgetMs })

const url = binanceStreamUrl(['BTC/USDT'], 'aggTrade')
const feed = createStreamingFeed({
  transport: createNodeWebSocketTransport(),
  scheduler: { schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  } },
  sink,
  now: () => Date.now(),
  url,
  symbols: [],
  bootstrapSymbols: ['BTC/USDT'],
  bootstrap: async (symbols) => {
    const snapshots = await Promise.all(symbols.map((symbol) => fetchBinanceSnapshot(symbol, 1)))
    return snapshots.filter((snapshot) => snapshot !== undefined)
  },
  subscribePayload: () => '',
  decode: (text, epoch) => parseBinanceFrame(text, epoch),
  heartbeatTimeoutMs: 30_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 8_000,
  subscribeTokenCapacity: 5,
  subscribeRefillPerSec: 0.5,
})

// 基准周期刷新（年龄预算 12s ⇒ 5s 刷新）
const refresh = setInterval(() => {
  void fetchBinanceSnapshot('BTC/USDT', 1).then((snapshot) => {
    if (snapshot !== undefined) feed.deliverSnapshot(snapshot)
  })
}, 5_000)

process.stdout.write('connecting: ' + url + String.fromCharCode(10))
feed.start()

let referencePrice: number | undefined
let decisions = 0
let opened = 0
let rebuildable = 0
let reproduced = 0
const samplePrices: number[] = []

const decide = setInterval(() => {
  const atMs = Date.now()
  const state = alignment.state(atMs)
  const price = lastPublished?.price
  if (price === undefined || state.alignment !== 'aligned') return
  samplePrices.push(price)
  decisions += 1
  const movePct = referencePrice === undefined ? 0 : Math.abs(price - referencePrice) / referencePrice
  const thesis = referencePrice === undefined
    ? 'first decision on real data: establishing the reference price'
    : 'real-data move ' + (movePct * 100).toFixed(3) + '% since the last reference'
  const action = movePct > 0.0005 && referencePrice !== undefined
    ? { kind: 'open' as const, symbol: 'BTC/USDT', quantity: 0.0001, notional: price * 0.0001 }
    : { kind: 'hold' as const, symbol: 'BTC/USDT', quantity: 0, notional: 0 }
  const card = desk.decide({
    trigger: 'live-tick:' + String(decisions),
    thesis,
    action,
    provenance: {
      price,
      priceAgeMs: 0,
      positionSnapshotSeq: decisions,
      mandateVersion: 3,
      mandateHash: 'h-live-run',
      epoch: state.epoch,
      alignment: state.alignment,
      level: 'normal',
    },
    risk: { level: 'normal', levelSinceMs: atMs, haltFromOutOfBand: false, symbols: {} },
    limits: { limits, positionNotional: 0, deskNotional: 0, openOrders: 0, leverage: 1 },
  })
  if (action.kind === 'open') {
    opened += 1
    referencePrice = price
  }
  const rebuilt = rebuildDecision(card.card, { limits, positionNotional: 0, deskNotional: 0, openOrders: 0, leverage: 1 }, params.snapshotAgeBudgetMs)
  if (rebuilt.rebuildable) rebuildable += 1
  if (rebuilt.reproduced) reproduced += 1
}, 5_000)

setTimeout(() => {
  clearInterval(refresh)
  clearInterval(decide)
  const stats = feed.stats()
  const state = alignment.state(Date.now())
  process.stdout.write(String.fromCharCode(10) + '=== shadow 真实行情跑批（' + String(seconds) + 's）===' + String.fromCharCode(10))
  process.stdout.write('行情：Binance aggTrade（公共流）· 传输：' + JSON.stringify(stats) + String.fromCharCode(10))
  process.stdout.write('对齐态：' + JSON.stringify(state) + String.fromCharCode(10))
  process.stdout.write('价格样本（已发布 tick 的决策时点价，最多 10 个）：' + JSON.stringify(samplePrices.slice(0, 10)) + String.fromCharCode(10))
  process.stdout.write('决策 ' + String(decisions) + ' 次（open ' + String(opened) + '）；可重建 ' + String(rebuildable) + '/' + String(decisions) + '；结论一致 ' + String(reproduced) + '/' + String(decisions) + String.fromCharCode(10))
  process.stdout.write('状态叙述：' + desk.narrative(Date.now()) + String.fromCharCode(10))
  feed.stop()
  ledgers.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}, seconds * 1_000)
