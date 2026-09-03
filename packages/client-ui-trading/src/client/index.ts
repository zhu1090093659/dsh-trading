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
import { fillComposerWithQuote, type FillComposerFn, type ConversationDraftFace } from './fill-composer.ts'
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
import { en, zh } from './locales.ts'
/** 本面板/字符串翻译的 locale namespace。 */
const NS = 'dshtrading.market'

/** Required services：会话区读官方 sessions 状态；startSession 是右栏退役后
 * 新会话的唯一通路（无参取当前/最近工作区）。注意 startSession 在
 * uiWorkspace（UiWorkspaceService，官方 sidebar/conversation 同款消费方式），
 * 不在 workspaces（纯 WorkspaceController：create/rename/archive，无导航）。 */
export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']

/** SessionId 是 branded 类型而 dsh-session 非本包依赖（直接 import 解析不到）；
 *  从已引入的 ISessions 面派生同一 brand，inject 面字符串 id 在边界断言一次。 */
type SessionIdParam = Parameters<ISessions['open']>[0]

/** uiWorkspace 的最小结构面（startSession = 建/复用并打开会话；
 *  archiveSession = 官方侧栏「归档会话」同款通路，host 权威归档集随之广播）。 */
interface WorkspaceNavigation {
  startSession(workspaceId?: string): void
  archiveSession(sessionId: string): Promise<void>
}

/** 注册 slot + locale 字典。 */
export function apply(ctx: ClientContext): void {
  // bind 的 t 由 slot 的 locale: NS 声明经框架注入组件；本文件不直接消费。
  ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-trading-market: dictionaries')

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

  // 行情 → 会话输入框（「发给 Agent」按钮）：只把上下文 + 截图**填入 composer
  // 不提交**（owner 裁决：用户还要补自己的 prompt）。conversation 根服务在点击
  // 时惰性解析（同 uiWorkspace 纪律：apply 时序不保证）；编排细节见 fill-composer.ts。
  const fillComposer: FillComposerFn = (text, image) =>
    fillComposerWithQuote({
      sessions,
      conversation: ctx.get('conversation', false) as ConversationDraftFace | undefined,
      startSession: startNewSession,
    }, text, image)
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
      // 历史行操作菜单三件套，与官方 WorkspaceBrowser 语义对齐：
      // rename 走 session binding 的显式标题（钉住自动生成）；fork 官方同款
      // increaseTitle 后 open 新会话；archive 走 uiWorkspace（同 startSession
      // 惰性解析纪律：apply 时序不保证，点击时 ctx.get）。
      renameSession: async (sessionId: string, title: string) => {
        const face = sessions.binding(sessionId as SessionIdParam)?.session
        if (face === undefined) throw new Error(`unknown session "${sessionId}"`)
        const result = await face.rename(title)
        if (!result.ok) throw new Error(result.error.message)
      },
      forkSession: (sessionId: string) => {
        sessions.fork({ sessionId: sessionId as SessionIdParam, increaseTitle: true })
          .then((forkedId) => { sessions.open(forkedId) })
          .catch((e: unknown) => { console.warn('[dsh-trading] session fork rejected:', e) })
      },
      archiveSession: (sessionId: string) => {
        ;(ctx.get('uiWorkspace') as unknown as WorkspaceNavigation | undefined)
          ?.archiveSession(sessionId)
          .catch((e: unknown) => { console.warn('[dsh-trading] session archive rejected:', e) })
      },
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
      fillComposer,
    }),
  }, QuotePane))}
