/**
 * Slot/locale contract imports + augmentations. Type-only: pulls the host
 * SlotMap merges (sidebar/conversation/layout) and the locale namespace map
 * into every program that sees this file, so PropsRuntime<'…'> resolves.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** Locale keys of the dshtrading.market namespace. */
export type MarketLocaleKey =
  | 'tab.watch'
  | 'tab.crypto'
  | 'tab.us'
  | 'tab.cn'
  | 'tab.hk'
  | 'sidebar.addPlaceholder'
  | 'sidebar.add'
  | 'sidebar.empty'
  | 'sidebar.emptyHint'
  | 'sidebar.loadFailed'
  | 'sidebar.retry'
  | 'sidebar.markets'
  | 'row.remove'
  | 'row.select'
  | 'view.quote'
  | 'quote.empty'
  | 'quote.emptyHint'
  | 'quote.open'
  | 'quote.high'
  | 'quote.low'
  | 'quote.prevClose'
  | 'quote.volume'
  | 'quote.updated'
  | 'quote.loadFailed'
  | 'quote.noData'
  | 'interval.15m'
  | 'interval.1h'
  | 'interval.4h'
  | 'interval.1d'
  | 'interval.1w'
  | 'interval.1M'
  | 'panel.title'
  | 'panel.new'
  | 'panel.workspace'
  | 'panel.sessionsEmpty'
  | 'panel.collapse'
  | 'panel.expand'
  | 'panel.running'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Trading shell (sidebar browser, quote stage, side panel) copy. */
    'dshtrading.market': MarketLocaleKey
  }
}
