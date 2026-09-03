/**
 * 冒烟测试：node half 可加载（空 apply）+ 控制器纯逻辑（projectSnapshot 投射）。
 * 不测试浏览器半（bundle 构建由 tsdown.client.config.mjs 负责，浏览器行为需真实宿主）。
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import {
  projectSnapshot,
  type TradingSettings,
  type SettingsScopeSnapshotLike,
} from '../src/client/trading-settings-controller.js'

describe('@dshtrading/client-ui-settings node half', () => {
  it('node apply 为空操作（surface 占位，浏览器半是唯一实现）', () => {
    expect(typeof apply).toBe('function')
    // 直接调用不抛（任何 ctx 均可——空 apply）。
    apply({} as never)
  })
})

describe('projectSnapshot（状态投射：value 优先、user presence、dict 并集）', () => {
  const SNAP = {
    status: 'ready',
    value: { markets: { crypto: { provider: 'okx' } } } as TradingSettings,
    base: { markets: { crypto: { provider: 'binance' } } },
    user: { markets: { crypto: { provider: 'okx' } } },
    revision: 3,
    writable: true,
    mode: 'host' as const,
  }

  it('resolved：value 优先，undefined 时回落 base', () => {
    const state = projectSnapshot(SNAP as never)
    expect(state.resolved.crypto).toBe('okx')
    const noValue = { ...SNAP, value: undefined }
    const state2 = projectSnapshot(noValue as never)
    expect(state2.resolved.crypto).toBe('binance')
  })

  it('overridden：user 层 presence 判定（非值比较）', () => {
    const state = projectSnapshot(SNAP as never)
    expect(state.overridden.crypto).toBe(true)
    const noUser = { ...SNAP, user: {} }
    const state2 = projectSnapshot(noUser as never)
    expect(state2.overridden.crypto).toBe(false)
  })

  it('市场键 = value/base/user 并集（dict 开放：新市场键自动进入）', () => {
    const snap = {
      status: 'ready',
      value: { markets: { jp: { provider: 'stooq' } } } as TradingSettings,
      base: { markets: { crypto: { provider: 'binance' } } },
      user: {},
      revision: 1,
      writable: true,
      mode: 'host' as const,
    }
    const state = projectSnapshot(snap as never)
    expect(state.resolved.jp).toBe('stooq')
    expect(state.resolved.crypto).toBe('binance')
  })

  it('writable：mode=host 且 writable 才可写', () => {
    const readOnly = { ...SNAP, writable: false }
    const state = projectSnapshot(readOnly as never)
    expect(state.writable).toBe(false)
    const local = { ...SNAP, mode: 'local' as const }
    const state2 = projectSnapshot(local as never)
    expect(state2.writable).toBe(false)
  })
})
