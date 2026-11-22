/**
 * @dshtrading/connector-akshare/etf-rescue-cache
 * 「ETF 托底」本地缓存：trading home 下 <home>/etf-rescue/，**增量**语义。
 *
 * 落盘位置经 @dshtrading/dsh-home 的 dshHomeDir() 解析（与全仓其它 home 数据同一入口），
 * 分文件存四类事实（口径见 packages/api 的 EtfRescueHistory）：
 *   shares/sse|szse/<日期>.json      ETF 份额（按交易所 + 日期；值是**份**）
 *   shares/szse-covered.json         深交所已取区间水位（避免「已确认无数据」的日期反复重取）
 *   nav/<ETF代码>.json               单位净值（按代码；键为交易日）
 *   index/<指数代码>.json            指数收盘（按代码；键为交易日）
 *   index-k.json                     指数 k 标定值（长缓存；失败时沿用上次值）
 *
 * 「已存在的日期不再重取」由调用方按缓存文件/水位判断，本模块只负责读写与形状校验。
 * 损坏或不认识的缓存一律当「没有」返回 undefined（重取比信坏值安全），但
 * **读不到 ≠ 0**：空 map 是「取过、确实没有」，undefined 是「没取过」。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomeDir, writeJsonAtomic } from '@dshtrading/dsh-home'

/** 缓存根目录名（相对 trading home）。 */
export const ETF_RESCUE_CACHE_DIR = 'etf-rescue'

/** writeJsonAtomic 的日志前缀（写失败由它打印并抛出）。 */
export const ETF_RESCUE_LOG_PREFIX = '[dsh-trading/connector-akshare/etf-rescue] failed to atomic flush to'

/** 份额交易所（两所披露形态完全不同：上交所 JSON 按日、深交所 xlsx 按区间）。 */
export type EtfShareExchange = 'sse' | 'szse'

/** 深交所已取区间记录（fetchedAt 是 ISO 时间，用于判断区间是否已「结清」）。 */
export interface SzseWindowRecord {
  readonly start: string
  readonly end: string
  readonly fetchedAt: string
}

/** 指数 k 标定条目：k = 流通市值(元) ÷ 点位。 */
export interface IndexCalibrationEntry {
  readonly k: number
  readonly close: number
  readonly calibratedAt: string
  readonly source: string
}

/** 净值缓存内容：日期→净值 + 已取到哪天。 */
export interface CachedNav {
  readonly dates: Record<string, number>
  readonly fetchedThrough: string
}

/** 收盘缓存内容：日期→收盘 + 已取到哪天。 */
export interface CachedCloses {
  readonly closes: Record<string, number>
  readonly fetchedThrough: string
}

export interface EtfRescueCacheOptions {
  /** 缓存根目录覆盖（测试注入临时目录用）。 */
  readonly rootDir?: string | undefined
  /** 环境变量映射（缺省 process.env；测试固定 home 用）。 */
  readonly env?: Record<string, string | undefined> | undefined
}

/** 默认缓存根：$DSH_HOME/etf-rescue。 */
export function etfRescueCacheDir(env: Record<string, string | undefined> = process.env): string {
  return join(dshHomeDir(env), ETF_RESCUE_CACHE_DIR)
}

/** 读 JSON；文件缺失/内容损坏 → undefined（当作没取过）。 */
async function readJsonFile(filePath: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** 未知值 → 只留有限数的 map（坏行丢弃）。 */
function numberMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof value !== 'object' || value === null) return out
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 限并发的批处理（写盘与取数共用；worker 池，结果与调度顺序无关）。 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const width = Math.max(1, Math.min(limit, items.length))
  let cursor = 0
  const workers = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const item = items[cursor] as T
      cursor += 1
      await run(item)
    }
  })
  await Promise.all(workers)
}

/**
 * 「ETF 托底」缓存句柄。
 *
 * 所有写入走 writeJsonAtomic（tmp+rename+fsync），两个宿主进程同时取数也不会读到
 * 半截文件；同一日期的文件并发写是幂等覆盖（内容由上游决定）。
 */
export class EtfRescueCache {
  private readonly rootDir: string

  constructor(options: EtfRescueCacheOptions = {}) {
    this.rootDir = options.rootDir ?? etfRescueCacheDir(options.env ?? process.env)
  }

  /** 缓存根目录（诊断与测试断言用）。 */
  get root(): string {
    return this.rootDir
  }

  private sharesPath(exchange: EtfShareExchange, date: string): string {
    return join(this.rootDir, 'shares', exchange, date + '.json')
  }

