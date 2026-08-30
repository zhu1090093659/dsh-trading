/**
 * Trading GUI shell, browser half. Slot 布局（不改 DSH 源码，全部走官方 slot 机制）:
 *
 * - `shell.overlay`（dshtrading-market-dock）→ 左侧自选停靠面板
 * - `sidebar.workspaces`（priority -1 遮蔽 WorkspaceBrowser）→ 右侧边栏会话区
 *   （历史会话列表；新对话入口统一走官方首页 composer，宿主侧栏列已由 CSS
 *   rtl 移到右缘）
 * - `shell.overlay`（dshtrading-quote-pane）→ 中栏行情面板（恒渲染；
 *   对话列由宿主官方 UI 常驻右侧栏，见 shell-pad.css 2.4 布局）
 *
 * 行情数据走 node 半注册的 /dshtrading/api 桥（同源 fetch，浏览器认证栅栏内）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSelectionStore, createWatchlistStore } from './store.ts'
import { MarketDock } from './MarketDock.tsx'
import { QuotePane } from './QuotePane.tsx'
import { SessionBrowser } from './SessionBrowser.tsx'
import './shell-pad.css'
import type { MarketLocaleKey } from './contract.ts'

/** 本面板/字符串翻译的 locale namespace。 */
const NS = 'dshtrading.market'

/** Required services：会话区只读官方 sessions/workspaces 状态（新对话入口已归一官方 composer）。 */
export const inject = ['slots', 'locale', 'sessions']

/** 注册 slot + locale 字典。 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, dictionaries()), 'dsh-trading-market: dictionaries')

  const selection = createSelectionStore()
  const watchlists = createWatchlistStore()
  const sessions = ctx.sessions as unknown as ISessions

  // 静态包的 slot 条目崩溃默认无人上报（监督缝只覆盖动态插件）——打到 console 可见化。
  ctx.slots.onEntryError((slot, _entry, error) => {
    console.error(`[dsh-trading] slot entry crashed: ${slot}`, error)
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

  // 右侧边栏会话区：遮蔽官方 WorkspaceBrowser（宿主形态自带每组「+ 新会话」
  // 等重复入口；这里只留历史会话列表，数据面仍全是官方 sessions/workspaces
  // 服务，新建会话统一走官方首页 composer）。
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    id: 'dshtrading-session-browser',
    priority: -1,
    locale: NS,
    inject: () => ({
      openSession: (sessionId) => { sessions.open(sessionId) },
    }),
  }, SessionBrowser))

  // 中栏行情面板：恒渲染，盖住栅格第 3 轨道（行情区）。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dshtrading-quote-pane',
    order: 50,
    locale: NS,
    inject: () => ({
      hooks: { selection },
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
      'sidebar.empty': '暂无标的',
      'sidebar.emptyHint': '在各市场页签中添加标的',
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
    },
  }
}
