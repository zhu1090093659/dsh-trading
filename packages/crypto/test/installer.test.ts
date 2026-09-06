import { describe, expect, it } from 'vitest'
import { getPresetContribution, apply } from '../src/index.js'

describe('market capability contribution', () => {
  it('exports connector realms and kit, never the old persona', async () => {
    const result = await getPresetContribution()
    expect(result.market).toBe('crypto')
    expect(result.traderRows).toMatch(/^- id: dsh-trading-crypto-connector\n/)
    expect(result.traderRows).toContain('tradingCryptoMarketData: true')
    expect(result.traderRows).toContain("name: '@dshtrading/kit-crypto'")
    expect(result.traderRows).not.toContain('name: \'@deepseek-ai/dsh-persona\'')
  })
  it('keeps the legacy host row inert (base is the only writer)', () => {
    expect(apply()).toBeUndefined()
  })
})
