/**
 * 当前会话读面（0.1.7）单测：`SessionListState` 删除 `current` 字段后，插件按
 * 官方 ui-layout/ui-workspace 同款读法，从 `mainView` 保留计数解出主视图会话；
 * 解不出即「无当前会话」（HomeHistory 隐藏、ChatResizeHandle 退场据此判定）。
 */
import { describe, expect, it } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { currentSessionId } from '../src/client/current-session.ts'

/** 造会话列表快照：只有 rows 里 mainView > 0 的行算被主视图保留。 */
function sessionList(rows: ReadonlyArray<{ id: string; blank?: boolean; mainView?: number }>): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, {
      id: row.id,
      displayTitle: row.id,
      running: false,
      blank: row.blank ?? false,
      updatedAt: 0,
      retainedBy: { mainView: row.mainView ?? 0 },
    }])),
    phase: 'ready',
    projectionsBySession: {},
  } as unknown as SessionListState
}

describe('currentSessionId（0.1.7 当前会话读面）', () => {
  it('用户当前会话被主视图保留时解出该会话 id', () => {
    // Given 两个会话，只有 s2 被主视图 retain
    const list = sessionList([{ id: 's1' }, { id: 's2', mainView: 1 }])
    // When 解当前会话
    // Then 返回被 mainView 保留的 s2，而不是列表首行 s1
    expect(currentSessionId(list)).toBe('s2')
  })

  it('用户没有任何会话被主视图保留时视为无当前会话', () => {
    // Given 两个会话都未被主视图 retain
    const list = sessionList([{ id: 's1' }, { id: 's2' }])
    // When 解当前会话
    // Then 返回 undefined
    expect(currentSessionId(list)).toBeUndefined()
  })

  it('用户当前会话是空白会话时同样按主视图保留解出', () => {
    // Given 唯一的空白会话被主视图 retain（首页 hero 态）
    const list = sessionList([{ id: 'blank-1', blank: true, mainView: 1 }])
    // When 解当前会话
    // Then 返回 blank-1，HomeHistory 据此物化融合面板
    expect(currentSessionId(list)).toBe('blank-1')
  })
})
