/**
 * @dshtrading/connector-akshare/etf-rescue-service
 * 「ETF 托底」编排：现场采集 + 本地增量缓存 + 三源对齐出点。
 *
 * 取数顺序（每一步都先读缓存、只补缺口）：
 *   1. 七个指数日线收盘 → 同时得到交易日序列（腾讯一家覆盖 399006，见 source 头注）；
 *   2. 十四个 ETF 的单位净值（按代码增量，pageSize 上限 20 需翻页）；
 *   3. 两所 ETF 份额（沪按日、深按 ≤3 个月区间，均只取缓存里没有的交易日）；
 *   4. 七个指数的 k 标定值（长缓存，90 天刷新；标定失败沿用上次 k）；
 *   5. 纯函数 computeEtfRescuePoints 出点。
 *
 * 时间口径：交易所披露按上海墙钟；当日 16:00 前只认「昨天」为已结算上界，
 * 免得把盘中的半截收盘/未披露的份额写进序列（上界之前的日期一律视为已结清）。
 */

import type { EtfRescueHistory } from '@dshtrading/api'
// 错误词汇与连接器同源（与 kit 引用 connector-hithink 的 HiThinkRestClient 同款先例）：
// 「上游失败」必须是同一个可诊断的错误类型，桥与测试都按它分流。
import { TradingServiceError } from '@dshtrading/connector-akshare'
import {
  ETF_RESCUE_BASKET_CODES,
  ETF_RESCUE_INDEX_BASKETS,
  ETF_RESCUE_START_DATE,
  addDays,
  computeEtfRescuePoints,
  resolveEtfRescueTarget,
  tradingDateMs,
} from './etf-rescue.js'
import {
  EtfRescueCache,
  runBounded,
  type IndexCalibrationEntry,
  type SzseWindowRecord,
} from './etf-rescue-cache.js'
import { EtfRescueSource, type EtfRescueSourceOptions } from './etf-rescue-source.js'

/** k 标定的长缓存刷新周期（缺省 90 天）。 */
export const ETF_RESCUE_CALIBRATION_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** 份额取数并发（上交所按日一请求，900+ 个交易日要摊开取）。 */
const SHARE_CONCURRENCY = 4

/** 净值取数并发（每个 ETF 内部还要按 20 行/页翻页）。 */
const NAV_CONCURRENCY = 4

/** 缓存读并发（每次调用要读近两千个小文件）。 */
const CACHE_READ_CONCURRENCY = 16

/** 深交所区间窗口宽度（月）。实测 >6 个月被拒、5.7 个月 65536 行截断，取 3 个月稳。 */
const SZSE_WINDOW_MONTHS = 3

export interface EtfRescueServiceOptions extends EtfRescueSourceOptions {
  /** 缓存根目录覆盖（缺省 $DSH_HOME/etf-rescue）。 */
  readonly cacheDir?: string | undefined
  /** 环境变量映射（缺省 process.env；测试固定 home 用）。 */
  readonly env?: Record<string, string | undefined> | undefined
  /** k 标定刷新周期（缺省 90 天；测试用 0 强制重标定）。 */
  readonly calibrationTtlMs?: number | undefined
  /** 份额/净值取数并发覆盖。 */
  readonly shareConcurrency?: number | undefined
  readonly navConcurrency?: number | undefined
}

/** 上海墙钟日期（交易所披露用的日历日）。 */
export function shanghaiDate(instant: Date): string {
  return new Date(instant.getTime() + 8 * 3_600_000).toISOString().slice(0, 10)
}

/** 已结算上界：上海墙钟未到 16:00 时只认前一天（收盘与披露都还没出全）。 */
export function lastSettledDate(now: Date): string {
  const shanghai = new Date(now.getTime() + 8 * 3_600_000)
  const date = shanghai.toISOString().slice(0, 10)
  return shanghai.getUTCHours() >= 16 ? date : addDays(date, -1)
}

