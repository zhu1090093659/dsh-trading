/**
 * 形态/资产类别展示判据单测（2026-10-08 加密永续与 TradFi 永续 P5）。
 *
 * 覆盖判据层（不 mount 组件）：
 * - 形态由规范符号后缀裁决（`-SWAP` = 永续），条目面显式 `form` 优先；
 * - 资产类别只信显式元数据或合并字典里来自交易所名册的那一份——**禁止按符号猜**
 *   （OKX `SPX` 是迷因币 SPX6900、标普 500 是 `US500`，是本仓的判据反例）；
 * - 徽标键：现货不挂标；永续按资产类别细分；
 * - TradFi 认定：永续 + 非加密资产类别，未知资产类别不声称 TradFi；
 * - 落库元数据：现货不落 `form`（缺省即现货），资产类别有值才落。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  entryForm,
  entryMeta,
  formBadgeKey,
  isTradFiPerp,
  resolveAssetClass,
  rowForm,
} from '../src/client/instrument-meta.ts'
import { setDynamicCatalog } from '../src/client/symbol-catalog.ts'

afterEach(() => {
  // 动态字典是模块级单例：每个用例后清空，避免跨用例串味（合并字典回落静态表）。
  setDynamicCatalog('crypto', [])
})

describe('instrument-meta 形态与资产类别判据', () => {
  it('用户查看自选行或联想条目时，永续与现货由符号后缀裁决', () => {
    // Given: 一行永续与一行现货的规范符号
    // When: 分别按行判据与条目判据读形态
    const perpRow = rowForm({ symbol: 'BTCUSDT-SWAP' })
    const spotRow = rowForm({ symbol: 'BTCUSDT' })
    const perpEntry = entryForm({ symbol: 'TSLAUSDT-SWAP' })
    const explicitEntry = entryForm({ symbol: 'BTCUSDT', form: 'perp' })
    // Then: 带 -SWAP 为永续、不带为现货；条目面显式 form 优先（与 catalogFormOf 同款）
    expect(perpRow).toBe('perp')
    expect(spotRow).toBe('spot')
    expect(perpEntry).toBe('perp')
    expect(explicitEntry).toBe('perp')
  })

  it('用户查看永续行的形态徽标时，按资产类别细分为加密永续/股票/大宗/指数合约', () => {
    // Given: 同一永续形态下的四种资产类别
    // When: 逐类取徽标键
    // Then: 加密=永续、其余=TradFi 合约细分标
    expect(formBadgeKey({ symbol: 'BTCUSDT-SWAP' }, 'crypto')).toBe('form.perp')
    expect(formBadgeKey({ symbol: 'TSLAUSDT-SWAP' }, 'equity')).toBe('form.perpEquity')
    expect(formBadgeKey({ symbol: 'XAUUSDT-SWAP' }, 'commodity')).toBe('form.perpCommodity')
    expect(formBadgeKey({ symbol: 'US500USDT-SWAP' }, 'index')).toBe('form.perpIndex')
  })

  it('用户查看现货行时没有形态徽标（现货是默认形态，渲染零变化）', () => {
    // Given: 美股现货与加密现货
    // When: 取徽标键
    const equity = formBadgeKey({ symbol: 'AAPL' }, 'equity')
    const crypto = formBadgeKey({ symbol: 'BTCUSDT' }, 'crypto')
    // Then: 两者都不挂标
    expect(equity).toBeNull()
    expect(crypto).toBeNull()
  })

  it('用户查看资产类别未知的永续时，徽标只报永续且不声称 TradFi（未知按未知渲染）', () => {
    // Given: 一个不在字典/名册里的永续符号
    // When: 解析资产类别与徽标，并做 TradFi 认定
    const assetClass = resolveAssetClass('crypto', { symbol: 'NEWUSDT-SWAP' })
    const badge = formBadgeKey({ symbol: 'NEWUSDT-SWAP' }, assetClass)
    // Then: 资产类别留空、徽标退回「永续」、TradFi 判定为否（不按符号猜）
    expect(assetClass).toBeUndefined()
    expect(badge).toBe('form.perp')
    expect(isTradFiPerp('perp', assetClass)).toBe(false)
  })

  it('用户搜索 TradFi 合约时，资产类别取自交易所名册，且 SPX 迷因币不被误标为指数', () => {
    // Given: 交易所名册（动态字典）注入了一行指数永续（符号不在静态冷启动字典里）
    setDynamicCatalog('crypto', [{ symbol: 'TESTINDEXUSDT-SWAP', name: '测试指数 永续', assetClass: 'index' }])
    // When: 按符号解析资产类别（大小写不敏感）
    const resolved = resolveAssetClass('crypto', { symbol: 'testindexusdt-swap' })
    // Then: 归属来自名册；而字面像指数的 SPX 迷因币查不到归属、保持留空
    expect(resolved).toBe('index')
    expect(isTradFiPerp('perp', resolved)).toBe(true)
    expect(resolveAssetClass('crypto', { symbol: 'SPXUSDT-SWAP' })).toBeUndefined()
  })

  it('用户把标的加入自选时，现货不落形态键、永续落形态与已知资产类别', () => {
    // Given: 加密现货、带完整元数据的 TradFi 永续、只有形态的永续
    // When: 生成随行直落的元数据
    const spot = entryMeta('crypto', { symbol: 'BTCUSDT' })
    const tradFi = entryMeta('crypto', { symbol: 'TSLAUSDT-SWAP', form: 'perp', assetClass: 'equity' })
    const unknownClass = entryMeta('crypto', { symbol: 'NEWUSDT-SWAP' })
    // Then: 现货两键都不落（缺省即现货）；永续落 form，资产类别有值才落
    expect(spot).toEqual({})
    expect(tradFi).toEqual({ form: 'perp', assetClass: 'equity' })
    expect(unknownClass).toEqual({ form: 'perp' })
  })
})
