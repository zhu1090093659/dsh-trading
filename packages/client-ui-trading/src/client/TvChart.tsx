/**
 * TradingView lightweight-charts v5 封装——中栏行情渲染器（富途牛牛视觉风格）。
 *
 * 结构：pane 0 = 蜡烛 + 主图叠加指标；pane 1 = 成交量；pane 2+ = 每个
 * 副图指标独占一 pane（v5 原生 panes）。渲染层对指标实现零感知，只消费
 * 注册表 compute 的输出（@dsh-trading/indicators 注册表）。
 *
 * 视觉对齐：
 * - 红涨绿跌（#e64545 / #2ba471）
 * - 当前最新价水平虚线与坐标轴实心价签
 * - 紧凑网格与等宽数字
 */
import { useEffect, useRef } from 'react'
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart,
} from 'lightweight-charts'
import type {
  IChartApi, ISeriesApi, MouseEventParams, SeriesType, Time, UTCTimestamp,
} from 'lightweight-charts'
import { DOWN_COLOR, UP_COLOR, fmtAxis, priceDigits } from './format.ts'
import type { IndicatorOutput } from '@dsh-trading/indicators'
import type { Kline } from './types.ts'

export interface TvBar {
  time: UTCTimestamp
  open: number
  high: number
  low: number
  close: number
}

export interface TvVolume {
  time: UTCTimestamp
  value: number
  color: string
}

/** 一个指标实例的渲染输入（key = instanceKey，diff 锚点）。 */
export interface TvIndicatorGroup {
  key: string
  outputs: readonly IndicatorOutput[]
}

export interface TvChartProps {
  bars: readonly TvBar[]
  volumes: readonly TvVolume[]
  /** market:symbol:interval——变化即全量重置并 fitContent。 */
  dataKey: string
  intraday: boolean
  mainOverlays: readonly TvIndicatorGroup[]
  subIndicators: readonly TvIndicatorGroup[]
  /** 十字线悬停的 K 线下标（离场为 null），父级负责 OHLC 读数。 */
  onHoverIndex: (index: number | null) => void
}

/** kline → 图表 bar（openTime 毫秒 → UTC 秒）。 */
export function toBar(kline: Kline): TvBar {
  return {
    time: Math.floor(kline.openTime / 1000) as UTCTimestamp,
    open: kline.open,
    high: kline.high,
    low: kline.low,
    close: kline.close,
  }
}

export function toVolume(kline: Kline): TvVolume {
  const up = kline.close >= kline.open
  return {
    time: Math.floor(kline.openTime / 1000) as UTCTimestamp,
    value: kline.volume,
    color: up ? 'rgba(230, 69, 69, 0.55)' : 'rgba(43, 164, 113, 0.55)',
  }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

function localDate(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function localTime(ms: number): string {
  const date = new Date(ms)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

const CHART_BASE = {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid, color: '#ffffff' },
    textColor: '#5f6672',
    fontSize: 10.5,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, sans-serif',
    panes: {
      separatorColor: '#e3e6ea',
      separatorHoverColor: '#c8cdd4',
      enableResize: true,
    },
  },
  grid: {
    vertLines: { color: '#f5f6f8' },
    horzLines: { color: '#f0f2f5' },
  },
  rightPriceScale: {
    borderColor: '#e5e7eb',
    scaleMargins: { top: 0.08, bottom: 0.08 },
    entireTextOnly: true,
  },
  timeScale: {
    borderColor: '#e5e7eb',
    rightOffset: 6,
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: {
      color: '#8e95a3',
      width: 1,
      style: LineStyle.Dashed,
      labelBackgroundColor: '#1a1e24',
    },
    horzLine: {
      color: '#8e95a3',
      width: 1,
      style: LineStyle.Dashed,
      labelBackgroundColor: '#1a1e24',
    },
  },
} as const

export function TvChart(props: TvChartProps): React.JSX.Element {
  const { bars, volumes, dataKey, intraday, mainOverlays, subIndicators, onHoverIndex } = props

  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  /** 主图/副图各一张序列表：groupKey → outputKey → series（结构 diff 用）。 */
  const mainRefs = useRef(new Map<string, Map<string, ISeriesApi<SeriesType>>>())
  const subRefs = useRef(new Map<string, Map<string, ISeriesApi<SeriesType>>>())
  /** 最新 props 快照，供只跑一次的 chart 工厂与事件回调读取。 */
  const propsRef = useRef(props)
  propsRef.current = props

  // ---- 图表生命周期（仅挂载/卸载各一次） ----
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const chart = createChart(container, {
      ...CHART_BASE,
      localization: {
        timeFormatter: (time: Time): string => {
          const ms = Number(time) * 1000
          return propsRef.current.intraday ? `${localDate(ms)} ${localTime(ms)}` : localDate(ms)
        },
      },
      timeScale: {
        ...CHART_BASE.timeScale,
        tickMarkFormatter: (time: Time): string => fmtAxis(Number(time) * 1000, propsRef.current.intraday),
      },
    })
    chartRef.current = chart

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      borderDownColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      priceLineVisible: true,
      priceLineWidth: 1,
      priceLineStyle: LineStyle.Dashed,
      lastValueVisible: true,
    })
    candleRef.current = candles

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
    }, 1)
    volumeRef.current = volume

    applyStretch(chart)

    const onCrosshair = (param: MouseEventParams): void => {
      if (param.logical === undefined || param.time === undefined) {
        propsRef.current.onHoverIndex(null)
        return
      }
      propsRef.current.onHoverIndex(param.logical)
    }
    chart.subscribeCrosshairMove(onCrosshair)

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair)
      mainRefs.current.clear()
      subRefs.current.clear()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
    }
  }, [])

  // ---- 蜡烛/成交量：dataKey 变化全量重置，否则尾部增量 ----
  const prevRef = useRef<{ key: string; bars: readonly TvBar[]; volumes: readonly TvVolume[] } | null>(null)
  useEffect(() => {
    const candles = candleRef.current
    const volume = volumeRef.current
    const chart = chartRef.current
    if (candles === null || volume === null || chart === null) return
    const prev = prevRef.current
    prevRef.current = { key: dataKey, bars, volumes }

    const last = bars[bars.length - 1]
    const up = last !== undefined ? last.close >= last.open : true
    const priceFormat = { type: 'price' as const, precision: priceDigits(last?.close), minMove: 1 / 10 ** priceDigits(last?.close) }
    candles.applyOptions({
      priceFormat,
      priceLineColor: up ? UP_COLOR : DOWN_COLOR,
    })

    if (prev === null || prev.key !== dataKey || bars.length < prev.bars.length || firstTimeDiffers(prev.bars, bars)) {
      candles.setData(bars as TvBar[])
      volume.setData(volumes as TvVolume[])
      chart.timeScale().fitContent()
      return
    }
    for (let index = Math.max(prev.bars.length - 1, 0); index < bars.length; index++) {
      candles.update(bars[index] as TvBar)
      volume.update(volumes[index] as TvVolume)
    }
  }, [bars, volumes, dataKey])

  // ---- 指标序列：结构 diff + 数据同步 ----
  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    // 注册表契约：outputs.values 与 bars 等长——时间轴由 bars 给出。
    const timeAxis = bars.map(bar => bar.time)
    syncGroups(chart, mainRefs.current, mainOverlays, 0, timeAxis)
    syncGroups(chart, subRefs.current, subIndicators, 2, timeAxis, true)
    applyStretch(chart)
  }, [mainOverlays, subIndicators, bars])

  return <div className="dshtrading-tv-chart" ref={containerRef} style={{ width: '100%', height: '100%' }} />
}

