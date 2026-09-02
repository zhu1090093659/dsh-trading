/**
 * Trading GUI shell, browser half. Slot 布局（不改 DSH 源码，全部走官方 slot 机制）:
 *
 * - `shell.overlay`（dshtrading-market-dock）→ 左侧自选停靠面板（支持富途式展开与折叠竖条）
 * - `sidebar.workspaces`（priority -1 遮蔽 WorkspaceBrowser）→ 会话历史的
 *   挂载面：面板 DOM 经 portal 并入官方 hero 容器（HomeHistory——历史与
 *   hero composer 拼成同一个容器），侧栏列只留 hidden 占位维持遮蔽
 * - `shell.overlay`（dshtrading-quote-pane）→ 中栏行情面板（恒渲染；
 *   对话列由宿主官方 UI 常驻右侧栏，见 shell-pad.css 2.4 布局）
 * - `shell.overlay`（dshtrading-session-rail）→ 右缘常驻会话竖条（折叠/
 *   新会话/设置，2.9 起取代窗口角标浮动簇 + 会话头内联按钮双入口）
 * - `shell.overlay`（dshtrading-chat-resize-handle）→ 对话列左缘拖拽调宽
 *   手柄（宿主手柄在 rtl 下坐标错位被隐藏，见 shell-pad.css 规则 4）
 *
 * 行情数据走 node 半注册的 /dshtrading/api 桥（同源 fetch，浏览器认证栅栏内）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IndicatorRegistry } from '@dsh-trading/indicators'
import { validateCustomIndicatorAsync } from '@dsh-trading/indicators'
import { createSelectionStore, createWatchlistStore } from './store.ts'
import { createChartStateStore } from './chart-state.ts'
import { indicators, markCustomIndicator, unmarkCustomIndicator } from './indicator-registry.ts'
import { stageViews } from './stage-views.ts'
import { createTradingBridgeService } from './api.ts'
import { sendQuoteToAgent, type SendToAgentFn } from './send-to-agent.ts'
import { OrderCard, WatchlistChipCard } from './toolview.tsx'
import { MarketDock } from './MarketDock.tsx'
import { QuotePane } from './QuotePane.tsx'
import { HomeHistory } from './HomeHistory.tsx'
import { SessionRail } from './SessionRail.tsx'
import { ChatResizeHandle } from './ChatResizeHandle.tsx'
import { foldStore, marketFoldStore } from './fold-store.ts'
import { deleteCustomIndicator, fetchCustomIndicators, subscribeTradingEvents } from './api.ts'
import { wireHostWatchlistSync } from './host-watchlist-sync.ts'
import './tokens.css'
import './shell-pad.css'
import type { MarketLocaleKey } from './contract.ts'

/** 本面板/字符串翻译的 locale namespace。 */
const NS = 'dshtrading.market'

