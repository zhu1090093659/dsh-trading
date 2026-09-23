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
 *   新会话/定时任务，2.9 起取代窗口角标浮动簇 + 会话头内联按钮双入口；
 *   设置入口 3.0 起迁往左侧 MarketDock 底部）
 * - `shell.overlay`（dshtrading-chat-resize-handle）→ 对话列左缘拖拽调宽
 *   手柄（宿主手柄在 rtl 下坐标错位被隐藏，见 shell-pad.css 规则 4）
 *
 * 行情数据走 node 半注册的 /dshtrading/api 桥（同源 fetch，浏览器认证栅栏内）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型锚点（type-only，无运行时 import）：加载 locale 与 renderer 的 cordis
// Context 增补（ctx.locale / ctx.slots 服务面）。缺锚点时这两个服务在 client
// tsconfig 下解析不到，形成历史 tsc 债务。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ISessions, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
// 仅加载 conversation 的 SlotMap 增补（conversation.input.left 等），type-only
// 不产生运行时 import，client purity gate 不受影响。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { IndicatorRegistry } from '@dshtrading/indicators'
import type { Instrument, MarketId } from './types.ts'
import { validateCustomIndicatorAsync } from '@dshtrading/indicators'
import { createSelectionStore, createWatchlistGroupsStore, createWatchlistStore } from './store.ts'
import { createChartStateStore } from './chart-state.ts'
import { indicators, markCustomIndicator, unmarkCustomIndicator } from './indicator-registry.ts'
import { stageViews } from './stage-views.ts'
import { createTradingBridgeService } from './api.ts'
import { fillComposerWithQuote, guardComposerTarget, type FillComposerFn, type FillComposerTarget, type ConversationDraftFace } from './fill-composer.ts'
import { createSessionTargetHolder, SessionTargetProbe } from './session-target.ts'
import { OrderCard, WatchlistChipCard } from './toolview.tsx'
import { MarketDock } from './MarketDock.tsx'
import { QuotePane } from './QuotePane.tsx'
import { HomeHistory } from './HomeHistory.tsx'
import { SessionRail } from './SessionRail.tsx'
import { ChatResizeHandle } from './ChatResizeHandle.tsx'
import { foldStore, marketFoldStore } from './fold-store.ts'
import { rightbarStore } from './rightbar-store.ts'
import { deleteCustomIndicator, fetchCustomIndicators, subscribeTradingEvents } from './api.ts'
import { wireHostWatchlistSync } from './host-watchlist-sync.ts'
import { wireHostChartSync } from './host-chart-sync.ts'
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
 *  从已引入的 ISessions 面派生同一 brand，inject 面字符串 id 在边界断言一次。
 *  0.1.7：open() 已被 workspace 导航取代，会话寻址统一走 SessionTarget。 */
type SessionIdParam = SessionTarget

/** uiWorkspace 的最小结构面（0.1.7：会话导航全部收口到 uiWorkspace——
 *  startSession 建/复用并打开、openSession 即官方「选中并显示」、forkSession
 *  官方同款语义（不切选中，行内可见）、archiveSession 广播权威归档集）。 */
