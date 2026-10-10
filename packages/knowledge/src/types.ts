/**
 * 知识库核心契约类型（对齐 docs/design/knowledge-graph.md §2）。
 */
export type KnowledgeSourceType = 'bilibili' | 'wechat' | 'manual'
export type KnowledgeCredibility = 'high' | 'medium' | 'low'

export interface KnowledgeFactCheck {
  readonly verified: readonly string[] // ✅ 证实
  readonly discrepancies: readonly string[] // ⚠️ 有出入
  readonly unverifiable: readonly string[] // ❓ 无法核实
}

export interface KnowledgeSource {
  readonly type: KnowledgeSourceType
  readonly url: string // 去重键：BV 页链接 / 微信文章链接 / manual
  readonly author: string // UP主 / 公众号名 / 手工
  readonly publishedAt?: string // 素材发布日期（ISO 日期）
}

export interface KnowledgeCard {
  readonly id: string // 'kc_' + 唯一标识（入库时生成，稳定不变）
  readonly title: string // 卡片主题（模板「知识卡片：<主题>」的主题段）
  readonly summary: string // 2-4 条核心论点合并的一句话概述（图谱 hover 文案）
  readonly source: KnowledgeSource
  readonly credibility: KnowledgeCredibility // 依据核查结论整体定级
  readonly coreClaims: readonly string[] // 核心论点（保留原作者推理链）
  readonly factCheck: KnowledgeFactCheck
  readonly takeaways: readonly string[] // 可复用的分析经验
  readonly boundaries: readonly string[] // 适用边界与避坑
  readonly tags: readonly string[] // 受控主题词
  readonly tickers?: readonly string[] // 可选关联标的（市场规范词汇：BTCUSDT / 600519.SH）
  readonly related?: readonly string[] // 显式关联卡片 id
  readonly createdAt: string
  readonly updatedAt: string
}

export type KnowledgeCardInput = Omit<KnowledgeCard, 'id' | 'createdAt' | 'updatedAt'> & {
  readonly id?: string
  readonly createdAt?: string
  readonly updatedAt?: string
}

export type GraphLinkKind = 'related' | 'co-tag' | 'co-author' | 'tag-hub'

export interface KnowledgeGraphNode {
  readonly id: string
  readonly label: string
  readonly cluster: string
  readonly credibility: KnowledgeCredibility
  readonly degree: number
  /** 节点类别：'card' = 知识卡片（默认，向后兼容），'tag' = 标签 hub 节点（Obsidian 式）。 */
  readonly type?: 'card' | 'tag'
  readonly raw?: KnowledgeCard
}

export interface KnowledgeGraphLink {
  readonly source: string
  readonly target: string
  readonly kind: GraphLinkKind
  readonly weight: number
}

export interface KnowledgeGraphData {
  readonly nodes: readonly KnowledgeGraphNode[]
  readonly links: readonly KnowledgeGraphLink[]
}

export interface BuildGraphOptions {
  readonly coTag?: boolean
  readonly coAuthor?: boolean
  /**
   * Obsidian 式标签 hub 模式（2026-09-01 起 UI 默认开启）：标签聚合为独立 hub 节点，
   * 卡片仅与自己的标签建边（kind='tag-hub'）+ 显式 related 建边；关闭 co-tag/co-author
   * 全配对边。大规模单作者/单标签库下全配对是 O(n²) 边爆炸（215 卡 ≈ 2 万+边），
   * 力导模拟发散、画布糊成一团——hub 模式把边数降为 O(卡片数 × 平均标签数)。
   */
  readonly tagHubs?: boolean
}

export interface KnowledgeCardStore {
  list(): Promise<readonly KnowledgeCard[]>
  get(id: string): Promise<KnowledgeCard | undefined>
  getByUrl(url: string): Promise<KnowledgeCard | undefined>
  save(card: KnowledgeCard): Promise<void>
  /**
   * 批量写入（可选能力）：最终状态等同于按序逐张 save，但实现可为一次事务。
   *
   * 存在的理由：文件版 store 的 save 是整表事务（跨进程排他锁 + 锁内读盘 + 序列化 +
   * 原子写），knowledge_delete 清理 F 张引用方就是 F+1 次整表落盘。调用方在能力存在时
   * 必须走本方法，缺席（轻量/第三方实现）则逐张 save 降级——正确性两版一致，只差落盘次数。
   */
  saveMany?(cards: readonly KnowledgeCard[]): Promise<void>
  delete(id: string): Promise<boolean>
}
