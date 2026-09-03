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
import './contract.ts'

import { en, zh } from './locales.ts'
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
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-trading-knowledge-view: dictionaries')

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
