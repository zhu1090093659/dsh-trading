/**
 * TradingView lightweight-charts v5 封装——中栏行情渲染器（富途牛牛视觉风格）。
 *
 * 结构：pane 0 = 蜡烛 + 主图叠加指标；pane 1+ = 每个副图指标独占一 pane
 * （v5 原生 panes）。图表没有内置成交量 pane——成交量由指标名册里的 `vol`
 * 指标（普通副图组）渲染，取消勾选即整个 pane 消失、下方副图随之上移。渲染层
 * 对指标实现零感知，只消费注册表 compute 的输出（@dshtrading/indicators 注册表）。
 * 唯一的例外是**占位 pane**（外部序列取不到的 aux 副图）：它没有 outputs，本层为它
 * 建一条不承载任何数值的锚序列（库的 pane 由序列隐式创建），撤下走同一套序列 diff。
 *
 * pane 内 legend：副图指标（pane 1+）的读数以绝对定位 overlay 显示在各自
 * pane 左上角（悬停跟随 readoutIndex，离场回落最新值）；主图指标读数由
 * QuoteStage 的读数行承载，不在这里重复。
 *
 * 视觉对齐：
 * - 红涨绿跌（#e64545 / #2ba471）
 * - 当前最新价水平虚线与坐标轴实心价签
 * - 紧凑网格与等宽数字
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers,
} from 'lightweight-charts'
import type {
  Coordinate, IChartApi, ISeriesApi, ISeriesMarkersPluginApi, Logical, LogicalRange, MouseEventParams, SeriesType, Time, UTCTimestamp,
} from 'lightweight-charts'
import type { BarPrice, PriceFormatCustom } from 'lightweight-charts'
import { fmtAxis, priceDigits } from './format.ts'
import { AXIS_FONT_FAMILY, AXIS_FONT_SIZE, AXIS_SCALE_MARGIN, axisMinimumWidth, percentAxisRef, percentLabel, percentLabelCandidates } from './axis-width.ts'
import { getColorPalette, type ColorMode } from './color-mode.ts'
import { resolveHistogramBarColor, resolveOutputColor } from './indicator-color.ts'
import { isDarkTheme, useDarkTheme } from './theme-mode.ts'
import { chartXToContainerX, containerXToChartX, visibleDayMarkXs } from './chart-coordinate.ts'
import { fiveDayWheelStep, viewportResetStrategy } from './five-day-series.ts'
import type { IndicatorOutput } from '@dshtrading/indicators'
import type { Kline } from './types.ts'

export { isDarkTheme }

export interface TvBar {
  time: UTCTimestamp
  open: number
  high: number
  low: number
  close: number
}

/** 一个指标实例的渲染输入（key = instanceKey，diff 锚点）。 */
export interface TvIndicatorGroup {
  key: string
  title?: string
  live?: true
  outputs: readonly IndicatorOutput[]
  /**
   * 空态占位组：该组**没有任何输出**，pane 照样出现、标题行改显示这句理由（已翻译的
   * 文案，词典归属在 UI 层）。占位组由 indicator-dispatch 在「声明了 aux 且每个声明键
   * 都没有非空序列」时给出——空 ≠ 0：不建数据点、不画零线、不前向填充、不伪造 live。
   */
  emptyNotice?: string
}

/** 占位组判据：带空态文案且没有任何输出。有输出就不是占位（两者不会同时成立）。 */
export function isPlaceholderGroup(group: TvIndicatorGroup): boolean {
  return group.emptyNotice !== undefined && group.outputs.length === 0
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
  /** 屏幕坐标 X（TvChart 容器坐标系）。 */
  x: number
  /** 屏幕坐标 Y（TvChart 容器坐标系）。 */
  y: number
  /** 容器尺寸（Tooltip 越界翻转钳位用）。 */
  containerWidth: number
  containerHeight: number
  /** 策略信号数据（与 knowledge 互斥）。 */
  signal?: ChartSignalMarkerInput
  /** 知识事件数据（与 signal 互斥）。 */
  knowledge?: ChartKnowledgeMarkerInput
}

