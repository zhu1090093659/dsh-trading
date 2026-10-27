/**
 * bundle 导出/导入核心（bundle.ts）的行为契约。
 *
 * 全部用例只走纯函数：零 mock、零 sleep、零临时文件——bundle 与导入计划的正确性
 * 与文件系统无关，落盘路径的行为由 import-tools.test.ts 用真实临时目录覆盖。
 */
import { describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_BUNDLE_MAX_BYTES,
  KNOWLEDGE_BUNDLE_MAX_CARDS,
  createKnowledgeBundle,
  parseKnowledgeBundle,
  planKnowledgeImport,
  serializeKnowledgeBundle,
} from '../src/bundle.ts'
import type { KnowledgeCard } from '../src/types.ts'

const EXPORT_NOW = new Date('2026-03-01T08:00:00.000Z')
const IMPORT_NOW = new Date('2026-03-02T09:30:00.000Z')

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

function goodMeta() {
  return createKnowledgeBundle([], { now: EXPORT_NOW }).meta
}

function bundleText(cards: readonly unknown[], meta: Record<string, unknown> = goodMeta()): string {
  return JSON.stringify({ meta, cards })
}

describe('Knowledge Bundle', () => {
  describe('createKnowledgeBundle / serializeKnowledgeBundle', () => {
    it('用户导出知识卡片时 meta 记下版本、导出时间、卡片数、生成方与免责声明', () => {
      // Given: 两张本机卡片
      const cards = [card('kc_a'), card('kc_b')]

      // When: 用固定时间构造 bundle
      const bundle = createKnowledgeBundle(cards, { now: EXPORT_NOW })

      // Then: meta 逐字段等于契约值，cards 是传入的原数组（不深拷贝改写）
      expect(bundle.meta.schemaVersion).toBe(1)
      expect(bundle.meta.exportedAt).toBe(EXPORT_NOW.toISOString())
      expect(bundle.meta.cardCount).toBe(2)
      expect(bundle.meta.generator).toBe('dsh-trading')
      expect(bundle.meta.notice).toBe('知识卡片是第三方观点的结构化转述，不构成投资建议；来源作者与原始链接随卡片保留以便查证。')
      expect(bundle.cards).toBe(cards)
    })

    it('用户导出空库时仍生成卡片数为 0 的合法 bundle', () => {
      // Given: 一个还没有卡片的库
      // When: 构造并序列化再解析
      const bundle = createKnowledgeBundle([], { now: EXPORT_NOW })
      const parsed = parseKnowledgeBundle(serializeKnowledgeBundle(bundle))

      // Then: 卡片数为 0，解析通过且卡片为空
      expect(bundle.meta.cardCount).toBe(0)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.bundle.cards).toHaveLength(0)
    })

    it('用户导出后再解析时拿到逐字段一致的卡片，文本以换行收尾', () => {
      // Given: 一张带关联与可选字段的卡片
      const cards = [card('kc_a'), card('kc_b', { related: ['kc_a'], tickers: ['BTCUSDT'] })]

      // When: 序列化后再解析（完整往返）
      const text = serializeKnowledgeBundle(createKnowledgeBundle(cards, { now: EXPORT_NOW }))
      const parsed = parseKnowledgeBundle(text)

      // Then: meta 与 cards 逐字段一致，文本是 2 空格缩进且以换行收尾
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.bundle.meta).toEqual(createKnowledgeBundle(cards, { now: EXPORT_NOW }).meta)
      expect(parsed.bundle.cards).toEqual(cards)
      expect(text.endsWith('}\n')).toBe(true)
      expect(text).toContain('\n  "meta": {')
    })
  })

  describe('parseKnowledgeBundle', () => {
    it('用户导入内容为空或不是字符串时看到「bundle 内容为空」', () => {
      // Given: 空字符串、纯空白与非字符串三种输入
      const inputs = ['', '   \n\t ', 42 as unknown as string]

      // When: 逐个解析
      const errors = inputs.map((input) => parseKnowledgeBundle(input))

      // Then: 三种都失败且原因统一为内容为空
      for (const result of errors) {
        expect(result.ok).toBe(false)
        if (result.ok) continue
        expect(result.error).toBe('bundle 内容为空')
      }
    })

    it('用户导入超过字节上限的文本时看到实际字节数与上限', () => {
      // Given: 一段超过 8 MiB 的文本（字节数按 UTF-8 计）
      const text = 'x'.repeat(KNOWLEDGE_BUNDLE_MAX_BYTES + 1)

      // When: 解析这段文本
      const result = parseKnowledgeBundle(text)

      // Then: 失败原因点名实际字节数与上限
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain(String(KNOWLEDGE_BUNDLE_MAX_BYTES + 1))
      expect(result.error).toContain(String(KNOWLEDGE_BUNDLE_MAX_BYTES))
    })

    it('用户导入不是 JSON 的文本时看到点名 JSON 的失败原因', () => {
      // Given: 一段截断的 JSON
      // When: 解析
      const result = parseKnowledgeBundle('{ "meta": ')

      // Then: 原因说明不是合法 JSON 并带上解析器的说明
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('bundle 不是合法 JSON:')
    })

    it('用户导入缺 meta、缺 cards 或顶层不是对象的 bundle 时看到点名缺项的原因', () => {
      // Given: 三种结构不完整的 bundle 文本
      const meta = goodMeta()
      const cases = [
        { text: JSON.stringify({ cards: [] }), expected: '缺少 meta 字段' },
        { text: JSON.stringify({ meta }), expected: '缺少 cards 字段' },
        { text: '[]', expected: '顶层必须是 JSON 对象' },
      ]

      // When: 逐个解析
      // Then: 每条都点名缺的是哪一项
      for (const item of cases) {
        const result = parseKnowledgeBundle(item.text)
        expect(result.ok).toBe(false)
        if (result.ok) continue
        expect(result.error).toContain(item.expected)
      }
    })

    it('用户导入 schemaVersion 不是 1 的 bundle 时看到本机支持的版本', () => {
      // Given: schemaVersion 写成 2 的 bundle
      const text = bundleText([], { ...goodMeta(), schemaVersion: 2 })

      // When: 解析
      const result = parseKnowledgeBundle(text)

      // Then: 失败原因点名收到的版本与本机支持的 1
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('不支持的 schemaVersion: 2')
      expect(result.error).toContain('本机支持 1')
    })

    it('用户导入卡片数超过上限的 bundle 时看到卡片数上限', () => {
      // Given: 卡片数刚好超过上限的 bundle
      const cards = Array.from({ length: KNOWLEDGE_BUNDLE_MAX_CARDS + 1 }, () => ({}))
      const text = bundleText(cards)

      // When: 解析
      const result = parseKnowledgeBundle(text)

      // Then: 失败原因点名卡片数上限
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain(String(KNOWLEDGE_BUNDLE_MAX_CARDS))
      expect(result.error).toContain('超过上限')
    })

    it('用户导入缺 id、title 或 source.url 的卡片时看到点到第几张缺什么', () => {
      // Given: 第二张卡分别缺一个必填字段的三份 bundle
      const cases = [
        { broken: { title: '标题', source: { url: 'https://example.com/a' } }, field: 'id' },
        { broken: { id: 'kc_x', source: { url: 'https://example.com/a' } }, field: 'title' },
        { broken: { id: 'kc_x', title: '标题' }, field: 'source.url' },
      ]

      // When: 逐个解析
      // Then: 每条都指出第 2 张卡（下标 1）与缺的字段名
      for (const item of cases) {
        const result = parseKnowledgeBundle(bundleText([card('kc_ok'), item.broken]))
        expect(result.ok).toBe(false)
        if (result.ok) continue
        expect(result.error).toContain('第 2 张卡片（下标 1）')
        expect(result.error).toContain(item.field)
      }
    })

    it('用户导入 meta.cardCount 与实际不符的 bundle 时仍按 cards 原值通过', () => {
      // Given: meta 声称 99 张、实际只有 1 张的 bundle
      const text = bundleText([card('kc_a')], { ...goodMeta(), cardCount: 99 })

      // When: 解析
      const result = parseKnowledgeBundle(text)

      // Then: 宽容通过，cards 是原数组原值
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.bundle.cards).toHaveLength(1)
      expect(result.bundle.meta.cardCount).toBe(99)
    })
  })

  describe('planKnowledgeImport', () => {
    it('用户在 skip 模式下导入已存在来源链接的卡片时该条计入跳过且不写入', () => {
      // Given: 本机已有一张卡，bundle 里有一张同链接（带空白）与一张新卡
      const localCard = card('kc_local', {
        source: { type: 'bilibili', url: 'https://www.bilibili.com/video/dup', author: '行业研究员' },
      })
      const incoming = [
        card('kc_foreign', { source: { type: 'bilibili', url: '  https://www.bilibili.com/video/dup  ', author: '行业研究员' } }),
        card('kc_new'),
      ]

      // When: 以 skip 模式算导入计划
      const plan = planKnowledgeImport([localCard], incoming, 'skip', { now: IMPORT_NOW })

      // Then: 同链接那条进 skipped（用本地卡身份回显），新卡进 create
      expect(plan.skipped).toHaveLength(1)
      expect(plan.skipped[0]).toEqual({
        id: 'kc_local',
        title: localCard.title,
        url: 'https://www.bilibili.com/video/dup',
        reason: 'source.url 已存在',
      })
      expect(plan.create.map((item) => item.id)).toEqual(['kc_new'])
      expect(plan.update).toHaveLength(0)
      expect(localCard.updatedAt).toBe('2026-01-02T00:00:00.000Z')
    })

    it('管理员用 overwrite 模式导入同链接卡片时保留本机 id 与 createdAt 并刷新 updatedAt', () => {
      // Given: 本机一张旧卡，bundle 里同链接但内容更新
      const localCard = card('kc_local', {
        createdAt: '2025-12-01T00:00:00.000Z',
        updatedAt: '2025-12-02T00:00:00.000Z',
      })
      const incoming = [card('kc_foreign', {
        title: '新标题',
        summary: '新概述',
        source: { type: 'bilibili', url: localCard.source.url, author: '行业研究员' },
      })]

      // When: 以 overwrite 模式算导入计划
      const plan = planKnowledgeImport([localCard], incoming, 'overwrite', { now: IMPORT_NOW })

      // Then: 归入 update、id 与 createdAt 取本地、内容与 updatedAt 取新的
      expect(plan.create).toHaveLength(0)
      expect(plan.update).toHaveLength(1)
      expect(plan.update[0]?.id).toBe('kc_local')
      expect(plan.update[0]?.createdAt).toBe('2025-12-01T00:00:00.000Z')
      expect(plan.update[0]?.updatedAt).toBe(IMPORT_NOW.toISOString())
      expect(plan.update[0]?.title).toBe('新标题')
      expect(plan.update[0]?.summary).toBe('新概述')
      expect(plan.skipped).toHaveLength(0)
    })

    it('用户在 skip 模式下导入时包内指向本机已有卡片的关联被换成本机 id', () => {
      // Given: 本机已有 A 卡，bundle 里 A 卡换成外来 id（同链接）且 B 卡关联那个外来 id
      const localCard = card('kc_local_a')
      const incoming = [
        card('kc_foreign_a', { source: { type: 'bilibili', url: localCard.source.url, author: '行业研究员' } }),
        card('kc_b', { related: ['kc_foreign_a'] }),
      ]

      // When: 以 skip 模式算导入计划（A 卡被跳过）
      const plan = planKnowledgeImport([localCard], incoming, 'skip', { now: IMPORT_NOW })

      // Then: 外来 id 记进 remappedIds，B 卡的关联指向本机 A 卡而不是被当成包外引用丢掉
      expect(plan.skipped.map((entry) => entry.id)).toEqual(['kc_local_a'])
      expect(plan.remappedIds).toEqual([{ from: 'kc_foreign_a', to: 'kc_local_a' }])
      expect(plan.create).toHaveLength(1)
      expect(plan.create[0]?.related).toEqual(['kc_local_a'])
      expect(plan.droppedRelated).toHaveLength(0)
    })

    it('管理员用 overwrite 模式导入时包内指向本机已有卡片的关联仍指向本机 id', () => {
      // Given: 本机已有 A 卡，bundle 里 A 卡换成外来 id（同链接、标题更新）且 B 卡关联那个外来 id
      const localCard = card('kc_local_a')
      const incoming = [
        card('kc_foreign_a', {
          title: '刷新后的 A 卡',
          source: { type: 'bilibili', url: localCard.source.url, author: '行业研究员' },
        }),
        card('kc_b', { related: ['kc_foreign_a'] }),
      ]

      // When: 以 overwrite 模式算导入计划（A 卡被覆盖）
      const plan = planKnowledgeImport([localCard], incoming, 'overwrite', { now: IMPORT_NOW })

      // Then: A 卡进 update 并保留本机 id，外来 id 记进 remappedIds，B 卡的关联指向本机 A 卡
      expect(plan.update.map((entry) => entry.id)).toEqual(['kc_local_a'])
      expect(plan.remappedIds).toEqual([{ from: 'kc_foreign_a', to: 'kc_local_a' }])
      expect(plan.create).toHaveLength(1)
      expect(plan.create[0]?.related).toEqual(['kc_local_a'])
      expect(plan.droppedRelated).toHaveLength(0)
    })

    it('用户导入同一个 id 既指向本机已有卡片又写在新卡上的 bundle 时新卡重新生成 id', () => {
      // Given: 本机已有 kc_local（链接 L）；bundle 里 A 卡用 id kc_dup 指向链接 L（会被跳过），B 卡不同链接也用 kc_dup
      const localCard = card('kc_local', {
        source: { type: 'bilibili', url: 'https://www.bilibili.com/video/local-dup', author: '行业研究员' },
      })
      const incoming = [
        card('kc_dup', { source: { type: 'bilibili', url: localCard.source.url, author: '行业研究员' } }),
        card('kc_dup', { source: { type: 'bilibili', url: 'https://www.bilibili.com/video/other-dup', author: '行业研究员' } }),
      ]

      // When: 以 skip 模式算导入计划
      const plan = planKnowledgeImport([localCard], incoming, 'skip', { now: IMPORT_NOW })

      // Then: A 卡被跳过（kc_dup 指向本机 id），B 卡不拿 kc_dup 落地并再记一条 kc_dup → 新 id
      expect(plan.skipped.map((entry) => entry.id)).toEqual(['kc_local'])
      expect(plan.create).toHaveLength(1)
      const createdId = plan.create[0]?.id
      expect(createdId).not.toBe('kc_dup')
      expect(createdId?.startsWith('kc_')).toBe(true)
      expect(plan.remappedIds).toEqual([
        { from: 'kc_dup', to: 'kc_local' },
        { from: 'kc_dup', to: createdId },
      ])
    })

    it('用户导入与本地 id 冲突的卡片时重新生成 id 并记录 remappedIds', () => {
      // Given: 本机已占用 kc_taken，bundle 里另一张不同链接的卡也叫 kc_taken
      const localCard = card('kc_taken')
      const incoming = [card('kc_taken', {
        source: { type: 'bilibili', url: 'https://www.bilibili.com/video/other-url', author: '行业研究员' },
      })]

      // When: 算导入计划
      const plan = planKnowledgeImport([localCard], incoming, 'skip', { now: IMPORT_NOW })

      // Then: 新 id 不以 kc_taken 落地，且 from/to 记进 remappedIds
      expect(plan.create).toHaveLength(1)
      const created = plan.create[0]
      expect(created?.id).not.toBe('kc_taken')
      expect(created?.id.startsWith('kc_')).toBe(true)
      expect(plan.remappedIds).toEqual([{ from: 'kc_taken', to: created?.id }])
    })

    it('用户导入同一批次内 id 重复的卡片时后一张重新生成 id 并记录 remappedIds', () => {
      // Given: bundle 里两张都叫 kc_dup 但链接不同的卡，本机为空库
      const incoming = [
        card('kc_dup'),
        card('kc_dup', { source: { type: 'bilibili', url: 'https://www.bilibili.com/video/kc_dup_2', author: '行业研究员' } }),
      ]

      // When: 算导入计划
      const plan = planKnowledgeImport([], incoming, 'skip', { now: IMPORT_NOW })

      // Then: 先到的保住 id，后到的重生成并记 remappedIds
      expect(plan.create).toHaveLength(2)
      expect(plan.create[0]?.id).toBe('kc_dup')
      expect(plan.create[1]?.id).not.toBe('kc_dup')
      expect(plan.remappedIds).toEqual([{ from: 'kc_dup', to: plan.create[1]?.id }])
    })

    it('用户导入 related 指向包内其它卡片的 bundle 时关联被改写到包内卡片的新 id', () => {
      // Given: 包内第一张卡与本地 id 冲突（会被重生成），第二张卡关联它
      const incoming = [
        card('kc_taken', {
          source: { type: 'bilibili', url: 'https://www.bilibili.com/video/incoming-a', author: '行业研究员' },
        }),
        card('kc_new', { related: ['kc_taken'] }),
      ]

      // When: 算导入计划
      const plan = planKnowledgeImport([card('kc_taken')], incoming, 'skip', { now: IMPORT_NOW })

      // Then: 关联值跟着重映射走，没有被丢弃
      expect(plan.create).toHaveLength(2)
      const rewritten = plan.create[0]?.id
      expect(rewritten).not.toBe('kc_taken')
      expect(plan.create[1]?.related).toEqual([rewritten])
      expect(plan.droppedRelated).toHaveLength(0)
    })

    it('用户导入 related 指向包外卡片的 bundle 时关联被丢弃并按卡片合并计数', () => {
      // Given: 第二张卡关联包内一张卡与两个不存在的 id
      const incoming = [card('kc_a'), card('kc_b', { related: ['kc_a', 'kc_ghost1', 'kc_ghost2'] })]

      // When: 空库导入
      const plan = planKnowledgeImport([], incoming, 'skip', { now: IMPORT_NOW })

      // Then: 包内关联保留，两条缺失合并成一个卡片条目
      expect(plan.create).toHaveLength(2)
      expect(plan.create[1]?.related).toEqual(['kc_a'])
      expect(plan.droppedRelated).toEqual([{ id: 'kc_b', missing: ['kc_ghost1', 'kc_ghost2'] }])
    })

    it('用户导入关联被全部丢弃的卡片时 related 变为不带该字段的卡片', () => {
      // Given: 一张卡只关联包外 id
      const incoming = [card('kc_a', { related: ['kc_ghost'] })]

      // When: 空库导入
      const plan = planKnowledgeImport([], incoming, 'skip', { now: IMPORT_NOW })

      // Then: related 为 undefined（不是空数组），缺失被计数
      expect(plan.create).toHaveLength(1)
      expect(plan.create[0]?.related).toBeUndefined()
      expect(plan.droppedRelated).toEqual([{ id: 'kc_a', missing: ['kc_ghost'] }])
    })

    it('用户导入含非法卡片的 bundle 时该卡计入 invalid 且其它卡照常建卡', () => {
      // Given: 中间一张卡没有标签（validate 会拒绝），前后两张合法
      const incoming = [
        card('kc_ok1'),
        card('kc_bad', { tags: [] }),
        card('kc_ok2'),
      ]

      // When: 算导入计划
      const plan = planKnowledgeImport([], incoming, 'skip', { now: IMPORT_NOW })

      // Then: 前后两张照常建卡，非法卡按原始下标与标题回报
      expect(plan.create.map((item) => item.id)).toEqual(['kc_ok1', 'kc_ok2'])
      expect(plan.invalid).toHaveLength(1)
      expect(plan.invalid[0]?.index).toBe(1)
      expect(plan.invalid[0]?.title).toBe('卡片 kc_bad')
      expect(plan.invalid[0]?.error).toContain('tags')
    })

    it('用户导入空卡片列表时计划里五类结果全为空', () => {
      // Given: 一个空 bundle
      // When: 空库、空 incoming 算计划
      const plan = planKnowledgeImport([], [], 'skip', { now: IMPORT_NOW })

      // Then: 新增/更新/跳过/丢弃关联/非法/重映射全部为空
      expect(plan.create).toHaveLength(0)
      expect(plan.update).toHaveLength(0)
      expect(plan.skipped).toHaveLength(0)
      expect(plan.droppedRelated).toHaveLength(0)
      expect(plan.invalid).toHaveLength(0)
      expect(plan.remappedIds).toHaveLength(0)
    })
  })
})
