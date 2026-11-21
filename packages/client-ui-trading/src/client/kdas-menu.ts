/**
 * KDAS 关键日右键菜单：动作推导（纯函数）+ 官方 ContextMenus 服务桥。
 *
 * 表层是官方菜单（@deepseek-ai/dsh-client-ui-context-menu）：定位与钳位、Esc/外点
 * 关闭、键盘与焦点都由它承担。本模块只贡献一个 target 家族（KDAS_MENU_TARGET，官方
 * ContextMenuTargetMap 明示外部插件可扩展 target 家族）与它的动作；增删关键日这些
 * 动作用例仍是本仓的（addKdasDay / removeKdasDay），作为该家族的薄扩展。
 *
 * 口径契约（与 custom 指标 kdas 的 computeSource 一致，勿单方改动）：
 * - Key Day 存储值为 YYYYMMDD 数字（20000101..20991231，0 = 槽位未用，kd1..kd8）；
 * - 交易日取 K 线 openTime 的 UTC 日期——港股日 K 的 openTime 落在 HKT 零点
 *   （= 前一日 16:00Z），图表轴显示的本地日期与存储值可差一天，这是 compute 的
 *   既有口径（见 weekly-trading-plan skill 的 kdas.py 注释）；菜单的取日与锚定
 *   判定必须与 compute 同源（都用 UTC 日）；
 * - 锚定 = 第一根交易日 >= kd 的 K 线；多个 kd 同锚时 compute 去重只画一条，
 *   因此「点击已锚定的 K 线」语义是删除其存储 kd，而不是再添一条同锚线。
 */

/** KDAS 实例 id（指标名册与图表参数写入共用）。 */
export const KDAS_ID = 'kdas'

export const KDAS_SLOTS = 8

/** 官方菜单的 target 家族名：value = 右键命中的业务快照，动作只读它。 */
export const KDAS_MENU_TARGET = 'dshtrading.kdas'

/** 关键日行的线色圆点：官方 contextMenu.icon 按 key 分发一格，颜色经 data URL 携带。 */
export const KDAS_MENU_DAY_ICON = 'dshtrading.kdas.day'

/** 菜单动作 id（稳定值进官方选中路径；逐日移除带存储日后缀）。 */
export const KDAS_ACTION_MOUNT = 'mount'
export const KDAS_ACTION_ADD = 'add'
export const KDAS_ACTION_REMOVE_ANCHOR = 'remove-anchor'
const REMOVE_DAY_PREFIX = 'remove-day:'

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

/** 图上一条关键日线的身份：存储日 + 该线在图上的颜色（菜单圆点取它）。 */
export interface KdasMenuDay {
  readonly kd: number
  readonly color: string
}

/** 右键命中时的业务快照——官方 target value，resolve 的全部输入都在这里。 */
export interface KdasMenuValue {
  readonly market: string
  readonly symbol: string
  /** 命中柱的存储口径日（UTC，与 compute 同源）。 */
  readonly barDay: number
  /** 命中柱上锚定的存储 kd；自由日（可新增）为 null。 */
  readonly anchorDay: number | null
  /** KDAS 是否已在本标的挂载：未挂载时菜单退化为单项「挂载」。 */
  readonly mounted: boolean
  /** 当前全部有效关键日（槽位序）。 */
  readonly days: readonly KdasMenuDay[]
}

/** 官方菜单 target：{ kind, value }。 */
export interface KdasMenuTarget {
  readonly kind: typeof KDAS_MENU_TARGET
  readonly value: KdasMenuValue
}

/** 菜单文案键（本仓 kdas.menu.* 词条；t 由插槽或 apply 注入）。 */
export type KdasMenuCopyKey =
  | 'kdas.menu.mount'
  | 'kdas.menu.add'
  | 'kdas.menu.remove'
  | 'kdas.menu.removeShort'
  | 'kdas.menu.full'

/** 文案函数的最小面：只收本菜单用到的键与 {date} 变量。 */
export type KdasMenuCopy = (key: KdasMenuCopyKey, vars?: { date: string }) => string

/** 一个菜单动作：官方 MenuActionView 的最小面 + 稳定 id。 */
export interface KdasMenuAction {
  readonly id: string
  readonly label: string
  readonly disabled?: boolean
  readonly danger?: boolean
  readonly separatorBefore?: boolean
  readonly icon?: { readonly key: string; readonly src: string }
}