export interface TvChartProps {
  bars: readonly TvBar[]
  /** market:symbol:interval——变化即全量重置并 fitContent。 */
  dataKey: string
  intraday: boolean
  /**
   * 右轴百分比参考价（五日级别传昨收，与头部涨跌幅同锚）：给了就固定，滚动/缩放/换档位
   * 都不再重算，右轴读数即头部那个涨跌幅的口径。缺省/非法退回「可视区最左一根收盘」。
   */
  percentRef?: number | undefined
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
  /** 策略回测信号标记（可选，issue #41）。 */
  signalMarkers?: readonly ChartSignalMarkerInput[] | undefined
  /** 知识事件标记（可选，issue #41）。 */
  knowledgeMarkers?: readonly ChartKnowledgeMarkerInput[] | undefined
  /** 悬停标记时回调（null = 离开标记区域；父级负责渲染 Tooltip）。 */
  onMarkerHover?: (info: MarkerHoverInfo | null) => void
  /** 信号标记图上的短文案（买入/卖出，词典驱动）。 */
  markerTexts?: { entry: string; exit: string } | undefined
  liveText?: string | undefined
  /**
   * 右键某根 K 线（KDAS 关键日菜单入口）：index = 命中柱逻辑下标，x/y = 容器坐标。
   * 返回 true 表示已处理（阻止浏览器默认菜单）；缺省/返回 false 保留默认菜单。
   * 是否启用（周期/指标守卫）由父级判定；换算与区间框选同源（coordinateToLogical
   * + 左轴宽修正）。
   */
  onBarContextMenu?: (info: { index: number; x: number; y: number }) => boolean
  /**
   * 五日级别（客户端视图级别 '5d'）：x 轴跨 5 个交易日拼接。dayStarts = 除显示
   * 窗口首日外每个交易日首根 bar 的 UTC 秒（日界竖线与日期刻度）。成交量档位色
   * 由 `vol` 指标经 dispatch 的 barAux 通道自带，图表侧不参与。
   * 缺省即普通级别。
   */
  fiveDay?: { dayStarts: readonly number[] } | undefined
  /**
   * 五日级别的滚轮换档（-1 = 少显示一个交易日，+1 = 多显示一个）。给了即表示当前
   * 处于五日级别：库的滚轮缩放让位给换档——键在**级别**而不是数据是否到位，否则
   * 换级别后数据在途的那一瞬滚轮会退回缩放。
   */
  onFiveDayWheel?: ((delta: -1 | 1) => void) | undefined
}

