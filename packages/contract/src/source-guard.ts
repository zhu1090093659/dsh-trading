/**
 * 数据源守卫（P4 步骤 5 的硬约束，契约层）：
 *   「同一份 $DSH_HOME 同一时刻只允许一个 dsh host 写者；两种形态下**不得混显**两个数据源
 *    （数据源是会话级单例、每条数据带 sourceId、渲染层拒绝跨源显示、切换期只读 + 双源对账）」
 *
 * 这一层只做**判定**，不碰渲染与网络：渲染层拿 %%viewOf()%% 的结果去画，拿 %%writable()%% 决定
 * 是否允许写操作。把"不得混显"与"切换期只读"做成可执行判定，卡片要的那条契约测试才有落脚点。
 *
 * 三条立场：
 *   1. **跨源永不混显**：%%viewOf()%% 只返回当前源的数据 —— 同 id 出现在两个源时，另一个源的那条
 *      连"被过滤掉"都不需要解释，它根本不在视图里。
 *   2. **切换期 fail-closed**：%%switchTo()%% 之后 %%writable()%% 为 false，直到 %%reconcile()%% 完成。
 *      "切换期只读"如果靠调用方自觉，就一定会在某条路径上漏掉。
 *   3. **对账要显式**：%%reconcile()%% 必须给出两边条数，计数不符即视为未完成 —— 静默"假装对上了"
 *      是这类切换最危险的失败方式。
 *
 * @module @dshtrading/contract/source-guard
 */

/** 带来源标记的一条数据（%%id%% 是它在**各自源内**的唯一标识）。 */
export interface SourcedDatum<T> {
  readonly id: string
  readonly sourceId: string
  readonly value: T
}

/** 对账结果：两边条数必须一致才算对上。 */
export interface ReconcileReport {
  readonly ok: boolean
  readonly activeCount: number
  readonly incomingCount: number
  readonly reason?: string | undefined
}

export interface SourceGuardOptions {
  /** 当前（也是唯一允许显示的）数据源。 */
  readonly activeSourceId: string
}

/**
 * 建一个数据源守卫。
 * @param options - 初始数据源。
 */
export function createSourceGuard<T>(options: SourceGuardOptions): {
  sourceId(): string
  /** 渲染层唯一入口：只给出当前源的数据（跨源永不混显）。 */
  viewOf(data: readonly SourcedDatum<T>[]): readonly SourcedDatum<T>[]
  /** 写操作是否允许（切换期只读）。 */
  writable(): boolean
  /** 开始切到另一个源：立即进入只读，直到 reconcile 通过。 */
  switchTo(nextSourceId: string): void
  /** 切换中？ */
  switching(): boolean
  /** 对账：两边条数一致才结束只读；不一致保持只读并给出原因。 */
  reconcile(active: readonly SourcedDatum<T>[], incoming: readonly SourcedDatum<T>[]): ReconcileReport
} {
  let activeSourceId = options.activeSourceId
  let pendingSourceId: string | undefined

  return {
    sourceId: () => activeSourceId,
    viewOf(data) {
      return data.filter((datum) => datum.sourceId === activeSourceId)
    },
    writable: () => pendingSourceId === undefined,
    switchTo(nextSourceId) {
      // 同一个源不算切换（避免把"刷新"误当成切换而进入只读）
      if (nextSourceId === activeSourceId) return
      pendingSourceId = nextSourceId
    },
    switching: () => pendingSourceId !== undefined,
    reconcile(active, incoming) {
      const activeCount = active.filter((datum) => datum.sourceId === activeSourceId).length
      const incomingCount = incoming.filter((datum) => datum.sourceId === pendingSourceId).length
      // 计数不符 ⇒ 不切换、保持只读（宁可停在只读，也不要把半个源显示出来）
      if (activeCount !== incomingCount) {
        return {
          ok: false,
          activeCount,
          incomingCount,
          reason: '条数不一致（' + String(activeCount) + ' vs ' + String(incomingCount) + '），保持只读',
        }
      }
      if (pendingSourceId !== undefined) {
        activeSourceId = pendingSourceId
        pendingSourceId = undefined
      }
      return { ok: true, activeCount, incomingCount }
    },
  }
}
