/**
 * ticker-bar 纯函数单测：日 K 的同日合并、末根不是当日时补「当日未完成」日 K、
 * 非交易日/开市前不补、美股盘前盘后不补（常规时段白名单）、crypto（无市场本地日）与
 * 分钟/五日/周线级别维持合并，快照量缺省、无效快照、不可变与引用稳定，以及 30s
 * 全量重取落地时的当日 bar 复原（restoreFormingBar 的源门控与回落）。
 *
 * 时间锚点：2026-10 美股 ET=UTC-4（EDT）、A股 CST=UTC+8；2026-10-21 是周三，
 * 2026-10-24 是周六。cn 日 K 的 openTime 取 tencent 口径（本地日的 UTC 零点 =
 * 08:00 CST），us 日 K 取 yahoo 口径（当日 09:30 ET = 13:30Z）——两种口径共享
 * 「openTime 的 UTC 日期 == 市场本地日」这条不变量。
 */
import { describe, expect, it } from 'vitest'
import { restoreFormingBar, withTickerBar, type TickerBarContext, type TickerSnapshot } from '../src/client/ticker-bar.ts'
import type { Kline, Ticker } from '../src/client/types.ts'

const DAY_MS = 86_400_000

/** cn 本地交易日 → 该日行情日界（08:00 CST）。 */
function cnDay(dayOfMonth: number): number {
  return Date.UTC(2026, 9, dayOfMonth)
}

/** us 本地交易日开盘 09:30 ET（EDT=UTC-4）。 */
function usSession(dayOfMonth: number): number {
  return Date.UTC(2026, 9, dayOfMonth, 13, 30)
}

function dailyBar(openTime: number, open: number, high: number, low: number, close: number, volume: number): Kline {
  return { openTime, open, high, low, close, volume, closeTime: openTime + DAY_MS - 1 }
}

function snapshot(timestamp: number, price: number, volume?: number): Ticker {
  return { symbol: '600519.SH', price, timestamp, ...(volume === undefined ? {} : { volume }) }
}

const CN_DAILY: TickerBarContext = { market: 'cn', interval: '1d' }

