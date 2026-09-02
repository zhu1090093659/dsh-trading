import { describe, expect, it } from 'vitest'
import { createMemoryKnowledgeCardStore } from '../src/store-memory.ts'
import {
  createKnowledgeDeleteTool,
  createKnowledgeGetTool,
  createKnowledgeIngestTool,
  createKnowledgeSearchTool,
} from '../src/tool.ts'
import type { KnowledgeCard } from '../src/types.ts'

function createSampleIngestArgs(url: string, title = '周期股景气度拐点研判') {
  return {
    title,
    summary: '通过供需错配与资本开支周期识别周期行业拐点。',
    sourceType: 'bilibili',
    sourceUrl: url,
    sourceAuthor: '行业研究员',
    credibility: 'high',
    coreClaimsJson: JSON.stringify(['资本开支连续三年负增长通常构筑供给侧底']),
    factCheckJson: JSON.stringify({
      verified: ['历史三次大宗周期均符合此资本开支规律'],
      discrepancies: [],
      unverifiable: [],
    }),
    takeawaysJson: JSON.stringify(['逆向布局重资产周期的核心在于寻找供给侧出清信号']),
    boundariesJson: JSON.stringify(['需求端出现永久性替代技术时供给逻辑失效']),
    tagsJson: JSON.stringify(['周期', '大宗商品', '产能周期']),
    tickersJson: JSON.stringify(['600028.SH']),
  }
}

