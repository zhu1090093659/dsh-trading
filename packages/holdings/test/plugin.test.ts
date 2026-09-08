import { describe, expect, it } from 'vitest'
import { createMemoryHoldingsStore } from '../src/store-memory.ts'
import { registerHoldingsTools } from '../src/plugin.ts'

/** 极简 cordis 面替身：只保留 tools 注册面与 tradingEvents 发布面。 */
function fakeContext() {
  const registered: any[] = []
  const emits: string[] = []
  const tools = {
    register: (tool: any) => registered.push(tool),
    get: (name: string) => registered.find(tool => tool.name === name),
  }
  const ctx = {
    inject: (_deps: string[], callback: (toolCtx: unknown) => void) => callback({ tools }),
    get: (key: string) => (key === 'tradingEvents' ? { emit: (store: string) => emits.push(store) } : undefined),
  }
  return { ctx, registered, emits }
}

describe('Holdings Plugin Wiring', () => {
  it('注册全部 7 个台账工具（且幂等不重复注册）', () => {
    const { ctx, registered } = fakeContext()
    registerHoldingsTools(ctx as any, { store: createMemoryHoldingsStore() })
    expect(registered.map(tool => tool.name).sort()).toEqual([
      'holdings_add',
      'holdings_confirm',
      'holdings_discard',
      'holdings_list',
      'holdings_remove',
      'holdings_stage',
      'holdings_update',
    ])
    // 再注册一次：get(name) 命中即跳过，不产生重复工具。
    registerHoldingsTools(ctx as any, { store: createMemoryHoldingsStore() })
    expect(registered).toHaveLength(7)
  })

  it('任一写工具成功 → emit tradingEvents("holdings")；只读工具不触发', async () => {
    const { ctx, registered, emits } = fakeContext()
    const store = createMemoryHoldingsStore()
    registerHoldingsTools(ctx as any, { store })
    const byName = (name: string) => registered.find(tool => tool.name === name)

    await byName('holdings_list')!.execute({})
    expect(emits).toHaveLength(0)

    const staged = await byName('holdings_stage')!.execute({
      itemsJson: JSON.stringify([{ market: 'cn', symbol: '159869.SZ', size: 5000, entryPrice: 1.023 }]),
    })
    expect(emits).toEqual(['holdings'])
    const id = staged.match(/\[(hd-[^\]]+)\]/)![1]

    await byName('holdings_confirm')!.execute({ idsJson: [id] })
    await byName('holdings_update')!.execute({ id, patchJson: { size: 4000 } })
    await byName('holdings_remove')!.execute({ idsJson: [id] })
    expect(emits).toEqual(['holdings', 'holdings', 'holdings', 'holdings'])
    expect((await store.snapshot()).holdings).toHaveLength(0)

    const staged2 = await byName('holdings_add')!.execute({ itemsJson: [{ market: 'cn', symbol: '002714.SZ', size: 2500 }] })
    await byName('holdings_discard')!.execute({ idsJson: ['hd-nope'] })
    expect(emits).toHaveLength(5)
    expect(staged2).toContain('已录入 1 条')
  })
})