export function IndicatorPaneTitle(props: { title?: string | undefined; live?: true | undefined; liveText?: string | undefined }): React.JSX.Element {
  return (
    <span style={{ color: 'var(--dsw-futu-text-secondary, #5f6672)', fontWeight: 600, display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
      <span>{props.title}</span>
      {props.live === true && <span role="status" style={{ color: 'var(--dsw-futu-text-tertiary, #8a919c)', fontWeight: 500 }}>{props.liveText}</span>}
    </span>
  )
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
 * 副图指标的 pane 序号：pane 0 归蜡烛 + 主图叠加，副图从 pane 1 起按激活顺序
 * 排列。图表不再有内置成交量 pane，所以第一个副图指标（含 `vol`）就是 pane 1；
 * 取消勾选后剩余副图整体前移。序列创建与 legend 定位共用这一处序号来源。
 */
export function subIndicatorPaneIndex(groupIndex: number): number {
  return 1 + groupIndex
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
    // 口径与右轴宽度下限（axis-width.ts）共用同一个 percentLabel——两份实现漂移会让
    // minimumWidth 偏窄、抖动回归，且没有任何测试能发现。
    formatter: (price: BarPrice): string => percentLabel(Number(price), refPriceRef.current),
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

/** 五日级别的轴刻度：日界（该日首根 bar）带日期，其余只带时刻。 */
function fiveDayTickLabel(ms: number, dayStartSet: ReadonlySet<number>, intraday: boolean): string {
  const seconds = Math.floor(ms / 1000)
  if (intraday && dayStartSet.has(seconds)) return `${localDate(ms).slice(5)} ${localTime(ms)}`
  return fmtAxis(ms, intraday)
}

/**
 * 时轴几何（与主题无关）：只在 createChart 给一次，**主题热切换不得重放**。轻量图表
 * 收到 barSpacing 会按新间距重排可见范围——亮暗两套的这些值完全相同，重放纯属损失，
 * 却会清掉用户当前的缩放/平移（2026-10-14 五日级别实测：fit 铺满 5 个交易日、4 条
 * 日界的视窗在切主题后塌回约一小时）。
 */
export const TIME_SCALE_GEOMETRY = {
  rightOffset: 6,
  barSpacing: 9,
  minBarSpacing: 0.5,
  fixLeftEdge: true,
  fixRightEdge: true,
  shiftVisibleRangeOnNewBar: true,
} as const

/**
 * 主题视觉选项 = 完整主题选项去掉创建期结构键（时轴几何 + autoSize）。主题热切换只重放
 * 这一份：亮/暗两套的差异全在这里（布局、网格、双价格轴、十字线、时轴边框色）。结构键
 * 一次都不重放——时轴几何会按新间距重排可见范围，autoSize 会重新量测容器，两者都能动到
 * 用户当前的缩放/平移。
 */
export function getChartThemeVisualOptions(dark: boolean) {
  if (dark) {
    return {
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor: '#787b86',
        fontSize: AXIS_FONT_SIZE,
        fontFamily: AXIS_FONT_FAMILY,
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
        scaleMargins: { top: AXIS_SCALE_MARGIN, bottom: AXIS_SCALE_MARGIN },
        entireTextOnly: true,
      },
      rightPriceScale: {
        borderColor: '#2a2e39',
        scaleMargins: { top: AXIS_SCALE_MARGIN, bottom: AXIS_SCALE_MARGIN },
        entireTextOnly: true,
      },
      timeScale: { borderColor: '#2a2e39' },
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
    layout: {
      background: { type: ColorType.Solid, color: '#ffffff' },
      textColor: '#5f6672',
      fontSize: AXIS_FONT_SIZE,
      fontFamily: AXIS_FONT_FAMILY,
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
      scaleMargins: { top: AXIS_SCALE_MARGIN, bottom: AXIS_SCALE_MARGIN },
      entireTextOnly: true,
    },
    rightPriceScale: {
      borderColor: '#e5e7eb',
      scaleMargins: { top: AXIS_SCALE_MARGIN, bottom: AXIS_SCALE_MARGIN },
      entireTextOnly: true,
    },
    timeScale: { borderColor: '#e5e7eb' },
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

/**
 * createChart 的完整主题选项：创建期结构键（autoSize + 时轴几何）+ 随主题变化的视觉选项。
 * 两套主题的结构键逐键相同，差异只在视觉选项里。
 */
export function getChartThemeOptions(dark: boolean) {
  const visual = getChartThemeVisualOptions(dark)
  return { autoSize: true, ...visual, timeScale: { ...TIME_SCALE_GEOMETRY, ...visual.timeScale } }
}

function TvChartImpl(props: TvChartProps): React.JSX.Element {
  const { bars, dataKey, mainOverlays, subIndicators, readoutIndex } = props

  const dark = useDarkTheme()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const markerPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  /** 当前图上标记的元数据（命中检测用；与 markerPlugin 的 markers 同步重建）。 */
  const markerMetaRef = useRef<MarkerMeta[]>([])
  /** 右轴镜像序列（透明）：top/bottom 钉范围，close 供轴上百分比徽标。 */
  const mirrorTopRef = useRef<ISeriesApi<'Line'> | null>(null)
  const mirrorBottomRef = useRef<ISeriesApi<'Line'> | null>(null)
  const mirrorCloseRef = useRef<ISeriesApi<'Line'> | null>(null)
  /** 右轴百分比参考价（固定锚点或可视区最左一根K线收盘；null = 未定）。 */
  const refPriceRef = useRef<number | null>(null)
  /** 五日级别右轴锚点（昨收）；null = 沿用「可视区最左一根收盘」口径。 */
  const fixedPercentRef = percentAxisRef(props.percentRef)
  /** 挂载期建好的参考价重算入口（锚点变化时复用同一份口径，不另写一份）。 */
  const syncRefPriceRef = useRef<(() => void) | null>(null)
  const mirrorFormatRafRef = useRef(0)
  /** 右轴宽度下限（px；0 = 未锁）。锁住「轴宽 ↔ 绘图区宽」正反馈，见 axis-width.ts。 */
  const rightAxisMinWidthRef = useRef(0)
  /** 主图/副图各一张序列表：groupKey → outputKey → series（结构 diff 用）。 */
  const mainRefs = useRef(new Map<string, Map<string, ISeriesApi<SeriesType>>>())
  const subRefs = useRef(new Map<string, Map<string, ISeriesApi<SeriesType>>>())
  /** 各 pane 顶缘 y 坐标（legend overlay 定位用）；空数组 = 尚未测量。 */
  const [paneTops, setPaneTops] = useState<number[]>([])
  /** 最新 props 快照，供只跑一次的 chart 工厂与事件回调读取。 */
  const propsRef = useRef(props)
  propsRef.current = props

  /** 五日级别日界集合（tick formatter 的 O(1) 判据；只跑一次的 chart 工厂经 propsRef 读）。 */
  const dayStarts = props.fiveDay?.dayStarts
  const dayStartSet = useMemo(() => new Set(dayStarts ?? []), [dayStarts])
  const dayStartSetRef = useRef(dayStartSet)
  dayStartSetRef.current = dayStartSet

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
        // 五日级别：日界处显示日期（MM-DD HH:mm），其余刻度只显示时刻——跨 5 个
        // 交易日的横轴没有日期锚点就分不清哪根是哪天。
        tickMarkFormatter: (time: Time): string => {
          const ms = Number(time) * 1000
          return fiveDayTickLabel(ms, dayStartSetRef.current, propsRef.current.intraday)
        },
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

    // 参考价：固定锚点（五日级别 = 昨收）优先，否则取可视区最左一根K线收盘。滚动/缩放/
    // 换数据时经 visibleLogicalRange 事件重算，rAF 去抖后刷新镜像 formatter（新对象强制轴重绘）。
    const syncRefPrice = (): void => {
      let next = percentAxisRef(propsRef.current.percentRef)
      if (next === null) {
        const barsNow = propsRef.current.bars
        const range: LogicalRange | null = chart.timeScale().getVisibleLogicalRange()
        if (barsNow.length > 0 && range !== null) {
          const index = Math.min(barsNow.length - 1, Math.max(0, Math.ceil(range.from)))
          const close = barsNow[index]?.close
          next = close !== undefined && Number.isFinite(close) && close > 0 ? close : null
        }
      }
      if (next === null || next === refPriceRef.current) return
      refPriceRef.current = next
      scheduleMirrorFormatRefresh()
    }
    syncRefPriceRef.current = syncRefPrice
    chart.timeScale().subscribeVisibleLogicalRangeChange(syncRefPrice)
    syncRefPrice()

    applyStretch(chart)

    const onCrosshair = (param: MouseEventParams): void => {
      if (param.logical === undefined || param.time === undefined) {
        propsRef.current.onHoverIndex(null)
        propsRef.current.onMarkerHover?.(null)
        return
      }
      propsRef.current.onHoverIndex(param.logical)
      propsRef.current.onMarkerHover?.(hitTestMarker(param, propsRef, chart, candles, container, markerMetaRef))
    }
    chart.subscribeCrosshairMove(onCrosshair)

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair)
      mainRefs.current.clear()
      subRefs.current.clear()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      markerPluginRef.current?.detach()
      markerPluginRef.current = null
      markerMetaRef.current = []
      mirrorTopRef.current = null
      mirrorBottomRef.current = null
      mirrorCloseRef.current = null
      refPriceRef.current = null
      syncRefPriceRef.current = null
      cancelAnimationFrame(mirrorFormatRafRef.current)
    }
  }, [])

  // 右轴锚点变化（进出五日级别、换标的换昨收）：立刻按新口径重设参考价，不等下一次可视区
  // 事件——否则退出五日级别后右轴会停在昨收口径上，锚点换了也不立刻生效。
  useEffect(() => {
    syncRefPriceRef.current?.()
  }, [fixedPercentRef])

  // 主题热切换（浅色 ↔ 深色动态 applyOptions）：只重放随主题变化的视觉选项。时轴几何与
  // autoSize 是创建期结构键，重放会让库重排可见范围 / 重新量测容器 = 清掉缩放与平移。
  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    chart.applyOptions(getChartThemeVisualOptions(dark))
  }, [dark])

  // 涨跌配色热切换：蜡烛换色（成交量由 `vol` 指标按自己的语义色渲染，不随
  // 红涨绿跌设置走，图表侧不再整表重着色）。
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
  }, [props.colorMode])

  // ---- 蜡烛：dataKey 变化全量重置，否则尾部增量 ----
  const prevRef = useRef<{ key: string; bars: readonly TvBar[] } | null>(null)
  useEffect(() => {
    const candles = candleRef.current
    const chart = chartRef.current
    if (candles === null || chart === null) return
    const prev = prevRef.current
    prevRef.current = { key: dataKey, bars }

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
      if (viewportResetStrategy(props.fiveDay !== undefined) === 'fit-window') {
        // 五日级别：默认铺满整个 5 日窗口（5 段拼接 + 4 条日界可见）。主题设了
        // fixLeftEdge/fixRightEdge，此时库的 minBarSpacing 下限正好等于「全部点铺满」，
        // fitContent 不会被钳短；视窗不锁定，用户仍可缩放平移。
        chart.timeScale().fitContent()
      } else {
        // 常规级别：既有行为（默认 barSpacing + 最新价贴右缘），零改动。
        chart.timeScale().resetTimeScale()
        chart.timeScale().scrollToRealTime()
      }
      return
    }
    for (let index = Math.max(prev.bars.length - 1, 0); index < bars.length; index++) {
      candles.update(bars[index] as TvBar)
    }
  }, [bars, dataKey, props.colorMode, props.fiveDay])

  // ---- 五日级别日界竖线：日界时刻 → 容器 x 坐标（滚动/缩放/换数据都要重算） ----
  const [dayMarks, setDayMarks] = useState<number[]>([])
  const dayMarkRafRef = useRef(0)
  useEffect(() => {
    const chart = chartRef.current
    const starts = props.fiveDay?.dayStarts ?? []
    if (chart === null || starts.length === 0) {
      setDayMarks([])
      return
    }
    const container = containerRef.current
    const measure = (): void => {
      // 轴宽每次量测现取（axisMinimumWidth 会随价位/徽标变化），换算只有一处实现。
      const paneOffset = chart.priceScale('left').width()
      const chartXs = starts.map(time => chart.timeScale().timeToCoordinate(time as UTCTimestamp))
      const xs = visibleDayMarkXs(chartXs, paneOffset, container?.clientWidth ?? 0)
      setDayMarks(current => (current.length === xs.length && current.every((x, index) => x === xs[index]) ? current : xs))
    }
    const schedule = (): void => {
      cancelAnimationFrame(dayMarkRafRef.current)
      dayMarkRafRef.current = requestAnimationFrame(measure)
    }
    schedule()
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule)
    // 容器宽度变化（面板折叠/窗口 resize）会改变可视根数，日界进出视窗都要重测。
    const observer = container !== null ? new ResizeObserver(schedule) : null
    if (container !== null) observer?.observe(container)
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule)
      observer?.disconnect()
      cancelAnimationFrame(dayMarkRafRef.current)
    }
  }, [props.fiveDay, dataKey, bars])

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
    const meta: MarkerMeta[] = []
    /** marker time → 柱下标（命中检测按柱下标匹配；bars 变化时本 effect 重建）。 */
    const indexOfTime = new Map<number, number>()
    for (let index = 0; index < bars.length; index++) {
      const bar = bars[index]
      if (bar !== undefined) indexOfTime.set(bar.time as number, index)
    }

    // 策略信号 → 绿色买入箭头 / 红色卖出箭头
    if (props.signalMarkers) {
      for (const s of props.signalMarkers) {
        const t = (s.time > 1e11 ? Math.floor(s.time / 1000) : s.time) as UTCTimestamp
        markers.push({
          time: t,
          position: s.action === 'entry' ? 'belowBar' : 'aboveBar',
          color: s.action === 'entry' ? '#22c55e' : '#ef4444',
          shape: s.action === 'entry' ? 'arrowUp' : 'arrowDown',
          text: s.action === 'entry' ? (props.markerTexts?.entry ?? 'Buy') : (props.markerTexts?.exit ?? 'Sell'),
        })
        meta.push({ index: indexOfTime.get(t as number) ?? -1, signal: s })
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
        meta.push({ index: indexOfTime.get(t as number) ?? -1, knowledge: k })
      }
    }

    // 按 time 升序排列（与 markers 顺序一致）
    markers.sort((a, b) => (a.time as number) - (b.time as number))
    meta.sort((a, b) => a.index - b.index)
    markerMetaRef.current = meta
    if (markerPluginRef.current === null) {
      markerPluginRef.current = createSeriesMarkers(candles, markers)
    } else {
      markerPluginRef.current.setMarkers(markers)
    }
    // 标记消失（切标的/关开关）后悬停详情立即清场。
    if (meta.length === 0) propsRef.current.onMarkerHover?.(null)
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
    // 包络与收盘极值：右轴宽度下限的输入（见下）。可视区无关，只随数据变化。
    let minPrice = Number.POSITIVE_INFINITY
    let maxPrice = Number.NEGATIVE_INFINITY
    let minClose = Number.POSITIVE_INFINITY
    let maxClose = Number.NEGATIVE_INFINITY
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
      if (high > maxPrice) maxPrice = high
      if (low < minPrice) minPrice = low
      if (bar.close > maxClose) maxClose = bar.close
      if (bar.close < minClose) minClose = bar.close
      topData.push({ time: bar.time, value: high })
      bottomData.push({ time: bar.time, value: low })
      closeData.push({ time: bar.time, value: bar.close })
    }
    top.setData(topData)
    bottom.setData(bottomData)
    badge.setData(closeData)
    // 右轴宽度下限：轴宽 = 最宽刻度标签宽度，百分号标签正数不带号、量级跨 10/100
    // 各差一个字符，宽度随可视区在 5/6/7 字符间跳 → 绘图区宽 → 可视 K 线 → 自缩放
    // → 标签 → 轴宽 正反馈（实测 625px 容器宽下无限抖动）。按数据极值给出的最宽
    // 标签锁死下限，反馈即断开。下限只随数据变化，不随可视区变化。候选标签已把
    // scaleMargins 把轴范围撑出数据区间的部分算进去（axis-width.ts）。
    if (Number.isFinite(minPrice) && Number.isFinite(maxPrice)) {
      const chart = chartRef.current
      // 五日级别的固定锚点（昨收）可落在可视收盘区间之外，候选按锚点直接算。
      const minWidth = axisMinimumWidth(percentLabelCandidates({ minPrice, maxPrice, minClose, maxClose, ref: percentAxisRef(propsRef.current.percentRef) }))
      if (chart !== null && minWidth > 0 && minWidth !== rightAxisMinWidthRef.current) {
        rightAxisMinWidthRef.current = minWidth
        chart.applyOptions({ rightPriceScale: { minimumWidth: minWidth } })
      }
    }
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
    syncIndicators(chart, mainRefs.current, mainOverlays, timeAxis, false, 0, dark)
    syncIndicators(chart, subRefs.current, subIndicators, timeAxis, true, subIndicatorPaneIndex(0), dark)
    applyStretch(chart)
  }, [mainOverlays, subIndicators, bars, props.colorMode, dark])

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
      // 容器高 = Σpane 高 + Σ分隔条 + 底部时间轴；先扣时间轴再反推分隔条厚度，
      // 否则分隔条被高估 timeAxis/(panes-1)，pane 越靠后 legend 下漂越多
      //（末位 pane 恰好多漂一整条时间轴高度，legend 落进绘图区中段与图形重叠）。
      const timeAxisHeight = chart.timeScale().height()
      const gapsTotal = panes.length > 1
        ? Math.max(0, container.clientHeight - heights.reduce((sum, height) => sum + height, 0) - timeAxisHeight)
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

  // ---- 图表交互开关的唯一一处：框选模式全关；五日级别只关滚轮（滚轮改作换档，
  // 拖拽平移保留）。传完整对象而非布尔，库的布尔展开会把滚轮一起带走。 ----
  const fiveDayActive = props.onFiveDayWheel !== undefined
  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    const selecting = props.rangeSelectionMode === true
    chart.applyOptions({
      handleScroll: {
        mouseWheel: !selecting && !fiveDayActive,
        pressedMouseMove: !selecting,
        horzTouchDrag: !selecting,
        vertTouchDrag: !selecting,
      },
      handleScale: {
        mouseWheel: !selecting && !fiveDayActive,
        pinch: !selecting,
        axisPressedMouseMove: { time: !selecting, price: !selecting },
        axisDoubleClickReset: { time: !selecting, price: !selecting },
      },
    })
  }, [props.rangeSelectionMode, fiveDayActive])

  // ---- 五日级别滚轮换档：库的滚轮缩放已关，滚轮事件全归这里。触控板一次两指滑动
  // 是一串小 delta，攒格判定交给 fiveDayWheelStep；回调经 propsRef 现取，
  // 免得每次父级渲染重挂监听。 ----
  useEffect(() => {
    const container = containerRef.current
    if (container === null || !fiveDayActive) return
    let accum = 0
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const step = propsRef.current.onFiveDayWheel
      if (step === undefined) return
      const next = fiveDayWheelStep(accum, event.deltaY, event.deltaMode)
      accum = next.accum
      if (next.delta !== 0) step(next.delta)
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => { container.removeEventListener('wheel', onWheel) }
  }, [fiveDayActive])

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
    const fromLogical = chart.timeScale().coordinateToLogical(containerXToChartX(startX, paneOffset))
    const toLogical = chart.timeScale().coordinateToLogical(containerXToChartX(event.clientX - box.left, paneOffset))
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

  // 右键 K 线命中：容器坐标 → 逻辑下标（与框选抬起换算同源：减左轴宽后走
  // coordinateToLogical，圆整钳位到序列范围）。命中才交给父级菜单并拦截默认菜单。
  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    const handler = propsRef.current.onBarContextMenu
    if (handler === undefined) return
    const chart = chartRef.current
    if (chart === null) return
    const box = event.currentTarget.getBoundingClientRect()
    const paneOffset = chart.priceScale('left').width()
    const logical = chart.timeScale().coordinateToLogical(containerXToChartX(event.clientX - box.left, paneOffset))
    if (logical === null) return
    const index = Math.round(Number(logical))
    const lastIndex = propsRef.current.bars.length - 1
    if (index < 0 || index > lastIndex) return
    if (handler({ index, x: event.clientX - box.left, y: event.clientY - box.top })) {
      event.preventDefault()
    }
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
      const left = chartXToContainerX(Math.min(Number(x1), Number(x2)) as Coordinate, paneOffset)
      if (left === null) return null
      return { left, width: Math.abs(Number(x2) - Number(x1)) }
    }
    return null
  })()

  const monoFont = AXIS_FONT_FAMILY

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
      onContextMenu={handleContextMenu}
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
      {/* 五日级别日界：每个交易日首根 K 线上的竖分隔线（隔夜/午休空档已被
          lightweight-charts 的槽位横轴压缩掉，只有这根线标出跨日边界） */}
      {dayMarks.map((x, index) => (
        <div
          key={`${x}-${index}`}
          data-dshtrading-day-boundary=""
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: x,
            width: 1,
            background: dark ? 'rgba(240, 243, 250, 0.28)' : 'rgba(15, 23, 42, 0.28)',
            zIndex: 1,
            pointerEvents: 'none',
          }}
        />
      ))}
      {/* pane 1+ legend：副图指标读数（分量按输出色着色，组名打头；pane 序号与
          序列创建同源——第一个副图指标即 pane 1，无成交量特例读数块）。
          占位组只有标题行 + 空态理由，且**不随悬停状态消失**（它就是那条理由本身）。 */}
      {subIndicators.map((group, groupIndex) => {
        const top = paneTops[subIndicatorPaneIndex(groupIndex)]
        if (top === undefined) return null
        if (isPlaceholderGroup(group)) {
          return (
            <div key={group.key} style={{ position: 'absolute', left: 8, top: top + 4, zIndex: 2, pointerEvents: 'none', fontSize: 10.5, fontFamily: monoFont, display: 'flex', gap: 8 }}>
              <IndicatorPaneTitle title={group.title} />
              <span style={{ color: 'var(--dsw-futu-text-tertiary, #8a919c)', fontWeight: 500 }}>{group.emptyNotice}</span>
            </div>
          )
        }
        if (readoutIndex === null) return null
        return (
          <div key={group.key} style={{ position: 'absolute', left: 8, top: top + 4, zIndex: 2, pointerEvents: 'none', fontSize: 10.5, fontFamily: monoFont, display: 'flex', gap: 8 }}>
            <IndicatorPaneTitle title={group.title} live={group.live} liveText={props.liveText} />
            {group.outputs.map((output) => {
              const value = output.values[readoutIndex]
              if (value === undefined || !Number.isFinite(value)) return null
              return (
                <span key={output.key} style={{ color: resolveOutputColor(output, dark), fontWeight: 500 }}>
                  {output.key}: {value.toFixed(output.precision ?? 2)}
                </span>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/** 一条标记的命中检测元数据（index = 所属柱下标，-1 = 柱不在当前序列）。 */
type MarkerMeta = {
  index: number
  signal?: ChartSignalMarkerInput
  knowledge?: ChartKnowledgeMarkerInput
}

/**
 * 标记命中检测：十字线所在柱有信号/知识标记时回报容器坐标与详情（驱动
 * MarkerTooltip）。x = 时间轴坐标 + 左价格轴宽；y = 标记锚定价位（entry 在
 * 柱 low、exit/知识图钉在柱 high），锚点不可见时回退鼠标 y。
 */
function hitTestMarker(
  param: MouseEventParams,
  propsRef: { current: TvChartProps },
  chart: IChartApi,
  candles: ISeriesApi<'Candlestick'>,
  container: HTMLDivElement,
  metaRef: { current: readonly MarkerMeta[] },
): MarkerHoverInfo | null {
  const meta = metaRef.current
  if (meta.length === 0 || param.logical === undefined) return null
  const index = Math.round(Number(param.logical))
  // 同柱多标记：signal 优先（交易详情信息量更大），knowledge 兜底。
  const entry = meta.find(m => m.index === index && m.signal !== undefined)
    ?? meta.find(m => m.index === index && m.knowledge !== undefined)
  if (entry === undefined) return null

  const paneOffset = chart.priceScale('left').width()
  const x = chartXToContainerX(chart.timeScale().logicalToCoordinate(param.logical), paneOffset)
  if (x === null) return null

  const bar = propsRef.current.bars[index]
  const anchorPrice = entry.signal !== undefined
    ? (entry.signal.action === 'entry' ? bar?.low : bar?.high)
    : bar?.high
  const yCoord = anchorPrice !== undefined ? candles.priceToCoordinate(anchorPrice as BarPrice) : null
  const y = yCoord ?? param.point?.y ?? 0

  const info: MarkerHoverInfo = { x, y, containerWidth: container.clientWidth, containerHeight: container.clientHeight }
  if (entry.signal !== undefined) info.signal = entry.signal
  else if (entry.knowledge !== undefined) info.knowledge = entry.knowledge
  return info
}

/** 主图叠加（pane 0）与副图（pane 1+，重建式）两套 diff 策略。导出为图表侧直测缝。 */
export function syncIndicators(
  chart: IChartApi,
  refs: Map<string, Map<string, ISeriesApi<SeriesType>>>,
  groups: readonly TvIndicatorGroup[],
  timeAxis: readonly UTCTimestamp[],
  recreateAll: boolean,
  basePane: number,
  dark: boolean,
): void {
  const nextKeys = new Set(groups.map(group => group.key))

  // 卸载不在场的组（重建模式下全部先卸）。占位组的锚序列也在这里被撤下——它一撤，
  // pane 就成了空 pane，库随即回收（_private__cleanupIfPaneIsEmpty，见
  // lightweight-charts 的 _internal_removeSeries），占位 pane 因此随组一起消失：
  // 换标的 / 切市场 / 取消勾选都不需要额外清理路径。
  for (const [groupKey, seriesMap] of refs) {
    const keep = nextKeys.has(groupKey) && !recreateAll
    if (keep) continue
    for (const series of seriesMap.values()) chart.removeSeries(series)
    refs.delete(groupKey)
  }

  groups.forEach((group, groupIndex) => {
    // 重建模式：pane 随激活顺序对齐（basePane+i），series 需按 pane 归属重建。
    const paneIndex = recreateAll ? basePane + groupIndex : basePane
    if (isPlaceholderGroup(group)) {
      // 占位组：没有输出，pane 只能靠一个**不承载任何数值**的锚序列建立（库的 pane 由
      // 序列隐式创建）。锚序列从不 setData，只是让 pane 拥有一个数据源而不被回收。
      if (refs.get(group.key) === undefined) {
        const seriesMap = new Map<string, ISeriesApi<SeriesType>>()
        refs.set(group.key, seriesMap)
        if (paneIndex > 0) seriesMap.set(EMPTY_PANE_SERIES_KEY, createEmptyPaneSeries(chart, paneIndex))
      }
      return
    }
    let seriesMap = refs.get(group.key)
    if (seriesMap === undefined) {
      seriesMap = new Map()
      refs.set(group.key, seriesMap)
      for (const output of group.outputs) {
        seriesMap.set(output.key, createSeries(chart, output, paneIndex, dark))
      }
    }
    for (const output of group.outputs) {
      const series = seriesMap.get(output.key)
      if (series === undefined) continue
      // 主题热切换：主图叠加（recreateAll=false）不重建序列，颜色必须显式重放，
      // 否则 themeColor 会停在旧主题色，直到指标增删触发一次重建。
      applySeriesColor(series, output, dark)
      if (output.kind === 'histogram') {
        ;(series as ISeriesApi<'Histogram'>).setData(toHistogramData(output, timeAxis, dark))
      } else {
        ;(series as ISeriesApi<'Line' | 'Area'>).setData(toLineData(output, timeAxis))
      }
    }
  })
}

/** 输出读数小数位（precision 缺省 2，越界/非整数收敛到 0-8）。 */
function outputDigits(output: IndicatorOutput): number {
  if (output.precision === undefined) return 2
  return Math.min(8, Math.max(0, Math.round(output.precision)))
}

/**
 * `IndicatorOutput.priceFormat` 的结构化视图：只声明本文件真正读取的这一个可选字段，
 * 不复制 IndicatorOutput 本体。indicators 包该字段与客户端非同步落地，用结构化视图
 * 读它既能立刻编译，也在字段落地后自动对齐（同一类型，无本地副本）。
 */
type PriceFormatField = { priceFormat?: 'price' | 'volume' | undefined }

/**
 * 输出 → lightweight-charts priceFormat：`priceFormat: 'volume'` 的输出（成交量类指标）
 * 取库的紧凑量格式（亿/万、K/M/B），成交量 pane 纵轴不再显示成 `12000000.00`；其余
 * 输出维持 `{ type:'price', precision, minMove }`（precision/minMove 同源于 outputDigits，
 * 与十字线/轴标签分辨率一致）。缺省即 'price'，存量输出逐字不变。
 */
export function outputPriceFormat(output: IndicatorOutput): { type: 'price'; precision: number; minMove: number } | { type: 'volume' } {
  if ((output as PriceFormatField).priceFormat === 'volume') return { type: 'volume' as const }
  const digits = outputDigits(output)
  return { type: 'price' as const, precision: digits, minMove: 1 / 10 ** digits }
}

/**
 * 已存在序列的颜色重放：颜色只在 createSeries 建序列时读过一次，复用路径（主图
 * 叠加 recreateAll=false）不重建序列，主题热切换后必须显式 applyOptions 才能重着色。
 * 只在解析色与序列当前色不同时才写——无 themeColor 的输出解析结果恒等于 output.color，
 * 即与改动前的渲染逐帧一致（每次同步都不产生任何 applyOptions）。
 */
function applySeriesColor(series: ISeriesApi<SeriesType>, output: IndicatorOutput, dark: boolean): void {
  const color = resolveOutputColor(output, dark)
  if (output.kind === 'histogram') {
    const histogram = series as ISeriesApi<'Histogram'>
    if (histogram.options().color !== color) histogram.applyOptions({ color })
    return
  }
  if (output.kind === 'area') {
    const area = series as ISeriesApi<'Area'>
    if (area.options().lineColor !== color) area.applyOptions({ lineColor: color })
    return
  }
  const line = series as ISeriesApi<'Line'>
  if (line.options().color !== color) line.applyOptions({ color })
}

/**
 * 占位 pane 的锚序列键：NUL 前缀是「不可能与任何 IndicatorOutput.key 撞名」的标记
 * （定义侧 key 是人写的中文/英文标签），它只活在副图 refs 里，不进 legend 也不进读数。
 */
const EMPTY_PANE_SERIES_KEY = '\u0000aux-empty-pane'

/**
 * 占位 pane 的锚序列：**不承载任何数值**——从不 setData（不是空数组，是从未有过数据，
 * 更不是零线），各项可见性全关（无绘制、无价格线、无轴标签、十字线不可命中）。它唯一
 * 的职责是让 lightweight-charts 按 paneIndex 建立那个 pane：没有序列就没有 pane。
 */
function createEmptyPaneSeries(chart: IChartApi, paneIndex: number): ISeriesApi<SeriesType> {
  return chart.addSeries(LineSeries, {
    lineVisible: false,
    color: 'transparent',
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  }, paneIndex)
}

function createSeries(chart: IChartApi, output: IndicatorOutput, paneIndex: number, dark: boolean): ISeriesApi<SeriesType> {
  // 主图叠加（pane 0）与蜡烛同住左轴价格刻度；副图 pane 保持各自默认右轴。
  const priceScaleId = paneIndex === 0 ? { priceScaleId: 'left' as const } : {}
  // 序列 priceFormat 由 output.priceFormat 决定：成交量类输出走库的紧凑量格式，
  // 其余显式传入按 output.precision 提高十字线/轴标签分辨率（见 outputPriceFormat）。
  const priceFormat = outputPriceFormat(output)
  // 线/柱主色按当前主题解析（themeColor 缺省回落 output.color）；area 的填充
  // 渐变（topColor/bottomColor）沿用 output.color 的既有语义，不参与主题取色。
  const color = resolveOutputColor(output, dark)
  if (output.kind === 'histogram') {
    return chart.addSeries(HistogramSeries, {
      ...priceScaleId,
      color,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat,
    }, paneIndex)
  }
  if (output.kind === 'area') {
    return chart.addSeries(AreaSeries, {
      ...priceScaleId,
      lineColor: color,
      topColor: output.topColor ?? output.color,
      bottomColor: output.bottomColor ?? 'transparent',
      invertFilledArea: output.invertFilledArea ?? false,
      lineWidth: (output.lineWidth ?? 1.5) as 1 | 2 | 3 | 4,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat,
    }, paneIndex)
  }
  return chart.addSeries(LineSeries, {
    ...priceScaleId,
    color,
    lineWidth: (output.lineWidth ?? 1.2) as 1 | 2 | 3 | 4,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    priceFormat,
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

/**
 * 逐根柱色（导出为图表侧的直测缝）：符号色（histogramBySign）优先，否则按主题
 * 解析输出色；与 K 线对齐的缺值/暖机根不产出。
 */
export function toHistogramData(output: IndicatorOutput, timeAxis: readonly UTCTimestamp[], dark: boolean): Array<{ time: UTCTimestamp; value: number; color: string }> {
  const data: Array<{ time: UTCTimestamp; value: number; color: string }> = []
  for (let index = 0; index < output.values.length; index++) {
    const value = output.values[index]
    const time = timeAxis[index]
    if (value === undefined || !Number.isFinite(value) || time === undefined) continue
    data.push({ time, value, color: resolveHistogramBarColor(output, value, dark) })
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

/**
 * Memo boundary: QuoteStage 的秒级时钟、面板开关、轮询 setState 都会重渲染父树，
 * 但只有图表真正消费的 props（bars/readoutIndex/指标/标记/色彩模式）变化时
 * 才需要重建 lightweight-charts 视图。其余重渲染在此短路。
 */
export const TvChart = memo(TvChartImpl)