describe('Knowledge Agent Tools', () => {
  it('knowledge_ingest creates card on new URL', async () => {
    const store = createMemoryKnowledgeCardStore()
    const ingestTool = createKnowledgeIngestTool(store)

    const input = createSampleIngestArgs('https://www.bilibili.com/video/BV111')
    const result = await (ingestTool as any).execute(input)

    expect(result).toContain('成功创建新知识卡片')
    expect(result).toContain('周期股景气度拐点研判')
    expect(await store.list()).toHaveLength(1)
  })

  it('knowledge_ingest updates existing card when URL duplicates, preserving original ID and createdAt', async () => {
    const store = createMemoryKnowledgeCardStore()
    const ingestTool = createKnowledgeIngestTool(store)

    // 1. 首次创建
    const input1 = createSampleIngestArgs('https://www.bilibili.com/video/BVSame', '初始标题')
    const res1 = await (ingestTool as any).execute(input1)
    expect(res1).toContain('成功创建新知识卡片')

    const list1 = await store.list()
    const originalId = list1[0]!.id
    const originalCreatedAt = list1[0]!.createdAt

    // 2. 相同 URL 再次提交更新
    const input2 = createSampleIngestArgs('https://www.bilibili.com/video/BVSame', '更新后的标题')
    const res2 = await (ingestTool as any).execute(input2)

    expect(res2).toContain('成功更新已有知识卡片')
    expect(res2).toContain(originalId)

    const list2 = await store.list()
    expect(list2).toHaveLength(1)
    expect(list2[0]?.id).toBe(originalId)
    expect(list2[0]?.title).toBe('更新后的标题')
    expect(list2[0]?.createdAt).toBe(originalCreatedAt)
  })

  it('knowledge_ingest rejects dangling related card IDs', async () => {
    const store = createMemoryKnowledgeCardStore()
    const ingestTool = createKnowledgeIngestTool(store)

    const input = {
      ...createSampleIngestArgs('https://www.bilibili.com/video/BV_Dangling'),
      relatedJson: JSON.stringify(['kc_non_existent']),
    }

    const result = await (ingestTool as any).execute(input)
    expect(result).toContain('校验失败')
    expect(result).toContain('拒绝悬空关联')
    expect(await store.list()).toHaveLength(0)
  })

  it('knowledge_search performs multi-field queries and filtering', async () => {
    const store = createMemoryKnowledgeCardStore()
    const ingestTool = createKnowledgeIngestTool(store)
    const searchTool = createKnowledgeSearchTool(store)

    await (ingestTool as any).execute(createSampleIngestArgs('https://www.bilibili.com/video/BV1', '半导体周期分析'))
    await (ingestTool as any).execute({
      ...createSampleIngestArgs('https://mp.weixin.qq.com/s/wx1', '红利低波策略'),
      sourceType: 'wechat',
      sourceUrl: 'https://mp.weixin.qq.com/s/wx1',
      sourceAuthor: '微信财神',
      tagsJson: JSON.stringify(['红利', '宏观']),
      credibility: 'medium',
    })

    // 1. 关键词搜索
    const queryRes = await (searchTool as any).execute({ query: '半导体' })
    expect(queryRes).toContain('半导体周期分析')
    expect(queryRes).not.toContain('红利低波')

    // 2. 标签过滤
    const tagRes = await (searchTool as any).execute({ tags: '红利' })
    expect(tagRes).toContain('红利低波策略')

    // 3. 来源类型过滤
    const typeRes = await (searchTool as any).execute({ sourceType: 'wechat' })
    expect(typeRes).toContain('微信财神')

    // 4. 可信度过滤
    const credRes = await (searchTool as any).execute({ credibility: 'high' })
    expect(credRes).toContain('半导体周期分析')
  })

  it('knowledge_search ranks field-hit relevance above recency', async () => {
    const mkCard = (id: string, title: string, summary: string, updatedAt: string): KnowledgeCard => ({
      id,
      title,
      summary,
      source: { type: 'manual', url: `manual:${id}`, author: '手工' },
      credibility: 'medium',
      coreClaims: [],
      factCheck: { verified: [], discrepancies: [], unverifiable: [] },
      takeaways: [],
      boundaries: [],
      tags: ['宏观'],
      createdAt: updatedAt,
      updatedAt,
    })
    // 老卡标题命中「美联储」，新卡仅摘要命中——相关度应压过时间序。
    const titleHit = mkCard('kc_title_hit', '美联储加息路径研判', '利率与流动性框架。', '2026-08-01T00:00:00.000Z')
    const summaryHit = mkCard('kc_summary_hit', '黄金配置逻辑', '美联储降息预期下的避险需求。', '2026-09-01T00:00:00.000Z')
    const store = createMemoryKnowledgeCardStore([summaryHit, titleHit])
    const searchTool = createKnowledgeSearchTool(store)

    const res = await (searchTool as any).execute({ query: '美联储' })
    expect(res.indexOf('kc_title_hit')).toBeGreaterThan(-1)
    expect(res.indexOf('kc_title_hit')).toBeLessThan(res.indexOf('kc_summary_hit'))
  })

  it('knowledge_search detail=full returns claims and takeaways, summary mode does not', async () => {
    const store = createMemoryKnowledgeCardStore()
    const ingestTool = createKnowledgeIngestTool(store)
    const searchTool = createKnowledgeSearchTool(store)

    await (ingestTool as any).execute(createSampleIngestArgs('https://www.bilibili.com/video/BV_full', '半导体周期分析'))

    const summaryRes = await (searchTool as any).execute({ query: '半导体' })
    expect(summaryRes).not.toContain('核心论点:')

    const fullRes = await (searchTool as any).execute({ query: '半导体', detail: 'full' })
    expect(fullRes).toContain('核心论点:')
    expect(fullRes).toContain('资本开支连续三年负增长')
    expect(fullRes).toContain('可复用经验:')
    expect(fullRes).toContain('适用边界:')
  })

  it('knowledge_get returns full card by id and errors on missing id', async () => {
    const store = createMemoryKnowledgeCardStore()
    const ingestTool = createKnowledgeIngestTool(store)
    const getTool = createKnowledgeGetTool(store)

    await (ingestTool as any).execute(createSampleIngestArgs('https://www.bilibili.com/video/BV_get'))
    const id = (await store.list())[0]!.id

    const res = await (getTool as any).execute({ id })
    expect(res).toContain('周期股景气度拐点研判')
    expect(res).toContain('核心论点:')
    expect(res).toContain('资本开支连续三年负增长')

    expect(await (getTool as any).execute({ id: 'kc_missing' })).toContain('未找到卡片')
    await expect((getTool as any).execute({})).rejects.toThrow()
  })

  it('knowledge_delete removes a card, cleans dangling related references and fires the event callback', async () => {
    const store = createMemoryKnowledgeCardStore()
    const ingestTool = createKnowledgeIngestTool(store)

    await (ingestTool as any).execute(createSampleIngestArgs('https://www.bilibili.com/video/BV_del_target', '待证伪卡片'))
    const targetId = (await store.list())[0]!.id

    await (ingestTool as any).execute({
      ...createSampleIngestArgs('https://www.bilibili.com/video/BV_ref', '引用卡片'),
      relatedJson: JSON.stringify([targetId]),
    })

    let emitted = 0
    const deleteTool = createKnowledgeDeleteTool(store, { onWritten: () => { emitted += 1 } })

    const result = await (deleteTool as any).execute({ id: targetId, reason: '核心论点被证伪' })
    expect(result).toContain('已删除卡片')
    expect(result).toContain('待证伪卡片')
    expect(result).toContain('核心论点被证伪')
    expect(emitted).toBe(1)

    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.title).toBe('引用卡片')
    expect(list[0]!.related ?? []).toHaveLength(0)
  })

  it('knowledge_delete errors on missing id and without required id', async () => {
    const store = createMemoryKnowledgeCardStore()
    const deleteTool = createKnowledgeDeleteTool(store)

    expect(await (deleteTool as any).execute({ id: 'kc_missing' })).toContain('未找到卡片')
    await expect((deleteTool as any).execute({})).rejects.toThrow()
  })
})
