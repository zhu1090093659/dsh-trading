/**
 * FX 汇率服务（对齐 docs/design/holdings-ledger.md §3-§4，Node.js 宿主端专用）。
 *
 * - 源：frankfurter.dev（ECB 汇率，免费无 key，个人用途），
 *   `GET /v1/latest?base=<base>&symbols=USD,CNY,HKD`；USDT 不入请求，
 *   恒定锚定 USD：`rates.USDT = rates.USD`。
 * - **语义翻转**：frankfurter 返回「1 base = X 单位 c」，契约 §3 改定
 *   `rates[c] = 1 单位 c 折合多少 base`——落库/出桥前取倒数
 *   （USD 基准示例：`{USD:1, USDT:1, CNY:0.14, HKD:0.128}`）。
 * - 缓存：宿主内存 1h + 文件缓存 ~/.dsh/holdings/fx-cache.json 兜底（重启可用）；
 *   失败链：内存（过期）→ 文件 → 恒等兜底，后两段 `stale:true`。
 * - fetch 超时 5s（AbortSignal.timeout）；base 限 USD/CNY/HKD，非法 base 抛
 *   FxInvalidBaseError（桥映射 HTTP 400）。
 */
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from './fs-atomic.ts'

export const FX_BASES = ['USD', 'CNY', 'HKD'] as const
export type FxBase = (typeof FX_BASES)[number]

/** 请求符号集（USDT 不入请求，恒定锚定 USD——契约 §4）。 */
const FX_SYMBOLS = ['USD', 'CNY', 'HKD'] as const

const FRANKFURTER_LATEST = 'https://api.frankfurter.dev/v1/latest'
/** 内存缓存 TTL：1h（契约 §4）。 */
const DEFAULT_TTL_MS = 60 * 60 * 1000
/** fetch 超时：5s（契约 §4）。 */
const DEFAULT_TIMEOUT_MS = 5000

const LOG_TAG = '[dsh-trading/holdings/fx]'

/** 非法 base（契约 §4：桥映射 HTTP 400）。 */
export class FxInvalidBaseError extends Error {
  readonly code = 'TRADING_FX_INVALID_BASE'
  constructor(base: string) {
    super(`unsupported fx base ${JSON.stringify(base)}（支持 ${FX_BASES.join('/')}）`)
    this.name = 'FxInvalidBaseError'
  }
}

/** REST GET /fx 的数据载荷形状（契约 §3）。 */
export interface FxQuote {
  readonly base: FxBase
  /** `rates[c]` = 1 单位 c 折合多少 base；恒含 `base:1`，USD 可解析时含 USDT（锚 USD）。 */
  readonly rates: Record<string, number>
  /** 汇率数据取得时间（ms epoch）；恒等兜底为 0（无真实数据哨兵）。 */
  readonly asOf: number
  /** true = 走了过期内存/文件缓存/恒等兜底（契约 §4 失败链后段）。 */
  readonly stale: boolean
}

export interface FxService {
  getRates(base: string): Promise<FxQuote>
}

/** fetch 的最小结构面（测试注入 mock，生产用 Node 18+ 全局 fetch）。 */
export type FxFetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export interface FxServiceOptions {
  /** 文件缓存路径（缺省 = 无文件层，仅内存缓存——纯浏览器/测试面可用）。 */
  cacheFilePath?: string
  /** 内存缓存 TTL ms（缺省 1h）。 */
  ttlMs?: number
  /** fetch 超时 ms（缺省 5000）。 */
  timeoutMs?: number
  /** 注入 fetch（测试 mock；缺省全局 fetch）。 */
  fetchImpl?: FxFetchLike
  /** 注入时钟（测试用；缺省 Date.now()）。 */
  now?: () => number
}

interface FxCacheEntry {
  rates: Record<string, number>
  asOf: number
}

/** fx-cache.json 文件形状：`{ version:1, entries: { USD: { rates, asOf }, ... } }`。 */
interface FxCacheFile {
  version: 1
  entries: Partial<Record<FxBase, FxCacheEntry>>
}