describe('ticker-bar：日 K 的 ticker 合并与当日未完成 bar 补位', () => {
  it('用户看日 K 时末根已落在快照当日本地日 → 只把快照价并进末根，开盘与成交量原样', () => {
    // Given cn 日 K 覆盖 10-19、10-20，快照在 10-20 10:00 CST（盘中）
    const prev = [
      dailyBar(cnDay(19), 9.9, 10.5, 9.8, 10.0, 1000),
      dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200),
    ]

    // When 用 10.4 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 20, 2), 10.4), CN_DAILY)

    // Then 根数不变、首根同引用、末根收盘抬到 10.4 且开盘/成交量不动
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(prev[0])
    expect(result[1]).toEqual({
      openTime: cnDay(20), open: 10.0, high: 10.4, low: 9.9, close: 10.4, volume: 1200, closeTime: cnDay(20) + DAY_MS - 1,
    })
  })

  it('用户看日 K 时末根还是昨日 → 追加一根当日未完成 bar，快照价同时是开高低收', () => {
    // Given cn 日 K 只到 10-20，快照是 10-21 10:00 CST（次日盘中）带量 3456
    const prev = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]

    // When 用 12.5 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 2), 12.5, 3456), CN_DAILY)

    // Then 末位多出一根 10-21 的未完成 bar，入参数组原样不被改写
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({
      openTime: cnDay(21), open: 12.5, high: 12.5, low: 12.5, close: 12.5, volume: 3456, closeTime: cnDay(21) + DAY_MS - 1,
    })
    expect(prev).toEqual([dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)])
    expect(result).not.toBe(prev)
  })

  it('用户看美股日 K 时追加的当日 bar 按快照的市场本地日锚定，UTC 日期与本地日一致', () => {
    // Given us 日 K 停在 10-20 09:30 ET，快照是 10-21 10:00 ET
    const prev = [dailyBar(usSession(20), 190.0, 195.0, 189.0, 194.0, 5000)]

    // When 用 200 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 14), 200, 6000), { market: 'us', interval: '1d' })

    // Then 新 bar 的 openTime 是 10-21 的行情日界（UTC 日期 21，与本地日同一天）
    expect(result).toHaveLength(2)
    expect(result[1]?.openTime).toBe(Date.UTC(2026, 9, 21))
    expect(new Date(result[1]?.openTime ?? 0).getUTCDate()).toBe(21)
  })

  it('用户看美股日 K 时盘前快照 → 不补当日 bar，延长时段的价不进常规日 K', () => {
    // Given us 日 K 停在 10-20 09:30 ET，快照是 10-21 04:30 ET（盘前，status.preMarket）
    const prev = [dailyBar(usSession(20), 190.0, 195.0, 189.0, 194.0, 5000)]

    // When 用 200 的盘前快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 8, 30), 200), { market: 'us', interval: '1d' })

    // Then 原数组原样返回（盘前极值不得写进日 K 的最高/最低）
    expect(result).toBe(prev)
    expect(result).toHaveLength(1)
  })

  it('用户看美股日 K 时盘后快照 → 不补当日 bar，延长时段的价不进常规日 K', () => {
    // Given us 日 K 停在 10-20 09:30 ET，快照是 10-21 16:30 ET（盘后，status.afterHours）
    const prev = [dailyBar(usSession(20), 190.0, 195.0, 189.0, 194.0, 5000)]

    // When 用 210 的盘后快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 20, 30), 210), { market: 'us', interval: '1d' })

    // Then 原数组原样返回
    expect(result).toBe(prev)
    expect(result).toHaveLength(1)
  })

  it('用户看日 K 时第二拍快照只推进刚补出来的那根当日 bar', () => {
    // Given 序列里已有昨日日 K 与按 12.5 补出的当日 bar
    const prev = [
      dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200),
      dailyBar(cnDay(21), 12.5, 12.5, 12.5, 12.5, 3456),
    ]

    // When 五分钟后快照涨到 13.0
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 2, 5), 13.0), CN_DAILY)

    // Then 当日那根被推进（高点与收盘 13.0），开盘与成交量仍是补位时的值，不会再多一根
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({
      openTime: cnDay(21), open: 12.5, high: 13.0, low: 12.5, close: 13.0, volume: 3456, closeTime: cnDay(21) + DAY_MS - 1,
    })
  })

  it('用户的标的是周末休市 → 不追加当日 bar，也不改昨日那根', () => {
    // Given cn 日 K 到 10-20，快照时间落在 10-24 周六 10:00 CST
    const prev = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]

    // When 用 12.5 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 24, 2), 12.5), CN_DAILY)

    // Then 原数组原样返回（一根都不动）
    expect(result).toBe(prev)
    expect(result).toHaveLength(1)
  })

  it('用户在工作日开盘前看日 K → 不追加当日 bar，也不改昨日那根', () => {
    // Given cn 日 K 到 10-20，快照时间落在 10-21 周三 08:00 CST（开市前）
    const prev = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]

    // When 用 12.5 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 0), 12.5), CN_DAILY)

    // Then 原数组原样返回
    expect(result).toBe(prev)
  })

  it('用户在午间休市看日 K → 当日未完成 bar 照常追加', () => {
    // Given cn 日 K 到 10-20，快照时间落在 10-21 周三 12:00 CST（午休，非交易中但属交易日）
    const prev = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]

    // When 用 5.5 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 4), 5.5, 800), CN_DAILY)

    // Then 补出当日 bar（开高低收 5.5）
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({
      openTime: cnDay(21), open: 5.5, high: 5.5, low: 5.5, close: 5.5, volume: 800, closeTime: cnDay(21) + DAY_MS - 1,
    })
  })

  it('用户看加密日 K → 没有市场本地日，维持合并最后一根，不造日级 bar', () => {
    // Given crypto 一根 10-20 的日 K，快照时间已跨到 10-21
    const prev = [dailyBar(Date.UTC(2026, 9, 20), 100, 101, 99, 100.5, 4000)]

    // When 用 105 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 5), 105), { market: 'crypto', interval: '1d' })

    // Then 仍是同一根被推进（收盘与高点 105），根数不变
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      openTime: Date.UTC(2026, 9, 20), open: 100, high: 105, low: 99, close: 105, volume: 4000, closeTime: Date.UTC(2026, 9, 20) + DAY_MS - 1,
    })
  })

  it('用户看分钟级别 → 只推进末根，绝不追加日级 bar', () => {
    // Given cn 5m 序列末根是 10-20 10:00 CST，快照时间已跨到 10-21（跨日不是补 bar 的理由）
    const prev = [{ openTime: Date.UTC(2026, 9, 20, 2), open: 10.0, high: 10.2, low: 9.9, close: 10.1, volume: 30, closeTime: Date.UTC(2026, 9, 20, 2) + 299_999 }]

    // When 用 12.5 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 2), 12.5), { market: 'cn', interval: '5m' })

    // Then 末根被推进但开盘时刻不变，根数仍然是 1
    expect(result).toHaveLength(1)
    expect(result[0]?.openTime).toBe(Date.UTC(2026, 9, 20, 2))
    expect(result[0]?.close).toBe(12.5)
  })

  it('用户看五日级别 → 只推进末根，绝不追加日级 bar', () => {
    // Given cn 五日级别（'5d'）序列末根是 10-20 10:00 CST，快照时间跨到 10-21
    const prev = [{ openTime: Date.UTC(2026, 9, 20, 2), open: 10.0, high: 10.2, low: 9.9, close: 10.1, volume: 30, closeTime: Date.UTC(2026, 9, 20, 2) + 59_999 }]

    // When 用 12.5 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 2), 12.5), { market: 'cn', interval: '5d' })

    // Then 根数不变，收盘被推进到 12.5
    expect(result).toHaveLength(1)
    expect(result[0]?.close).toBe(12.5)
  })

  it('用户看周线 → 只推进末根，不把按日定义的 bar 塞进跨周序列', () => {
    // Given cn 周线末根是 10-19（本周）开盘，快照时间跨到 10-21
    const prev = [{ openTime: Date.UTC(2026, 9, 19), open: 9.0, high: 10.2, low: 8.9, close: 10.1, volume: 5000, closeTime: Date.UTC(2026, 9, 23) + DAY_MS - 1 }]

    // When 用 12.5 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 2), 12.5), { market: 'cn', interval: '1w' })

    // Then 只有末根被推进，没有新 bar
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      openTime: Date.UTC(2026, 9, 19), open: 9.0, high: 12.5, low: 8.9, close: 12.5, volume: 5000, closeTime: Date.UTC(2026, 9, 23) + DAY_MS - 1,
    })
  })

  it('用户的快照没带成交量 → 当日未完成 bar 的成交量是 0', () => {
    // Given cn 日 K 到 10-20，快照只有价格
    const prev = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]

    // When 用不带 volume 的 12.5 快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 2), 12.5), CN_DAILY)

    // Then 补出的当日 bar 成交量是 0 而不是缺键
    expect(result).toHaveLength(2)
    expect(result[1]?.volume).toBe(0)
    expect(result[1]).toEqual({
      openTime: cnDay(21), open: 12.5, high: 12.5, low: 12.5, close: 12.5, volume: 0, closeTime: cnDay(21) + DAY_MS - 1,
    })
  })

  it('用户的快照价与末根收盘一致且落在高低区间内 → 返回原数组引用', () => {
    // Given cn 日 K 末根收盘 10.1、高低 10.2/9.9
    const prev = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]

    // When 用同为 10.1 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 20, 2), 10.1), CN_DAILY)

    // Then 同引用返回（调用方的 setState 走短路，不重算整张图）
    expect(result).toBe(prev)
  })

  it('用户的快照跌破末根低点 → 返回新数组，入参数组与元素一个字段都不被改写', () => {
    // Given cn 日 K 末根（低点 9.9）
    const prev = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]

    // When 用 9.5 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 20, 2), 9.5), CN_DAILY)

    // Then 新数组承载更新，原数组内容原样
    expect(result).not.toBe(prev)
    expect(result[0]).toEqual({
      openTime: cnDay(20), open: 10.0, high: 10.2, low: 9.5, close: 9.5, volume: 1200, closeTime: cnDay(20) + DAY_MS - 1,
    })
    expect(prev[0]).toEqual(dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200))
  })

  it('用户的末根日 K 落在快照本地日之后（时钟或数据异常）→ 一根都不动', () => {
    // Given cn 日 K 已到 10-22，快照时间却是 10-21 10:00 CST
    const prev = [dailyBar(cnDay(22), 11.0, 11.5, 10.8, 11.2, 900)]

    // When 用 12.5 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 2), 12.5), CN_DAILY)

    // Then 原数组原样返回
    expect(result).toBe(prev)
  })

  it('用户的快照价非正数或非有限数 → 一根都不动', () => {
    // Given cn 日 K 到 10-20
    const prev = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]

    // When 分别用 0、负数、NaN 的快照推进
    const zero = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 2), 0), CN_DAILY)
    const negative = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 2), -3), CN_DAILY)
    const notANumber = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 2), Number.NaN), CN_DAILY)

    // Then 三种都原样返回
    expect(zero).toBe(prev)
    expect(negative).toBe(prev)
    expect(notANumber).toBe(prev)
  })

  it('用户的快照时间无效 → 判不出交易日，一根都不动', () => {
    // Given cn 日 K 到 10-20
    const prev = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]

    // When 快照时间是不可解析的 NaN
    const result = withTickerBar(prev, snapshot(Number.NaN, 12.5), CN_DAILY)

    // Then 原数组原样返回
    expect(result).toBe(prev)
  })

  it('用户的 K 线序列还没到手 → 原样返回空数组', () => {
    // Given 空序列
    const prev: Kline[] = []

    // When 用 12.5 的快照推进
    const result = withTickerBar(prev, snapshot(Date.UTC(2026, 9, 21, 2), 12.5), CN_DAILY)

    // Then 同引用空数组，不会凭空造出一根
    expect(result).toBe(prev)
    expect(result).toHaveLength(0)
  })
})

