/**
 * 离线快照与深链解析（P4 步骤 4 的契约面）。
 *
 * 卡片要求移动端"离线最后快照 + 陈旧度标记"与"推送深链"。这两件事的**判据**与分发方式无关，
 * 而且都有明确的危险面，所以进契约：
 *
 *   1. **陈旧度分档**：不能只显示一个"最后更新于 X"了事 —— 交易界面上的旧数据会被当成现状。
 *      过了保留期（ttlMs）**必须不再显示数据本身**，只显示"数据已过期，请联网"：
 *      显示一个可能完全错的持仓，比什么都不显示危险得多。
 *   2. **无数据 ≠ 数据是空的**：%%unknown%% 档必须与"取到了空列表"区分开。
 *   3. **深链是封闭集合**：只允许应用内的少数几个目标；未知目标一律拒绝（不"尽力跳转"）——
 *      推送通道的信任级别不足以让它把用户送到任意位置。
 *
 * @module @dshtrading/contract/offline
 */
import { DEEPLINK_SCHEME } from './push.ts'

/** 陈旧度分档。 */
export const STALENESS = ['fresh', 'aging', 'stale', 'expired', 'unknown'] as const
export type Staleness = (typeof STALENESS)[number]

/** 一份离线快照。 */
export interface OfflineSnapshot<T> {
  readonly data: T
  readonly atMs: number
  /** 数据来源标识（两种形态（本地/远端）不得混显，客户端据此拒绝跨源展示）。 */
  readonly sourceId: string
}

/**
 * 判断陈旧度：age < freshMs ⇒ fresh；< staleMs ⇒ aging；< ttlMs ⇒ stale；≥ ttlMs ⇒ expired。
 * @param snapshot - 快照（undefined 表示本地没有数据）。
 * @param nowMs - 当前时间。
 * @param budgets - 三档边界（必须 freshMs <= staleMs <= ttlMs）。
 */
export function stalenessOf<T>(
  snapshot: OfflineSnapshot<T> | undefined,
  nowMs: number,
  budgets: { readonly freshMs: number; readonly staleMs: number; readonly ttlMs: number },
): Staleness {
  if (snapshot === undefined) return 'unknown'
  if (budgets.freshMs > budgets.staleMs || budgets.staleMs > budgets.ttlMs) return 'unknown'
  const age = Math.max(0, nowMs - snapshot.atMs)
  if (age < budgets.freshMs) return 'fresh'
  if (age < budgets.staleMs) return 'aging'
  if (age < budgets.ttlMs) return 'stale'
  return 'expired'
}

/** 一份可以拿去渲染的东西（或明确的"不能渲染"）。 */
export type OfflineView<T> =
  | { readonly kind: 'data'; readonly data: T; readonly staleness: Staleness; readonly badge: string | undefined }
  | { readonly kind: 'notice'; readonly staleness: Staleness; readonly message: string }

/**
 * 把快照转成可渲染视图。**过期数据不渲染数据本身** —— 这条是本节存在的理由。
 * @param snapshot - 快照。
 * @param nowMs - 当前时间。
 * @param budgets - 三档边界。
 */
export function offlineView<T>(
  snapshot: OfflineSnapshot<T> | undefined,
  nowMs: number,
  budgets: { readonly freshMs: number; readonly staleMs: number; readonly ttlMs: number },
): OfflineView<T> {
  const staleness = stalenessOf(snapshot, nowMs, budgets)
  if (staleness === 'unknown') {
    return { kind: 'notice', staleness, message: '还没有本地数据，请联网获取' }
  }
  if (staleness === 'expired') {
    const ageSeconds = Math.round((nowMs - (snapshot as OfflineSnapshot<T>).atMs) / 1000)
    return { kind: 'notice', staleness, message: '本地数据已过期（' + String(ageSeconds) + ' 秒前），请联网获取后再操作' }
  }
  const badge = staleness === 'fresh' ? undefined : staleness === 'aging' ? '数据可能已变化' : '⚠ 数据陈旧，仅供对照'
  return { kind: 'data', data: (snapshot as OfflineSnapshot<T>).data, staleness, badge }
}

/** 深链可达的应用内目标（封闭集合）。 */
export const DEEPLINK_SCREENS = ['escalations', 'decisions', 'positions', 'control'] as const
export type DeeplinkScreen = (typeof DEEPLINK_SCREENS)[number]

/** 深链解析结果。 */
export type DeeplinkResult =
  | { readonly ok: true; readonly screen: DeeplinkScreen; readonly id: string | undefined }
  | { readonly ok: false; readonly reason: string }

/**
 * 解析应用内深链。只认封闭集合里的目标，未知目标一律拒绝（**不尽力跳转**）。
 * @param url - 形如 dshtrading://escalations/esc-1 的地址。
 */
export function parseDeeplink(url: string): DeeplinkResult {
  if (!url.startsWith(DEEPLINK_SCHEME)) return { ok: false, reason: 'NOT_APP_SCHEME' }
  const rest = url.slice(DEEPLINK_SCHEME.length)
  const segments = rest.split('/').filter((segment) => segment !== '')
  const screen = segments[0]
  if (screen === undefined) return { ok: false, reason: 'NO_SCREEN' }
  if (!(DEEPLINK_SCREENS as readonly string[]).includes(screen)) return { ok: false, reason: 'UNKNOWN_SCREEN: ' + screen }
  const id = segments[1]
  return { ok: true, screen: screen as DeeplinkScreen, id: id === undefined ? undefined : decodeURIComponent(id) }
}
