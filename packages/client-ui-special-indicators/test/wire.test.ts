/**
 * wire.ts 派生纯函数测试：toChartSeries 的 null 纪律（docs/api.md：null/空
 * 不补成数值零）、sentimentZone 五档边界、format 空值口径。
 */
import { describe, expect, it } from 'vitest'
import {
  formatNum,
  formatPct,
  formatSigned,
  isDataBehind,
  sectorsDataStale,
  sentimentDataStale,
  sentimentZone,
  toChartSeries,
} from '../src/client/wire.ts'

describe('toChartSeries 图表序列派生', () => {
  it('用户序列含 null 时该点被丢弃而非补零', () => {
    // Given: 三行日频数据，中间行 score 为 null（上游缺观测）
    const rows = [
      { date: '2026-09-14', score: 40 },
      { date: '2026-09-15', score: null },
      { date: '2026-09-16', score: 42.65 },
    ]
    // When: 派生图表序列
    const series = toChartSeries(rows, (r) => r.score)
    // Then: null 行不出现（不补零、不连线误导），其余原值保留
    expect(series).toEqual([
      { time: '2026-09-14', value: 40 },
      { time: '2026-09-16', value: 42.65 },
    ])
  })

  it('用户序列乱序且含重复日期时输出升序且按日期去重', () => {
    // Given: 乱序 + 重复日期行
    const rows = [
      { date: '2026-09-16', pct: 2.2 },
      { date: '2026-09-14', pct: 1.8 },
      { date: '2026-09-16', pct: 9.9 },
    ]
    // When: 派生图表序列
    const series = toChartSeries(rows, (r) => r.pct)
    // Then: 升序、先到者胜出（同日回补前的快照不双画）
    expect(series).toEqual([
      { time: '2026-09-14', value: 1.8 },
      { time: '2026-09-16', value: 2.2 },
    ])
  })
})

describe('sentimentZone 五档分区', () => {
  it('用户分数落在各档边界时分区与源页面口径一致', () => {
    // Given: 0–100 分数的五档口径（20/40/60/80 为界）
    // When: 逐档取代表值与边界值
    // Then: 分区落位正确（越低越恐惧）
    expect(sentimentZone(0)).toBe('extreme_fear')
    expect(sentimentZone(19.9)).toBe('extreme_fear')
    expect(sentimentZone(20)).toBe('fear')
    expect(sentimentZone(42.65)).toBe('neutral')
    expect(sentimentZone(60)).toBe('greed')
    expect(sentimentZone(80)).toBe('extreme_greed')
    expect(sentimentZone(100)).toBe('extreme_greed')
  })
})

describe('isDataBehind 数据滞后判据', () => {
  it('用户看到 T+1 数据落在上一交易日时不判滞后', () => {
    // Given: 10-09 交易日，融资余额/恐慌指数显示 10-08（预期数据日也是 10-08）
    // When: 比较数据日与预期数据日
    // Then: 相等即新鲜，不是滞后——这是 T+1 口径的常态
    expect(isDataBehind('2026-10-08', '2026-10-08')).toBe(false)
  })

  it('用户数据日早于预期数据日时判滞后', () => {
    // Given: 上游仍停在 09-30（长假前），预期已到 10-08
    // When: 比较
    // Then: 数据日更早即滞后
    expect(isDataBehind('2026-09-30', '2026-10-08')).toBe(true)
  })

  it('用户日期缺失时一律不判滞后', () => {
    // Given: 上游字段缺失/为空（无口径可比）
    // When: 比较
    // Then: 宁可不标，不误标
    expect(isDataBehind(null, '2026-10-08')).toBe(false)
    expect(isDataBehind('2026-10-08', undefined)).toBe(false)
    expect(isDataBehind('', '2026-10-08')).toBe(false)
  })

  it('用户快照缺数据时快照级判据不标滞后', () => {
    // Given: 尚未落地任何快照
    // When: 走两个快照级判据
    // Then: 都返回 false（加载态不挂滞后徽标）
    expect(sentimentDataStale(undefined)).toBe(false)
    expect(sectorsDataStale(undefined)).toBe(false)
  })
})

describe('format 空值口径', () => {
  it('用户面对 null/undefined/NaN 时一律渲染占位符而非零值', () => {
    // Given: 空值三态
    // When: 走三个格式化函数
    // Then: 全部输出 —（docs/api.md：null 不应补成数值零）
    expect(formatPct(null)).toBe('—')
    expect(formatPct(undefined)).toBe('—')
    expect(formatSigned(Number.NaN)).toBe('—')
    expect(formatNum(null)).toBe('—')
  })

  it('用户面对正常数值时输出百分数/带符号差值', () => {
    // Given: 上游已是百分数口径的数值（1.5 表示 1.5%）
    // When: 格式化
    // Then: 直出不换算，带符号差值正数补 +
    expect(formatPct(1.664)).toBe('1.66%')
    expect(formatSigned(13.41, 1)).toBe('+13.4')
    expect(formatSigned(-0.378, 2)).toBe('-0.38')
  })
})
