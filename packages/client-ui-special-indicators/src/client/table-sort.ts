/**
 * 表列排序（纯函数，零运行时依赖）：点表头三态循环 + Shift 追加次级排序键。
 *
 * 口径（2026-11-10 用户裁决，与自选列表头三态排序同款）：
 * - 普通点击：该列已是唯一键时 降序 → 升序 → 取消（回上游默认顺序）；
 *   否则一律重置为「只有该列、降序」——点哪列就以哪列为主键。
 * - Shift 点击：追加为次级键（已在键里则移除）；首键用 Shift 点掉即整表回默认顺序。
 * - 缺值（null / undefined / NaN）恒排末尾，与方向无关：上游给不出数值的行不该因为
 *   排序方向不同而挤到最前（自选列表头「未知涨跌幅排末尾」同口径）。
 * - 并列行保持上游顺序（稳定排序）：排序只重排，不改变上游对同值行的相对次序。
 */

export type SortDir = 'asc' | 'desc'

export interface SortKey {
  key: string
  dir: SortDir
}

/** 点表头后的新键表（additive = 按住 Shift）。 */
export function nextSortKeys(current: readonly SortKey[], key: string, additive: boolean): SortKey[] {
  if (additive) {
    const without = current.filter((k) => k.key !== key)
    if (without.length !== current.length) return without
    return [...current, { key, dir: 'desc' }]
  }
  const sole = current.length === 1 ? current[0] : undefined
  if (sole !== undefined && sole.key === key) {
    return sole.dir === 'desc' ? [{ key, dir: 'asc' }] : []
  }
  return [{ key, dir: 'desc' }]
}

function compareValues(a: number | null | undefined, b: number | null | undefined, dir: SortDir): number {
  const av = Number.isFinite(a) ? (a as number) : null
  const bv = Number.isFinite(b) ? (b as number) : null
  if (av === null && bv === null) return 0
  if (av === null) return 1
  if (bv === null) return -1
  return dir === 'desc' ? bv - av : av - bv
}

/** 按键表排序（稳定；键表为空即上游顺序）。valueOf 取该行的列值。 */
export function sortRows<T>(
  rows: readonly T[],
  keys: readonly SortKey[],
  valueOf: (row: T, key: string) => number | null | undefined,
): T[] {
  if (keys.length === 0) return rows.slice()
  const decorated = rows.map((row, index) => ({ row, index }))
  decorated.sort((a, b) => {
    for (const sortKey of keys) {
      const cmp = compareValues(valueOf(a.row, sortKey.key), valueOf(b.row, sortKey.key), sortKey.dir)
      if (cmp !== 0) return cmp
    }
    return a.index - b.index
  })
  return decorated.map((entry) => entry.row)
}

/** 持久化面收敛：只留合法列 + 合法方向，同列去重保序，超出列数的尾巴丢弃。 */
export function sanitizeSortKeys(raw: unknown, allowed: readonly string[]): SortKey[] {
  if (!Array.isArray(raw)) return []
  const out: SortKey[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const key = (entry as { key?: unknown }).key
    const dir = (entry as { dir?: unknown }).dir
    if (typeof key !== 'string' || !allowed.includes(key)) continue
    if (dir !== 'asc' && dir !== 'desc') continue
    if (out.some((k) => k.key === key)) continue
    out.push({ key, dir })
    if (out.length >= allowed.length) break
  }
  return out
}
