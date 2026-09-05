/**
 * 文件持久化版统一资产台账 store（Node.js 宿主端专用）。
 *
 * 落 ~/.dsh/holdings/book.json，形状 `{ revision, staged, holdings }`（契约 §2）；
 * 原子写走 fs-atomic.ts（tmp + rename，knowledge-fs 先例）；坏文件（JSON 损坏 /
 * 形状不符）打错误日志并回退空台账——读侧不崩宿主（knowledge-fs 同款纪律）。
 */
import { readFile } from 'node:fs/promises'
import { createEmptyBook, createHoldingsStore } from './store-core.ts'
import { writeJsonAtomic } from './fs-atomic.ts'
import type { HoldingsBook, HoldingsStore } from './types.ts'

const LOG_TAG = '[dsh-trading/holdings]'

export function createFileHoldingsStore(filePath: string): HoldingsStore {
  let cache: HoldingsBook | null = null

  async function load(): Promise<HoldingsBook> {
    if (cache !== null) return cache
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

  async function flush(book: HoldingsBook): Promise<void> {
    await writeJsonAtomic(filePath, { revision: book.revision, staged: book.staged, holdings: book.holdings }, LOG_TAG)
  }

  return createHoldingsStore({ load, flush })
}
