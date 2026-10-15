/**
 * 「记录 store 适配器」（{@link createRecordStoreAdapter}）单测：各文件版 store 共用的
 * 骨架——锁内新鲜读盘 → 事务写 → **落盘成功后才发布缓存**。
 *
 * 用例只做真实文件 I/O：故障注入走适配器自己的注入缝（readFromDisk / decode / encode），
 * 不用通用 mock 工具——encode 抛错即「落盘前失败」，写盘失败另有真实用例（目标路径是目录）。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRecordStoreAdapter, readStoreText } from '../src/index.ts'
import type { RecordStoreAdapter, RecordStoreAdapterOptions } from '../src/index.ts'

/** 与各 store 同款降级口径的测试解码：无文件 / 坏 JSON / 坏形状一律降级空表（不抛）。 */
function decodeTable(text: string | undefined): string[] {
  if (text === undefined) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed as string[] : []
  } catch (error) {
    console.error('[test] list table is not valid JSON; falling back to an empty table:', error)
    return []
  }
}

/** 真实文件 + 真实 JSON 编解码的适配器；三个回调可按需覆写以注入故障。 */
function recordStore(
  file: string,
  overrides: Partial<RecordStoreAdapterOptions<string[]>> = {},
): RecordStoreAdapter<string[]> {
  return createRecordStoreAdapter<string[]>({
    filePath: file,
    logPrefix: '[test] flush',
    readFromDisk: () => readStoreText(file, '[test] read'),
    decode: decodeTable,
    encode: (rows) => rows,
    ...overrides,
  })
}

const readDisk = (file: string): string[] => JSON.parse(readFileSync(file, 'utf8')) as string[]

describe('createRecordStoreAdapter', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-home-record-store-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('用户读一个尚不存在的 store 文件时得到「无内容」而不是错误', async () => {
    // Given 一个不存在的文件路径
    const file = join(dir, 'not-created-yet.json')

    // When 纯读该文件
    const text = await readStoreText(file, '[test] read')

    // Then 无内容（ENOENT 是首启正常路径，不抛、不算失败）
    expect(text).toBeUndefined()
    // And 适配器据此降级空表
    expect(await recordStore(file).load()).toEqual([])
  })

  it('用户落盘前编码失败时，事务明确失败且未落盘的新值不会被读到', async () => {
    // Given 一份已落盘的表 ['a']，与一个编码阶段必定抛错的适配器（缓存已装载）
    const file = join(dir, 'list.json')
    writeFileSync(file, JSON.stringify(['a']), 'utf8')
    const store = recordStore(file, {
      encode: () => { throw new Error('disk is full') },
    })
    expect(await store.load()).toEqual(['a'])

    // When 一次把 'b' 追加进表的事务，在落盘前的编码阶段失败
    const attempt = store.commit(rows => [...rows, 'b'])

    // Then 事务明确失败（不静默降级成成功）
    await expect(attempt).rejects.toThrow('disk is full')
    // And 未确认的新值不进入缓存：下一次读取仍是磁盘上的 ['a']
    expect(await store.load()).toEqual(['a'])
    // And 再下一次读取同样以磁盘为准（不是「第一次读碰巧对了」）
    expect(await store.load()).toEqual(['a'])
    // And 磁盘本身没被这次失败的事务改动
    expect(readDisk(file)).toEqual(['a'])
  })

  it('用户写盘路径失败时，事务明确失败、不留半成品 tmp、缓存不发布', async () => {
    // Given 目标路径其实是一个目录（真实的落盘目标不合法），适配器读失败降级空表
    const file = join(dir, 'data.json')
    mkdirSync(file)
    const store = recordStore(file)
    expect(await store.load()).toEqual([])

    // When 一次往表里追加 'a' 的事务（原子替换一个目录必然失败）
    const attempt = store.commit(rows => [...rows, 'a'])

    // Then 事务明确失败
    await expect(attempt).rejects.toThrow()
    // And 未落盘的新值不会被读到（缓存没有提前发布）
    expect(await store.load()).toEqual([])
    // And 目录里没有残留下来的 tmp 半成品（失败路径自行清理），目标路径也没被替换
    expect(readdirSync(dir).filter(name => name.startsWith('data.json.tmp.'))).toEqual([])
    expect(statSync(file).isDirectory()).toBe(true)
  })

  it('用户一次成功落盘后，另一实例的下一次读取能看到新值', async () => {
    // Given 两个实例都已把空表读进缓存
    const file = join(dir, 'list.json')
    const desktop = recordStore(file)
    const cli = recordStore(file)
    expect(await desktop.load()).toEqual([])
    expect(await cli.load()).toEqual([])

    // When 桌面端落盘一条
    await desktop.commit(rows => [...rows, 'x'])

    // Then CLI 的下一次读取看到它（缓存不永久命中陈旧快照）
    expect(await cli.load()).toEqual(['x'])
    expect(readDisk(file)).toEqual(['x'])
  })

  it('用户两个实例各自追加时，后到者在锁内新鲜表上继续追加，两条都在盘上', async () => {
    // Given 两个实例都持有同一份陈旧空表
    const file = join(dir, 'list.json')
    const desktop = recordStore(file)
    const cli = recordStore(file)
    expect(await desktop.load()).toEqual([])
    expect(await cli.load()).toEqual([])

    // When 两边各追加一条（CLI 用的是自己那份陈旧视图）
    await desktop.commit(rows => [...rows, 'a'])
    await cli.commit(rows => [...rows, 'b'])

    // Then 两条都在盘上：后到者是在锁内新鲜值上改，而不是用陈旧快照覆盖
    expect(readDisk(file)).toEqual(['a', 'b'])
    expect(await desktop.load()).toEqual(['a', 'b'])
  })
})
