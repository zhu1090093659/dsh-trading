/**
 * 文件持久化版统一资产台账 store（Node.js 宿主端专用）。
 *
 * 落 ~/.dsh/holdings/book.json，形状 `{ revision, staged, holdings }`（契约 §2）。
 * 读写骨架走 `@dshtrading/dsh-home` 的 {@link createRecordStoreAdapter}——跨进程排他锁 +
 * 锁内新鲜读盘 + 原子写 + **落盘成功后才发布缓存**（2026-10-09 多进程互相覆盖事故修复）；
 * 坏文件（JSON 损坏 / 形状不符）打错误日志并回退空台账——读侧不崩宿主
 * （knowledge-fs 同款纪律）。
 *
 * 读新鲜度（2026-10-12 补强）：readFromDisk 是**纯读**，缓存发布只发生在事务成功之后
 * ——写失败时本实例不会把未落盘的账发布进缓存；每次 load() 先核对磁盘签名，另一个实例
 * （桌面端/CLI）确认落盘的新持仓因此可见。
 */
import { createEmptyBook, createHoldingsStore } from './store-core.ts'
import { createRecordStoreAdapter, readStoreText } from '@dshtrading/dsh-home'
import type { HoldingsBook, HoldingsStore } from './types.ts'

const LOG_TAG = '[dsh-trading/holdings]'

export function createFileHoldingsStore(filePath: string): HoldingsStore {
  /** 读盘/解析失败的日志前缀（与既有 load 口径逐字一致，覆盖坏 JSON 与非 ENOENT 读失败）。 */
  const READ_FAILED = `${LOG_TAG} failed to read holdings book from ${filePath}; falling back to an empty book:`

  /**
   * 文本 → 台账：坏 JSON 与形状不符都回退空台账并打日志（不崩宿主）。
   * revision/staged/holdings 三字段的形状校验是本 store 的差异，不外包。
   */
  function decode(text: string | undefined): HoldingsBook {
    if (text === undefined) return createEmptyBook()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      console.error(READ_FAILED, err)
      return createEmptyBook()
    }
    const book = parsed as HoldingsBook
    if (
      typeof parsed !== 'object' || parsed === null
      || typeof book.revision !== 'number'
      || !Array.isArray(book.staged)
      || !Array.isArray(book.holdings)
    ) {
      console.error(`${LOG_TAG} holdings book ${filePath} has unexpected shape; falling back to an empty book`)
      return createEmptyBook()
    }
    return book
  }

  const store = createRecordStoreAdapter<HoldingsBook>({
    filePath,
    logPrefix: `${LOG_TAG} failed to atomic flush to`,
    // 纯粹的新鲜读盘（坏文件回退空台账并打日志）；供缓存与锁内重读共用，不发布缓存。
    readFromDisk: () => readStoreText(filePath, READ_FAILED),
    decode,
    encode: value => ({ revision: value.revision, staged: value.staged, holdings: value.holdings }),
  })

  async function load(): Promise<HoldingsBook> {
    return store.load()
  }

  /** 跨进程临界区：plan 在锁内新鲜读到的 book 上就地改；返回前已原子落盘。 */
  async function transact<T>(plan: (book: HoldingsBook) => T | Promise<T>): Promise<T> {
    let result: T | undefined
    await store.commit(async (fresh) => {
      result = await plan(fresh)
      return fresh
    })
    return result as T
  }

  return createHoldingsStore({ load, transact })
}
