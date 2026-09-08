/**
 * 市场词汇共享小件（issue #82 抽取）：市场页签 → locale 键映射 + 手输代码的
 * 市场规范形归一。MarketSidebar 与 WatchlistManager 双消费（后者由前者挂载，
 * 直接反向 import 会成环，故独立成模块）。
 */
import type { MarketLocaleKey } from './contract.ts'
import type { MarketId } from './types.ts'

/** 市场 → 页签文案键（sidebar 胶囊 / manager 市场列共用）。 */
export const MARKET_TAB_KEY: Record<MarketId, MarketLocaleKey> = {
  crypto: 'tab.crypto',
  us: 'tab.us',
  cn: 'tab.cn',
  hk: 'tab.hk',
}

const KNOWN_SH_INDICES = new Set(['000688', '000300', '000016', '000905', '000852'])

/** 手输 symbol → 市场规范形：cn 6 位数字补 .SH/.SZ（沪：6/9/5 开头与已知指数），hk 数字补零 .HK；其余大写透传。 */
export function normalizeSymbolInput(target: MarketId, rawDraft: string): string {
  const raw = rawDraft.trim().toUpperCase()
  if (target === 'cn' && /^\d{6}$/.test(raw)) {
    const isSh = raw.startsWith('6') || raw.startsWith('9') || raw.startsWith('5') || KNOWN_SH_INDICES.has(raw)
    return `${raw}.${isSh ? 'SH' : 'SZ'}`
  }
  if (target === 'hk' && /^\d{1,5}$/.test(raw)) {
    return `${raw.padStart(5, '0')}.HK`
  }
  return raw
}
