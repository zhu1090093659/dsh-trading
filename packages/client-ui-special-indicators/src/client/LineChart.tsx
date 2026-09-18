/**
 * 多序列小线图（lightweight-charts v5 薄封装）：
 * - 1–2 条日频序列，支持左/右双价格轴（score 0–100 与指数点位不同量纲）。
 * - 序列名一律进图上方 HTML 图例（series.title），不交给价格轴：v5 把
 *   series.title 画在最新价标签旁、文字伸进绘图区压住折线（2026-09-18 实证）。
 * - 尺寸由容器驱动（autoSize + ResizeObserver）：卡片吃掉中栏剩余高度后
 *   画布随之伸展，不再按固定像素高留出空白。
 * - series 引用变化即整体重建（重建成本 < 一帧；生产方须用 useMemo 把
 *   引用稳定到数据真正更新时，否则行选中等无数据变化的重渲染会整图
 *   销毁重建。与 StrategyView 权益曲线同款生命周期纪律：卸载即 chart.remove()）。
 */
import { useEffect, useRef } from 'react'
import {
  AreaSeries,
  ColorType,
  LineSeries,
  createChart,
  type IChartApi,
  type Time,
} from 'lightweight-charts'
import type { ChartPoint } from './wire.ts'
import css from './LineChart.module.css'

/** CSS Modules 类表在 noUncheckedIndexedAccess 下索引为 string|undefined；
 *  运行期类名恒存在（构建期类表契约），此处把类型面收敛为 string。 */
const cx = (name: string): string => css[name] ?? name

/** ResizeObserver 缺失或首帧未量出尺寸时的回退画布尺寸（autoSize 失效路径）。 */
const FALLBACK_WIDTH = 600
const FALLBACK_HEIGHT = 240

export interface LineChartSeries {
  id: string
  points: ChartPoint[]
  color: string
  /** 价格轴：默认 right；左轴用于第二量纲。 */
  scale?: 'left' | 'right'
  /** area = 渐变填充面积图，默认细线。 */
  area?: boolean
  /** 图例名（含轴位提示）；不写入价格轴尾标签。 */
  title?: string
}

export interface LineChartProps {
  series: LineChartSeries[]
}

export function LineChart({ series }: LineChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container === null || series.every((s) => s.points.length === 0)) return

    const chart: IChartApi = createChart(container, {
      // 画布跟随容器尺寸（含中栏/侧栏改宽与窗高变化）；width/height 只作
      // ResizeObserver 不可用时的回退值。
      autoSize: true,
      width: container.clientWidth > 0 ? container.clientWidth : FALLBACK_WIDTH,
      height: container.clientHeight > 0 ? container.clientHeight : FALLBACK_HEIGHT,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8e95a3',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(128, 128, 128, 0.08)' },
        horzLines: { color: 'rgba(128, 128, 128, 0.08)' },
      },
      timeScale: { borderColor: 'rgba(128, 128, 128, 0.25)' },
      rightPriceScale: { borderColor: 'rgba(128, 128, 128, 0.25)' },
      leftPriceScale: { visible: series.some((s) => s.scale === 'left'), borderColor: 'rgba(128, 128, 128, 0.25)' },
      crosshair: { vertLine: { labelVisible: false } },
    })

    for (const s of series) {
      if (s.points.length === 0) continue
      const common = {
        priceScaleId: s.scale ?? 'right',
        priceLineVisible: false,
        lastValueVisible: true,
      }
      const data = s.points.map((p) => ({ time: p.time as Time, value: p.value }))
      if (s.area === true) {
        chart.addSeries(AreaSeries, {
          ...common,
          lineColor: s.color,
          topColor: s.color + '55',
          bottomColor: s.color + '08',
          lineWidth: 2,
        }).setData(data)
      } else {
        chart.addSeries(LineSeries, { ...common, color: s.color, lineWidth: 2 }).setData(data)
      }
    }
    chart.timeScale().fitContent()

    return () => {
      chart.remove()
    }
  }, [series])

  const legend = series.filter((s) => (s.title ?? '') !== '')
  return (
    <div className={cx('chart')}>
      {legend.length > 0 && (
        <div className={cx('chartLegend')}>
          {legend.map((s) => (
            <span key={s.id} className={cx('chartLegendItem')}>
              <span className={cx('chartLegendSwatch')} style={{ background: s.color }} />
              {s.title}
            </span>
          ))}
        </div>
      )}
      <div ref={containerRef} className={cx('chartCanvas')} />
    </div>
  )
}
