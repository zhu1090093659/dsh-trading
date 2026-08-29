/**
 * 冒烟测试：node half 可加载（空 apply）+ 控制器纯逻辑（快照读取/覆盖判定）。
 * 不测试浏览器半（bundle 构建由 tsdown.client.config.mjs 负责，浏览器行为需真实宿主）。
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import {
  isOverridden, resolvedProvider,
  type TradingSettings, type SettingsScopeSnapshotLike,
} from '../src/client/trading-settings-controller.js'

describe('@dsh-trading/client-ui-settings node half', () => {
  it('node apply 为空操作（surface 占位，浏览器半是唯一实现）', () => {
    expect(typeof apply).toBe('function')
    // 直接调用不抛（任何 ctx 均可——空 apply）。
    apply({} as never)
  })
})

describe('trading settings 控制器纯逻辑', () => {
  const SNAP = {
    status: 'ready',
    value: { markets: { crypto: { provider: 'okx' } } } as TradingSettings,
    base: { markets: { crypto: { provider: 'binance' } } },
    user: { markets: { crypto: { provider: 'okx' } } },
    revision: 3,
    writable: true,
    mode: 'host' as const,
  }

  it('resolvedProvider：value 优先，undefined 时回落 base', () => {
    expect(resolvedProvider(SNAP as never, 'crypto')).toBe('okx')
    const noValue = { ...SNAP, value: undefined }
    expect(resolvedProvider(noValue as never, 'crypto')).toBe('binance')
  })

  it('isOverridden：user 层 presence 判定（非值比较）', () => {
    expect(isOverridden(SNAP as never, 'crypto')).toBe(true)
    const noUser = { ...SNAP, user: {} }
    expect(isOverridden(noUser as never, 'crypto')).toBe(false)
  })
})