interface FrankfurterLatest {
  base?: string
  date?: string
  rates?: Record<string, unknown>
}

export function createFxService(options: FxServiceOptions = {}): FxService {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl: FxFetchLike = options.fetchImpl ?? ((url, init) => fetch(url, { signal: init.signal }))
  const now = options.now ?? (() => Date.now())
  const memory = new Map<FxBase, FxCacheEntry>()

  async function fetchFresh(base: FxBase): Promise<FxCacheEntry> {
    const url = `${FRANKFURTER_LATEST}?base=${base}&symbols=${FX_SYMBOLS.join(',')}`
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`frankfurter responded HTTP ${res.status}`)
    const data = (await res.json()) as FrankfurterLatest
    const raw = data?.rates ?? {}
    const out: Record<string, number> = {}
    for (const c of FX_SYMBOLS) {
      if (c === base) continue
      const v = raw[c]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        out[c] = 1 / v
      }
    }
    out[base] = 1
    // USDT 恒定锚定 USD（契约 §4）；base=USD 时 USD≡1，USDT 随之=1。
    if (out.USD !== undefined) out.USDT = out.USD
    return { rates: out, asOf: now() }
  }

  async function readFileCache(base: FxBase): Promise<FxCacheEntry | undefined> {
    if (options.cacheFilePath === undefined) return undefined
    try {
      const parsed = JSON.parse(await readFile(options.cacheFilePath, 'utf8')) as Partial<FxCacheFile> | null
      const entry = parsed?.entries?.[base]
      if (entry && typeof entry.asOf === 'number' && entry.rates && typeof entry.rates === 'object') {
        return { rates: { ...entry.rates }, asOf: entry.asOf }
      }
    } catch {
      // 缓存缺失/损坏静默，走下一级兜底。
    }
    return undefined
  }

  async function writeFileCache(base: FxBase, entry: FxCacheEntry): Promise<void> {
    const cacheFilePath = options.cacheFilePath
    if (cacheFilePath === undefined) return
    try {
      let file: FxCacheFile = { version: 1, entries: {} }
      try {
        const parsed = JSON.parse(await readFile(cacheFilePath, 'utf8')) as Partial<FxCacheFile> | null
        if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
          file = { version: 1, entries: { ...parsed.entries } }
        }
      } catch {
        // 首写/损坏：覆盖重建。
      }
      file.entries[base] = entry
      await writeJsonAtomic(cacheFilePath, file, LOG_TAG)
    } catch {
      // 缓存落盘失败不致命：内存层已就位，文件层只是重启兜底。
    }
  }

  return {
    async getRates(baseInput: string): Promise<FxQuote> {
      const normalized = baseInput.trim().toUpperCase()
      if (!(FX_BASES as readonly string[]).includes(normalized)) {
        throw new FxInvalidBaseError(baseInput)
      }
      const base = normalized as FxBase

      // 第一层：内存缓存（TTL 内直接命中，stale:false）。
      const mem = memory.get(base)
      if (mem && now() - mem.asOf < ttlMs) {
        return { base, rates: { ...mem.rates }, asOf: mem.asOf, stale: false }
      }

      try {
        const fresh = await fetchFresh(base)
        memory.set(base, fresh)
        await writeFileCache(base, fresh)
        return { base, rates: { ...fresh.rates }, asOf: fresh.asOf, stale: false }
      } catch {
        // 失败链（契约 §4）：过期内存 → 文件缓存 → 恒等兜底，皆 stale:true。
        if (mem) {
          return { base, rates: { ...mem.rates }, asOf: mem.asOf, stale: true }
        }
        const file = await readFileCache(base)
        if (file) {
          memory.set(base, file)
          return { base, rates: { ...file.rates }, asOf: file.asOf, stale: true }
        }
        // 恒等兜底：rates 只含 {base:1, USDT≈USD}——非 USD 基准时 USDT/USD
        // 无数据不编造（契约 §3）。
        const identity: Record<string, number> = { [base]: 1 }
        if (base === 'USD') identity.USDT = 1
        return { base, rates: identity, asOf: 0, stale: true }
      }
    },
  }
}
