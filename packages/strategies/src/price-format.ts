/**
 * 标的价格显示小数位（自适应，全局显示约定单一来源）：
 * ≥1 默认 2 位；当 2 位舍入会丢失第 3 位有效小数（如港股 0.001 tick、
 * 低价权证/债券）时升到 3 位；<1 按量级 4/6 位（低价加密对）。
 * 1e-9 容差只滤浮点表示噪声——常规价位下它比第 3 位小数量级低多个数量级。
 *
 * client-ui-trading / client-ui-strategies 经本包复用同一规则；范式策略的
 * compute 因需自包含（compute.toString() 导出可编译源码）内联同式实现，
 * 两处改动必须同步。
 */
export function priceDigits(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 2
  const abs = Math.abs(value)
  if (abs < 1) return abs >= 0.01 ? 4 : 6
  const rounded = Number(value.toFixed(2))
  return Math.abs(rounded - value) < 1e-9 ? 2 : 3
}

/** 价格文本：undefined/NaN → '—'，否则按 priceDigits 定点舍入。 */
export function fmtPrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return value.toFixed(priceDigits(value))
}
