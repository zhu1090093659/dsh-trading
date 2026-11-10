/**
 * 表列排序纯函数用例（node 面，零 mock）：点表头三态循环、Shift 追加/移除次级键、
 * 缺值恒末位、并列保持上游顺序、持久化读入收敛。
 */
import { describe, expect, it } from 'vitest'
import { nextSortKeys, sanitizeSortKeys, sortRows, type SortKey } from '../src/client/table-sort.ts'

describe('表列排序键表', () => {
  it('用户点表头时按 降序 → 升序 → 取消 三态循环', () => {
    // Given: 空键表
    // When: 连点同一列表头三次
    const first = nextSortKeys([], 'latest_margin', false)
    const second = nextSortKeys(first, 'latest_margin', false)
    const third = nextSortKeys(second, 'latest_margin', false)
    // Then: 降序 → 升序 → 空（回上游默认顺序）
    expect(first).toEqual([{ key: 'latest_margin', dir: 'desc' }])
    expect(second).toEqual([{ key: 'latest_margin', dir: 'asc' }])
    expect(third).toEqual([])
  })

  it('用户点另一列表头时重置为「只有该列、降序」', () => {
    // Given: 已有唯一主键
    const current: SortKey[] = [{ key: 'latest_margin', dir: 'desc' }]
    // When: 点另一列表头
    // Then: 主键换成新列并从降序起算（不是把旧列留在次级）
    expect(nextSortKeys(current, 'daily_change', false)).toEqual([{ key: 'daily_change', dir: 'desc' }])
  })

  it('用户按住 Shift 点表头时追加次级键，再 Shift 点同一列则移除', () => {
    // Given: 一个主键
    const primary: SortKey[] = [{ key: 'daily_change', dir: 'desc' }]
    // When: Shift 点第二列
    const added = nextSortKeys(primary, 'total_5d_flow', true)
    // Then: 追加为次级键（默认降序）
    expect(added).toEqual([
      { key: 'daily_change', dir: 'desc' },
      { key: 'total_5d_flow', dir: 'desc' },
    ])
    // When: 再 Shift 点同一列
    // Then: 该键被移除，其余顺序不变
    expect(nextSortKeys(added, 'total_5d_flow', true)).toEqual([{ key: 'daily_change', dir: 'desc' }])
  })

  it('用户 Shift 点掉唯一主键时整表回上游默认顺序', () => {
    // Given: 只有主键
    const current: SortKey[] = [{ key: 'weight', dir: 'desc' }]
    // When: Shift 点同一列
    // Then: 键表清空
    expect(nextSortKeys(current, 'weight', true)).toEqual([])
  })
})

describe('表列排序结果', () => {
  const rows = [
    { name: 'a', margin: 103.16, flow: -0.43 },
    { name: 'b', margin: 844.0, flow: 2.16 },
    { name: 'c', margin: null as number | null, flow: null as number | null },
  ]
  const valueOf = (row: (typeof rows)[number], key: string): number | null | undefined =>
    key === 'margin' ? row.margin : row.flow

  it('用户按某列排序时该列数值按方向重排', () => {
    // Given/When: 按 margin 降序、升序
    const desc = sortRows(rows, [{ key: 'margin', dir: 'desc' }], valueOf)
    const asc = sortRows(rows, [{ key: 'margin', dir: 'asc' }], valueOf)
    // Then: 两向都按数值排列
    expect(desc.map((r) => r.name)).toEqual(['b', 'a', 'c'])
    expect(asc.map((r) => r.name)).toEqual(['a', 'b', 'c'])
  })

  it('用户排序时缺值行恒排末尾，与方向无关', () => {
    // Given: 一行 margin 为 null
    // When: 两个方向各排一次
    // Then: 缺值行都在最后（不因降序被顶到最前）
    expect(sortRows(rows, [{ key: 'margin', dir: 'desc' }], valueOf).at(-1)?.name).toBe('c')
    expect(sortRows(rows, [{ key: 'margin', dir: 'asc' }], valueOf).at(-1)?.name).toBe('c')
  })

  it('用户按多列排序时先比主键、并列再比次级键', () => {
    // Given: a 与 b 的 flow 相同（并列），margin 不同
    const tied = [
      { name: 'a', margin: 103.16, flow: 1 },
      { name: 'b', margin: 844.0, flow: 1 },
      { name: 'c', margin: 844.0, flow: 5 },
    ]
    // When: 按 flow 降序 + margin 降序
    const sorted = sortRows(tied, [{ key: 'flow', dir: 'desc' }, { key: 'margin', dir: 'desc' }], valueOf)
    // Then: flow 决定首段，flow 并列时由 margin 决定
    expect(sorted.map((r) => r.name)).toEqual(['c', 'b', 'a'])
  })

  it('用户排序时并列行保持上游相对顺序（稳定排序）', () => {
    // Given: 三行 flow 全相同
    const tied = rows.map((r) => ({ ...r, flow: 1 }))
    // When: 按 flow 排序
    // Then: 顺序与上游一致（不因排序抖动）
    expect(sortRows(tied, [{ key: 'flow', dir: 'desc' }], valueOf).map((r) => r.name)).toEqual(['a', 'b', 'c'])
    expect(sortRows(tied, [{ key: 'flow', dir: 'asc' }], valueOf).map((r) => r.name)).toEqual(['a', 'b', 'c'])
  })

  it('用户没有点过任何表头时表保持上游顺序', () => {
    // Given/When: 无排序键
    // Then: 原样返回（复制，不改入参数组）
    const out = sortRows(rows, [], valueOf)
    expect(out.map((r) => r.name)).toEqual(['a', 'b', 'c'])
    expect(out).not.toBe(rows)
  })
})

describe('排序状态读入收敛', () => {
  const allowed = ['margin', 'flow']

  it('用户读到的持久化值里有未知列或非法方向时只保留合法项', () => {
    // Given: 混入未知列 / 非法方向 / 非对象项
    const raw = [
      { key: 'margin', dir: 'desc' },
      { key: 'unknown', dir: 'desc' },
      { key: 'flow', dir: 'sideways' },
      { key: 'flow', dir: 'asc' },
      'nope',
      null,
    ]
    // When: 收敛
    // Then: 只留合法项
    expect(sanitizeSortKeys(raw, allowed)).toEqual([
      { key: 'margin', dir: 'desc' },
      { key: 'flow', dir: 'asc' },
    ])
  })

  it('用户读到的持久化值里同一列重复出现时只保留第一次', () => {
    // Given: 同一列两条记录（先升序后降序）
    const raw = [{ key: 'flow', dir: 'asc' }, { key: 'flow', dir: 'desc' }]
    // When: 收敛
    // Then: 只留第一次出现的那条
    expect(sanitizeSortKeys(raw, allowed)).toEqual([{ key: 'flow', dir: 'asc' }])
  })

  it('用户读到的持久化值不是数组时回空键表', () => {
    // Given: undefined 与对象两种非数组输入
    // When: 收敛
    // Then: 都回空键表（视图按未排序渲染）
    expect(sanitizeSortKeys(undefined, allowed)).toEqual([])
    expect(sanitizeSortKeys({ key: 'flow' }, allowed)).toEqual([])
  })
})
