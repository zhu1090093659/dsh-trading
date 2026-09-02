/**
 * TradingView lightweight-charts v5 封装——中栏行情渲染器（富途牛牛视觉风格）。
 *
 * 结构：pane 0 = 蜡烛 + 主图叠加指标；pane 1 = 成交量；pane 2+ = 每个
 * 副图指标独占一 pane（v5 原生 panes）。渲染层对指标实现零感知，只消费
 * 注册表 compute 的输出（@dsh-trading/indicators 注册表）。
 *
 * pane 内 legend：VOL（pane 1）与副图指标（pane 2+）的读数以绝对定位
 * overlay 显示在各自 pane 左上角（悬停跟随 readoutIndex，离场回落最新值）；
 * 主图指标读数由 QuoteStage 的读数行承载，不在这里重复。
 *
 * 视觉对齐：
 * - 红涨绿跌（#e64545 / #2ba471）
 * - 当前最新价水平虚线与坐标轴实心价签
 * - 紧凑网格与等宽数字
 */
import { useEffect, useRef, useState } from 'react'
import {
  AreaSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers,
} from 'lightweight-charts'
import type {
  IChartApi, ISeriesApi, Logical, LogicalRange, MouseEventParams, SeriesType, Time, UTCTimestamp,
} from 'lightweight-charts'
import type { BarPrice, PriceFormatCustom } from 'lightweight-charts'
import { fmtAxis, fmtCompact, priceDigits } from './format.ts'
import { getColorPalette, type ColorMode } from './color-mode.ts'
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

/* ── 图表标记输入（Issue #41）──────────────────────────────── */

/** 策略信号标记输入（从 marker-state 传入）。 */
export interface ChartSignalMarkerInput {
  readonly time: number
  readonly action: 'entry' | 'exit'
  readonly price: number
  readonly reason: string
}

/** 知识事件标记输入（从 marker-state 传入）。 */
export interface ChartKnowledgeMarkerInput {
  readonly time: number
  readonly title: string
  readonly cardId: string
  readonly credibility: 'high' | 'medium' | 'low'
}

/** 悬停标记时传递给父级的详情（驱动 MarkerTooltip 渲染）。 */
export interface MarkerHoverInfo {
  /** 屏幕坐标 X。 */
  x: number
  /** 屏幕坐标 Y。 */
  y: number
  /** 策略信号数据（与 knowledge 互斥）。 */
  signal?: ChartSignalMarkerInput
  /** 知识事件数据（与 signal 互斥）。 */
  knowledge?: ChartKnowledgeMarkerInput
}

export interface TvChartProps {
  bars: readonly TvBar[]
  volumes: readonly TvVolume[]
  /** market:symbol:interval——变化即全量重置并 fitContent。 */
  dataKey: string
  intraday: boolean
  colorMode?: ColorMode
  mainOverlays: readonly TvIndicatorGroup[]
  subIndicators: readonly TvIndicatorGroup[]
  /** 悬停读数下标（null = 回落最新一根）；pane legend 与父级读数行同源。 */
  readoutIndex: number | null
  /** 十字线悬停的 K 线下标（离场为 null），父级负责 OHLC 读数。 */
  onHoverIndex: (index: number | null) => void
  /** 区间统计框选模式（2026-09-02）：true 时禁用拖拽平移/缩放，指针框选K线区间。 */
  rangeSelectionMode?: boolean | undefined
  /** 框选提交（逻辑下标闭区间；null = 点击清除）。 */
  onRangeSelect?: (range: { start: number; end: number } | null) => void
  /** 已提交的框选区间（父级持有以驱动统计面板；此处只负责高亮回显）。 */
  selection?: { start: number; end: number } | null | undefined
  /** 图表就绪时注册截图回调、卸载时以 null 注销（「发给 Agent」用）。 */
  onCaptureReady?: (capture: (() => TvChartCapture | null) | null) => void
  /** 策略回测信号标记（可选，issue #41）。 */
  signalMarkers?: readonly ChartSignalMarkerInput[]
  /** 知识事件标记（可选，issue #41）。 */
  knowledgeMarkers?: readonly ChartKnowledgeMarkerInput[]
  /** 悬停标记时回调（null = 离开标记区域；父级负责渲染 Tooltip）。 */
  onMarkerHover?: (info: MarkerHoverInfo | null) => void
}

