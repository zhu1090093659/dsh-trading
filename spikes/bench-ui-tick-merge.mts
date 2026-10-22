/**
 * 用户可见路径性能普查：终端每拍 ticker 快照推进图上 bar 序列。
 *
 * 路径本体是 9875f2ff 抽出的 packages/client-ui-trading/src/client/ticker-bar.ts
 * （withTickerBar / restoreFormingBar），此前无测量卡。本卡只做**确定性工作量**普查：
 * 不取墙钟毫秒作结论（机器饱和），不修改生产代码（本轮 owner 裁决）。
 *
 * 测量卡（口径同 spikes/bench-client-ui-tickers.mts）：
 * | 字段 | 取值 |
 * |---|---|
 * | 用户操作 | 终端开着，图上一条 K 线序列；行情不停手。外部可观察完成条件 = 该序列末根被快照价改写，或补出「当日未完成」日 K，且图表拿到新序列 |
 * | 工作负载 | 真实规模：自选 18 标的（crypto 2 / cn 7 / hk 2 / us 6 / futures 1），日 K 序列 n=750（DAILY_LIMIT）；对照：crypto 分钟级 n=300、五日级别 n≈1950；尾部 100 标的 |
 * | 进入路径 | 生产函数 withTickerBar / restoreFormingBar（ticker-bar.ts）← QuoteStage.tsx:653（ticker poll，5s）与 :443（bar resync，30s）。**不碰 transport**：快照与 bar 数组都是本地构造成入参；网络层不在这条路径内，且与拷贝量无关，故排除 |
 * | 时钟 | 非权威、本轮不作结论（CPU 约 12% idle、compressor 5.6GB）；只顺带打印 elapsed 作旁证，标注「待安静窗口复测」 |
 * | 内存 | 端点为 Kline[]；不测堆增量，只数「必须新建的 Kline 对象数 / 新数组槽位数 / 被拷贝的槽位数」——这三项与 GC 压力线性相关 |
 * | 判据 | 元素访问次数（入参数组包 Proxy，数数字索引 get/has trap）+ 原生 slice 拷贝槽位（patch Array.prototype.slice）+ 结构化拷贝量（引用身份，引擎无关）+ 每拍辅助调用次数（marketLocalDay / getMarketSessionStatus / dayAnchorMs）。负对照：同一「线性」断言施加于 O(1) 原地修改实现时必须失败 |
 * | 行为 | 包级 ticker-bar.test.ts 已覆盖三分支语义；本基准只测量、不改生产代码、不改语义 |
 *
 * 实测（权威计数；n=750 / cn 日线；命令与完整 stdout 见交付报告）：
 * - 同日合并 + 价格变化：751 次元素读、749 次原生 slice 拷贝、新数组 750 槽位、存活新对象 1、
 *   末根换新对象且前缀 749 根全部同引用（ticker-bar.ts:87-93）。真实槽位写入 = 2×749：
 *   slice 一次（已计数）+ spread 一次（同一 idiom 的第二段，在切出来的真实数组上由引擎完成）。
 * - 同日合并 + 价格在区间内：2 次元素读、0 拷贝、返回入参同引用（ticker-bar.ts:86）。
 * - 末根早于快照日 + 盘中：751 次元素读、追加 1 根、2 次 marketLocalDay + 1 次
 *   getMarketSessionStatus + 1 次 dayAnchorMs（ticker-bar.ts:116-121）；盘前/收市则同引用返回、
 *   0 次 dayAnchorMs（ticker-bar.ts:120）。
 * - crypto 与 5d 级别：0 次日期/时段/锚点调用（ticker-bar.ts:114-115）。
 * - resync 落地（restoreFormingBar）在上游缺当日时复制两遍：withTickerBar 追加一遍（751 次读 +
 *   750 槽位），继承时 slice 再来一遍（750 槽位），并且先造的成形 bar 被丢弃——每拍 2 个新
 *   Kline 只留 1 个（ticker-bar.ts:122-131 与 :182-191）；另加 5 次 marketLocalDay。
 *
 * 规模对照（每 30s = 6 拍合并 + 1 次 resync）：单序列 6×1498 + 1501 ≈ 1.05e4 槽位写入；
 * 自选 18 条同拍 ≈ 1.9e5；尾部 100 条 ≈ 1.0e6。但**生产今天只推进聚焦标的 1 条序列**
 * （QuoteStage.tsx:653 是唯一调用点），18/100 行是同一常数的外推。
 *
 * 可证伪的修复假设 H1（未实现）：把 withTickerBar 的「slice + spread」换成末根替换 / 结构共享，
 * 预期把每次合并的槽位写入从 2(n-1) 降到 0（元素读 751 → 2），18 条序列每 30s 从 1.6e5 降到 0。
 * 推翻条件：若下游确实靠数组身份变化触发（React setState 同引用短路、图表只在 setData 时刷新），
 * 原地替换会让「价格变了但序列同引用」= 图表停更，H1 即被推翻，正确方向改为「保身份变化但
 * 不复制前缀」（单点 update 交给图表 API）。
 *
 * 未测（必须有真浏览器才有意义）：渲染、绘制、输入延迟、React 提交耗时、图表 setData 耗时。
 *
 * 运行：pnpm exec tsx spikes/bench-ui-tick-merge.mts
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 真实生产函数（不是复制品）：三个都是 src/client 下的导出函数。
import { tickerBarMergeable } from '../packages/client-ui-trading/src/client/five-day-series.ts'
import { restoreFormingBar, withTickerBar, type TickerBarContext, type TickerSnapshot } from '../packages/client-ui-trading/src/client/ticker-bar.ts'
import type { Kline, Ticker } from '../packages/client-ui-trading/src/client/types.ts'

// ---------------------------------------------------------------------------
// 0. 规模常量：来自生产源码，带漂移守卫（源码改了这里就红，禁止悄悄过期）
// ---------------------------------------------------------------------------

const QUOTE_STAGE_PATH = fileURLToPath(new URL('../packages/client-ui-trading/src/client/QuoteStage.tsx', import.meta.url))
const FIVE_DAY_PATH = fileURLToPath(new URL('../packages/client-ui-trading/src/client/five-day-series.ts', import.meta.url))
const quoteStageSource = readFileSync(QUOTE_STAGE_PATH, 'utf8')
const fiveDaySource = readFileSync(FIVE_DAY_PATH, 'utf8')

/** 取数深度：日 K 与各级别分别取多少根（全部来自 QuoteStage.tsx）。 */
const DAILY_LIMIT = 750 // QuoteStage.tsx:103
const KLINE_LIMIT_CRYPTO = 300 // QuoteStage.tsx:100
const FIVE_DAY_BARS = 1950 // 五日级别图上 bar 数上界：us 5 交易日 1m ≈1950 根（five-day-series.ts:49-50 注释口径）
const TICKER_POLL_MS = 5000 // QuoteStage.tsx:83
const KLINE_RESYNC_MS = 30000 // QuoteStage.tsx:84

