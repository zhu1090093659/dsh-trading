/**
 * knowledge_export / knowledge_import 两个 agent 工具的行为契约。
 *
 * 用真实内存 store（createMemoryKnowledgeCardStore）+ 真实临时目录：
 * 零 mock、零 sleep——路径解析、目录递归创建、跳过/写库都是真跑出来的。
 *
 * home-guard-allow: 只有"省略 path 时落到 $DSH_HOME/knowledge/exports"这一例需要把
 * DSH_HOME 钉到 mkdtemp 出来的临时目录（默认路径由 dshHomeDir() 读进程环境决定，没有
 * 注入缝）；afterEach 无条件还原/删除该变量，不触碰任何真实 home。
 */
import { afterEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createKnowledgeBundle, parseKnowledgeBundle, serializeKnowledgeBundle } from '../src/bundle.ts'
import { createMemoryKnowledgeCardStore } from '../src/store-memory.ts'
import { createKnowledgeExportTool, createKnowledgeImportTool } from '../src/tool.ts'
import type { KnowledgeCard } from '../src/types.ts'

type ExecutableTool = { execute(raw: Record<string, unknown>): Promise<string> }

function exec(tool: unknown, raw: Record<string, unknown>): Promise<string> {
  return (tool as ExecutableTool).execute(raw)
}

const BUNDLE_NOW = new Date('2026-03-01T08:00:00.000Z')