/** 一次图表截图（PNG data URL + 像素尺寸，回显/命名用）。 */
export interface TvChartCapture {
  dataUrl: string
  width: number
  height: number
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

/**
 * 右轴价格格式（2026-09-02 相对涨跌幅轴）：镜像序列的数值仍是**价位**，仅
 * 标签经本 formatter 换算为相对参考价的百分比——两轴刻度行逐行对齐的关键。
 * 参考价从 refPriceRef 惰性读取（滚动/缩放时经 applyOptions 换新对象强制重绘）。
 * 负数带负号、正数不带正号（同花顺式）。
 */
function mirrorPercentFormat(refPriceRef: { current: number | null }): PriceFormatCustom {
  return {
    type: 'custom',
    minMove: 0.01,
    formatter: (price: BarPrice): string => {
      const ref = refPriceRef.current
      const value = Number(price)
      if (ref === null || !Number.isFinite(ref) || ref <= 0 || !Number.isFinite(value)) return ''
      const pct = (value - ref) / ref * 100
      return `${pct.toFixed(2)}%`
    },
  }
}

export function toVolume(kline: Kline, colorMode: ColorMode = 'red-up'): TvVolume {
  const up = kline.close >= kline.open
  const palette = getColorPalette(colorMode)
  return {
    time: Math.floor(kline.openTime / 1000) as UTCTimestamp,
    value: kline.volume,
    color: up ? palette.upAlpha(0.55) : palette.downAlpha(0.55),
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

export function isDarkTheme(): boolean {
  if (typeof document === 'undefined') return false
  return document.body.hasAttribute('data-ds-dark-theme')
    || document.documentElement.getAttribute('data-theme') === 'dark'
    || document.body.getAttribute('data-theme') === 'dark'
}

export function getChartThemeOptions(dark: boolean) {
  if (dark) {
    return {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor: '#787b86',
        fontSize: 10.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, sans-serif',
        panes: {
          separatorColor: '#2a2e39',
          separatorHoverColor: '#363a45',
          enableResize: true,
        },
      },
      grid: {
        vertLines: { color: '#1e222d' },
        horzLines: { color: '#1e222d' },
      },
      leftPriceScale: {
        visible: true,
        borderColor: '#2a2e39',
        scaleMargins: { top: 0.08, bottom: 0.08 },
        entireTextOnly: true,
      },
      rightPriceScale: {
        borderColor: '#2a2e39',
        scaleMargins: { top: 0.08, bottom: 0.08 },
        entireTextOnly: true,
      },
      timeScale: {
        borderColor: '#2a2e39',
        rightOffset: 6,
        barSpacing: 9,
        minBarSpacing: 0.5,
        fixLeftEdge: true,
        fixRightEdge: true,
        shiftVisibleRangeOnNewBar: true,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: '#787b86',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#2a2e39',
        },
        horzLine: {
          color: '#787b86',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#2a2e39',
        },
      },
    } as const
  }
  return {
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
    // 双价格轴（2026-09-02）：左轴=价格（蜡烛+主图指标），右轴=相对涨跌幅
    // （镜像序列把刻度值钉在与左轴相同的价位上，标签经 formatter 换算成百分比，
    // 两轴刻度行逐行对齐——同花顺式）。scaleMargins 必须两轴一致，包络范围才同映射。
    leftPriceScale: {
      visible: true,
      borderColor: '#e5e7eb',
      scaleMargins: { top: 0.08, bottom: 0.08 },
      entireTextOnly: true,
    },
    rightPriceScale: {
      borderColor: '#e5e7eb',
      scaleMargins: { top: 0.08, bottom: 0.08 },
      entireTextOnly: true,
    },
    timeScale: {
      borderColor: '#e5e7eb',
      rightOffset: 6,
      barSpacing: 9,
      minBarSpacing: 0.5,
      fixLeftEdge: true,
      fixRightEdge: true,
      shiftVisibleRangeOnNewBar: true,
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
}

export function TvChart(props: TvChartProps): React.JSX.Element {
  const { bars, volumes, dataKey, intraday, mainOverlays, subIndicators, readoutIndex, onHoverIndex } = props

  const [dark, setDark] = useState<boolean>(() => isDarkTheme())
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const markerPluginRef = useRef<ReturnType<typeof createSeriesMarkers> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  /** 右轴镜像序列（透明）：top/bottom 钉范围，close 供轴上百分比徽标。 */
  const mirrorTopRef = useRef<ISeriesApi<'Line'> | null>(null)
  const mirrorBottomRef = useRef<ISeriesApi<'Line'> | null>(null)
  const mirrorCloseRef = useRef<ISeriesApi<'Line'> | null>(null)
  /** 右轴百分比参考价（可视区最左一根K线收盘；null = 未定）。 */
  const refPriceRef = useRef<number | null>(null)
  const mirrorFormatRafRef = useRef(0)
  /** 主图/副图各一张序列表：groupKey → outputKey → series（结构 diff 用）。 */
  const mainRefs = useRef(new Map<string, Map<string, ISeriesApi<SeriesType>>>())
  const subRefs = useRef(new Map<string, Map<string, ISeriesApi<SeriesType>>>())
  /** 各 pane 顶缘 y 坐标（legend overlay 定位用）；空数组 = 尚未测量。 */
  const [paneTops, setPaneTops] = useState<number[]>([])
  /** 最新 props 快照，供只跑一次的 chart 工厂与事件回调读取。 */
  const propsRef = useRef(props)
  propsRef.current = props

  // 监听宿主主题切换（body 属性与 media query）
  useEffect(() => {
    const updateTheme = (): void => {
      setDark(isDarkTheme())
    }
    const mo = new MutationObserver(updateTheme)
    if (typeof document !== 'undefined') {
      mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-theme'] })
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    }
    const mql = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : undefined
    mql?.addEventListener('change', updateTheme)
    return () => {
      mo.disconnect()
      mql?.removeEventListener('change', updateTheme)
    }
  }, [])

  /** 参考价变化后 rAF 去抖刷新镜像 formatter（新 formatter 对象强制轴重绘）。 */
  const scheduleMirrorFormatRefresh = (): void => {
    cancelAnimationFrame(mirrorFormatRafRef.current)
    mirrorFormatRafRef.current = requestAnimationFrame(() => {
      const format = mirrorPercentFormat(refPriceRef)
      for (const series of [mirrorTopRef.current, mirrorBottomRef.current, mirrorCloseRef.current]) {
        series?.applyOptions({ priceFormat: format })
      }
    })
  }

  // ---- 图表生命周期（仅挂载/卸载各一次） ----
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const initialTheme = getChartThemeOptions(isDarkTheme())
    const chart = createChart(container, {
      ...initialTheme,
      localization: {
        timeFormatter: (time: Time): string => {
          const ms = Number(time) * 1000
          return propsRef.current.intraday ? `${localDate(ms)} ${localTime(ms)}` : localDate(ms)
        },
      },
      timeScale: {
        ...initialTheme.timeScale,
        tickMarkFormatter: (time: Time): string => fmtAxis(Number(time) * 1000, propsRef.current.intraday),
      },
    })
    chartRef.current = chart

    const initialPalette = getColorPalette(propsRef.current.colorMode)
    const candles = chart.addSeries(CandlestickSeries, {
      // 左轴承载价格（蜡烛 + 主图叠加指标都在 left）；右轴留给百分比镜像序列。
      priceScaleId: 'left',
      upColor: initialPalette.upColor,
      downColor: initialPalette.downColor,
      borderUpColor: initialPalette.upColor,
      borderDownColor: initialPalette.downColor,
      wickUpColor: initialPalette.upColor,
      wickDownColor: initialPalette.downColor,
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

    // 右轴镜像序列（主图 pane）：三根透明 LineSeries 把右轴数值范围钉在与左轴
    // 完全相同的价位集合上（最高/最低包络对齐蜡烛+主图指标的 autoscale 范围，
    // 收盘序列负责轴上当前价百分比徽标）。百分比只出现在标签 formatter 里——
    // 两侧刻度行因此逐行对齐（同花顺式右轴）。
    const mirrorBase = () => ({
      color: 'rgba(0,0,0,0)',
      lineWidth: 1 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: mirrorPercentFormat(refPriceRef),
    })
    mirrorTopRef.current = chart.addSeries(LineSeries, { ...mirrorBase() }, 0)
    mirrorBottomRef.current = chart.addSeries(LineSeries, { ...mirrorBase() }, 0)
    mirrorCloseRef.current = chart.addSeries(LineSeries, {
      ...mirrorBase(),
      lastValueVisible: true,
    }, 0)

    // 参考价 = 可视区最左一根K线收盘：滚动/缩放/换数据时经 visibleLogicalRange
    // 事件重算，rAF 去抖后刷新镜像 formatter（新对象强制轴重绘）。
    const syncRefPrice = (): void => {
      const barsNow = propsRef.current.bars
      if (barsNow.length === 0) return
      const range: LogicalRange | null = chart.timeScale().getVisibleLogicalRange()
      if (range === null) return
      const index = Math.min(barsNow.length - 1, Math.max(0, Math.ceil(range.from)))
      const close = barsNow[index]?.close
      if (close === undefined || !Number.isFinite(close) || close <= 0) return
      if (close === refPriceRef.current) return
      refPriceRef.current = close
      scheduleMirrorFormatRefresh()
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(syncRefPrice)

    applyStretch(chart)

    const onCrosshair = (param: MouseEventParams): void => {
      if (param.logical === undefined || param.time === undefined) {
        propsRef.current.onHoverIndex(null)
        return
      }
      propsRef.current.onHoverIndex(param.logical)
    }
    chart.subscribeCrosshairMove(onCrosshair)

    // 截图回调（v5 takeScreenshot 覆盖主图+副图 pane，白底、不含十字线）。
    const capture = (): TvChartCapture | null => {
      try {
        const canvas = chart.takeScreenshot()
        if (canvas === null) return null
        return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
      } catch {
        return null
      }
    }
    propsRef.current.onCaptureReady?.(capture)

    return () => {
      propsRef.current.onCaptureReady?.(null)
      chart.unsubscribeCrosshairMove(onCrosshair)
      mainRefs.current.clear()
      subRefs.current.clear()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      markerPluginRef.current?.detach()
      markerPluginRef.current = null
      volumeRef.current = null
      mirrorTopRef.current = null
      mirrorBottomRef.current = null
      mirrorCloseRef.current = null
      refPriceRef.current = null
      cancelAnimationFrame(mirrorFormatRafRef.current)
    }
  }, [])

  // 主题热切换（浅色 ↔ 深色动态 applyOptions）
  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    const themeOpts = getChartThemeOptions(dark)
    chart.applyOptions(themeOpts)
  }, [dark])

  // 涨跌配色热切换（红涨绿跌 ↔ 绿涨红跌）
  useEffect(() => {
    const palette = getColorPalette(props.colorMode)
    candleRef.current?.applyOptions({
      upColor: palette.upColor,
      downColor: palette.downColor,
      borderUpColor: palette.upColor,
      borderDownColor: palette.downColor,
      wickUpColor: palette.upColor,
      wickDownColor: palette.downColor,
    })
    if (volumeRef.current && props.volumes.length > 0) {
      volumeRef.current.setData(props.volumes)
    }
  }, [props.colorMode, props.volumes])

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
    const palette = getColorPalette(props.colorMode)
    const priceFormat = { type: 'price' as const, precision: priceDigits(last?.close), minMove: 1 / 10 ** priceDigits(last?.close) }
    candles.applyOptions({
      priceFormat,
      priceLineColor: up ? palette.upColor : palette.downColor,
    })

    if (prev === null || prev.key !== dataKey || bars.length < prev.bars.length || firstTimeDiffers(prev.bars, bars)) {
      candles.setData(bars as TvBar[])
      volume.setData(volumes as TvVolume[])
      chart.timeScale().resetTimeScale()
      chart.timeScale().scrollToRealTime()
      return
    }
    for (let index = Math.max(prev.bars.length - 1, 0); index < bars.length; index++) {
      candles.update(bars[index] as TvBar)
      volume.update(volumes[index] as TvVolume)
    }
  }, [bars, volumes, dataKey, props.colorMode])

