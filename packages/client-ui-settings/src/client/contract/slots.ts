/**
 * Trading settings slot contract — declares the per-market tab slot the
 * Trading section hosts. Each market contribution is ONE tab registration
 * (id = market id, order, label, children = the market panel), so a new
 * market = a new registration, no section changes (设计: 全兼容性, 对照官方
 * settings.plugins.tab 模式).
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One market's provider-routing page inside the Trading settings section.
     * Keyed by market id (crypto/us/cn/hk/...). The section chrome (tab bar)
     * is owned by the Trading section; each contribution renders its own
     * panel body from the shared dshtrading scope.
     */
    'dshtrading.market.tab': { kind: 'keyed'; scope: 'root'; owner: never }
  }
}

/** Owner share of a market tab (the section supplies nothing). */
export interface MarketTabOwnerProps {
  /** Marker field: tab owner props are intentionally empty. */
  children?: never
}