describe('ticker-bar：全量重取落地时的当日 bar 复原', () => {
  it('用户看日 K 时上游缺当日那根 → 源一致就用最近快照把当日 bar 复原', () => {
    // Given resync 落地的是只到 10-20 的日 K，上一拍序列也只有昨日真 bar，快照来自同一个源 tencent
    const rows = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]
    const prev = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]
    const last: TickerSnapshot = { ticker: snapshot(Date.UTC(2026, 9, 21, 2), 12.5, 3456), source: 'tencent' }

    // When 落地前复原
    const result = restoreFormingBar(rows, prev, last, 'tencent', CN_DAILY)

    // Then 当日那根仍在；上一拍没有同日的当日 bar 可继承，开高低收都是当拍价
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({
      openTime: cnDay(21), open: 12.5, high: 12.5, low: 12.5, close: 12.5, volume: 3456, closeTime: cnDay(21) + DAY_MS - 1,
    })
  })

  it('用户看日 K 时重取序列已带上当日那根 → 快照只并进它，不再多补一根', () => {
    // Given resync 落地的是含 10-21 真实日 K 的序列，快照来自同一个源
    const rows = [
      dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200),
      dailyBar(cnDay(21), 12.0, 12.8, 11.9, 12.4, 2000),
    ]
    const last: TickerSnapshot = { ticker: snapshot(Date.UTC(2026, 9, 21, 2), 12.5), source: 'tencent' }

    // When 落地前复原
    const result = restoreFormingBar(rows, rows, last, 'tencent', CN_DAILY)

    // Then 只有末根被推进到快照价 12.5，根数不变（真实 bar 的开高低不被合成值覆盖）
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({
      openTime: cnDay(21), open: 12.0, high: 12.8, low: 11.9, close: 12.5, volume: 2000, closeTime: cnDay(21) + DAY_MS - 1,
    })
  })

  it('用户的当日 bar 已在上一拍序列里 → 复原时继承它的开盘价与高低点包络', () => {
    // Given 上一拍序列的当日 bar 已推到 open 12.8 / high 13.4 / low 12.2，快照回落到 12.5
    const rows = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]
    const prev = [
      dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200),
      dailyBar(cnDay(21), 12.8, 13.4, 12.2, 13.0, 2400),
    ]
    const last: TickerSnapshot = { ticker: snapshot(Date.UTC(2026, 9, 21, 2, 30), 12.5, 3456), source: 'tencent' }

    // When 落地前复原
    const result = restoreFormingBar(rows, prev, last, 'tencent', CN_DAILY)

    // Then 继承开盘 12.8 与包络 high 13.4 / low 12.2，收盘用当拍价 12.5，量用快照量 3456
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({
      openTime: cnDay(21), open: 12.8, high: 13.4, low: 12.2, close: 12.5, volume: 3456, closeTime: cnDay(21) + DAY_MS - 1,
    })
  })

  it('用户的快照与重取序列来自不同源 → 原样落地，不把两个源混进同一根', () => {
    // Given 快照来自 tencent，落地序列来自 eastmoney
    const rows = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]
    const last: TickerSnapshot = { ticker: snapshot(Date.UTC(2026, 9, 21, 2), 12.5), source: 'tencent' }

    // When 落地前复原
    const result = restoreFormingBar(rows, rows, last, 'eastmoney', CN_DAILY)

    // Then 同引用原样落地
    expect(result).toBe(rows)
    expect(result).toHaveLength(1)
  })

  it('用户的快照源两端都未标注 → 按可合并处理，当日 bar 仍复原', () => {
    // Given 快照与序列都没有源标注（桥未标注 provider）
    const rows = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]
    const last: TickerSnapshot = { ticker: snapshot(Date.UTC(2026, 9, 21, 2), 12.5), source: undefined }

    // When 落地前复原
    const result = restoreFormingBar(rows, rows, last, undefined, CN_DAILY)

    // Then 当日 bar 照样补回来
    expect(result).toHaveLength(2)
    expect(result[1]?.openTime).toBe(cnDay(21))
  })

  it('用户看分钟级别时重取落地 → 原样落地，不补日级 bar', () => {
    // Given 5m 序列与一份日线快照
    const rows = [{ openTime: Date.UTC(2026, 9, 20, 2), open: 10.0, high: 10.2, low: 9.9, close: 10.1, volume: 30, closeTime: Date.UTC(2026, 9, 20, 2) + 299_999 }]
    const last: TickerSnapshot = { ticker: snapshot(Date.UTC(2026, 9, 21, 2), 12.5), source: 'tencent' }

    // When 落地前复原
    const result = restoreFormingBar(rows, rows, last, 'tencent', { market: 'cn', interval: '5m' })

    // Then 同引用原样落地（分钟级别的行为不受影响）
    expect(result).toBe(rows)
    expect(result).toHaveLength(1)
  })

  it('用户还没收到过任何快照 → 原样落地', () => {
    // Given 只有落地序列，没有快照
    const rows = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]

    // When 落地前复原
    const result = restoreFormingBar(rows, rows, null, undefined, CN_DAILY)

    // Then 同引用原样落地
    expect(result).toBe(rows)
    expect(result).toHaveLength(1)
  })

  it('用户的上一拍末根还是昨日真 bar → 不继承昨日的极值，当日 bar 只按当拍价造', () => {
    // Given 上一拍序列的末根是 10-20 的真日 K（极值 99/1），上游重取仍缺当日那根
    const rows = [dailyBar(cnDay(20), 10.0, 99.0, 1.0, 10.1, 1200)]
    const prev = [dailyBar(cnDay(20), 10.0, 99.0, 1.0, 10.1, 1200)]
    const last: TickerSnapshot = { ticker: snapshot(Date.UTC(2026, 9, 21, 2), 12.5, 3456), source: 'tencent' }

    // When 落地前复原
    const result = restoreFormingBar(rows, prev, last, 'tencent', CN_DAILY)

    // Then 当日 bar 的开高低收都只等于当拍价，昨日 99/1 没有带进来
    expect(result).toHaveLength(2)
    expect(result[1]).toEqual({
      openTime: cnDay(21), open: 12.5, high: 12.5, low: 12.5, close: 12.5, volume: 3456, closeTime: cnDay(21) + DAY_MS - 1,
    })
  })

  it('用户连过三拍 30s 重取 → 当日 bar 一直在，high 只涨不跌、low 只跌不涨', () => {
    // Given 上游始终缺当日那根的日 K（每拍重取都是同一份 rows），快照价先冲高再回落
    const rows = [dailyBar(cnDay(20), 10.0, 10.2, 9.9, 10.1, 1200)]
    const prices = [12.8, 12.5, 12.6]
    const lengths: number[] = []
    const highs: number[] = []
    const lows: number[] = []
    const opens: number[] = []
    const closes: number[] = []
    let series = rows

    // When 每拍落地复原（prev 传上一拍序列）再走一次 5s ticker 推进
    for (const price of prices) {
      const last: TickerSnapshot = { ticker: snapshot(Date.UTC(2026, 9, 21, 2), price), source: 'tencent' }
      series = withTickerBar(restoreFormingBar(rows, series, last, 'tencent', CN_DAILY), last.ticker, CN_DAILY)
      const bar = series[series.length - 1] as Kline
      lengths.push(series.length)
      highs.push(bar.high)
      lows.push(bar.low)
      opens.push(bar.open)
      closes.push(bar.close)
    }

    // Then 当日 bar 每拍都在；开盘价恒为第一拍价 12.8，high 不回落、low 不下压，收盘是当拍价
    expect(lengths).toEqual([2, 2, 2])
    expect(series[1]?.openTime).toBe(cnDay(21))
    expect(opens).toEqual([12.8, 12.8, 12.8])
    expect(highs).toEqual([12.8, 12.8, 12.8])
    expect(lows).toEqual([12.8, 12.5, 12.5])
    expect(closes).toEqual([12.8, 12.5, 12.6])
    expect(highs.every((high, index) => index === 0 || high >= (highs[index - 1] as number))).toBe(true)
    expect(lows.every((low, index) => index === 0 || low <= (lows[index - 1] as number))).toBe(true)
  })
})
