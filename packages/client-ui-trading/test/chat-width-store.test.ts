/**
 * chat-width-store：会话列宽度夹紧与持久化契约。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_WIDTH_DEFAULT, CHAT_WIDTH_MAX, CHAT_WIDTH_MIN, chatWidthStore, clampChatWidth } from '../src/client/chat-width-store.ts'

const WIDTH_KEY = 'dshtrading.chat.width.v1'

/** 内存版 localStorage 假件（node 环境无该全局）。 */
function stubStorage(): Map<string, string> {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  })
  return map
}

describe('clampChatWidth', () => {
  it('夹紧到 [min, max] 并取整', () => {
    expect(clampChatWidth(Number.NEGATIVE_INFINITY)).toBe(CHAT_WIDTH_MIN)
    expect(clampChatWidth(Number.MAX_SAFE_INTEGER)).toBe(CHAT_WIDTH_MAX)
    expect(clampChatWidth(380.4)).toBe(380)
    expect(clampChatWidth(CHAT_WIDTH_DEFAULT)).toBe(CHAT_WIDTH_DEFAULT)
  })
})

describe('chatWidthStore', () => {
  let storage: Map<string, string>
  beforeEach(() => { storage = stubStorage() })
  afterEach(() => {
    vi.unstubAllGlobals()
    chatWidthStore().set(CHAT_WIDTH_DEFAULT)
  })

  it('set() 夹紧越界值并持久化（重载恢复契约）', () => {
    const store = chatWidthStore()
    store.set(CHAT_WIDTH_MIN - 100)
    expect(store.getSnapshot()).toBe(CHAT_WIDTH_MIN)
    expect(JSON.parse(storage.get(WIDTH_KEY) ?? 'null')).toBe(CHAT_WIDTH_MIN)
    store.set(CHAT_WIDTH_MAX + 500)
    expect(store.getSnapshot()).toBe(CHAT_WIDTH_MAX)
    expect(JSON.parse(storage.get(WIDTH_KEY) ?? 'null')).toBe(CHAT_WIDTH_MAX)
  })

  it('订阅者收到夹紧后的快照', () => {
    const store = chatWidthStore()
    const seen: number[] = []
    store.subscribe(() => { seen.push(store.getSnapshot()) })
    store.set(2000)
    expect(seen).toEqual([CHAT_WIDTH_MAX])
  })
})
