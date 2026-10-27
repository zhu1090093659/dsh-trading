/**
 * client-ui-knowledge 的 locale 契约：独立 namespace「dshtrading.knowledge」
 * （P5 拆包后文案随视图包走）。key 前缀 kv.*（stage view knowledge）。
 */

export type KnowledgeLocaleKey =
  | 'kv.search.placeholder'
  | 'kv.filter.tag'
  | 'kv.filter.allTags'
  | 'kv.filter.allAuthors'
  | 'kv.filter.allCredibility'
  | 'kv.filter.allSourceTypes'
  | 'kv.filter.reset'
  | 'kv.credibility.high'
  | 'kv.credibility.medium'
  | 'kv.credibility.low'
  | 'kv.sourceType.bilibili'
  | 'kv.sourceType.wechat'
  | 'kv.sourceType.manual'
  | 'kv.empty.hint'
  | 'kv.empty.filtered'
  | 'kv.stats.cards'
  | 'kv.stats.clusters'
  | 'kv.drawer.coreClaims'
  | 'kv.drawer.factCheck'
  | 'kv.drawer.verified'
  | 'kv.drawer.discrepancies'
  | 'kv.drawer.unverifiable'
  | 'kv.drawer.takeaways'
  | 'kv.drawer.boundaries'
  | 'kv.drawer.tickers'
  | 'kv.drawer.related'
  | 'kv.drawer.openSource'
  | 'kv.io.export'
  | 'kv.io.import'
  | 'kv.io.exportEmpty'
  | 'kv.io.dialogTitle'
  | 'kv.io.modeSkip'
  | 'kv.io.modeOverwrite'
  | 'kv.io.planCreate'
  | 'kv.io.planUpdate'
  | 'kv.io.planSkip'
  | 'kv.io.planDropped'
  | 'kv.io.planInvalid'
  | 'kv.io.confirm'
  | 'kv.io.cancel'
  | 'kv.io.applied'
  | 'kv.io.failed'
  | 'kv.io.fileHint'
  | 'kv.io.exportTooLarge'

declare module '@deepseek-ai/dsh-client-locale/client' {
  interface LocaleNamespaceMap {
    /** 知识库视图词典（client-ui-knowledge 包私有）。 */
    'dshtrading.knowledge': KnowledgeLocaleKey
  }
}