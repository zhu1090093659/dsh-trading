/**
 * 预置指标（仿富途：主图 MA/EMA/BOLL，副图 MACD/RSI/KDJ；副图另有成交「量」、
 * 全级别通用的「量比分档量能」、仅港股的「港股通持股比例」与仅 A 股的「主动买盘」
 * 三条外部序列/逐根序列指标）。全部是 definition 数据 + math.ts 纯函数的组合，无
 * 渲染逻辑；由指标插件（client-ui-indicators）注册进 tradingIndicators 服务。
 */
import type { IndicatorDefinition, IndicatorThemeColor, Kline } from './types.ts'
import { alignAuxToBars, FIVE_DAY_VOLUME_TIER_AUX_KEY, type AuxPoint } from './aux-series.ts'
import { bollinger, ema, kdj, macd, rsi, sma } from './math.ts'

/** MA 线配色（富途系配色 + 扩展周期轮换调色板）。 */
export const MA_COLORS: Record<string, string> = {
  MA5: '#e6b800',
  MA10: '#4a90e2',
  MA20: '#c05fd8',
  MA30: '#2ba471',
  MA60: '#f97316',
  MA120: '#0ea5e9',
  MA250: '#8a8f99',
}

/** EMA 线配色。 */
export const EMA_COLORS: Record<string, string> = {
  EMA5: '#e6b800',
  EMA6: '#e6b800',
  EMA10: '#4a90e2',
  EMA12: '#ff9800',
  EMA20: '#c05fd8',
  EMA26: '#00bcd4',
  EMA30: '#2ba471',
  EMA50: '#2ba471',
  EMA60: '#f97316',
  EMA120: '#0ea5e9',
  EMA200: '#8a8f99',
  EMA250: '#8a8f99',
}

/** 均线 6 色备用调色板（富途黄/蓝/紫/绿/橙/青）。 */
const FALLBACK_PALETTE: readonly string[] = ['#e6b800', '#4a90e2', '#c05fd8', '#2ba471', '#f97316', '#0ea5e9']

function maColor(period: number, index: number): string {
  return MA_COLORS[`MA${period}`] ?? FALLBACK_PALETTE[index % FALLBACK_PALETTE.length] ?? '#8a8f99'
}

function emaColor(period: number, index: number): string {
  return EMA_COLORS[`EMA${period}`] ?? FALLBACK_PALETTE[index % FALLBACK_PALETTE.length] ?? '#8a8f99'
}

const closesOf = (bars: readonly Kline[]): number[] => bars.map(bar => bar.close)

/** 港股通持股比例副图消费的外部序列键（宿主按此键 prefetch 并按同名键注入）。 */
const HK_CONNECT_HOLDING_AUX_KEY = 'hk-connect-holding'

/** 主动买盘副图消费的外部序列键（与桥端点同名，宿主按此键 prefetch 并注入）。 */
const ACTIVE_BUY_AUX_KEY = 'cn-active-buy'

/** 一天的毫秒数（K 线交易日归一到 UTC 00:00 用）。 */
const MS_PER_DAY = 86_400_000

/**
 * K 线 → 交易日（UTC 00:00），供日频外部序列对齐。日线及更细周期取 openTime
 * 当日（本仓日频 openTime 即 UTC 00:00，与外部序列一字对齐）：这时不用 closeTime，
 * 它是当日 23:59:59.999，一旦 openTime 带盘中偏移（如 09:30）向下取整就会进位到
 * 次日、吃到未来一天的值。周 K/月 K 则取 closeTime 当日——周期末，从而对齐到区间内
 * 最新已知值，而不是周期起点的旧值。
 */
function klineTradingDay(bar: Kline): number {
  const closeTime = bar.closeTime
  const periodEnd = typeof closeTime === 'number' && Number.isFinite(closeTime) ? closeTime : bar.openTime
  const tradingDay = periodEnd - bar.openTime >= 2 * MS_PER_DAY ? periodEnd : bar.openTime
  return Math.floor(tradingDay / MS_PER_DAY) * MS_PER_DAY
}

