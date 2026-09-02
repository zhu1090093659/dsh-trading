/**
 * 内置标的字典（联想用）：自 issue #33 起升位为 host 侧 SSOT
 * （@dsh-trading/router/catalog，instruments_search 工具与桥共用），本模块
 * 保留为再导出垫片，既有导入路径不破坏。
 */
export { SYMBOL_CATALOG, getMergedCatalog, searchSymbols, setDynamicCatalog, updateDynamicCatalog, searchAllMarkets, type CatalogEntry, type CatalogMarket, type Suggestion } from '@dsh-trading/router/catalog'
