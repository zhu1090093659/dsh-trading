/**
 * 内置标的字典（联想用，2026-08-31 用户反馈"输入代码没有自动联想"）：
 * 每市场常见标的的 symbol + 中文名静态种子。**静态快照**——新上市标的靠
 * "回车直接添加"兜底（任意规范符号仍可加入）；后续可接交易所 instruments
 * 端点做动态全集（届时本表退化为冷启动加速）。
 *
 * 词汇纪律：symbol 一律市场规范词汇（docs/symbol-vocabulary.md）。
 */
import type { MarketId } from './types.ts'

export interface CatalogEntry {
  symbol: string
  name: string
}

export const SYMBOL_CATALOG: Record<MarketId, CatalogEntry[]> = {
  crypto: [
    { symbol: 'BTCUSDT', name: '比特币' },
    { symbol: 'ETHUSDT', name: '以太坊' },
    { symbol: 'SOLUSDT', name: 'Solana' },
    { symbol: 'BNBUSDT', name: 'BNB' },
    { symbol: 'XRPUSDT', name: 'XRP' },
    { symbol: 'DOGEUSDT', name: '狗狗币' },
    { symbol: 'ADAUSDT', name: '艾达币' },
    { symbol: 'TRXUSDT', name: '波场' },
    { symbol: 'AVAXUSDT', name: '雪崩' },
    { symbol: 'LINKUSDT', name: '链link' },
    { symbol: 'TONUSDT', name: 'Toncoin' },
    { symbol: 'SHIBUSDT', name: '屎币' },
    { symbol: 'SUIUSDT', name: 'Sui' },
    { symbol: 'DOTUSDT', name: '波卡' },
    { symbol: 'LTCUSDT', name: '莱特币' },
    { symbol: 'BCHUSDT', name: '比特币现金' },
    { symbol: 'NEARUSDT', name: 'NEAR' },
    { symbol: 'APTUSDT', name: 'Aptos' },
    { symbol: 'ARBUSDT', name: 'Arbitrum' },
    { symbol: 'OPUSDT', name: 'Optimism' },
    { symbol: 'ATOMUSDT', name: 'Cosmos' },
    { symbol: 'XLMUSDT', name: '恒星币' },
    { symbol: 'HBARUSDT', name: 'Hedera' },
    { symbol: 'INJUSDT', name: 'Injective' },
    { symbol: 'SEIUSDT', name: 'Sei' },
    { symbol: 'TIAUSDT', name: 'Celestia' },
    { symbol: 'PEPEUSDT', name: 'Pepe' },
    { symbol: 'WIFUSDT', name: 'dogwifhat' },
    { symbol: 'BONKUSDT', name: 'Bonk' },
    { symbol: 'ORDIUSDT', name: 'ORDI' },
    { symbol: 'NOTUSDT', name: 'Notcoin' },
    { symbol: 'UNIUSDT', name: 'Uniswap' },
    { symbol: 'AAVEUSDT', name: 'Aave' },
    { symbol: 'RENDERUSDT', name: 'Render' },
    { symbol: 'FETUSDT', name: 'ASAI' },
    { symbol: 'WLDUSDT', name: '世界币' },
    { symbol: 'JUPUSDT', name: 'Jupiter' },
    { symbol: 'PYTHUSDT', name: 'Pyth' },
    { symbol: 'STXUSDT', name: 'Stacks' },
    { symbol: 'IMXUSDT', name: 'Immutable' },
    { symbol: 'GALAUSDT', name: 'Gala' },
    { symbol: 'SANDUSDT', name: 'The Sandbox' },
    { symbol: 'MANAUSDT', name: 'Decentraland' },
    { symbol: 'AXSUSDT', name: 'Axie Infinity' },
    { symbol: 'CRVUSDT', name: 'Curve' },
    { symbol: 'LDOUSDT', name: 'Lido DAO' },
    { symbol: 'ETCUSDT', name: '以太经典' },
    { symbol: 'FILUSDT', name: 'Filecoin' },
    { symbol: 'MATICUSDT', name: 'Polygon' },
    { symbol: 'ETHBTC', name: 'ETH/BTC' },
  ],
  us: [
    { symbol: 'AAPL', name: '苹果' },
    { symbol: 'MSFT', name: '微软' },
    { symbol: 'GOOGL', name: '谷歌' },
    { symbol: 'AMZN', name: '亚马逊' },
    { symbol: 'META', name: 'Meta' },
    { symbol: 'NVDA', name: '英伟达' },
    { symbol: 'TSLA', name: '特斯拉' },
    { symbol: 'AVGO', name: '博通' },
    { symbol: 'TSM', name: '台积电' },
    { symbol: 'LLY', name: '礼来' },
    { symbol: 'JPM', name: '摩根大通' },
    { symbol: 'V', name: 'Visa' },
    { symbol: 'MA', name: '万事达' },
    { symbol: 'UNH', name: '联合健康' },
    { symbol: 'JNJ', name: '强生' },
    { symbol: 'WMT', name: '沃尔玛' },
    { symbol: 'PG', name: '宝洁' },
    { symbol: 'HD', name: '家得宝' },
    { symbol: 'ORCL', name: '甲骨文' },
    { symbol: 'CRM', name: '赛富时' },
    { symbol: 'NFLX', name: '奈飞' },
    { symbol: 'AMD', name: '超威半导体' },
    { symbol: 'INTC', name: '英特尔' },
    { symbol: 'QCOM', name: '高通' },
    { symbol: 'TXN', name: '德州仪器' },
    { symbol: 'ADBE', name: 'Adobe' },
    { symbol: 'PYPL', name: 'PayPal' },
    { symbol: 'DIS', name: '迪士尼' },
    { symbol: 'KO', name: '可口可乐' },
    { symbol: 'PEP', name: '百事' },
    { symbol: 'MCD', name: '麦当劳' },
    { symbol: 'NKE', name: '耐克' },
    { symbol: 'BA', name: '波音' },
    { symbol: 'CAT', name: '卡特彼勒' },
    { symbol: 'XOM', name: '埃克森美孚' },
    { symbol: 'CVX', name: '雪佛龙' },
    { symbol: 'BAC', name: '美国银行' },
    { symbol: 'C', name: '花旗' },
    { symbol: 'GS', name: '高盛' },
    { symbol: 'MS', name: '摩根士丹利' },
    { symbol: 'BLK', name: '贝莱德' },
    { symbol: 'UBER', name: '优步' },
    { symbol: 'ABNB', name: '爱彼迎' },
    { symbol: 'COIN', name: 'Coinbase' },
    { symbol: 'MSTR', name: '微策略' },
    { symbol: 'PLTR', name: 'Palantir' },
    { symbol: 'SMCI', name: '超微电脑' },
    { symbol: 'BABA', name: '阿里巴巴' },
    { symbol: 'GM', name: '通用汽车' },
    { symbol: 'F', name: '福特' },
  ],
  cn: [
    { symbol: '600519.SH', name: '贵州茅台' },
    { symbol: '000001.SZ', name: '平安银行' },
    { symbol: '600036.SH', name: '招商银行' },
    { symbol: '000333.SZ', name: '美的集团' },
    { symbol: '000651.SZ', name: '格力电器' },
    { symbol: '601318.SH', name: '中国平安' },
    { symbol: '600900.SH', name: '长江电力' },
    { symbol: '601398.SH', name: '工商银行' },
    { symbol: '601988.SH', name: '中国银行' },
    { symbol: '601939.SH', name: '建设银行' },
    { symbol: '600030.SH', name: '中信证券' },
    { symbol: '601899.SH', name: '紫金矿业' },
    { symbol: '000002.SZ', name: '万科A' },
    { symbol: '002594.SZ', name: '比亚迪' },
    { symbol: '300750.SZ', name: '宁德时代' },
    { symbol: '002475.SZ', name: '立讯精密' },
    { symbol: '603259.SH', name: '药明康德' },
    { symbol: '600276.SH', name: '恒瑞医药' },
    { symbol: '000858.SZ', name: '五粮液' },
    { symbol: '002415.SZ', name: '海康威视' },
    { symbol: '688981.SH', name: '中芯国际' },
    { symbol: '601012.SH', name: '隆基绿能' },
    { symbol: '600887.SH', name: '伊利股份' },
    { symbol: '601888.SH', name: '中国中免' },
    { symbol: '600028.SH', name: '中国石化' },
    { symbol: '601857.SH', name: '中国石油' },
    { symbol: '601668.SH', name: '中国建筑' },
    { symbol: '601728.SH', name: '中国电信' },
    { symbol: '600941.SH', name: '中国移动' },
    { symbol: '600050.SH', name: '中国联通' },
    { symbol: '300059.SZ', name: '东方财富' },
    { symbol: '300124.SZ', name: '汇川技术' },
    { symbol: '002230.SZ', name: '科大讯飞' },
    { symbol: '688111.SH', name: '金山办公' },
    { symbol: '688041.SH', name: '海光信息' },
    { symbol: '002371.SZ', name: '北方华创' },
    { symbol: '603501.SH', name: '韦尔股份' },
    { symbol: '600584.SH', name: '长电科技' },
    { symbol: '601127.SH', name: '赛力斯' },
    { symbol: '002714.SZ', name: '牧原股份' },
  ],
  hk: [
    { symbol: '00700.HK', name: '腾讯控股' },
    { symbol: '09988.HK', name: '阿里巴巴-W' },
    { symbol: '03690.HK', name: '美团-W' },
    { symbol: '09618.HK', name: '京东集团-SW' },
    { symbol: '09999.HK', name: '网易-S' },
    { symbol: '09888.HK', name: '百度集团-SW' },
    { symbol: '01024.HK', name: '快手-W' },
    { symbol: '09626.HK', name: '哔哩哔哩-W' },
    { symbol: '01810.HK', name: '小米集团-W' },
    { symbol: '02015.HK', name: '理想汽车-W' },
    { symbol: '09863.HK', name: '零跑汽车' },
    { symbol: '01211.HK', name: '比亚迪股份' },
    { symbol: '02333.HK', name: '长城汽车' },
    { symbol: '00175.HK', name: '吉利汽车' },
    { symbol: '00939.HK', name: '建设银行' },
    { symbol: '01398.HK', name: '工商银行' },
    { symbol: '01299.HK', name: '友邦保险' },
    { symbol: '02318.HK', name: '中国平安' },
    { symbol: '00388.HK', name: '香港交易所' },
    { symbol: '00005.HK', name: '汇丰控股' },
    { symbol: '00941.HK', name: '中国移动' },
    { symbol: '00857.HK', name: '中国石油股份' },
    { symbol: '00883.HK', name: '中国海洋石油' },
    { symbol: '03888.HK', name: '金山软件' },
    { symbol: '02628.HK', name: '中国人寿' },
    { symbol: '00322.HK', name: '康师傅控股' },
    { symbol: '02319.HK', name: '蒙牛乳业' },
    { symbol: '01876.HK', name: '百威亚太' },
    { symbol: '00316.HK', name: '东方海外国际' },
    { symbol: '00669.HK', name: '创科实业' },
  ],
}

