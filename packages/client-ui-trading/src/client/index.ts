/**
 * Trading GUI shell, browser half. Registers three slots against the host
 * three-column frame（不改 DSH 源码，全部走官方 slot 机制）:
 *
 * - `sidebar.workspaces`（priority -1 遮蔽 WorkspaceBrowser）→ 富途式市场/自选栏
 * - `conversation.view`（id 'quote', order -10）→ 中栏行情视图（会话内 tab）
 * - `shell.overlay`（id 'dshtrading-side-panel'）→ 右侧可折叠会话面板
 *
 * 行情数据走 node 半注册的 /dshtrading/api 桥（同源 fetch，浏览器认证栅栏内）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSelectionStore, createWatchlistStore } from './store.ts'
import { MarketSidebar } from './MarketSidebar.tsx'
import { QuoteStage } from './QuoteStage.tsx'
import { SidePanel } from './SidePanel.tsx'
import './shell-pad.css'
import type { MarketLocaleKey } from './contract.ts'

/** 本面板/字符串翻译的 locale namespace。 */
const NS = 'dshtrading.market'

/** Required services（sessions/uiWorkspace 供 SidePanel 的会话读写）. */
export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']

/** uiWorkspace 的最小结构面（connectWorkspace = 新建/复用并打开会话）。 */
interface WorkspaceNavigation {
  connectWorkspace(workspaceId: string): Promise<unknown>
}

interface SessionsLike {
  open(sessionId: string): void
}

/** 注册三个 slot + locale 字典。 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, dictionaries()), 'dsh-trading-market: dictionaries')

  const selection = createSelectionStore()
  const watchlists = createWatchlistStore()
  const sessions = ctx.get('sessions') as unknown as SessionsLike | undefined
  const uiWorkspace = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation | undefined

  // 左栏：遮蔽官方 WorkspaceBrowser（priority -1 < 0，lowest renders）。
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    id: 'dshtrading-market-browser',
    priority: -1,
    locale: NS,
    inject: () => ({
      hooks: { selection, watchlists },
      addInstrument: (market, instrument) => { watchlists.add(market, instrument) },
      removeInstrument: (market, symbol) => { watchlists.remove(market, symbol) },
      selectInstrument: (instrument) => { selection.select(instrument) },
    }),
  }, MarketSidebar))

  // 中栏：行情视图（会话内 view tab；激活视图由宿主按会话持久化）。
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'quote',
    order: -10,
    label: () => t('view.quote'),
    locale: NS,
    inject: () => ({
      hooks: { selection },
    }),
  }, QuoteStage))

  // 右栏：可折叠会话面板（overlay 全帧浮层，条目自行开启 pointer-events）。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dshtrading-side-panel',
    order: 100,
    locale: NS,
    inject: () => ({
      openSession: (sessionId) => { sessions?.open(sessionId) },
      createSession: async (workspaceId) => {
        if (uiWorkspace === undefined) throw new Error('dsh-trading: uiWorkspace service unavailable')
        await uiWorkspace.connectWorkspace(workspaceId)
      },
    }),
  }, SidePanel))
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
      'sidebar.empty': '暂无标的',
      'sidebar.emptyHint': '在各市场页签中添加标的',
      'sidebar.loadFailed': '行情桥不可用（未装市场包？）',
      'sidebar.retry': '重试',
      'sidebar.markets': '市场与自选',
      'row.remove': '移除',
      'row.select': '查看行情',
      'view.quote': '行情',
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
      'panel.title': '会话',
      'panel.new': '新建会话',
      'panel.workspace': '工作区',
      'panel.sessionsEmpty': '还没有会话',
      'panel.collapse': '收起面板',
      'panel.expand': '展开面板',
      'panel.running': '运行中',
    },
    en: {
      'tab.watch': 'Watchlist',
      'tab.crypto': 'Crypto',
      'tab.us': 'US Stocks',
      'tab.cn': 'China A',
      'tab.hk': 'Hong Kong',
      'sidebar.addPlaceholder': 'Symbol, Enter to add',
      'sidebar.add': 'Add',
      'sidebar.empty': 'No instruments',
      'sidebar.emptyHint': 'Add instruments from the market tabs',
      'sidebar.loadFailed': 'Quote bridge unavailable (market bundle missing?)',
      'sidebar.retry': 'Retry',
      'sidebar.markets': 'Markets & watchlist',
      'row.remove': 'Remove',
      'row.select': 'View quote',
      'view.quote': 'Quote',
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
      'panel.title': 'Sessions',
      'panel.new': 'New Session',
      'panel.workspace': 'Workspace',
      'panel.sessionsEmpty': 'No sessions yet',
      'panel.collapse': 'Collapse panel',
      'panel.expand': 'Expand panel',
      'panel.running': 'running',
    },
  }
}