/** 月加减（窗口切分用；保留「日」，溢出月按目标月末截断）。 */
export function addMonths(date: string, months: number): string {
  const base = new Date(tradingDateMs(date))
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1))
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  const day = Math.min(base.getUTCDate(), daysInTarget)
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day)).toISOString().slice(0, 10)
}

interface SzseWindow {
  readonly start: string
  readonly end: string
  readonly dates: readonly string[]
}

/** 把缺失交易日切成 ≤SZSE_WINDOW_MONTHS 的连续窗口（区间端点 = 首个/末个缺失日）。 */
export function groupSzseWindows(dates: readonly string[]): SzseWindow[] {
  const sorted = [...dates].sort()
  const windows: SzseWindow[] = []
  let current: string[] = []
  for (const date of sorted) {
    const first = current[0]
    if (first !== undefined && date > addMonths(first, SZSE_WINDOW_MONTHS)) {
      windows.push({ start: first, end: current[current.length - 1] as string, dates: current })
      current = []
    }
    current.push(date)
  }
  const first = current[0]
  if (first !== undefined) windows.push({ start: first, end: current[current.length - 1] as string, dates: current })
  return windows
}

/** 已结清判定：取数发生在窗口末日的**下一个上海日历日**之后，该窗口的数据才算定版。 */
function windowSettled(record: SzseWindowRecord, end: string): boolean {
  const fetchedAt = new Date(record.fetchedAt)
  if (Number.isNaN(fetchedAt.getTime())) return false
  return shanghaiDate(fetchedAt) > end
}

/**
 * 「ETF 托底」服务：getEtfRescue 的唯一实现。
 *
 * 缓存与网络都可注入（测试用临时目录 + 契约化 fake fetch），生产用 trading home
 * 与全局 fetch。整条链路取不到时抛 TradingServiceError（TRADING_UPSTREAM_ERROR /
 * TRADING_NETWORK），由上层决定降级——绝不返回「全 0」的假序列。
 */
export class EtfRescueService {
  private readonly cache: EtfRescueCache
  private readonly source: EtfRescueSource
  private readonly now: () => Date
  private readonly calibrationTtlMs: number
  private readonly shareConcurrency: number
  private readonly navConcurrency: number

  constructor(options: EtfRescueServiceOptions = {}) {
    this.cache = new EtfRescueCache({
      ...(options.cacheDir === undefined ? {} : { rootDir: options.cacheDir }),
      ...(options.env === undefined ? {} : { env: options.env }),
    })
    this.source = new EtfRescueSource(options)
    this.now = options.now ?? (() => new Date())
    this.calibrationTtlMs = options.calibrationTtlMs ?? ETF_RESCUE_CALIBRATION_TTL_MS
    this.shareConcurrency = options.shareConcurrency ?? SHARE_CONCURRENCY
    this.navConcurrency = options.navConcurrency ?? NAV_CONCURRENCY
  }

  /** 缓存根目录（诊断用）。 */
  get cacheDir(): string {
    return this.cache.root
  }

