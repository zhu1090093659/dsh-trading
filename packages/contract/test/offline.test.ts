/**
 * 离线快照与深链测试（P4 步骤 4 契约面）：纯函数，无 mock 无 sleep。
 */
import { describe, expect, it } from 'vitest'
import { DEEPLINK_SCREENS, offlineView, parseDeeplink, stalenessOf, STALENESS, type OfflineSnapshot } from '../src/offline.ts'

const T0 = 1_700_000_000_000
const budgets = { freshMs: 5_000, staleMs: 30_000, ttlMs: 300_000 }
const snapshot = (atMs: number): OfflineSnapshot<string[]> => ({ data: ['BTC/USDT'], atMs, sourceId: 'edge' })

describe('陈旧度分档', () => {
  it('管理员：无数据是 unknown，与"取到了空列表"区分开', () => {
    // Given 没有本地快照
    // When 判断陈旧度
    // Then unknown（而不是 fresh）
    expect(stalenessOf(undefined, T0, budgets)).toBe('unknown')
    expect(stalenessOf({ data: [], atMs: T0, sourceId: 'edge' }, T0, budgets)).toBe('fresh')
    expect(STALENESS).toEqual(['fresh', 'aging', 'stale', 'expired', 'unknown'])
  })

  it('管理员：四档边界按 freshMs / staleMs / ttlMs 划分', () => {
    // Given 四个时间点
    // When 判断
    // Then 依次 fresh / aging / stale / expired
    expect(stalenessOf(snapshot(T0), T0 + 1_000, budgets)).toBe('fresh')
    expect(stalenessOf(snapshot(T0), T0 + 10_000, budgets)).toBe('aging')
    expect(stalenessOf(snapshot(T0), T0 + 60_000, budgets)).toBe('stale')
    expect(stalenessOf(snapshot(T0), T0 + 400_000, budgets)).toBe('expired')
  })

  it('管理员：边界值写错（fresh > stale）时一律判 unknown，不猜一个档位', () => {
    // Given 一组自相矛盾的边界
    // When 判断
    // Then unknown
    expect(stalenessOf(snapshot(T0), T0, { freshMs: 9_000, staleMs: 1_000, ttlMs: 300_000 })).toBe('unknown')
  })
})

describe('离线渲染', () => {
  it('管理员：过期数据不渲染数据本身，只给"请联网"提示（显示错的持仓比不显示危险）', () => {
    // Given 一份十分钟前的持仓快照
    const view = offlineView(snapshot(T0), T0 + 600_000, budgets)
    // When 转成渲染视图
    // Then notice 而非 data，且提示里带年龄
    expect(view.kind).toBe('notice')
    if (view.kind === 'notice') {
      expect(view.message).toContain('已过期')
      expect(view.message).toContain('请联网')
    }
    expect(JSON.stringify(view)).not.toContain('BTC/USDT')
  })

  it('管理员：fresh 无徽标、aging/stale 带不同强度的徽标、unknown 明确说没有数据', () => {
    // Given 三种时间点与无数据
    const fresh = offlineView(snapshot(T0), T0 + 1_000, budgets)
    const aging = offlineView(snapshot(T0), T0 + 10_000, budgets)
    const stale = offlineView(snapshot(T0), T0 + 60_000, budgets)
    const unknown = offlineView(undefined, T0, budgets)
    // When 取视图
    // Then 徽标强度递增，unknown 是 notice
    expect(fresh.kind === 'data' && fresh.badge).toBeUndefined()
    expect(aging.kind === 'data' && aging.badge).toBe('数据可能已变化')
    expect(stale.kind === 'data' && stale.badge).toContain('陈旧')
    expect(unknown.kind).toBe('notice')
  })
})

describe('深链解析', () => {
  it('管理员：只认封闭集合里的目标，未知目标与外部链接一律拒绝', () => {
    // Given 五种地址
    // When 解析
    // Then 只有合法的两个通过
    expect(parseDeeplink('dshtrading://escalations/esc-1')).toEqual({ ok: true, screen: 'escalations', id: 'esc-1' })
    expect(parseDeeplink('dshtrading://control')).toEqual({ ok: true, screen: 'control', id: undefined })
    expect(parseDeeplink('https://evil.example/steal')).toMatchObject({ ok: false, reason: 'NOT_APP_SCHEME' })
    expect(parseDeeplink('dshtrading://admin/root')).toMatchObject({ ok: false })
    expect(parseDeeplink('dshtrading://')).toMatchObject({ ok: false, reason: 'NO_SCREEN' })
    expect(DEEPLINK_SCREENS).toHaveLength(4)
  })

  it('管理员：深链里的 id 做 URL 解码，不原样当路径用', () => {
    // Given 一个含转义字符的 id
    // When 解析
    // Then id 已解码
    const result = parseDeeplink('dshtrading://decisions/dec%2F1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.id).toBe('dec/1')
  })
})
