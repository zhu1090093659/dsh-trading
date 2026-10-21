/**
 * tool-index 单测：索引层必须与真实注册面一致。
 *
 * 核心契约（防漂移）：`buildToolIndex` 拿到的 schema 列表，分族后每个工具
 * 都必须出现且只出现一次；索引总数 === 注册总数。这正是把它做成「现读现算」
 * 而不是硬编码清单的理由——硬编码清单迟早会与真实工具面脱节。
 */
import { describe, expect, it } from 'vitest'
import { buildToolIndex, FAMILIES } from '../src/tool-index.ts'

const schemas = [
  { name: 'cn_get_ticker', description: 'Latest A-share snapshot.' },
  { name: 'cn_get_klines', description: 'Recent OHLCV candles.' },
  { name: 'holdings_list', description: 'Read-only view of the holdings ledger.' },
  { name: 'strategy_backtest', description: 'Backtest a strategy.' },
  { name: 'flash_search', description: 'Keyword search over flash headlines.' },
  { name: 'fx_get', description: 'Read-only FX rate snapshot.' },
]

describe('buildToolIndex', () => {
  it('用户：覆盖全部注册工具且不重复（防漂移契约）', () => {
    // Given 六个真实形态的工具 schema
    // When 构建索引
    // Then 每个工具都出现且只出现一次，索引总数等于注册总数
    const out = buildToolIndex(schemas)
    expect(out.total).toBe(schemas.length)
    expect(out.matched).toBe(schemas.length)
    const names = out.families.flatMap(f => f.tools.map(t => t.name))
    expect([...names].sort()).toEqual(schemas.map(s => s.name).sort())
    expect(new Set(names).size).toBe(names.length)
  })

  it('用户：按前缀分族并挂上族级场景说明', () => {
    // Given 六个工具 schema，其中两个属于 A 股族
    // When 构建索引并取 A 股族
    // Then 族计数正确，且场景说明来自 FAMILIES 定义
    const out = buildToolIndex(schemas)
    const cn = out.families.find(f => f.family === 'cn')
    expect(cn?.count).toBe(2)
    expect(cn?.label).toBe(FAMILIES.cn.label)
    expect(cn?.whenToUse).toBe(FAMILIES.cn.whenToUse)
  })

  it('用户：query 命中场景词时返回整族', () => {
    // Given 场景词「持仓」
    // When 带 query 构建索引
    // Then 只留下持仓族
    const out = buildToolIndex(schemas, '持仓')
    expect(out.families.map(f => f.family)).toContain('holdings')
    expect(out.families.every(f => f.family === 'holdings')).toBe(true)
  })

  it('用户：query 命中工具名时只返回命中的工具', () => {
    // Given 工具名片段 klines
    // When 带 query 构建索引
    // Then 只返回命中的那一个工具
    const out = buildToolIndex(schemas, 'klines')
    const cn = out.families.find(f => f.family === 'cn')
    expect(cn?.tools.map(t => t.name)).toEqual(['cn_get_klines'])
    expect(cn?.count).toBe(1)
  })

  it('用户：family 参数只打开单族', () => {
    // Given family 指定策略族
    // When 构建索引
    // Then 只剩这一个族
    const out = buildToolIndex(schemas, undefined, 'strategy')
    expect(out.families).toHaveLength(1)
    expect(out.families[0].family).toBe('strategy')
  })

  it('用户：未登记族回落为原前缀而不是报错', () => {
    // Given 前缀未登记的工具 zzz_unknown
    // When 构建索引
    // Then 族名回落为前缀本身，场景说明为空
    const out = buildToolIndex([{ name: 'zzz_unknown', description: 'x' }])
    expect(out.families[0].label).toBe('zzz')
    expect(out.families[0].whenToUse).toBe('')
  })

  it('用户：brief 截到第一句并限长', () => {
    // Given 两句话的描述
    // When 构建索引
    // Then brief 只保留第一句
    const out = buildToolIndex([{ name: 'a_b', description: 'First sentence here. Second one.' }])
    expect(out.families[0].tools[0].brief).toBe('First sentence here.')
  })
})
