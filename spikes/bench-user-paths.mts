/**
 * 用户可见路径性能基线（measure-first，/code-optimization High）。
 *
 * 测量两类成本：
 *  1. 上游往返放大（OKX 只读账户面）：冷缓存下 getPositions/listOpenOrders/listTradeFills
 *     对每个不同 instId 串行调用 /public/instruments。用固定 per-call 延迟模拟 RTT，
 *     统计串行往返次数与墙钟时间。
 *  2. 本地纯计算（知识检索/图谱、持仓聚合）：真实数据形态下的中位耗时。
 *
 * 运行：pnpm exec tsx spikes/bench-user-paths.mts
 */
import type { Context } from '@deepseek-ai/cordis'
import { OkxTradeService, type Config } from '../packages/connector-okx/src/index.ts'
import { OkxRestClient } from '../packages/connector-okx/src/rest.ts'
import { aggregateHoldings } from '../packages/client-ui-trading/src/client/holdings-aggregate.ts'
import type { TaggedPosition } from '../packages/client-ui-trading/src/client/holdings-types.ts'
import { createKnowledgeSearchTool } from '../packages/knowledge/src/tool.ts'
import { createMemoryKnowledgeCardStore } from '../packages/knowledge/src/store-memory.ts'
import { buildGraph, countGraphSummary } from '../packages/knowledge/src/graph.ts'
import type { KnowledgeCard } from '../packages/knowledge/src/types.ts'

const CALL_MS = 25
const ROUNDS = 5

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }
function okEnvelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: '0', data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
function makeCtx(): Context { return { get: () => undefined, reflect: { provide: () => {} } } as unknown as Context }
function baseConfig(): Config {
  return {
    enabled: true, env: 'demo', dryRun: true, liveTrading: false,
    apiKeyRef: 'OKX_API_KEY', secretRef: 'OKX_SECRET_KEY', passphraseRef: 'OKX_PASSPHRASE',
    demoApiKeyRef: 'OKX_DEMO_API_KEY', demoSecretRef: 'OKX_DEMO_SECRET_KEY', demoPassphraseRef: 'OKX_DEMO_PASSPHRASE',
  }
}
function instrumentFor(instId: string) {
  return { instId, instType: 'SWAP', lotSz: '0.01', minSz: '0.01', tickSz: '0.1', ctVal: '0.01', ctValCcy: 'BTC', settleCcy: 'USDT' }
}
function instId(i: number): string { return 'S' + String(i).padStart(2, '0') + '-USDT-SWAP' }

interface Counters { instrumentCalls: number; totalCalls: number }
function countingFetch(body: { positions?: unknown[]; pending?: unknown[]; fills?: unknown[] }, c: Counters): typeof fetch {
  return (async (input: unknown) => {
    c.totalCalls++
    const url = String(input)
    await sleep(CALL_MS)
    if (url.includes('/public/instruments')) {
      c.instrumentCalls++
      const id = new URL(url).searchParams.get('instId') ?? ''
      return okEnvelope([instrumentFor(id)])
    }
    if (url.includes('/account/positions')) return okEnvelope(body.positions ?? [])
    if (url.includes('/trade/orders-pending')) return okEnvelope(body.pending ?? [])
    if (url.includes('/trade/fills-history')) return okEnvelope(body.fills ?? [])
    throw new Error('unexpected request: ' + url)
  }) as unknown as typeof fetch
}
function makeService(fetchImpl: typeof fetch): OkxTradeService {
  return new OkxTradeService(makeCtx(), {
    client: new OkxRestClient({ baseUrl: 'https://okx.test', fetchImpl, clockSync: false, clockOffsetMs: 0 }),
    config: baseConfig(),
    getCredentials: async () => ({ key: 'k', secret: 's', passphrase: 'p' }),
  }, 'bench-trade')
}

function positionRow(i: number) {
  return { instId: instId(i), pos: '10', avgPx: '100', markPx: '110', upl: '1', lever: '5', uTime: '1700000000000' }
}
function pendingRow(i: number) {
  return { instId: instId(i), ordId: 'o' + i, side: 'buy', ordType: 'limit', px: '42000', sz: '2', accFillSz: '1', state: 'live', uTime: '1700000000000', cTime: '1700000000000' }
}
function fillRow(i: number) {
  return { instId: instId(i), billId: 'f' + i, fillPx: '42001', fillSz: '3', side: 'sell', fee: '-0.5', feeCcy: 'USDT', ts: '1700000000000' }
}

