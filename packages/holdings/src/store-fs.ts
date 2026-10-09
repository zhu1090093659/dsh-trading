/**
 * 文件持久化版统一资产台账 store（Node.js 宿主端专用）。
 *
 * 落 ~/.dsh/holdings/book.json，形状 `{ revision, staged, holdings }`（契约 §2）。
 * 写路径走 `@dshtrading/dsh-home` 的 {@link transactStore}——跨进程排他锁 + 锁内
 * 新鲜读盘 + 原子写（2026-10-09 多进程互相覆盖事故修复）；坏文件（JSON 损坏 /
 * 形状不符）打错误日志并回退空台账——读侧不崩宿主（knowledge-fs 同款纪律）。
 */
import { readFile } from 'node:fs/promises'
import { createEmptyBook, createHoldingsStore } from './store-core.ts'
import { transactStore } from '@dshtrading/dsh-home'
import type { HoldingsBook, HoldingsStore } from './types.ts'

const LOG_TAG = '[dsh-trading/holdings]'

export function createFileHoldingsStore(filePath: string): HoldingsStore {
  let cache: HoldingsBook | null = null

  /** 新鲜读盘（坏文件回退空台账并打日志）；供 load 与锁内重读共用。 */
  async function readFromDisk(): Promise<HoldingsBook> {
    let content: string
    try {
      content = await readFile(filePath, 'utf8')
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`${LOG_TAG} failed to read holdings book from ${filePath}; falling back to an empty book:`, err)
      }
      // ENOENT = 首启正常路径，静默起空台账。
      cache = createEmptyBook()
      return cache
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (err) {
      console.error(`${LOG_TAG} holdings book ${filePath} is not valid JSON; falling back to an empty book:`, err)
      cache = createEmptyBook()
      return cache
    }
    const book = parsed as HoldingsBook
    if (
      typeof parsed !== 'object' || parsed === null
      || typeof book.revision !== 'number'
      || !Array.isArray(book.staged)
      || !Array.isArray(book.holdings)
    ) {
      console.error(`${LOG_TAG} holdings book ${filePath} has unexpected shape; falling back to an empty book`)
      cache = createEmptyBook()
      return cache
    }
    cache = book
    return cache
  }

  async function load(): Promise<HoldingsBook> {
    if (cache !== null) return cache
    return readFromDisk()
  }

  /** 跨进程临界区：plan 在锁内新鲜读到的 book 上就地改；返回前已原子落盘。 */
  async function transact<T>(plan: (book: HoldingsBook) => T | Promise<T>): Promise<T> {
    let result: T | undefined
    await transactStore(
      filePath,
      readFromDisk,
      async (book) => {
        result = await plan(book)
        return book
      },
      book => ({ revision: book.revision, staged: book.staged, holdings: book.holdings }),
      `${LOG_TAG} failed to atomic flush to`,
    )
    return result as T
  }

  return createHoldingsStore({ load, transact })
}
