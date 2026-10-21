/**
 * 外部序列对齐单测（契约 §3）：日 K 一字对齐、周 K 前向填充取区间最新值、
 * 早于首条数据填 undefined、空输入语义与长度严格性、不用未来数据。
 * 并冻结逐根通道的词汇：通道键字面量、档位编码表下标与档位编码类型一致。
 */
import { describe, expect, it } from 'vitest'
import type { AuxPoint, FiveDayVolumeTierCode, Kline } from '../src/index.ts'
import { FIVE_DAY_VOLUME_TIER_AUX_KEY, FIVE_DAY_VOLUME_TIER_CODES, alignAuxToBars } from '../src/index.ts'

const DAY = 86_400_000

/** UTC 当日 00:00 的 epoch ms（与 AuxPoint.date 同口径）。 */
function day(year: number, month: number, date: number): number {
  return Date.UTC(year, month - 1, date)
}

/** 日 K：openTime 为 UTC 当日 00:00，closeTime 为当日 23:59:59.999。 */
function dailyBar(tradingDay: number): Kline {
  return { openTime: tradingDay, closeTime: tradingDay + DAY - 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100 }
}

/** 周 K：openTime 为周期首日 00:00，closeTime 为周期末日 23:59:59.999。 */
function weeklyBar(periodStart: number, days: number): Kline {
  return {
    openTime: periodStart,
    closeTime: periodStart + days * DAY - 1,
    open: 10, high: 11, low: 9, close: 10.5, volume: 500,
  }
}

const dayOfBar = (bar: Kline): number => bar.openTime

describe('alignAuxToBars', () => {
  it('用户看日 K 时，同日期的外部值与 K 线一字对齐', () => {
    // Given: 三个交易日，外部序列每天一条且与 K 线同日期
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6)), dailyBar(day(2026, 10, 7))]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 5), value: 11.1 },
      { date: day(2026, 10, 6), value: 11.4 },
      { date: day(2026, 10, 7), value: 11.9 },
    ]
    // When: 按 K 线交易日对齐
    const aligned = alignAuxToBars(bars, points, dayOfBar)
    // Then: 一一对应，长度严格等于 K 线数
    expect(aligned).toEqual([11.1, 11.4, 11.9])
    expect(aligned).toHaveLength(bars.length)
  })

  it('用户看周 K 时，取该周区间内最新一条外部值（不是周期起点旧值）', () => {
    // Given: 两根周 K；第一周覆盖 10-05~10-11，其内 10-06/10-09 各有一条外部值
    const bars = [weeklyBar(day(2026, 10, 5), 7), weeklyBar(day(2026, 10, 12), 7)]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 6), value: 11.1 },
      { date: day(2026, 10, 9), value: 11.7 },
      { date: day(2026, 10, 13), value: 12.3 },
    ]
    // When: 以周期末日（closeTime 所在日）为对齐基准
    const aligned = alignAuxToBars(bars, points, bar => Math.floor((bar.closeTime ?? bar.openTime) / DAY) * DAY)
    // Then: 第一周取区间内最新的 11.7（10-09），第二周取 12.3（10-13）
    expect(aligned).toEqual([11.7, 12.3])
  })

  it('用户看早于首条外部数据的 K 线时，该段留空而不是回填首条值', () => {
    // Given: 外部序列从第三个交易日才开始（前两日无数据）
    const bars = [dailyBar(day(2026, 10, 1)), dailyBar(day(2026, 10, 2)), dailyBar(day(2026, 10, 5))]
    const points: AuxPoint[] = [{ date: day(2026, 10, 5), value: 11.1 }]
    // When: 对齐
    const aligned = alignAuxToBars(bars, points, dayOfBar)
    // Then: 前两根 undefined（不画），第三根取首条值
    expect(aligned).toEqual([undefined, undefined, 11.1])
    expect(aligned).toHaveLength(bars.length)
  })

  it('用户遇到无数据的情形时得到全空序列，长度仍与 K 线一致', () => {
    // Given: 空外部序列（标的不在港股通范围）与空 K 线序列
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6))]
    // When: 各自对齐
    const emptyAux = alignAuxToBars(bars, [], dayOfBar)
    const emptyBars = alignAuxToBars([], [{ date: day(2026, 10, 5), value: 11.1 }], dayOfBar)
    // Then: 前者逐根 undefined，后者为空数组
    expect(emptyAux).toEqual([undefined, undefined])
    expect(emptyAux).toHaveLength(bars.length)
    expect(emptyBars).toEqual([])
  })

  it('用户看周末或非交易日 K 线时，只取到该日及之前已公布的值而不前视未来', () => {
    // Given: K 线交易日 10-06，外部序列在 10-07 才公布（未来一天）
    const bars = [dailyBar(day(2026, 10, 6))]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 5), value: 11.1 },
      { date: day(2026, 10, 7), value: 11.4 },
    ]
    // When: 对齐
    const aligned = alignAuxToBars(bars, points, dayOfBar)
    // Then: 取 10-05 的值，绝不使用 10-07 的未来数据
    expect(aligned).toEqual([11.1])
  })

  it('用户倒序传入 K 线时，每根仍取到各自交易日的最新值', () => {
    // Given: 同一序列按新→旧传入
    const ascending = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6))]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 5), value: 11.1 },
      { date: day(2026, 10, 6), value: 11.4 },
    ]
    // When: 正序与倒序各对齐一次
    const forward = alignAuxToBars(ascending, points, dayOfBar)
    const backward = alignAuxToBars([...ascending].reverse(), points, dayOfBar)
    // Then: 倒序结果为正序的镜像，不因扫描方向错配
    expect(backward).toEqual([...forward].reverse())
    expect(backward).toEqual([11.4, 11.1])
  })
})

describe('逐根序列通道词汇', () => {
  it('用户读五日档位通道键时，它是冻结的通道名字面量', () => {
    // Given 逐根通道的键常量
    // When 读它的值
    // Then 字面量冻结（宿主与指标两侧按同一个字符串握手，改名即断链）
    expect(FIVE_DAY_VOLUME_TIER_AUX_KEY).toBe('five-day-volume-tiers')
  })

  it('用户读档位编码表时，下标即编码值且与档位编码类型的取值域一一对应', () => {
    // Given 编码表与「0..4 每个下标都是合法编码」的编译期清单
    const everyCode: readonly FiveDayVolumeTierCode[] = [0, 1, 2, 3, 4]
    // When 对照编码表
    // Then 下标即编码值：0 无前值，1..4 为量比四档
    expect(FIVE_DAY_VOLUME_TIER_CODES[0]).toBe('noPrior')
    expect(FIVE_DAY_VOLUME_TIER_CODES[1]).toBe('lt1')
    expect(FIVE_DAY_VOLUME_TIER_CODES[2]).toBe('lt2')
    expect(FIVE_DAY_VOLUME_TIER_CODES[3]).toBe('lt3')
    expect(FIVE_DAY_VOLUME_TIER_CODES[4]).toBe('gte3')
    // Then 编码表长度 = 编码类型取值域长度（多一档或少一档都会被这里拦住）
    expect([...FIVE_DAY_VOLUME_TIER_CODES]).toHaveLength(everyCode.length)
    expect(FIVE_DAY_VOLUME_TIER_CODES).toHaveLength(5)
  })
})
