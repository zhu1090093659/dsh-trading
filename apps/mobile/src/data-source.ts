/**
 * 数据源视图：把 contract 的 source-guard 接到 UI 上。
 *
 * 这里**不重写任何语义** —— 跨源不混、切换即只读、对账数量不符就继续只读，
 * 都由 @dshtrading/contract 的 createSourceGuard 决定；本模块只负责
 * "把收到的数据攒起来、把当前源该看的部分交给 UI"。
 */
import { createSourceGuard, type ReconcileReport, type SourcedDatum } from '@dshtrading/contract/core'

export interface DataSourceViewOptions {
  /** 初始数据源 id（例如 bot 的 sourceId）。 */
  readonly initialSourceId: string
}

export interface DataSourceView<T> {
  sourceId(): string
  switching(): boolean
  writable(): boolean
  /** 收下新数据（可以来自多个源；视图只显示当前源）。 */
  ingest(incoming: readonly SourcedDatum<T>[]): void
  /** 当前源可见的数据。 */
  visible(): readonly SourcedDatum<T>[]
  /** 切换到另一个源：进入只读窗口，直到对账完成。 */
  switchTo(nextSourceId: string): void
  /** 用外部数据对账当前视图（数量一致才算对得上）。 */
  reconcileWith(incoming: readonly SourcedDatum<T>[]): ReconcileReport
}

/**
 * 建一个数据源视图。
 * @param options - 初始数据源。
 */
export function createDataSourceView<T>(options: DataSourceViewOptions): DataSourceView<T> {
  const guard = createSourceGuard<T>({ activeSourceId: options.initialSourceId })
  let rows: readonly SourcedDatum<T>[] = []

  return {
    sourceId: () => guard.sourceId(),
    switching: () => guard.switching(),
    writable: () => guard.writable(),
    ingest(incoming) {
      // 同 id 覆盖（后到的为准），其余追加 —— 视图仍然只显示当前源。
      const byId = new Map(rows.map((row) => [row.id, row]))
      for (const row of incoming) byId.set(row.id, row)
      rows = [...byId.values()]
    },
    visible: () => guard.viewOf(rows),
    switchTo: (nextSourceId) => guard.switchTo(nextSourceId),
    reconcileWith: (incoming) => guard.reconcile(guard.viewOf(rows), incoming),
  }
}
