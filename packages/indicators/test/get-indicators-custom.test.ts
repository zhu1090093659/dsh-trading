/**
 * <market>_get_indicators 自定义指标解析（issue #33）：未知 id → custom store
 * 记录 → 校验+编译 → 计算输出；无 store / 记录缺失 / 校验失败的可读错误。
 */
import { describe, expect, it } from 'vitest'
import { createMemoryCustomIndicatorStore } from '../src/index.js'
import { createGetIndicatorsTool } from '../src/tool.js'
import type { Kline } from '../src/types.js'

const BARS: Kline[] = Array.from({ length: 40 }, (_, i) => ({
  openTime: 1700000000000 + i * 60_000,
  open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000,
}))

const CUSTOM_SOURCE = `(bars) => [{ key: 'close_copy', kind: 'line', color: '#ff0000', values: bars.map(b => b.close) }]`

function fakeMarketData() {
  return { getKlines: async () => BARS }
}

describe('createGetIndicatorsTool 自定义指标支持（issue #33）', () => {
  it('未知 id + custom store 有记录 → 用自定义定义计算', async () => {
    const store = createMemoryCustomIndicatorStore([{
      id: 'my_close', title: '收盘复制', pane: 'sub', params: [],
      computeSource: CUSTOM_SOURCE, createdAt: 1,
    }])
    const tool = createGetIndicatorsTool({ marketData: fakeMarketData(), market: 'us', customStore: store })
    const out = String(await tool.execute({ symbol: 'AAPL', interval: '1d', indicators: 'my_close' }))
    expect(out).toContain('close_copy')       // 自定义定义的输出 key
    expect(out).toContain('latest=139.5')     // 最新收盘价 100.5 + 39
    expect(out).not.toContain('unknown indicator id')
  })

  it('未知 id 且无 custom store → 报错并列举预置词汇', async () => {
    const tool = createGetIndicatorsTool({ marketData: fakeMarketData(), market: 'us' })
    await expect(tool.execute({ symbol: 'AAPL', interval: '1d', indicators: 'nope' }))
      .rejects.toThrow(/available presets/)
  })

  it('custom store 缺记录 → 提示先经 indicator_author 创作', async () => {
    const store = createMemoryCustomIndicatorStore()
    const tool = createGetIndicatorsTool({ marketData: fakeMarketData(), market: 'us', customStore: store })
    await expect(tool.execute({ symbol: 'AAPL', interval: '1d', indicators: 'ghost' }))
      .rejects.toThrow(/indicator_author first/)
  })
})
