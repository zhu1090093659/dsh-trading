/**
 * Trading settings controller: a SnapshotStore over the dshtrading namespace
 * view (markets map + provider presence), with the write methods supplied as
 * plain inject fields (官方模式: hooks = 可观察状态, 普通字段 = 写操作)。
 * The Host (dsh-trading/router) owns the namespace and its schema; this
 * controller binds the client settings scope and translates user choices
 * into revision-fenced path mutations.
 */
import type {
  SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'

/** provider 候选显示名（slug + 显示名；值与 router PROVIDER_VOCABULARY 对齐）。 */
export const PROVIDER_LABELS: readonly Readonly<{ id: string; label: string }>[] = [
  { id: 'binance', label: 'Binance' },
  { id: 'okx', label: 'OKX' },
  { id: 'yahoo', label: 'Yahoo Finance' },
  { id: 'stooq', label: 'Stooq' },
  { id: 'tencent', label: '腾讯' },
]

/** dshtrading namespace 下的值形状（router 侧同步；窄化后的子集契约）。 */
export interface TradingSettings {
  markets: Record<string, { provider?: string; tradeProvider?: string }>
}

/** 组件的可观察状态（SnapshotStore 值）：已解析 value + 覆盖标记。 */
export interface TradingSettingsState {
  status: 'loading' | 'ready' | 'unavailable'
  /** market id → 已解析 provider（undefined = 未解析到）。 */
  resolved: Record<string, string | undefined>
  /** market id → 用户是否覆盖（user 层 presence）。 */
  overridden: Record<string, boolean>
  /** 表单可写（mode=host 且 writable）。 */
  writable: boolean
}

/** 写路径（普通 inject 字段）。 */
export interface TradingSettingsActions {
  setProvider(market: string, provider: string): Promise<void>
  resetProvider(market: string): Promise<void>
}

/** 状态转化：从 settings 快照投射为组件的可观察视图。 */
export function projectSnapshot(snap: SettingsScopeSnapshot<TradingSettings>): TradingSettingsState {
  const value = snap.value ?? (snap.base as TradingSettings | undefined)
  const user = (snap.user ?? {}) as { markets?: Record<string, unknown> }
  // 市场键 = value/base/user 的实际键并集（dict 开放：新市场的键出现即进入，无需改码）。
  const marketIds = new Set<string>([
    ...Object.keys(value?.markets ?? {}),
    ...Object.keys((snap.base as TradingSettings | undefined)?.markets ?? {}),
    ...Object.keys(user.markets ?? {}),
  ])
  const resolved: Record<string, string | undefined> = {}
  const overridden: Record<string, boolean> = {}
  const baseMarkets = (snap.base as TradingSettings | undefined)?.markets ?? {}
  for (const marketId of marketIds) {
    // 逐市场 value 优先、base 兜底：value 缺该市场键时（部分合并）仍能解析到实际 provider。
    resolved[marketId] = value?.markets?.[marketId]?.provider ?? baseMarkets[marketId]?.provider
    overridden[marketId] = user.markets?.[marketId] !== undefined
  }
  return { status: snap.status, resolved, overridden, writable: snap.writable && snap.mode === 'host' }
}

/** 从 settings scope 构建 SnapshotStore（getSnapshot 稳定引用 + subscribe 转发）。 */
export function createTradingSettingsStore(scope: SettingsScope<TradingSettings>): SnapshotStore<TradingSettingsState> {
  let cached: TradingSettingsState = projectSnapshot(scope.getSnapshot())
  return {
    getSnapshot: () => {
      const current = projectSnapshot(scope.getSnapshot())
      // 引用稳定：值未变则复用缓存（bindSnapshotSelector 依赖引用稳定性做浅比较）。
      if (JSON.stringify(current) !== JSON.stringify(cached)) cached = current
      return cached
    },
    subscribe: (listener) => scope.subscribe(listener),
  }
}
