/**
 * 知识库主视图组件（对齐 docs/design/knowledge-graph.md §5 & §6 与 Issue #25 规格）。
 *
 * 结构：
 *   1. 顶部工具栏（搜索定位 + 标签/作者/可信度/平台过滤 + 统计徽章）
 *   2. 主画布区（Obsidian 式 force-graph 力导知识图谱网络）
 *   3. 右侧详情抽屉（卡片全文：核心论点 + 事实核查三桶 + 复用经验 + 边界避坑 + 来源链接）
 *   4. 空态引导与状态持久化 (dshtrading.knowledge.view.v1)
 *   5. 导出 / 导入动作与导入预览浮动层（非模态：抽屉与图谱照常可交互）
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  KNOWLEDGE_BUNDLE_MAX_BYTES,
  KNOWLEDGE_BUNDLE_MAX_CARDS,
  buildGraph,
  planKnowledgeImport,
  type KnowledgeBundle,
  type KnowledgeCard,
  type KnowledgeGraphData,
  type KnowledgeImportMode,
} from '@dshtrading/knowledge'
import { readJson, writeJson } from './shell-faces.ts'
import { CREDIBILITY_OPTIONS, SOURCE_TYPE_OPTIONS, staleFilterFields } from './filter-state.ts'
import {
  exportKnowledgeFileName,
  exportKnowledgeText,
  importPlanSummary,
  parseImportFileText,
} from './import-export.ts'
import { IconKnowledge, IconSearch } from './icons.tsx'
import { KnowledgeGraph, type KnowledgeGraphHandle } from './KnowledgeGraph.tsx'
import type { KnowledgeLocaleKey } from './contract.ts'
import css from './KnowledgeView.module.css'

interface KnowledgeViewStored {
  query: string
  selectedTag: string
  selectedAuthor: string
  selectedCredibility: string
  selectedSourceType: string
}

const STORE_KEY = 'dshtrading.knowledge.view.v1'

const DEFAULT_STORED: KnowledgeViewStored = {
  query: '',
  selectedTag: '',
  selectedAuthor: '',
  selectedCredibility: '',
  selectedSourceType: '',
}

/** 桥的导入结果面：本视图只用得到这几项，失败时 error 是可直接显示的原文。 */
export interface KnowledgeImportOutcome {
  ok: boolean
  created: number
  updated: number
  skipped: number
  error?: string
}

/** 导入预览草稿：draft 非 null 即面板打开，bundle 为 null 表示文件解析失败。 */
interface ImportDraft {
  fileName: string
  /** 原始文件文本：预览与写库用同一份输入（确认时原样交给桥）。 */
  text: string
  bundle: KnowledgeBundle | null
  mode: KnowledgeImportMode
}

export interface KnowledgeViewProps {
  t: (key: KnowledgeLocaleKey) => string
  /** 桥面（shell 的 tradingBridge 服务；未注入时保持 loading 空态）。 */
  bridge: {
    fetchKnowledgeCards: () => Promise<KnowledgeCard[]>
    subscribeTradingEvents: (handlers: { knowledge?: () => void }) => () => void
    importKnowledgeBundle: (input: {
      mode: KnowledgeImportMode
      bundle: string
    }) => Promise<KnowledgeImportOutcome>
  }
}

