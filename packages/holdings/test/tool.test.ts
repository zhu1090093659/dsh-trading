import { describe, expect, it } from 'vitest'
import { createMemoryHoldingsStore } from '../src/store-memory.ts'
import {
  createHoldingsAddTool,
  createHoldingsConfirmTool,
  createHoldingsDiscardTool,
  createHoldingsListTool,
  createHoldingsRemoveTool,
  createHoldingsStageTool,
  createHoldingsUpdateTool,
} from '../src/tool.ts'

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

describe('Holdings Ledger Write Tools', () => {
  async function seedStaged(store: ReturnType<typeof createMemoryHoldingsStore>) {
    const stage = createHoldingsStageTool(store)
    await (stage as any).execute({
      itemsJson: JSON.stringify([
        { market: 'cn', symbol: '159869.SZ', name: '游戏ETF华夏', size: 5000, entryPrice: 1.023, account: '国金证券' },
        { market: 'us', symbol: 'AAPL', size: 10, account: '富途' },
      ]),
    })
    return (await store.snapshot()).staged.map(h => h.id)
  }

  it('holdings_confirm 确认入账（带 editsJson 修订）并回显', async () => {
    const store = createMemoryHoldingsStore()
    const [gameId, aaplId] = await seedStaged(store)
    const written: string[][] = []
    const tool = createHoldingsConfirmTool(store, { onWritten: ids => written.push(ids) })
    const result = await (tool as any).execute({
      idsJson: [gameId!],
      editsJson: JSON.stringify({ [gameId!]: { size: 5000, entryPrice: 1.023, note: '用户确认' } }),
    })
    expect(result).toContain('已确认入账 1 条')
    expect(result).toContain('159869.SZ')
    expect(result).toContain('资产面板复核')
    const snap = await store.snapshot()
    expect(snap.staged.map(h => h.id)).toEqual([aaplId])
    expect(snap.holdings).toHaveLength(1)
    expect(snap.holdings[0]).toMatchObject({ id: gameId, size: 5000, entryPrice: 1.023, note: '用户确认', currency: 'CNY' })
    expect(written).toEqual([[gameId]])
  })

  it('holdings_confirm 全部 id 未知时提示两区工具分工', async () => {
    const store = createMemoryHoldingsStore()
    await seedStaged(store)
    const tool = createHoldingsConfirmTool(store)
    const result = await (tool as any).execute({ idsJson: 'hd-nope' })
    expect(result).toContain('待确认区没有这些 id')
    expect(result).toContain('holdings_update')
    expect((await store.snapshot()).staged).toHaveLength(2)
  })

  it('holdings_confirm edits 非法时整体拒绝，待确认区不动', async () => {
    const store = createMemoryHoldingsStore()
    const [gameId] = await seedStaged(store)
    const tool = createHoldingsConfirmTool(store)
    const result = await (tool as any).execute({
      idsJson: [gameId!],
      editsJson: { [gameId!]: { size: -5 } },
    })
    expect(result).toContain('修订校验失败')
    expect(result).toContain('size')
    const snap = await store.snapshot()
    expect(snap.staged).toHaveLength(2)
    expect(snap.holdings).toHaveLength(0)
  })

  it('holdings_discard 丢弃待确认条目并回显剩余', async () => {
    const store = createMemoryHoldingsStore()
    const [gameId, aaplId] = await seedStaged(store)
    const written: string[][] = []
    const tool = createHoldingsDiscardTool(store, { onWritten: ids => written.push(ids) })
    const result = await (tool as any).execute({ idsJson: JSON.stringify([aaplId!]) })
    expect(result).toContain('已丢弃 1 条')
    expect(result).toContain('AAPL')
    const snap = await store.snapshot()
    expect(snap.staged.map(h => h.id)).toEqual([gameId])
    expect(snap.holdings).toHaveLength(0)
    expect(written).toEqual([[aaplId]])
  })

  it('holdings_discard 未知 id 指向 holdings_remove', async () => {
    const store = createMemoryHoldingsStore()
    const tool = createHoldingsDiscardTool(store)
    const result = await (tool as any).execute({ idsJson: ['hd-missing'] })
    expect(result).toContain('待确认区没有这些 id')
    expect(result).toContain('holdings_remove')
  })

  it('holdings_add 直接录入正式持仓（多条目 + 写入侧推导）', async () => {
    const store = createMemoryHoldingsStore()
    const written: string[][] = []
    const tool = createHoldingsAddTool(store, { onWritten: ids => written.push(ids) })
    const result = await (tool as any).execute({
      itemsJson: JSON.stringify([
        { market: 'cn', symbol: '159869.SZ', name: '游戏ETF华夏', size: 5000, entryPrice: 1.023, account: '国金证券' },
        { market: 'crypto', symbol: 'BTCUSDT', size: '0.5' },
      ]),
    })
    expect(result).toContain('已录入 2 条正式持仓')
    expect(result).toContain('正式持仓现共 2 条')
    const snap = await store.snapshot()
    expect(snap.staged).toHaveLength(0)
    expect(snap.holdings.map(h => h.symbol)).toEqual(['159869.SZ', 'BTCUSDT'])
    expect(snap.holdings[1]).toMatchObject({ currency: 'USDT', account: '默认账户', kind: 'real' })
    expect(written[0]).toHaveLength(2)
  })

  it('holdings_add 校验失败整体拒绝（不落半解析记录）', async () => {
    const store = createMemoryHoldingsStore()
    const tool = createHoldingsAddTool(store)
    const result = await (tool as any).execute({
      itemsJson: JSON.stringify([
        { market: 'cn', symbol: '159869.SZ', size: 5000 },
        { market: 'cn', symbol: '', size: 1 },
      ]),
    })
    expect(result).toContain('未录入任何条目')
    expect(result).toContain('symbol')
    expect((await store.snapshot()).holdings).toHaveLength(0)
  })

  it('holdings_update 修订正式持仓并回显旧→新', async () => {
    const store = createMemoryHoldingsStore()
    const added = await store.add({ market: 'cn', symbol: '159869.SZ', name: '游戏ETF华夏', size: 5000, entryPrice: 1.023, account: '国金证券' })
    const written: string[][] = []
    const tool = createHoldingsUpdateTool(store, { onWritten: ids => written.push(ids) })
    const result = await (tool as any).execute({
      id: added.id,
      patchJson: JSON.stringify({ size: 4000, entryPrice: 1.05, account: '国金证券A' }),
    })
    expect(result).toContain('已更新 1 条')
    expect(result).toContain('旧:')
    expect(result).toContain('新:')
    const h = (await store.snapshot()).holdings[0]
    expect(h).toMatchObject({ size: 4000, entryPrice: 1.05, account: '国金证券A', currency: 'CNY' })
    expect(written).toEqual([[added.id]])
  })

  it('holdings_update 改 market 未给 currency 时按新市场重推导', async () => {
    const store = createMemoryHoldingsStore()
    const added = await store.add({ market: 'cn', symbol: '00700.HK', size: 100 })
    const tool = createHoldingsUpdateTool(store)
    await (tool as any).execute({ id: added.id, patchJson: { market: 'hk' } })
    expect((await store.snapshot()).holdings[0]).toMatchObject({ market: 'hk', currency: 'HKD' })
  })

  it('holdings_update 对待确认区 id / 未知 id / 空 patch 分别提示', async () => {
    const store = createMemoryHoldingsStore()
    const [stagedId] = await seedStaged(store)
    const tool = createHoldingsUpdateTool(store)
    const staged = await (tool as any).execute({ id: stagedId!, patchJson: { size: 1 } })
    expect(staged).toContain('在待确认区')
    expect(staged).toContain('holdings_confirm')
    const missing = await (tool as any).execute({ id: 'hd-nope', patchJson: { size: 1 } })
    expect(missing).toContain('正式持仓里没有 id')
    const empty = await (tool as any).execute({ id: stagedId!, patchJson: {} })
    expect(empty).toContain('不能为空对象')
    const bad = await (tool as any).execute({ id: stagedId!, patchJson: { size: 'abc' } })
    expect(bad).toContain('必须是有限数字')
  })

  it('holdings_remove 删除正式持仓（平仓清理）并回显剩余', async () => {
    const store = createMemoryHoldingsStore()
    const game = await store.add({ market: 'cn', symbol: '159869.SZ', name: '游戏ETF华夏', size: 5000, entryPrice: 1.023, account: '国金证券' })
    await store.add({ market: 'cn', symbol: '002714.SZ', name: '牧原股份', size: 2500 })
    const written: string[][] = []
    const tool = createHoldingsRemoveTool(store, { onWritten: ids => written.push(ids) })
    const result = await (tool as any).execute({ idsJson: game.id })
    expect(result).toContain('已删除 1 条')
    expect(result).toContain('正式持仓剩 1 条')
    expect(result).toContain('159869.SZ')
    expect(result).toContain('不代表账户真实状态')
    const snap = await store.snapshot()
    expect(snap.holdings.map(h => h.symbol)).toEqual(['002714.SZ'])
    expect(written).toEqual([[game.id]])
  })

  it('holdings_remove 对待确认区 id 指向 holdings_discard、未知 id 如实跳过', async () => {
    const store = createMemoryHoldingsStore()
    const [stagedId] = await seedStaged(store)
    const tool = createHoldingsRemoveTool(store)
    const onlyStaged = await (tool as any).execute({ idsJson: [stagedId!] })
    expect(onlyStaged).toContain('正式持仓没有这些 id')
    expect(onlyStaged).toContain('holdings_discard')
    const kept = await store.add({ market: 'cn', symbol: '002714.SZ', size: 2500 })
    const mixed = await (tool as any).execute({ idsJson: JSON.stringify([kept.id, stagedId!, 'hd-ghost']) })
    expect(mixed).toContain('已删除 1 条')
    expect(mixed).toContain('在待确认区未删')
    expect(mixed).toContain('未找到（已跳过）')
    expect((await store.snapshot()).holdings).toHaveLength(0)
  })
})
