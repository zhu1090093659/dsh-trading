import { describe, expect, it, afterEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createMemoryHoldingsStore } from '../src/store-memory.ts'
import { createFileHoldingsStore } from '../src/store-fs.ts'
import { HoldingValidationError } from '../src/normalize.ts'
import type { Holding, HoldingsStore, NewHoldingInput } from '../src/types.ts'

function sampleInput(overrides: Partial<NewHoldingInput> = {}): NewHoldingInput {
  return { market: 'us', symbol: 'AAPL', size: 10, ...overrides }
}

/** 两区操作行为套件：memory / file store 同构跑一遍（契约 §2 语义与实现解耦）。 */
function storeBehaviorSuite(label: string, make: () => HoldingsStore) {
  describe(label, () => {
    it('stage 推导默认值：currency 按 market、account 缺省、kind 缺省 real', async () => {
      const store = make()
      const { ids, revision } = await store.stage([
        sampleInput({ market: 'crypto', symbol: 'BTCUSDT', size: 0.5 }),
        sampleInput({ market: 'us', symbol: 'AAPL', size: 10 }),
        sampleInput({ market: 'cn', symbol: '002714.SZ', size: 100 }),
        sampleInput({ market: 'hk', symbol: '00700.HK', size: 200 }),
      ])
      expect(revision).toBe(1)
      expect(ids).toHaveLength(4)
      const snap = await store.snapshot()
      expect(snap.staged).toHaveLength(4)
      expect(snap.holdings).toHaveLength(0)
      const byMarket = new Map(snap.staged.map(h => [h.market, h]))
      expect(byMarket.get('crypto')?.currency).toBe('USDT')
      expect(byMarket.get('us')?.currency).toBe('USD')
      expect(byMarket.get('cn')?.currency).toBe('CNY')
      expect(byMarket.get('hk')?.currency).toBe('HKD')
      for (const h of snap.staged) {
        expect(h.id).toMatch(/^hd-\d+-[a-z0-9]+$/)
        expect(h.account).toBe('默认账户')
        expect(h.kind).toBe('real')
        expect(h.side).toBe('long')
        expect(h.source).toBe('imported')
        expect(typeof h.importedAt).toBe('number')
        expect(h.updatedAt).toBe(h.importedAt)
      }
    })

    it('stage 保留显式字段（currency 覆盖 / account / kind=sim / name / entryPrice / note）', async () => {
      const store = make()
      await store.stage([sampleInput({
        market: 'crypto', symbol: 'ETHUSDT', size: 2,
        currency: 'USDT', account: '币安', kind: 'sim',
        name: '以太坊', entryPrice: 3200.5, note: '截图导入',
      })])
      const snap = await store.snapshot()
      const h = snap.staged[0]
      expect(h).toMatchObject({
        currency: 'USDT', account: '币安', kind: 'sim',
        name: '以太坊', entryPrice: 3200.5, note: '截图导入',
      })
    })

    it('stage 校验失败整体拒绝（负 size），不产生半解析暂存', async () => {
      const store = make()
      await expect(store.stage([
        sampleInput({ symbol: 'AAPL', size: 10 }),
        sampleInput({ symbol: 'TSLA', size: -3 }),
      ])).rejects.toThrow(HoldingValidationError)
      const snap = await store.snapshot()
      expect(snap.staged).toHaveLength(0)
      expect(snap.revision).toBe(0)
    })

    it('confirm 迁移到正式区并应用 edits；market 变更未显式给 currency 时重推导', async () => {
      const store = make()
      const { ids } = await store.stage([
        sampleInput({ market: 'us', symbol: 'AAPL', size: 10 }),
        sampleInput({ market: 'hk', symbol: '00700.HK', size: 200 }),
      ])
      const revAfterStage = (await store.snapshot()).revision
      const result = await store.confirm(ids, {
        [ids[0]!]: { size: 12, account: '富途' },
        // 截图市场看走眼：us → hk，未显式给 currency → 按新 market 重推导 HKD
        [ids[1]!]: { market: 'us' },
      })
      expect(result.confirmed).toEqual(ids)
      expect(result.revision).toBe(revAfterStage + 1)
      const snap = await store.snapshot()
      expect(snap.staged).toHaveLength(0)
      expect(snap.holdings).toHaveLength(2)
      const aapl = snap.holdings.find(h => h.symbol === 'AAPL')
      expect(aapl).toMatchObject({ size: 12, account: '富途', currency: 'USD' })
      // 第二条原 hk/00700.HK，edits 改 market=us → currency 重推导为 USD
      const tencent = snap.holdings.find(h => h.symbol === '00700.HK')
      expect(tencent?.market).toBe('us')
      expect(tencent?.currency).toBe('USD')
      expect(tencent?.id).toBe(ids[1]!)
    })

    it('confirm 未知 id 静默跳过；全部未知 = 幂等 no-op（revision 不动）', async () => {
      const store = make()
      const { ids } = await store.stage([sampleInput()])
      const rev1 = (await store.snapshot()).revision
      const mixed = await store.confirm([ids[0]!, 'hd-nonexistent'])
      expect(mixed.confirmed).toEqual([ids[0]!])
      const rev2 = (await store.snapshot()).revision
      expect(rev2).toBe(rev1 + 1)
      const noop = await store.confirm(['hd-nonexistent'])
      expect(noop.confirmed).toEqual([])
      expect((await store.snapshot()).revision).toBe(rev2)
    })

    it('confirm 坏 edits 整体拒绝：两区状态不变', async () => {
      const store = make()
      const { ids } = await store.stage([
        sampleInput({ symbol: 'AAPL' }),
        sampleInput({ symbol: 'TSLA' }),
      ])
      const before = await store.snapshot()
      await expect(store.confirm(ids, { [ids[1]!]: { size: -1 } })).rejects.toThrow(HoldingValidationError)
      const after = await store.snapshot()
      expect(after.revision).toBe(before.revision)
      expect(after.staged).toHaveLength(2)
      expect(after.holdings).toHaveLength(0)
    })

    it('discard 移除待确认条目；未知 id 幂等 no-op', async () => {
      const store = make()
      const { ids } = await store.stage([sampleInput(), sampleInput({ symbol: 'TSLA' })])
      const rev1 = (await store.snapshot()).revision
      const result = await store.discard([ids[0]!, 'hd-ghost'])
      expect(result.discarded).toEqual([ids[0]!])
      const snap = await store.snapshot()
      expect(snap.revision).toBe(rev1 + 1)
      expect(snap.staged).toHaveLength(1)
      const noop = await store.discard(['hd-ghost'])
      expect(noop.discarded).toEqual([])
      expect((await store.snapshot()).revision).toBe(snap.revision)
    })

    it('add 直入正式区并推导默认值，返回新 id', async () => {
      const store = make()
      const { id, revision } = await store.add(sampleInput({ market: 'cn', symbol: '600519.SH', size: 100 }))
      expect(revision).toBe(1)
      expect(id).toMatch(/^hd-/)
      const snap = await store.snapshot()
      expect(snap.holdings).toHaveLength(1)
      expect(snap.holdings[0]).toMatchObject({
        id, symbol: '600519.SH', currency: 'CNY', account: '默认账户', kind: 'real', source: 'imported',
      })
    })

    it('update 应用补丁并刷新 updatedAt；未知 id 返回 updated:false 且不动 revision', async () => {
      const store = make()
      const { id } = await store.add(sampleInput({ size: 10, entryPrice: 100 }))
      const before = (await store.snapshot()).holdings[0]!
      const result = await store.update(id, { size: 20, note: '加仓' })
      expect(result.updated).toBe(true)
      const after = (await store.snapshot()).holdings[0]!
      expect(after.size).toBe(20)
      expect(after.note).toBe('加仓')
      expect(after.entryPrice).toBe(100)
      expect(after.importedAt).toBe(before.importedAt)
      expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)
      const rev = (await store.snapshot()).revision
      const miss = await store.update('hd-ghost', { size: 1 })
      expect(miss.updated).toBe(false)
      expect((await store.snapshot()).revision).toBe(rev)
    })

    it('update 拒绝把 quality 字段改掉（id/source 不可经 patch 注入）', async () => {
      const store = make()
      const { id } = await store.add(sampleInput())
      await store.update(id, { size: 5 })
      const h = (await store.snapshot()).holdings[0]!
      expect(h.id).toBe(id)
      expect(h.source).toBe('imported')
    })

    it('update 坏补丁抛错且库内状态不变', async () => {
      const store = make()
      const { id } = await store.add(sampleInput({ size: 10 }))
      await expect(store.update(id, { size: 0 })).rejects.toThrow(HoldingValidationError)
      const h = (await store.snapshot()).holdings[0]!
      expect(h.size).toBe(10)
    })

    it('remove 删除正式持仓；未知 id removed:false 且不动 revision', async () => {
      const store = make()
      const { id } = await store.add(sampleInput())
      const rev1 = (await store.snapshot()).revision
      const result = await store.remove(id)
      expect(result.removed).toBe(true)
      expect((await store.snapshot()).holdings).toHaveLength(0)
      expect((await store.snapshot()).revision).toBe(rev1 + 1)
      const miss = await store.remove('hd-ghost')
      expect(miss.removed).toBe(false)
      expect((await store.snapshot()).revision).toBe(rev1 + 1)
    })

    it('revision 跨操作单调自增', async () => {
      const store = make()
      const { ids } = await store.stage([sampleInput()])
      await store.add(sampleInput({ symbol: 'TSLA' }))
      await store.confirm(ids)
      const snap = await store.snapshot()
      expect(snap.revision).toBe(3)
      expect(snap.holdings).toHaveLength(2)
    })

    it('snapshot 返回副本：改返回值不污染库内数据', async () => {
      const store = make()
      await store.add(sampleInput())
      const snap = await store.snapshot()
      snap.holdings.push({} as Holding)
      snap.staged.push({} as Holding)
      const again = await store.snapshot()
      expect(again.holdings).toHaveLength(1)
      expect(again.staged).toHaveLength(0)
    })
  })
}

