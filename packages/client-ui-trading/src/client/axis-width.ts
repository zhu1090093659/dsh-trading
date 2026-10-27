/**
 * 价格轴宽度下限（px）：锁死「轴宽 ↔ 绘图区宽」这条正反馈。
 *
 * lwc 的价格轴宽度 = 当前刻度标签里最宽的那一条（+ 轴内边距），而绘图区宽度 =
 * 容器宽 - 左轴宽 - 右轴宽。绘图区一变，可视 K 线根数随之变，自缩放的价格区间
 * 随之变，刻度标签随之变，轴宽又变……右侧「相对涨跌幅」轴的标签长度尤其不稳
 * （正数不带正号、量级跨 10/100 各差一个字符、参考价还来自可视区最左一根），
 * 于是某些容器宽度下整条链路无限抖动：2026-09-15 headless 实测同一张图在
 * 625px 容器宽下右轴在 58 ↔ 66 ↔ 72px（5/6/7 字符标签）之间反复跳，蜡烛随
 * 绘图区宽度重排重定标，肉眼就是「图表疯狂抖动」。
 *
 * 解法：给轴一个与可视区无关的宽度下限。按当前数据的价格极值算出可能出现的
 * 最宽标签，取其浏览器文本宽度 + lwc 轴内边距。下限只随数据变化，可视区再变
 * 也改不动轴宽，反馈断开（实测下限 84px 时该宽度下只剩 1 个稳定状态）。
 */
/** 轴标签字体：与 TvChart 的 getChartThemeOptions 同源，改动须同步。 */
export const AXIS_FONT_SIZE = 10.5
export const AXIS_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, sans-serif'

/** lwc 价格轴上下留白（与 TvChart 的 scaleMargins 同源：两轴同值，刻度行才逐行对齐）。 */
export const AXIS_SCALE_MARGIN = 0.08

/** lwc 轴标签内边距（实测 26.4-28.1px，取 32 保守值：偏大只多几像素留白，偏小会重新抖）。 */
const AXIS_LABEL_MARGIN = 32

export interface PercentAxisExtremes {
  /** 价格轴自缩放包络的下/上界（蜡烛高低 ∪ 主图指标输出）。 */
  minPrice: number
  maxPrice: number
  /** 闭区间收盘价极值——可视区口径的参考价（最左一根收盘）必落在此区间内。 */
  minClose: number
  maxClose: number
  /**
   * 固定参考价（五日级别 = 昨收）：给了就按它直接算两端标签。固定锚点可以落在可视收盘
   * 区间之外，此时上面的收盘包络会低估涨跌幅度，候选也就不再保宽。
   */
  ref?: number | null
}

/**
 * 右轴百分比参考价的固定锚点：合法正价 → 该值；否则 null（退回「可视区最左一根收盘」）。
 * formatter（TvChart.mirrorPercentFormat）与宽度下限共用本函数，口径只有这一份。
 */
export function percentAxisRef(percentRef: number | null | undefined): number | null {
  return percentRef !== null && percentRef !== undefined && Number.isFinite(percentRef) && percentRef > 0 ? percentRef : null
}

/**
 * 相对参考价的百分比标签（右轴 formatter 与宽度下限同源，杜绝两份口径漂移）。
 * 正数不带正号、两位小数、带 %（同花顺式）；参考价非正/非有限 → 空串。
 */
export function percentLabel(value: number, ref: number | null): string {
  if (ref === null || !Number.isFinite(ref) || ref <= 0 || !Number.isFinite(value)) return ''
  return `${((value - ref) / ref * 100).toFixed(2)}%`
}

/**
 * 轴留白外扩量：scaleMargins 把可见价格范围撑到数据范围之外——数据区间 D 只占轴高的
 * 1-2m，故轴范围 = D/(1-2m)，上/下各多出 D·m/(1-2m)（m=0.08 时 ≈ 9.52%·D）。顶端
 * 刻度因此可以高于数据最高价，候选标签必须按外扩后的边界取；否则在量级边界附近会少算
 * 一个字符（如数据最大涨幅 9.5% 时真实标签已是 10.40%），下限压不住自然轴宽，抖动回来。
 */
function axisPadding(span: number): number {
  return span * AXIS_SCALE_MARGIN / (1 - 2 * AXIS_SCALE_MARGIN)
}

/**
 * 右轴可能出现的两个最宽标签：正向极值在「参考价取最小收盘、价格取轴范围上界」时取到，
 * 负向极值在「参考价取最大收盘、价格取轴范围下界」时取到。返回文本即 formatter 输出。
 */
export function percentLabelCandidates(extremes: PercentAxisExtremes): string[] {
  const { minPrice, maxPrice, minClose, maxClose } = extremes
  const span = Number.isFinite(minPrice) && Number.isFinite(maxPrice) ? Math.max(0, maxPrice - minPrice) : 0
  const pad = axisPadding(span)
  // 固定锚点优先；否则沿用收盘包络的两端（参考价未知，但必落在区间内）。
  const anchor = percentAxisRef(extremes.ref)
  const rise = percentLabel(maxPrice + pad, anchor ?? minClose)
  const fall = percentLabel(minPrice - pad, anchor ?? maxClose)
  return [rise === '' ? '0.00%' : rise, fall === '' ? '0.00%' : fall]
}

/** 标签集合里最宽一条的浏览器文本宽度 + 轴内边距；无 DOM（node 单测）时回 0。 */
export function axisMinimumWidth(labels: readonly string[]): number {
  if (typeof document === 'undefined') return 0
  const context = document.createElement('canvas').getContext('2d')
  if (context === null) return 0
  context.font = `${AXIS_FONT_SIZE}px ${AXIS_FONT_FAMILY}`
  let widest = 0
  for (const label of labels) widest = Math.max(widest, context.measureText(label).width)
  return Math.ceil(widest) + AXIS_LABEL_MARGIN
}
