/**
 * 台账两区（staged/holdings）操作核心：file store 与 memory store 共用同一
 * 实现，仅持久化策略不同（file store 走跨进程临界区 / memory store 纯内存）。
 *
 * 纪律（契约 §2）：
 * - 全部写操作先整体校验再落库——stage 任一条目非法、confirm 任一 edits
 *   非法都整体拒绝，不产生半迁移状态；
 * - 内容真实变化才自增 revision 并 flush（无匹配 id 的 confirm/discard/
 *   update/remove 与空 stage 是幂等 no-op）；
 * - confirm/discard 只作用于 staged 区，update/remove 只作用于 holdings 区。
 *
 * 跨进程（2026-10-09 事故修复）：file store 提供 driver.transact——「锁内新鲜读盘 +
 * 就地改 + 原子写」整段临界区，替换旧的「load 内存缓存 → flush 整表回写」写路径；
 * memory store 无此缺口，保持 load/flush 组合。两条路径共用同一 plan 闭包，
 * 行为（校验顺序、revision 自增、幂等 no-op）完全一致。
 */
import type { Holding, HoldingsBook, HoldingsStore } from './types.ts'
import { applyHoldingEdits, normalizeNewHolding } from './normalize.ts'

export function createEmptyBook(): HoldingsBook {
  return { revision: 0, staged: [], holdings: [] }
}

export interface HoldingsBookDriver {
  /** 取当前可变 book（file store 首次调用时从磁盘装载并缓存单实例）。 */
  load(): Promise<HoldingsBook>
  /** 写后持久化（memory store 为空操作；file store 走 transact 时无需提供）。 */
  flush?(book: HoldingsBook): Promise<void>
  /**
   * 跨进程临界区（file store 提供）：plan 在**锁内新鲜读到的** book 上就地修改并
   * 返回本次操作结果，函数返回前已原子落盘。memory store 缺席。
   */
  transact?<T>(plan: (book: HoldingsBook) => T | Promise<T>): Promise<T>
}

function copyHolding(holding: Holding): Holding {
  return { ...holding }
}

export function createHoldingsStore(driver: HoldingsBookDriver): HoldingsStore {
  /**
   * 统一写路径：file store 走跨进程临界区；memory store 走 load → plan → flush。
   * plan 必须是「就地把本次修改施加到 book 并返回结果」的闭包（校验/计算在调用前
   * 完成），因此失败校验抛错时 book 与磁盘都不被触碰。
   */
  async function mutate<T>(plan: (book: HoldingsBook) => T | Promise<T>): Promise<T> {
    if (driver.transact !== undefined) return driver.transact(plan)
    const book = await driver.load()
    const result = await plan(book)
    if (driver.flush !== undefined) await driver.flush(book)
    return result
  }

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
      // 先全量校验/推导（非法条目整体拒绝，不落半解析暂存）。
      const staged = items.map(item => normalizeNewHolding(item))
      if (staged.length === 0) {
        const book = await driver.load()
        return { revision: book.revision, ids: [] }
      }
      return mutate((book) => {
        book.staged.push(...staged)
        book.revision += 1
        return { revision: book.revision, ids: staged.map(h => h.id) }
      })
    },

    async confirm(ids, edits = {}) {
      return mutate((book) => {
        // 先整体解析/校验全部 edits（坏 edits 整体拒绝，抛出即不落盘），未知 id 静默跳过（幂等确认）。
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
        return { revision: book.revision, confirmed: plan.map(p => p.id) }
      })
    },

    async discard(ids) {
      return mutate((book) => {
        const targets = new Set(ids)
        const remaining = book.staged.filter(h => !targets.has(h.id))
        const discarded = book.staged.filter(h => targets.has(h.id)).map(h => h.id)
        if (discarded.length === 0) return { revision: book.revision, discarded: [] }
        book.staged = remaining
        book.revision += 1
        return { revision: book.revision, discarded }
      })
    },

    async add(item) {
      const holding = normalizeNewHolding(item)
      return mutate((book) => {
        book.holdings.push(holding)
        book.revision += 1
        return { revision: book.revision, id: holding.id }
      })
    },

    async update(id, patch) {
      return mutate((book) => {
        const index = book.holdings.findIndex(h => h.id === id)
        const current = index >= 0 ? book.holdings[index] : undefined
        if (current === undefined) return { revision: book.revision, updated: false }
        // 校验通过才替换（applyHoldingEdits 抛错时库内状态不变）。
        const next = applyHoldingEdits(current, patch)
        book.holdings[index] = next
        book.revision += 1
        return { revision: book.revision, updated: true }
      })
    },

    async remove(id) {
      return mutate((book) => {
        const index = book.holdings.findIndex(h => h.id === id)
        if (index < 0) return { revision: book.revision, removed: false }
        book.holdings.splice(index, 1)
        book.revision += 1
        return { revision: book.revision, removed: true }
      })
    },
  }
}
