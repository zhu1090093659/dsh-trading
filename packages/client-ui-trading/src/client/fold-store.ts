/**
 * 双侧栏折叠状态持久化 Store（富途式双栏折叠规范）：
 *
 * - 左侧栏（自选 MarketDock）：marketFoldStore ↔ dshtrading.market.folded.v1（默认展开）
 * - 右侧栏（会话 SessionRail）：foldStore ↔ dshtrading.chat.folded.v1（默认折叠）
 * - 左右各自独立持久化，各自支持 toggle()/set()/update()，可观察变化。
 */
import { createObservable, readJson, writeJson, type WritableObservable } from './store.ts'

export const RIGHT_FOLD_KEY = 'dshtrading.chat.folded.v1'
export const LEFT_FOLD_KEY = 'dshtrading.market.folded.v1'

export type FoldStore = WritableObservable<boolean> & { toggle(): void }

/** 创建独立的侧栏折叠持久化 Store（缺键或非布尔值时回落 defaultFolded）。 */
export function createFoldStore(storageKey: string, defaultFolded: boolean): FoldStore {
  const saved = readJson<unknown>(storageKey, defaultFolded)
  const initial = typeof saved === 'boolean' ? saved : defaultFolded
  const base = createObservable<boolean>(initial)
  const write = (next: boolean): void => {
    base.set(next)
    writeJson(storageKey, next)
  }
  return {
    getSnapshot: base.getSnapshot,
    subscribe: base.subscribe,
    set: write,
    update(mutator) {
      write(mutator(base.getSnapshot()))
    },
    toggle() {
      write(!base.getSnapshot())
    },
  }
}

let rightStore: FoldStore | undefined
let leftStore: FoldStore | undefined

/** 会话列（右侧栏）折叠 Store（默认折叠，优先留出首屏行情视野）。 */
export function foldStore(): FoldStore {
  if (rightStore !== undefined) return rightStore
  rightStore = createFoldStore(RIGHT_FOLD_KEY, true)
  return rightStore
}

/** 自选侧栏（左侧栏）折叠 Store（默认展开）。 */
export function marketFoldStore(): FoldStore {
  if (leftStore !== undefined) return leftStore
  leftStore = createFoldStore(LEFT_FOLD_KEY, false)
  return leftStore
}
