/**
 * CCXT 快照适配器测试：用**契约假件**（只实现我们依赖的 fetchTicker 子集），无 mock 框架、无网络。
 */
import { describe, expect, it } from 'vitest'
import { ccxtSymbol, createCcxtSnapshotSource, type CcxtExchangeLike, type CcxtTicker } from '../src/adapters/ccxt.ts'

const T0 = 1_700_000_000_000

/** 契约假件：按 symbol 给出预设结果，可注入抛错。 */
function fakeExchange(table: Record<string, CcxtTicker | 'throw'>): { exchange: CcxtExchangeLike; calls: string[] } {
  const calls: string[] = []
  const exchange: CcxtExchangeLike = {
    async fetchTicker(symbol) {
      calls.push(symbol)
      const entry = table[symbol]
      if (entry === undefined || entry === 'throw') throw new Error('exchange 不可用（模拟）')
      return entry
    },
  }
  return { exchange, calls }
}

describe('CCXT 快照适配器', () => {
  it('管理员：把 fetchTicker 的 last 映射成内部快照（symbol 与内部写法一致）', async () => {
    // Given 一个能返回价格与时间的 exchange
    const { exchange } = fakeExchange({ 'BTC/USDT': { last: 60_000, timestamp: T0 } })
    const source = createCcxtSnapshotSource({ exchange, epoch: 3, now: () => T0 + 1 })
    // When 拉一批
    const snapshots = await source(['BTC/USDT'])
    // Then 一条快照、字段齐全、epoch 如实传递
    expect(snapshots).toEqual([{ kind: 'snapshot', epoch: 3, symbol: 'BTC/USDT', price: 60_000, atMs: T0 }])
    expect(ccxtSymbol('BTC/USDT')).toBe('BTC/USDT')
  })

  it('管理员：单只标的失败或价格不可用时跳过它，其余照常返回（不抛）', async () => {
    // Given 三只标的：一只正常、一只抛错、一只 last 是空值
    const { exchange } = fakeExchange({ 'BTC/USDT': { last: 60_000, timestamp: T0 }, 'ETH/USDT': { last: undefined } })
    const source = createCcxtSnapshotSource({ exchange, epoch: 1, now: () => T0 })
    // When 一次拉三只
    const snapshots = await source(['BTC/USDT', 'DOGE/USDT', 'ETH/USDT'])
    // Then 只有正常那只回来
    expect(snapshots.map((snapshot) => snapshot.symbol)).toEqual(['BTC/USDT'])
  })

  it('管理员：没有 timestamp 时用注入时钟兜底，且价格字符串也能解析', async () => {
    // Given 一只只有字符串价格、没有时间的标的
    const { exchange } = fakeExchange({ 'BTC/USDT': { last: '60123.45' } })
    const source = createCcxtSnapshotSource({ exchange, epoch: 2, now: () => T0 + 500 })
    // When 拉取
    const snapshots = await source(['BTC/USDT'])
    // Then 价格解析为数字、时间用注入时钟
    expect(snapshots[0]).toMatchObject({ price: 60123.45, atMs: T0 + 500, epoch: 2 })
  })

  it('管理员：只产快照不产 tick（CCXT 是聚合兜底，不是高频推流）', async () => {
    // Given 一个正常的 exchange
    const { exchange } = fakeExchange({ 'BTC/USDT': { last: 1, timestamp: T0 } })
    const source = createCcxtSnapshotSource({ exchange, epoch: 1, now: () => T0 })
    // When 拉取
    const snapshots = await source(['BTC/USDT'])
    // Then 全部是 snapshot 类型
    expect(snapshots.every((snapshot) => snapshot.kind === 'snapshot')).toBe(true)
  })
})
