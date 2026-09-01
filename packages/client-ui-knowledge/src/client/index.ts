/**
 * client-ui-knowledge, browser half (issue #34 / P5 拆包).
 *
 * 接入面（一切皆插件）：ctx.inject(['tradingStageViews']) 把「知识库」视图注册
 * 进中栏注册表；桥与 SSE 经 tradingBridge 服务（shell 提供）inject 进视图 props。
 * shell 未安装时 inject 回调不触发，本插件静默无 UI（可选依赖语义）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import { KnowledgeView } from './KnowledgeView.tsx'
import type { KnowledgeLocaleKey } from './contract.ts'
import './contract.ts'

const NS = 'dshtrading.knowledge'

/** Required services：slot/locale 官方服务 + 视图注册面 + 桥面（后两者由
 * client-ui-trading client 半 provide；本插件 apply 同步访问 ctx.locale/ctx.slots，
 * 故必须声明；tradingStageViews/tradingBridge 在 apply 内 ctx.inject 异步等待，
 * 不进静态名单——shell 未安装时挂起无害，可选依赖语义）。 */
export const inject = ['slots', 'locale']

/** tradingStageViews / tradingBridge 的最小结构面（避免对 shell 包类型依赖）。 */
interface StageViewsService {
  register(definition: {
    id: string
    titleKey: string
    order?: number
    render: ComponentType<{ t: (key: string) => string; view: string }>
  }): void
}
interface BridgeService {
  fetchKnowledgeCards(): Promise<Array<Record<string, unknown>>>
  subscribeTradingEvents(handlers: Record<string, () => void>): () => void
}

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, dictionaries()), 'dsh-trading-knowledge-view: dictionaries')

  // 中栏「知识库」tab：视图组件在 render 闭包里捕获 t 与桥。
  // bridge/t 必须 apply 期只建一次（引用稳定）：render 闭包里每次新建字面量会让
  // 视图 useEffect([bridge]) 自激振荡——每帧重拉数据 + force-graph 每帧销毁重建，
  // 画布永远画不出来（2026-09-01 实证 fetch 风暴 ~80 req/s）。
  ctx.inject(['tradingStageViews', 'tradingBridge'] as never, (scope) => {
    const faces = scope as unknown as { tradingStageViews: StageViewsService; tradingBridge: BridgeService }
    const bridge = {
      fetchKnowledgeCards: () => faces.tradingBridge.fetchKnowledgeCards() as never,
      subscribeTradingEvents: (handlers) => faces.tradingBridge.subscribeTradingEvents(handlers),
    }
    faces.tradingStageViews.register({
      id: 'knowledge',
      titleKey: 'stage.knowledge',
      order: 20,
      render: (props) => KnowledgeView({
        t: t as unknown as (key: string) => string,
        view: props.view,
        bridge,
      }),
    })
  })
}

/** 文案字典：locale.register 契约 = { zh, en }。 */
function dictionaries(): Record<'zh' | 'en', Record<KnowledgeLocaleKey, string>> {
  return {
    zh: {
      'kv.search.placeholder': '搜索卡片标题、摘要、标签...',
      'kv.filter.tag': '主题标签',
      'kv.filter.allTags': '全部标签',
      'kv.filter.author': '来源作者',
      'kv.filter.allAuthors': '全部作者',
      'kv.filter.credibility': '可信度',
      'kv.filter.allCredibility': '全部评级',
      'kv.filter.sourceType': '来源平台',
      'kv.filter.allSourceTypes': '全部平台',
      'kv.filter.reset': '重置筛选',
      'kv.credibility.high': '高可信度 (High)',
      'kv.credibility.medium': '中可信度 (Medium)',
      'kv.credibility.low': '低可信度 (Low)',
      'kv.sourceType.bilibili': 'B站 (Bilibili)',
      'kv.sourceType.wechat': '微信公众号 (WeChat)',
      'kv.sourceType.manual': '手工录入 (Manual)',
      'kv.empty.hint': '知识库暂无内容。把 B 站视频或公众号文章链接发给助手，说「沉淀到知识库」即可入库。',
      'kv.empty.filtered': '未找到匹配当前筛选条件的知识卡片',
      'kv.stats.cards': '张卡片',
      'kv.stats.clusters': '个主题簇',
      'kv.drawer.title': '知识卡片详情',
      'kv.drawer.coreClaims': '核心论点',
      'kv.drawer.factCheck': '事实核查 (三桶分类)',
      'kv.drawer.verified': '经核实真实 (Verified)',
      'kv.drawer.discrepancies': '有出入/夸大 (Discrepancies)',
      'kv.drawer.unverifiable': '无法核实 (Unverifiable)',
      'kv.drawer.takeaways': '可复用分析经验',
      'kv.drawer.boundaries': '适用边界与避坑',
      'kv.drawer.tickers': '关联标的',
      'kv.drawer.related': '关联卡片',
      'kv.drawer.openSource': '打开原始链接',
      'kv.drawer.publishedAt': '发布日期',
      'kv.drawer.author': '来源作者',
    },
    en: {
      'kv.search.placeholder': 'Search title, summary, tags...',
      'kv.filter.tag': 'Topic Tag',
      'kv.filter.allTags': 'All Tags',
      'kv.filter.author': 'Author',
      'kv.filter.allAuthors': 'All Authors',
      'kv.filter.credibility': 'Credibility',
      'kv.filter.allCredibility': 'All Credibility',
      'kv.filter.sourceType': 'Platform',
      'kv.filter.allSourceTypes': 'All Platforms',
      'kv.filter.reset': 'Reset',
      'kv.credibility.high': 'High',
      'kv.credibility.medium': 'Medium',
      'kv.credibility.low': 'Low',
      'kv.sourceType.bilibili': 'Bilibili',
      'kv.sourceType.wechat': 'WeChat',
      'kv.sourceType.manual': 'Manual',
      'kv.empty.hint': 'No knowledge cards yet. Send a Bilibili video or WeChat article link to the assistant and say "Save to knowledge base" to ingest.',
      'kv.empty.filtered': 'No knowledge cards match the current filter criteria',
      'kv.stats.cards': 'Cards',
      'kv.stats.clusters': 'Clusters',
      'kv.drawer.title': 'Knowledge Card Details',
      'kv.drawer.coreClaims': 'Core Claims',
      'kv.drawer.factCheck': 'Fact Check (3 Buckets)',
      'kv.drawer.verified': 'Verified',
      'kv.drawer.discrepancies': 'Discrepancies',
      'kv.drawer.unverifiable': 'Unverifiable',
      'kv.drawer.takeaways': 'Reusable Takeaways',
      'kv.drawer.boundaries': 'Boundaries & Pitfalls',
      'kv.drawer.tickers': 'Related Tickers',
      'kv.drawer.related': 'Related Cards',
      'kv.drawer.openSource': 'Open Original URL',
      'kv.drawer.publishedAt': 'Published At',
      'kv.drawer.author': 'Author',
    },
  }
}