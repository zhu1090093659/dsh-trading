import { describe, expect, it } from 'vitest'
import { createMemoryHoldingsStore } from '../src/store-memory.ts'
import { createHoldingsListTool, createHoldingsStageTool } from '../src/tool.ts'

describe('Holdings Agent Tools', () => {
  it('holdings_stage 暂存截图解析结果并回显提醒文案', async () => {
    const store = createMemoryHoldingsStore()
    const written: string[][] = []
    const tool = createHoldingsStageTool(store, { onWritten: ids => written.push(ids) })
    const result = await (tool as any).execute({
      itemsJson: JSON.stringify([
        { market: 'us', symbol: 'AAPL', size: 10, entryPrice: 178.5, name: '苹果', account: '富途' },
        { market: 'crypto', symbol: 'BTCUSDT', size: 0.5 },
      ]),
    })
    expect(result).toContain('已暂存 2 条持仓到待确认区')
    expect(result).toContain('资产面板确认入账')
    expect(result).toContain('AAPL')
    expect(result).toContain('BTCUSDT')
    const snap = await store.snapshot()
    expect(snap.revision).toBe(1)
    expect(snap.staged).toHaveLength(2)
    // 写入侧推导：crypto → USDT / 默认账户 / real
    const btc = snap.staged.find(h => h.symbol === 'BTCUSDT')
    expect(btc).toMatchObject({ currency: 'USDT', account: '默认账户', kind: 'real' })
    const aapl = snap.staged.find(h => h.symbol === 'AAPL')
    expect(aapl).toMatchObject({ currency: 'USD', account: '富途', name: '苹果', entryPrice: 178.5 })
    expect(written).toHaveLength(1)
    expect(written[0]).toHaveLength(2)
  })

  it('holdings_stage 参数为 connector 词汇的 cn 市场：推导 CNY', async () => {
    const store = createMemoryHoldingsStore()
    const tool = createHoldingsStageTool(store)
    const result = await (tool as any).execute({
      itemsJson: JSON.stringify([{ market: 'cn', symbol: '002714.SZ', size: 100 }]),
    })
    expect(result).toContain('已暂存 1 条')
    expect((await store.snapshot()).staged[0]?.currency).toBe('CNY')
  })

  it('holdings_stage 校验拒绝负 size（整体拒绝，不落半解析暂存）', async () => {
    const store = createMemoryHoldingsStore()
    const written: string[][] = []
    const tool = createHoldingsStageTool(store, { onWritten: ids => written.push(ids) })
    const result = await (tool as any).execute({
      itemsJson: JSON.stringify([
        { market: 'us', symbol: 'AAPL', size: 10 },
        { market: 'us', symbol: 'TSLA', size: -3 },
      ]),
    })
    expect(result).toContain('校验失败')
    expect(result).toContain('未暂存任何条目')
    expect(result).toContain('size')
    expect(result).toContain('items[1]')
    const snap = await store.snapshot()
    expect(snap.staged).toHaveLength(0)
    expect(snap.revision).toBe(0)
    expect(written).toHaveLength(0)
  })

  it('holdings_stage 拒绝非法 market / 空 symbol / 非法 kind', async () => {
    const store = createMemoryHoldingsStore()
    const tool = createHoldingsStageTool(store)
    const result = await (tool as any).execute({
      itemsJson: JSON.stringify([
        { market: 'moon', symbol: 'X', size: 1 },
        { market: 'us', symbol: '  ', size: 1 },
        { market: 'hk', symbol: '00700.HK', size: 1, kind: 'fake' },
      ]),
    })
    expect(result).toContain('校验失败')
    expect(result).toContain('market')
    expect(result).toContain('symbol')
    expect(result).toContain('kind')
    expect((await store.snapshot()).staged).toHaveLength(0)
  })

  it('holdings_stage 拒绝空数组与坏 JSON', async () => {
    const store = createMemoryHoldingsStore()
    const tool = createHoldingsStageTool(store)
    const empty = await (tool as any).execute({ itemsJson: '[]' })
    expect(empty).toContain('非空')
    const bad = await (tool as any).execute({ itemsJson: '{oops' })
    expect(bad).toContain('参数解析失败')
    // 缺必填参数由 defineTool 参数 schema 层拒绝（ToolArgsError，不进 execute 主体）
    await expect((tool as any).execute({})).rejects.toThrow(/itemsJson/)
    expect((await store.snapshot()).staged).toHaveLength(0)
  })

  it('holdings_stage 数字字段容忍数字字符串（"0.5" → 0.5）', async () => {
    const store = createMemoryHoldingsStore()
    const tool = createHoldingsStageTool(store)
    const result = await (tool as any).execute({
      itemsJson: JSON.stringify([{ market: 'crypto', symbol: 'ETHUSDT', size: '0.5', entryPrice: '3200.5' }]),
    })
    expect(result).toContain('已暂存 1 条')
    const h = (await store.snapshot()).staged[0]
    expect(h?.size).toBe(0.5)
    expect(h?.entryPrice).toBe(3200.5)
  })

  it('holdings_list 空台账输出两区为空', async () => {
    const store = createMemoryHoldingsStore()
    const tool = createHoldingsListTool(store)
    const result = await (tool as any).execute({})
    expect(result).toContain('revision 0')
    expect(result).toContain('待确认区 0 条 / 正式持仓 0 条')
    expect(result).toContain('待确认区：空')
    expect(result).toContain('正式持仓：空')
  })

  it('holdings_list 输出两区概要与条目行', async () => {
    const store = createMemoryHoldingsStore()
    const stageTool = createHoldingsStageTool(store)
    await (stageTool as any).execute({
      itemsJson: JSON.stringify([{ market: 'us', symbol: 'AAPL', size: 10, account: '富途' }]),
    })
    await store.add({ market: 'crypto', symbol: 'BTCUSDT', size: 0.5, account: '币安' })
    const listTool = createHoldingsListTool(store)
    const result = await (listTool as any).execute({})
    expect(result).toContain('待确认区 1 条 / 正式持仓 1 条')
    expect(result).toContain('AAPL')
    expect(result).toContain('富途')
    expect(result).toContain('BTCUSDT')
    expect(result).toContain('币安')
    expect(result).toContain('revision 2')
  })
})
