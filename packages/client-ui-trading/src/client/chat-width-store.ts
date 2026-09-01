/**
 * 会话列（右侧栏对话列）宽度持久化 Store：shell-pad.css 规则 3 的
 * --dshtrading-chat-w 引用 body 内联的 --dshtrading-chat-user-w（自定义属性
 * 随继承进栅格 frame）；本 store 只管数值夹紧与持久化，把值写到 body 变量
 * 是 ChatResizeHandle 的职责（拖拽路径不进 React 状态，松手才落库）。
 */
import { createObservable, readJson, writeJson, type WritableObservable } from './store.ts'

const WIDTH_KEY = 'dshtrading.chat.width.v1'

/** 会话列宽度夹紧范围与默认值（px）：下限保证 composer 可用，上限给中栏行情留有效宽度。 */
export const CHAT_WIDTH_MIN = 320
export const CHAT_WIDTH_MAX = 720
export const CHAT_WIDTH_DEFAULT = 380

/** 夹紧到合法宽度（取整）。 */
export function clampChatWidth(width: number): number {
  return Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, Math.round(width)))
}

export type ChatWidthStore = WritableObservable<number>

let store: ChatWidthStore | undefined

/** 会话列宽度 Store（px，持久化 dshtrading.chat.width.v1）。 */
export function chatWidthStore(): ChatWidthStore {
  if (store !== undefined) return store
  const base = createObservable<number>(clampChatWidth(readJson<number>(WIDTH_KEY, CHAT_WIDTH_DEFAULT)))
  store = {
    ...base,
    set(value: number) {
      base.set(clampChatWidth(value))
      writeJson(WIDTH_KEY, base.getSnapshot())
    },
  }
  return store
}