/** Required services：会话区读官方 sessions 状态；startSession 是右栏退役后
 * 新会话的唯一通路（无参取当前/最近工作区）。注意 startSession 在
 * uiWorkspace（UiWorkspaceService，官方 sidebar/conversation 同款消费方式），
 * 不在 workspaces（纯 WorkspaceController：create/rename/archive，无导航）。 */
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

  // 共享入口动作：右缘竖条（2.9 起唯一会话入口）使用。
  // uiWorkspace 必须在点击时惰性解析：官方 dsh.client.inject 边只是加载/预取
  // 元数据、「never apply sequencing」（ui-workspace 同款注释）——服务由
  // dsh-client-ui-workspace 的 apply 注册，apply 时序不保证，过早捕获会在
  // 服务未就绪时拿到 undefined 并永久失效。官方 dsh-client-ui-sidebar 即
  // ctx.get('uiWorkspace').startSession() 同款。
  const startNewSession = (): void => {
    ;(ctx.get('uiWorkspace') as unknown as WorkspaceNavigation | undefined)?.startSession()
  }

  // 行情 → Agent（「发给 Agent」按钮）：复用 sessions + startNewSession 入口，
  // 投递编排细节见 send-to-agent.ts（beginSubmission echo → prompt('queue')）。
  const sendToAgent: SendToAgentFn = (text, image) =>
    sendQuoteToAgent({ sessions, startSession: startNewSession }, text, image)
  const openSettings = (): void => {
    // 官方设置触发器在退役侧栏列内（整列移出视口保持挂载）；触发器是
    // 侧栏里唯一的 [aria-haspopup=dialog]，程序化 click 走官方打开逻辑，
    // 弹层 position:fixed 盖满视口不受列位置影响。
    document
      .querySelector<HTMLElement>("div:has(> [data-shell-overlay]) > div:nth-child(1) [aria-haspopup='dialog']")
      ?.click()
  }
  const chatFolded = foldStore()
  const marketFolded = marketFoldStore()
  const toggleFold = (): void => { chatFolded.toggle() }
  const toggleMarketFold = (): void => { marketFolded.toggle() }

  // 静态包的 slot 条目崩溃默认无人上报（监督缝只覆盖动态插件）——打到 console 可见化。
  ctx.slots.onEntryError((slot, _entry, error) => {
    console.error(`[dsh-trading] slot entry crashed: ${slot}`, error)
  })

  // 中栏视图开放注册面（issue #34 / P5）：provide tradingStageViews —— 策略/
  // 知识/第三方视图包经 ctx.inject(['tradingStageViews'], …) register 定义即新增
  // 中栏 tab；插件未安装时名册只有 quote，行情视图独立正常工作（可选依赖语义）。
  // provide 由插件 fiber 持有（tradingIndicators 同款），插件卸载服务随之注销。
  ctx.reflect.provide('tradingStageViews', stageViews)

  // 视图包的桥依赖面：provide tradingBridge（K线/策略/知识卡 fetch + SSE 订阅
  // 共享单例）。视图包不 import shell 内部模块，只经服务 inject。
  ctx.reflect.provide('tradingBridge', createTradingBridgeService())

  // quote 视图是 registry 的内建种子条目（stage-views.ts 工厂内写入）——tab 条
  // 从名册统一渲染，MiddleStage 对 quote 走 QuoteStage 直引面。

  // 对话内富卡片（issue #34 / P5 §5.5）：下单三态卡（4 市场 keyed 各一把 +
  // 生成器注册）与自选 chip 卡。策略/知识卡的注册在各自视图包（归属随视图）。
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const market of ['crypto', 'us', 'cn', 'hk'] as const) {
      yield ctx.slots.register({
        name: 'tool.call.toolview',
        key: `${market}_place_order`,
        locale: NS,
      }, OrderCard as never)
    }
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'watchlist_add', locale: NS }, WatchlistChipCard as never)
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'watchlist_select', locale: NS }, WatchlistChipCard as never)
  })

  // 指标插件桥（可选依赖）：client-ui-indicators 在 client 上下文提供
  // tradingIndicators 服务（IndicatorRegistry，含预置）；插件未安装时
  // 回调不触发，行情视图零指标正常工作。definition 是纯数据+纯函数，
  // 合并进本地注册表即可用；register 通知订阅者（选择器名册重渲染）。
  ctx.inject(['tradingIndicators'] as never, (scope) => {
    const service = (scope as unknown as { tradingIndicators: IndicatorRegistry }).tradingIndicators
    for (const definition of service.list()) indicators.register(definition)
  })

  // Issue #19 + #30：异步拉取并注册已持久化的自定义指标；SSE 'indicators' 失效
  // 信号到达时重拉（register 同名覆盖幂等），indicator_author 入库无需刷新即上榜。
  const loadCustomIndicators = async (): Promise<void> => {
    try {
      const customList = await fetchCustomIndicators()
      for (const item of customList) {
        // issue #31：浏览器端校验走 Worker 超时熔断（validateCustomIndicatorAsync），
        // 补 new Function 裸执行「恶意/死循环源码卡死主线程」的既知缺口。
        const result = await validateCustomIndicatorAsync(item)
        if (result.ok) {
          indicators.register(result.definition)
          markCustomIndicator(result.definition.id)
        }
      }
    } catch (e) {
      console.warn('[dsh-trading] failed to fetch custom indicators:', e)
    }
  }
  void loadCustomIndicators()

  // SSE 失效信号订阅（issue #30）：EventSource 单例在 api.ts（多视图共享一条
  // 连接）；EventSource 不可用或桥 503 → 一次性 fetch 的现状兜底（不劣于现状）。
  subscribeTradingEvents({
    indicators: () => { void loadCustomIndicators() },
  })

  // 自选股 host SSOT 同步（issue #32）：启动同步 + 一次性迁移 + 变更 host-first
  // 接管（add/remove/select 写 host 成功后才更新本地）+ SSE 双通道刷新。
  wireHostWatchlistSync({ watchlists, selection })

  // 左侧停靠：自选面板（官方浮层通道；支持展开与折叠态 MarketRail）。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dshtrading-market-dock',
    order: 10,
    locale: NS,
    inject: () => ({
      hooks: { selection, watchlists, marketFolded },
      addInstrument: (market, instrument) => { watchlists.add(market, instrument) },
      removeInstrument: (market, symbol) => { watchlists.remove(market, symbol) },
      selectInstrument: (instrument) => { selection.select(instrument) },
      toggleFold: toggleMarketFold,
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
      hooks: { folded: chatFolded },
    }),
  }, SessionRail))

  // 会话列拖拽调宽手柄（shell.overlay）：贴对话列左缘常驻；宽度持久化
  // chat-width-store（dshtrading.chat.width.v1），拖拽直写 body 变量
  // --dshtrading-chat-user-w 驱动栅格（shell-pad.css 规则 3/10）。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dshtrading-chat-resize-handle',
    order: 61,
    locale: NS,
    inject: () => ({
      hooks: { folded: chatFolded },
    }),
  }, ChatResizeHandle))

  // 中栏面板：恒渲染，盖住栅格第 3 轨道（行情区）；内含 MiddleStage 视图注册表（行情 | 策略 | 知识库）
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dshtrading-quote-pane',
    order: 50,
    locale: NS,
    inject: () => ({
      hooks: { selection, chart },
      toggleIndicator: (id) => { chart.togglePreset(id) },
      setIndicatorParams: (id, params) => { chart.setParams(id, params) },
      deleteIndicator: async (id) => {
        const ok = await deleteCustomIndicator(id)
        if (ok) {
          indicators.unregister(id)
          unmarkCustomIndicator(id)
          chart.removeInstance(id)
        }
        return ok
      },
      sendToAgent,
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
      'sidebar.fold': '收起自选',
      'sidebar.expand': '展开自选',
      'header.symbol': '名称代码',
      'header.trend': '走势',
      'header.priceChange': '最新价/涨跌幅',
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
      'quote.sendToAgent': '发给 Agent',
      'quote.sendSending': '发送中…',
      'quote.sendSent': '已发给 Agent',
      'quote.sendFailed': '发送失败',
      'interval.1m': '1分',
      'interval.3m': '3分',
      'interval.5m': '5分',
      'interval.10m': '10分',
      'interval.15m': '15分',
      'interval.30m': '30分',
      'interval.1h': '1小时',
      'interval.4h': '4小时',
      'interval.1d': '日K',
      'interval.1w': '周K',
      'interval.1M': '月K',
      'status.trading': '交易中',
      'status.closed': '已收盘',
      'status.midday': '午间休市',
      'status.preMarket': '盘前',
      'status.afterHours': '盘后',
      'status.auction': '集合竞价',
      'browser.history': '历史会话',
      'browser.historyEmpty': '该工作区还没有会话',
      'browser.showMore': '展开其余 {n} 条',
      'browser.showLess': '收起',
      'entry.new': '新会话',
      'entry.settings': '设置',
      'chat.fold': '折叠会话列',
      'chat.expand': '展开会话列',
      'chat.resize': '拖拽调整会话列宽度（双击复位，方向键微调）',
      'stage.quote': '行情',
      'stage.strategy': '策略',
      'stage.knowledge': '知识库',
      'indicator.picker': '技术指标',
      'indicator.group.main': '主图指标',
      'indicator.group.sub': '副图指标',
      'indicator.empty': '暂无可用指标（未安装指标插件？）',
      'indicator.params': '参数',
      'indicator.apply': '应用',
      'indicator.cancel': '取消',
      'indicator.delete': '删除',
      'indicator.deleteConfirm': '确定删除该自定义指标？已持久化的定义将从指标库移除。',
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
      'sidebar.fold': 'Collapse watchlist',
      'sidebar.expand': 'Expand watchlist',
      'header.symbol': 'Symbol',
      'header.trend': 'Trend',
      'header.priceChange': 'Price / Change',
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
      'quote.sendToAgent': 'Send to agent',
      'quote.sendSending': 'Sending…',
      'quote.sendSent': 'Sent to agent',
      'quote.sendFailed': 'Send failed',
      'interval.1m': '1m',
      'interval.3m': '3m',
      'interval.5m': '5m',
      'interval.10m': '10m',
      'interval.15m': '15m',
      'interval.30m': '30m',
      'interval.1h': '1H',
      'interval.4h': '4H',
      'interval.1d': 'D',
      'interval.1w': 'W',
      'interval.1M': 'M',
      'status.trading': 'Trading',
      'status.closed': 'Closed',
      'status.midday': 'Midday break',
      'status.preMarket': 'Pre-market',
      'status.afterHours': 'After-hours',
      'status.auction': 'Auction',
      'browser.history': 'History',
      'browser.historyEmpty': 'No sessions in this workspace',
      'browser.showMore': 'Show {n} more',
      'browser.showLess': 'Show less',
      'entry.new': 'New session',
      'entry.settings': 'Settings',
      'chat.fold': 'Fold conversation panel',
      'chat.expand': 'Expand conversation panel',
      'chat.resize': 'Drag to resize conversation panel (double-click to reset, arrow keys to nudge)',
      'stage.quote': 'Chart',
      'stage.strategy': 'Strategies',
      'stage.knowledge': 'Knowledge',
      'indicator.picker': 'Indicators',
      'indicator.group.main': 'Main chart',
      'indicator.group.sub': 'Sub-chart',
      'indicator.empty': 'No indicators available (indicator plugin missing?)',
      'indicator.params': 'Params',
      'indicator.apply': 'Apply',
      'indicator.cancel': 'Cancel',
      'indicator.delete': 'Delete',
      'indicator.deleteConfirm': 'Delete this custom indicator? The persisted definition will be removed from the library.',
    },
  }
}
