/**
 * 测试全局 setup：每个用例前清空浏览器存储。
 *
 * 客户端 store 把状态持久化到 localStorage（如 `dshtrading.watchlist.v1`、
 * `dshtrading.tradeDesk.open`）。CI 的 node 22 没有全局 storage，vitest 按文件里的
 * `@vitest-environment jsdom` 装上真存储，于是上一条用例写下的数据会被下一条水合；
 * 本机 node 25 的全局 localStorage 又只有空壳（setItem/clear 都不是函数），store
 * 静默降级。三种形态都必须不抛——探测到能清就清，清不了就当没有可清的。
 */
import { beforeEach } from 'vitest'

const STORAGE_NAMES = ['localStorage', 'sessionStorage'] as const

function clearStorage(host: unknown, name: string): void {
  try {
    const storage = (host as Record<string, unknown> | undefined)?.[name] as { clear?: unknown } | undefined
    if (typeof storage?.clear !== 'function') return
    ;(storage.clear as () => void).call(storage)
  } catch {
    // 访问器本身抛错、隐私模式拒绝写入、或方法被换成非函数：都只为这一件事服务，
    // 清不掉不该让用例变红。
  }
}

beforeEach(() => {
  // 纯 node 环境没有 DOM 存储：store 一律经 window 读写，globalThis 上的
  // localStorage 是 node 自带的桩（碰它只会告警），没有可清的东西。
  const host = (globalThis as { window?: unknown }).window
  if (typeof host === 'undefined') return
  for (const name of STORAGE_NAMES) {
    clearStorage(host, name)
    clearStorage(globalThis, name)
  }
})
