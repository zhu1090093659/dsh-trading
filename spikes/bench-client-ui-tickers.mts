/**
 * 用户可见路径性能基线：统一资产台账的批量盯市（holdings-store.refreshM2mPrices）。
 *
 * 测量卡（measure-first）：
 * | 字段 | 取值 |
 * |---|---|
 * | 用户操作 | 打开右侧「资产」面板（挂载即 tick，随后每 30s 一拍）；外部可观察完成条件 = prices 快照被写入 = 全部 ticker 分块响应返回 |
 * | 工作负载 | 4 个市场 × 22 个持仓标的（crypto/us/cn/hk），每市场 1 块（≤ TICKERS_CHUNK=32）；另测 100 标的 / 6 块的最坏块数 |
 * | 进入路径 | 生产函数 refreshM2mPrices(targetsKey) → fetchTickers(market, chunk) → HTTP；本基准只桩 fetch，chunk 处理成本用固定 per-request 延迟模拟 |
 * | 时钟 | 预热 1 轮丢弃；计时含分块与平移，不含模块加载；transport 被排除（固定延迟即服务端/传输成本，两侧相同） |
 * | 内存 | 端点为 prices 快照（可达）；本基准不做内存断言 |
 * | 判据 | 原始样本 + 中位数；负对照 = 分块并发度 ≥ 2 的断言（优化前必失败） |
 * | 行为 | 包级 holdings 相关用例；价格表键值与取数语义不变 |
 *
 * 运行：pnpm exec tsx spikes/bench-client-ui-tickers.mts
 */

const CHUNK_LATENCY_MS = 25

interface ChunkCall { market: string; symbols: string[]; at: number; settledAt: number }

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function targetsKeyFor(perMarket: number): string {
  const markets = ['crypto', 'us', 'cn', 'hk'] as const
  const keys: string[] = []
  for (const m of markets) {
    for (let i = 0; i < perMarket; i++) keys.push(`${m}:SYM${i}`)
  }
  return [...keys].sort().join(',')
}

/** 桩：记录每次块的进入/离开时间，用固定延迟模拟分块处理成本。 */
function installStub(calls: ChunkCall[]): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input), 'http://localhost')
    const market = url.searchParams.get('market') ?? ''
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean)
    const at = performance.now()
    await sleep(CHUNK_LATENCY_MS)
    const settledAt = performance.now()
    calls.push({ market, symbols, at, settledAt })
    const tickers: Record<string, unknown> = {}
    for (const s of symbols) tickers[s] = { ok: true, ticker: { symbol: s, price: 12 } }
    return jsonResponse({ tickers })
  }) as unknown as typeof globalThis.fetch
}

/** 峰值并发：同一时刻尚未返回的分块请求数上限。 */
function peakConcurrency(calls: ChunkCall[]): number {
  const events: Array<{ t: number; d: number }> = []
  for (const c of calls) { events.push({ t: c.at, d: 1 }); events.push({ t: c.settledAt, d: -1 }) }
  events.sort((a, b) => (a.t === b.t ? a.d - b.d : a.t - b.t))
  let cur = 0; let peak = 0
  for (const e of events) { cur += e.d; if (cur > peak) peak = cur }
  return peak
}

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }

async function main(): Promise<void> {
  const { refreshM2mPrices, holdingsDataStore } = await import('../packages/client-ui-trading/src/client/holdings-store.ts')

  // 预热：丢弃（首次调用含 vite 转译后的惰性初始化）
  {
    const warmCalls: ChunkCall[] = []
    installStub(warmCalls)
    await refreshM2mPrices(targetsKeyFor(1))
  }

  for (const perMarket of [22, 100]) {
    const ROUNDS = 7
    const times: number[] = []
    let rows: { calls: number; peak: number; keys: number } | undefined
    for (let r = 0; r < ROUNDS; r++) {
      const calls: ChunkCall[] = []
      installStub(calls)
      const t = performance.now()
      await refreshM2mPrices(targetsKeyFor(perMarket))
      const elapsed = performance.now() - t
      times.push(elapsed)
      const prices = holdingsDataStore.getSnapshot().prices
      rows = { calls: calls.length, peak: peakConcurrency(calls), keys: Object.keys(prices).length }
    }
    console.log(JSON.stringify({
      path: 'refreshM2mPrices', positionsPerMarket: perMarket, rounds: ROUNDS,
      chunkLatencyMs: CHUNK_LATENCY_MS,
      rawMs: times.map((x) => +x.toFixed(1)),
      medianMs: +median(times).toFixed(1),
      chunkRequests: rows?.calls, peakConcurrency: rows?.peak, priceKeys: rows?.keys,
      serialFloorMs: (rows?.calls ?? 0) * CHUNK_LATENCY_MS,
    }))
  }
}

await main()
