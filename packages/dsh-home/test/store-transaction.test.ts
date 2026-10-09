/**
 * 跨进程写保护共享层单测：{@link withHomeFileLock} 的排他/超时/陈旧回收，
 * 与 {@link transactStore} 的锁内读-改-写语义。
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HomeFileLockTimeoutError, SKIP_WRITE, transactStore, withHomeFileLock } from '../src/index.ts'

describe('withHomeFileLock', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-home-lock-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('用户拿到锁时锁文件存在，出临界区后锁文件被释放', async () => {
    // Given 一个目标文件与该文件的锁路径
    const file = join(dir, 'data.json')
    const lockPath = `${file}.lock`

    // When 进入临界区
    const seen = await withHomeFileLock(file, async () => {
      // Then 临界区内锁文件存在
      expect(statSync(lockPath).isFile()).toBe(true)
      return 'done'
    })

    // Then 返回值透传，且退出后锁文件已清理
    expect(seen).toBe('done')
    expect(() => statSync(lockPath)).toThrow()
  })

  it('管理员持锁时第二个等锁者超时，得到明确失败而非静默通过', async () => {
    // Given 一把被别人持有的锁（手工创建锁文件模拟另一进程）
    const file = join(dir, 'data.json')
    await mkdir(dir, { recursive: true })
    await writeFile(`${file}.lock`, JSON.stringify({ pid: 999999, host: 'other', at: Date.now() }), 'utf8')

    // When 以很短的超时去拿锁（陈旧阈值设大，保证不回收）
    const attempt = withHomeFileLock(file, async () => 'never', { timeoutMs: 120, staleMs: 60_000 })

    // Then 抛 HomeFileLockTimeoutError（明确失败），且不静默写盘
    await expect(attempt).rejects.toBeInstanceOf(HomeFileLockTimeoutError)
  })

  it('用户遇到崩溃进程留下的陈旧锁时，后来者按阈值回收并继续', async () => {
    // Given 一个 mtime 很旧、没有活进程持有的锁文件
    const file = join(dir, 'data.json')
    await mkdir(dir, { recursive: true })
    const lockPath = `${file}.lock`
    await writeFile(lockPath, JSON.stringify({ pid: 999999, host: 'gone', at: 0 }), 'utf8')
    writeFileSync(join(dir, 'seed'), 'x')
    // 把锁文件 mtime 拨到 1 小时前
    const { utimes } = await import('node:fs/promises')
    const old = new Date(Date.now() - 3_600_000)
    await utimes(lockPath, old, old)

    // When 以 30s 陈旧阈值拿锁
    const result = await withHomeFileLock(file, async () => 'reclaimed', { timeoutMs: 500, staleMs: 30_000 })

    // Then 陈旧锁被回收，临界区正常执行
    expect(result).toBe('reclaimed')
  })
})

describe('transactStore', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-home-tx-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const parseList = (text: string): string[] => {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed as string[] : []
  }

  it('用户两次交错写入时，第二次在锁内新鲜读盘上追加，两条都在盘上', async () => {
    // Given 一个空表文件
    const file = join(dir, 'list.json')
    const read = async (): Promise<string[]> => {
      try { return parseList(readFileSync(file, 'utf8')) } catch { return [] }
    }

    // When 两次独立事务各自追加一条（模拟两个进程各持陈旧视图）
    await transactStore(file, read, (onDisk) => [...onDisk, 'a'], rows => rows, '[test] flush')
    await transactStore(file, read, (onDisk) => [...onDisk, 'b'], rows => rows, '[test] flush')

    // Then 磁盘含两条
    expect(parseList(readFileSync(file, 'utf8'))).toEqual(['a', 'b'])
  })

  it('用户删除已不存在的条目时表达无变化，文件不被重写', async () => {
    // Given 一份已有的表
    const file = join(dir, 'list.json')
    await writeFile(file, JSON.stringify(['a']), 'utf8')
    const before = statSync(file).mtimeMs
    const read = async (): Promise<string[]> => parseList(readFileSync(file, 'utf8'))

    // When 一次实际无变化的事务返回 SKIP_WRITE
    const next = await transactStore(file, read, () => SKIP_WRITE, rows => rows, '[test] flush')

    // Then 返回锁内新鲜值，且文件 mtime 未变（没有空写）
    expect(next).toEqual(['a'])
    expect(statSync(file).mtimeMs).toBe(before)
  })
})
