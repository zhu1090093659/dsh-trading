/**
 * client-ui-strategies, browser half (issue #34 / P5 拆包).
 *
 * 接入面（一切皆插件）：ctx.inject(['tradingStageViews']) 把「策略」视图注册进
 * 中栏注册表；桥与 SSE 经 tradingBridge 服务（shell 提供）inject 进视图 props。
 * shell 未安装时两个 inject 回调都不触发，本插件静默无 UI（可选依赖语义）。
 *
 * 额外注册 tool.call.toolview keyed slot（key = strategy_backtest / strategy_author）：
 * 对话内富卡片——回测 8 指标 mini 卡 + 权益曲线 sparkline；author 校验结果摘要。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { StrategyView } from './StrategyView.tsx'
import { StrategyBacktestCard, StrategyAuthorCard } from './toolview.tsx'
import './contract.ts'

import { en, zh } from './locales.ts'
const NS = 'dshtrading.strategies'

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
  fetchKlines(market: string, symbol: string, interval: string, limit: number): Promise<unknown[]>
  fetchCustomStrategies(): Promise<Array<Record<string, unknown>>>
  fetchSymbols(market: string): Promise<Array<{ symbol: string; name?: string }>>
  subscribeTradingEvents(handlers: Record<string, () => void>): () => void
}

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-trading-strategies-view: dictionaries')

  // 中栏「策略」tab：视图组件在 render 闭包里捕获 t 与桥（服务就绪后注册，
  // 依赖时序由 cordis inject 解析保证）。
  // bridge/t 必须 apply 期只建一次（引用稳定）：render 闭包里每次新建字面量会让
  // 视图 useEffect([bridge]) 自激振荡——每帧重拉数据（2026-09-01 实证 fetch 风暴）。
  ctx.inject(['tradingStageViews', 'tradingBridge'] as never, (scope) => {
    const faces = scope as unknown as { tradingStageViews: StageViewsService; tradingBridge: BridgeService }
    const bridge = {
      fetchKlines: (market, symbol, interval, limit) =>
        faces.tradingBridge.fetchKlines(market, symbol, interval, limit) as never,
      fetchCustomStrategies: () =>
        faces.tradingBridge.fetchCustomStrategies() as never,
      fetchSymbols: (market) =>
        faces.tradingBridge.fetchSymbols(market) as never,
      subscribeTradingEvents: (handlers) => faces.tradingBridge.subscribeTradingEvents(handlers),
    }
    faces.tradingStageViews.register({
      id: 'strategy',
      titleKey: 'stage.strategy',
      order: 10,
      render: (props) => StrategyView({
        // shell 词典的 stage.tab 文案由宿主 t（dshtrading.market）渲染——这里
        // 只收本包词典；tab 条的 t 由 MiddleStage 自己出。视图内 t 走本包 NS。
        t: t as unknown as (key: string) => string,
        view: props.view,
        bridge,
      }),
    })
  })

  // 对话内富卡片（§5.5）：strategy_backtest 权益曲线 + 8 指标 mini 卡；
  // strategy_author 校验结果 + 参数摘要。keyed slot，key = 工具名。
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'strategy_backtest',
    locale: NS,
  }, StrategyBacktestCard as unknown as ComponentType<ToolCallOwnerProps & { t: (key: string) => string }>))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'strategy_author',
    locale: NS,
  }, StrategyAuthorCard as unknown as ComponentType<ToolCallOwnerProps & { t: (key: string) => string }>))
}