/**
 * K 线覆盖的 UTC 日区间 [首日 00:00, 末日 00:00]（含首尾）。日线开收盘同日 ⇒ 单日
 * 区间（等价于精确当日匹配）；周 K/月 K 跨多日 ⇒ 多日区间。closeTime 非有限或早于
 * openTime（脏数据）时退化为 openTime 当日。
 */
function klineCoverageRange(bar: Kline): readonly [number, number] {
  const start = Math.floor(bar.openTime / MS_PER_DAY) * MS_PER_DAY
  const closeTime = bar.closeTime
  const closeDay = typeof closeTime === 'number' && Number.isFinite(closeTime)
    ? Math.floor(closeTime / MS_PER_DAY) * MS_PER_DAY
    : start
  return closeDay > start ? [start, closeDay] : [start, start]
}

/**
 * 把日频外部序列对齐到 K 线：每根只取**落在该 K 线覆盖区间内**的最新一条值，区间内
 * 无点 ⇒ undefined，绝不沿用区间之前的点（无前向填充）。返回数组长度严格等于
 * bars.length。只依赖 points 升序（契约要求）且每根 K 线独立二分，不假设 bars 升序。
 */
function alignAuxToBarCoverage(
  bars: readonly Kline[],
  points: readonly AuxPoint[],
): Array<number | undefined> {
  const aligned = new Array<number | undefined>(bars.length)
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]
    if (bar === undefined) { aligned[index] = undefined; continue }
    const [start, end] = klineCoverageRange(bar)
    aligned[index] = valueWithinRange(points, start, end)
  }
  return aligned
}

