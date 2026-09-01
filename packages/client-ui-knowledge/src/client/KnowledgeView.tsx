/**
 * 知识库主视图组件（对齐 docs/design/knowledge-graph.md §5 & §6 与 Issue #25 规格）。
 *
 * 结构：
 *   1. 顶部工具栏（搜索定位 + 标签/作者/可信度/平台过滤 + 统计徽章）
 *   2. 主画布区（Obsidian 式 force-graph 力导知识图谱网络）
 *   3. 右侧详情抽屉（卡片全文：核心论点 + 事实核查三桶 + 复用经验 + 边界避坑 + 来源链接）
 *   4. 空态引导与状态持久化 (dshtrading.knowledge.view.v1)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildGraph, type KnowledgeCard, type KnowledgeGraphData } from '@dsh-trading/knowledge'
import { readJson, writeJson } from './shell-faces.ts'
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

export interface KnowledgeViewProps {
  t: (key: KnowledgeLocaleKey) => string
  /** 桥面（shell 的 tradingBridge 服务；未注入时保持 loading 空态）。 */
  bridge: {
    fetchKnowledgeCards: () => Promise<KnowledgeCard[]>
    subscribeTradingEvents: (handlers: { knowledge?: () => void }) => () => void
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
    return buildGraph(filteredCards, { coTag: true, coAuthor: true })
  }, [filteredCards])

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

  // 统计主题簇数量
  const clusterCount = useMemo(() => {
    const clusters = new Set<string>()
    for (const c of filteredCards) {
      clusters.add(c.tags[0] ?? '未分类')
    }
    return clusters.size
  }, [filteredCards])

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
            <option value="high">{t('kv.credibility.high')}</option>
            <option value="medium">{t('kv.credibility.medium')}</option>
            <option value="low">{t('kv.credibility.low')}</option>
          </select>

          {/* 平台过滤 */}
          <select
            className={css.filterSelect}
            value={selectedSourceType}
            onChange={(e) => setSelectedSourceType(e.target.value)}
          >
            <option value="">{t('kv.filter.allSourceTypes')}</option>
            <option value="bilibili">{t('kv.sourceType.bilibili')}</option>
            <option value="wechat">{t('kv.sourceType.wechat')}</option>
            <option value="manual">{t('kv.sourceType.manual')}</option>
          </select>

          {hasActiveFilters && (
            <button type="button" className={css.resetBtn} onClick={handleResetFilters}>
              {t('kv.filter.reset')}
            </button>
          )}
        </div>

        <div className={css.statsText}>
          {filteredCards.length} {t('kv.stats.cards')} · {clusterCount} {t('kv.stats.clusters')}
        </div>
      </div>

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
      </div>
    </div>
  )
}
