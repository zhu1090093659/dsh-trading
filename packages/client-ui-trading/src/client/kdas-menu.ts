/**
 * KDAS 关键日右键菜单动作推导（纯函数，QuoteStage 菜单与单测消费）。
 *
 * 口径契约（与 custom 指标 kdas 的 computeSource 一致，勿单方改动）：
 * - Key Day 存储值为 YYYYMMDD 数字（20000101..20991231，0 = 槽位未用，kd1..kd8）；
 * - 交易日取 K 线 openTime 的 UTC 日期——港股日 K 的 openTime 落在 HKT 零点
 *   （= 前一日 16:00Z），图表轴显示的本地日期与存储值可差一天，这是 compute 的
 *   既有口径（见 weekly-trading-plan skill 的 kdas.py 注释）；菜单的取日与锚定
 *   判定必须与 compute 同源（都用 UTC 日），显示标签才是本地口径的换算层；
 * - 锚定 = 第一根交易日 >= kd 的 K 线；多个 kd 同锚时 compute 去重只画一条，
 *   因此「点击已锚定的 K 线」语义是删除其存储 kd，而不是再添一条同锚线。
 */

export const KDAS_SLOTS = 8

export interface KdasSlot {
  readonly slot: number
  readonly kd: number
}

/** openTime 毫秒 → YYYYMMDD（UTC）；非法输入返回 0。与 kdas compute 的 dayNum 同源。 */
export function utcDayNum(openTimeMs: number): number {
  const date = new Date(openTimeMs)
  if (!Number.isFinite(date.getTime())) return 0
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate()
}

/** YYYYMMDD → 'YYYY-MM-DD'（存储口径的显示形式；非 8 位原样字符串化）。 */
export function formatKdasDay(kd: number): string {
  const text = String(kd)
  return text.length === 8 ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text
}

/** kd → kdas compute 的 output key（KDAS_YY-MM-DD），供菜单按线取色。 */
export function kdasOutputKey(kd: number): string {
  const text = String(kd)
  return 'KDAS_' + text.slice(2, 4) + '-' + text.slice(4, 6) + '-' + text.slice(6, 8)
}

/** 存储值合法性（与 compute 的 raw 过滤同规则：整数且落在 2000..2099 年）。 */
export function isKdasDayValue(kd: number): boolean {
  return Number.isInteger(kd) && kd >= 20000101 && kd <= 20991231
}

function slotValue(params: Record<string, number>, slot: number): number {
  const raw = Math.round(Number(params['kd' + slot] ?? 0))
  return Number.isFinite(raw) ? raw : 0
}

/** 当前全部有效 Key Day（槽位序 1..8；重复值保留最小槽位，非法值跳过）。 */
export function kdasSlots(params: Record<string, number> | undefined): KdasSlot[] {
  const out: KdasSlot[] = []
  if (params === undefined) return out
  const seen = new Set<number>()
  for (let slot = 1; slot <= KDAS_SLOTS; slot++) {
    const kd = slotValue(params, slot)
    if (!isKdasDayValue(kd) || seen.has(kd)) continue
    seen.add(kd)
    out.push({ slot, kd })
  }
  return out
}

/** kd 是否已占用任一槽位。 */
export function isKdasDay(params: Record<string, number> | undefined, kd: number): boolean {
  return kdasSlots(params).some(entry => entry.kd === kd)
}

/** 第一个空槽（1..8）；满槽返回 null。 */
export function freeKdasSlot(params: Record<string, number> | undefined): number | null {
  if (params === undefined) return 1
  for (let slot = 1; slot <= KDAS_SLOTS; slot++) {
    if (!isKdasDayValue(slotValue(params, slot))) return slot
  }
  return null
}

export type KdasAddResult =
  | { ok: true; params: Record<string, number>; slot: number }
  | { ok: false; reason: 'duplicate' | 'full' }

/** 追加一个 Key Day（写第一个空槽，返回完整 8 键参数表；重复/满槽拒绝）。 */
export function addKdasDay(params: Record<string, number>, kd: number): KdasAddResult {
  if (!isKdasDayValue(kd) || isKdasDay(params, kd)) return { ok: false, reason: 'duplicate' }
  const slot = freeKdasSlot(params)
  if (slot === null) return { ok: false, reason: 'full' }
  const next: Record<string, number> = {}
  for (let i = 1; i <= KDAS_SLOTS; i++) next['kd' + i] = slotValue(params, i)
  next['kd' + slot] = kd
  return { ok: true, params: next, slot }
}

export type KdasRemoveResult =
  | { ok: true; params: Record<string, number>; slot: number }
  | { ok: false; reason: 'missing' }

/** 移除一个 Key Day（该槽位归 0；值不存在为 missing）。 */
export function removeKdasDay(params: Record<string, number>, kd: number): KdasRemoveResult {
  const entry = kdasSlots(params).find(candidate => candidate.kd === kd)
  if (entry === undefined) return { ok: false, reason: 'missing' }
  return { ok: true, params: { ...params, ['kd' + entry.slot]: 0 }, slot: entry.slot }
}

/**
 * 锚定命中：存储的 kd 中哪个会锚定到 barDay 这根 K 线（第一根交易日 >= kd 的
 * UTC 日等于 barDay）。bars 按 openTime 升序；无命中返回 null（自由日 → 新增）。
 * 非交易日/时区差落点：存储 kd 本身可能不是交易日，命中比较用的是锚点日。
 */
export function kdasAnchorSourceDay(
  params: Record<string, number> | undefined,
  bars: ReadonlyArray<{ openTime: number }>,
  barDay: number,
): number | null {
  if (params === undefined || !isKdasDayValue(barDay)) return null
  for (const { kd } of kdasSlots(params)) {
    let anchorDay: number | null = null
    for (const bar of bars) {
      const day = utcDayNum(bar.openTime)
      if (day >= kd) {
        anchorDay = day
        break
      }
    }
    if (anchorDay === barDay) return kd
  }
  return null
}

export interface KdasRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * 菜单钳位：inner（菜单视口矩形）越出 outer（图表容器视口矩形）时平移回
 * padding 内边距；inner 比 outer 还宽/高时钉在左/上 padding 处（只保证左上
 * 可见，极端窄窗下不追求完整）。返回钳位后的左上角视口坐标。
 */
export function clampRectInto(
  inner: KdasRect,
  outer: KdasRect,
  padding = 4,
): { x: number; y: number } {
  let x = inner.x
  let y = inner.y
  if (x + inner.width > outer.x + outer.width - padding) {
    x = outer.x + outer.width - padding - inner.width
  }
  if (y + inner.height > outer.y + outer.height - padding) {
    y = outer.y + outer.height - padding - inner.height
  }
  if (x < outer.x + padding) x = outer.x + padding
  if (y < outer.y + padding) y = outer.y + padding
  return { x, y }
}
