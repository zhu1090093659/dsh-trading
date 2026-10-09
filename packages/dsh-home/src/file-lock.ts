/**
 * home 数据文件的跨进程排他锁（2026-10-09 事故「多进程整表回写互相覆盖」的机制基座）。
 *
 * 为什么不是 flock/fcntl：Node 无内建 flock，Windows 与网络盘语义不一致；锁文件
 * （O_EXCL 创建 + pid/host/心跳 mtime）三平台一致，且持锁进程崩溃后可由后来者按
 * 陈旧阈值回收——不依赖持锁者自己清理。
 *
 * 语义：进入临界区前必得锁；拿不到时等待（缺省 5s），仍拿不到抛
 * {@link HomeFileLockTimeoutError}——「明确告知失败」这条出路，绝不静默按陈旧
 * 快照写盘。持锁期间的临界区应只包住「读盘 + 合并 + 原子写」这一小段。
 */
import { mkdir, open, rename, stat, unlink, utimes } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'

export interface HomeFileLockOptions {
  /** 等锁上限（毫秒）；超时抛错，不静默降级。 */
  readonly timeoutMs?: number
  /** 锁文件 mtime 超过该毫秒数视为陈旧（持锁者已崩溃），可被后来者回收。 */
  readonly staleMs?: number
}

/** 等锁超时：本次调用按「明确失败」处理，磁盘上的数据保持持锁者的版本。 */
export class HomeFileLockTimeoutError extends Error {
  readonly lockPath: string
  readonly timeoutMs: number
  constructor(lockPath: string, timeoutMs: number) {
    super(`waiting for home file lock ${lockPath} timed out after ${timeoutMs}ms (another process holds it; this process wrote nothing)`)
    this.name = 'HomeFileLockTimeoutError'
    this.lockPath = lockPath
    this.timeoutMs = timeoutMs
  }
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_STALE_MS = 30_000
const RETRY_MS = 15

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * 陈旧锁回收：返回 true 表示可立刻重试拿锁（锁已不在，或已被本次回收）。
 *
 * 抢占用 rename 做原子裁决（同一陈旧 inode 只可能被一个进程搬走）；搬走后复核
 * mtime，若发现抢到的是别人刚重建的新锁（极窄窗口），原样搬回，避免误删活锁。
 */
async function reclaimIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  let ageMs: number
  try {
    ageMs = Date.now() - (await stat(lockPath)).mtimeMs
  } catch {
    return true
  }
  if (ageMs <= staleMs) return false
  const claimPath = `${lockPath}.stale-${process.pid}-${Date.now()}`
  try {
    await rename(lockPath, claimPath)
  } catch {
    return true
  }
  const claimed = await stat(claimPath).catch(() => undefined)
  if (claimed !== undefined && Date.now() - claimed.mtimeMs <= staleMs) {
    await rename(claimPath, lockPath).catch(() => unlink(claimPath).catch(() => {}))
    return false
  }
  await unlink(claimPath).catch(() => {})
  console.warn(`[dsh-home] reclaimed stale home file lock ${lockPath} (mtime older than ${staleMs}ms; the holding process likely crashed)`)
  return true
}

/** 在跨进程锁内执行 work；无论成功失败都释放锁（进程崩溃时由陈旧阈值兜底）。 */
export async function withHomeFileLock<T>(
  filePath: string,
  work: () => Promise<T>,
  options: HomeFileLockOptions = {},
): Promise<T> {
  const lockPath = `${filePath}.lock`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  await mkdir(dirname(filePath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let handle: FileHandle | undefined
  while (handle === undefined) {
    try {
      handle = await open(lockPath, 'wx')
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
    }
    if (handle !== undefined) break
    if (Date.now() >= deadline) throw new HomeFileLockTimeoutError(lockPath, timeoutMs)
    if (await reclaimIfStale(lockPath, staleMs)) continue
    await delay(RETRY_MS)
  }
  // 心跳：临界区比陈旧阈值长时（含等待 rename 退避）刷新 mtime，锁不会被误回收。
  const heartbeat = setInterval(() => {
    const now = new Date()
    void utimes(lockPath, now, now).catch(() => {})
  }, Math.max(1_000, Math.floor(staleMs / 3)))
  heartbeat.unref?.()
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }), 'utf8')
    return await work()
  } finally {
    clearInterval(heartbeat)
    await handle.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
  }
}
