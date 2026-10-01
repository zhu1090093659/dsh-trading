/**
 * 离线/陈旧数据在 UI 上的呈现。
 *
 * **不在 App 里重写陈旧度判据**：边界（fresh/aging/stale/expired/unknown）与提示文案都由
 * @dshtrading/contract 的 offlineView 决定，这里只是把它翻译成 UI 能直接渲染的形状，
 * 并额外给出"能不能让用户照着操作"的意见（UI 文案属客户端，判据不属）。
 */
import { offlineView, type OfflineSnapshot, type Staleness } from '@dshtrading/contract/core'

export interface StalenessBudgets {
  readonly freshMs: number
  readonly staleMs: number
  readonly ttlMs: number
}

export type OfflineBanner<T> =
  | { readonly kind: 'data'; readonly staleness: Staleness; readonly view: unknown; readonly hint: string }
  | { readonly kind: 'notice'; readonly staleness: Staleness; readonly hint: string }

/** 供 UI 显示的提示（判据在契约，措辞在这里）。 */
function hintFor(staleness: Staleness): string {
  if (staleness === 'fresh') return ''
  if (staleness === 'aging') return '数据略旧，正在刷新'
  if (staleness === 'stale') return '数据较旧，请核对后再操作'
  return ''
}

/**
 * 把离线快照翻成横幅。
 * @param snapshot - 本地快照（可能没有）。
 * @param nowMs - 当前时刻（注入，便于测试）。
 * @param budgets - 陈旧度预算（必须 fresh <= stale <= ttl，否则契约判 unknown）。
 */
export function offlineBanner<T>(
  snapshot: OfflineSnapshot<T> | undefined,
  nowMs: number,
  budgets: StalenessBudgets,
): OfflineBanner<T> {
  const view = offlineView<T>(snapshot, nowMs, budgets)
  if (view.kind === 'notice') {
    // 直接复用契约给的 message —— 过期/无数据这类关键提示不允许两处措辞
    return { kind: 'notice', staleness: view.staleness, hint: view.message }
  }
  return { kind: 'data', staleness: view.staleness, view, hint: hintFor(view.staleness) }
}
