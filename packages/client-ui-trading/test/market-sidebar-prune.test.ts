/**
 * MarketSidebar 行情 Map 有界化：长生命周期桌面宿主下，prices/series 只保有
 * 当前自选全集，移出自选的标的键必须被回收（否则随会话内自选变更单调增长）。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { pruneRecord } from '../src/client/MarketSidebar.tsx'

describe('pruneRecord（行情 Map 有界化）', () => {
  it('丢弃不在 live 键集里的条目', () => {
    const current = { 'us:AAPL': 1, 'us:MSFT': 2, 'cn:600519': 3 }
    const next = pruneRecord(current, new Set(['us:AAPL']))
    expect(Object.keys(next)).toEqual(['us:AAPL'])
    expect(next['us:AAPL']).toBe(1)
  })

  it('无条目被删时返回原引用（不触发多余重渲染）', () => {
    const current = { 'us:AAPL': 1 }
    expect(pruneRecord(current, new Set(['us:AAPL']))).toBe(current)
  })

  it('空 live 键集清空全部条目', () => {
    expect(pruneRecord({ a: 1, b: 2 }, new Set<string>())).toEqual({})
  })
})