/** 升序序列里 date ∈ [start, end] 的最后一条值；区间内无点（或序列为空）返回 undefined。 */
function valueWithinRange(points: readonly AuxPoint[], start: number, end: number): number | undefined {
  let low = 0
  let high = points.length - 1
  let hit = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    const point = points[mid]
    if (point === undefined) break
    if (point.date <= end) {
      hit = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  const point = hit < 0 ? undefined : points[hit]
  return point !== undefined && point.date >= start ? point.value : undefined
}

/** 量比分档的档位（输出序列 key = 图例名，也是着色分组）。 */
type VolumeTier = '无前值' | '量比<1' | '量比1-2' | '量比2-3' | '量比≥3'

/**
 * 档位色（亮/暗）：镜像 `packages/client-ui-trading/src/client/five-day-series.ts`
 * 的 TIER_COLORS_LIGHT / TIER_COLORS_DARK——「行情·5日」成交量档位色是这组色值的
 * 唯一事实来源，本表是逐档同值的副本（本包不能反向依赖 UI 包），改色必须两处同步。
 */
const VOLUME_TIER_THEME_COLORS: Record<VolumeTier, IndicatorThemeColor> = {
  无前值: { light: '#a8adb8', dark: '#6b7280' },
  '量比<1': { light: '#d9a01f', dark: '#e8c552' },
  '量比1-2': { light: '#ee7f72', dark: '#f0958b' },
  '量比2-3': { light: '#c62828', dark: '#e5484d' },
  '量比≥3': { light: '#1c1c1e', dark: '#f2f4f8' },
}

/** 档位顺序 = 输出顺序 = 图例顺序（灰档在前，其后按量比递增）。 */
const VOLUME_TIERS: readonly VolumeTier[] = ['无前值', '量比<1', '量比1-2', '量比2-3', '量比≥3']

/** 量比分档量能的前值窗口默认周期（params schema 与 compute 的缺参兜底共用一处）。 */
const VOLUME_TIER_DEFAULT_PERIOD = 4

/**
 * 量比 → 档位：阈值 1/2/3 分四档（比值恰好等于阈值时落**较高**一档，与五日图例
 * 「1 ≤ 量比 < 2」的区间语义一致）；undefined（无前值 / 不可判）落中性灰档。
 * `Number.POSITIVE_INFINITY`（前值无量但本周期有量）落最高档。
 */
function volumeTierOf(ratio: number | undefined): VolumeTier {
  if (ratio === undefined) return '无前值'
  if (ratio < 1) return '量比<1'
  if (ratio < 2) return '量比1-2'
  if (ratio < 3) return '量比2-3'
  return '量比≥3'
}

/**
 * 量比序列：本周期量 ÷ 前 N 个周期量均值（不含本周期，等价 REF(MA(volume, N), 1)）。
 * 长度严格等于 bars.length。判定顺序（前值无量那两条与「行情·5日」现行分支同口径，
 * 见 `packages/client-ui-trading/src/client/five-day-series.ts:220-225`）：
 * 1. 本周期量非有限（脏数据）→ undefined（灰）；
 * 2. 前值窗口不可用（前 N 根之内）或均值非有限（窗口含脏值）→ undefined（灰）；
 * 3. 前值均值 ≤ 0 且本周期有量 → `Number.POSITIVE_INFINITY`（比值发散，按最高档处理）；
 * 4. 前值均值 ≤ 0 且本周期量为 0 → undefined（比值无定义，灰）；
 * 5. 其余 → 本周期量 ÷ 前值均值（溢出的极端值照样发散，落最高档）。
 */
function volumeRatios(bars: readonly Kline[], period: number): Array<number | undefined> {
  const volumes = bars.map(bar => bar.volume)
  // sma[i-1] 正是「前 N 个周期（不含本周期）的均值」——REF(..., 1) 的直译。
  const priorMeans = sma(volumes, period)
  return bars.map((_bar, index) => {
    const volume = volumes[index]
    if (volume === undefined || !Number.isFinite(volume)) return undefined
    const mean = index >= 1 ? priorMeans[index - 1] : undefined
    if (mean === undefined || !Number.isFinite(mean)) return undefined
    if (mean <= 0) return volume > 0 ? Number.POSITIVE_INFINITY : undefined
    return volume / mean
  })
}

/**
 * 成交量柱的两条语义色（红涨绿跌缺省档 red-up 的 up/down，不透明度 0.55）：
 * 镜像 `packages/client-ui-trading/src/client/color-mode.ts` 的
 * `PALETTES['red-up'].upAlpha(0.55)` / `downAlpha(0.55)`（本包不能反向依赖 UI 包）。
 * 成交量柱有意的口径：只按涨跌语义配色，**不读**红涨绿跌设置——与五日档位色同款，
 * 换绿涨红跌不会把成交量柱的涨跌语义翻过来。
 */
const VOLUME_UP_COLOR = 'rgba(230, 69, 69, 0.55)'
const VOLUME_DOWN_COLOR = 'rgba(43, 164, 113, 0.55)'

/** 十个预置 definition（纯数据，注册时机归消费方）。 */
export function presetDefinitions(): IndicatorDefinition[] {
  return [
    {
      // MA：一组最多 6 条均线（周期可调，默认 5/10/20/30/60/120，0 表示隐藏）。
      id: 'ma',
      pane: 'main',
      title: 'MA',
      params: [
        { key: 'n1', label: '周期1', default: 5, min: 0, max: 250 },
        { key: 'n2', label: '周期2', default: 10, min: 0, max: 250 },
        { key: 'n3', label: '周期3', default: 20, min: 0, max: 250 },
        { key: 'n4', label: '周期4', default: 30, min: 0, max: 250 },
        { key: 'n5', label: '周期5', default: 60, min: 0, max: 250 },
        { key: 'n6', label: '周期6', default: 120, min: 0, max: 250 },
      ],
      compute(bars, params) {
        const closes = closesOf(bars)
        const periods = [params.n1, params.n2, params.n3, params.n4, params.n5, params.n6]
          .filter((period): period is number => typeof period === 'number' && Number.isFinite(period) && period > 0)
        return periods.map((period, index) => ({
          key: `MA${period}`,
          kind: 'line' as const,
          color: maColor(period, index),
          values: sma(closes, period),
        }))
      },
    },
    {
      // EMA：一组最多 6 条指数均线（周期可调，默认 5/10/20/30/60/120，0 表示隐藏）。
      id: 'ema',
      pane: 'main',
      title: 'EMA',
      params: [
        { key: 'n1', label: '周期1', default: 5, min: 0, max: 250 },
        { key: 'n2', label: '周期2', default: 10, min: 0, max: 250 },
        { key: 'n3', label: '周期3', default: 20, min: 0, max: 250 },
        { key: 'n4', label: '周期4', default: 30, min: 0, max: 250 },
        { key: 'n5', label: '周期5', default: 60, min: 0, max: 250 },
        { key: 'n6', label: '周期6', default: 120, min: 0, max: 250 },
      ],
      compute(bars, params) {
        const closes = closesOf(bars)
        const periods = [params.n1, params.n2, params.n3, params.n4, params.n5, params.n6]
          .filter((period): period is number => typeof period === 'number' && Number.isFinite(period) && period > 0)
        return periods.map((period, index) => ({
          key: `EMA${period}`,
          kind: 'line' as const,
          color: emaColor(period, index),
          values: ema(closes, period),
        }))
      },
    },
    {
      // BOLL：中轨 + 上下轨（20, ×2）。
      id: 'boll',
      pane: 'main',
      title: 'BOLL',
      params: [
        { key: 'n', label: '周期', default: 20, min: 2, max: 250 },
        { key: 'k', label: '倍数', default: 2, min: 1, max: 5 },
      ],
      compute(bars, params) {
        const { mid, upper, lower } = bollinger(closesOf(bars), params.n, params.k)
        return [
          { key: 'MID', kind: 'line', color: '#8a8f99', values: mid },
          { key: 'UP', kind: 'line', color: '#4a90e2', values: upper },
          { key: 'LOW', kind: 'line', color: '#4a90e2', values: lower },
        ]
      },
    },
    {
      // MACD：DIF/DEA 线 + 按符号红涨绿跌的柱（12,26,9）。
      id: 'macd',
      pane: 'sub',
      title: 'MACD',
      params: [
        { key: 'fast', label: '快线', default: 12, min: 2, max: 100 },
        { key: 'slow', label: '慢线', default: 26, min: 2, max: 200 },
        { key: 'signal', label: '信号', default: 9, min: 1, max: 60 },
      ],
      compute(bars, params) {
        const { dif, dea, hist } = macd(closesOf(bars), params.fast, params.slow, params.signal)
        return [
          { key: 'DIF', kind: 'line', color: '#e6b800', values: dif },
          { key: 'DEA', kind: 'line', color: '#4a90e2', values: dea },
          { key: 'HIST', kind: 'histogram', color: '#8a8f99', values: hist, histogramBySign: true },
        ]
      },
    },
    {
      // RSI（Wilder 平滑，14）。
      id: 'rsi',
      pane: 'sub',
      title: 'RSI',
      params: [{ key: 'n', label: '周期', default: 14, min: 2, max: 120 }],
      compute(bars, params) {
        return [{ key: `RSI${params.n}`, kind: 'line', color: '#c05fd8', values: rsi(closesOf(bars), params.n) }]
      },
    },
    {
      // KDJ（RSV 的 1/3 平滑，9）。
      id: 'kdj',
      pane: 'sub',
      title: 'KDJ',
      params: [{ key: 'n', label: '周期', default: 9, min: 1, max: 120 }],
      compute(bars, params) {
        const highs = bars.map(bar => bar.high)
        const lows = bars.map(bar => bar.low)
        const { k, d, j } = kdj(highs, lows, closesOf(bars), params.n)
        return [
          { key: 'K', kind: 'line', color: '#e6b800', values: k },
          { key: 'D', kind: 'line', color: '#4a90e2', values: d },
          { key: 'J', kind: 'line', color: '#c05fd8', values: j },
        ]
      },
    },
    {
      // 成交量（副图）：原来由图表层内置成 pane 1 特例的成交量柱搬进指标系统——它现在是
      // 一条可取消勾选的预置指标，取消后整个副图消失（客户端按实例存在与否建 pane）。
      // 柱高 = 本周期成交量；方向判据 = 收盘 ≥ 开盘记上涨（等号归上涨，二分覆盖完整），
      // 颜色是固定的上涨/下跌语义色，不读红涨绿跌设置；纵轴用成交量紧凑格式
      // （每条输出声明 priceFormat: 'volume'），不是价格两位小数。
      //   barAux：宿主在当前级别算得出五日同分钟档位序列时优先走 computeBarAux（改用档位
      // 色），算不出（非五日级别 / 该标的没有档位数据源）回落 compute —— 增强通道缺失
      // 绝不隐藏实例，这正是它与 aux 的分界。
      //   defaultActive：宿主启动时补种一次，见 chart-seed.ts。
      id: 'vol',
      pane: 'sub',
      title: '成交量',
      params: [],
      description: '柱高是本周期成交量；上涨（收盘 ≥ 开盘，等号归上涨）用红色、下跌用绿色，与 K 线方向判据同口径。'
        + '颜色是固定的涨跌语义色，不随红涨绿跌配色设置翻转。'
        + '当前级别能取到五日同分钟档位序列时（五日级别），柱色改用档位色（「行情·5日」的五档口径，见量比分档量能）；'
        + '取不到时回落涨跌色照常出柱。全市场、全 K 线级别通用。',
      defaultActive: true,
      barAux: [FIVE_DAY_VOLUME_TIER_AUX_KEY],
      compute(bars) {
        return [
          {
            key: '上涨量',
            kind: 'histogram' as const,
            color: VOLUME_UP_COLOR,
            // 非有限成交量（脏数据）不出柱：绝不把 NaN/Infinity 交给渲染层。
            values: bars.map(bar => (Number.isFinite(bar.volume) && bar.close >= bar.open ? bar.volume : undefined)),
            priceFormat: 'volume' as const,
          },
          {
            key: '下跌量',
            kind: 'histogram' as const,
            color: VOLUME_DOWN_COLOR,
            values: bars.map(bar => (Number.isFinite(bar.volume) && bar.close < bar.open ? bar.volume : undefined)),
            priceFormat: 'volume' as const,
          },
        ]
      },
      computeBarAux(bars, _params, barAux) {
        // 逐根档位编码 → 档位名：编码即 VOLUME_TIERS 的下标（0 无前值 / 1 量比<1 /
        // 2 量比1-2 / 3 量比2-3 / 4 量比≥3，与 FIVE_DAY_VOLUME_TIER_CODES 同序）。
        // 越界（含小数、负数、超范围）与 undefined 都不等于任何合法下标 ⇒ 该根不出柱。
        const tiers = barAux[FIVE_DAY_VOLUME_TIER_AUX_KEY]
        return VOLUME_TIERS.map((tier, tierIndex) => ({
          key: tier,
          kind: 'histogram' as const,
          // color 是必需字段：填同语义的亮色值，消费方优先读 themeColor（与 vol-tier 同一张色表）。
          color: VOLUME_TIER_THEME_COLORS[tier].light,
          themeColor: VOLUME_TIER_THEME_COLORS[tier],
          // 柱高 = 本周期成交量，档位只决定颜色：每根至多落一条。
          values: bars.map((bar, index) => (
            tiers?.[index] === tierIndex && Number.isFinite(bar.volume) ? bar.volume : undefined
          )),
          // 与 compute 同口径：柱高是成交量，纵轴用成交量紧凑格式。
          priceFormat: 'volume' as const,
        }))
      },
    },
    {
      // 量比分档量能（副图）：把「行情·5日」的成交量档位着色泛化成全级别通用的预置
      // 指标。柱高 = 本周期的成交量（与五日级别同款：档位只决定颜色，不改柱高），
      // 颜色按量比分档——因此每根柱只落在五条输出中的一条，其余四条在该下标留空。
      // 前值无量时的「有无本周期量」分支与 five-day-series.ts:220-225 同口径。
      // 默认勾选（defaultActive）：宿主启动时补种一次，见 chart-seed.ts。
      id: 'vol-tier',
      pane: 'sub',
      title: '量比分档量能',
      params: [{ key: 'n', label: '周期', default: VOLUME_TIER_DEFAULT_PERIOD, min: 2, max: 250 }],
      description: '成交量按量比分档着色：量比 = 本周期成交量 ÷ 前 N 个周期成交量均值（不含本周期，等价 REF(MA(volume, N), 1)），'
        + '阈值 1 / 2 / 3 分四档（量比 < 1、1 ≤ 量比 < 2、2 ≤ 量比 < 3、量比 ≥ 3）。'
        + '前值窗口不可用（前 N 个周期之内，或前值含脏数据）走中性灰档；'
        + '前值无量（前值均值为 0）时，本周期也无量走中性灰档，本周期有量则比值发散、按最高档处理（与「行情·5日」同口径）。'
        + '柱高是本周期成交量，档位只决定颜色；全市场、全 K 线级别通用。'
        + '着色读的是量比而不是涨跌，因此不受红涨绿跌配色设置影响。',
      defaultActive: true,
      compute(bars, params) {
        const ratios = volumeRatios(bars, Math.round(params.n ?? VOLUME_TIER_DEFAULT_PERIOD))
        return VOLUME_TIERS.map(tier => ({
          key: tier,
          kind: 'histogram' as const,
          // color 是必需字段：填同语义的亮色值，消费方优先读 themeColor。
          color: VOLUME_TIER_THEME_COLORS[tier].light,
          themeColor: VOLUME_TIER_THEME_COLORS[tier],
          // 柱高 = 本周期成交量；非有限（脏数据）不出柱，绝不把 NaN/Infinity 交给渲染层。
          values: bars.map((bar, index) => (
            volumeTierOf(ratios[index]) === tier && Number.isFinite(bar.volume) ? bar.volume : undefined
          )),
        }))
      },
    },
    {
      // 港股通持股比例（副图，仅港股；决策 7：日线及以上才适用，级别过滤归实例侧）：
      // 数据来自宿主预取的日频外部序列（aux 声明的键），无参数，单条 line。
      id: 'hk-connect-holding',
      pane: 'sub',
      title: '港股通持股比例',
      params: [],
      markets: ['hk'],
      // 决策 7 的默认适用范围只在这里声明一次：数据是日频序列，分钟级上会被前向
      // 填充成一整段平移直线，故新实例默认只勾 1d/1w/1M（GUI 挂载、indicator_activate
      // 与桥 PUT 三条创建路径共用本声明）。
      defaultApplyScope: { hk: { enabled: true, intervals: ['1d', '1w', '1M'] } },
      aux: [HK_CONNECT_HOLDING_AUX_KEY],
      compute() {
        // 声明了 aux 的指标由宿主走 computeAux（契约 §3 二选一）：旧宿主若误调
        // compute，返回空输出即「什么都不画」，绝不降级为一条贴底的零线。
        return []
      },
      computeAux(bars, _params, aux) {
        const points = aux[HK_CONNECT_HOLDING_AUX_KEY]
        // 无数据（未取到 / 标的不在港股通范围）→ 空输出：消费方据此隐藏该副图
        // pane（决策 3），空 ≠ 0。
        if (points === undefined || points.length === 0) return []
        const aligned = alignAuxToBars(bars, points, klineTradingDay)
        return [{
          key: 'HK_CONNECT_HOLDING',
          kind: 'line',
          color: '#7c5cff',
          // 非有限值（脏数据）按 warm-up 处理：曲线断开，不把 NaN 交给渲染层。
          values: aligned.map(value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)),
          precision: 2,
        }]
      },
    },
    {
      // 主动买盘（副图，仅 A 股）：数据来自宿主预取的日频外部序列（aux 声明的键），
      // 序列值语义 = 净主动买占当日总量百分比；无参数，两条输出（净买柱 + 买占线）。
      id: 'active-buy',
      pane: 'sub',
      title: '主动买盘',
      params: [],
      markets: ['cn'],
      description: '数据源：本地累积的腾讯盘口快照推断的内外盘（非交易所官方逐笔方向，涨跌停/对倒日失真）。'
        + '红柱为净主动买占当日总量百分比，蓝线为主动买占比 ((100 + 净买占比) / 2，前提是外盘 + 内盘 ≈ 当日总量，'
        + '两者的差值是未归向成交、量级不固定)。'
        + '当日柱为盘中累计到最新取数时刻，收盘后收敛为当日终值；某交易日没有采集到读数就是空的，不插值、不沿用前一交易日。',
      // 与港股通持股比例同款（决策 7）：数据是日频序列，分钟级一根 bar 只匹配到当日
      // 那一条点（同一交易日内重复取值、不给额外信息），故新实例默认只勾 1d/1w/1M
      // （GUI 挂载、indicator_activate 与桥 PUT 三条创建路径共用本声明）。
      defaultApplyScope: { cn: { enabled: true, intervals: ['1d', '1w', '1M'] } },
      aux: [ACTIVE_BUY_AUX_KEY],
      compute() {
        // 声明了 aux 的指标由宿主走 computeAux（契约 §3 二选一）：旧宿主若误调
        // compute，返回空输出即「什么都不画」，绝不降级为一条贴底的零线。
        return []
      },
      computeAux(bars, _params, aux) {
        const points = aux[ACTIVE_BUY_AUX_KEY]
        // 无数据（未取到 / 该标的无盘口推断记录）→ 空输出：消费方据此隐藏整个副图
        // pane（决策 3），空 ≠ 0。
        if (points === undefined || points.length === 0) return []
        // 区间内匹配（无前向填充）：只取本 bar 覆盖区间内的点，区间内无点即留空。
        const aligned = alignAuxToBarCoverage(bars, points)
        // 非有限值（脏数据）按 warm-up 处理：曲线断开，不把 NaN 交给渲染层。
        const net = aligned.map(value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined))
        return [
          {
            key: '净买',
            kind: 'histogram',
            histogramBySign: true,
            color: '#e64545',
            values: net,
            precision: 2,
          },
          {
            key: '买占',
            kind: 'line',
            color: '#3b82f6',
            // 口径恒等式：买占 = (100 + 净买占比) / 2。前提是「外盘 + 内盘 ≈ 当日总量」：
            // 总量 −（外盘+内盘）之差是**未归向成交**（集合竞价与价间成交计入总量却不计入
            // 内外盘），量级不固定——本数据集 5 标的实测最大 0.071%（517520 2026-09-18），
            // 单条报价行盘中可达 0.63%（600519 2026-10-13 10:09 实测）。故本式是**派生值**，
            // 与源记录里的 buySharePct 相差「残差 / 2」（本数据集 ≤0.036 个百分点）。只取一条
            // aux 序列（净买）而不注入两条，是有意的取舍：偏差比读图分辨率低一个量级。
            // 对齐上不做前向填充（上面的区间内匹配）：aux 值语义是「某一日的当日累计占比」，
            // 跨日沿用会把昨日读数画成今日累计——把「没数据」伪装成「有数据」，比留空更糟。
            values: net.map(value => (value === undefined ? undefined : (100 + value) / 2)),
            precision: 2,
          },
        ]
      },
    },
  ]
}

