/**
 * 会话列折叠状态（2.8）：单一可观察源 + localStorage 持久化。2.9 起唯一
 * 入口是右缘会话竖条（SessionRail，恒挂载），切换经
 * body[data-dshtrading-chat-folded] 与 shell-pad.css 规则 9 联动收起
 * 会话列轨道；竖条自身不随折叠隐藏。
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
