/**
 * 双侧栏折叠状态持久化 Store 单测：
 * - 右侧会话列（foldStore / dshtrading.chat.folded.v1）默认折叠，首次打开软件即收起会话区域；
 * - 左侧自选栏（marketFoldStore / dshtrading.market.folded.v1）维持默认展开；
 * - toggle()/set()/update() 同步写入 localStorage 并通知订阅者；
 * - 存储缺失或损坏（非布尔/非法 JSON）时安全回落各自默认值。
 *
 * @vitest-environment jsdom
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createFoldStore,
  foldStore,
  LEFT_FOLD_KEY,
  marketFoldStore,
  RIGHT_FOLD_KEY,
} from '../src/client/fold-store.ts'

/** 内存 Storage 契约替身（node 25 下默认 localStorage 缺 --localstorage-file 时方法未挂载）。 */
function createMemoryStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() { return entries.size },
    clear() { entries.clear() },
    getItem(key: string) { return entries.get(key) ?? null },
    key(index: number) { return Array.from(entries.keys())[index] ?? null },
    removeItem(key: string) { entries.delete(key) },
    setItem(key: string, value: string) { entries.set(key, String(value)) },
  }
}

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const memoryStorage = createMemoryStorage()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: memoryStorage,
})

beforeEach(() => { memoryStorage.clear() })

afterAll(() => {
  if (originalDescriptor !== undefined) {
    Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

describe('fold-store（侧栏折叠默认态与持久化）', () => {
  it('用户首次打开软件时会话列默认折叠、左侧自选栏默认展开', () => {
    // Given 全新客户端（localStorage 未记录任何折叠偏好）
    // When 读取会话列与自选栏折叠 Store
    const chat = foldStore()
    const market = marketFoldStore()
    // Then 会话列默认折叠（true）、左侧自选栏默认展开（false）
    expect(chat.getSnapshot()).toBe(true)
    expect(market.getSnapshot()).toBe(false)
  })

  it('用户切换会话列折叠态后会持久化到 localStorage 并通知订阅者', () => {
    // Given 独立的会话列折叠 Store（初始默认折叠）
    const store = createFoldStore(RIGHT_FOLD_KEY, true)
    const history: boolean[] = []
    const unsubscribe = store.subscribe(() => { history.push(store.getSnapshot()) })
    // When 用户先展开再折叠
    store.toggle()
    const afterExpand = createFoldStore(RIGHT_FOLD_KEY, true).getSnapshot()
    store.toggle()
    const afterFold = createFoldStore(RIGHT_FOLD_KEY, true).getSnapshot()
    unsubscribe()
    // Then 两次变更均通知订阅者，且重载后读取到最新持久化值
    expect(history).toEqual([false, true])
    expect(afterExpand).toBe(false)
    expect(afterFold).toBe(true)
  })

  it('用户经 set 与 update 修改折叠态后重载仍保留写入结果', () => {
    // Given 默认折叠的独立 Store
    const store = createFoldStore(RIGHT_FOLD_KEY, true)
    // When 显式 set(false) 展开后再经 update 取反
    store.set(false)
    const afterSet = createFoldStore(RIGHT_FOLD_KEY, true).getSnapshot()
    store.update(current => !current)
    const afterUpdate = createFoldStore(RIGHT_FOLD_KEY, true).getSnapshot()
    // Then 两种写路径均落盘并在新实例恢复
    expect(afterSet).toBe(false)
    expect(afterUpdate).toBe(true)
  })

  it('用户遇到损坏或非布尔的本地存储值时安全回落各自默认值', () => {
    // Given localStorage 写入了非布尔字符串与非法 JSON
    memoryStorage.setItem(RIGHT_FOLD_KEY, JSON.stringify('expanded'))
    memoryStorage.setItem(LEFT_FOLD_KEY, '{broken')
    // When 初始化两侧 Store
    const chat = createFoldStore(RIGHT_FOLD_KEY, true)
    const market = createFoldStore(LEFT_FOLD_KEY, false)
    // Then 两侧安全回落默认态（会话列折叠、自选栏展开）
    expect(chat.getSnapshot()).toBe(true)
    expect(market.getSnapshot()).toBe(false)
  })
})