describe('Holdings Store', () => {
  storeBehaviorSuite('Memory Store', () => createMemoryHoldingsStore())

  describe('File Store', () => {
    let tmpDir = ''
    let bookPath = ''

    afterEach(async () => {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      tmpDir = ''
    })

    async function freshPath(): Promise<string> {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'holdings-store-test-'))
      bookPath = path.join(tmpDir, 'book.json')
      return bookPath
    }

    // file store 同构跑一遍行为套件需要持久化路径——单独建子套件。
    it('落盘形状为 { revision, staged, holdings } 且新实例可回读', async () => {
      const file = await freshPath()
      const store1 = createFileHoldingsStore(file)
      const { ids } = await store1.stage([sampleInput({ market: 'crypto', symbol: 'BTCUSDT', size: 0.5 })])
      await store1.confirm(ids)
      const raw = JSON.parse(await readFile(file, 'utf8'))
      expect(Object.keys(raw).sort()).toEqual(['holdings', 'revision', 'staged'])
      expect(raw.revision).toBe(2)
      expect(raw.staged).toHaveLength(0)
      expect(raw.holdings).toHaveLength(1)
      expect(raw.holdings[0].currency).toBe('USDT')
      // 新实例从磁盘装载（重启语义）
      const store2 = createFileHoldingsStore(file)
      const snap = await store2.snapshot()
      expect(snap.revision).toBe(2)
      expect(snap.holdings[0]?.symbol).toBe('BTCUSDT')
    })

    it('坏 JSON 文件回退空台账（不崩）', async () => {
      const file = await freshPath()
      await writeFile(file, '{ not json !!!', 'utf8')
      const store = createFileHoldingsStore(file)
      const snap = await store.snapshot()
      expect(snap).toEqual({ revision: 0, staged: [], holdings: [] })
      // 回退后仍可正常写入（覆盖坏文件）
      await store.add(sampleInput())
      expect((await store.snapshot()).holdings).toHaveLength(1)
    })

    it('形状不符（合法 JSON 但非 book）回退空台账', async () => {
      const file = await freshPath()
      await writeFile(file, JSON.stringify([1, 2, 3]), 'utf8')
      const store = createFileHoldingsStore(file)
      expect(await store.snapshot()).toEqual({ revision: 0, staged: [], holdings: [] })
    })
  })

  storeBehaviorSuite('File Store（行为同构）', (() => {
    // 每个用例各自建临时文件：make 闭包记路径，afterEach 清。
    const paths: string[] = []
    const cleanup = async () => {
      for (const p of paths.splice(0)) await rm(path.dirname(p), { recursive: true, force: true }).catch(() => {})
    }
    afterEach(cleanup)
    return () => {
      const dir = path.join(os.tmpdir(), `holdings-behavior-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      const file = path.join(dir, 'book.json')
      paths.push(file)
      return createFileHoldingsStore(file)
    }
  })())
})
