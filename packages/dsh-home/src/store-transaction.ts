/**
 * 整表 JSON 的跨进程「锁内读 - 改 - 原子写」（2026-10-09 事故修复的共享入口）。
 *
 * 背景：下列 store 都是「进程内内存缓存 + 整表回写」，两个宿主进程共用同一
 * DSH_HOME 时后写者用自己那份陈旧快照覆盖先写者（last-writer-wins，静默丢数据；
 * 实测抹掉 indicators/chart.json 的 symbolParams 与 hiddenScopes）。
 *
 * {@link transactStore} 是全仓唯一的跨进程临界区实现，各 store 只调它，不各自复制：
 * 1. 取该文件的跨进程排他锁（{@link withHomeFileLock}）；
 * 2. 锁内**新鲜重读磁盘**（readFromDisk，不是进临界区前的缓存）；
 * 3. mutate 在这份新鲜值上做本次修改并返回新的内存值；
 * 4. tmp+rename 原子写落盘，返回值即调用方应缓存的当前值。
 *
 * 「读 - 改」整体在锁内，所以两个进程各自的**新增、删除**都不丢：后到者是在先到者的
 * 结果上继续改，而不是用陈旧快照覆盖。这是「先读回并合并双方数据」的具体形态，
 * 而不是「拒绝第二实例写」——本机桌面端与 CLI 长期共用同一 home，拒绝写会让第二
 * 实例完全存不了设置。等锁超时抛 {@link HomeFileLockTimeoutError}：那是明确失败，
 * 绝不静默按陈旧快照覆盖。
 *
 * 合并粒度是条目（行表按 id、嵌套表按各自键）：同一条目被两个进程同时改时，后写者
 * 在该条目上的整条值胜出（不做字段级三方合并，见 note 的 Residue）。
 *
 * 幂等 no-op（删除不存在的 id、重复写入同值）由调用方在 mutate 里返回
 * {@link SKIP_WRITE} 表达——此时不落盘（保持既有「无变化不重写」语义），返回值仍是
 * 锁内新鲜读到的值，调用方缓存照旧刷新。
 */
import { withHomeFileLock, type HomeFileLockOptions } from './file-lock.ts'
import { writeJsonAtomic } from './fs-atomic.ts'

/** 合并入口的缺省等锁上限：比 store 内部调用更宽松，避免正常并发被误判超时。 */
const DEFAULT_TIMEOUT_MS = 10_000

/** mutate 返回它表示「本次无内容变化」：不落盘，但缓存仍取锁内新鲜值。 */
export const SKIP_WRITE: unique symbol = Symbol('dsh-home:skip-write')

/** {@link SKIP_WRITE} 的类型形态：写 mutate 签名时用它标注「可能无变化」。 */
export type SkipWrite = typeof SKIP_WRITE

export interface TransactStoreOptions {
  /** 等锁上限（毫秒）；超时抛 {@link HomeFileLockTimeoutError}。 */
  readonly timeoutMs?: number
  /** 陈旧锁回收阈值（毫秒）。 */
  readonly staleMs?: number
}

function lockOptionsOf(options: TransactStoreOptions): HomeFileLockOptions {
  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}),
  }
}

/**
 * 在跨进程锁内读-改-写一份 JSON 表。
 *
 * @param filePath - 目标 JSON 文件
 * @param readFromDisk - **新鲜**读盘（不得回传内存缓存）；由各 store 提供 parse
 *   感知的读取，使坏形/坏 JSON 的降级口径与自身 load() 一致
 * @param mutate - 在锁内新鲜值上做本次修改；返回新内存值，或 {@link SKIP_WRITE}
 *   表示无变化不落盘
 * @param serialize - 新内存值 → 落盘形状（数组、按 id 为键的对象、容器包裹皆可）
 * @param logPrefix - 失败日志前缀，与各 store 原 writeJsonAtomic 调用逐字一致
 * @returns 落盘后的当前值（SKIP_WRITE 时即锁内新鲜值）
 */
export async function transactStore<T>(
  filePath: string,
  readFromDisk: () => Promise<T>,
  mutate: (onDisk: T) => T | SkipWrite | Promise<T | SkipWrite>,
  serialize: (value: T) => unknown,
  logPrefix: string,
  options: TransactStoreOptions = {},
): Promise<T> {
  return withHomeFileLock(filePath, async () => {
    const onDisk = await readFromDisk()
    const next = await mutate(onDisk)
    if (next === SKIP_WRITE) return onDisk
    await writeJsonAtomic(filePath, serialize(next), logPrefix)
    return next
  }, lockOptionsOf(options))
}
