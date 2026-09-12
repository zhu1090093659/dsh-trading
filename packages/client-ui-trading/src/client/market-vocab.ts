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
  futures: 'tab.futures',
}

const KNOWN_SH_INDICES = new Set(['000688', '000300', '000016', '000905', '000852'])

const CRYPTO_MARKERS = ['USDT', 'USDC', 'BTC', 'ETH']

/**
 * 手输 symbol 推断市场（无市场上下文的手输入口用，如自选管理弹窗的添加框）：
 * 1-5 位数字（含 `00700.HK`/`HK.00700`）→ hk；6 位数字（含 `.SH`/`.SZ`）→ cn；
 * 品种代码+2-4 位数字（如 RB00 主力连续、RB2610、IF2603）→ futures；含加密计价标记 → crypto；其余 → us。
 * 注意与 `store.inferMarket` 的差别：后者是存储恢复用（5 位数字才判 hk、无 USDC），
 * 这里按「用户可能手输 700 表示港股」的宽容口径。
 */
export function inferInputMarket(rawDraft: string): MarketId {
  const raw = rawDraft.trim().toUpperCase()
  if (/^(HK\.)?\d{1,5}(\.HK)?$/.test(raw)) return 'hk'
  if (/^\d{6}(\.(SH|SZ))?$/.test(raw)) return 'cn'
  if (/^[A-Z]{1,3}\d{2,4}(\.(SHF|DCE|CZC|INE|GFE|CFE))?$/.test(raw)) return 'futures'
  if (CRYPTO_MARKERS.some(marker => raw.includes(marker))) return 'crypto'
  return 'us'
}

/** 手输 symbol → 市场规范形：cn 6 位数字补 .SH/.SZ（沪：6/9/5 开头与已知指数），hk 数字补零 .HK；其余大写透传。 */
export function normalizeSymbolInput(target: MarketId, rawDraft: string): string {
  const raw = rawDraft.trim().toUpperCase()
  if (target === 'cn' && /^\d{6}$/.test(raw)) {
    const isSh = raw.startsWith('6') || raw.startsWith('9') || raw.startsWith('5') || KNOWN_SH_INDICES.has(raw)
    return `${raw}.${isSh ? 'SH' : 'SZ'}`
  }
  if (target === 'hk') {
    // 裸数字 / 规范形 00700.HK / Futu 原生形 HK.00700 一律归一到规范形。
    const digits = /^(?:HK\.)?(\d{1,5})(?:\.HK)?$/.exec(raw)?.[1]
    if (digits !== undefined) return `${digits.padStart(5, '0')}.HK`
  }
  return raw
}
