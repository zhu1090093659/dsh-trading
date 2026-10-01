/**
 * 数据源视图测试：语义来自契约的 source-guard（读实现后按事实写，第一版猜错过）。
 *
 * 真实语义备忘：
 *   - switchTo 只是设 pending：sourceId() 仍是旧源，writable() 变 false，switching() 变 true；
 *   - reconcile(active, incoming) 比较「当前源条数」与「pending 源条数」：一致才真正切换并解除只读；
 *     不一致则保持只读（宁可停在只读，也不显示半个源）。
 */
import { describe, expect, it } from 'vitest'
import { createDataSourceView } from '../src/data-source.ts'

const datum = (id: string, sourceId: string, value: number) => ({ id, sourceId, value })

describe('数据源视图（跨源不混 / 切换即只读）', () => {
  it('管理员：只显示当前源的数据', () => {
    // Given 一个当前源为 A 的视图，收下 A 与 B 的数据
    const view = createDataSourceView<number>({ initialSourceId: 'A' })
    view.ingest([datum('1', 'A', 10), datum('2', 'B', 20)])
    // When 取可见数据
    const visible = view.visible()
    // Then 只有 A 的
    expect(visible.map((row) => row.value)).toEqual([10])
    expect(visible.every((row) => row.sourceId === 'A')).toBe(true)
  })

  it('管理员：切换只设 pending —— 仍旧源、进入只读、switching 为真', () => {
    // Given 一个可写的视图
    const view = createDataSourceView<number>({ initialSourceId: 'A' })
    view.ingest([datum('1', 'A', 10)])
    expect(view.writable()).toBe(true)
    // When 请求切到 B
    view.switchTo('B')
    // Then 源还没变（要等对账通过），但已不可写、且处于切换中
    expect(view.sourceId()).toBe('A')
    expect(view.switching()).toBe(true)
    expect(view.writable()).toBe(false)
  })

  it('管理员：对账条数一致才真正切换；不一致则保持只读', () => {
    // Given A 一条、B 一条
    const view = createDataSourceView<number>({ initialSourceId: 'A' })
    view.ingest([datum('1', 'A', 10), datum('2', 'B', 20)])
    view.switchTo('B')
    // When 用条数不一致的数据对账（B 两条）
    const mismatch = view.reconcileWith([datum('2', 'B', 20), datum('3', 'B', 30)])
    // Then 对不上、仍旧源、仍只读
    expect(mismatch.ok).toBe(false)
    expect(view.sourceId()).toBe('A')
    expect(view.writable()).toBe(false)
    // When 用条数一致的数据对账
    const match = view.reconcileWith([datum('2', 'B', 20)])
    // Then 对得上并真正切到 B、解除只读
    expect(match.ok).toBe(true)
    expect(view.sourceId()).toBe('B')
    expect(view.writable()).toBe(true)
    expect(view.switching()).toBe(false)
  })

  it('管理员：切到同一个源是 no-op（刷新不该被当成切换）', () => {
    // Given 当前源为 A
    const view = createDataSourceView<number>({ initialSourceId: 'A' })
    // When 再切到 A
    view.switchTo('A')
    // Then 没有假的只读窗口
    expect(view.switching()).toBe(false)
    expect(view.writable()).toBe(true)
  })
})