  // ---- 策略信号 & 知识事件标记（Issue #41）────────────────────────────
  useEffect(() => {
    const candles = candleRef.current
    if (candles === null) return
    const markers: Array<{
      time: UTCTimestamp
      position: 'belowBar' | 'aboveBar'
      color: string
      shape: 'arrowUp' | 'arrowDown' | 'circle'
      text: string
    }> = []

    // 策略信号 → 绿色买入箭头 / 红色卖出箭头
    if (props.signalMarkers) {
      for (const s of props.signalMarkers) {
        const t = (s.time > 1e11 ? Math.floor(s.time / 1000) : s.time) as UTCTimestamp
        markers.push({
          time: t,
          position: s.action === 'entry' ? 'belowBar' : 'aboveBar',
          color: s.action === 'entry' ? '#22c55e' : '#ef4444',
          shape: s.action === 'entry' ? 'arrowUp' : 'arrowDown',
          text: s.action === 'entry' ? '买入' : '卖出',
        })
      }
    }

    // 知识事件 → 蓝色圆形图钉
    if (props.knowledgeMarkers) {
      for (const k of props.knowledgeMarkers) {
        const t = (k.time > 1e11 ? Math.floor(k.time / 1000) : k.time) as UTCTimestamp
        markers.push({
          time: t,
          position: 'aboveBar',
          color: '#3b82f6',
          shape: 'circle',
          text: '📌',
        })
      }
    }

    // 按 time 升序排列
    markers.sort((a, b) => (a.time as number) - (b.time as number))

    if (markerPluginRef.current === null) {
      markerPluginRef.current = createSeriesMarkers(candles, markers)
    } else {
      markerPluginRef.current.setMarkers(markers)
    }
  }, [props.signalMarkers, props.knowledgeMarkers, bars])

