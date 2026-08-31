import { describe, expect, it } from 'vitest'
import { createMemoryKnowledgeCardStore } from '../src/store-memory.ts'
import { createKnowledgeIngestTool, createKnowledgeSearchTool } from '../src/tool.ts'

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
})
