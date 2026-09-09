/**
 * home 数据文件原子写单一实现（2026-09-09 收敛，原为 7 个包的 9+ 处同体副本）：
 * tmp（唯一名）+ rename，EPERM/EBUSY（Windows 目标占用）25ms 退避重试 3 次；
 * 重试耗尽或任何失败保留旧文件、清理 tmp、log + throw——目标文件永远只被
 * 原子 rename 触碰，绝不非原子直写（半截写会损坏 JSON 导致 load 静默重置）。
 *
 * logPrefix 是失败日志在文件路径之前的完整前缀，逐字保留各调用方既有日志
 * （如 '[dsh-trading/knowledge] failed to atomic flush knowledge cards to'）。
 */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeJsonAtomic(filePath: string, data: unknown, logPrefix: string): Promise<void> {
  const dir = dirname(filePath)
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const text = JSON.stringify(data, null, 2)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(tmpPath, text, 'utf8')
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rename(tmpPath, filePath)
        return
      } catch (err: any) {
        if (err?.code !== 'EPERM' && err?.code !== 'EBUSY') throw err
        lastError = err
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
      }
    }
    throw lastError
  } catch (error) {
    console.error(`${logPrefix} ${filePath}:`, error)
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}
