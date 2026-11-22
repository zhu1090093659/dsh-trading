/**
 * 「ETF 托底」副图的组件级 UI harness（scripts/ui-component-check.mjs 装载）。
 *
 * 场景：A 股宽基标的挂载预置指标 cn-etf-rescue 后，副图里出现「ETF渗透% / 非300渗透%」
 * 两条百分比线，图例与纵轴读数都按两位小数呈现。数据面自桩——harness 用真实预置
 * definition + 真实调度 + 真实图形组件，只把宿主取数的结果换成两条形状正确的
 * EtfRescueHistory（经客户端真实映射函数 etfRescueToAuxPoints 拆成两条 aux 序列），
 * 因此被验的是「客户端接线 + 渲染」这一段，不需要后端。
 *
 * 断言三条（读图核对之外的机器判据）：
 * 1) 图例文字：标题「ETF托底」+ 两条输出的键名与两位小数读数；
 * 2) 两条线真的画在 canvas 上：按输出色数像素（#e64545 / #3b82f6）；
 * 3) 纵轴按百分比数值：输出 priceFormat 的 precision=2 / minMove=0.01（轴标签分辨率）。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createIndicatorRegistry, presetDefinitions } from '@dshtrading/indicators'
import type { EtfRescueHistory } from '@dshtrading/api'
import type { Kline } from '@dshtrading/indicators'
import { TvChart, outputPriceFormat, toBar } from '../src/client/TvChart.tsx'
import { dispatchIndicatorGroups } from '../src/client/indicator-dispatch.ts'
import { CN_ETF_RESCUE_BREADTH_KEY, CN_ETF_RESCUE_DEPTH_KEY, etfRescueToAuxPoints } from '../src/client/aux-series.ts'

const DAY = 86_400_000
const BAR_COUNT = 40
const ETF_RESCUE_ID = 'cn-etf-rescue'

/** 预置 definition（真实名册，不手写假体）：id/图例名/配色/精度都取自随包分发的那一份。 */
const registry = createIndicatorRegistry()
for (const definition of presetDefinitions()) registry.register(definition)
const definition = registry.get(ETF_RESCUE_ID)
if (definition === undefined) throw new Error('preset cn-etf-rescue missing')

/** 40 个交易日的 K 线（自桩行情，只用作 x 轴与对齐基准）。 */
const bars: Kline[] = Array.from({ length: BAR_COUNT }, (_, index) => {
  const openTime = Date.UTC(2026, 8, 1) + index * DAY
  const close = 10 + Math.sin(index / 4) * 0.6 + index * 0.02
  return {
    openTime,
    closeTime: openTime + DAY - 1,
    open: close - 0.1,
    high: close + 0.15,
    low: close - 0.15,
    close,
    volume: 1000 + index,
  }
})

/**
 * 自桩数据面：两条序列都有形状正确的一条历史（第 20、21 个交易日缺份额/净值 ⇒ 当日
 * 不出点，曲线在此断开——这正是「空 ≠ 0，不插值、不前向填充」的可见形态）。
 */
const rescueHistory: EtfRescueHistory = {
  symbol: '510300.SH',
  indexCode: '000300',
  depthLabel: '沪深300ETF',
  points: bars
    .map((bar, index) => ({ index, date: bar.openTime }))
    .filter(entry => entry.index !== 20 && entry.index !== 21)
    .map(({ index, date }) => ({ date, depthPct: 0.8 + index * 0.01, breadthPct: 1.6 + index * 0.015 })),
}

const aux = {
  [CN_ETF_RESCUE_DEPTH_KEY]: etfRescueToAuxPoints(rescueHistory, CN_ETF_RESCUE_DEPTH_KEY) ?? [],
  [CN_ETF_RESCUE_BREADTH_KEY]: etfRescueToAuxPoints(rescueHistory, CN_ETF_RESCUE_BREADTH_KEY) ?? [],
}

/** 真实调度：就绪判定 + computeAux 都走生产实现（数据缺席时这里会出占位组，不会出线）。 */
const groups = dispatchIndicatorGroups({
  klines: bars,
  instances: [{ id: ETF_RESCUE_ID, params: {} }],
  market: 'cn',
  symbol: '510300.SH',
  aux,
  liveKeys: [],
  deps: {
    getDefinition: id => registry.get(id),
    clampParams: (entry, params) => registry.clampParams(entry, params),
    instanceKey: instance => registry.instanceKey(instance),
  },
})

const subIndicators = groups.filter(group => group.pane === 'sub').map(group => ({
  key: group.key,
  ...(group.title === undefined ? {} : { title: group.title }),
  outputs: group.outputs,
}))