async function benchOkx(): Promise<void> {
  for (const n of [5, 20]) {
    for (const kind of ['getPositions', 'listOpenOrders', 'listTradeFills'] as const) {
      const times: number[] = []
      const calls: number[] = []
      for (let r = 0; r < ROUNDS; r++) {
        const c: Counters = { instrumentCalls: 0, totalCalls: 0 }
        const body = kind === 'getPositions'
          ? { positions: Array.from({ length: n }, (_, i) => positionRow(i)) }
          : kind === 'listOpenOrders'
            ? { pending: Array.from({ length: n }, (_, i) => pendingRow(i)) }
            : { fills: Array.from({ length: n }, (_, i) => fillRow(i)) }
        const svc = makeService(countingFetch(body, c))
        const t = performance.now()
        if (kind === 'getPositions') await svc.getPositions()
        else if (kind === 'listOpenOrders') await svc.listOpenOrders()
        else await svc.listTradeFills()
        times.push(performance.now() - t)
        calls.push(c.instrumentCalls)
      }
      console.log(JSON.stringify({ path: kind, distinctInstIds: n, simulatedRttMs: CALL_MS, medianMs: +median(times).toFixed(1), instrumentCalls: median(calls), totalUpstreamCalls: calls[0]! + 1 }))
    }
  }
}

function makeCard(i: number): KnowledgeCard {
  const tags = ['宏观', '行业', '公司', '策略', '风险', '估值', '美债', 'A股', '港股', '加密']
  const words = '本次分析聚焦于该主体在周期位置、估值水平、资金结构与风险边界上的可验证线索，并给出反方情景'
  return {
    id: 'kc_' + i, title: '主体分析 ' + i + '：' + tags[i % tags.length],
    summary: words.repeat(3),
    source: { type: 'wechat', url: 'https://mp.weixin.qq.com/s/' + i, author: '作者' + (i % 25), publishedAt: '2026-08-30' },
    credibility: 'high',
    coreClaims: [words.repeat(2), words.repeat(2)],
    factCheck: { verified: [], discrepancies: [], unverifiable: [] },
    takeaways: [words], boundaries: [words], tags: [tags[i % tags.length]!, tags[(i * 7 + 3) % tags.length]!], related: [],
    createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
  }
}
async function benchKnowledge(): Promise<void> {
  const cards = Array.from({ length: 300 }, (_, i) => makeCard(i))
  const store = createMemoryKnowledgeCardStore(cards)
  const search = createKnowledgeSearchTool(store)
  const run = async (args: Record<string, unknown>): Promise<number> => {
    const xs: number[] = []
    for (let r = 0; r < 30; r++) { const t = performance.now(); await search.execute(args); xs.push(performance.now() - t) }
    return +median(xs).toFixed(3)
  }
  console.log(JSON.stringify({ path: 'knowledge_search(query)', cards: cards.length, medianMs: await run({ query: '宏观', limit: 20 }) }))
  console.log(JSON.stringify({ path: 'knowledge_search(list-all)', cards: cards.length, medianMs: await run({ limit: 20 }) }))
  const g: number[] = []; const c: number[] = []
  for (let r = 0; r < 15; r++) { let t = performance.now(); buildGraph(cards); g.push(performance.now() - t); t = performance.now(); countGraphSummary(cards); c.push(performance.now() - t) }
  console.log(JSON.stringify({ path: 'knowledge graph build/count', cards: cards.length, buildMs: +median(g).toFixed(3), countMs: +median(c).toFixed(3) }))
}

function benchHoldings(): void {
  for (const n of [50, 300]) {
    const positions: TaggedPosition[] = Array.from({ length: n }, (_, i) => ({
      id: 'h' + i, market: (['us', 'cn', 'hk', 'crypto'] as const)[i % 4]!, symbol: 'SYM' + i,
      size: 100 + i, entryPrice: 10 + (i % 50), currency: 'USD', origin: 'live', account: 'acct-' + (i % 5),
    } as unknown as TaggedPosition))
    const prices: Record<string, number> = {}
    for (const p of positions) prices[p.market + ':' + p.symbol] = 12
    const xs: number[] = []
    for (let r = 0; r < 50; r++) { const t = performance.now(); aggregateHoldings(positions, prices, { base: 'USD', rates: { USD: 1, CNY: 7.2, HKD: 7.8 }, fetchedAt: new Date().toISOString(), stale: false } as never); xs.push(performance.now() - t) }
    console.log(JSON.stringify({ path: 'aggregateHoldings', positions: n, medianMs: +median(xs).toFixed(3) }))
  }
}

await benchOkx()
await benchKnowledge()
benchHoldings()
