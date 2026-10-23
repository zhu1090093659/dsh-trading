/**
 * 腾讯公共行情客户端（dsh-trading cn+hk 双市场切片）——单包双市场的数据面。
 *
 * 独立于插件 glue：仅依赖 @dshtrading/api 的类型词汇，无 cordis/dsh-tools 运行时依赖，
 * 便于单测与脚本直接消费（fetch 可注入）。
 *
 * 数据面（2026-08-31 本出口实测，原始证据 spikes/impl-cn-hk/r1-*.raw / r2-*.json）：
 *   - 实时报价：GET https://qt.gtimg.cn/q=<wire>。响应 **GBK 编码**（content-type:
 *     text/html; charset=GBK）——必须 TextDecoder('gbk') 解码，UTF-8 解出中文乱码。
 *     body 形如 `v_sh600519="1~贵州茅台~600519~1297.40~..."`，`~` 分隔。
 *     cn（sh600519/sz000001）与 hk（r_hk00700）**字段布局不同**（详见 parseCnTicker /
 *     parseHkTicker 注释）。
 *   - 日/周/月 K：GET https://ifzq.gtimg.cn/appstock/app/{fqkline,hkfqkline}/get
 *     ?param=<code>,<tf>,,,<count>,qfq → JSON data.<code>.qfq<day|week|month>。
 *     同族 `web.ifzq` 前缀域名已被上游 WAF 封死（HTTP 501 挑战页，2026-10-23 实测），
 *     故日/周/月 K 按 DEFAULT_KLINE_BASE_URLS 顺序回退（ifzq → web.ifzq），详见该常量注。
 *     行字段序是 **开收高低量**（open,close,high,low,volume）——与 OHLC 直觉相反，
 *     解析错序 K 线整体失真。hk 行第 7 个元素起是分红/回购等附加对象，须丢弃。
 *     cn 用 fqkline + sh/sz 前缀；**hk 报价用 r_hk 前缀而 K 线用 hk 前缀**——
 *     r_hk00700 打 K 线端点返回 {"code":0,"msg":"param error"}（实测）。
 *   - 分钟线端点（kline/mkline）在本出口 fetch 失败，未实现（待验证）。
 *
 * 合规（README 铁律 #5）：腾讯公共行情端点、无 key、无官方授权；个人使用边界自负，
 * 本仓不缓存、不再分发行情数据（详见 README 数据源节）。
 *
 * @module @dshtrading/connector-tencent/rest
 */

import type { ActiveBuySnapshot, Interval, Kline, KlineCapability, Orderbook, OrderbookLevel, StockFundamentals, Ticker, TradingErrorCode } from '@dshtrading/api'

/* ------------------------------------------------------------------ */
/* 错误载体（api 包词汇的运行时映射，与 connector-stooq 同构）               */
/* ------------------------------------------------------------------ */

/** api 包 TradingError 契约的运行时 Error 实现。 */
export class TradingServiceError extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'TradingServiceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/* ------------------------------------------------------------------ */
/* 符号规范化（单包双市场的市场分流在此收敛）                                  */
/* ------------------------------------------------------------------ */

export type TencentMarket = 'cn' | 'hk'

// 规范词汇（docs/symbol-vocabulary.md）：接受 600519.SH / 600519.sh / SH600519 / 裸 6 位。
const CN_SYMBOL_PATTERN = /^(?:(sh|sz)(\d{6})|(\d{6})(?:\.(sh|sz))?)$/
// 常见知名上海指数代码（深交所无对应证券，裸 6 位数字时推断为 sh）
const KNOWN_SH_INDICES = new Set(['000688', '000300', '000016', '000905', '000852'])
// 规范词汇：接受 00700.HK（规范形）、裸 1-5 位数字（宽容输入）及 HSI/HSTECH/HSCEI 等指数代码。
const HK_SYMBOL_PATTERN = /^(?:r_hk|hk)?([a-z0-9^]{1,10})(?:\.hk)?$/i

/**
 * 规范化 A 股符号：接受 `600519` / `SH600519` / `sh600519` / `sz000001`，统一为
 * 腾讯 wire 形态小写 `<sh|sz><6位数字>`。6/9 开头→sh（沪，含科创板 688），5 开头→sh（沪市基金/ETF），
 * 0/3 开头→sz（深，含创业板 300；知名上海指数 000688/000300 等推断为 sh）。4/8 开头（北交所）不在本切片支持范围。
 */
export function normalizeCnSymbol(symbol: string): string {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      'Symbol must be a non-empty string, e.g. 600519 / SH600519 / sz000001',
    )
  }
  const raw = symbol.trim().toLowerCase()
  const m = CN_SYMBOL_PATTERN.exec(raw)
  if (!m) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      `Symbol ${JSON.stringify(symbol)} is not a valid CN A-share symbol (expected 6-digit code, optionally SH/SZ prefixed)`,
    )
  }
  if (m[1]) return `${m[1]}${m[2]}` // 前缀形 sh600519
  const code = m[3] ?? ''
  if (!code) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      `Symbol ${JSON.stringify(symbol)} is not a valid CN A-share symbol (expected 6-digit code, optionally SH/SZ prefixed)`,
    )
  }
  if (m[4]) return `${m[4]}${code}` // 规范形 600519.SH（后缀即交易所）
  const prefix =
    code.startsWith('6') || code.startsWith('9') || code.startsWith('5') || KNOWN_SH_INDICES.has(code)
      ? 'sh'
      : 'sz' // 裸码宽容输入：按首位及已知上海指数推断
  return `${prefix}${code}`
}

/**
 * 规范化港股符号：接受 `00700` / `700`（1-5 位数字，不足 5 位左补零，统一为 5 位数字
 * 形态 `00700`）及 `HSI` / `HSTECH` / `HSCEI` 等指数符号。wire 形态由客户端按端点再加前缀（报价 `r_hk` / K线 `hk`）。
 */
export function normalizeHkSymbol(symbol: string): string {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      'Symbol must be a non-empty string, e.g. 00700, 700 or HSI',
    )
  }
  const m = HK_SYMBOL_PATTERN.exec(symbol.trim().toLowerCase())
  if (!m) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      `Symbol ${JSON.stringify(symbol)} is not a valid HK stock code or index (expected 1-5 digits or index symbol, e.g. 700 / 00700 / HSI)`,
    )
  }
  const code = m[1] ?? ''
  if (/^\d+$/.test(code)) return code.padStart(5, '0')
  return code.toUpperCase()
}

