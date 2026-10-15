/**
 * 上游 JSON 体的取值原语（discovery.ts 与 events.ts 共用，只此一份）。
 *
 * 为什么单独成模块：FOMC 发现面与事件检索面从同一份 gamma 半结构化体里取值，
 * 「字符串数字算不算数字」「空串算不算文本」「字符串化数组怎么拆」这三个口径一旦
 * 分叉，同一份上游数据会在两个工具面上给出不同答案。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 上游把数字既发成 number 也发成 string（`"0.835"`），两种都读；其余一律 undefined。 */
export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 非空字符串；`null` / 空串 / 纯空白一律 undefined（不当成空文本）。 */
export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 字符串化的 JSON 数组（gamma 的 `outcomes` / `outcomePrices`，如
 * `"[\"Yes\", \"No\"]"`）。解析失败或不是数组一律 undefined——不猜、不补空数组。
 */
export function parseStringArray(value: unknown): unknown[] | undefined {
  if (typeof value !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  return Array.isArray(parsed) ? parsed : undefined
}

/** 字符串化数组 → 数字数组（解析不出数字的项丢弃；全丢或非数组 = undefined）。 */
export function parseNumberArray(value: unknown): number[] | undefined {
  const raw = parseStringArray(value)
  if (raw === undefined) return undefined
  const parsed: number[] = []
  for (const item of raw) {
    const value = num(item)
    if (value !== undefined) parsed.push(value)
  }
  return parsed.length > 0 ? parsed : undefined
}

/** 字符串化数组 → 非空字符串数组（同 {@link parseNumberArray} 的丢弃口径）。 */
export function parseTextArray(value: unknown): string[] | undefined {
  const raw = parseStringArray(value)
  if (raw === undefined) return undefined
  const parsed: string[] = []
  for (const item of raw) {
    const value = text(item)
    if (value !== undefined) parsed.push(value)
  }
  return parsed.length > 0 ? parsed : undefined
}