  // ---- 右轴镜像数据：top/bottom 包络 = 蜡烛高低 ∪ 主图指标输出（与左轴
  // autoscale 范围完全一致，两轴刻度行对齐的前提），close 序列驱动百分比徽标。
  // 全量 setData：160 根 × 3 序列，30s resync / 5s 尾随合并的节奏下成本可忽略。
  useEffect(() => {
    const top = mirrorTopRef.current
    const bottom = mirrorBottomRef.current
    const badge = mirrorCloseRef.current
    if (top === null || bottom === null || badge === null) return
    const topData: Array<{ time: UTCTimestamp; value: number }> = []
    const bottomData: Array<{ time: UTCTimestamp; value: number }> = []
    const closeData: Array<{ time: UTCTimestamp; value: number }> = []
    for (let index = 0; index < bars.length; index++) {
      const bar = bars[index]
      if (bar === undefined) continue
      let high = bar.high
      let low = bar.low
      for (const group of mainOverlays) {
        for (const output of group.outputs) {
          const value = output.values[index]
          if (value === undefined || !Number.isFinite(value)) continue
          if (value > high) high = value
          if (value < low) low = value
        }
      }
      topData.push({ time: bar.time, value: high })
      bottomData.push({ time: bar.time, value: low })
      closeData.push({ time: bar.time, value: bar.close })
    }
    top.setData(topData)
    bottom.setData(bottomData)
    badge.setData(closeData)
    // 徽标底色跟随最新一根K线方向（与左轴价格徽标同款着色逻辑）。
    const last = bars[bars.length - 1]
    const prev = bars[bars.length - 2]
    if (last !== undefined && prev !== undefined) {
      const palette = getColorPalette(propsRef.current.colorMode)
      badge.applyOptions({ priceLineColor: last.close >= prev.close ? palette.upColor : palette.downColor })
    }
  }, [bars, mainOverlays, props.colorMode])

