/**
 * 主图叠加组的组内输出结构 diff（KDAS 关键日线增删直测）。
 *
 * 事故背景（2026-10-23 owner 报告）：日 K 右键「设为关键日」后读数行当场多一行，图上的线
 * 却要整页刷新才出现，而刷新会把全部行情重取一遍。根因在 TvChart.syncIndicators：主图叠加
 * 序列只在「组首次出现」时按当时的输出集建立——KDAS 这类实例与组键都不变、输出键随参数
 * 增删的指标（每条关键日一条 `KDAS_YY-MM-DD`）新增的输出永远等不到序列，被移除的输出也
 * 永远留在图上。副图走整组重建（recreateAll=true）不受影响，故本用例只钉主图叠加路径。
 *
 * jsdom 无 canvas、createChart 不可用，照 tv-chart-sub-pane 先例用手写最小图表契约假体重放
 * syncIndicators（不引通用 mock 工具）。
 */
import { describe, expect, it } from 'vitest'
import type { IChartApi, ISeriesApi, SeriesType, UTCTimestamp } from 'lightweight-charts'
import type { IndicatorOutput } from '@dshtrading/indicators'
import { syncIndicators } from '../src/client/TvChart.tsx'
import type { TvIndicatorGroup } from '../src/client/TvChart.tsx'
import { kdasOutputKey } from '../src/client/kdas-menu.ts'

/** 假体系列的记账：落到哪个 pane、收到过哪些数据写入。 */
interface FakeSeriesRecord {
  pane: number
  options: Record<string, unknown>
  dataWrites: Array<Array<{ time: UTCTimestamp; value: number }>>
}

interface FakeChart {
  chart: IChartApi
  /** 按建立顺序记录的序列。 */
  created: FakeSeriesRecord[]
  /** 已撤下的序列（记录 + 当时的序列句柄）。 */
  removed: Array<{ record: FakeSeriesRecord; series: ISeriesApi<SeriesType> }>
}

/** 手写最小图表契约假体：只实现 syncIndicators 用到的 addSeries/removeSeries。 */
function createFakeChart(): FakeChart {
  const created: FakeSeriesRecord[] = []
  const removed: Array<{ record: FakeSeriesRecord; series: ISeriesApi<SeriesType> }> = []
  const byApi = new Map<ISeriesApi<SeriesType>, FakeSeriesRecord>()
  const chart = {
    addSeries: (_definition: unknown, options: Record<string, unknown> = {}, paneIndex = 0): ISeriesApi<SeriesType> => {
      const record: FakeSeriesRecord = { pane: paneIndex, options: { ...options }, dataWrites: [] }
      const api = {
        applyOptions: (next: Record<string, unknown>): void => { record.options = { ...record.options, ...next } },
        options: (): Record<string, unknown> => ({ ...record.options }),
        setData: (data: Array<{ time: UTCTimestamp; value: number }>): void => { record.dataWrites.push(data) },
      } as unknown as ISeriesApi<SeriesType>
      created.push(record)
      byApi.set(api, record)
      return api
    },
    removeSeries: (series: ISeriesApi<SeriesType>): void => {
      const record = byApi.get(series)
      if (record === undefined) return
      byApi.delete(series)
      removed.push({ record, series })
    },
  }
  return { chart: chart as unknown as IChartApi, created, removed }
}

const TIME_AXIS = [1_700_000_000, 1_700_086_400, 1_700_172_800] as UTCTimestamp[]
/** KDAS 组键：instanceKey 由实例全局 params 组成，菜单写 symbolParams 时它不变。 */
const KDAS_GROUP_KEY = 'kdas:0,0,0,0,0,0,0,0'

function kdasLine(kd: number, values: IndicatorOutput['values']): IndicatorOutput {
  return { key: kdasOutputKey(kd), kind: 'line', color: '#8e95a3', values, precision: 3 }
}

function kdasGroup(outputs: readonly IndicatorOutput[]): TvIndicatorGroup {
  return { key: KDAS_GROUP_KEY, title: 'KDAS', outputs }
}

/** 一次主图叠加同步（与 TvChart 的 mainRefs 调用同参：recreateAll=false、basePane=0）。 */
function syncMain(chart: IChartApi, refs: Map<string, Map<string, ISeriesApi<SeriesType>>>, groups: readonly TvIndicatorGroup[]): void {
  syncIndicators(chart, refs, groups, TIME_AXIS, false, 0, false)
}