const FAILURES: string[] = []
function check(label: string, ok: boolean, detail: string): void {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + '  —  ' + detail)
  if (!ok) FAILURES.push(label)
}

console.log('## 0. 规模常量漂移守卫（源码字面量必须仍在）')
check('DAILY_LIMIT = 750', quoteStageSource.includes('const DAILY_LIMIT = 750'), 'QuoteStage.tsx:103')
check('KLINE_LIMIT_DEFAULT = 500', quoteStageSource.includes('const KLINE_LIMIT_DEFAULT = 500'), 'QuoteStage.tsx:99')
check('crypto: 300', quoteStageSource.includes('crypto: 300'), 'QuoteStage.tsx:100')
check('TICKER_POLL_MS = 5000', quoteStageSource.includes('const TICKER_POLL_MS = 5000'), 'QuoteStage.tsx:83')
check('KLINE_RESYNC_MS = 30000', quoteStageSource.includes('const KLINE_RESYNC_MS = 30000'), 'QuoteStage.tsx:84')
check('FIVE_DAY_KLINE_LIMIT = 2500', fiveDaySource.includes('export const FIVE_DAY_KLINE_LIMIT = 2500'), 'five-day-series.ts:46')

// ---------------------------------------------------------------------------
// 1. 确定性计数器
// ---------------------------------------------------------------------------

interface ArrayCounts {
  /** 数字索引 get trap 次数 = 被逐元素读取/拷贝的槽位数（Proxy 上界，见 §1 口径说明）。 */
  numericGets: number
  lengthGets: number
  /** 数字索引 HasProperty 次数（Array.prototype.slice 在 Proxy 上逐个先 has 再 get）。 */
  hasNumeric: number
  otherGets: number
}

function isIndexKey(key: string | symbol): boolean {
  if (typeof key !== 'string') return false
  const n = Number(key)
  return Number.isInteger(n) && n >= 0 && String(n) === key
}

/**
 * 把入参数组包成 Proxy：数「这一次调用实际读过多少元素」。
 *
 * 口径：Proxy 强制引擎走通用路径（真实 Array 上 slice/spread 是内联 memcpy，
 * JS 层看不到 get）。所以 numericGets 是**元素级访问次数的上界**，同时就是
 * 「必须被复制/读出的槽位数」——渐进量（O(n) 还是 O(1)）与真实数组一致。
 * 引擎侧的真实拷贝量另由 sliceSlots（patch Array.prototype.slice）与引用身份计数给出。
 */