  // ---- 指标序列：结构 diff + 数据同步 ----
  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    const timeAxis = bars.map(bar => bar.time)
    syncIndicators(chart, mainRefs.current, mainOverlays, timeAxis, false, 0, props.colorMode)
    syncIndicators(chart, subRefs.current, subIndicators, timeAxis, true, 2, props.colorMode)
    applyStretch(chart)
  }, [mainOverlays, subIndicators, bars, props.colorMode])

  // ---- pane 几何测量：legend overlay 定位用 ----
  // pane 高度随指标增删 / 容器 resize / 分隔线拖拽变化。v5 无 pane DOM 入口，
  // 以 getHeight 累加 + 容器高反推分隔条厚度定位。声明在指标同步之后，同一
  // 提交内先建 pane 再测量；rAF 等 layout 落定。
  useEffect(() => {
    const container = containerRef.current
    const chart = chartRef.current
    if (container === null || chart === null) return
    const measure = (): void => {
      const panes = chart.panes()
      if (panes.length === 0) {
        setPaneTops([])
        return
      }
      const heights = panes.map(pane => pane.getHeight())
      const gapsTotal = panes.length > 1
        ? Math.max(0, container.clientHeight - heights.reduce((sum, height) => sum + height, 0))
        : 0
      const separator = panes.length > 1 ? gapsTotal / (panes.length - 1) : 0
      const tops: number[] = []
      let acc = 0
      for (const height of heights) {
        tops.push(acc)
        acc += height + separator
      }
      setPaneTops(tops)
    }
    const raf = requestAnimationFrame(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    // 分隔线拖拽结束（pointerup）后复测，拖拽过程允许短暂滞后。
    container.addEventListener('pointerup', measure)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      container.removeEventListener('pointerup', measure)
    }
  }, [mainOverlays, subIndicators, bars, props.colorMode])

  // ---- 区间统计框选模式：禁用图表自身的拖拽平移/缩放，指针事件留给框选 ----
  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    const selecting = props.rangeSelectionMode === true
    chart.applyOptions({ handleScroll: !selecting, handleScale: !selecting })
  }, [props.rangeSelectionMode])

  // ---- 框选指针交互：按下记起点，移动更新矩形，抬起换算逻辑下标区间提交 ----
  const dragStartXRef = useRef<number | null>(null)
  const [dragRect, setDragRect] = useState<{ x1: number; x2: number } | null>(null)

  const handleRangePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (propsRef.current.rangeSelectionMode !== true || event.button !== 0) return
    const box = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - box.left
    dragStartXRef.current = x
    setDragRect({ x1: x, x2: x })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleRangePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragStartXRef.current === null) return
    const box = event.currentTarget.getBoundingClientRect()
    setDragRect({ x1: dragStartXRef.current, x2: event.clientX - box.left })
  }

  const handleRangePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const startX = dragStartXRef.current
    if (startX === null) return
    dragStartXRef.current = null
    setDragRect(null)
    const chart = chartRef.current
    if (chart === null) return
    const box = event.currentTarget.getBoundingClientRect()
    // 容器坐标 → pane 坐标：时间刻度换算以 pane 左缘为原点，容器含左价格轴，
    // 不减去轴宽会整体右移选区（提交端被 lastIndex 钳位掩盖）。
    const paneOffset = chart.priceScale('left').width()
    const fromLogical = chart.timeScale().coordinateToLogical(startX - paneOffset)
    const toLogical = chart.timeScale().coordinateToLogical(event.clientX - box.left - paneOffset)
    if (fromLogical === null || toLogical === null) {
      propsRef.current.onRangeSelect?.(null)
      return
    }
    let start = Math.round(fromLogical)
    let end = Math.round(toLogical)
    if (start > end) [start, end] = [end, start]
    const lastIndex = Math.max(propsRef.current.bars.length - 1, 0)
    start = Math.min(lastIndex, Math.max(0, start))
    end = Math.min(lastIndex, Math.max(0, end))
    // 单击（无拖拽跨度）= 清除选区。
    if (start === end) {
      propsRef.current.onRangeSelect?.(null)
      return
    }
    propsRef.current.onRangeSelect?.({ start, end })
  }

  const handleRangePointerCancel = (): void => {
    dragStartXRef.current = null
    setDragRect(null)
  }

  // 高亮矩形：拖拽中用像素坐标；已提交选区由逻辑下标反查坐标（布局变化经
  // paneTops 测量 effect 的 ResizeObserver 触发重渲染重算）。logicalToCoordinate
  // 返回 pane 内坐标，绘制在容器上需加回左价格轴宽度（与 pointerup 换算互逆）。
  const selectionRect = ((): { left: number; width: number } | null => {
    if (dragRect !== null) {
      return { left: Math.min(dragRect.x1, dragRect.x2), width: Math.abs(dragRect.x2 - dragRect.x1) }
    }
    if (props.rangeSelectionMode === true && props.selection != null) {
      const chart = chartRef.current
      if (chart === null) return null
      const timeScale = chart.timeScale()
      const paneOffset = chart.priceScale('left').width()
      const x1 = timeScale.logicalToCoordinate(props.selection.start as Logical)
      const x2 = timeScale.logicalToCoordinate(props.selection.end as Logical)
      if (x1 === null || x2 === null) return null
      return { left: Math.min(Number(x1), Number(x2)) + paneOffset, width: Math.abs(Number(x2) - Number(x1)) }
    }
    return null
  })()

  const monoFont = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, sans-serif'
  const volumeReadout = readoutIndex !== null ? volumes[readoutIndex] : undefined

  return (
    <div
      className="dshtrading-tv-chart"
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        cursor: props.rangeSelectionMode === true ? 'crosshair' : undefined,
      }}
      onPointerDown={handleRangePointerDown}
      onPointerMove={handleRangePointerMove}
      onPointerUp={handleRangePointerUp}
      onPointerCancel={handleRangePointerCancel}
    >
      {/* 框选高亮带（拖拽中 / 已提交选区） */}
      {selectionRect !== null && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: selectionRect.left,
            width: selectionRect.width,
            background: 'rgba(37, 99, 235, 0.08)',
            borderLeft: '1px solid rgba(37, 99, 235, 0.4)',
            borderRight: '1px solid rgba(37, 99, 235, 0.4)',
            zIndex: 1,
            pointerEvents: 'none',
          }}
        />
      )}
      {/* pane 1 legend：成交量读数（值按富途式蓝色着色） */}
      {paneTops[1] !== undefined && volumeReadout !== undefined && (
        <div style={{ position: 'absolute', left: 8, top: paneTops[1] + 4, zIndex: 2, pointerEvents: 'none', fontSize: 10.5, fontFamily: monoFont, color: 'var(--dsw-futu-text-secondary, #5f6672)', fontWeight: 600 }}>
          VOL: <span style={{ color: '#2563eb' }}>{fmtCompact(volumeReadout.value)}</span>
        </div>
      )}
      {/* pane 2+ legend：副图指标读数（分量按输出色着色，组名打头） */}
      {subIndicators.map((group, groupIndex) => {
        const top = paneTops[2 + groupIndex]
        if (top === undefined || readoutIndex === null) return null
        return (
          <div key={group.key} style={{ position: 'absolute', left: 8, top: top + 4, zIndex: 2, pointerEvents: 'none', fontSize: 10.5, fontFamily: monoFont, display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--dsw-futu-text-secondary, #5f6672)', fontWeight: 600 }}>{group.title}</span>
            {group.outputs.map((output) => {
              const value = output.values[readoutIndex]
              if (value === undefined || !Number.isFinite(value)) return null
              return (
                <span key={output.key} style={{ color: output.color, fontWeight: 500 }}>
                  {output.key}: {value.toFixed(2)}
                </span>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/** 主图叠加（pane 0）与副图（pane 2+，重建式）两套 diff 策略。 */
function syncIndicators(
  chart: IChartApi,
  refs: Map<string, Map<string, ISeriesApi<SeriesType>>>,
  groups: readonly TvIndicatorGroup[],
  timeAxis: readonly UTCTimestamp[],
  recreateAll: boolean,
  basePane: number,
  colorMode?: ColorMode,
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
        ;(series as ISeriesApi<'Histogram'>).setData(toHistogramData(output, timeAxis, colorMode))
      } else {
        ;(series as ISeriesApi<'Line' | 'Area'>).setData(toLineData(output, timeAxis))
      }
    }
  })
}

function createSeries(chart: IChartApi, output: IndicatorOutput, paneIndex: number): ISeriesApi<SeriesType> {
  // 主图叠加（pane 0）与蜡烛同住左轴价格刻度；副图 pane 保持各自默认右轴。
  const priceScaleId = paneIndex === 0 ? { priceScaleId: 'left' as const } : {}
  if (output.kind === 'histogram') {
    return chart.addSeries(HistogramSeries, {
      ...priceScaleId,
      color: output.color,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    }, paneIndex)
  }
  if (output.kind === 'area') {
    return chart.addSeries(AreaSeries, {
      ...priceScaleId,
      lineColor: output.color,
      topColor: output.topColor ?? output.color,
      bottomColor: output.bottomColor ?? 'transparent',
      invertFilledArea: output.invertFilledArea ?? false,
      lineWidth: (output.lineWidth ?? 1.5) as 1 | 2 | 3 | 4,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    }, paneIndex)
  }
  return chart.addSeries(LineSeries, {
    ...priceScaleId,
    color: output.color,
    lineWidth: (output.lineWidth ?? 1.2) as 1 | 2 | 3 | 4,
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

function toHistogramData(output: IndicatorOutput, timeAxis: readonly UTCTimestamp[], colorMode: ColorMode = 'red-up'): Array<{ time: UTCTimestamp; value: number; color: string }> {
  const palette = getColorPalette(colorMode)
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