const host = document.getElementById('root') as HTMLElement
host.style.width = '900px'
host.style.height = '720px'
host.style.margin = '0'

createRoot(host).render(createElement(TvChart, {
  bars: bars.map(toBar),
  dataKey: 'cn:510300.SH:1d',
  intraday: false,
  mainOverlays: [],
  subIndicators,
  // 读数回落到最后一根：副图 legend 只在有读数下标时显示（与生产默认一致）。
  readoutIndex: bars.length - 1,
  onHoverIndex: () => undefined,
}))

/** 按文本取图例元素（CSS module 类名被 hash，不能靠类名选）。 */
const spanWithPrefix = (prefix: string): Element | undefined => [...document.querySelectorAll('span')]
  .find(el => (el.textContent ?? '').startsWith(prefix))

/**
 * 输出色像素统计（抗锯齿留 ±26 容差），**只数副图区域**：
 * 主图的红涨蜡烛用的正是 #e64545（color-mode 的 upColor），全图计数会把 40 根阳线
 * 一起算进来——那样的「红色像素很多」证明不了副图那条线。副图顶界取该组图例 div 的
 * 上沿（legend 定位规则：left 8 / top paneTop + 4）。
 * 返回值带上匹配像素的纵向跨度（CSS px）：一条有斜率的线必然跨若干十像素，
 * 而图例色块只是一小块。
 */
const colorPixelsInSubPane = (target: readonly [number, number, number]): { count: number, spanY: number } => {
  const legend = spanWithPrefix('ETF渗透%:')
  const legendBox = legend?.parentElement?.getBoundingClientRect()
  if (legendBox === undefined) return { count: -1, spanY: -1 }
  let count = 0
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const canvas of [...document.querySelectorAll('canvas')]) {
    const context = canvas.getContext('2d')
    if (context === null) continue
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    const scaleY = rect.height / canvas.height
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    for (let y = 0; y < canvas.height; y += 1) {
      const viewportY = rect.top + y * scaleY
      if (viewportY < legendBox.top) continue
      for (let x = 0; x < canvas.width; x += 1) {
        const i = (y * canvas.width + x) * 4
        if ((data[i + 3] ?? 0) < 128) continue
        if (Math.abs((data[i] ?? 0) - target[0]) > 26) continue
        if (Math.abs((data[i + 1] ?? 0) - target[1]) > 26) continue
        if (Math.abs((data[i + 2] ?? 0) - target[2]) > 26) continue
        count += 1
        if (viewportY < minY) minY = viewportY
        if (viewportY > maxY) maxY = viewportY
      }
    }
  }
  return { count, spanY: count === 0 ? 0 : Math.round(maxY - minY) }
}

window.__h = { spanWithPrefix, colorPixelsInSubPane, groups, subIndicators, outputPriceFormat }

window.__uiHarness = {
  ready: (async () => {
    await new Promise(resolve => setTimeout(resolve, 400))
    return true
  })(),
  steps: [
    {
      name: 'etf-rescue-sub-pane',
      run: "(() => { document.getElementById('root').scrollIntoView(); })()",
      expect: `(() => {
        const legend = __h.spanWithPrefix('ETF渗透%:');
        const breadth = __h.spanWithPrefix('非300渗透%:');
        const depth = __h.colorPixelsInSubPane([230, 69, 69]);
        const blue = __h.colorPixelsInSubPane([59, 130, 246]);
        const formats = __h.groups[0] ? __h.groups[0].outputs.map((o) => __h.outputPriceFormat(o)) : [];
        const percentAxis = formats.length === 2 && formats.every((f) => f.type === 'price' && f.precision === 2 && f.minMove === 0.01);
        const groups = __h.groups.map((g) => g.outputs.map((o) => o.key));
        // 每条线：副图区域内的落笔像素足够多（一条横贯整幅的线 ≈ 1500+ 像素），
        // 且纵向跨度不是一条水平直线（本套数据两条线都在抬升，跨度按各自口径 ≥ 15px）。
        const drawn = depth.count > 800 && depth.spanY >= 15 && blue.count > 800 && blue.spanY >= 15;
        return {
          ok: legend !== undefined && breadth !== undefined && drawn && percentAxis,
          detail: '图例「' + (legend ? legend.textContent : '缺') + '」「' + (breadth ? breadth.textContent : '缺') + '」'
            + '；副图线 深红 ' + depth.count + 'px/跨度 ' + depth.spanY + 'px，蓝 ' + blue.count + 'px/跨度 ' + blue.spanY + 'px'
            + '；轴格式 ' + JSON.stringify(formats)
            + '；组 ' + JSON.stringify(groups),
        };
      })()`,
    },
  ],
}