  /**
   * 「ETF 托底」历史序列。
   *
   * 映射不到七个宽基指数的符号（如个股 600519.SH）返回空 points 且不触网——
   * 空 ≠ 0：消费方据此隐藏副图，而不是画零线。
   */
  async getEtfRescue(symbol: string): Promise<EtfRescueHistory> {
    const target = resolveEtfRescueTarget(symbol)
    if (target.basket === undefined) {
      return { symbol: target.symbol, indexCode: '', depthLabel: '', points: [] }
    }
    const settled = lastSettledDate(this.now())
    const closes = await this.loadCloses(settled)
    const tradingDays = this.tradingDays(closes, settled)
    if (tradingDays.length === 0) {
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        'etf-rescue: 七个宽基指数都没有 ' + ETF_RESCUE_START_DATE + ' 之后的收盘，无法确定交易日序列',
      )
    }
    const latestTradingDay = tradingDays[tradingDays.length - 1] as string
    const navs = await this.loadNavs(latestTradingDay)
    const shares = await this.loadShares(tradingDays)
    const ks = await this.loadKs()
    const points = computeEtfRescuePoints({
      targetIndexCode: target.basket.indexCode,
      sharesByCode: shares,
      navByCode: navs,
      closeByIndex: closes,
      kByIndex: ks,
      startDate: ETF_RESCUE_START_DATE,
      endDate: settled,
    })
    return {
      symbol: target.symbol,
      indexCode: target.basket.indexCode,
      depthLabel: target.basket.depthLabel,
      points,
    }
  }

  /** 全部指数的交易日并集（≥起点、≤已结算上界）。 */
  private tradingDays(closes: Record<string, Record<string, number>>, settled: string): string[] {
    const days = new Set<string>()
    for (const basket of ETF_RESCUE_INDEX_BASKETS) {
      for (const date of Object.keys(closes[basket.indexCode] ?? {})) {
        if (date >= ETF_RESCUE_START_DATE && date <= settled) days.add(date)
      }
    }
    return [...days].sort()
  }

  /** 指数收盘：按指数增量补齐到已结算上界（fetchedThrough 水位挡住重复请求）。 */
  private async loadCloses(settled: string): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {}
    for (const basket of ETF_RESCUE_INDEX_BASKETS) {
      const cached = await this.cache.readCloses(basket.indexCode)
      if (cached !== undefined && cached.fetchedThrough >= settled) {
        out[basket.indexCode] = cached.closes
        continue
      }
      const from = cached === undefined || cached.fetchedThrough === ''
        ? ETF_RESCUE_START_DATE
        : addDays(cached.fetchedThrough, 1)
      if (from > settled) {
        out[basket.indexCode] = cached?.closes ?? {}
        continue
      }
      const fetched = await this.source.fetchIndexCloses(basket.indexCode, from, settled)
      const merged: Record<string, number> = { ...(cached?.closes ?? {}), ...fetched }
      await this.cache.writeCloses(basket.indexCode, { closes: merged, fetchedThrough: settled })
      out[basket.indexCode] = merged
    }
    return out
  }

  /** 单位净值：按 ETF 代码增量补齐（每页 20 行翻页）。 */
  private async loadNavs(latestTradingDay: string): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {}
    await runBounded(ETF_RESCUE_BASKET_CODES, this.navConcurrency, async (code) => {
      const cached = await this.cache.readNav(code)
      if (cached !== undefined && cached.fetchedThrough >= latestTradingDay) {
        out[code] = cached.dates
        return
      }
      const from = cached === undefined || cached.fetchedThrough === ''
        ? ETF_RESCUE_START_DATE
        : addDays(cached.fetchedThrough, 1)
      if (from > latestTradingDay) {
        out[code] = cached?.dates ?? {}
        return
      }
      const fetched = await this.source.fetchFundNav(code, from)
      const merged: Record<string, number> = { ...(cached?.dates ?? {}), ...fetched }
      // 水位取「实际拿到的最新净值日」，不取请求终点：基金净值常 T+1 才披露，按请求
      // 终点记账会把「还没发布」永久记成「没有」，之后再也不回补。
      let fetchedThrough = cached?.fetchedThrough ?? ''
      for (const date of Object.keys(fetched)) {
        if (date > fetchedThrough) fetchedThrough = date
      }
      await this.cache.writeNav(code, { dates: merged, fetchedThrough })
      out[code] = merged
    })
    return out
  }

  /** 两所份额：只取缓存里没有的交易日；深交所按 ≤3 个月窗口取并记水位。 */
  private async loadShares(tradingDays: readonly string[]): Promise<Record<string, Record<string, number>>> {
    const sharesByCode: Record<string, Record<string, number>> = {}
    const put = (date: string, shares: Record<string, number>): void => {
      for (const [code, value] of Object.entries(shares)) {
        const series = sharesByCode[code] ?? {}
        series[date] = value
        sharesByCode[code] = series
      }
    }

    const sseMissing: string[] = []
    await runBounded(tradingDays, CACHE_READ_CONCURRENCY, async (date) => {
      const cached = await this.cache.readShares('sse', date)
      if (cached === undefined) sseMissing.push(date)
      else put(date, cached)
    })
    await runBounded(sseMissing, this.shareConcurrency, async (date) => {
      const shares = await this.source.fetchSseShares(date)
      await this.cache.writeShares('sse', date, shares)
      put(date, shares)
    })

    const szseMissing: string[] = []
    await runBounded(tradingDays, CACHE_READ_CONCURRENCY, async (date) => {
      const cached = await this.cache.readShares('szse', date)
      if (cached === undefined) szseMissing.push(date)
      else put(date, cached)
    })
    if (szseMissing.length > 0) {
      const covered = await this.cache.readSzseWindows()
      const added: SzseWindowRecord[] = []
      for (const window of groupSzseWindows(szseMissing)) {
        const coveredBefore = covered.some((record) =>
          record.start <= window.start && record.end >= window.end && windowSettled(record, window.end))
        if (coveredBefore) continue
        const fetched = await this.source.fetchSzseShares(window.start, window.end)
        const returned = Object.keys(fetched).sort()
        await runBounded(returned, this.shareConcurrency, async (date) => {
          const shares = fetched[date] as Record<string, number>
          await this.cache.writeShares('szse', date, shares)
          put(date, shares)
        })
        const fetchedAt = this.now().toISOString()
        // 只有「窗口末日的下一个上海日历日之后」取到的结果才敢记成定版：未结清的窗口
        // 不写空文件、也不记水位，下次调用会重新取一次（当日数据可能还没披露）。
        if (windowSettled({ start: window.start, end: window.end, fetchedAt }, window.end)) {
          const empties = window.dates.filter((date) => fetched[date] === undefined)
          await runBounded(empties, this.shareConcurrency, async (date) => {
            await this.cache.writeShares('szse', date, {})
          })
          added.push({ start: window.start, end: window.end, fetchedAt })
        }
      }
      if (added.length > 0) await this.cache.writeSzseWindows([...covered, ...added])
    }

    return sharesByCode
  }

  /** 全部指数的 k：缓存 90 天内直接用；过期则重标定，失败沿用上次 k，无旧值即抛错。 */
  private async loadKs(): Promise<Record<string, number>> {
    const cached = await this.cache.readCalibrations()
    const nowMs = this.now().getTime()
    const out: Record<string, number> = {}
    const next: Record<string, IndexCalibrationEntry> = { ...cached }
    let changed = false
    for (const basket of ETF_RESCUE_INDEX_BASKETS) {
      const entry = cached[basket.indexCode]
      if (entry !== undefined && nowMs - Date.parse(entry.calibratedAt) < this.calibrationTtlMs) {
        out[basket.indexCode] = entry.k
        continue
      }
      const calibrated = await this.source.calibrateIndex(basket.indexCode)
      if (calibrated !== undefined) {
        out[basket.indexCode] = calibrated.k
        next[basket.indexCode] = {
          k: calibrated.k,
          close: calibrated.close,
          calibratedAt: this.source.nowIso(),
          source: calibrated.source,
        }
        changed = true
        continue
      }
      if (entry !== undefined) {
        // 冻结口径：标定失败沿用上次 k（不重取、不补 0）。
        out[basket.indexCode] = entry.k
        continue
      }
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        'etf-rescue: 指数 ' + basket.indexCode + ' 的流通市值标定失败，且缓存里没有历史 k（' +
          this.cache.root + '/index-k.json）；恢复东财快照端点或先放入上次 k 再重试',
      )
    }
    if (changed) await this.cache.writeCalibrations(next)
    return out
  }
}