const dynamicCatalogs = new Map<MarketId, CatalogEntry[]>()

/** 注入某市场的动态标的全集（由桥端点拉取并入）。 */
export function setDynamicCatalog(market: MarketId, entries: Array<{ symbol: string; name?: string }>): void {
  const normalized: CatalogEntry[] = entries.map((e) => ({
    symbol: e.symbol,
    name: e.name ?? e.symbol,
  }))
  dynamicCatalogs.set(market, normalized)
}

/** 获取静态快照 ∪ 动态全集融合后的标的列表（静态优先保留中文名）。 */
export function getMergedCatalog(market: MarketId): CatalogEntry[] {
  const staticList = SYMBOL_CATALOG[market] ?? []
  const dynamicList = dynamicCatalogs.get(market) ?? []
  if (dynamicList.length === 0) return staticList
  const seen = new Set<string>()
  const merged: CatalogEntry[] = []
  for (const entry of staticList) {
    seen.add(entry.symbol.toUpperCase())
    merged.push(entry)
  }
  for (const entry of dynamicList) {
    const sym = entry.symbol.toUpperCase()
    if (!seen.has(sym)) {
      seen.add(sym)
      merged.push(entry)
    }
  }
  return merged
}

/**
 * 联想搜索：静态 ∪ 动态全集融合，symbol 前缀/包含（大小写不敏感）或中文名包含，返回前 limit 条。
 * 空查询返回空（不打扰）。
 */
export function searchSymbols(market: MarketId, query: string, limit = 8): CatalogEntry[] {
  const q = query.trim().toUpperCase()
  if (q === '') return []
  const catalog = getMergedCatalog(market)
  const scored: Array<{ entry: CatalogEntry; score: number }> = []
  for (const entry of catalog) {
    const symbol = entry.symbol.toUpperCase()
    const name = entry.name ? entry.name.toUpperCase() : ''
    let score = -1
    if (symbol === q) score = 0
    else if (symbol.startsWith(q)) score = 1
    else if (name && name.includes(q)) score = 2
    else if (symbol.includes(q)) score = 3
    if (score >= 0) scored.push({ entry, score })
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.entry)
}

/** 跨市场联想：全部市场字典合并搜索（自选页签的添加是跨市场的）。 */
export interface Suggestion extends CatalogEntry {
  market: MarketId
}

export function searchAllMarkets(query: string, limit = 8): Suggestion[] {
  const q = query.trim().toUpperCase()
  if (q === '') return []
  const markets: MarketId[] = ['crypto', 'us', 'cn', 'hk']
  return markets
    .flatMap((market) => searchSymbols(market, query, limit).map((entry) => ({ ...entry, market })))
    .slice(0, limit)
}
