/**
 * Trading GUI shell, browser half. Slot 布局（不改 DSH 源码，全部走官方 slot 机制）:
 *
 * - `shell.overlay`（dshtrading-market-dock）→ 左侧自选停靠面板
 * - `sidebar.workspaces`（priority -1 遮蔽 WorkspaceBrowser）→ 会话历史的
 *   挂载面：面板 DOM 经 portal 并入官方 hero 容器（HomeHistory——历史与
 *   hero composer 拼成同一个容器），侧栏列只留 hidden 占位维持遮蔽
 * - `shell.overlay`（dshtrading-quote-pane）→ 中栏行情面板（恒渲染；
 *   对话列由宿主官方 UI 常驻右侧栏，见 shell-pad.css 2.4 布局）
 * - `shell.overlay`（dshtrading-session-rail）→ 右缘常驻会话竖条（折叠/
 *   新会话/设置，2.9 起取代窗口角标浮动簇 + 会话头内联按钮双入口）
 *
 * 行情数据走 node 半注册的 /dshtrading/api 桥（同源 fetch，浏览器认证栅栏内）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IndicatorRegistry } from '@dsh-trading/indicators'
import { createSelectionStore, createWatchlistStore } from './store.ts'
import { createChartStateStore } from './chart-state.ts'
import { indicators } from './indicator-registry.ts'
import { MarketDock } from './MarketDock.tsx'
import { QuotePane } from './QuotePane.tsx'
import { HomeHistory } from './HomeHistory.tsx'
import { SessionRail } from './SessionRail.tsx'
import { foldStore } from './fold-store.ts'
import './shell-pad.css'
import type { MarketLocaleKey } from './contract.ts'

/** 本面板/字符串翻译的 locale namespace。 */
const NS = 'dshtrading.market'

/** Required services：会话区读官方 sessions/workspaces 状态；startSession 是
 * 右栏退役后新会话的唯一通路（无参取当前/最近工作区）。 */
export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']

/** uiWorkspace 的最小结构面（startSession = 建/复用并打开会话）。 */
interface WorkspaceNavigation {
  startSession(workspaceId?: string): void
}

