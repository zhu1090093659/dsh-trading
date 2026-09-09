/** writeJsonAtomic 单测：正常落盘形状、目录自创建、失败清理 tmp 且旧文件保留。 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeJsonAtomic } from '../src/fs-atomic.ts'

describe('writeJsonAtomic', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-home-atomic-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('正常写入：目录自创建 + 2 空格缩进 JSON + 无 tmp 残留', async () => {
    const file = join(dir, 'sub', 'data.json')
    await writeJsonAtomic(file, { a: 1, b: ['x'] }, '[test] failed to write')
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify({ a: 1, b: ['x'] }, null, 2))
    expect(readdirSync(join(dir, 'sub'))).toEqual(['data.json'])
  })

  it('重写覆盖旧内容（rename 原子替换语义）', async () => {
    const file = join(dir, 'data.json')
    writeFileSync(file, '{"old":true}', 'utf8')
    await writeJsonAtomic(file, { fresh: 1 }, '[test] failed to write')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fresh: 1 })
  })

  it('目标父路径是文件 → throw 且不产生新文件', async () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a dir', 'utf8')
    const file = join(blocker, 'data.json')
    await expect(writeJsonAtomic(file, { a: 1 }, '[test] failed to write')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['blocker'])
  })
})
