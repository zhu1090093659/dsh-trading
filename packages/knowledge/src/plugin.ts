/**
 * @dsh-trading/knowledge/plugin —— 知识能力 host 半插件（issue #33 / P4）。
 *
 * patch 行：id `dsh-trading-knowledge` / name `@dsh-trading/knowledge/plugin`
 * （base 拥有该共享行）。职责：
 * - provide `tradingKnowledgeCards` 服务（file store 单实例：桥 GET 与
 *   knowledge_ingest/search 共享同一缓存）；
 * - host 平面注册 `knowledge_ingest` / `knowledge_search` / `knowledge_get` /
 *   `knowledge_delete`（从 kit/client-ui-trading 双注册收口）+ `knowledge_graph`
 *   （buildGraph 的只读结构概要包装）；
 * - 写/删成功 emit tradingEvents('knowledge')（issue #30 通道）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import os from 'node:os'
import path from 'node:path'
import { buildGraph } from './graph.ts'
import type { KnowledgeCardStore } from './types.ts'
import { createFileKnowledgeCardStore } from './knowledge-fs.ts'
import {
  createKnowledgeDeleteTool,
  createKnowledgeGetTool,
  createKnowledgeIngestTool,
  createKnowledgeSearchTool,
} from './tool.ts'

// 桥经本子路径取 file store（knowledge/tool 同款再导出先例）。
export { createFileKnowledgeCardStore }

/** Cordis 插件名 = patch 行 id（TEMPLATES §8）。 */
export const name = 'dsh-trading-knowledge'

/** 本插件不硬依赖任何服务。 */
export const inject: string[] = []

/** SDK 服务键：知识卡片 store 单实例。 */
export const TRADING_KNOWLEDGE_CARDS_KEY = 'tradingKnowledgeCards'

/** tradingEvents 的最小发布面（鸭式；总线缺席时静默降级）。 */
export interface TradingEventsPublisher {
  emit(store: 'knowledge'): void
}

/** 默认存储路径：~/.dsh/knowledge/cards.json（与 client-ui-trading 旧路径一致）。 */
export function defaultStorePath(): string {
  return path.join(os.homedir(), '.dsh', 'knowledge', 'cards.json')
}

export interface KnowledgeGraphToolOptions {
  store: KnowledgeCardStore
}

/** knowledge_graph 工厂（issue #33 新增；只读结构概要，不倾倒全量 label）。 */
export function createKnowledgeGraphTool(options: KnowledgeGraphToolOptions) {
  const { store } = options
  return defineTool({
    name: 'knowledge_graph',
    description:
      'Level 1 of the two-level knowledge retrieval: structural overview of the persisted cards '
      + '(nodes = cards, edges = shared tags/authors/related). Returns the full cluster (topic) '
      + 'distribution and credibility counts. Pick a cluster here, then drill down with '
      + 'knowledge_search { cluster } and read full cards with knowledge_get.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const cards = await store.list()
      const data = buildGraph(cards)
      // 两级检索第一级：主体（聚类键 = 卡片首个标签）全量分布——清洗后约 10-20 个
      // 主体，全量返回成本可忽略；卡片级内容一律走 knowledge_search / knowledge_get。
      const clusterCounts = new Map<string, number>()
      const credibility = { high: 0, medium: 0, low: 0 }
      for (const card of cards) {
        const cluster = card.tags[0] ?? '未分类'
        clusterCounts.set(cluster, (clusterCounts.get(cluster) ?? 0) + 1)
        credibility[card.credibility] += 1
      }
      const clusters = [...clusterCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cluster, count]) => ({ cluster, count }))
      return JSON.stringify({
        ok: true,
        cards: cards.length,
        nodeCount: data.nodes.length,
        edgeCount: data.links.length,
        clusters,
        credibility,
      })
    },
  })
}

export interface KnowledgePluginDeps {
  store: KnowledgeCardStore
}

export function registerKnowledgeTools(ctx: Context, deps: KnowledgePluginDeps): void {
  ctx.inject(['tools'] as never, (toolCtx) => {
    const tools = (toolCtx as unknown as { tools?: { register(t: unknown): void; get(name: string): unknown } }).tools
    if (!tools || typeof tools.register !== 'function') return

    const events = (): TradingEventsPublisher | undefined =>
      (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingEvents', false) as TradingEventsPublisher | undefined

    const register = (tool: ReturnType<typeof defineTool>) => {
      if (tools.get(tool.name) === undefined) tools.register(tool)
    }
    register(createKnowledgeIngestTool(deps.store, {
      onWritten: () => events()?.emit('knowledge'),
    }))
    register(createKnowledgeSearchTool(deps.store))
    register(createKnowledgeGetTool(deps.store))
    register(createKnowledgeDeleteTool(deps.store, {
      onWritten: () => events()?.emit('knowledge'),
    }))
    register(createKnowledgeGraphTool({ store: deps.store }))
  })
}

/** 知识卡片 store 服务（桥与工具的单实例共享点）。 */
export class KnowledgeCardsService extends Service {
  readonly store: KnowledgeCardStore
  constructor(ctx: Context, store: KnowledgeCardStore, serviceName: string = TRADING_KNOWLEDGE_CARDS_KEY) {
    super(ctx, serviceName)
    this.store = store
  }
}

/** Host plugin body：store 服务 provide + 工具注册。 */
export function apply(ctx: Context): void {
  const store = createFileKnowledgeCardStore(defaultStorePath())
  new KnowledgeCardsService(ctx, store)
  registerKnowledgeTools(ctx, { store })
}