  /** 读某交易所某日的份额；文件不存在或形状不认识 → undefined（没取过）。 */
  async readShares(exchange: EtfShareExchange, date: string): Promise<Record<string, number> | undefined> {
    const raw = await readJsonFile(this.sharesPath(exchange, date))
    if (!isRecord(raw) || !isRecord(raw.shares)) return undefined
    return numberMap(raw.shares)
  }

  /** 写某交易所某日的份额（空 map 表示「取过、当日没有数据」，下次不再重取）。 */
  async writeShares(exchange: EtfShareExchange, date: string, shares: Record<string, number>): Promise<void> {
    await writeJsonAtomic(
      this.sharesPath(exchange, date),
      { exchange, date, shares },
      ETF_RESCUE_LOG_PREFIX,
    )
  }

  /** 深交所已取区间水位。 */
  async readSzseWindows(): Promise<readonly SzseWindowRecord[]> {
    const raw = await readJsonFile(join(this.rootDir, 'shares', 'szse-covered.json'))
    if (!isRecord(raw) || !Array.isArray(raw.windows)) return []
    const windows: SzseWindowRecord[] = []
    for (const entry of raw.windows) {
      if (!isRecord(entry)) continue
      const start = entry.start
      const end = entry.end
      const fetchedAt = entry.fetchedAt
      if (typeof start !== 'string' || typeof end !== 'string' || typeof fetchedAt !== 'string') continue
      windows.push({ start, end, fetchedAt })
    }
    return windows
  }

  /** 覆写深交所区间水位（调用方把新记录并入后整体写入）。 */
  async writeSzseWindows(windows: readonly SzseWindowRecord[]): Promise<void> {
    await writeJsonAtomic(
      join(this.rootDir, 'shares', 'szse-covered.json'),
      { windows },
      ETF_RESCUE_LOG_PREFIX,
    )
  }

  private navPath(code: string): string {
    return join(this.rootDir, 'nav', code + '.json')
  }

  /** 读某 ETF 的净值缓存；没有 → undefined。 */
  async readNav(code: string): Promise<CachedNav | undefined> {
    const raw = await readJsonFile(this.navPath(code))
    if (!isRecord(raw) || typeof raw.fetchedThrough !== 'string') return undefined
    return { dates: numberMap(raw.dates), fetchedThrough: raw.fetchedThrough }
  }

  /** 写某 ETF 的净值缓存（增量的合并由调用方完成）。 */
  async writeNav(code: string, payload: CachedNav): Promise<void> {
    await writeJsonAtomic(
      this.navPath(code),
      { code, fetchedThrough: payload.fetchedThrough, dates: payload.dates },
      ETF_RESCUE_LOG_PREFIX,
    )
  }

  private indexPath(indexCode: string): string {
    return join(this.rootDir, 'index', indexCode + '.json')
  }

  /** 读某指数收盘缓存；没有 → undefined。 */
  async readCloses(indexCode: string): Promise<CachedCloses | undefined> {
    const raw = await readJsonFile(this.indexPath(indexCode))
    if (!isRecord(raw) || typeof raw.fetchedThrough !== 'string') return undefined
    return { closes: numberMap(raw.closes), fetchedThrough: raw.fetchedThrough }
  }

  /** 写某指数收盘缓存。 */
  async writeCloses(indexCode: string, payload: CachedCloses): Promise<void> {
    await writeJsonAtomic(
      this.indexPath(indexCode),
      { indexCode, fetchedThrough: payload.fetchedThrough, closes: payload.closes },
      ETF_RESCUE_LOG_PREFIX,
    )
  }

  private calibrationsPath(): string {
    return join(this.rootDir, 'index-k.json')
  }

  /** 读全部指数 k 标定值；文件缺失/损坏 → 空表。 */
  async readCalibrations(): Promise<Record<string, IndexCalibrationEntry>> {
    const raw = await readJsonFile(this.calibrationsPath())
    if (!isRecord(raw) || !isRecord(raw.calibrations)) return {}
    const out: Record<string, IndexCalibrationEntry> = {}
    for (const [indexCode, entry] of Object.entries(raw.calibrations)) {
      if (!isRecord(entry)) continue
      const k = entry.k
      const close = entry.close
      const calibratedAt = entry.calibratedAt
      const source = entry.source
      if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) continue
      if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) continue
      if (typeof calibratedAt !== 'string' || typeof source !== 'string') continue
      out[indexCode] = { k, close, calibratedAt, source }
    }
    return out
  }

  /** 覆写全部指数 k 标定值（调用方合并后整体写入）。 */
  async writeCalibrations(calibrations: Record<string, IndexCalibrationEntry>): Promise<void> {
    await writeJsonAtomic(this.calibrationsPath(), { calibrations }, ETF_RESCUE_LOG_PREFIX)
  }
}
