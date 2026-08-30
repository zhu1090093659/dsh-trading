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
  | 'stage.quote'
  | 'stage.workflow'
  | 'workflow.title'
  | 'workflow.placeholder'
  | 'indicator.picker'
  | 'indicator.group.main'
  | 'indicator.group.sub'
  | 'indicator.ma'
  | 'indicator.ema'
  | 'indicator.boll'
  | 'indicator.macd'
  | 'indicator.rsi'
  | 'indicator.kdj'
  | 'indicator.params'
  | 'indicator.apply'
  | 'indicator.cancel'
  | 'indicator.param.period'
  | 'indicator.param.p1'
  | 'indicator.param.p2'
  | 'indicator.param.p3'
  | 'indicator.param.fast'
  | 'indicator.param.slow'
  | 'indicator.param.signal'
  | 'indicator.param.mult'
  | 'interval.15m'
  | 'interval.1h'
  | 'interval.4h'
  | 'interval.1d'
  | 'interval.1w'
  | 'interval.1M'
  | 'browser.history'
  | 'browser.historyEmpty'
  | 'entry.new'
  | 'entry.settings'
  | 'chat.fold'
  | 'chat.expand'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Trading shell (sidebar browser, quote stage, side panel) copy. */
    'dshtrading.market': MarketLocaleKey
  }
}
