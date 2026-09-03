/**
 * client-ui-strategies 的 locale 契约：独立 namespace「dshtrading.strategies」
 * （P5 拆包后文案随视图包走，不再寄生 shell 的 dshtrading.market 词典——
 * 同 NS 双包注册会整表覆盖）。key 前缀 sv.*（stage view strategies）。
 */

export type StrategyLocaleKey =
  | 'sv.section.screener'
  | 'sv.section.quant'
  | 'sv.error.noKlines'
  | 'sv.error.failed'
  | 'sv.horizon.short'
  | 'sv.horizon.swing'
  | 'sv.horizon.long'
  | 'sv.symbolLabel'
  | 'sv.intervalDaily'
  | 'sv.run'
  | 'sv.running'
  | 'sv.metrics.totalReturn'
  | 'sv.metrics.cagr'
  | 'sv.metrics.maxDrawdown'
  | 'sv.metrics.sharpe'
  | 'sv.metrics.winRate'
  | 'sv.metrics.profitFactor'
  | 'sv.metrics.tradeCount'
  | 'sv.metrics.tradeUnit'
  | 'sv.metrics.exposure'
  | 'sv.trades.title'
  | 'sv.trades.empty'
  | 'sv.trades.entryTime'
  | 'sv.trades.exitTime'
  | 'sv.trades.entryPrice'
  | 'sv.trades.exitPrice'
  | 'sv.trades.holdingBars'
  | 'sv.trades.netReturn'
  | 'sv.trades.exitReason'
  | 'sv.empty.hint'
  | 'sv.screener.run'
  | 'sv.screener.running'
  | 'sv.screener.stop'
  | 'sv.screener.scanLimit'
  | 'sv.screener.universePrefix'
  | 'sv.screener.scanned'
  | 'sv.screener.hits'
  | 'sv.screener.failed'
  | 'sv.screener.noUniverse'
  | 'sv.screener.noHits'
  | 'sv.screener.scanning'
  | 'sv.screener.emptyHint'
  | 'sv.screener.col.symbol'
  | 'sv.screener.col.name'
  | 'sv.screener.col.price'
  | 'sv.screener.col.reason'

declare module '@deepseek-ai/dsh-client-locale/client' {
  interface LocaleNamespaceMap {
    /** 策略视图词典（client-ui-strategies 包私有）。 */
    'dshtrading.strategies': StrategyLocaleKey
  }
}