function countingArray<T>(items: readonly T[]): { proxy: T[]; counts: ArrayCounts } {
  const counts: ArrayCounts = { numericGets: 0, lengthGets: 0, hasNumeric: 0, otherGets: 0 }
  const target = [...items]
  const proxy = new Proxy(target, {
    get(t, key, recv) {
      if (key === 'length') counts.lengthGets++
      else if (isIndexKey(key)) counts.numericGets++
      else counts.otherGets++
      return Reflect.get(t, key, recv)
    },
    has(t, key) {
      if (isIndexKey(key)) counts.hasNumeric++
      return Reflect.has(t, key)
    },
  })
  return { proxy, counts }
}

interface Structure {
  sameRef: boolean
  length: number
  /** 结果里与入参同位置同引用的元素个数（浅拷贝 ⇒ n-1）。 */
  sharedByPosition: number
  /** 结果里入参中不存在的对象数（存活的新建 Kline 对象数）。 */
  freshObjects: number
  lastChanged: boolean
}

/** 引擎无关的权威量：这次调用结构性地复制了多少槽位、留下了几个新对象。 */
function structureOf(prev: readonly Kline[], result: readonly Kline[], returnedSameRef: boolean): Structure {
  if (returnedSameRef) return { sameRef: true, length: prev.length, sharedByPosition: prev.length, freshObjects: 0, lastChanged: false }
  const known = new Set<unknown>(prev)
  let fresh = 0
  for (const row of result) if (!known.has(row)) fresh++
  const m = Math.min(prev.length, result.length)
  let shared = 0
  for (let i = 0; i < m; i++) if (prev[i] === result[i]) shared++
  return { sameRef: false, length: result.length, sharedByPosition: shared, freshObjects: fresh, lastChanged: result[result.length - 1] !== prev[prev.length - 1] }
}

interface AuxCounts {
  /** Intl.DateTimeFormat 构造次数（market-status.ts:55 每次调用都新建，无缓存）。 */
  dtfConstructed: number
  /** formatToParts 次数 = getMarketSessionStatus→getZonedTime 次数。 */
  formatToParts: number
  /** .format() 次数 = marketLocalDay 次数（market-time.ts:26-36 有 formatter 缓存）。 */
  formatCalls: number
  /** Date.UTC 次数 = dayAnchorMs 次数（ticker-bar.ts:77-80 是唯一调用点）。 */
  dateUtc: number
  /** Array.prototype.slice 调用次数与拷贝槽位数：Proxy 看不到引擎侧 memcpy 的那一段。 */
  sliceCalls: number
  sliceSlots: number
}

const aux: AuxCounts = { dtfConstructed: 0, formatToParts: 0, formatCalls: 0, dateUtc: 0, sliceCalls: 0, sliceSlots: 0 }
let auxInstalled = false

function installAuxCounters(): void {
  if (auxInstalled) return
  auxInstalled = true
  const RealDTF = Intl.DateTimeFormat
  const proto = RealDTF.prototype
  const realFormatGetter = Object.getOwnPropertyDescriptor(proto, 'format')!.get!
  const realFormatToParts = proto.formatToParts
  Object.defineProperty(proto, 'format', {
    configurable: true,
    get(this: Intl.DateTimeFormat) {
      const bound = realFormatGetter.call(this) as (d: number | Date) => string
      return function (this: unknown, value: number | Date): string {
        aux.formatCalls++
        return bound.call(this, value)
      }
    },
  })
  proto.formatToParts = function (this: Intl.DateTimeFormat, value: number | Date) {
    aux.formatToParts++
    return realFormatToParts.call(this, value)
  }
  const CountingDTF = function (this: unknown, ...args: unknown[]) {
    aux.dtfConstructed++
    return new (RealDTF as unknown as new (...a: unknown[]) => Intl.DateTimeFormat)(...args)
  } as unknown as typeof Intl.DateTimeFormat
  CountingDTF.prototype = proto
  Object.defineProperty(Intl, 'DateTimeFormat', { configurable: true, writable: true, value: CountingDTF })
  const realUtc = Date.UTC
  Date.UTC = function (...args: number[]): number {
    aux.dateUtc++
    return realUtc.apply(Date, args)
  } as typeof Date.UTC
  // 生产里 slice 只有两处（ticker-bar.ts:93 与 :191），都在合并/继承的拷贝路径上。
  const realSlice = Array.prototype.slice
  Array.prototype.slice = function (this: unknown[], start?: number, end?: number) {
    const out = realSlice.call(this, start, end)
    aux.sliceCalls++
    aux.sliceSlots += out.length
    return out
  } as typeof Array.prototype.slice
}

function auxSnapshot(): AuxCounts { return { ...aux } }
function auxDiff(a: AuxCounts, b: AuxCounts): AuxCounts {
  return {
    dtfConstructed: b.dtfConstructed - a.dtfConstructed,
    formatToParts: b.formatToParts - a.formatToParts,
    formatCalls: b.formatCalls - a.formatCalls,
    dateUtc: b.dateUtc - a.dateUtc,
    sliceCalls: b.sliceCalls - a.sliceCalls,
    sliceSlots: b.sliceSlots - a.sliceSlots,
  }
}