describe('主图叠加组的组内输出 diff', () => {
  it('用户右键设为关键日后，新关键日线当场建序列并拿到数据，不需要刷新图表', () => {
    // Given 图上已有一条关键日线（kd 20250821，锚点在第二根）
    const fake = createFakeChart()
    const refs = new Map<string, Map<string, ISeriesApi<SeriesType>>>()
    syncMain(fake.chart, refs, [kdasGroup([kdasLine(20250821, [undefined, 11, 12])])])
    const firstLine = fake.created[0]

    // When 同一个实例（组键不变）又写入一个关键日 kd 20261008
    syncMain(fake.chart, refs, [kdasGroup([
      kdasLine(20250821, [undefined, 11, 12]),
      kdasLine(20261008, [undefined, undefined, 20]),
    ])])

    // Then 新线当场建出序列并绘制，而不是等下一次整图重建
    expect(fake.created).toHaveLength(2)
    expect(fake.created[1]?.pane).toBe(0)
    expect(fake.created[1]?.dataWrites[fake.created[1].dataWrites.length - 1]).toEqual([{ time: TIME_AXIS[2], value: 20 }])
    // Then 既有那条线复用原序列、只刷新数据（不重建、不清空重画）
    expect(fake.created[0]).toBe(firstLine)
    expect(firstLine?.dataWrites[firstLine.dataWrites.length - 1]).toEqual([
      { time: TIME_AXIS[1], value: 11 },
      { time: TIME_AXIS[2], value: 12 },
    ])
    expect(fake.removed).toHaveLength(0)
    // Then 组内序列表登记两条输出
    expect([...(refs.get(KDAS_GROUP_KEY)?.keys() ?? [])]).toEqual([kdasOutputKey(20250821), kdasOutputKey(20261008)])
  })

  it('用户移除一个关键日后，那条线当场从图上撤下，其余关键日线不受影响', () => {
    // Given 图上已有两条关键日线
    const fake = createFakeChart()
    const refs = new Map<string, Map<string, ISeriesApi<SeriesType>>>()
    syncMain(fake.chart, refs, [kdasGroup([
      kdasLine(20250821, [undefined, 11, 12]),
      kdasLine(20261008, [undefined, undefined, 20]),
    ])])
    const keptLine = fake.created[0]
    const droppedLine = fake.created[1]

    // When 菜单把 kd 20261008 那个槽位归零（输出集收缩为一条）
    syncMain(fake.chart, refs, [kdasGroup([kdasLine(20250821, [undefined, 11, 13])])])

    // Then 被移除的关键日线当场撤下，图上不留旧线
    expect(fake.removed).toHaveLength(1)
    expect(fake.removed[0]?.record).toBe(droppedLine)
    // Then 保留下来的线仍是原序列，只更新数据
    expect(fake.created).toHaveLength(2)
    expect(fake.created[0]).toBe(keptLine)
    expect(keptLine?.dataWrites[keptLine.dataWrites.length - 1]).toEqual([
      { time: TIME_AXIS[1], value: 11 },
      { time: TIME_AXIS[2], value: 13 },
    ])
    // Then 组内序列表只剩保留的那条
    expect([...(refs.get(KDAS_GROUP_KEY)?.keys() ?? [])]).toEqual([kdasOutputKey(20250821)])
  })

  it('用户盯盘时同一份输出重复同步不重建任何序列（ticker 轮询与 30s resync 都不闪断）', () => {
    // Given 两条关键日线已同步一次
    const fake = createFakeChart()
    const refs = new Map<string, Map<string, ISeriesApi<SeriesType>>>()
    const groups = kdasGroup([
      kdasLine(20250821, [undefined, 11, 12]),
      kdasLine(20261008, [undefined, undefined, 20]),
    ])
    syncMain(fake.chart, refs, [groups])

    // When 输出集完全相同的下一拍同步
    syncMain(fake.chart, refs, [kdasGroup([
      kdasLine(20250821, [undefined, 11, 12]),
      kdasLine(20261008, [undefined, undefined, 21]),
    ])])

    // Then 一条序列都没新建、没撤下，只有数据刷新
    expect(fake.created).toHaveLength(2)
    expect(fake.removed).toHaveLength(0)
    expect(fake.created[1]?.dataWrites[fake.created[1].dataWrites.length - 1]).toEqual([{ time: TIME_AXIS[2], value: 21 }])
  })
})