/** 主图叠加（pane 0）与副图（pane 2+，重建式）两套 diff 策略。 */
function syncGroups(
  chart: IChartApi,
  refs: Map<string, Map<string, ISeriesApi<SeriesType>>>,
  groups: readonly TvIndicatorGroup[],
  basePane: number,
  timeAxis: readonly UTCTimestamp[],
  recreateAll = false,
): void {
  const nextKeys = new Set(groups.map(group => group.key))

  // 卸载不在场的组（重建模式下全部先卸）。
  for (const [groupKey, seriesMap] of refs) {
    const keep = nextKeys.has(groupKey) && !recreateAll
    if (keep) continue
    for (const series of seriesMap.values()) chart.removeSeries(series)
    refs.delete(groupKey)
  }

  groups.forEach((group, groupIndex) => {
    let seriesMap = refs.get(group.key)
    if (seriesMap === undefined) {
      seriesMap = new Map()
      refs.set(group.key, seriesMap)
      // 重建模式：pane 随激活顺序对齐（basePane+i），series 需按 pane 归属重建。
      const paneIndex = recreateAll ? basePane + groupIndex : basePane
      for (const output of group.outputs) {
        seriesMap.set(output.key, createSeries(chart, output, paneIndex))
      }
    }
    for (const output of group.outputs) {
      const series = seriesMap.get(output.key)
      if (series === undefined) continue
      if (output.kind === 'histogram') {
        ;(series as ISeriesApi<'Histogram'>).setData(toHistogramData(output, timeAxis))
      } else {
        ;(series as ISeriesApi<'Line'>).setData(toLineData(output, timeAxis))
      }
    }
  })
}

function createSeries(chart: IChartApi, output: IndicatorOutput, paneIndex: number): ISeriesApi<SeriesType> {
  if (output.kind === 'histogram') {
    return chart.addSeries(HistogramSeries, {
      color: output.color,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    }, paneIndex)
  }
  return chart.addSeries(LineSeries, {
    color: output.color,
    lineWidth: 1.2,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  }, paneIndex)
}

function toLineData(output: IndicatorOutput, timeAxis: readonly UTCTimestamp[]): Array<{ time: UTCTimestamp; value: number }> {
  const data: Array<{ time: UTCTimestamp; value: number }> = []
  for (let index = 0; index < output.values.length; index++) {
    const value = output.values[index]
    const time = timeAxis[index]
    if (value === undefined || !Number.isFinite(value) || time === undefined) continue
    data.push({ time, value })
  }
  return data
}

function toHistogramData(output: IndicatorOutput, timeAxis: readonly UTCTimestamp[]): Array<{ time: UTCTimestamp; value: number; color: string }> {
  const data: Array<{ time: UTCTimestamp; value: number; color: string }> = []
  for (let index = 0; index < output.values.length; index++) {
    const value = output.values[index]
    const time = timeAxis[index]
    if (value === undefined || !Number.isFinite(value) || time === undefined) continue
    const color = output.histogramBySign === true
      ? (value >= 0 ? 'rgba(230, 69, 69, 0.75)' : 'rgba(43, 164, 113, 0.75)')
      : output.color
    data.push({ time, value, color })
  }
  return data
}

function applyStretch(chart: IChartApi): void {
  const panes = chart.panes()
  if (panes[0] !== undefined) panes[0].setStretchFactor(4)
  for (let index = 1; index < panes.length; index++) {
    panes[index]?.setStretchFactor(1)
  }
}

function firstTimeDiffers(prev: readonly TvBar[], next: readonly TvBar[]): boolean {
  const common = Math.min(prev.length, next.length)
  for (let index = 0; index < common; index++) {
    if (prev[index]?.time !== next[index]?.time) return true
  }
  return false
}
