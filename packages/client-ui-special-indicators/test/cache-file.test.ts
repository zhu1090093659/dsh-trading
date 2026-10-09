/**
 * 桥缓存落盘文件契约测试：地址变更判废、版本失配判废、损坏文件静默冷启、
 * 写盘原子落地。零 mock：真实临时目录 + 真实文件读写，flush() 排空代替轮询等待。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileCachePersistence, defaultCacheFilePath } from '../src/cache-file.ts'

let dir = ''
let filePath = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'si-cache-'))
  filePath = join(dir, 'nested', 'cache.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('桥缓存落盘文件', () => {
  it('用户未显式指定路径时落在 trading home 的 special-indicators 下', () => {
    // Given: DSH_HOME 钉到临时 trading home（home-guard-allow: 受控测试 fixture，
    //        仅解析路径，不写用户真实 home）
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = join(dir, 'trading-home')
    try {
      // When: 取缺省缓存路径
      const resolved = defaultCacheFilePath()
      // Then: 落在 <DSH_HOME>/special-indicators/cache.json
      expect(resolved).toBe(join(dir, 'trading-home', 'special-indicators', 'cache.json'))
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })

  it('用户首次运行没有缓存文件时冷启为空，不抛错', () => {
    // Given: 目录下没有任何缓存文件
    const port = createFileCachePersistence({ baseUrl: 'https://a.test', filePath })
    // When: 宿主启动补水
    const loaded = port.load()
    // Then: 空对象（冷启动是正常路径，不是错误）
    expect(loaded).toEqual({})
  })

  it('用户写盘后新进程能读回同一份缓存（跨重启保留）', async () => {
    // Given: 一个已写盘的缓存端口
    const port = createFileCachePersistence({ baseUrl: 'https://a.test', filePath })
    // When: 写入两条缓存并排空落盘
    port.save({ '/api/snapshot': { at: 1000, payload: { v: 1 } }, '/api/snapshot2': { at: 2000, payload: { v: 2 } } })
    await port.flush()
    // Then: 新进程（新端口实例）读回同一份数据
    const reopened = createFileCachePersistence({ baseUrl: 'https://a.test', filePath }).load()
    expect(reopened).toEqual({ '/api/snapshot': { at: 1000, payload: { v: 1 } }, '/api/snapshot2': { at: 2000, payload: { v: 2 } } })
  })

  it('用户换过上游地址后旧缓存判废，不把另一套数据面当命中', async () => {
    // Given: baseUrl=a 写下的缓存
    const port = createFileCachePersistence({ baseUrl: 'https://a.test', filePath })
    port.save({ '/api/snapshot': { at: 1000, payload: { v: 'from-a' } } })
    await port.flush()
    // When: baseUrl 换成 b 后读
    const loaded = createFileCachePersistence({ baseUrl: 'https://b.test', filePath }).load()
    // Then: 判废为空（宁冷拉，不用错源数据）
    expect(loaded).toEqual({})
  })

  it('用户缓存文件损坏时静默冷启，不阻塞宿主启动', async () => {
    // Given: 一个非法 JSON 的缓存文件
    const port = createFileCachePersistence({ baseUrl: 'https://a.test', filePath })
    port.save({})
    await port.flush()
    writeFileSync(filePath, '{ this is not json')
    // When: 读回
    // Then: 空对象，不抛
    expect(port.load()).toEqual({})
  })

  it('用户遇到旧 schema 版本的缓存文件时判废，不按新结构误读', async () => {
    // Given: v:0 的旧信封
    const port = createFileCachePersistence({ baseUrl: 'https://a.test', filePath })
    port.save({})
    await port.flush()
    writeFileSync(filePath, JSON.stringify({ v: 0, baseUrl: 'https://a.test', entries: { '/x': { at: 1, payload: {} } } }))
    // When: 读回
    // Then: 判废为空
    expect(port.load()).toEqual({})
  })

  it('用户多次写盘按序落笔，flush 承诺后文件为最后一次内容', async () => {
    // Given: 同一端口连续写两次
    const port = createFileCachePersistence({ baseUrl: 'https://a.test', filePath })
    // When: 两次 save 后 flush
    port.save({ '/api/snapshot': { at: 1, payload: { v: 'first' } } })
    port.save({ '/api/snapshot': { at: 2, payload: { v: 'second' } } })
    await port.flush()
    // Then: 文件为最后一次内容（串行落盘，后写覆盖先写）
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { entries: Record<string, { payload: { v: string } }> }
    expect(raw.entries['/api/snapshot']?.payload.v).toBe('second')
  })
})
