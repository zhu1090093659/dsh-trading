/**
 * 双侧栏折叠状态持久化 Store（富途式双栏折叠规范）：
 *
 * - 左侧栏（自选 MarketDock）：marketFoldStore ↔ dshtrading.market.folded.v1
 * - 右侧栏（会话 SessionRail）：foldStore ↔ dshtrading.chat.folded.v1
 * - 左右各自独立持久化，各自支持 toggle()，可观察变化。
 */
import { createObservable, readJson, writeJson, type WritableObservable } from './store.ts'

const RIGHT_FOLD_KEY = 'dshtrading.chat.folded.v1'
const LEFT_FOLD_KEY = 'dshtrading.market.folded.v1'

export type FoldStore = WritableObservable<boolean> & { toggle(): void }

let rightStore: FoldStore | undefined
let leftStore: FoldStore | undefined

/** 会话列（右侧栏）折叠 Store。 */
export function foldStore(): FoldStore {
  if (rightStore !== undefined) return rightStore
  const base = createObservable<boolean>(readJson<boolean>(RIGHT_FOLD_KEY, false))
  rightStore = {
    ...base,
    toggle() {
      const next = !base.getSnapshot()
      base.set(next)
      writeJson(RIGHT_FOLD_KEY, next)
    },
  }
  return rightStore
}

/** 自选侧栏（左侧栏）折叠 Store。 */
export function marketFoldStore(): FoldStore {
  if (leftStore !== undefined) return leftStore
  const base = createObservable<boolean>(readJson<boolean>(LEFT_FOLD_KEY, false))
  leftStore = {
    ...base,
    toggle() {
      const next = !base.getSnapshot()
      base.set(next)
      writeJson(LEFT_FOLD_KEY, next)
    },
  }
  return leftStore
}
