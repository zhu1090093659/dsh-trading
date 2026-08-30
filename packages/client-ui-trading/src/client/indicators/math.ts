/**
 * 指标数学内核：纯函数、无依赖、逐条对齐输入序列——每个返回数组的
 * 下标与输入 K 线一一对应，未达 warm-up 的位置为 undefined。
 * 这是指标注册表（registry.ts）唯一的计算层，也是自定义指标复用的入口。
 */

/** 序列对齐的指标值：undefined = warm-up 期，前端不画。 */
export type Series = ReadonlyArray<number | undefined>

/** 简单移动平均（滚动和，O(n)）。 */
export function sma(values: readonly number[], period: number): Series {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined)
  if (!valid(period, values.length)) return out
  let sum = 0
  for (let index = 0; index < values.length; index++) {
    sum += values[index] as number
    if (index >= period) sum -= values[index - period] as number
    if (index >= period - 1) out[index] = sum / period
  }
  return out
}

/** 指数移动平均（标准 EMA：种子 = 前 period 个的 SMA）。 */
export function ema(values: readonly number[], period: number): Series {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined)
  if (!valid(period, values.length)) return out
  const k = 2 / (period + 1)
  let seed = 0
  for (let index = 0; index < period; index++) seed += values[index] as number
  let prev = seed / period
  out[period - 1] = prev
  for (let index = period; index < values.length; index++) {
    prev = (values[index] as number) * k + prev * (1 - k)
    out[index] = prev
  }
  return out
}

/** 滚动样本标准差（无偏校正关——与主流行情软件一致用总体口径）。 */
export function stdev(values: readonly number[], period: number): Series {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined)
  if (!valid(period, values.length)) return out
  for (let index = period - 1; index < values.length; index++) {
    let mean = 0
    for (let offset = 0; offset < period; offset++) mean += values[index - offset] as number
    mean /= period
    let variance = 0
    for (let offset = 0; offset < period; offset++) {
      const delta = (values[index - offset] as number) - mean
      variance += delta * delta
    }
    out[index] = Math.sqrt(variance / period)
  }
  return out
}

/**
 * 布林带：返回中轨（SMA）与上下轨（中轨 ± N 倍标准差）。
 * 主图叠加指标，三条线共享 warm-up。
 */
export function bollinger(
  values: readonly number[],
  period: number,
  mult: number,
): { mid: Series; upper: Series; lower: Series } {
  const mid = sma(values, period)
  const sd = stdev(values, period)
  const upper: Array<number | undefined> = new Array(values.length).fill(undefined)
  const lower: Array<number | undefined> = new Array(values.length).fill(undefined)
  for (let index = 0; index < values.length; index++) {
    const base = mid[index]
    const dev = sd[index]
    if (base === undefined || dev === undefined) continue
    upper[index] = base + mult * dev
    lower[index] = base - mult * dev
  }
  return { mid, upper, lower }
}

/**
 * MACD：DIF = EMA(fast) - EMA(slow)；DEA = DIF 的 EMA(signal)；
 * 柱 = (DIF - DEA) × 2。warm-up 取两者较大者（EMA 串联）。
 */
export function macd(
  values: readonly number[],
  fast: number,
  slow: number,
  signal: number,
): { dif: Series; dea: Series; hist: Series } {
  const emaFast = ema(values, fast)
  const emaSlow = ema(values, slow)
  const dif: Array<number | undefined> = values.map((_, index) => {
    const a = emaFast[index]
    const b = emaSlow[index]
    return a === undefined || b === undefined ? undefined : a - b
  })
  // DEA 是 DIF 的 EMA：先压实 warm-up 段再算，摊平回原对齐。
  const compact = dif.filter((value): value is number => value !== undefined)
  const deaCompact = ema(compact, signal)
  const dea: Array<number | undefined> = new Array(values.length).fill(undefined)
  let cursor = 0
  for (let index = 0; index < values.length; index++) {
    if (dif[index] === undefined) continue
    dea[index] = deaCompact[cursor]
    cursor++
  }
  const hist: Array<number | undefined> = values.map((_, index) => {
    const d = dif[index]
    const e = dea[index]
    return d === undefined || e === undefined ? undefined : (d - e) * 2
  })
  return { dif, dea, hist }
}

/**
 * RSI（Wilder 平滑）。种子 = 前 period 个涨跌均值，其后
 * avgGain/avgLoss 递推；前 period 位为 undefined。
 */
export function rsi(values: readonly number[], period: number): Series {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined)
  if (!valid(period, values.length)) return out
  let gain = 0
  let loss = 0
  for (let index = 1; index <= period; index++) {
    const delta = (values[index] as number) - (values[index - 1] as number)
    if (delta >= 0) gain += delta
    else loss -= delta
  }
  gain /= period
  loss /= period
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  for (let index = period + 1; index < values.length; index++) {
    const delta = (values[index] as number) - (values[index - 1] as number)
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period
    out[index] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  }
  return out
}

/**
 * KDJ（RSV 的 SMA[Wilder] 平滑，初始值 50）。
 * 返回 k/d/j 三条序列；warm-up = N-1。
 */
export function kdj(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  n: number,
): { k: Series; d: Series; j: Series } {
  const length = closes.length
  const k: Array<number | undefined> = new Array(length).fill(undefined)
  const d: Array<number | undefined> = new Array(length).fill(undefined)
  const j: Array<number | undefined> = new Array(length).fill(undefined)
  if (!valid(n, length)) return { k, d, j }
  let prevK = 50
  let prevD = 50
  for (let index = n - 1; index < length; index++) {
    let hh = -Infinity
    let ll = Infinity
    for (let offset = 0; offset < n; offset++) {
      hh = Math.max(hh, highs[index - offset] as number)
      ll = Math.min(ll, lows[index - offset] as number)
    }
    const rsvValue = hh === ll ? 50 : ((closes[index] as number) - ll) / (hh - ll) * 100
    prevK = prevK + (rsvValue - prevK) / 3
    prevD = prevD + (prevK - prevD) / 3
    k[index] = prevK
    d[index] = prevD
    j[index] = 3 * prevK - 2 * prevD
  }
  return { k, d, j }
}

function valid(period: number, length: number): boolean {
  return Number.isFinite(period) && period >= 1 && length >= period
}