/** 按市场规范化符号并返回市场。 */
export function normalizeSymbol(market: TencentMarket, symbol: string): string {
  return market === 'hk' ? normalizeHkSymbol(symbol) : normalizeCnSymbol(symbol)
}

/**
 * 输出归一 → 规范形（docs/symbol-vocabulary.md）：cn wire 形 sh600519 → 600519.SH；
 * hk 5 位形 00700 → 00700.HK，指数形 HSI → HSI.HK。下游永远看到市场规范词汇。
 */
export function toCanonicalTencentSymbol(market: TencentMarket, wireOrCode: string): string {
  if (market === 'hk') {
    const raw = wireOrCode.replace(/^r_hk|^hk/i, '')
    return `${raw}.HK`
  }
  const m = /^(sh|sz)(\d{6})$/i.exec(wireOrCode)
  return m ? `${m[2]}.${(m[1] ?? '').toUpperCase()}` : wireOrCode
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* interval → 腾讯周期参数（日周月 fqkline / 分钟 mkline）              */
/* ------------------------------------------------------------------ */

export type TencentKlineType = 'fqkline' | 'mkline'

export interface TencentIntervalDef {
  readonly type: TencentKlineType
  readonly tf: string
  readonly key: string
  readonly durationMs: number
}

/** api Interval 词汇的受支持子集 → 腾讯 tf= 值与响应键。 */
const INTERVAL_TO_TENCENT: ReadonlyMap<Interval, TencentIntervalDef> = new Map([
  ['5m', { type: 'mkline', tf: 'm5', key: 'm5', durationMs: 5 * 60_000 }],
  ['30m', { type: 'mkline', tf: 'm30', key: 'm30', durationMs: 30 * 60_000 }],
  ['1d', { type: 'fqkline', tf: 'day', key: 'qfqday', durationMs: 86_400_000 }],
  ['1w', { type: 'fqkline', tf: 'week', key: 'qfqweek', durationMs: 7 * 86_400_000 }],
  ['1M', { type: 'fqkline', tf: 'month', key: 'qfqmonth', durationMs: 30 * 86_400_000 }],
])

/** 工具 parameters enum 用：受支持 interval 词汇。 */
export const INTERVAL_VOCABULARY: readonly string[] = [...INTERVAL_TO_TENCENT.keys()]

/**
 * 单请求能承接的根数上限 = 800（2026-10-14 实测，spikes/impl-five-day-1m-probe/EVIDENCE.md §1）：
 * mkline 端点 count ≤ 800 正常，**超过即静默降级到 320 根**（不是报错），无游标可翻页。
 * 故 800 是本连接器能诚实承接的 limit 上限（getKlines 也按它 min 裁剪）。
 */
export const TENCENT_KLINE_MAX_BARS = 800

/**
 * K 线能力声明（api 可选契约 klineCapabilities）：本实例能诚实服务的 (周期, 请求深度)。
 * - 周期集 = INTERVAL_TO_TENCENT 的键；**hk 实例不含 5m/30m**——mkline 端点对港股一律
 *   `msg: param error`（实测同上 §1），getKlines 也显式抛 TRADING_UNSUPPORTED_INTERVAL；
 * - 深度 = TENCENT_KLINE_MAX_BARS（上限即截断点，超过就静默降级，不是「多给几根」）。
 */
export function tencentKlineCapabilities(market: TencentMarket): KlineCapability[] {
  return [...INTERVAL_TO_TENCENT]
    .filter(([, def]) => !(def.type === 'mkline' && market === 'hk'))
    .map(([interval]) => ({ interval, maxBars: TENCENT_KLINE_MAX_BARS }))
}

/* ------------------------------------------------------------------ */
/* 时间处理                                                                */
/* ------------------------------------------------------------------ */

/**
 * 分钟 K 线时间 `YYYYMMDDHHmm` → epoch ms（Asia/Shanghai 墙钟，12 位紧凑格式）。
 */
export function minuteKlineTimeToEpochMs(value: string, timeZone = 'Asia/Shanghai'): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value)
  if (!m) throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `invalid tencent minute kline timestamp ${JSON.stringify(value)}`)
  const [, y, mo, d, h, mi] = m
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0)
  const offsetMs = (date: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(date))
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
    const hour = get('hour') % 24
    return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - date
  }
  return guess - offsetMs(guess)
}

/** K 线日期 `YYYY-MM-DD` → epoch ms（UTC 当日零点锚定，行情日界语义，与 stooq 映射同构）。 */
export function klineDateToEpochMs(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `invalid tencent kline date ${JSON.stringify(date)}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/**
 * 交易所当地墙钟 → epoch ms（Intl 求时区偏移，含夏令时；同 stooq easternWallTimeToEpochMs
 * 的两轮逼近法，泛化时区参数）。cn 报价时间是 `YYYYMMDDHHMMSS`（Asia/Shanghai），
 * hk 报价时间是 `YYYY/MM/DD HH:MM:SS`（Asia/Hong_Kong）。
 */
export function wallTimeToEpochMs(value: string, timeZone: string): number {
  // cn 报价时间是紧凑形态 YYYYMMDDHHMMSS；hk 是 YYYY/MM/DD HH:MM:SS——先归一化。
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value)
  const normalized = (compact
    ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}`
    : value.replace(/\//g, '-')
  ).replace(/^(\d{4}-\d{2}-\d{2})$/, '$1T00:00:00')
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(normalized)
  if (!m) throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `invalid tencent quote timestamp ${JSON.stringify(value)}`)
  const [, y, mo, d, h, mi, s] = m
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0))
  const offsetMs = (date: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(date))
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0')
    const hour = get('hour') % 24
    return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - date
  }
  return guess - offsetMs(guess)
}

/* ------------------------------------------------------------------ */
/* 行解析                                                                  */
/* ------------------------------------------------------------------ */

/** 宽松转 number（非有限值返回 undefined）。 */
function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** cn 报价扩展字段（Ticker 契约的超集；风控 skill 用涨停/跌停价）。 */
export interface CnTickerExtra {
  readonly market: 'cn'
  readonly name: string
  readonly prevClose?: number
  readonly open?: number
  readonly high?: number
  readonly low?: number
  /** 涨停价（f47）。 */
  readonly limitUp?: number
  /** 跌停价（f48）。 */
  readonly limitDown?: number
  readonly change?: number
  readonly changePercent?: number
  readonly currency: 'CNY'
}

