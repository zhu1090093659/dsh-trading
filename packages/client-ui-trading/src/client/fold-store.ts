/**
 * 会话列折叠状态（2.8）：单一可观察源 + localStorage 持久化。WindowChrome
 * （浮动角标）与 HeaderCornerActions（会话头内联）两个入口共享同一 store，
 * 任一处切换，另一处与 shell-pad.css（body[data-dshtrading-chat-folded]）
 * 同步生效。
 */
import { createObservable, readJson, writeJson, type WritableObservable } from './store.ts'

const FOLD_KEY = 'dshtrading.chat.folded.v1'

export type FoldStore = WritableObservable<boolean> & { toggle(): void }

let store: FoldStore | undefined

export function foldStore(): FoldStore {
  if (store !== undefined) return store
  const base = createObservable<boolean>(readJson<boolean>(FOLD_KEY, false))
  store = {
    ...base,
    toggle() {
      const next = !base.getSnapshot()
      base.set(next)
      writeJson(FOLD_KEY, next)
    },
  }
  return store
}
