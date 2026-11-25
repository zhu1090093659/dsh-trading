/**
 * home 数据文件原子写单一实现（2026-09-09 收敛，原为 7 个包的 9+ 处同体副本）：
 * tmp（唯一名）+ rename，EPERM/EBUSY（Windows 目标占用）25ms 退避重试 3 次；
 * 重试耗尽或任何失败保留旧文件、清理 tmp、log + throw——目标文件永远只被
 * 原子 rename 触碰，绝不非原子直写（半截写会损坏 JSON 导致 load 静默重置）。
 *
 * 耐久性（2026-10-12 补强）：rename 前对 tmp 的**文件描述符** fsync，rename 后对
 * **父目录** fsync——新内容与「改名已发生」各有明确同步点，而不是只把数据交给
 * 页缓存。同步失败不静默降级：目录 fsync 只在平台/文件系统**明确不支持**时
 * （Windows 无法以句柄打开目录；部分网络盘）记一行告警后跳过，其余同步错误一律
 * 上抛——「无法确认耐久」必须响亮，不能装成功。
 *
 * logPrefix 是失败日志在文件路径之前的完整前缀，逐字保留各调用方既有日志
 * （如 '[dsh-trading/knowledge] failed to atomic flush knowledge cards to'）。
 */
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'

/** rename 目标被占用（Windows 常见）时可退避重试的 errno。 */
const RENAME_BUSY_CODES = new Set(['EPERM', 'EBUSY'])

/**
 * 目录 fsync 在平台/文件系统层面不支持时的 errno：Windows 无法以文件句柄打开
 * 目录（EISDIR/EPERM/EINVAL），部分网络盘/容器返回 ENOTSUP/ENOSYS。只有这类
 * 「能力缺失」可容忍；EACCES/ENOENT/IO 错误等真正的同步失败一律上抛。
 */
const DIR_SYNC_UNSUPPORTED_CODES = new Set(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP', 'ENOSYS'])

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
}

let warnedDirSyncUnsupported = false

/** 平台不支持目录 fsync 时明确告知一次（明确受限 ≠ 静默吞掉所有错误）。 */
function warnDirSyncUnsupported(dir: string, code: string | undefined): void {
  if (warnedDirSyncUnsupported) return
  warnedDirSyncUnsupported = true
  console.warn(
    `[dsh-home] directory fsync is unsupported on this platform/fs (${code ?? 'unknown'}) for ${dir}; `
    + 'rename durability is limited to the file fsync (other sync errors are still surfaced)',
  )
}

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms) })

/** 对父目录 fsync，让 rename 本身持久化；不支持的平台明确受限，其余错误上抛。 */
async function fsyncDirectory(dir: string): Promise<void> {
  let handle: FileHandle
  try {
    handle = await open(dir, 'r')
  } catch (error) {
    if (!DIR_SYNC_UNSUPPORTED_CODES.has(errorCode(error) ?? '')) throw error
    warnDirSyncUnsupported(dir, errorCode(error))
    return
  }
  let failure: unknown
  try {
    await handle.sync()
  } catch (error) {
    if (DIR_SYNC_UNSUPPORTED_CODES.has(errorCode(error) ?? '')) warnDirSyncUnsupported(dir, errorCode(error))
    else failure = error
  }
  try {
    await handle.close()
  } catch (error) {
    failure ??= error
  }
  if (failure !== undefined) throw failure
}

export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  logPrefix: string,
  options?: { readonly mode?: number | undefined },
): Promise<void> {
  const dir = dirname(filePath)
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const text = JSON.stringify(data, null, 2)
  let tmpPresent = false
  try {
    await mkdir(dir, { recursive: true })
    const handle = options?.mode === undefined
      ? await open(tmpPath, 'wx')
      : await open(tmpPath, 'wx', options.mode)
    tmpPresent = true
    let failure: unknown
    try {
      await handle.writeFile(text, 'utf8')
      // 显式 fd fsync：rename 之前先把新内容刷到盘，rename 之后才不会指向未落盘的数据。
      await handle.sync()
    } catch (error) {
      failure = error
    }
    try {
      await handle.close()
    } catch (error) {
      failure ??= error
    }
    if (failure !== undefined) throw failure

    let renameError: unknown
    let renamed = false
    for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
      try {
        await rename(tmpPath, filePath)
        renamed = true
      } catch (error) {
        if (!RENAME_BUSY_CODES.has(errorCode(error) ?? '')) throw error
        renameError = error
        await delay(25 * (attempt + 1))
      }
    }
    if (!renamed) throw renameError
    tmpPresent = false
    // rename 之后 fsync 父目录：让「文件已改名」这件事本身持久化。
    await fsyncDirectory(dir)
  } catch (error) {
    console.error(`${logPrefix} ${filePath}:`, error)
    if (tmpPresent) await unlink(tmpPath).catch(() => {})
    throw error
  }
}