// ---------------------------------------------------------------------------
// 2. 夹具（本地构造的入参；不是算法复制）
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
/** 2026-10-21 10:00 Asia/Shanghai（周三，cn 盘中）。 */
const CN_INTRADAY_MS = Date.UTC(2026, 9, 21, 2, 0)
/** 2026-10-21 08:00 America/New_York（盘前，不在 TRADABLE_STATUS 白名单内）。 */
const US_PREMARKET_MS = Date.UTC(2026, 9, 21, 12, 0)
const DAY_2026_10_20 = Date.UTC(2026, 9, 20)
const DAY_2026_10_21 = Date.UTC(2026, 9, 21)

const CN_DAILY: TickerBarContext = { market: 'cn', interval: '1d' }
const US_DAILY: TickerBarContext = { market: 'us', interval: '1d' }
const CRYPTO_DAILY: TickerBarContext = { market: 'crypto', interval: '1d' }
const CN_FIVE_DAY: TickerBarContext = { market: 'cn', interval: '5d' }

/** 日 K 夹具：末根 openTime = lastDayUtc，往前每根退一天；收盘价统一 base，high/low 为 base±1。 */
function dailyBars(lastDayUtc: number, n: number, base = 100): Kline[] {
  const rows: Kline[] = []
  for (let i = 0; i < n; i++) {
    const openTime = lastDayUtc - (n - 1 - i) * DAY_MS
    rows.push({ openTime, open: base - 1, high: base + 1, low: base - 1, close: base, volume: 1000 + i, closeTime: openTime + DAY_MS - 1 })
  }
  return rows
}

/** 分钟级夹具：5m 一根，末根 close=base。 */
function intradayBars(n: number, base = 100, lastOpen = CN_INTRADAY_MS - 300_000): Kline[] {
  const rows: Kline[] = []
  for (let i = 0; i < n; i++) {
    const openTime = lastOpen - (n - 1 - i) * 300_000
    rows.push({ openTime, open: base - 1, high: base + 1, low: base - 1, close: base, volume: 1000 + i, closeTime: openTime + 299_999 })
  }
  return rows
}

function snap(price: number, timestamp: number, volume?: number): Ticker {
  return volume === undefined ? { symbol: '600519.SH', price, timestamp } : { symbol: '600519.SH', price, timestamp, volume }
}

interface Measured {
  name: string
  counts: ArrayCounts
  aux: AuxCounts
  structure: Structure
}

function measure(name: string, target: Kline[], invoke: (prev: Kline[]) => Kline[]): Measured {
  const { proxy, counts } = countingArray(target)
  const before = auxSnapshot()
  const result = invoke(proxy)
  const after = auxSnapshot()
  const sameRef = (result as unknown) === (proxy as unknown)
  return { name, counts: { ...counts }, aux: auxDiff(before, after), structure: structureOf(target, sameRef ? target : result, sameRef) }
}

function restoreMeasure(name: string, rows: Kline[], prev: Kline[], invoke: (rows: Kline[], prev: Kline[]) => Kline[]): Measured & { prevCounts: ArrayCounts } {
  const rowsCounted = countingArray(rows)
  const prevCounted = countingArray(prev)
  const before = auxSnapshot()
  const result = invoke(rowsCounted.proxy, prevCounted.proxy)
  const after = auxSnapshot()
  const sameRef = (result as unknown) === (rowsCounted.proxy as unknown)
  return {
    name,
    counts: { ...rowsCounted.counts },
    prevCounts: { ...prevCounted.counts },
    aux: auxDiff(before, after),
    structure: structureOf(rows, sameRef ? rows : result, sameRef),
  }
}

// ---------------------------------------------------------------------------
// 3. 预热（让 market-time 的 formatter 缓存落地；之后构造次数只反映 market-status）
// ---------------------------------------------------------------------------

function warmUp(): void {
  const rows = dailyBars(DAY_2026_10_21, 8)
  for (const ctx of [CN_DAILY, US_DAILY, CRYPTO_DAILY, CN_FIVE_DAY]) withTickerBar(rows, snap(101, CN_INTRADAY_MS), ctx)
  tickerBarMergeable('tencent', 'tencent')
}
warmUp()
installAuxCounters()

// ---------------------------------------------------------------------------
// 4. 场景：ticker 每拍推进 bar 序列
// ---------------------------------------------------------------------------

console.log('')
console.log('## 1. 每拍 withTickerBar 的确定性工作量（单条序列）')