/** hk 报价扩展字段。 */
export interface HkTickerExtra {
  readonly market: 'hk'
  readonly name: string
  readonly prevClose?: number
  readonly open?: number
  readonly high?: number
  readonly low?: number
  readonly change?: number
  readonly changePercent?: number
  /** 52 周最高（f48）。 */
  readonly week52High?: number
  /** 52 周最低（f49）。 */
  readonly week52Low?: number
  readonly currency: 'HKD'
}

export type TencentTicker = Ticker & (CnTickerExtra | HkTickerExtra)

/**
 * cn 报价字段布局（v_sh600519，2026-08-31 实测 sh600519，88 字段）：
 * 1=名称 2=代码 3=现价 4=昨收 5=今开 6=成交量(**手**) 9=买一价 19=卖一价
 * 30=时间 YYYYMMDDHHMMSS(Asia/Shanghai) 31=涨跌 32=涨跌% 33=最高 34=最低
 * 35="价/量(手)/额(元)" 47=涨停价 48=跌停价 82=币种(CNY)。
 */
function parseCnTicker(fields: string[], timestamp: number): TencentTicker {
  const price = num(fields[3])
  if (price === undefined) {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'Tencent CN ticker: missing/invalid price field')
  }
  const bid = num(fields[9])
  const ask = num(fields[19])
  const volumeLots = num(fields[6])
  return {
    market: 'cn',
    currency: 'CNY',
    name: fields[1] ?? '',
    symbol: String(fields[2] ?? ''),
    price,
    ...(bid !== undefined && bid > 0 ? { bid } : {}),
    ...(ask !== undefined && ask > 0 ? { ask } : {}),
    // cn 成交量单位是手（100 股）：统一归一到股，与 hk 对齐。
    ...(volumeLots !== undefined ? { volume: volumeLots * 100 } : {}),
    timestamp,
    prevClose: num(fields[4]),
    open: num(fields[5]),
    high: num(fields[33]),
    low: num(fields[34]),
    limitUp: num(fields[47]),
    limitDown: num(fields[48]),
    change: num(fields[31]),
    changePercent: num(fields[32]),
  }
}

/**
 * hk 报价字段布局（v_r_hk00700，2026-08-31 实测腾讯控股，78 字段——与 cn 布局不同）：
 * 1=名称 2=代码 3=现价 4=昨收 5=今开 6=成交量(**股**，非手) 30=时间 YYYY/MM/DD
 * HH:MM:SS(Asia/Hong_Kong) 31=涨跌 32=涨跌% 33=最高 34=最低 37=成交额(HKD)
 * 46=英文名 48=52周高 49=52周低 75=币种(HKD)。买卖档位字段全 0（r_hk 实时档不可用），
 * bid/ask 置缺省。
 */
function parseHkTicker(fields: string[], timestamp: number): TencentTicker {
  const price = num(fields[3])
  if (price === undefined) {
    throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'Tencent HK ticker: missing/invalid price field')
  }
  return {
    market: 'hk',
    currency: 'HKD',
    name: fields[1] ?? '',
    symbol: String(fields[2] ?? ''),
    price,
    ...(num(fields[6]) !== undefined ? { volume: num(fields[6]) } : {}),
    timestamp,
    prevClose: num(fields[4]),
    open: num(fields[5]),
    high: num(fields[33]),
    low: num(fields[34]),
    change: num(fields[31]),
    changePercent: num(fields[32]),
    week52High: num(fields[48]),
    week52Low: num(fields[49]),
  }
}

/**
 * cn 五档盘口解析（issue #39）。字段布局（v_sh600519，与 parseCnTicker 同一行）：
 * 9=买一价 10=买一量(**手**) … 17=买五价 18=买五量；19=卖一价 20=卖一量 … 27=卖五价
 * 28=卖五量。档位全 0/缺省时该档丢弃——全部无效时返回空档位（消费方显示空态，
 * 盘后/集合竞价外时段属正常），不抛错。
 */
export function parseCnOrderbook(fields: string[], timestamp: number): Orderbook {
  const bids: OrderbookLevel[] = []
  const asks: OrderbookLevel[] = []
  // 买档：价 fields[9,11,13,15,17]，量 fields[10,12,14,16,18]（手 → 股 ×100）。
  for (let i = 0; i < 5; i++) {
    const price = num(fields[9 + i * 2])
    const amountLots = num(fields[10 + i * 2])
    if (price !== undefined && amountLots !== undefined && price > 0 && amountLots > 0) {
      bids.push({ price, amount: amountLots * 100 })
    }
  }
  // 卖档：价 fields[19,21,23,25,27]，量 fields[20,22,24,26,28]（手 → 股 ×100）。
  for (let i = 0; i < 5; i++) {
    const price = num(fields[19 + i * 2])
    const amountLots = num(fields[20 + i * 2])
    if (price !== undefined && amountLots !== undefined && price > 0 && amountLots > 0) {
      asks.push({ price, amount: amountLots * 100 })
    }
  }
  // 行内保证：bids 降序（买一在前）、asks 升序（卖一在前）——腾讯行天然按档位排布。
  return { symbol: '', bids, asks, timestamp }
}

/** 基本面快照 = api 契约形（币种单位由市场决定：cn=CNY，hk=HKD，展示层标注）。 */
export type TencentFundamentals = StockFundamentals

/**
 * cn 基本面字段布局（与 parseCnTicker 同一行报价；字段号 2026-09-02 实测
 * spikes/impl-cn-hk/r4-fundamentals/ 核对）：38=换手率% 39=动态PE 44=流通市值(亿)
 * 45=总市值(亿) 46=PB 52=静态PE 53=PE(TTM) **67=52周高 68=52周低**。
 * 注意：kit-cn/fundamentals 的 68/69 与其实测夹具自洽，但夹具比真实响应多一个空字段
 * （真实行 53 之后只有两个空位，52 周高在 67）——本解析器以 r4 原始字节证据为准。
 * 字段缺省（指数/ETF）时 num() 置 undefined 后整字段省略。
 */
function parseCnFundamentals(fields: string[], timestamp: number): TencentFundamentals {
  const peDynamic = num(fields[39])
  const peTtm = num(fields[53]) ?? peDynamic
  const totalMarketCapYi = num(fields[45])
  const floatMarketCapYi = num(fields[44])
  return {
    symbol: '',
    name: fields[1] ?? '',
    ...(totalMarketCapYi !== undefined ? { marketCap: totalMarketCapYi * 100_000_000 } : {}),
    ...(floatMarketCapYi !== undefined ? { floatMarketCap: floatMarketCapYi * 100_000_000 } : {}),
    ...(peTtm !== undefined ? { peTtm } : {}),
    ...(peDynamic !== undefined ? { peDynamic } : {}),
    ...(num(fields[46]) !== undefined ? { pb: num(fields[46]) } : {}),
    ...(num(fields[38]) !== undefined ? { turnoverRate: num(fields[38]) } : {}),
    ...(num(fields[67]) !== undefined ? { fiftyTwoWeekHigh: num(fields[67]) } : {}),
    ...(num(fields[68]) !== undefined ? { fiftyTwoWeekLow: num(fields[68]) } : {}),
    timestamp,
  }
}

