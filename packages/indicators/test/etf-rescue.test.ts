/**
 * ETF托底预置指标单测（冻结规格）：元数据（id/title/pane/params/markets/aux/两条输出）、
 * 两条序列逐日对齐与长度严格性、warm-up 留空、缺读数日断开（无前向填充）、周 K 区间
 * 内取最新点、无数据返回空输出（空 ≠ 0）、单条序列不足以出图、脏数据断开、旧宿主误调
 * compute 不画线、市场可用性。
 */
import { describe, expect, it } from 'vitest'
import type { AuxPoint, IndicatorDefinition, Kline } from '../src/index.ts'
import { isDefinitionAvailableOn, presetDefinitions } from '../src/index.ts'

const DAY = 86_400_000
/** 外部序列键（冻结字面量，与宿主 prefetch 键同名）。 */
const DEPTH_KEY = 'cn-etf-rescue-depth'
const BREADTH_KEY = 'cn-etf-rescue-breadth'

function day(year: number, month: number, date: number): number {
  return Date.UTC(year, month - 1, date)
}

function dailyBar(tradingDay: number): Kline {
  return {
    openTime: tradingDay,
    closeTime: tradingDay + DAY - 1,
    open: 10, high: 11, low: 9, close: 10.5, volume: 100,
  }
}

/** 覆盖指定首末日（闭区间）的周 K：用于区间端点与区间内无点的边界用例。 */
function spanBar(periodStart: number, periodEnd: number): Kline {
  return {
    openTime: periodStart,
    closeTime: periodEnd + DAY - 1,
    open: 10, high: 11, low: 9, close: 10.5, volume: 500,
  }
}

function etfRescueDefinition(): IndicatorDefinition {
  const definition = presetDefinitions().find(entry => entry.id === 'cn-etf-rescue')
  if (definition === undefined) throw new Error('preset cn-etf-rescue missing')
  return definition
}

/** 取该 definition 的 aux 输出（无 aux 输出时返回空数组，便于断言「空 ≠ 0」）。 */
function auxOutputs(bars: readonly Kline[], aux: Record<string, readonly AuxPoint[]>) {
  return etfRescueDefinition().computeAux?.(bars, {}, aux) ?? []
}

