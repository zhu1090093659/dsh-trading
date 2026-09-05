/**
 * 台账两区（staged/holdings）操作核心：file store 与 memory store 共用同一
 * 实现，仅持久化策略不同（flush 落盘 / 空操作）。
 *
 * 纪律（契约 §2）：
 * - 全部写操作先整体校验再落库——stage 任一条目非法、confirm 任一 edits
 *   非法都整体拒绝，不产生半迁移状态；
 * - 内容真实变化才自增 revision 并 flush（无匹配 id 的 confirm/discard/
 *   update/remove 与空 stage 是幂等 no-op）；
 * - confirm/discard 只作用于 staged 区，update/remove 只作用于 holdings 区。
 */
import type { Holding, HoldingsBook, HoldingsStore } from './types.ts'
import { applyHoldingEdits, normalizeNewHolding } from './normalize.ts'

export function createEmptyBook(): HoldingsBook {
  return { revision: 0, staged: [], holdings: [] }
}

export interface HoldingsBookDriver {
  /** 取当前可变 book（file store 首次调用时从磁盘装载并缓存单实例）。 */
  load(): Promise<HoldingsBook>
  /** 写后持久化（memory store 为空操作）。 */
  flush(book: HoldingsBook): Promise<void>
}

function copyHolding(holding: Holding): Holding {
  return { ...holding }
}

export function createHoldingsStore(driver: HoldingsBookDriver): HoldingsStore {
  return {
    async snapshot() {
      const book = await driver.load()
      return {
        revision: book.revision,
        staged: book.staged.map(copyHolding),
        holdings: book.holdings.map(copyHolding),
      }
    },

    async stage(items) {
      const book = await driver.load()
      // 先全量校验/推导（非法条目整体拒绝，不落半解析暂存）。
      const staged = items.map(item => normalizeNewHolding(item))
      if (staged.length === 0) return { revision: book.revision, ids: [] }
      book.staged.push(...staged)
      book.revision += 1
      await driver.flush(book)
      return { revision: book.revision, ids: staged.map(h => h.id) }
    },

    async confirm(ids, edits = {}) {
      const book = await driver.load()
      // 先整体解析/校验全部 edits（坏 edits 整体拒绝），未知 id 静默跳过（幂等确认）。
      const plan: { id: string; item: Holding }[] = []
      for (const id of ids) {
        const stagedItem = book.staged.find(h => h.id === id)
        if (stagedItem === undefined) continue
        plan.push({ id, item: applyHoldingEdits(stagedItem, edits[id] ?? {}) })
      }
      if (plan.length === 0) return { revision: book.revision, confirmed: [] }
      const confirmedIds = new Set(plan.map(p => p.id))
      book.staged = book.staged.filter(h => !confirmedIds.has(h.id))
      for (const p of plan) book.holdings.push(p.item)
      book.revision += 1
      await driver.flush(book)
      return { revision: book.revision, confirmed: plan.map(p => p.id) }
    },

    async discard(ids) {
      const book = await driver.load()
      const targets = new Set(ids)
      const remaining = book.staged.filter(h => !targets.has(h.id))
      const discarded = book.staged.filter(h => targets.has(h.id)).map(h => h.id)
      if (discarded.length === 0) return { revision: book.revision, discarded: [] }
      book.staged = remaining
      book.revision += 1
      await driver.flush(book)
      return { revision: book.revision, discarded }
    },

    async add(item) {
      const book = await driver.load()
      const holding = normalizeNewHolding(item)
      book.holdings.push(holding)
      book.revision += 1
      await driver.flush(book)
      return { revision: book.revision, id: holding.id }
    },

    async update(id, patch) {
      const book = await driver.load()
      const index = book.holdings.findIndex(h => h.id === id)
      const current = index >= 0 ? book.holdings[index] : undefined
      if (current === undefined) return { revision: book.revision, updated: false }
      // 校验通过才替换（applyHoldingEdits 抛错时库内状态不变）。
      const next = applyHoldingEdits(current, patch)
      book.holdings[index] = next
      book.revision += 1
      await driver.flush(book)
      return { revision: book.revision, updated: true }
    },

    async remove(id) {
      const book = await driver.load()
      const index = book.holdings.findIndex(h => h.id === id)
      if (index < 0) return { revision: book.revision, removed: false }
      book.holdings.splice(index, 1)
      book.revision += 1
      await driver.flush(book)
      return { revision: book.revision, removed: true }
    },
  }
}