/**
 * hk 基本面字段布局（与 parseHkTicker 同一行报价，字段号对齐 kit-hk/fundamentals 实测）：
 * 39=动态PE 44=总市值(亿港元) 45=流通市值(亿港元) 47=股息率(百分比数值) 48=52周高 49=52周低
 * 57=PE(TTM) 58=PB 59=换手率%。
 */
function parseHkFundamentals(fields: string[], timestamp: number): TencentFundamentals {
  const peDynamic = num(fields[39])
  const peTtm = num(fields[57]) ?? peDynamic
  const totalMarketCapYi = num(fields[44])
  const floatMarketCapYi = num(fields[45])
  const dividendYieldPercent = num(fields[47])
  return {
    symbol: '',
    name: fields[1] ?? '',
    ...(totalMarketCapYi !== undefined ? { marketCap: totalMarketCapYi * 100_000_000 } : {}),
    ...(floatMarketCapYi !== undefined ? { floatMarketCap: floatMarketCapYi * 100_000_000 } : {}),
    ...(peTtm !== undefined ? { peTtm } : {}),
    ...(peDynamic !== undefined ? { peDynamic } : {}),
    ...(num(fields[58]) !== undefined ? { pb: num(fields[58]) } : {}),
    // 契约语义是小数（0.015 = 1.5%）；腾讯 wire 给的是百分比数值（1.17 = 1.17%）。
    ...(dividendYieldPercent !== undefined ? { dividendYield: dividendYieldPercent / 100 } : {}),
    ...(num(fields[59]) !== undefined ? { turnoverRate: num(fields[59]) } : {}),
    ...(num(fields[48]) !== undefined ? { fiftyTwoWeekHigh: num(fields[48]) } : {}),
    ...(num(fields[49]) !== undefined ? { fiftyTwoWeekLow: num(fields[49]) } : {}),
    timestamp,
  }
}

/* ------------------------------------------------------------------ */
/* 主动买盘快照（cn 专用，2026-10-13）                                      */
/* ------------------------------------------------------------------ */

/** ActiveBuySnapshot.source 的取值（与 api 契约同一事实，只在这里写一次）。 */
export const ACTIVE_BUY_SOURCE = 'qt.gtimg.cn'

/**
 * 行的严格数值读数：空串/纯空白视为**缺失**。
 * `Number('') === 0`——用宽松读数会把「字段缺席」伪装成 0 读数，而「主动买/卖为 0」
 * 本身是有效事实，两者不能混同（本文件此前的 num() 保留给宽容字段用）。
 */
function strictNum(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

/** 占比归一：保留 2 位小数（-0 归一为 0，避免 wire 上出现 `-0`）。 */
function round2(value: number): number {
  const r = Math.round(value * 100) / 100
  return r === 0 ? 0 : r
}

/** 源字段 30（`YYYYMMDDHHMMSS`，交易所本地墙钟）→ 契约的 date/time 两个字符串。 */
function splitQuoteTime(value: string | undefined, symbol: string): { date: string; time: string } {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value ?? '')
  if (!m) {
    throw new TradingServiceError(
      'TRADING_EXCHANGE_ERROR',
      `Tencent CN active-buy for ${symbol}: invalid quote time field ${JSON.stringify(value ?? null)}`,
    )
  }
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}:${m[6]}` }
}

/**
 * cn 主动买盘快照解析（字段布局与 parseCnTicker 同一行报价；字段号 2026-10-13 实测
 * spikes/impl-active-buy/r1-raw-sz002714.gbk）：
 * 6=成交量=当日总量(**手**) 7=外盘=主动买(手) 8=内盘=主动卖(手)
 * 30=时间 YYYYMMDDHHMMSS(Asia/Shanghai) 47=涨停价 48=跌停价。
 *
 * 口径与失败语义（api ActiveBuySnapshot 契约）：
 *   - 外盘/内盘是**行情源按盘口推断**的当日累计主动方向，非交易所官方逐笔方向；
 *   - 总量 <= 0、外盘/内盘字段缺失（空串也算缺失）、非有限或为负 → 抛
 *     TRADING_EXCHANGE_ERROR，**绝不补 0、绝不返回 NaN**（无读数 ≠ 读数 0）；
 *   - 占比按「÷当日总量」口径；`total - outer - inner` 的残差是**未归向成交**（集合竞价与
 *     价间成交计入总量但不计入外/内盘），实测 2026-10-13 为 002714 12/121808 手、
 *     600519 45/7154 手——不是固定量级，且**不参与修正**（源读数原样返回，见 spike 的
 *     sumGap 对照）；
 *   - 涨跌停价字段缺省（指数/ETF）时整字段省略，不用 0 占位。
 */
export function parseCnActiveBuySnapshot(fields: string[], symbol: string, fetchedAt: string): ActiveBuySnapshot {
  const totalLots = strictNum(fields[6])
  if (totalLots === undefined || totalLots <= 0) {
    throw new TradingServiceError(
      'TRADING_EXCHANGE_ERROR',
      `Tencent CN active-buy for ${symbol}: missing/invalid total volume field 6 ${JSON.stringify(fields[6] ?? null)}`,
    )
  }
  const outerLots = strictNum(fields[7])
  const innerLots = strictNum(fields[8])
  if (outerLots === undefined || innerLots === undefined || outerLots < 0 || innerLots < 0) {
    throw new TradingServiceError(
      'TRADING_EXCHANGE_ERROR',
      `Tencent CN active-buy for ${symbol}: missing/invalid outer/inner volume fields 7/8 `
      + `${JSON.stringify(fields[7] ?? null)}/${JSON.stringify(fields[8] ?? null)}`,
    )
  }
  const { date, time } = splitQuoteTime(fields[30], symbol)
  const limitUp = strictNum(fields[47])
  const limitDown = strictNum(fields[48])
  return {
    symbol,
    date,
    time,
    totalLots,
    outerLots,
    innerLots,
    buySharePct: round2((outerLots / totalLots) * 100),
    netSharePct: round2(((outerLots - innerLots) / totalLots) * 100),
    ...(limitUp !== undefined ? { limitUp } : {}),
    ...(limitDown !== undefined ? { limitDown } : {}),
    source: ACTIVE_BUY_SOURCE,
    fetchedAt,
  }
}

/**
 * epoch ms → ISO 8601 **带偏移**（该时区的墙钟，形如 2026-10-13T09:53:12+08:00）。
 * 用 Intl 求时区偏移（含夏令时，与 wallTimeToEpochMs 同一套机制）；不用
 * `Date#toISOString`——它是 UTC `Z` 形，读不出「本地」，且会让同一读数随宿主时区漂移。
 */
