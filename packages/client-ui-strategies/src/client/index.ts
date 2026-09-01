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
import type { StrategyLocaleKey } from './contract.ts'
import './contract.ts'

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
  subscribeTradingEvents(handlers: Record<string, () => void>): () => void
}

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, dictionaries()), 'dsh-trading-strategies-view: dictionaries')

  // 中栏「策略」tab：视图组件在 render 闭包里捕获 t 与桥（服务就绪后注册，
  // 依赖时序由 cordis inject 解析保证）。
  ctx.inject(['tradingStageViews', 'tradingBridge'] as never, (scope) => {
    const faces = scope as unknown as { tradingStageViews: StageViewsService; tradingBridge: BridgeService }
    faces.tradingStageViews.register({
      id: 'strategy',
      titleKey: 'stage.strategy',
      order: 10,
      render: (props) => StrategyView({
        // shell 词典的 stage.tab 文案由宿主 t（dshtrading.market）渲染——这里
        // 只收本包词典；tab 条的 t 由 MiddleStage 自己出。视图内 t 走本包 NS。
        t: t as unknown as (key: string) => string,
        view: props.view,
        bridge: {
          fetchKlines: (market, symbol, interval, limit) =>
            faces.tradingBridge.fetchKlines(market, symbol, interval, limit) as never,
          fetchCustomStrategies: () =>
            faces.tradingBridge.fetchCustomStrategies() as never,
          subscribeTradingEvents: (handlers) => faces.tradingBridge.subscribeTradingEvents(handlers),
        },
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

/** 文案字典：locale.register 契约 = { zh, en }。 */
function dictionaries(): Record<'zh' | 'en', Record<StrategyLocaleKey, string>> {
  return {
    zh: {
      'sv.horizon.short': '短线交易',
      'sv.horizon.swing': '波段操作',
      'sv.horizon.long': '长线投资',
      'sv.run': '运行回测',
      'sv.running': '回测计算中...',
      'sv.symbolLabel': '标的:',
      'sv.intervalDaily': '(日K)',
      'sv.error.noKlines': '未能获取到该标的的 K 线数据，无法执行回测',
      'sv.error.failed': '策略计算异常',
      'sv.metrics.totalReturn': '累计收益率',
      'sv.metrics.cagr': '年化复合增长率 (CAGR)',
      'sv.metrics.maxDrawdown': '最大回撤 (MDD)',
      'sv.metrics.sharpe': '夏普比率 (Sharpe)',
      'sv.metrics.winRate': '胜率 (Win Rate)',
      'sv.metrics.profitFactor': '盈亏比 (Profit Factor)',
      'sv.metrics.tradeCount': '交易笔数',
      'sv.metrics.tradeUnit': '笔',
      'sv.metrics.exposure': '市场暴露度 (Exposure)',
      'sv.trades.title': '交易明细流水',
      'sv.trades.empty': '回测区间内未触发交易信号',
      'sv.trades.entryTime': '开仓时间',
      'sv.trades.exitTime': '平仓时间',
      'sv.trades.entryPrice': '开仓均价',
      'sv.trades.exitPrice': '平仓均价',
      'sv.trades.holdingBars': '持仓根数',
      'sv.trades.netReturn': '单笔净收益率',
      'sv.trades.exitReason': '离场原因',
      'sv.empty.hint': '选择上方策略与参数后，点击「运行回测」查看绩效与权益曲线',
    },
    en: {
      'sv.horizon.short': 'Short-term',
      'sv.horizon.swing': 'Swing',
      'sv.horizon.long': 'Long-term',
      'sv.run': 'Run Backtest',
      'sv.running': 'Running...',
      'sv.symbolLabel': 'Symbol & Interval:',
      'sv.intervalDaily': '(Daily)',
      'sv.error.noKlines': 'Failed to fetch klines for this symbol, cannot run backtest',
      'sv.error.failed': 'Strategy compute error',
      'sv.metrics.totalReturn': 'Total Return',
      'sv.metrics.cagr': 'CAGR',
      'sv.metrics.maxDrawdown': 'Max Drawdown',
      'sv.metrics.sharpe': 'Sharpe Ratio',
      'sv.metrics.winRate': 'Win Rate',
      'sv.metrics.profitFactor': 'Profit Factor',
      'sv.metrics.tradeCount': 'Trades',
      'sv.metrics.tradeUnit': 'trades',
      'sv.metrics.exposure': 'Market Exposure',
      'sv.trades.title': 'Trade Log',
      'sv.trades.empty': 'No trades generated in the backtest period',
      'sv.trades.entryTime': 'Entry Time',
      'sv.trades.exitTime': 'Exit Time',
      'sv.trades.entryPrice': 'Entry Price',
      'sv.trades.exitPrice': 'Exit Price',
      'sv.trades.holdingBars': 'Holding Bars',
      'sv.trades.netReturn': 'Net Return',
      'sv.trades.exitReason': 'Exit Reason',
      'sv.empty.hint': 'Select a strategy and parameters above, then click "Run Backtest"',
    },
  }
}