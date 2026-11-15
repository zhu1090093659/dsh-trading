/**
 * 指标输出的线型与价格轴标签（止损线/支撑线这类参考线的渲染契约）。
 *
 * 契约：IndicatorOutput 的 lineStyle / showLastValue 都是**可选**字段，缺省值分别是
 * 'solid' 与 false——存量指标的渲染必须逐字不变（实线、不挂轴标签）。声明了才生效：
 * 'dashed' 映射到 lightweight-charts 的 LineStyle.Dashed，showLastValue 打开
 * lastValueVisible，使该序列最新值以实心价签落在所属价格轴上（主图叠加为左轴）。
 */
import { describe, expect, it } from 'vitest'
import { LineStyle } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, SeriesType, UTCTimestamp } from 'lightweight-charts'
import type { IndicatorOutput } from '@dshtrading/indicators'
import { syncIndicators } from '../src/client/TvChart.tsx'
import type { TvIndicatorGroup } from '../src/client/TvChart.tsx'

interface FakeSeriesRecord {
  pane: number
  options: Record<string, unknown>
}

/** 只实现 syncIndicators 用到的 addSeries/removeSeries（jsdom 无 canvas）。 */
function createFakeChart(): { chart: IChartApi; created: FakeSeriesRecord[] } {
  const created: FakeSeriesRecord[] = []
  const chart = {
    addSeries: (_definition: unknown, options: Record<string, unknown> = {}, paneIndex = 0): ISeriesApi<SeriesType> => {
      const record: FakeSeriesRecord = { pane: paneIndex, options: { ...options } }
      const api = {
        applyOptions: (next: Record<string, unknown>): void => { record.options = { ...record.options, ...next } },
        options: (): Record<string, unknown> => ({ ...record.options }),
        setData: (): void => undefined,
      } as unknown as ISeriesApi<SeriesType>
      created.push(record)
      return api
    },
    removeSeries: (): void => undefined,
  }
  return { chart: chart as unknown as IChartApi, created }
}

const TIME_AXIS = [1_700_000_000, 1_700_086_400, 1_700_172_800] as UTCTimestamp[]
const GROUP_KEY = 'stoploss:5,1.2,1.5,8,0,0,1'

function group(outputs: readonly IndicatorOutput[]): TvIndicatorGroup {
  return { key: GROUP_KEY, title: '综合止损线', outputs }
}

function sync(chart: IChartApi, outputs: readonly IndicatorOutput[]): void {
  const refs = new Map<string, Map<string, ISeriesApi<SeriesType>>>()
  syncIndicators(chart, refs, [group(outputs)], TIME_AXIS, false, 0, false)
}

describe('指标输出的线型与价格轴标签', () => {
  it('用户声明虚线并要求轴标签的参考线，建序列时拿到 Dashed 与 lastValueVisible', () => {
    // Given 一条止损线输出：绿色虚线、要在左轴挂价签
    const fake = createFakeChart()
    const slNow: IndicatorOutput = {
      key: 'SL_NOW',
      kind: 'line',
      color: '#2ba471',
      values: [44.816, 44.816, 44.816],
      lineWidth: 2,
      precision: 3,
      lineStyle: 'dashed',
      showLastValue: true,
    }

    // When 同步进主图叠加
    sync(fake.chart, [slNow])

    // Then 序列落在主图（pane 0），走左轴价格刻度，线型与轴标签按声明生效
    expect(fake.created).toHaveLength(1)
    expect(fake.created[0]?.pane).toBe(0)
    expect(fake.created[0]?.options.lineStyle).toBe(LineStyle.Dashed)
    expect(fake.created[0]?.options.lastValueVisible).toBe(true)
    expect(fake.created[0]?.options.priceScaleId).toBe('left')
    expect(fake.created[0]?.options.color).toBe('#2ba471')
  })

  it('用户不声明这两个字段时，存量输出维持实线与不挂轴标签', () => {
    // Given 一条普通均线式输出（没有 lineStyle / showLastValue）
    const fake = createFakeChart()
    const ma: IndicatorOutput = {
      key: 'MA',
      kind: 'line',
      color: '#e6a23c',
      values: [10, 11, 12],
      precision: 2,
    }

    // When 同步进主图叠加
    sync(fake.chart, [ma])

    // Then 线型回落 Solid、轴标签保持关闭（与本次改动前逐字一致）
    expect(fake.created[0]?.options.lineStyle).toBe(LineStyle.Solid)
    expect(fake.created[0]?.options.lastValueVisible).toBe(false)
  })

  it('用户给 area 输出声明线型时生效，histogram 不受影响', () => {
    // Given 一条声明虚线的 area 与一条 histogram
    const fake = createFakeChart()
    const area: IndicatorOutput = {
      key: 'BAND',
      kind: 'area',
      color: '#3b82f6',
      values: [1, 2, 3],
      lineStyle: 'dotted',
      showLastValue: true,
    }
    const hist: IndicatorOutput = {
      key: 'MACD',
      kind: 'histogram',
      color: '#e64545',
      values: [1, -1, 2],
    }

    // When 同组同步
    sync(fake.chart, [area, hist])

    // Then area 拿到点线并挂轴标签；histogram 不产生线型、也不挂轴标签
    expect(fake.created[0]?.options.lineStyle).toBe(LineStyle.Dotted)
    expect(fake.created[0]?.options.lastValueVisible).toBe(true)
    expect(fake.created[1]?.options.lineStyle).toBeUndefined()
    expect(fake.created[1]?.options.lastValueVisible).toBe(false)
  })
})