export function isoWithOffset(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(epochMs))
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'
  const hour = String(Number(get('hour')) % 24).padStart(2, '0') // ICU 在 hour12:false 下可能给 '24'
  const wall = Date.UTC(
    Number(get('year')), Number(get('month')) - 1, Number(get('day')),
    Number(hour), Number(get('minute')), Number(get('second')),
  )
  const offsetMinutes = Math.round((wall - epochMs) / 60_000)
  const abs = Math.abs(offsetMinutes)
  const offset = `${offsetMinutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}${offset}`
}

/* ------------------------------------------------------------------ */
/* 报价响应文本 → 行映射（单标的与批量共用同一套正则）                          */
/* ------------------------------------------------------------------ */

/**
 * 整段报价响应文本（**已 GBK 解码**）→ wire(小写归一)→字段数组。
 *
 * 每行形如 `v_<wire>="字段~字段~…";\n`——wire 原样可能是 `sh600519` / `r_hk00700` /
 * `r_hkHSI`。**键统一小写归一**：hk 指数 wire 大小写敏感（`r_hkHSI` 有行、`r_hkhsi` 返回
 * `v_pv_none_match="1";`，2026-10-14 实测），请求侧必须原样带大小写，只有查表键归一化；
 * 规范形由调用方持有的 sym 还原，不用响应键（否则指数会变成 `hsi.HK`）。字段切分与单标的
 * 路径同源，批量不另写解析器。
 *
 * 未知代码的两种上游形态都在调用侧处理：单标的短 body `v_pv_none="1"`（键也匹配不上）、
 * 批量响应里**整行缺席**（2026-10-14 实证 `q=sh600519,sz000001,sz159869,sz999999` 只回
 * 3 行，HTTP 200）。
 */