interface WorkspaceNavigation {
  startSession(workspaceId?: string): void
  openSession(sessionId: string): void
  forkSession(sessionId: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
}

/** 注册 slot + locale 字典。 */
export function apply(ctx: ClientContext): void {
  // bind 的 t 由 slot 的 locale: NS 声明经框架注入组件；本文件不直接消费。
  ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-trading-market: dictionaries')

  const selection = createSelectionStore()
  const watchlists = createWatchlistStore()
  const watchlistGroups = createWatchlistGroupsStore()
  const chart = createChartStateStore(indicators)
  const sessions = ctx.sessions as unknown as ISessions

  // 0.1.7 活动会话读面桥：session 作用域 slot 的 inject 工厂会收到框架解析的
  // sessionId，采集件把它投影进本地 holder（见 session-target.ts）。
  const sessionTarget = createSessionTargetHolder()
  const resolveTarget = (): FillComposerTarget | undefined =>
    sessionTarget.current !== undefined ? { sessionId: sessionTarget.current } : undefined

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
  // 不提交**（owner 裁决：用户还要补自己的 prompt）。目标会话 = 显式传入或当前
  // 活动会话（0.1.7 经官方 slot 契约投影，见 session-target.ts）；无目标即显式报错，
  // 不猜会话。conversation 根服务在点击时惰性解析（同 uiWorkspace 纪律：apply
  // 时序不保证）；编排细节见 fill-composer.ts。
  const rawFill: FillComposerFn = (text, image, target) => {
    // exactOptionalPropertyTypes：conversation 缺席时必须整个键缺位，不能显式 undefined。
    const conversation = ctx.get('conversation', false) as ConversationDraftFace | undefined
    return fillComposerWithQuote({
      ...(conversation !== undefined ? { conversation } : {}),
    }, text, image, target)
  }
  const fillComposer: FillComposerFn = (text, image, target) => rawFill(text, image, target ?? resolveTarget())
  // 采集期间固定目标：captureTarget 在异步采集开始前解析一次（无会话时固定为
  // undefined，填入阶段显式报错），杜绝采集中切会话写错 composer。
  fillComposer.captureTarget = target => guardComposerTarget(rawFill).captureTarget?.(target ?? resolveTarget()) ?? fillComposer
  const openSettings = (): void => {
    // 官方设置触发器在退役侧栏列内（整列移出视口保持挂载）；触发器是
    // 侧栏里唯一的 [aria-haspopup=dialog]，程序化 click 走官方打开逻辑，
    // 弹层 position:fixed 盖满视口不受列位置影响。
    // 3.0 起唯一入口在左侧自选面板底部（MarketDock 两态：展开底栏/折叠竖条）。
    document
      .querySelector<HTMLElement>("div:has(> [data-shell-overlay]) > div:nth-child(1) [aria-haspopup='dialog']")
      ?.click()
  }
  const chatFolded = foldStore()
  const marketFolded = marketFoldStore()
  const toggleFold = (): void => { chatFolded.toggle() }
  const toggleMarketFold = (): void => { marketFolded.toggle() }

  // 宿主右侧栏（官方 sidebar-right dock，0.1.5 起接管 details 列，承载文件/
  // 预览等原生页签）：SessionRail 文件页签的开合动作面。最小结构面不 import
  // SDK 类型（client 产物 purity gate 禁未声明 SDK 包，WorkspaceNavigation
  // 同款边界）；服务在点击时惰性解析（apply 时序不保证，uiWorkspace 同款纪律）。
  interface SidebarRightFace {
    openTab(kind: string): void
    isExpanded(): boolean
    toggleExpanded(): void
  }
  const rightbar = rightbarStore()
  const sidebarRight = (): SidebarRightFace | undefined =>
    ctx.get('sidebarRight', false) as SidebarRightFace | undefined
  // 文件页签 ON：官方导航通路 openTab('files')——页签幂等揭示 + 同步展开列。
  const openFilesPanel = (): void => { sidebarRight()?.openTab('files') }
  // 文件页签 OFF / 自有面板互斥：仅当前展开时收起（toggle 语义收窄为单向）。
  const collapseRightbar = (): void => {
    const svc = sidebarRight()
    if (svc?.isExpanded()) svc.toggleExpanded()
  }

  // 静态包的 slot 条目崩溃默认无人上报（监督缝只覆盖动态插件）——打到 console 可见化。
  ctx.slots.onEntryError((slot: string, _entry: unknown, error: unknown) => {
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

  // 市场快讯（2026-09-13 迁出中栏）：原 flash stage 注册已移除——快讯改为右缘
  // SessionRail 的功能页签（与定时任务/资产同款原位覆盖对话列），见 FlashPanel.tsx。

  // quote 视图是 registry 的内建种子条目（stage-views.ts 工厂内写入）——tab 条
  // 从名册统一渲染，MiddleStage 对 quote 走 QuoteStage 直引面。

  // 对话内富卡片（issue #34 / P5 §5.5）：下单三态卡（4 市场 keyed 各一把 +
  // 生成器注册）与自选 chip 卡。策略/知识卡的注册在各自视图包（归属随视图）。
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const market of ['crypto', 'us', 'cn', 'hk', 'futures', 'global'] as const) {
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
  // 分组扩展（issue #82）：groups 的 create/rename/delete/assignMember 同步被
  // 接管为 host-first；注册表启动拉取 + SSE 'watchlists' 一并重拉。
  wireHostWatchlistSync({ watchlists, selection, groups: watchlistGroups })

  // 图表激活名册 host SSOT 同步（issue #63）：agent 经 indicator_activate/
  // deactivate 写 host → SSE 'chart' → 图表即时点亮；GUI 挂载/摘除/调参同样
  // host-first（桥不可用时本地镜像维持现状，不劣于升级前）。
  wireHostChartSync({ chart })

  // 左侧停靠：自选面板（官方浮层通道；支持展开与折叠态 MarketRail）。
  // 3.0 起设置入口迁驻此处底部（openSettings 程序化 click 退役列内的官方触发器）。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dshtrading-market-dock',
    order: 10,
    locale: NS,
    inject: () => ({
      hooks: { selection, watchlists, marketFolded, groups: watchlistGroups },
      addInstrument: (market: MarketId, instrument: Instrument) => { watchlists.add(market, instrument) },
      removeInstrument: (market: MarketId, symbol: string) => { watchlists.remove(market, symbol) },
      selectInstrument: (instrument: Instrument) => { selection.select(instrument) },
      toggleFold: toggleMarketFold,
      openSettings,
      // 分组写路径（issue #82）：实现已由 wireHostWatchlistSync 接管为 host-first。
      createGroup: (name: string) => watchlistGroups.create(name),
      renameGroup: (id: string, name: string) => watchlistGroups.rename(id, name),
      deleteGroup: (id: string) => watchlistGroups.delete(id),
      assignGroupMember: (id: string, market: string, symbol: string, member: boolean, name?: string) =>
        watchlistGroups.assignMember(id, market, symbol, member, name),
      setActiveGroup: (id: string | null) => { watchlistGroups.setActiveGroup(id) },
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
      openSession: (sessionId: string) => {
        ;(ctx.get('uiWorkspace') as unknown as WorkspaceNavigation | undefined)
          ?.openSession(sessionId)
      },
      startNewSession,
      // 历史行操作菜单三件套，与官方 WorkspaceBrowser 语义对齐：
      // rename 走 session binding 的显式标题（钉住自动生成）；fork 官方同款
      // increaseTitle 后 open 新会话；archive 走 uiWorkspace（同 startSession
      // 惰性解析纪律：apply 时序不保证，点击时 ctx.get）。
      renameSession: async (sessionId: string, title: string) => {
        // 0.1.7：session 对象层经 retain/using 获取（binding 随 reference 存活）。
        await sessions.using(sessionId as SessionIdParam, { source: 'controllerOperation' }, async (reference) => {
          const result = await reference.binding.session.rename(title)
          if (!result.ok) throw new Error(result.error.message)
        })
      },
      forkSession: (sessionId: string) => {
        // 0.1.7 官方 forkSession：不切换当前选中（官方行内动作同款），新会话在列表可见。
        ;(ctx.get('uiWorkspace') as unknown as WorkspaceNavigation | undefined)
          ?.forkSession(sessionId)
          .catch((e: unknown) => { console.warn('[dsh-trading] session fork rejected:', e) })
      },
      archiveSession: (sessionId: string) => {
        ;(ctx.get('uiWorkspace') as unknown as WorkspaceNavigation | undefined)
          ?.archiveSession(sessionId)
          .catch((e: unknown) => { console.warn('[dsh-trading] session archive rejected:', e) })
      },
      // 工作区删除（官方 WorkspaceBrowser 同款 workspaces.delete 通路：只摘注册，
      // 会话与目录保留）。惰性解析纪律同 uiWorkspace：apply 时序不保证，点击时 get。
      // 失败 reject 交由 HomeHistory 确认面板原位呈报。
      deleteWorkspace: async (workspaceId: string) => {
        const workspaces = ctx.get('workspaces') as unknown as
          | { delete: (workspaceId: string) => Promise<void> }
          | undefined
        if (workspaces === undefined) throw new Error('workspaces service unavailable')
        await workspaces.delete(workspaceId)
      },
    }),
  }, HomeHistory))

