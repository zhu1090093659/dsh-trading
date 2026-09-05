/**
 * JSON 原子写小工具（Node.js 宿主端专用）：tmp + rename 模式，
 * 逐行对齐 packages/knowledge/src/knowledge-fs.ts 的 flush 先例
 * （EPERM/EBUSY 重试 3 次、失败清理 tmp、错误日志带模块前缀）。
 */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeJsonAtomic(filePath: string, data: unknown, logTag: string): Promise<void> {
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
    console.error(`${logTag} failed to atomic flush to ${filePath}:`, error)
    await unlink(tmpPath).catch(() => {})
    throw error
  }
}