const s1 = measure('S1 同日合并·价格变化·cn/1d·n=750', dailyBars(DAY_2026_10_21, DAILY_LIMIT), prev => withTickerBar(prev, snap(101, CN_INTRADAY_MS), CN_DAILY))
const s2 = measure('S2 同日合并·无变化（价在区间内）·cn/1d·n=750', dailyBars(DAY_2026_10_21, DAILY_LIMIT), prev => withTickerBar(prev, snap(100, CN_INTRADAY_MS), CN_DAILY))
const s3 = measure('S3 末根早于快照日·补当日未完成日 K·cn/1d·n=750', dailyBars(DAY_2026_10_20, DAILY_LIMIT), prev => withTickerBar(prev, snap(101, CN_INTRADAY_MS, 5000), CN_DAILY))
const s4 = measure('S4 末根早于快照日但盘前（不可交易）·us/1d·n=750', dailyBars(DAY_2026_10_20, DAILY_LIMIT), prev => withTickerBar(prev, snap(101, US_PREMARKET_MS), US_DAILY))
const s5 = measure('S5 crypto/1d（无市场本地日）·价格变化·n=300', dailyBars(DAY_2026_10_21, KLINE_LIMIT_CRYPTO), prev => withTickerBar(prev, snap(101, CN_INTRADAY_MS), CRYPTO_DAILY))
const s6 = measure('S6 五日级别 5d（非日线，恒走同日合并）·cn·n=1950', intradayBars(FIVE_DAY_BARS), prev => withTickerBar(prev, snap(101, CN_INTRADAY_MS), CN_FIVE_DAY))
const s7 = measure('S7 空序列（首帧 ticker 早于 K 线落地）', [], prev => withTickerBar(prev, snap(101, CN_INTRADAY_MS), CN_DAILY))

console.log('| 场景 | 元素读(get) | has | length | slice 调用 | slice 拷贝槽位 | 结果同引用 | 新数组槽位 | 同位置共享 | 存活新对象 | 本地日 | 时段状态 | dayAnchor |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const m of [s1, s2, s3, s4, s5, s6, s7]) {
  console.log('| ' + m.name + ' | ' + m.counts.numericGets + ' | ' + m.counts.hasNumeric + ' | ' + m.counts.lengthGets + ' | ' + m.aux.sliceCalls + ' | ' + m.aux.sliceSlots + ' | ' + (m.structure.sameRef ? '是' : '否') + ' | ' + (m.structure.sameRef ? 0 : m.structure.length) + ' | ' + m.structure.sharedByPosition + ' | ' + m.structure.freshObjects + ' | ' + m.aux.formatCalls + ' | ' + m.aux.formatToParts + ' | ' + m.aux.dateUtc + ' |')
}

check('S1 同日价格变化必须重建数组：末根换新对象、前缀全长共享、恰好 1 次 slice 拷贝 749 槽位', !s1.structure.sameRef && s1.structure.lastChanged && s1.structure.freshObjects === 1 && s1.structure.sharedByPosition === DAILY_LIMIT - 1 && s1.aux.sliceCalls === 1 && s1.aux.sliceSlots === DAILY_LIMIT - 1, 'gets=' + s1.counts.numericGets + ' slice=' + s1.aux.sliceCalls + 'x' + s1.aux.sliceSlots)
check('S2 同日无变化必须同引用短路：0 槽位、0 新对象、0 次 slice、2 次元素读', s2.structure.sameRef && s2.structure.freshObjects === 0 && s2.counts.numericGets === 2 && s2.aux.sliceCalls === 0, 'gets=' + s2.counts.numericGets + ' slice=' + s2.aux.sliceCalls)
check('S3 补当日日 K：追加 1 根、前缀全长共享、0 次 slice、2 次本地日 + 1 次时段状态 + 1 次 dayAnchor', !s3.structure.sameRef && s3.structure.length === DAILY_LIMIT + 1 && s3.structure.freshObjects === 1 && s3.aux.sliceCalls === 0 && s3.aux.formatCalls === 2 && s3.aux.formatToParts === 1 && s3.aux.dateUtc === 1, 'len=' + s3.structure.length + ' day=' + s3.aux.formatCalls + ' status=' + s3.aux.formatToParts + ' anchor=' + s3.aux.dateUtc)
check('S4 盘前不补 bar：同引用、仅 2 次本地日 + 1 次时段状态、0 次 dayAnchor', s4.structure.sameRef && s4.aux.formatCalls === 2 && s4.aux.formatToParts === 1 && s4.aux.dateUtc === 0, 'sameRef=' + s4.structure.sameRef + ' anchor=' + s4.aux.dateUtc)
check('S5 crypto 无时区：0 次本地日/时段/锚点调用，直接同日合并', s5.aux.formatCalls === 0 && s5.aux.formatToParts === 0 && s5.aux.dateUtc === 0 && !s5.structure.sameRef, 'day=' + s5.aux.formatCalls + ' gets=' + s5.counts.numericGets)
check('S6 五日级别：0 次本地日/时段/锚点调用（非日线不判日期）', s6.aux.formatCalls === 0 && s6.aux.formatToParts === 0 && s6.aux.dateUtc === 0 && !s6.structure.sameRef, 'day=' + s6.aux.formatCalls + ' gets=' + s6.counts.numericGets)
check('S7 空序列：同引用、0 元素读', s7.structure.sameRef && s7.counts.numericGets === 0, 'gets=' + s7.counts.numericGets)