function parseQuoteRows(text: string): Map<string, string[]> {
  const rows = new Map<string, string[]>()
  for (const m of text.matchAll(/v_([A-Za-z0-9_^]+)="([^"]*)"/g)) {
    const wire = (m[1] ?? '').toLowerCase()
    if (!rows.has(wire)) rows.set(wire, (m[2] ?? '').split('~'))
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* 腾讯行情客户端（无凭证、可注入 fetch，便于单测）                            */
/* ------------------------------------------------------------------ */

const DEFAULT_QUOTE_BASE_URL = 'https://qt.gtimg.cn'
/**
 * 日/周/月 K 的域名回退链（有序、最多两级）：2026-10-23 实测 `web.ifzq.gtimg.cn` 被上游
 * WAF 封死（HTTP 501 + `waf.tencent.com/501page.html` 挑战页；绕开本机代理直连
 * 183.47.126.125 仍 501，换 UA/Referer/标的/周期/HTTP 版本全 501），同族 `ifzq.gtimg.cn`
 * 同参数返回 200 且 payload 结构一致（`qfqday`/`qfqweek`）——故同族域名优先、被封域名垫后，
 * 串行各打一次，绝不无限重试。分钟线走 mkline，本就落在同族域名上，不参与回退。
 */
const DEFAULT_KLINE_BASE_URLS = ['https://ifzq.gtimg.cn', 'https://web.ifzq.gtimg.cn'] as const
const DEFAULT_MKLINE_BASE_URL = 'https://ifzq.gtimg.cn'
const DEFAULT_SEARCH_BASE_URL = 'https://smartbox.gtimg.cn'
const DEFAULT_TIMEOUT_MS = 10_000

/** 腾讯 K 线响应体（fqkline / hkfqkline / mkline 同形：code + data.<wire>.<key>）。 */
type TencentKlinePayload = { code?: number; msg?: string; data?: Record<string, Record<string, unknown>> }

export interface TencentRestOptions {
  /** 覆盖报价 base（测试/反代用），末尾不带斜杠。 */
  readonly quoteBaseUrl?: string
  /** 覆盖 K 线 base（测试/反代用），末尾不带斜杠；注入即取代整条回退链，不掺默认域名。 */
  readonly klineBaseUrl?: string
  /** 覆盖分钟 K 线 base（测试/反代用），末尾不带斜杠。 */
  readonly mklineBaseUrl?: string
  /** 覆盖智能联想搜索 base（测试/反代用），末尾不带斜杠。 */
  readonly searchBaseUrl?: string
  /** 单请求超时（ms），默认 10s。 */
  readonly timeoutMs?: number
  /** 注入 fetch 实现；缺省用全局 fetch（Node 22+ 内置）。 */
  readonly fetchImpl?: typeof fetch
  /** 时钟注入（单测固定 active-buy 快照的 fetchedAt 用；缺省 Date.now）。 */
  readonly now?: () => number
}

export class TencentRestClient {
  // 纯数据客户端（非 cordis Service 类），可用 # 私有字段（realm 代理风险只涉 Service 基类）。
  readonly #market: TencentMarket
  readonly #quoteBaseUrl: string
  readonly #klineBaseUrls: readonly string[]
  readonly #mklineBaseUrl: string
  readonly #searchBaseUrl: string
  readonly #timeoutMs: number
  readonly #fetchImpl: typeof fetch
  readonly #now: () => number

  constructor(market: TencentMarket, options: TencentRestOptions = {}) {
    this.#market = market
    this.#quoteBaseUrl = options.quoteBaseUrl ?? DEFAULT_QUOTE_BASE_URL
    this.#klineBaseUrls = options.klineBaseUrl === undefined ? DEFAULT_KLINE_BASE_URLS : [options.klineBaseUrl]
    this.#mklineBaseUrl = options.mklineBaseUrl ?? DEFAULT_MKLINE_BASE_URL
    this.#searchBaseUrl = options.searchBaseUrl ?? DEFAULT_SEARCH_BASE_URL
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.#now = options.now ?? (() => Date.now())
  }

  get market(): TencentMarket {
    return this.#market
  }

  /** 单请求带超时闸门；网络级失败/超时统一抛 TRADING_NETWORK。 */
  async #fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException(`request timed out after ${this.#timeoutMs}ms`, 'TimeoutError')),
      this.#timeoutMs,
    )
    try {
      return await this.#fetchImpl(url, { signal: controller.signal })
    } catch (cause) {
      const timedOut = controller.signal.aborted
      throw new TradingServiceError(
        'TRADING_NETWORK',
        timedOut ? `Tencent ${url}: request timed out after ${this.#timeoutMs}ms` : `Tencent ${url}: network error`,
        cause,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  async #requestArrayBuffer(url: string): Promise<Uint8Array> {
    const res = await this.#fetchWithTimeout(url)
    if (!res.ok) {
      throw new TradingServiceError(
        res.status === 429 ? 'TRADING_RATE_LIMITED' : 'TRADING_EXCHANGE_ERROR',
        `Tencent ${url}: HTTP ${res.status} ${res.statusText}`,
      )
    }
    return new Uint8Array(await res.arrayBuffer())
  }

  /**
   * 单域名取一份 K 线 JSON，把「能不能换下一个域名」的判断就地做掉：
   * 网络级失败（含超时）、HTTP 5xx、非 JSON（WAF 挑战页/HTML 错误页）可换；429/4xx 与
   * 其余业务语义（code!=0、无行、坏行）不重试、由调用方原样 fail-closed。
   */
  async #requestKlinePayload(
    url: string,
    sym: string,
  ): Promise<
    | { readonly ok: true; readonly payload: TencentKlinePayload }
    | { readonly ok: false; readonly retryable: boolean; readonly error: TradingServiceError }
  > {
    let res: Response
    try {
      res = await this.#fetchWithTimeout(url)
    } catch (cause) {
      const error = cause instanceof TradingServiceError
        ? cause
        : new TradingServiceError('TRADING_NETWORK', `Tencent ${url}: network error`, cause)
      return { ok: false, retryable: true, error }
    }
    if (!res.ok) {
      return {
        ok: false,
        retryable: res.status >= 500,
        error: new TradingServiceError(
          res.status === 429 ? 'TRADING_RATE_LIMITED' : 'TRADING_EXCHANGE_ERROR',
          `Tencent ${url}: HTTP ${res.status} ${res.statusText}`,
        ),
      }
    }
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await res.arrayBuffer())
    } catch (cause) {
      return {
        ok: false,
        retryable: true,
        error: new TradingServiceError('TRADING_NETWORK', `Tencent ${url}: network error`, cause),
      }
    }
    try {
      return { ok: true, payload: JSON.parse(new TextDecoder('utf-8').decode(bytes)) as TencentKlinePayload }
    } catch (cause) {
      return {
        ok: false,
        retryable: true,
        error: new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tencent klines for ${sym}: non-JSON payload`, cause),
      }
    }
  }

  /**
   * 报价 wire 形态：cn=sh600519；hk=r_hk00700（hk K 线另用 hk 前缀，见文件头注）。
   * **大小写原样进 URL**：hk 指数 wire 大小写敏感（`r_hkHSI` 有行、`r_hkhsi` 返回
   * `v_pv_none_match="1";`，2026-10-14 实测），只有响应查表键才小写归一。
   */
  #quoteWireCode(symbol: string): string {
    return this.#market === 'hk' ? `r_hk${symbol}` : symbol
  }

  /** K 线 wire 形态：cn=sh600519；hk=hk00700（r_hk 打 K 线端点是 param error，实测）。 */
  #klineWireCode(symbol: string): string {
    return this.#market === 'hk' ? `hk${symbol}` : symbol
  }

  /**
   * 报价批量取数：一次 `GET /q=<wire,wire,…>`（腾讯端点原生支持逗号列表，2026-10-14 实证
   * 40 码单请求 HTTP 200 / 17954 B / 180 ms）→ wire(小写)→字段数组。wires 原样拼 URL
   * （hk 指数大小写敏感，见 #quoteWireCode）；整批失败（网络/超时/HTTP 非 2xx）在
   * #requestArrayBuffer 里抛出，不在这里吞。
   */
  async #fetchQuoteRows(wires: readonly string[]): Promise<Map<string, string[]>> {
    const url = `${this.#quoteBaseUrl}/q=${wires.join(',')}`
    const text = new TextDecoder('gbk').decode(await this.#requestArrayBuffer(url))
    return parseQuoteRows(text)
  }

  /**
   * 单行校验（getTicker 与 getTickers **共用**）：字段数 < 35 = 未知/退市代码的短行
   * （`v_pv_none="1"` 之类）；字段 30 是行情时间（cn=Asia/Shanghai，hk=Asia/Hong_Kong）。
   */
  #validateQuoteRow(fields: string[], sym: string): { fields: string[]; timestamp: number } {
    if (fields.length < 35) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `Tencent ticker for ${sym}: payload has ${fields.length} fields, expected >= 35 (unknown/delisted symbol?)`,
      )
    }
    const timestamp = this.#market === 'hk'
      ? wallTimeToEpochMs(fields[30] ?? '', 'Asia/Hong_Kong')
      : wallTimeToEpochMs(fields[30] ?? '', 'Asia/Shanghai')
    return { fields, timestamp }
  }

  /** 已校验的行 → 契约快照（getTicker 与 getTickers 共用同一解析与规范形出口）。 */
  #tickerFrom(fields: string[], timestamp: number, sym: string): TencentTicker {
    const parsed = this.#market === 'hk' ? parseHkTicker(fields, timestamp) : parseCnTicker(fields, timestamp)
    // 输出一律规范形（响应体 fields[2] 是裸代码，交易所信息在请求时的 wire 前缀里）。
    return { ...parsed, symbol: toCanonicalTencentSymbol(this.#market, sym) }
  }

  /**
   * 单标的报价行取数（getTicker/getFundamentals/getOrderbook/getActiveBuySnapshot 共用）：
   * **GBK 解码**（响应 charset=GBK，UTF-8 直接乱码）；未知代码返回 `v_pv_none="1"` 之类
   * 短 body（行键匹配不上），按 TRADING_UNSUPPORTED_SYMBOL 上报。返回 `~` 分隔字段数组 +
   * 行情时间戳 + 规范化符号。
   */
  async #fetchQuoteFields(symbol: string): Promise<{ fields: string[]; timestamp: number; sym: string }> {
    const sym = normalizeSymbol(this.#market, symbol)
    const wire = this.#quoteWireCode(sym)
    const rows = await this.#fetchQuoteRows([wire])
    const fields = rows.get(wire.toLowerCase())
    if (fields === undefined) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `Tencent ticker for ${sym}: no row for wire ${wire} (${rows.size} quote rows in payload, unknown symbol?)`,
      )
    }
    return { ...this.#validateQuoteRow(fields, sym), sym }
  }

  /**
   * 最新行情快照（同一报价行含基本面字段，getFundamentals 零额外请求成本地解析）。
   */
  async getTicker(symbol: string): Promise<TencentTicker> {
    const { fields, timestamp, sym } = await this.#fetchQuoteFields(symbol)
    return this.#tickerFrom(fields, timestamp, sym)
  }

  /**
   * 批量最新报价（api 可选契约 getTickers，2026-10-14）：自选栏「每拍 N 只标的 N 次请求」
   * → **一次请求**（`q=` 原生支持逗号列表，实证见 #fetchQuoteRows）。**实现不分片**——
   * 单次请求的标的数由调用方按 MAX_SYMBOLS 裁剪。
   *
   * 契约语义：
   *   - 键 = **入参原字符串**（调用方按它一一对应），值 Ticker.symbol 仍是市场规范形；
   *   - 只返回**确实拿到**的标的：入参不可规范化、上游整行缺席、行字段不足、行内时间读数
   *     坏掉——一律跳过该符号（调用方回落 getTicker 拿它自己的错误码），绝不凑数造假行；
   *   - 整批 HTTP/网络失败 → 抛出（不做 N 次重试）；
   *   - 空入参（或全部入参都不可规范化）→ `{}` 且**不发请求**。
   */
  async getTickers(symbols: string[]): Promise<Record<string, TencentTicker>> {
    const tickers: Record<string, TencentTicker> = {}
    if (symbols.length === 0) return tickers

    // wire（小写归一，查表键）→ 该 wire 的入参与规范形符号：同一 wire 的多个入参
    // （600519 / 600519.SH）共享一行；wire 本体保留原大小写发请求（hk 指数大小写敏感）。
    const byWire = new Map<string, { wire: string; sym: string; inputs: string[] }>()
    for (const symbol of symbols) {
      let sym: string
      try {
        sym = normalizeSymbol(this.#market, symbol)
      } catch {
        continue // 不可规范化：不是「确实拿到」的标的，交给调用方回落 getTicker
      }
      const wire = this.#quoteWireCode(sym)
      const key = wire.toLowerCase()
      const group = byWire.get(key)
      if (group === undefined) byWire.set(key, { wire, sym, inputs: [symbol] })
      else if (!group.inputs.includes(symbol)) group.inputs.push(symbol)
    }
    if (byWire.size === 0) return tickers

    const rows = await this.#fetchQuoteRows([...byWire.values()].map((group) => group.wire))
    for (const [key, group] of byWire) {
      const fields = rows.get(key)
      if (fields === undefined) continue // 未知代码在批量响应里整行缺席 → 跳过，不拖垮整批
      let ticker: TencentTicker
      try {
        const row = this.#validateQuoteRow(fields, group.sym)
        ticker = this.#tickerFrom(row.fields, row.timestamp, group.sym)
      } catch {
        continue // 短行（未知/退市）或行内时间读数坏 → 该符号跳过，整批照常返回
      }
      for (const input of group.inputs) tickers[input] = ticker
    }
    return tickers
  }

  /**
   * 基本面与估值快照：与 getTicker 同一行报价（字段布局见 parseCnFundamentals /
   * parseHkFundamentals 注释），无额外端点。估值字段缺省（指数/ETF）时整字段省略。
   */
  async getFundamentals(symbol: string): Promise<TencentFundamentals> {
    const { fields, timestamp, sym } = await this.#fetchQuoteFields(symbol)
    const parsed = this.#market === 'hk' ? parseHkFundamentals(fields, timestamp) : parseCnFundamentals(fields, timestamp)
    return { ...parsed, symbol: toCanonicalTencentSymbol(this.#market, sym) }
  }

  /**
   * 盘口快照（api 可选契约 getOrderbook，issue #39）：与 getTicker 同一行报价的
   * 五档字段（cn 布局 fields 9-28，见 parseCnOrderbook）。**hk 结构性不支持**——
   * r_hk 行买卖档位全 0（2026-08-31 实测，parseHkTicker 注释），直接按
   * TRADING_NOT_IMPLEMENTED 上报，桥层转 ok:false（前端显示「未提供」而非空盘口）。
   */
  async getOrderbook(symbol: string): Promise<Orderbook> {
    if (this.#market === 'hk') {
      throw new TradingServiceError(
        'TRADING_NOT_IMPLEMENTED',
        'Tencent HK orderbook: r_hk quote row carries no five-level depth (all-zero fields) — orderbook unavailable for hk',
      )
    }
    const { fields, timestamp, sym } = await this.#fetchQuoteFields(symbol)
    const parsed = parseCnOrderbook(fields, timestamp)
    return { ...parsed, symbol: toCanonicalTencentSymbol(this.#market, sym) }
  }

  /**
   * 当日累计主动买盘快照（api 可选契约 getActiveBuySnapshot，2026-10-13）：与 getTicker
   * 同一行报价的外盘/内盘字段（cn 布局 6/7/8/30/47/48，见 parseCnActiveBuySnapshot 注释），
   * 每次调用仍独立发起一次报价请求，不复用 getTicker 的应答。**hk 结构性不支持**——r_hk 行的 7/8 位恒为 0（2026-10-13 实测
   * spikes/impl-active-buy/r2-raw-hk00700.gbk），直接按 TRADING_NOT_IMPLEMENTED 上报；
   * 服务层 hk 实例上该方法本身缺席（能力自然缺席，消费方按「方法是否存在」判降级）。
   */
  async getActiveBuySnapshot(symbol: string): Promise<ActiveBuySnapshot> {
    if (this.#market === 'hk') {
      throw new TradingServiceError(
        'TRADING_NOT_IMPLEMENTED',
        'Tencent HK active-buy: r_hk quote row carries no outer/inner (active buy/sell) fields (7/8 always 0) — unavailable for hk',
      )
    }
    const { fields, sym } = await this.#fetchQuoteFields(symbol)
    return parseCnActiveBuySnapshot(
      fields,
      toCanonicalTencentSymbol('cn', sym),
      isoWithOffset(this.#now(), 'Asia/Shanghai'),
    )
  }

  /** K 线能力声明（api 可选契约）：本实例市场的诚实 (周期, 请求深度) 清单，口径见 tencentKlineCapabilities。 */
  klineCapabilities(): readonly KlineCapability[] {
    return tencentKlineCapabilities(this.#market)
  }

  /**
   * K 线（日/周/月走 fqkline 前权 qfq；5m/30m 分钟线走 mkline 端点）。
   * 港股 mkline 端点不支持分钟线，请求 5m/30m 会抛出 TRADING_UNSUPPORTED_INTERVAL。
   */
  async getKlines(symbol: string, interval: Interval, limit?: number): Promise<Kline[]> {
    const sym = normalizeSymbol(this.#market, symbol)
    const mapping = INTERVAL_TO_TENCENT.get(interval)
    if (!mapping) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_INTERVAL',
        `Tencent klines: unsupported interval ${String(interval)} — supported: ${INTERVAL_VOCABULARY.join('/')}`,
      )
    }
    if (mapping.type === 'mkline' && this.#market === 'hk') {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_INTERVAL',
        `Tencent klines: Hong Kong market (HKEX) does not support minute intervals (${interval}) via public endpoint`,
      )
    }
    const count = typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, TENCENT_KLINE_MAX_BARS) : 100
    const wire = this.#klineWireCode(sym)
    const isMinute = mapping.type === 'mkline'
    const klinePath = this.#market === 'hk' ? 'appstock/app/hkfqkline/get' : 'appstock/app/fqkline/get'
    const urlFor = (base: string) => isMinute
      ? `${base}/appstock/app/kline/mkline?param=${wire},${mapping.tf},,${count}`
      : `${base}/${klinePath}?param=${wire},${mapping.tf},,,${count},qfq`
    const bases = isMinute ? [this.#mklineBaseUrl] : this.#klineBaseUrls

    let payload: TencentKlinePayload | undefined
    let lastError: TradingServiceError | undefined
    for (const base of bases) {
      const attempt = await this.#requestKlinePayload(urlFor(base), sym)
      if (attempt.ok) {
        payload = attempt.payload
        break
      }
      lastError = attempt.error
      if (!attempt.retryable) throw attempt.error
    }
    if (payload === undefined) {
      const error = lastError ?? new TradingServiceError('TRADING_NETWORK', `Tencent klines for ${sym}: no kline host configured`)
      // 只注入了单域名时错误原样上抛（消息与单域名实现一致）；走回退链时补一句链上事实，便于归因。
      if (bases.length === 1) throw error
      throw new TradingServiceError(
        error.code,
        `Tencent klines for ${sym}: all kline hosts failed (${bases.join(' -> ')}); last: ${error.message}`,
        error,
      )
    }
    if (payload.code !== 0) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `Tencent klines for ${sym}: upstream code=${String(payload.code)} msg=${JSON.stringify(payload.msg ?? '')}`,
      )
    }
    const market = payload.data?.[wire]
    // 键回落（2026-08-31 实证，美团 hk03690）：hkfqkline 对无前权事件的代码返回
    // `day`（未复权）而非 `qfqday`——优先 qfq 键，缺失回落裸键，行结构相同。
    const raw = isMinute
      ? market?.[mapping.key]
      : (market?.[mapping.key] ?? market?.[mapping.tf])
    const rows = Array.isArray(raw) ? raw : undefined
    if (rows === undefined || rows.length === 0) {
      throw new TradingServiceError(
        'TRADING_UNSUPPORTED_SYMBOL',
        `Tencent klines for ${sym}: no ${mapping.key}/${mapping.tf} rows (unknown/delisted symbol?)`,
      )
    }
    const klines: Kline[] = []
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== 'string') {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tencent klines for ${sym}: malformed row ${JSON.stringify(row)?.slice(0, 80)}`)
      }
      const open = num(String(row[1]))
      const close = num(String(row[2]))
      const high = num(String(row[3]))
      const low = num(String(row[4]))
      const volume = num(String(row[5]))
      if (open === undefined || close === undefined || high === undefined || low === undefined) {
        throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tencent klines for ${sym}: malformed row values ${JSON.stringify(row).slice(0, 80)}`)
      }
      const openTime = isMinute ? minuteKlineTimeToEpochMs(row[0]) : klineDateToEpochMs(row[0])
      klines.push({
        openTime,
        open,
        high,
        low,
        close,
        volume: volume ?? 0,
        closeTime: openTime + mapping.durationMs - 1,
      })
    }
    return klines
  }

  /**
   * 智能联想标的列表（按名称、代码、拼音模糊检索）：
   * 接入腾讯证券智能联想端点，统一格式输出标的 symbol、name、pinyin。
   */
  async listInstruments(query?: string): Promise<Array<{ symbol: string; name: string; pinyin?: string }>> {
    const q = query?.trim()
    if (!q) return []
    const url = `${this.#searchBaseUrl}/s3/?t=all&q=${encodeURIComponent(q)}`
    let text = ''
    try {
      const res = await this.#fetchImpl(url)
      if (!res.ok) return []
      text = await res.text()
    } catch {
      return []
    }
    const m = /v_hint="([^"]*)"/.exec(text)
    if (!m || !m[1]) return []
    const rawContent = m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    const records = rawContent.split('^').filter(Boolean)
    const results: Array<{ symbol: string; name: string; pinyin?: string }> = []
    const seen = new Set<string>()

    for (const rec of records) {
      const parts = rec.split('~')
      if (parts.length < 3) continue
      const [mkt, code, name, pinyin] = parts
      if (!mkt || !code || !name) continue

      let canonicalSymbol = ''
      if (this.#market === 'cn') {
        const lowerMkt = mkt.toLowerCase()
        if (lowerMkt === 'sh') {
          canonicalSymbol = `${code}.SH`
        } else if (lowerMkt === 'sz') {
          canonicalSymbol = `${code}.SZ`
        } else if (lowerMkt === 'bj') {
          canonicalSymbol = `${code}.BJ`
        } else {
          continue
        }
      } else if (this.#market === 'hk') {
        if (mkt.toLowerCase() === 'hk') {
          canonicalSymbol = /^\d+$/.test(code) ? `${code.padStart(5, '0')}.HK` : `${code.toUpperCase()}.HK`
        } else {
          continue
        }
      } else {
        continue
      }

      if (seen.has(canonicalSymbol)) continue
      seen.add(canonicalSymbol)
      results.push({
        symbol: canonicalSymbol,
        name,
        ...(pinyin ? { pinyin: pinyin.toUpperCase() } : {}),
      })
    }

    return results
  }
}