describe('ETF托底预置定义', () => {
  it('用户看指标选择器时，该指标仅 A 股可用、副图、无参数、不默认上图，并声明深度与广度两条外部序列', () => {
    // Given: 预置定义名册里的 ETF托底
    const definition = etfRescueDefinition()
    // When: 读取其展示、适用范围与外部序列声明
    const { pane, title, params, markets, aux } = definition
    // Then: 冻结规格逐项成立
    expect(definition.id).toBe('cn-etf-rescue')
    expect(title).toBe('ETF托底')
    expect(pane).toBe('sub')
    expect(params).toEqual([])
    expect(markets).toEqual(['cn'])
    expect(aux).toEqual([DEPTH_KEY, BREADTH_KEY])
    expect(definition.defaultActive).toBeUndefined()
  })

  it('用户看日 K 时，深度线与广度线逐日对齐、长度等于 K 线数，样式按冻结规格', () => {
    // Given: 三个交易日的日 K 与两天的深度 / 广度读数
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6)), dailyBar(day(2026, 10, 7))]
    const depth: AuxPoint[] = [
      { date: day(2026, 10, 5), value: 5.25 },
      { date: day(2026, 10, 6), value: 5.5 },
      { date: day(2026, 10, 7), value: 5.75 },
    ]
    const breadth: AuxPoint[] = [
      { date: day(2026, 10, 5), value: 9.1 },
      { date: day(2026, 10, 6), value: 9.35 },
      { date: day(2026, 10, 7), value: 9.5 },
    ]
    // When: 走 computeAux 入口
    const outputs = auxOutputs(bars, { [DEPTH_KEY]: depth, [BREADTH_KEY]: breadth })
    // Then: 两条 line 输出，key / 配色 / 精度按冻结规格
    expect(outputs).toHaveLength(2)
    expect(outputs[0]?.key).toBe('ETF渗透%')
    expect(outputs[0]?.kind).toBe('line')
    expect(outputs[0]?.color).toBe('#e64545')
    expect(outputs[0]?.precision).toBe(2)
    expect(outputs[1]?.key).toBe('非300渗透%')
    expect(outputs[1]?.kind).toBe('line')
    expect(outputs[1]?.color).toBe('#3b82f6')
    expect(outputs[1]?.precision).toBe(2)
    // Then: 数值与交易日一一对应，两条序列长度都严格等于 K 线数
    expect(outputs[0]?.values).toEqual([5.25, 5.5, 5.75])
    expect(outputs[1]?.values).toEqual([9.1, 9.35, 9.5])
    expect(outputs[0]?.values).toHaveLength(bars.length)
    expect(outputs[1]?.values).toHaveLength(bars.length)
  })

  it('用户看序列起点之前的 K 线时，两条线都留空而不是回填', () => {
    // Given: 深度与广度的日频序列都从第二个交易日才开始
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6)), dailyBar(day(2026, 10, 7))]
    const depth: AuxPoint[] = [
      { date: day(2026, 10, 6), value: 5.5 },
      { date: day(2026, 10, 7), value: 5.75 },
    ]
    const breadth: AuxPoint[] = [
      { date: day(2026, 10, 6), value: 9.35 },
      { date: day(2026, 10, 7), value: 9.5 },
    ]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [DEPTH_KEY]: depth, [BREADTH_KEY]: breadth })
    // Then: 首根两条线都是 undefined（warm-up 不画），长度仍与 K 线一致
    expect(outputs[0]?.values).toEqual([undefined, 5.5, 5.75])
    expect(outputs[1]?.values).toEqual([undefined, 9.35, 9.5])
    expect(outputs[0]?.values).toHaveLength(bars.length)
    expect(outputs[1]?.values).toHaveLength(bars.length)
  })

  it('用户当期没取到读数时，该日两条线都断开而不是沿用前一交易日', () => {
    // Given: 三根日 K，中间那天两条序列都缺点（缺份额 / 缺净值导致当日不出点）
    const bars = [dailyBar(day(2026, 10, 12)), dailyBar(day(2026, 10, 13)), dailyBar(day(2026, 10, 14))]
    const depth: AuxPoint[] = [
      { date: day(2026, 10, 12), value: 5.4 },
      { date: day(2026, 10, 14), value: 5.6 },
    ]
    const breadth: AuxPoint[] = [
      { date: day(2026, 10, 12), value: 9.2 },
      { date: day(2026, 10, 14), value: 9.4 },
    ]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [DEPTH_KEY]: depth, [BREADTH_KEY]: breadth })
    // Then: 缺读数那天留空，昨日读数不冒充今日——既不前向铺到次根，也不回填到前一根
    expect(outputs[0]?.values).toEqual([5.4, undefined, 5.6])
    expect(outputs[1]?.values).toEqual([9.2, undefined, 9.4])
  })

  it('用户看周 K 时，每根取该周区间内最新一条读数，区间内无点的周留空', () => {
    // Given: 两根周 K（10-05~10-09、10-12~10-16），前一周区间内有两条读数，后一周只有 10-19（区间外）
    const bars = [spanBar(day(2026, 10, 5), day(2026, 10, 9)), spanBar(day(2026, 10, 12), day(2026, 10, 16))]
    const depth: AuxPoint[] = [
      { date: day(2026, 10, 6), value: 5.3 },
      { date: day(2026, 10, 9), value: 5.6 },
      { date: day(2026, 10, 19), value: 5.9 },
    ]
    const breadth: AuxPoint[] = [
      { date: day(2026, 10, 6), value: 9.0 },
      { date: day(2026, 10, 9), value: 9.3 },
      { date: day(2026, 10, 19), value: 9.8 },
    ]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [DEPTH_KEY]: depth, [BREADTH_KEY]: breadth })
    // Then: 前一周取区间内最新的 10-09（不是区间内的 10-06，也不越界取下一周的值）；后一周区间内无点
    expect(outputs[0]?.values).toEqual([5.6, undefined])
    expect(outputs[1]?.values).toEqual([9.3, undefined])
  })

  it('用户尚未取到外部数据时，该指标输出空数组而不是零线', () => {
    // Given: 有 K 线但宿主没注入两条序列（键缺失）与注入了空序列两种情形
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6))]
    // When: 各种缺数据组合各算一次
    const missingBoth = auxOutputs(bars, {})
    const emptyBoth = auxOutputs(bars, { [DEPTH_KEY]: [], [BREADTH_KEY]: [] })
    // Then: 都是空输出（消费方据此隐藏整块副图 pane），绝不降级为 0 值曲线
    expect(missingBoth).toEqual([])
    expect(emptyBoth).toEqual([])
  })

  it('用户只取到一条序列时，该指标输出空数组而不是画半块副图', () => {
    // Given: 深度取到了、广度没取到（反之亦然）的两种组合
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6))]
    const depth: AuxPoint[] = [{ date: day(2026, 10, 5), value: 5.3 }, { date: day(2026, 10, 6), value: 5.4 }]
    const breadth: AuxPoint[] = [{ date: day(2026, 10, 5), value: 9.0 }, { date: day(2026, 10, 6), value: 9.1 }]
    // When: 分别只注入一条
    const onlyDepth = auxOutputs(bars, { [DEPTH_KEY]: depth })
    const onlyBreadth = auxOutputs(bars, { [BREADTH_KEY]: breadth })
    const emptyBreadth = auxOutputs(bars, { [DEPTH_KEY]: depth, [BREADTH_KEY]: [] })
    // Then: 缺一条就不出图——半块副图会让读图的人把缺的那条当成 0
    expect(onlyDepth).toEqual([])
    expect(onlyBreadth).toEqual([])
    expect(emptyBreadth).toEqual([])
  })

  it('用户遇到脏数据（NaN / 无穷）时，该点两条线都断开', () => {
    // Given: 两条外部序列里混入 NaN 与 Infinity
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6)), dailyBar(day(2026, 10, 7))]
    const depth: AuxPoint[] = [
      { date: day(2026, 10, 5), value: Number.NaN },
      { date: day(2026, 10, 6), value: Number.POSITIVE_INFINITY },
      { date: day(2026, 10, 7), value: 5.75 },
    ]
    const breadth: AuxPoint[] = [
      { date: day(2026, 10, 5), value: Number.NEGATIVE_INFINITY },
      { date: day(2026, 10, 6), value: Number.NaN },
      { date: day(2026, 10, 7), value: 9.5 },
    ]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [DEPTH_KEY]: depth, [BREADTH_KEY]: breadth })
    // Then: 非有限值一律落成 undefined（曲线断开），有限值保留，长度不变且无 NaN 泄漏
    expect(outputs[0]?.values).toEqual([undefined, undefined, 5.75])
    expect(outputs[1]?.values).toEqual([undefined, undefined, 9.5])
    expect(outputs[0]?.values).toHaveLength(bars.length)
    expect(outputs[1]?.values).toHaveLength(bars.length)
    expect((outputs[0]?.values ?? []).some(value => typeof value === 'number' && !Number.isFinite(value))).toBe(false)
    expect((outputs[1]?.values ?? []).some(value => typeof value === 'number' && !Number.isFinite(value))).toBe(false)
  })

  it('用户用未升级的宿主直接调 compute 时，该指标不报错也不画线', () => {
    // Given: 声明了 aux 的 definition 与一段 K 线
    const definition = etfRescueDefinition()
    const bars = [dailyBar(day(2026, 10, 5))]
    // When: 旧宿主走 compute 入口（新宿主只认 computeAux）
    const outputs = definition.compute(bars, {})
    // Then: 空输出，等价于不画任何东西
    expect(outputs).toEqual([])
  })

  it('用户切换市场时，该指标只在 A 股可用', () => {
    // Given: ETF托底 definition
    const definition = etfRescueDefinition()
    // When: 分别按 A 股 / 港股 / 美股判定可用性
    const cn = isDefinitionAvailableOn(definition, 'cn')
    const hk = isDefinitionAvailableOn(definition, 'hk')
    const us = isDefinitionAvailableOn(definition, 'us')
    // Then: 只有 A 股为真
    expect(cn).toBe(true)
    expect(hk).toBe(false)
    expect(us).toBe(false)
  })
})
