/**
 * 「记录 store 适配器」：把各包文件版 store 各自复制的同一段骨架收敛成一处——
 * **锁内新鲜读盘 → 事务写 → 落盘成功后才发布缓存**（{@link transactStore} 与
 * {@link createStoreCache} 的组合形态，2026-10-09 跨进程覆盖事故 + 2026-10-12
 * 读新鲜度两次修复的共享入口）。
 *
 * 分工（本模块刻意不认识任何领域类型，也不 import 任何业务包）：
 * - dsh-home 只拥有「怎么读、怎么写、什么时候发布缓存」的骨架；
 * - 三个回调由各 store 提供：{@link RecordStoreAdapterOptions.readFromDisk} 是
 *   **纯读**（把文件读成文本，不发布缓存、不就地改缓存对象），
 *   {@link RecordStoreAdapterOptions.decode} 把文本变成内存值（解析 + 校验 +
 *   **各自 store 的降级口径**），{@link RecordStoreAdapterOptions.encode} 把内存值
 *   变回落盘形状。
 * - 因此 knowledge 的作者别名归一、chart-activations 的 sanitizeInstance、holdings
 *   的三字段形状校验、tombstones 的 Set 形态、watchlist 的多文件形态，全部留在各包
 *   decode 里，逐字不变。
 *
 * 为什么读盘要拆成「纯读 + decode」两半：坏 JSON 与非 ENOENT 读失败在各 store 里都
 * 是同一条 catch 分支（同一条日志文案、同一个降级值），所以「读失败日志」由纯读一侧
 * 负责（{@link readStoreText}），「解析失败降级」由 decode 一侧负责，两半合起来与
 * 各 store 原来的单函数逐分支等价。
 */
import { readFile } from 'node:fs/promises'
import { createStoreCache, transactStore, type SkipWrite, type TransactStoreOptions } from './store-transaction.ts'

/** mutate 的返回形态，与 {@link transactStore} 的 mutate 完全一致。 */
export type RecordStoreMutate<T> = (onDisk: T) => T | SkipWrite | Promise<T | SkipWrite>

export interface RecordStoreAdapterOptions<T> {
  /** 目标 JSON 文件。 */
  readonly filePath: string
  /**
   * 写失败的日志前缀，逐字透传给 {@link transactStore}（各 store 文案不同，属可观察行为）。
   */
  readonly logPrefix: string
  /**
   * **纯读**：把文件读成文本。无文件（ENOENT）与读失败都以 `undefined` 上报，
   * 由 decode 决定降级成什么。不得回传内存缓存，也不得借它发布缓存。
   */
  readonly readFromDisk: () => Promise<string | undefined>
  /**
   * 文本 → 内存值：解析 + 校验 + 降级（坏 JSON / 形状不符 / 无文件的口径由各 store 决定，
   * 领域类型与降级纪律都不出包）。
   */
  readonly decode: (text: string | undefined) => T
  /** 内存值 → 落盘形状（数组、Set、容器包裹皆可）。 */
  readonly encode: (value: T) => unknown
  /** 等锁上限（毫秒），透传 {@link transactStore}。 */
  readonly timeoutMs?: number
  /** 陈旧锁回收阈值（毫秒），透传 {@link transactStore}。 */
  readonly staleMs?: number
}

export interface RecordStoreAdapter<T> {
  /** 取当前新鲜值：磁盘签名未变时用缓存，变了（或没发布过签名）则重新纯读 + decode。 */
  load(): Promise<T>
  /**
   * 跨进程锁内：新鲜纯读 + decode → mutate → encode + 原子写 → **落盘成功后才** replace
   * 缓存。落盘失败时抛出且缓存保持旧值（未确认的值绝不提前进入缓存）。
   */
  commit(mutate: RecordStoreMutate<T>): Promise<T>
}

/**
 * 纯读一个 store 文件为文本。
 *
 * - ENOENT（首启的正常路径）静默返回 `undefined`；
 * - 其他读失败按 `errorMessage` 记一条 error 后同样返回 `undefined`（降级值由 decode 决定，
 *   与各 store 原来的读盘口径逐字一致）；
 * - 不做任何解析，也不发布缓存——调用链上唯一的发布点是 {@link RecordStoreAdapter.commit}
 *   成功之后。
 */
export async function readStoreText(filePath: string, errorMessage: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') console.error(errorMessage, error)
    return undefined
  }
}

/**
 * 建一个文件版记录 store 的适配器：缓存 + 跨进程事务 + 「成功才发布」三件事一次装好。
 *
 * @param options - 文件路径、写失败日志前缀与三个回调（纯读 / decode / encode）。
 * @returns {@link RecordStoreAdapter}：`load()` 供各 store 的 list/get 用，`commit()` 供写路径用。
 */
export function createRecordStoreAdapter<T>(options: RecordStoreAdapterOptions<T>): RecordStoreAdapter<T> {
  const { filePath, logPrefix, readFromDisk, decode, encode } = options
  const lockOptions: TransactStoreOptions = {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}),
  }
  /** 新鲜读：纯读 + decode，不发布缓存；缓存与锁内重读共用同一入口。 */
  const fresh = async (): Promise<T> => decode(await readFromDisk())
  const cache = createStoreCache(filePath, fresh)
  return {
    load: () => cache.load(),
    async commit(mutate: RecordStoreMutate<T>): Promise<T> {
      const next = await transactStore(filePath, fresh, mutate, encode, logPrefix, lockOptions)
      // 只有成功落盘才发布：写失败时缓存保持旧值（不提前 publish 未确认的值）。
      cache.replace(next)
      return next
    },
  }
}