/** 注册 slot + locale 字典。 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, dictionaries()), 'dsh-trading-market: dictionaries')

  const selection = createSelectionStore()
  const watchlists = createWatchlistStore()
  const chart = createChartStateStore(indicators)
  const sessions = ctx.sessions as unknown as ISessions
  const uiWorkspace = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation | undefined

  // 共享入口动作：右缘竖条（2.9 起唯一会话入口）使用。
  const startNewSession = (): void => { uiWorkspace?.startSession() }
  const openSettings = (): void => {
    // 官方设置触发器在退役侧栏列内（整列移出视口保持挂载）；触发器是
    // 侧栏里唯一的 [aria-haspopup=dialog]，程序化 click 走官方打开逻辑，
    // 弹层 position:fixed 盖满视口不受列位置影响。
    document
      .querySelector<HTMLElement>("div:has(> [data-shell-overlay]) > div:nth-child(1) [aria-haspopup='dialog']")
      ?.click()
  }
  const folded = foldStore()
  const toggleFold = (): void => { folded.toggle() }

  // 静态包的 slot 条目崩溃默认无人上报（监督缝只覆盖动态插件）——打到 console 可见化。
  ctx.slots.onEntryError((slot, _entry, error) => {
    console.error(`[dsh-trading] slot entry crashed: ${slot}`, error)
  })

  // 指标插件桥（可选依赖）：client-ui-indicators 在 client 上下文提供
  // tradingIndicators 服务（IndicatorRegistry，含预置）；插件未安装时
  // 回调不触发，行情视图零指标正常工作。definition 是纯数据+纯函数，
  // 合并进本地注册表即可用；register 通知订阅者（选择器名册重渲染）。
  ctx.inject(['tradingIndicators'] as never, (scope) => {
    const service = (scope as unknown as { tradingIndicators: IndicatorRegistry }).tradingIndicators
    for (const definition of service.list()) indicators.register(definition)
  })

  // 左侧停靠：自选面板（官方浮层通道；宿主栅格四轨道重排见 shell-pad.css）。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dshtrading-market-dock',
    order: 10,
    locale: NS,
    inject: () => ({
      hooks: { selection, watchlists },
      addInstrument: (market, instrument) => { watchlists.add(market, instrument) },
      removeInstrument: (market, symbol) => { watchlists.remove(market, symbol) },
      selectInstrument: (instrument) => { selection.select(instrument) },
    }),
  }, MarketDock))

  // 会话历史（sidebar.workspaces）：遮蔽官方 WorkspaceBrowser（其每组
  // 「+ 新会话」/添加工作区在融合布局下是冗余入口）；HomeHistory 面板
  // 经 portal 并入官方 hero 容器，数据面仍全是官方 sessions/workspaces 服务。
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    id: 'dshtrading-home-history',
    priority: -1,
    locale: NS,
    inject: () => ({
      openSession: (sessionId) => { sessions.open(sessionId) },
      startNewSession,
    }),
  }, HomeHistory))

  // 会话竖条（shell.overlay）：右缘 44px 常驻（折叠/新会话/设置竖排），
  // 恒挂载——首页、会话进行中、折叠态都是同一入口，不再按状态切换入口面。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dshtrading-session-rail',
    order: 60,
    locale: NS,
    inject: () => ({
      startNewSession,
      openSettings,
      toggleFold,
      hooks: { folded },
    }),
  }, SessionRail))

  // 中栏行情面板：恒渲染，盖住栅格第 3 轨道（行情区）；3.0 起内含
  // MiddleStage 视图注册表（行情 | 量化），指标态走 chart store。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dshtrading-quote-pane',
    order: 50,
    locale: NS,
    inject: () => ({
      hooks: { selection, chart },
      toggleIndicator: (id) => { chart.togglePreset(id) },
      setIndicatorParams: (id, params) => { chart.setParams(id, params) },
    }),
  }, QuotePane))
}

/** 文案字典：locale.register 契约 = { zh, en }。 */
function dictionaries(): Record<'zh' | 'en', Record<MarketLocaleKey, string>> {
  return {
    zh: {
      'tab.watch': '自选',
      'tab.crypto': '加密货币',
      'tab.us': '美股',
      'tab.cn': 'A股',
      'tab.hk': '港股',
      'sidebar.addPlaceholder': '输入代码，回车加入自选',
      'sidebar.add': '添加',
      'sidebar.addMarketHint': '点击切换目标市场（加密货币→美股→A股→港股）',
      'sidebar.empty': '暂无标的',
      'sidebar.emptyHint': '在上方输入代码加入自选（可切换目标市场）',
      'sidebar.loadFailed': '行情桥不可用（未装市场包？）',
      'sidebar.retry': '重试',
      'sidebar.markets': '市场与自选',
      'row.remove': '移除',
      'row.select': '查看行情',
      'quote.empty': '选择左侧标的查看行情',
      'quote.emptyHint': '左栏点击任意标的，这里展示 K 线与关键报价',
      'quote.open': '开',
      'quote.high': '高',
      'quote.low': '低',
      'quote.prevClose': '昨收',
      'quote.volume': '量',
      'quote.updated': '更新',
      'quote.loadFailed': 'K线加载失败',
      'quote.noData': '暂无数据',
      'interval.15m': '15分',
      'interval.1h': '时',
      'interval.4h': '4时',
      'interval.1d': '日',
      'interval.1w': '周',
      'interval.1M': '月',
      'browser.history': '历史会话',
      'browser.historyEmpty': '该工作区还没有会话',
      'entry.new': '新会话',
      'entry.settings': '设置',
      'chat.fold': '折叠会话列',
      'chat.expand': '展开会话列',
      'stage.quote': '行情',
      'stage.workflow': '量化',
      'workflow.title': '量化工作流',
      'workflow.placeholder': '回测与量化工作流正在规划中：策略编排、历史回测、绩效分析将在此区域展开。',
      'indicator.picker': '技术指标',
      'indicator.group.main': '主图指标',
      'indicator.group.sub': '副图指标',
      'indicator.empty': '暂无可用指标（未安装指标插件？）',
      'indicator.params': '参数',
      'indicator.apply': '应用',
      'indicator.cancel': '取消',
    },
    en: {
      'tab.watch': 'Watchlist',
      'tab.crypto': 'Crypto',
      'tab.us': 'US Stocks',
      'tab.cn': 'China A',
      'tab.hk': 'Hong Kong',
      'sidebar.addPlaceholder': 'Symbol, Enter to add',
      'sidebar.add': 'Add',
      'sidebar.addMarketHint': 'Click to cycle target market (crypto→us→cn→hk)',
      'sidebar.empty': 'No instruments',
      'sidebar.emptyHint': 'Type a symbol above to add (cycle target market)',
      'sidebar.loadFailed': 'Quote bridge unavailable (market bundle missing?)',
      'sidebar.retry': 'Retry',
      'sidebar.markets': 'Markets & watchlist',
      'row.remove': 'Remove',
      'row.select': 'View quote',
      'quote.empty': 'Pick an instrument on the left',
      'quote.emptyHint': 'Click any row in the sidebar to chart it here',
      'quote.open': 'Open',
      'quote.high': 'High',
      'quote.low': 'Low',
      'quote.prevClose': 'Prev close',
      'quote.volume': 'Vol',
      'quote.updated': 'Updated',
      'quote.loadFailed': 'Failed to load klines',
      'quote.noData': 'No data',
      'interval.15m': '15m',
      'interval.1h': '1H',
      'interval.4h': '4H',
      'interval.1d': 'D',
      'interval.1w': 'W',
      'interval.1M': 'M',
      'browser.history': 'History',
      'browser.historyEmpty': 'No sessions in this workspace',
      'entry.new': 'New session',
      'entry.settings': 'Settings',
      'chat.fold': 'Fold conversation panel',
      'chat.expand': 'Expand conversation panel',
      'stage.quote': 'Chart',
      'stage.workflow': 'Quant',
      'workflow.title': 'Quant Workflow',
      'workflow.placeholder': 'Backtesting and quant workflows are on the way: strategy composition, historical backtests and performance analytics will live here.',
      'indicator.picker': 'Indicators',
      'indicator.group.main': 'Main chart',
      'indicator.group.sub': 'Sub-chart',
      'indicator.empty': 'No indicators available (indicator plugin missing?)',
      'indicator.params': 'Params',
      'indicator.apply': 'Apply',
      'indicator.cancel': 'Cancel',
    },
  }
}
