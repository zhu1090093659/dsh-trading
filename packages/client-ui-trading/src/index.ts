/**
 * Trading GUI shell, node half：`/dshtrading/api` 行情 HTTP 桥（web 宿主专用）。
 *
 * 浏览器半（exports["./client"]）通过同源 fetch 拉行情，本半把请求透传给
 * 对应市场的 MarketDataService（connector-binance/yahoo/tencent 提供）。
 *
 * 双宿主策略：webServer/connection 只在 web 宿主存在，这里用 ctx.inject 子插件
 * 声明依赖——web 宿主等服务就绪后注册路由；headless 宿主永不解析，子 fiber 挂起
 * （无副作用，不崩 profile），与 client-ui-settings 的「空 apply 双宿主安全」同效力。
 *
 * 安全：路由挂在 connection.requestRejection 认证栅栏之后（与 /api 同一 browser
 * auth cookie），未认证一律 401/403。数据面公共端点、无凭证、不缓存（铁律 #5）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MarketDataService } from '@dshtrading/api'
import type { TradingEventsService } from '@dshtrading/eventbus'
import { createFileChartActivationStore, createFileCustomIndicatorStore } from '@dshtrading/indicators/plugin'
import { createFileKnowledgeCardStore } from '@dshtrading/knowledge/plugin'
import { createFileCustomStrategyStore } from '@dshtrading/strategies/plugin'
import { createFileSelectionStore, createFileWatchlistStore } from '@dshtrading/watchlist/plugin'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  BridgeProtocolError,
  MARKET_SERVICE_KEYS,
  TradingBridge,
  createBridgeHost,
  dispatchBridgeRequest,
  type MarketDataRegistryLike,
  type TradeRegistryLike,
} from './bridge.ts'
import { attachEventStream } from './sse.ts'
import { TaskActionError } from './tasks/ledger.ts'
import { registerTasksTools } from './tasks/tools.ts'
import { TASKS_ACTION_BYTES_LIMIT, parseTasksEnvelope } from './client/tasks-protocol.ts'
import { TradingTasksService } from './tasks/service.ts'
import type { SessionCommandDispatcher, SessionGateway } from './tasks/runner.ts'

/** webServer / connection 的最小结构面（避免对本仓未安装的宿主包产生类型依赖）。 */
interface WebServerLike {
  /** 宿主 rc.1 语义：register 返回路由注销器（ctx.effect 挂接，插件停止时注销）。 */
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

interface ConnectionLike {
  /** 返回拒绝状态码（401/403），undefined = 已认证放行（alpha.2 官方栅栏，同 /api）。 */
  requestRejection(req: IncomingMessage): number | undefined
}

/** 本插件不硬依赖任何服务（headless 宿主零要求）；web 面依赖在 apply 内声明。 */
export const inject: readonly string[] = []

/** 发送 JSON 响应（禁缓存：行情是易变数据，代理层也不许中间层缓存）。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Host plugin body：注册 /dshtrading/api 路由（web 宿主）或静默挂起（headless）。
 * @param ctx - Host cordis context（bundle loader entry）。
 */
export function apply(ctx: Context): void {
  // store 单实例解析（issue #33 收口）：能力包 ./plugin 以 Service 类 provide
  // 服务——ctx.get 取到的是 Service 实例（store 挂在 .store 属性，不是 store 本
  // 身；2026-09-01 实证 store.list is not a function 回归）→ 解包 .store 复用同
  // 一 file store 实例；服务缺席（老部署）→ 回退自建实例（旧行为）。
  const serviceGet = (key: string): unknown =>
    (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.(key, false)
  const customIndicatorsService = serviceGet('tradingCustomIndicators') as
    | { store?: import('@dshtrading/indicators').CustomIndicatorStore }
    | undefined
  const customIndicatorsStore = customIndicatorsService?.store
    ?? createFileCustomIndicatorStore(path.join(os.homedir(), '.dsh', 'indicators', 'custom.json'))
  // issue #63：图表激活名册 store 单实例（Service 解包同上；服务缺席 → 回退自建）。
  const chartActivationsService = serviceGet('tradingChartActivations') as
    | { store?: import('@dshtrading/indicators').ChartActivationStore }
    | undefined
  const chartActivationsStore = chartActivationsService?.store
    ?? createFileChartActivationStore(path.join(os.homedir(), '.dsh', 'indicators', 'chart.json'))
  const knowledgeService = serviceGet('tradingKnowledgeCards') as
    | { store?: import('@dshtrading/knowledge').KnowledgeCardStore }
    | undefined
  const knowledgeStore = knowledgeService?.store
    ?? createFileKnowledgeCardStore(path.join(os.homedir(), '.dsh', 'knowledge', 'cards.json'))

  const strategyStorePath = path.join(os.homedir(), '.dsh', 'strategies', 'custom.json')
  const strategyStore = createFileCustomStrategyStore(strategyStorePath)

  const watchlistStorePath = path.join(os.homedir(), '.dsh', 'watchlists.json')
  const watchlistStore = createFileWatchlistStore(watchlistStorePath)
  const selectionStorePath = path.join(os.homedir(), '.dsh', 'selection.json')
  const selectionStore = createFileSelectionStore(selectionStorePath)

  // tradingEvents 失效信号源（issue #30）：base patch 行挂载 eventbus 时可用；
  // 缺席（老部署）→ 发布点静默降级为现状（一次性 fetch 客户端行为不变）。
  const eventsOf = (): TradingEventsService | undefined =>
    (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingEvents', false) as TradingEventsService | undefined

  // issue #33 收口：indicator_author / knowledge_ingest / knowledge_search 的注册
  // 已迁移至 @dshtrading/indicators/plugin 与 @dshtrading/knowledge/plugin
  // （base patch 行，host 平面），emit 接线随迁；本插件不再重复注册。

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer') as unknown as WebServerLike | undefined
    const connection = webCtx.get('connection') as unknown as ConnectionLike | undefined
    if (webServer === undefined || connection === undefined) return
    // registry-first（2026-08-30 注册表模式）：每请求经注册表按路由当前值解析——
    // settings 切换交易所 GUI 即刻生效（热切换）；注册表缺席回退旧市场键直读。
    const host = createBridgeHost({
      registry: webCtx.get('tradingMarketDataRegistry', false) as MarketDataRegistryLike | undefined,
      tradeRegistry: webCtx.get('tradingTradeRegistry', false) as TradeRegistryLike | undefined,
      router: webCtx.get('tradingMarketRouter', false) as { activeProvider(m: string): string | undefined } | undefined,
      legacy: market => webCtx.get(MARKET_SERVICE_KEYS[market]) as MarketDataService | undefined,
      customIndicatorsStore,
      chartActivationsStore,
      knowledgeStore,
      strategyStore,
      watchlistStore,
      selectionStore,
      // 新闻注册表（issue #37）：各 Kit 向 host 面注册表注册 aggregateNews 纯函数。
      newsRegistry: webCtx.get('tradingNewsRegistry', false) as import('./bridge.ts').TradingNewsRegistryLike | undefined,
      newsKey: () => {
        const router = webCtx.get('tradingMarketRouter', false) as { newsKey?: () => string | undefined } | undefined
        return router?.newsKey?.()
      },
    })
    const bridge = new TradingBridge(host)

    // 右缘竖栏「定时任务」Host 面：文件账本 + cron 调度 + 会话 runner（web 宿主
    // 专属；目录锁被另一个活宿主持有时降级为 503——特性不挂、宿主照跑）。宿主
    // 服务（typertGateway/commands/workspaceRegistry）全部惰性解析：激活时序
    // 不保证，调度/执行时才取（与 uiWorkspace 惰性纪律同款）。
    const resolveHostService = (name: string): unknown =>
      (webCtx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.(name, false)
      ?? (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.(name, false)
    let tasksService: TradingTasksService | undefined
    try {
      tasksService = new TradingTasksService({
        ledgerPath: process.env.DSH_TRADING_TASKS_LEDGER ?? path.join(os.homedir(), '.dsh', 'trading-tasks', 'ledger-v1.json'),
        gateway: () => resolveHostService('typertGateway') as SessionGateway | undefined,
        commands: () => resolveHostService('commands') as SessionCommandDispatcher | undefined,
        workspaces: () => resolveHostService('workspaceRegistry') as import('./tasks/service.ts').WorkspaceDirectoryLike | undefined,
        onEvent: () => eventsOf()?.emit('tasks'),
      })
    } catch (error) {
      console.error('[dsh-trading/tasks] task ledger unavailable (locked by another live host?):', error)
    }
    const tasks = tasksService
    if (tasks !== undefined) {
      // agent 工具面与 HTTP 面同源：服务存在 = 工具存在（headless 宿主两者皆无）。
      registerTasksTools(ctx, tasks)
      ctx.effect(() => {
        tasks.start()
        return () => { tasks.dispose() }
      }, 'dsh-trading-client-ui-trading: scheduled-tasks service')
    }
    const route = {
      kind: 'prefix' as const,
      path: '/dshtrading/api',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        // 与官方 RPC 通道同款栅栏（alpha.2 dsh-client-connection register 同构）：
        // Host/Origin fence + browser auth cookie，未认证一律 401/403。
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.local')
          // 路由是前缀挂载：剥掉挂载点后按子路径分发。
          const mount = '/dshtrading/api'
          const raw = url.pathname
          const sub = raw === mount || raw.startsWith(`${mount}/`) ? raw.slice(mount.length) || '/' : raw
          // SSE 失效信号通道（issue #30 / P1）：同一认证栅栏之后的唯一流式端点；
          // tradingEvents 缺席 → 503，客户端 EventSource 失败降级为一次性 fetch（不劣于现状）。
          if (req.method === 'GET' && sub === '/events') {
            const events = eventsOf()
            if (events === undefined) {
              sendJson(res, 503, { ok: false, code: 'TRADING_EVENTS_UNAVAILABLE', message: 'tradingEvents service is not mounted' })
              return
            }
            attachEventStream(res, events)
            return
          }
          // PUT/POST（issue #32 自选/选中写入面）：读 JSON body（1MB 封顶）后进桥。
          let body: unknown
          if (req.method === 'PUT' || req.method === 'POST') {
            body = await readJsonBody(req)
          }
          // 定时任务子面（右侧栏）：独立账本与调度，行情桥不感知。
          if (sub === '/tasks' || sub.startsWith('/tasks/')) {
            await handleTasksRoute(tasks, req, res, sub, body)
            return
          }
          const { status, payload } = await dispatchBridgeRequest(bridge, req.method ?? 'GET', sub, url.searchParams, body)
          // 发布点接线（issue #30/#31/#32）：写成功 → 对应 store 失效信号。
          if (status === 200 && (payload as { ok?: unknown } | undefined)?.ok === true) {
            if (req.method === 'DELETE' && sub === '/indicators/custom') eventsOf()?.emit('indicators')
            // issue #63：GUI 写激活名册成功 → 'chart' 失效信号（工具写入侧在
            // indicators/plugin emit，本处只接 GUI 桥写入，避免双 emit）。
            if ((req.method === 'PUT' || req.method === 'DELETE') && sub === '/chart/indicators') eventsOf()?.emit('chart')
            if (req.method === 'POST' && sub === '/chart/indicators/import') eventsOf()?.emit('chart')
            if (req.method === 'DELETE' && sub === '/strategies/custom') eventsOf()?.emit('strategies')
            if ((req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE')
              && (sub === '/watchlists' || sub === '/watchlists/import')) eventsOf()?.emit('watchlists')
            if (req.method === 'PUT' && sub === '/selection') eventsOf()?.emit('selection')
          }
          sendJson(res, status, payload)
        } catch (error) {
          if (error instanceof BridgeProtocolError) {
            // error.code 可携带细分语义（如 TRADING_NO_TRADE_SERVICE，2026-09-04）；缺省回退协议错误。
            const code = (error as { code?: string }).code ?? 'TRADING_PROTOCOL'
            sendJson(res, error.status, { ok: false, code, message: error.message })
            return
          }
          sendJson(res, 200, { ok: false, ...errorPayloadOf(error) })
        }
      },
    }
    ctx.effect(() => webServer.register(route), 'dsh-trading-client-ui-trading: /dshtrading/api route')
  })
}

/**
 * 定时任务子面分发：GET /tasks（revision 快照）、GET /tasks/meta（确认门基准
 * + 工作区/预设名册）、POST /tasks/action（幂等动作信封，64KiB 封顶）。
 * 账本缺席（锁被夺/未挂）→ 503 降级，不影响行情桥。
 */
async function handleTasksRoute(
  service: TradingTasksService | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  sub: string,
  body: unknown,
): Promise<void> {
  if (service === undefined) {
    sendJson(res, 503, { ok: false, code: 'TASKS_UNAVAILABLE', message: 'task ledger is unavailable (locked by another live host?)' })
    return
  }
  if (req.method === 'GET' && sub === '/tasks') {
    sendJson(res, 200, service.snapshot())
    return
  }
  if (req.method === 'GET' && sub === '/tasks/meta') {
    sendJson(res, 200, await service.meta())
    return
  }
  if (req.method === 'POST' && sub === '/tasks/action') {
    if (Buffer.byteLength(JSON.stringify(body ?? {}), 'utf8') > TASKS_ACTION_BYTES_LIMIT) {
      sendJson(res, 413, { ok: false, code: 'TASKS_ACTION_TOO_LARGE', message: 'action payload exceeds 64KiB' })
      return
    }
    const envelope = parseTasksEnvelope(body)
    if (envelope === undefined) {
      sendJson(res, 400, { ok: false, code: 'TASKS_ACTION_INVALID', message: 'invalid action envelope' })
      return
    }
    try {
      sendJson(res, 200, service.apply(envelope))
    } catch (error) {
      if (error instanceof TaskActionError) {
        sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
        return
      }
      throw error
    }
    return
  }
  sendJson(res, 404, { ok: false, code: 'TASKS_ROUTE_NOT_FOUND', message: 'unknown tasks route: ' + sub })
}

/** JSON body 读取（PUT/POST 用；1MB 封顶，非法 JSON → 400 协议错误）。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > 1024 * 1024) {
      throw new BridgeProtocolError(413, 'request body too large (1MB cap)')
    }
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new BridgeProtocolError(400, 'request body must be valid JSON')
  }
}

function errorPayloadOf(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const raw = (error as { code?: unknown }).code
    const code = typeof raw === 'string' ? raw : 'TRADING_UNKNOWN'
    return { code, message: error.message }
  }
  return { code: 'TRADING_UNKNOWN', message: String(error) }
}
