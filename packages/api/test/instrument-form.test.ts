/**
 * api 形态契约单测（2026-10-08 加密永续与 TradFi 永续 P1）：
 * 规范符号后缀 → 形态的裁决、`-SWAP` 词汇常量的唯一性，以及 InstrumentRef 的
 * 向后兼容形状（老 `{ symbol, name? }` 行仍合法，缺省 = 现货）。
 * 类型面用「联合穷举 + 赋值」断言：InstrumentForm 增删字面量时这里编译不过。
 */
import { describe, expect, it } from 'vitest'
import { instrumentFormOf, SWAP_SYMBOL_SUFFIX } from '@dshtrading/api'
import type { InstrumentAssetClass, InstrumentContract, InstrumentForm, InstrumentRef } from '@dshtrading/api'

/** 形态联合穷举：InstrumentForm 增删字面量即编译失败（类型面的断言，不是文档）。 */
const FORM_MEMBERS: Record<InstrumentForm, true> = { spot: true, perp: true }
/** 资产类别联合穷举：InstrumentAssetClass 增删字面量即编译失败。 */
const ASSET_CLASS_MEMBERS: Record<InstrumentAssetClass, true> = {
  crypto: true,
  equity: true,
  commodity: true,
  index: true,
}

describe('标的形态契约（api）', () => {
  it('用户对规范符号取形态：-SWAP 后缀为永续、裸形为现货', () => {
    // Given: 同一 base/quote 的现货与永续规范形
    const spot = 'BTCUSDT'
    const perp = 'BTCUSDT-SWAP'
    // When: 消费方按规范符号裁决形态
    const spotForm = instrumentFormOf(spot)
    const perpForm = instrumentFormOf(perp)
    // Then: 后缀决定形态，且与 InstrumentForm 的字面量一致
    expect(spotForm).toBe('spot')
    expect(perpForm).toBe('perp')
    expect(FORM_MEMBERS[spotForm]).toBe(true)
    expect(FORM_MEMBERS[perpForm]).toBe(true)
    expect(SWAP_SYMBOL_SUFFIX).toBe('-SWAP')
  })

  it('用户传 TradFi 合约与小写原生形时仍判断为永续', () => {
    // Given: OKX 路由下的 TradFi 永续与用户手输的小写形
    const tradFiPerp = 'TSLAUSDT-SWAP'
    const lowercasePerp = ' xauusdt-swap '
    const nonSwapWithSwapInside = 'SWAPUSDT'
    // When: 消费方按规范符号裁决形态
    const tradFiForm = instrumentFormOf(tradFiPerp)
    const lowercaseForm = instrumentFormOf(lowercasePerp)
    const insideForm = instrumentFormOf(nonSwapWithSwapInside)
    // Then: 只看后缀，不做字面包含匹配
    expect(tradFiForm).toBe('perp')
    expect(lowercaseForm).toBe('perp')
    expect(insideForm).toBe('spot')
  })

  it('用户读取老名册行时形态度量缺省为未标注而不破坏兼容', () => {
    // Given: 只实现现货的连接器返回的老形状行，与 crypto 连接器返回的永续行
    const legacyRow: InstrumentRef = { symbol: 'BTCUSDT', name: 'Bitcoin' }
    const contract: InstrumentContract = {
      multiplier: 0.01,
      tickSize: 0.1,
      lotSize: 0.01,
      maxLeverage: 20,
      settleCcy: 'USDT',
    }
    const perpRow: InstrumentRef = {
      symbol: 'TSLAUSDT-SWAP',
      form: 'perp',
      assetClass: 'equity',
      contract,
    }
    // When: 消费方按同一 InstrumentRef 读取两行
    const rows: InstrumentRef[] = [legacyRow, perpRow]
    // Then: 缺省行不算永续（form 未标注），永续行的资产类别与合约元数据原样可见
    expect(rows).toHaveLength(2)
    expect(rows[0]?.form).toBeUndefined()
    expect(instrumentFormOf(rows[0]?.symbol ?? '')).toBe('spot')
    expect(rows[1]?.form).toBe('perp')
    expect(rows[1]?.assetClass).toBe('equity')
    expect(ASSET_CLASS_MEMBERS[rows[1]?.assetClass ?? 'crypto']).toBe(true)
    expect(rows[1]?.contract?.settleCcy).toBe('USDT')
    expect(rows[1]?.contract?.maxLeverage).toBe(20)
  })
})