function card(id: string, overrides: Partial<KnowledgeCard> = {}): KnowledgeCard {
  return {
    id,
    title: `卡片 ${id}`,
    summary: '一句话概述',
    source: { type: 'bilibili', url: `https://www.bilibili.com/video/${id}`, author: '行业研究员' },
    credibility: 'high',
    coreClaims: ['论点一'],
    factCheck: { verified: ['证实一'], discrepancies: [], unverifiable: [] },
    takeaways: ['经验一'],
    boundaries: ['边界一'],
    tags: ['宏观', '利率'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
}

const roots: string[] = []
const previousHome = process.env.DSH_HOME

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kn_bundle_'))
  roots.push(dir)
  return dir
}

/** 把卡片写成临时 bundle 文件并返回其绝对路径。 */
async function writeBundle(cards: readonly KnowledgeCard[]): Promise<string> {
  const filePath = path.join(await tempDir(), 'bundle.json')
  await writeFile(filePath, serializeKnowledgeBundle(createKnowledgeBundle(cards, { now: BUNDLE_NOW })), 'utf8')
  return filePath
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() ?? '', { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

describe('Knowledge Export Tool', () => {
  it('用户按标签筛选导出知识卡片时文件里只包含命中的卡片', async () => {
    // Given: 三张卡片，两张带「宏观」标签、一张只带「加密」
    const store = createMemoryKnowledgeCardStore([
      card('kc_1', { tags: ['宏观'] }),
      card('kc_2', { tags: ['宏观', '利率'] }),
      card('kc_3', { tags: ['加密'] }),
    ])
    const target = path.join(await tempDir(), 'nested', 'deeper', 'bundle.json')

    // When: 用 tags=宏观 导出到还不存在的子目录
    const result = await exec(createKnowledgeExportTool(store), { path: target, tags: '宏观' })

    // Then: 回显绝对路径与卡片数，文件里恰好两张且目录被递归创建
    expect(result).toContain('[knowledge_export] 已导出 2 张卡片')
    expect(result).toContain('标签命中任一: 宏观')
    expect(result).toContain(target)
    const parsed = parseKnowledgeBundle(await readFile(target, 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.bundle.cards.map((item) => item.id).sort()).toEqual(['kc_1', 'kc_2'])
    expect(parsed.bundle.meta.cardCount).toBe(2)
  })

  it('用户省略导出路径时 bundle 落在 $DSH_HOME/knowledge/exports 下并回显全库', async () => {
    // Given: 一个显式指定的 home 目录与一张卡片
    const home = await tempDir()
    process.env.DSH_HOME = home
    const store = createMemoryKnowledgeCardStore([card('kc_only')])

    // When: 不带 path 全库导出
    const result = await exec(createKnowledgeExportTool(store), {})

    // Then: 回报里带「全库」与带时间戳的绝对路径，文件可被解析回同一张卡
    expect(result).toContain('全库')
    const matched = /文件: (.+)/.exec(result)
    expect(matched).not.toBeNull()
    const filePath = matched === null ? '' : matched[1].trim()
    expect(filePath).toBe(path.join(home, 'knowledge', 'exports', path.basename(filePath)))
    expect(path.basename(filePath)).toMatch(/^knowledge-\d{8}-\d{6}\.json$/)
    const parsed = parseKnowledgeBundle(await readFile(filePath, 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.bundle.cards.map((item) => item.id)).toEqual(['kc_only'])
  })

  it('用户导出到不可写路径时看到显式失败文本而不抛异常', async () => {
    // Given: 目标路径是一个已存在的目录（无法当文件写）
    const store = createMemoryKnowledgeCardStore([card('kc_1')])
    const dir = await tempDir()

    // When: 把目录当文件路径导出
    const result = await exec(createKnowledgeExportTool(store), { path: dir })

    // Then: 回报以显式失败前缀开头，不向外抛
    expect(result.startsWith('[knowledge_export] 导出失败:')).toBe(true)
  })
})

describe('Knowledge Import Tool', () => {
  it('用户用 dryRun 预览导入时库中不新增卡片也不通知写库', async () => {
    // Given: 一个两张卡的 bundle 与一个空库，写库回调计数
    const filePath = await writeBundle([card('kc_x'), card('kc_y')])
    const store = createMemoryKnowledgeCardStore()
    let written = 0
    const tool = createKnowledgeImportTool(store, { onWritten: () => { written += 1 } })

    // When: dryRun 预览
    const result = await exec(tool, { path: filePath, dryRun: true })

    // Then: 回报计划「新增 2」，库里仍是空，写库回调一次都没有
    expect(result).toContain('dryRun 预览（未写库）')
    expect(result).toContain('新增 2')
    expect(await store.list()).toHaveLength(0)
    expect(written).toBe(0)
  })

  it('用户用 skip 模式导入 bundle 后库里确实多出卡片且已存在链接被跳过', async () => {
    // Given: 库里一张旧卡，bundle 里一张同链接（改过标题）与一张新卡
    const localCard = card('kc_local', {
      source: { type: 'bilibili', url: 'https://www.bilibili.com/video/dup', author: '行业研究员' },
    })
    const store = createMemoryKnowledgeCardStore([localCard])
    const filePath = await writeBundle([
      card('kc_foreign', {
        title: '想覆盖的标题',
        source: { type: 'bilibili', url: 'https://www.bilibili.com/video/dup', author: '行业研究员' },
      }),
      card('kc_imported'),
    ])
    let written = 0
    const tool = createKnowledgeImportTool(store, { onWritten: () => { written += 1 } })

    // When: 默认（skip）模式导入
    const result = await exec(tool, { path: filePath })

    // Then: 新增 1 / 跳过 1，库里 2 张，本地卡内容未被覆盖，写库回调恰好一次
    expect(result).toContain('新增 1')
    expect(result).toContain('跳过 1')
    expect(result).toContain('[kc_local]')
    expect(result).toContain('source.url 已存在')
    const cards = await store.list()
    expect(cards).toHaveLength(2)
    expect(cards.map((item) => item.id).sort()).toEqual(['kc_imported', 'kc_local'])
    expect(cards.find((item) => item.id === 'kc_local')?.title).toBe(localCard.title)
    expect(written).toBe(1)
  })

  it('用户用 overwrite 模式导入同链接卡片时保留本机 id 并刷新标题', async () => {
    // Given: 库里一张旧卡，bundle 里同链接但标题不同
    const localCard = card('kc_local', {
      source: { type: 'bilibili', url: 'https://www.bilibili.com/video/dup', author: '行业研究员' },
    })
    const store = createMemoryKnowledgeCardStore([localCard])
    const filePath = await writeBundle([
      card('kc_foreign', {
        title: '刷新后的标题',
        source: { type: 'bilibili', url: 'https://www.bilibili.com/video/dup', author: '行业研究员' },
      }),
    ])

    // When: overwrite 模式导入
    const result = await exec(createKnowledgeImportTool(store), { path: filePath, mode: 'overwrite' })

    // Then: 更新 1，库里仍是一张且 id/createdAt 不变、标题已刷新
    expect(result).toContain('更新 1')
    const cards = await store.list()
    expect(cards).toHaveLength(1)
    expect(cards[0]?.id).toBe('kc_local')
    expect(cards[0]?.createdAt).toBe(localCard.createdAt)
    expect(cards[0]?.title).toBe('刷新后的标题')
  })

  it('用户导入不存在或不是 JSON 的 bundle 文件时看到显式失败原因', async () => {
    // Given: 一个不存在的路径与一个内容不是 JSON 的文件
    const store = createMemoryKnowledgeCardStore()
    const tool = createKnowledgeImportTool(store)
    const missingPath = path.join(await tempDir(), 'nope.json')
    const badPath = path.join(await tempDir(), 'bad.json')
    await writeFile(badPath, '{ 这不是 JSON', 'utf8')

    // When: 分别导入
    const missingResult = await exec(tool, { path: missingPath })
    const badResult = await exec(tool, { path: badPath })

    // Then: 两条都是显式文本错误，库里没有被写入任何东西
    expect(missingResult).toContain('文件不存在')
    expect(missingResult).toContain(missingPath)
    expect(badResult).toContain('bundle 不是合法 JSON:')
    expect(await store.list()).toHaveLength(0)
  })

  it('用户传入非法 mode 时看到允许值提示且库不变', async () => {
    // Given: 一个正常 bundle 与一个非法 mode 取值
    const filePath = await writeBundle([card('kc_x')])
    const store = createMemoryKnowledgeCardStore()

    // When: 用 mode=merge 导入
    const result = await exec(createKnowledgeImportTool(store), { path: filePath, mode: 'merge' })

    // Then: 回报允许值且一张卡都没写
    expect(result).toContain('参数 mode 非法: merge')
    expect(result).toContain('skip, overwrite')
    expect(await store.list()).toHaveLength(0)
  })

  it('用户传入纯空白的 path 参数时看到必填提示', async () => {
    // Given: 一个空的内存 store
    const store = createMemoryKnowledgeCardStore()

    // When: path 只有空白字符（能过 schema，但去掉空白后为空）
    const result = await exec(createKnowledgeImportTool(store), { path: '   ' })

    // Then: 回报 path 必填，库不变
    expect(result).toContain('参数 path 为必填字符串')
    expect(await store.list()).toHaveLength(0)
  })
})
