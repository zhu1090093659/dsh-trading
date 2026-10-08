/**
 * 形态/资产类别展示判据（2026-10-08 加密永续与 TradFi 永续 P5）。
 *
 * 事实只有一个家：形态由规范符号后缀裁决（`instrumentFormOf` 在 `@dshtrading/api` 是唯一
 * 实现，docs/guides/symbol-vocabulary.md），行上的 `form` 只是名册/wire 带来的元数据，
 * 两者不一致时**以符号为准**（符号是形态的唯一载体，展示层不允许漂移）；
 * 资产类别则相反——它**不可能**从符号推断（OKX `SPX` 是迷因币 SPX6900、标普 500 是
 * `US500`），所以只信显式元数据或合并字典里来自交易所名册的那一份。
 *
 * 展示词的落点：本模块只产出 locale 键（`MarketLocaleKey`），文案家在 locales.ts。
 */
import { instrumentFormOf, type InstrumentAssetClass, type InstrumentForm } from '@dshtrading/api'
import type { MarketLocaleKey } from './contract.ts'
import { getMergedCatalog, type CatalogMarket } from './symbol-catalog.ts'
import type { MarketId } from './types.ts'

/** 带形态/资产类别的最小行形状（自选行、联想条目、选中标的通用）。 */
export interface InstrumentMetaSource {
  symbol: string
  form?: InstrumentForm
  assetClass?: InstrumentAssetClass
}

/**
 * 添加到自选时随行直落的元数据（可选值显式允许 `undefined`：tsconfig 开了
 * `exactOptionalPropertyTypes`，调用点从字典条目取到的值本来就是「有或未定义」）。
 */
export interface InstrumentMeta {
  form?: InstrumentForm | undefined
  assetClass?: InstrumentAssetClass | undefined
}

/** 自选行/选中标的的形态：符号后缀是唯一载体，显式 `form` 不参与（防展示漂移）。 */
export function rowForm(row: Pick<InstrumentMetaSource, 'symbol'>): InstrumentForm {
  return instrumentFormOf(row.symbol)
}

/** 检索条目的形态：显式值优先，缺省回落符号判据（与 router/catalog 的 catalogFormOf 同款）。 */
export function entryForm(entry: InstrumentMetaSource): InstrumentForm {
  return entry.form ?? instrumentFormOf(entry.symbol)
}

/**
 * 资产类别：显式值优先；缺省时在合并字典（静态冷启动 ∪ 交易所名册）里按符号查——
 * 查不到即 `undefined`（未知 ≠ 现货，也 ≠ 加密，按未知渲染）。
 */
export function resolveAssetClass(market: MarketId, source: InstrumentMetaSource): InstrumentAssetClass | undefined {
  if (source.assetClass !== undefined) return source.assetClass
  const upper = source.symbol.toUpperCase()
  const entry = getMergedCatalog(market as CatalogMarket).find(item => item.symbol.toUpperCase() === upper)
  return entry?.assetClass
}

/** TradFi 永续 = 永续形态 + 非加密资产类别（股票/大宗/指数；交易所合成合约）。 */
export function isTradFiPerp(form: InstrumentForm, assetClass: InstrumentAssetClass | undefined): boolean {
  return form === 'perp' && assetClass !== undefined && assetClass !== 'crypto'
}

/**
 * 添加到自选时随行直落的元数据：**现货不落 `form`**（缺省即现货，落键只会让存量行形状
 * 与既有断言无谓变化，违背「现货路径零回归」）；资产类别有值就落（它不可能从符号推断）。
 */
export function entryMeta(market: MarketId, entry: InstrumentMetaSource): InstrumentMeta {
  const form = entryForm(entry)
  const assetClass = resolveAssetClass(market, entry)
  return {
    ...(form === 'perp' ? { form } : {}),
    ...(assetClass !== undefined ? { assetClass } : {}),
  }
}

/**
 * 行/联想条目的形态徽标键：现货不挂徽标（默认形态，现货行渲染零变化）；
 * 永续按资产类别细分（加密=永续、股票/大宗/指数=TradFi 合约）；资产类别未知 → 只报「永续」。
 */
export function formBadgeKey(source: InstrumentMetaSource, assetClass: InstrumentAssetClass | undefined): MarketLocaleKey | null {
  const form = entryForm(source)
  if (form !== 'perp') return null
  if (assetClass === 'equity') return 'form.perpEquity'
  if (assetClass === 'commodity') return 'form.perpCommodity'
  if (assetClass === 'index') return 'form.perpIndex'
  return 'form.perp'
}