// ---------------------------------------------------------------------------
// 5. 场景：30s resync 落地（restoreFormingBar）
// ---------------------------------------------------------------------------

console.log('')
console.log('## 2. 每次 bar resync 落地 restoreFormingBar 的确定性工作量')

const snapTencent: TickerSnapshot = { ticker: snap(102, CN_INTRADAY_MS, 5000), source: 'tencent' }
const snapFlat: TickerSnapshot = { ticker: snap(100, CN_INTRADAY_MS), source: 'tencent' }

const r1 = restoreMeasure('R1 上游缺当日 → 补 bar + 继承上一拍包络·rows=750', dailyBars(DAY_2026_10_20, DAILY_LIMIT), dailyBars(DAY_2026_10_21, DAILY_LIMIT + 1), (rows, prev) => restoreFormingBar(rows, prev, snapTencent, 'tencent', CN_DAILY))
const r2 = restoreMeasure('R2 上游已带当日·价格未变 → 同引用', dailyBars(DAY_2026_10_21, DAILY_LIMIT), dailyBars(DAY_2026_10_21, DAILY_LIMIT + 1), (rows, prev) => restoreFormingBar(rows, prev, snapFlat, 'tencent', CN_DAILY))
const r3 = restoreMeasure('R3 上游已带当日·价格变化 → 末根替换', dailyBars(DAY_2026_10_21, DAILY_LIMIT), dailyBars(DAY_2026_10_21, DAILY_LIMIT + 1), (rows, prev) => restoreFormingBar(rows, prev, snapTencent, 'tencent', CN_DAILY))
const r4 = restoreMeasure('R4 源不一致（bar=tencent / ticker=eastmoney）→ 原样落地', dailyBars(DAY_2026_10_20, DAILY_LIMIT), dailyBars(DAY_2026_10_21, DAILY_LIMIT + 1), (rows, prev) => restoreFormingBar(rows, prev, { ticker: snap(102, CN_INTRADAY_MS), source: 'eastmoney' }, 'tencent', CN_DAILY))

console.log('| 场景 | rows 元素读 | rows has | prev 元素读 | slice 调用 | slice 拷贝槽位 | 结果同引用 | 新数组槽位 | 存活新对象 | 本地日 | 时段状态 | dayAnchor |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const m of [r1, r2, r3, r4]) {
  console.log('| ' + m.name + ' | ' + m.counts.numericGets + ' | ' + m.counts.hasNumeric + ' | ' + m.prevCounts.numericGets + ' | ' + m.aux.sliceCalls + ' | ' + m.aux.sliceSlots + ' | ' + (m.structure.sameRef ? '是' : '否') + ' | ' + (m.structure.sameRef ? 0 : m.structure.length) + ' | ' + m.structure.freshObjects + ' | ' + m.aux.formatCalls + ' | ' + m.aux.formatToParts + ' | ' + m.aux.dateUtc + ' |')
}

check('R1 补回当日：结果 = rows+1、1 个存活新对象（成形那根被丢弃）、1 次 slice 拷贝 750 槽位、5 次本地日', r1.structure.length === DAILY_LIMIT + 1 && r1.structure.freshObjects === 1 && r1.aux.sliceCalls === 1 && r1.aux.sliceSlots === DAILY_LIMIT && r1.aux.formatCalls === 5 && r1.aux.formatToParts === 1 && r1.aux.dateUtc === 1, 'len=' + r1.structure.length + ' fresh=' + r1.structure.freshObjects + ' slice=' + r1.aux.sliceSlots + ' day=' + r1.aux.formatCalls)
check('R2 上游已带当日且价未变：整条路径同引用、0 拷贝、0 新对象', r2.structure.sameRef && r2.structure.freshObjects === 0 && r2.aux.sliceCalls === 0, 'sameRef=' + r2.structure.sameRef + ' day=' + r2.aux.formatCalls)
check('R3 上游已带当日但价变了：只在 rows 上重建一次末根，继承分支不再拷贝（slice 只 1 次）', !r3.structure.sameRef && r3.structure.freshObjects === 1 && r3.structure.length === DAILY_LIMIT && r3.aux.sliceCalls === 1, 'fresh=' + r3.structure.freshObjects + ' len=' + r3.structure.length + ' slice=' + r3.aux.sliceCalls)
check('R4 源不一致：一行都不读（rows 元素读 = 0）、同引用、0 次日期调用', r4.structure.sameRef && r4.counts.numericGets === 0 && r4.aux.formatCalls === 0 && r4.aux.sliceCalls === 0, 'rowsGets=' + r4.counts.numericGets + ' day=' + r4.aux.formatCalls)
check('tickerBarMergeable 语义：同源可合并、异源不可、任一未知按可合并', tickerBarMergeable('tencent', 'tencent') && !tickerBarMergeable('tencent', 'eastmoney') && tickerBarMergeable(undefined, 'eastmoney'), 'five-day-series.ts:106-109')