/**
 * 关键日线的圆点图片：8x8 SVG data URL。
 *
 * 官方动作只带 icon { key, src }，线色经 src 携带——圆点格按 key 分发一格即可，
 * 不必按颜色注册任意多个格子。
 */
export function kdasDayDotSrc(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3.5" fill="${color}"/></svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

/** 逐日移除动作的 id（存储日进 id，run 侧据此还原该日）。 */
export function kdasRemoveDayActionId(kd: number): string {
  return REMOVE_DAY_PREFIX + String(kd)
}

/** 从动作 id 还原逐日移除的存储日；不是该族动作返回 null。 */
export function kdasDayFromActionId(id: string): number | null {
  if (!id.startsWith(REMOVE_DAY_PREFIX)) return null
  const kd = Number(id.slice(REMOVE_DAY_PREFIX.length))
  return isKdasDayValue(kd) ? kd : null
}

/**
 * 一个右键命中该给用户哪些动作用例。
 *
 * 三态与 owner 裁决（2026-10-08）一致：未挂载只有「挂载」；命中锚点柱只给「移除该
 * 锚」；自由柱给「设为关键日」，满 8 条时禁用并把原因写在行上（官方动作没有
 * tooltip 位，原因必须是可见文案）。底部逐日移除行始终列出全部关键日（含视野外的
 * 锚点），带线色圆点。
 */
export function kdasMenuActions(value: KdasMenuValue, copy: KdasMenuCopy): KdasMenuAction[] {
  const actions: KdasMenuAction[] = []
  if (!value.mounted) {
    return [{ id: KDAS_ACTION_MOUNT, label: copy('kdas.menu.mount') }]
  }
  if (value.anchorDay !== null) {
    actions.push({
      id: KDAS_ACTION_REMOVE_ANCHOR,
      label: copy('kdas.menu.remove', { date: formatKdasDay(value.anchorDay) }),
    })
  } else {
    // 满槽判定与 addKdasDay 同源：该日已在名册里时仍可点（幂等拒绝由动作自己承担）。
    const stored = value.days.some(day => day.kd === value.barDay)
    const full = value.days.length >= KDAS_SLOTS && !stored
    actions.push({
      id: KDAS_ACTION_ADD,
      label: full ? copy('kdas.menu.full') : copy('kdas.menu.add', { date: formatKdasDay(value.barDay) }),
      ...(full ? { disabled: true } : {}),
    })
  }
  value.days.forEach((day, index) => {
    actions.push({
      id: kdasRemoveDayActionId(day.kd),
      label: `${formatKdasDay(day.kd)} · ${copy('kdas.menu.removeShort')}`,
      ...(index === 0 ? { separatorBefore: true } : {}),
      icon: { key: KDAS_MENU_DAY_ICON, src: kdasDayDotSrc(day.color) },
    })
  })
  return actions
}

/**
 * 官方 ContextMenus 服务在本模块用到的最小面。
 *
 * 不 import 未声明的 SDK 包（client 产物 purity gate 禁未声明包），与 uiWorkspace /
 * sidebarRight 同款边界：服务面在本文件断言一次。
 */
export interface KdasContextMenus {
  register(contribution: {
    readonly id: string
    readonly target: string
    readonly order: number
    resolve(value: KdasMenuValue): readonly KdasMenuAction[]
  }): () => void
  open(target: KdasMenuTarget, point: { readonly x: number; readonly y: number }): void
}

/** 当前装上的官方菜单服务：apply 期由 index.ts 装上，卸载时摘掉。 */
let menus: KdasContextMenus | undefined

/** 装上官方菜单服务；返回的卸载函数只在服务仍是它时清空（重装后旧卸载不乱摘）。 */
export function installKdasContextMenu(service: KdasContextMenus): () => void {
  menus = service
  return () => {
    if (menus === service) menus = undefined
  }
}

/**
 * 在视口坐标处打开关键日菜单（官方弹层负责定位与关闭）。
 *
 * @returns 是否接管了本次右键；菜单服务缺席时返回 false，交回浏览器默认菜单。
 */
export function openKdasContextMenu(target: KdasMenuTarget, point: { x: number; y: number }): boolean {
  if (menus === undefined) return false
  menus.open(target, point)
  return true
}