export function KnowledgeView({ t, bridge }: KnowledgeViewProps) {
  // 1. 过滤器持久化状态
  const [stored] = useState<KnowledgeViewStored>(() => {
    return readJson<KnowledgeViewStored>(STORE_KEY, DEFAULT_STORED)
  })

  const [query, setQuery] = useState(stored.query ?? '')
  const [selectedTag, setSelectedTag] = useState(stored.selectedTag ?? '')
  const [selectedAuthor, setSelectedAuthor] = useState(stored.selectedAuthor ?? '')
  const [selectedCredibility, setSelectedCredibility] = useState(stored.selectedCredibility ?? '')
  const [selectedSourceType, setSelectedSourceType] = useState(stored.selectedSourceType ?? '')

  // 2. 卡片数据与选中态
  const [cards, setCards] = useState<KnowledgeCard[]>([])
  const [selectedCard, setSelectedCard] = useState<KnowledgeCard | null>(null)
  const [loading, setLoading] = useState(true)

  // 2b. 导入 / 导出状态（draft 非 null 即预览面板打开；bundle 为 null = 解析失败）
  const [draft, setDraft] = useState<ImportDraft | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [applied, setApplied] = useState<{ created: number; updated: number; skipped: number } | null>(null)
  const [importing, setImporting] = useState(false)
  /** 导出超出导入侧上限（2000 张 / 8 MiB）时的可见提示，下一次导出成功或被缩小筛选后消失。 */
  const [exportTooLarge, setExportTooLarge] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const graphRef = useRef<KnowledgeGraphHandle | null>(null)

  // 桥引用稳定化（防御）：上游 render 闭包若每次传新 bridge 字面量，以 bridge 为
  // 依赖的 effect 会自激振荡（每帧 loadCards → setState → 重渲染 → 新 bridge…）。
  // 锁定首见引用（首次挂载的桥即用终生；真换桥实例需重挂视图，语义可接受）。
  // 注意不能写「ref.current !== bridge 时同步」——那等于把每次的新引用都放进 deps。
  const bridgeRef = useRef(bridge)
  if (bridgeRef.current === null) bridgeRef.current = bridge
  const stableBridge = bridgeRef.current

  // 同步持久化
  useEffect(() => {
    const nextState: KnowledgeViewStored = {
      query,
      selectedTag,
      selectedAuthor,
      selectedCredibility,
      selectedSourceType,
    }
    writeJson(STORE_KEY, nextState)
  }, [query, selectedTag, selectedAuthor, selectedCredibility, selectedSourceType])

  // 拉取知识卡片全集（桥来自 shell 的 tradingBridge 服务；未注入时空态）
  const loadCards = async () => {
    try {
      setLoading(true)
      const data = await bridge.fetchKnowledgeCards()
      setCards(data)
    } catch (e) {
      console.warn('[dsh-trading/knowledge-ui] failed to load cards:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadCards()
  }, [stableBridge])

  // SSE 失效信号订阅（issue #30 / P1）：knowledge_ingest 入库 / 更新后本视图
  // 实时刷新，无需刷新页面；EventSource 不可用时退化为一次性加载（现状）。
  useEffect(() => stableBridge.subscribeTradingEvents({
    knowledge: () => { void loadCards() },
  }), [stableBridge])

  // 3. 提取所有可用筛选候选项
  const { allTags, allAuthors } = useMemo(() => {
    const tagsSet = new Set<string>()
    const authorsSet = new Set<string>()
    for (const c of cards) {
      if (c.source.author) authorsSet.add(c.source.author)
      if (Array.isArray(c.tags)) {
        for (const tag of c.tags) tagsSet.add(tag)
      }
    }
    return {
      allTags: Array.from(tagsSet).sort(),
      allAuthors: Array.from(authorsSet).sort(),
    }
  }, [cards])

  // 3b. 失效筛选自愈：持久化的标签 / 作者一旦不在候选集里（例：某作者的卡片被
  // 全部移出知识库），下拉会回落显示「全部」而过滤条件仍在执行，视图显示 0 张
  // 卡片却看不出原因——此处按候选集清空失效值，让 UI 与过滤条件保持一致。
  // 卡片集为空时跳过：无法区分「库为空」与「拉取失败」，此时清空筛选是意外副作用。
  useEffect(() => {
    if (cards.length === 0) {
      return
    }
    const stale = staleFilterFields(
      { selectedTag, selectedAuthor, selectedCredibility, selectedSourceType },
      { tags: allTags, authors: allAuthors },
    )
    for (const field of stale) {
      if (field === 'selectedTag') setSelectedTag('')
      else if (field === 'selectedAuthor') setSelectedAuthor('')
      else if (field === 'selectedCredibility') setSelectedCredibility('')
      else setSelectedSourceType('')
    }
  }, [cards, allTags, allAuthors, selectedTag, selectedAuthor, selectedCredibility, selectedSourceType])

  // 4. 过滤卡片集合
  const filteredCards = useMemo(() => {
    const q = query.trim().toLowerCase()
    return cards.filter((card) => {
      if (selectedTag && !card.tags.includes(selectedTag)) {
        return false
      }
      if (selectedAuthor && card.source.author !== selectedAuthor) {
        return false
      }
      if (selectedCredibility && card.credibility !== selectedCredibility) {
        return false
      }
      if (selectedSourceType && card.source.type !== selectedSourceType) {
        return false
      }
      if (q) {
        const matchTitle = card.title.toLowerCase().includes(q)
        const matchSummary = card.summary.toLowerCase().includes(q)
        const matchClaims = card.coreClaims.some((c) => c.toLowerCase().includes(q))
        const matchTags = card.tags.some((t) => t.toLowerCase().includes(q))
        const matchAuthor = card.source.author.toLowerCase().includes(q)
        if (!matchTitle && !matchSummary && !matchClaims && !matchTags && !matchAuthor) {
          return false
        }
      }
      return true
    })
  }, [cards, query, selectedTag, selectedAuthor, selectedCredibility, selectedSourceType])

  // 5. 纯函数构建图结构数据
  const graphData = useMemo<KnowledgeGraphData>(() => {
    // Obsidian 式 hub 拓扑：标签聚合为 hub 节点，消除单作者大库下的 O(n²) 全配对边
    return buildGraph(filteredCards, { tagHubs: true, coTag: false, coAuthor: false })
  }, [filteredCards])

  // 6. 导入预览计划：模式切换与 cards 变化都重算（同一批 bundle，不同口径）
  const importPlan = useMemo(() => {
    if (draft === null || draft.bundle === null) return null
    return planKnowledgeImport(cards, draft.bundle.cards, draft.mode)
  }, [draft, cards])

  const importCounts = useMemo(
    () => (importPlan === null ? null : importPlanSummary(importPlan)),
    [importPlan],
  )

  // 重置过滤
  const handleResetFilters = () => {
    setQuery('')
    setSelectedTag('')
    setSelectedAuthor('')
    setSelectedCredibility('')
    setSelectedSourceType('')
  }

  const hasActiveFilters = Boolean(
    query || selectedTag || selectedAuthor || selectedCredibility || selectedSourceType,
  )

  /**
   * 导出：当前筛选结果（无筛选即全库）直接下载为 JSON 文件，文件名带本地时间戳。
   *
   * 导出侧与导入侧同口径（KNOWLEDGE_BUNDLE_MAX_CARDS / KNOWLEDGE_BUNDLE_MAX_BYTES）：
   * 超过上限就一个字节都不下载——否则我们造出的文件自己的导入侧必然拒收，
   * 用户要到下一次导入才知道白导了一场。
   */
  const handleExport = () => {
    const now = new Date()
    const text = exportKnowledgeText(filteredCards, now)
    const bytes = new TextEncoder().encode(text).length
    if (filteredCards.length > KNOWLEDGE_BUNDLE_MAX_CARDS || bytes > KNOWLEDGE_BUNDLE_MAX_BYTES) {
      setExportTooLarge(true)
      return
    }
    setExportTooLarge(false)
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = exportKnowledgeFileName(now)
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const closeImportPanel = useCallback(() => {
    setDraft(null)
    setImportError(null)
    setApplied(null)
    setImporting(false)
    const input = fileInputRef.current
    if (input !== null) input.value = ''
  }, [])

  // 选中文件 → 读文本 → 解析：解析失败停在面板显示原文错误，不写库
  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0] ?? null
    // 清空 value：同一文件再次选择也要触发 change
    input.value = ''
    if (file === null) return
    setApplied(null)
    let text: string
    try {
      text = await file.text()
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error))
      setDraft({ fileName: file.name, text: '', bundle: null, mode: 'skip' })
      return
    }
    const parsed = parseImportFileText(text)
    if (!parsed.ok) {
      setImportError(parsed.error)
      setDraft({ fileName: file.name, text, bundle: null, mode: 'skip' })
      return
    }
    setImportError(null)
    setDraft({ fileName: file.name, text, bundle: parsed.bundle, mode: 'skip' })
  }

  // 模式切换：用同一批 bundle 重算计划，计数随之刷新
  const handleSelectImportMode = (mode: KnowledgeImportMode) => {
    setApplied(null)
    setImportError(null)
    setDraft((prev) => (prev === null ? prev : { ...prev, mode }))
  }

  // 确认写库：原始文件文本原样交给桥；成功后重拉卡片（桥另会广播 'knowledge' 失效）
  const handleConfirmImport = async () => {
    if (draft === null || draft.bundle === null || importing || applied !== null) return
    setImporting(true)
    setImportError(null)
    try {
      const result = await stableBridge.importKnowledgeBundle({ mode: draft.mode, bundle: draft.text })
      if (!result.ok) {
        setImportError(result.error ?? '')
        return
      }
      setApplied({ created: result.created, updated: result.updated, skipped: result.skipped })
      await loadCards()
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }

  // Esc 关闭预览面板（面板不铺遮罩，图谱与抽屉照常可交互）
  useEffect(() => {
    if (draft === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeImportPanel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draft, closeImportPanel])

  // 处理关联卡片点击跳转
  const handleJumpToRelated = (relatedId: string) => {
    const target = cards.find((c) => c.id === relatedId)
    if (target) {
      setSelectedCard(target)
      graphRef.current?.focusNode(target.id)
    }
  }

  // 图谱节点选中回调（引用稳定：KnowledgeGraph 的初始化 effect 依赖 onSelectCard，
  // 内联箭头函数会导致实例每帧重建、力导模拟反复清零——画布永远空白）。
  const handleSelectCard = useCallback((card: KnowledgeCard) => {
    setSelectedCard(card)
  }, [])

  // 点击标签 hub = 切换标签过滤（Obsidian 交互：点标签即聚焦该主题）
  const handleTagClick = useCallback((tag: string) => {
    setSelectedTag((prev) => (prev === tag ? '' : tag))
  }, [])

  // 统计主题簇数量（'untagged' = 无标签卡片的簇哨兵，与 KnowledgeGraph 同值）
  const clusterCount = useMemo(() => {
    const clusters = new Set<string>()
    for (const c of filteredCards) {
      clusters.add(c.tags[0] ?? 'untagged')
    }
    return clusters.size
  }, [filteredCards])

  // 导出按钮的说明文案：空结果 > 超上限 > 正常（超限时点下去只会看到提示，不下载）
  const exportTitle =
    filteredCards.length === 0
      ? t('kv.io.exportEmpty')
      : exportTooLarge || filteredCards.length > KNOWLEDGE_BUNDLE_MAX_CARDS
        ? t('kv.io.exportTooLarge')
        : t('kv.io.export')

  return (
    <div className={css.root} data-dshtrading-knowledge-view="">
      {/* 1. 顶部搜索与过滤栏 */}
      <div className={css.toolbar}>
        <div className={css.filtersGroup}>
          <div className={css.searchBox}>
            <span className={css.searchIcon}>
              <IconSearch size={13} />
            </span>
            <input
              type="text"
              className={css.searchInput}
              placeholder={t('kv.search.placeholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {/* 标签过滤 */}
          <select
            className={css.filterSelect}
            value={selectedTag}
            onChange={(e) => setSelectedTag(e.target.value)}
          >
            <option value="">{t('kv.filter.allTags')}</option>
            {allTags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>

          {/* 作者过滤 */}
          <select
            className={css.filterSelect}
            value={selectedAuthor}
            onChange={(e) => setSelectedAuthor(e.target.value)}
          >
            <option value="">{t('kv.filter.allAuthors')}</option>
            {allAuthors.map((author) => (
              <option key={author} value={author}>
                {author}
              </option>
            ))}
          </select>

          {/* 可信度过滤 */}
          <select
            className={css.filterSelect}
            value={selectedCredibility}
            onChange={(e) => setSelectedCredibility(e.target.value)}
          >
            <option value="">{t('kv.filter.allCredibility')}</option>
            {CREDIBILITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>

          {/* 平台过滤 */}
          <select
            className={css.filterSelect}
            value={selectedSourceType}
            onChange={(e) => setSelectedSourceType(e.target.value)}
          >
            <option value="">{t('kv.filter.allSourceTypes')}</option>
            {SOURCE_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>

          {hasActiveFilters && (
            <button type="button" className={css.resetBtn} onClick={handleResetFilters}>
              {t('kv.filter.reset')}
            </button>
          )}
        </div>

        <div className={css.ioGroup}>
          <button
            type="button"
            className={css.ioBtn}
            onClick={handleExport}
            disabled={filteredCards.length === 0}
            title={exportTitle}
          >
            {t('kv.io.export')}
          </button>
          <button type="button" className={css.ioBtn} onClick={() => fileInputRef.current?.click()}>
            {t('kv.io.import')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className={css.ioFileInput}
            aria-label={t('kv.io.import')}
            onChange={(event) => { void handleFileChange(event) }}
          />
          <div className={css.statsText}>
            {filteredCards.length} {t('kv.stats.cards')} · {clusterCount} {t('kv.stats.clusters')}
          </div>
        </div>
      </div>

      {/* 1b. 导出超限提示（下一次导出成功即消失；与面板提示条同一套视觉） */}
      {exportTooLarge && (
        <div className={`${css.ioNotice} ${css.ioNoticeError} ${css.ioBanner}`} role="status">
          {t('kv.io.exportTooLarge')}
        </div>
      )}

      {/* 2. 主画布区 */}
      <div className={css.mainArea}>
        {cards.length === 0 && !loading ? (
          <div className={css.emptyState}>
            <div className={css.emptyIcon}>
              <IconKnowledge size={40} />
            </div>
            <div className={css.emptyHint}>{t('kv.empty.hint')}</div>
          </div>
        ) : filteredCards.length === 0 && !loading ? (
          <div className={css.emptyState}>
            <div className={css.emptyIcon}>
              <IconKnowledge size={32} />
            </div>
            <div className={css.emptyHint}>{t('kv.empty.filtered')}</div>
            <button type="button" className={css.resetBtn} onClick={handleResetFilters}>
              {t('kv.filter.reset')}
            </button>
          </div>
        ) : (
          <div className={css.graphCanvas}>
            <KnowledgeGraph
              ref={graphRef}
              data={graphData}
              selectedCardId={selectedCard?.id}
              onSelectCard={handleSelectCard}
              onTagClick={handleTagClick}
            />
          </div>
        )}

        {/* 3. 详情抽屉 (Drawer) */}
        {selectedCard && (
          <div className={css.drawer} role="dialog" aria-modal="false">
            <div className={css.drawerHeader}>
              <div className={css.drawerTitleGroup}>
                <div className={css.drawerTitle}>{selectedCard.title}</div>
                <div className={css.metaRow}>
                  <span className={`${css.badge} ${css.badgePlatform}`}>
                    {selectedCard.source.type}
                  </span>
                  <span
                    className={`${css.badge} ${
                      selectedCard.credibility === 'high'
                        ? css.badgeHigh
                        : selectedCard.credibility === 'medium'
                        ? css.badgeMedium
                        : css.badgeLow
                    }`}
                  >
                    {selectedCard.credibility}
                  </span>
                  <span>{selectedCard.source.author}</span>
                  {selectedCard.source.publishedAt && (
                    <span>{selectedCard.source.publishedAt}</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className={css.closeBtn}
                onClick={() => setSelectedCard(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className={css.drawerBody}>
              {/* 核心论点 */}
              <div className={css.section}>
                <div className={css.sectionLabel}>{t('kv.drawer.coreClaims')}</div>
                <ul className={css.claimsList}>
                  {selectedCard.coreClaims.map((claim, idx) => (
                    <li key={idx}>{claim}</li>
                  ))}
                </ul>
              </div>

              {/* 事实核查三桶 */}
              <div className={css.section}>
                <div className={css.sectionLabel}>{t('kv.drawer.factCheck')}</div>

                {selectedCard.factCheck.verified.length > 0 && (
                  <div className={`${css.factBucket} ${css.factVerified}`}>
                    <div className={css.bucketTitle}>✅ {t('kv.drawer.verified')}</div>
                    <ul className={css.bucketList}>
                      {selectedCard.factCheck.verified.map((v, i) => (
                        <li key={i}>{v}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {selectedCard.factCheck.discrepancies.length > 0 && (
                  <div className={`${css.factBucket} ${css.factDiscrepancies}`}>
                    <div className={css.bucketTitle}>⚠️ {t('kv.drawer.discrepancies')}</div>
                    <ul className={css.bucketList}>
                      {selectedCard.factCheck.discrepancies.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {selectedCard.factCheck.unverifiable.length > 0 && (
                  <div className={`${css.factBucket} ${css.factUnverifiable}`}>
                    <div className={css.bucketTitle}>❓ {t('kv.drawer.unverifiable')}</div>
                    <ul className={css.bucketList}>
                      {selectedCard.factCheck.unverifiable.map((u, i) => (
                        <li key={i}>{u}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* 可复用经验 */}
              {selectedCard.takeaways.length > 0 && (
                <div className={css.section}>
                  <div className={css.sectionLabel}>{t('kv.drawer.takeaways')}</div>
                  <ul className={css.claimsList}>
                    {selectedCard.takeaways.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 适用边界与避坑 */}
              {selectedCard.boundaries.length > 0 && (
                <div className={css.section}>
                  <div className={css.sectionLabel}>{t('kv.drawer.boundaries')}</div>
                  <ul className={css.claimsList}>
                    {selectedCard.boundaries.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 主题标签 */}
              <div className={css.section}>
                <div className={css.sectionLabel}>{t('kv.filter.tag')}</div>
                <div className={css.tagPills}>
                  {selectedCard.tags.map((tag) => (
                    <span key={tag} className={css.tagPill}>
                      #{tag}
                    </span>
                  ))}
                </div>
              </div>

              {/* 关联标的 */}
              {selectedCard.tickers && selectedCard.tickers.length > 0 && (
                <div className={css.section}>
                  <div className={css.sectionLabel}>{t('kv.drawer.tickers')}</div>
                  <div className={css.tagPills}>
                    {selectedCard.tickers.map((sym) => (
                      <span key={sym} className={css.tagPill}>
                        ${sym}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 显式关联卡片 */}
              {selectedCard.related && selectedCard.related.length > 0 && (
                <div className={css.section}>
                  <div className={css.sectionLabel}>{t('kv.drawer.related')}</div>
                  {selectedCard.related.map((relId) => {
                    const relCard = cards.find((c) => c.id === relId)
                    return (
                      <div
                        key={relId}
                        className={css.relatedItem}
                        onClick={() => handleJumpToRelated(relId)}
                      >
                        🔗 {relCard?.title ?? relId}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* 底部打开原始链接按钮 */}
            {selectedCard.source.url && (
              <div className={css.drawerFooter}>
                <a
                  href={selectedCard.source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={css.openSourceBtn}
                >
                  {t('kv.drawer.openSource')} ↗
                </a>
              </div>
            )}
          </div>
        )}

        {/* 4. 导入预览浮动层（不铺遮罩：抽屉与图谱照常可交互；Esc / 取消关闭） */}
        {draft !== null && (
          <div className={css.ioOverlay}>
            <div
              className={css.ioPanel}
              role="dialog"
              aria-modal="false"
              aria-label={t('kv.io.dialogTitle')}
            >
              <div className={css.ioPanelHeader}>
                <div className={css.ioPanelTitle}>{t('kv.io.dialogTitle')}</div>
                <button
                  type="button"
                  className={css.closeBtn}
                  onClick={closeImportPanel}
                  aria-label={t('kv.io.cancel')}
                >
                  ✕
                </button>
              </div>

              <div className={css.ioPanelBody}>
                <div className={css.ioFileHint}>
                  {draft.fileName} — {t('kv.io.fileHint')}
                </div>

                {importError !== null && (
                  <div className={`${css.ioNotice} ${css.ioNoticeError}`}>
                    {t('kv.io.failed')}
                    {importError === '' ? '' : `: ${importError}`}
                  </div>
                )}

                {applied !== null && (
                  <div className={`${css.ioNotice} ${css.ioNoticeOk}`}>
                    {t('kv.io.applied')}: {t('kv.io.planCreate')} {applied.created} ·{' '}
                    {t('kv.io.planUpdate')} {applied.updated} · {t('kv.io.planSkip')} {applied.skipped}
                  </div>
                )}

                {/* 写库成功后计数会按新库重算（全都变成「跳过」），与结果提示互相矛盾：
                    此时收起预览块，只留结果提示。 */}
                {applied === null && draft.bundle !== null && importCounts !== null && importPlan !== null && (
                  <>
                    <div className={css.ioModes}>
                      <label className={css.ioMode}>
                        <input
                          type="radio"
                          name="dshtrading-knowledge-import-mode"
                          value="skip"
                          checked={draft.mode === 'skip'}
                          onChange={() => handleSelectImportMode('skip')}
                          disabled={importing}
                        />
                        <span>{t('kv.io.modeSkip')}</span>
                      </label>
                      <label className={css.ioMode}>
                        <input
                          type="radio"
                          name="dshtrading-knowledge-import-mode"
                          value="overwrite"
                          checked={draft.mode === 'overwrite'}
                          onChange={() => handleSelectImportMode('overwrite')}
                          disabled={importing}
                        />
                        <span>{t('kv.io.modeOverwrite')}</span>
                      </label>
                    </div>

                    <div className={css.ioCounts}>
                      <div className={css.ioCount}>
                        <span className={css.ioCountValue}>{importCounts.create}</span>
                        <span className={css.ioCountLabel}>{t('kv.io.planCreate')}</span>
                      </div>
                      <div className={css.ioCount}>
                        <span className={css.ioCountValue}>{importCounts.update}</span>
                        <span className={css.ioCountLabel}>{t('kv.io.planUpdate')}</span>
                      </div>
                      <div className={css.ioCount}>
                        <span className={css.ioCountValue}>{importCounts.skip}</span>
                        <span className={css.ioCountLabel}>{t('kv.io.planSkip')}</span>
                      </div>
                      <div className={css.ioCount}>
                        <span className={css.ioCountValue}>{importCounts.dropped}</span>
                        <span className={css.ioCountLabel}>{t('kv.io.planDropped')}</span>
                      </div>
                      <div className={css.ioCount}>
                        <span className={css.ioCountValue}>{importCounts.invalid}</span>
                        <span className={css.ioCountLabel}>{t('kv.io.planInvalid')}</span>
                      </div>
                    </div>

                    {importCounts.invalid > 0 && (
                      <div className={css.ioInvalid}>
                        <div className={css.ioInvalidTitle}>
                          {t('kv.io.planInvalid')} {importCounts.invalid}
                        </div>
                        <ul className={css.ioInvalidList}>
                          {importPlan.invalid.slice(0, 5).map((item) => (
                            <li key={item.index}>
                              #{item.index} {item.error}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className={css.ioPanelFooter}>
                <button
                  type="button"
                  className={css.ioBtn}
                  onClick={closeImportPanel}
                  disabled={importing}
                >
                  {t('kv.io.cancel')}
                </button>
                <button
                  type="button"
                  className={`${css.ioBtn} ${css.ioBtnPrimary}`}
                  onClick={() => { void handleConfirmImport() }}
                  disabled={importing || applied !== null || draft.bundle === null}
                >
                  {t('kv.io.confirm')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