  // 会话竖条（shell.overlay）：右缘 44px 常驻（折叠/新会话/定时任务/资产/
  // 快讯/文件竖排），恒挂载——首页、会话进行中、折叠态都是同一入口，不再按
  // 状态切换入口面。设置入口 3.0 起迁往 MarketDock 底部，不再注入 openSettings。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dshtrading-session-rail',
    order: 60,
    locale: NS,
    inject: () => ({
      startNewSession,
      toggleFold,
      // 执行历史「打开会话」：HomeHistory 同款官方 sessions 通路。
      openSession: (sessionId: string) => {
        ;(ctx.get('uiWorkspace') as unknown as WorkspaceNavigation | undefined)
          ?.openSession(sessionId)
      },
      // 资产面板「导入持仓」：会话输入框填入入口（只填不发）。
      fillComposer,
      // 文件页签（2026-09-15）：宿主右侧栏 dock 的容器化开合面。
      openFilesPanel,
      collapseRightbar,
      hooks: { folded: chatFolded, rightbar },
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
      // 回调参数显式类型：QuotePaneProps 的 InjectFace 是异构 union，注入面在
      // 槽注册处不参与推断（PR #74 合并遗留债，2026-09-07 顺手清偿）。
      toggleIndicator: (id: string) => { chart.togglePreset(id) },
      setIndicatorParams: (id: string, params: Record<string, number>, scopeKey?: string) => { chart.setParams(id, params, scopeKey) },
      // symbol visibility：scopeKey = "<market>:<symbol>"；缺省（无聚焦标的）忽略——
      // QuoteStage 在该情形走 toggleIndicator 全局语义。
      setIndicatorVisible: (id: string, visible: boolean, scopeKey?: string) => {
        const split = scopeKey !== undefined ? scopeKey.indexOf(':') : -1
        if (scopeKey === undefined || split <= 0) return
        chart.setSymbolVisibility(id, scopeKey.slice(0, split), scopeKey.slice(split + 1), visible)
      },
      removeIndicator: (id: string) => { if (chart.isActive(id)) chart.togglePreset(id) },
      deleteIndicator: async (id: string) => {
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
  }, QuotePane))

  // 活动会话采集（0.1.7）：conversation.input.left 是官方 session 作用域 list 槽，
  // 其 inject 工厂收到框架解析的 sessionId（renderer 的 runInject 把 scope binding
  // 的 key 作为首参，按 entry × binding 记忆化）。采集件零渲染，只把活动会话 id
  // 投影进 sessionTarget，供「发给 Agent」定位目标；无会话时卸载清回 undefined。
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dshtrading-session-target',
    order: -100,
    inject: (sessionId: string) => ({ sessionId, holder: sessionTarget }),
  }, SessionTargetProbe))}

