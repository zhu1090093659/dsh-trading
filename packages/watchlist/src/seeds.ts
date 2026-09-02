/**
 * 各市场种子自选行（GUI 左栏的默认展示行）——单一事实源。
 *
 * 背景（2026-09-02 agent 可见性修复）：种子行原先只活在 client-ui-trading 的
 * store.ts，host 侧 `watchlist_list` 只能看到用户定制行——用户看着左栏里的
 * 苹果/AAPL 问行情，Agent 却答"不在自选里"。种子表上收到本包后，客户端展示
 * 回退与 Agent 工具合并视图同源（展示语义：市场未定制时回落种子，见
 * effectiveWatchlistRows——与客户端 rowsFor 同构）。
 *
 * 词汇纪律：symbol 用市场规范形（docs/symbol-vocabulary.md）。
 */
import type { WatchlistInstrument, WatchlistsMap } from './index.ts'

/** 各市场种子行（connector-validated symbol formats）。 */
export const WATCHLIST_SEEDS: WatchlistsMap = {
  crypto: [
    { market: 'crypto', symbol: 'BTCUSDT', name: 'Bitcoin' },
    { market: 'crypto', symbol: 'ETHUSDT', name: 'Ethereum' },
    { market: 'crypto', symbol: 'SOLUSDT', name: 'Solana' },
    { market: 'crypto', symbol: 'BNBUSDT', name: 'BNB' },
  ],
  us: [
    { market: 'us', symbol: 'AAPL', name: '苹果' },
    { market: 'us', symbol: 'MSFT', name: '微软' },
    { market: 'us', symbol: 'NVDA', name: '英伟达' },
    { market: 'us', symbol: 'GOOGL', name: '谷歌' },
  ],
  cn: [
    { market: 'cn', symbol: '600519', name: '贵州茅台' },
    { market: 'cn', symbol: '000001', name: '平安银行' },
    { market: 'cn', symbol: '601318', name: '中国平安' },
  ],
  hk: [
    { market: 'hk', symbol: '00700', name: '腾讯控股' },
    { market: 'hk', symbol: '09988', name: '阿里巴巴-W' },
    { market: 'hk', symbol: '03690', name: '美团-W' },
  ],
}

/** 单市场展示行：用户定制行优先；未定制（缺键/空数组）回落该市场种子。 */
export function effectiveWatchlistRows(map: WatchlistsMap, market: string): WatchlistInstrument[] {
  const rows = map[market]
  if (rows !== undefined && rows.length > 0) return rows
  return WATCHLIST_SEEDS[market] ?? []
}

/** 单市场行来源：'custom' = 用户定制行；'seed' = 种子展示行（未定制）。 */
export function watchlistRowSource(map: WatchlistsMap, market: string): 'custom' | 'seed' {
  const rows = map[market]
  return rows !== undefined && rows.length > 0 ? 'custom' : 'seed'
}