// ---------------------------------------------------------------------------
// 6. 负对照：计数器必须能区分「O(n) 拷贝」与「O(1) 原地修改」
// ---------------------------------------------------------------------------

console.log('')
console.log('## 3. 负对照（这个计数器有没有分辨力）')

/** 被否掉的替代实现：原地改写末根（违反 ticker-bar.ts:21「不修改入参数组」的不变量，只作对照）。 */
function inPlaceMerge(prev: Kline[], price: number): Kline[] {
  const last = prev[prev.length - 1]
  if (last === undefined) return prev
  if (last.close === price && last.high >= price && last.low <= price) return prev
  prev[prev.length - 1] = { ...last, close: price, high: Math.max(last.high, price), low: Math.min(last.low, price) }
  return prev
}

function productionRun(n: number): Measured {
  return measure('probe', dailyBars(DAY_2026_10_21, n), prev => withTickerBar(prev, snap(101, CN_INTRADAY_MS), CN_DAILY))
}
function inPlaceRun(n: number): Measured {
  return measure('probe', dailyBars(DAY_2026_10_21, n), prev => inPlaceMerge(prev, 101))
}

interface Ladder { ok: boolean; small: number; big: number; delta: number; threshold: number }
function linearAssertion(read: (n: number) => number): Ladder {
  const small = read(100)
  const big = read(750)
  const threshold = 0.9 * (750 - 100)
  return { ok: big - small >= threshold, small, big, delta: big - small, threshold }
}

const prodLadder = linearAssertion(n => productionRun(n).counts.numericGets)
const prodSliceLadder = linearAssertion(n => productionRun(n).aux.sliceSlots)
const inPlaceLadder = linearAssertion(n => inPlaceRun(n).counts.numericGets)
const inPlaceStructure = inPlaceRun(750).structure

check('NC-1 生产实现的元素读取随 n 线性增长（断言：n 100→750 增量 ≥ 585）', prodLadder.ok, 'n=100 -> ' + prodLadder.small + '，n=750 -> ' + prodLadder.big + '，增量 ' + prodLadder.delta + ' ≥ ' + prodLadder.threshold)
check('NC-1b 原生 slice 拷贝槽位同样随 n 线性增长（Proxy 之外的独立计数器）', prodSliceLadder.ok, 'n=100 -> ' + prodSliceLadder.small + '，n=750 -> ' + prodSliceLadder.big + '，增量 ' + prodSliceLadder.delta)
check('NC-2 原地实现与 n 无关（O(1)）：元素读恒为 1、0 次 slice', inPlaceLadder.big <= 4 && inPlaceLadder.delta === 0 && inPlaceRun(750).aux.sliceCalls === 0, 'n=100 -> ' + inPlaceLadder.small + '，n=750 -> ' + inPlaceLadder.big + '，slice=' + inPlaceRun(750).aux.sliceCalls)
check('NC-3 同一「线性」断言施加于原地实现必须失败（证明断言有分辨力）', !inPlaceLadder.ok, '原地实现在该断言下 = ' + (inPlaceLadder.ok ? 'PASS（断言无分辨力，计数器不可信）' : 'FAIL（符合预期）'))
check('NC-4 结构计数同向：生产新建 750 槽位、原地 0 槽位且同引用', s1.structure.length === 750 && s1.structure.sharedByPosition === 749 && inPlaceStructure.sameRef && inPlaceStructure.freshObjects === 0, 'prod: slots=750 shared=749；原地: sameRef=true fresh=0')

// ---------------------------------------------------------------------------
// 7. 规模外推
// ---------------------------------------------------------------------------

console.log('')
console.log('## 4. 规模外推（按 §1/§2 实测单序列计数乘算，不是二次估算）')

const perTickReads = s1.counts.numericGets
const perTickSlots = s1.structure.length
const perTickObjects = s1.structure.freshObjects
/** 每次同日合并的真实槽位写入：slice 一次(n-1) + spread 一次(n-1)（ticker-bar.ts:93 同一 idiom 两段）。 */
const perTickWrites = 2 * (DAILY_LIMIT - 1)
const ticksPer30s = Math.round(KLINE_RESYNC_MS / TICKER_POLL_MS)

interface ScaleRow { label: string; series: number; barLen: number; tickReads: number; tickSlots: number; tickObjects: number; thirtyWrites: number }
function row(label: string, series: number, barLen: number, reads: number, slots: number, objects: number, writesPerTick: number, resyncWrites: number): ScaleRow {
  return {
    label, series, barLen,
    tickReads: reads * series,
    tickSlots: slots * series,
    tickObjects: objects * series,
    thirtyWrites: writesPerTick * series * ticksPer30s + resyncWrites * series,
  }
}

