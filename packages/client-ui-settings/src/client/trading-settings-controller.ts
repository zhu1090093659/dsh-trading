/**
 * Trading settings controller: binds the dshtrading namespace through the
 * client settings scope, exposes the resolved markets map, and writes a
 * provider selection as one path mutation fenced by the revision the form
 * read. The Host (dsh-trading/router) owns the namespace and its schema.
 */
import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'

/** 市场显示元数据（与 router 的 dict 键同构；显示名本地化在组件层做）。 */
export const MARKET_LABELS: readonly Readonly<{ id: string; label: string }>[] = [
  { id: 'crypto', label: '加密货币' },
  { id: 'us', label: '美国股票' },
  { id: 'cn', label: '中国 A 股' },
  { id: 'hk', label: '香港股票' },
]

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

/** 控制器对外面：快照 + 订阅 + 写路径 + 重置。 */
export interface TradingSettingsController {
  snapshot(): SettingsScopeSnapshot<TradingSettings>
  subscribe(listener: () => void): () => void
  /** 写入某市场 provider（path mutation + 表单读到的 revision 防漂移）。 */
  setProvider(market: string, provider: string): Promise<void>
  /** 重置某市场 provider（unset path → 回 base/schema 默认）。 */
  resetProvider(market: string): Promise<void>
}

export function createTradingSettingsController(scope: SettingsScope<TradingSettings>): TradingSettingsController {
  return {
    snapshot: () => scope.getSnapshot(),
    subscribe: (listener) => scope.subscribe(listener),
    async setProvider(market: string, provider: string) {
      const rev = scope.getSnapshot().revision
      await scope.mutate([{ op: 'set', path: ['markets', market, 'provider'], value: provider }], rev)
    },
    async resetProvider(market: string) {
      const rev = scope.getSnapshot().revision
      await scope.mutate([{ op: 'unset', path: ['markets', market, 'provider'] }], rev)
    },
  }
}

/** 工具：判断某市场 provider 是否被用户覆盖（user 层 presence，非值比较）。 */
export function isOverridden(snapshot: SettingsScopeSnapshot<TradingSettings>, market: string): boolean {
  const user = (snapshot.user ?? {}) as { markets?: Record<string, unknown> }
  return user.markets?.[market] !== undefined
}

/** 工具：读快照中某市场已解析 provider（value 为 undefined 时回落 base）。 */
export function resolvedProvider(
  snapshot: SettingsScopeSnapshot<TradingSettings>,
  market: string,
): string | undefined {
  const value = snapshot.value ?? (snapshot.base as TradingSettings | undefined)
  return value?.markets?.[market]?.provider
}
