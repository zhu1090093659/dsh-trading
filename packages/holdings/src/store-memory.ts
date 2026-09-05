/**
 * 内存版台账 store（纯内存，零 Node.js 依赖）：单测与桥回退用
 * （client-ui-trading 桥在 tradingHoldings 服务缺席时的自建兜底先例——
 * 对齐 knowledge store-memory 同款角色）。
 */
import { createHoldingsStore } from './store-core.ts'
import type { HoldingsBook, HoldingsStore } from './types.ts'

export function createMemoryHoldingsStore(initial: Partial<HoldingsBook> = {}): HoldingsStore {
  const book: HoldingsBook = {
    revision: initial.revision ?? 0,
    staged: (initial.staged ?? []).map(h => ({ ...h })),
    holdings: (initial.holdings ?? []).map(h => ({ ...h })),
  }
  return createHoldingsStore({
    load: async () => book,
    flush: async () => {},
  })
}