const scale = (() => {
  const rows: ScaleRow[] = []
  rows.push(row('当前生产：聚焦 1 条序列 · 日 K', 1, DAILY_LIMIT, perTickReads, perTickSlots, perTickObjects, perTickWrites, 0))
  rows.push(row('自选全量 18 条序列 · 日 K（假设同拍推进）', 18, DAILY_LIMIT, perTickReads, perTickSlots, perTickObjects, perTickWrites, 0))
  rows.push(row('尾部 100 条序列 · 日 K', 100, DAILY_LIMIT, perTickReads, perTickSlots, perTickObjects, perTickWrites, 0))
  return rows
})()
const cryptoWrites = 2 * (KLINE_LIMIT_CRYPTO - 1)
const fiveDayWrites = 2 * (FIVE_DAY_BARS - 1)
const scaleExtra = [
  row('自选全量 18 条 · crypto 分钟级', 18, KLINE_LIMIT_CRYPTO, s5.counts.numericGets, s5.structure.length, s5.structure.freshObjects, cryptoWrites, 0),
  row('自选全量 18 条 · 五日级别 5d', 18, FIVE_DAY_BARS, s6.counts.numericGets, s6.structure.length, s6.structure.freshObjects, fiveDayWrites, 0),
  row('自选全量 18 条 · 日 K 且 resync 缺当日（R1 口径：多一遍 + 一次 slice）', 18, DAILY_LIMIT, perTickReads, perTickSlots, perTickObjects, perTickWrites, DAILY_LIMIT + DAILY_LIMIT),
]

console.log('| 规模 | 序列数 | bar 长度 | 每拍元素读 | 每拍新槽位 | 每拍存活新对象 | 每 30s 槽位写入 |')
console.log('|---|---|---|---|---|---|---|')
for (const r of [...scale, ...scaleExtra]) {
  console.log('| ' + r.label + ' | ' + r.series + ' | ' + r.barLen + ' | ' + r.tickReads + ' | ' + r.tickSlots + ' | ' + r.tickObjects + ' | ' + r.thirtyWrites + ' |')
}
console.log('')
console.log('槽位写入口径：同日合并 = slice 一次(n-1) + spread 一次(n-1)；补当日 bar = spread 一次(n)。')
console.log('节奏：ticker poll ' + TICKER_POLL_MS + 'ms（QuoteStage.tsx:83/656）→ 每 30s ' + ticksPer30s + ' 拍；bar resync ' + KLINE_RESYNC_MS + 'ms（QuoteStage.tsx:84/451）→ 每 30s 1 次。')
console.log('注：生产今天只推进**聚焦标的**那一条序列（QuoteStage.tsx:653 是唯一调用点）；18/100 行是同一常数的外推，不是当前并发工作量。')
console.log('身份变化次数（决定 React 提交 + 图表 setData 次数）：价格变动那一拍每序列 1 次，S2 那类无变化一拍 0 次。今天 = 每 5s ≤1 次；18 条同拍 = 每 5s ≤18 次；100 条 = 每 5s ≤100 次。')

// ---------------------------------------------------------------------------
// 8. 旁证：墙钟（非权威）
// ---------------------------------------------------------------------------

const reps = 5
const t0 = performance.now()
for (let i = 0; i < reps; i++) productionRun(750)
const t1 = performance.now()
console.log('')
console.log('[非权威] 5 次 withTickerBar(n=750) 合计 elapsed ≈ ' + (t1 - t0).toFixed(3) + 'ms —— 机器饱和（CPU 约 12% idle、compressor 5.6GB），本轮不作结论，待安静窗口复测。')

console.log('')
console.log('## 5. 结论')
console.log('- 每拍成本 = O(n) 数组重建：slice 与 spread 各写 n-1 个槽位 + 1 个新 Kline + 1 个 n 槽位新数组；价格在区间内时短路成 2 次元素读、0 分配（返回同引用）。')
console.log('- 辅助调用：cn/hk/us/futures 日线每拍 2 次 marketLocalDay；补当日那一拍再加 1 次 getMarketSessionStatus（内部每调用新建 1 个 Intl.DateTimeFormat，market-status.ts:55 无缓存）与 1 次 dayAnchorMs。crypto 与 5d 级别 0 次。')
console.log('- resync 那一拍（restoreFormingBar）在上游缺当日时把成本翻倍：withTickerBar 先造一根成形 bar，继承时再造一根并丢掉前一根——每拍新建 2 个 Kline 只留 1 个，序列被重建两次（slice 再拷 750 槽位，ticker-bar.ts:131 与 :191），另加 5 次 marketLocalDay。')
console.log('- 用户可感知的部分（渲染 / 绘制 / 输入延迟）本轮一律未测；Node 侧只能定量到「每拍多少槽位、多少对象、多少次辅助调用、身份是否变化」。')
console.log('')
if (FAILURES.length > 0) {
  console.log('FAILED: ' + FAILURES.length + ' 项 —— ' + FAILURES.join(' / '))
  process.exitCode = 1
} else {
  console.log('ALL CHECKS PASSED（含负对照）')
}
