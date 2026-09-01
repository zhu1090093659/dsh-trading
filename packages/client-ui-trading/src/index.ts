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
import type { MarketDataService } from '@dsh-trading/api'
import type { TradingEventsService } from '@dsh-trading/eventbus'
import { createFileCustomIndicatorStore, createAuthorIndicatorTool } from '@dsh-trading/indicators/tool'
import { createFileKnowledgeCardStore, createKnowledgeIngestTool, createKnowledgeSearchTool } from '@dsh-trading/knowledge/tool'
import { createFileCustomStrategyStore } from '@dsh-trading/strategies/plugin'
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
} from './bridge.ts'
import { attachEventStream } from './sse.ts'

/** webServer / connection 的最小结构面（避免对本仓未安装的宿主包产生类型依赖）。 */
interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): void
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
  const indicatorStorePath = path.join(os.homedir(), '.dsh', 'indicators', 'custom.json')
  const customIndicatorsStore = createFileCustomIndicatorStore(indicatorStorePath)

  const knowledgeStorePath = path.join(os.homedir(), '.dsh', 'knowledge', 'cards.json')
  const knowledgeStore = createFileKnowledgeCardStore(knowledgeStorePath)

  const strategyStorePath = path.join(os.homedir(), '.dsh', 'strategies', 'custom.json')
  const strategyStore = createFileCustomStrategyStore(strategyStorePath)

  // tradingEvents 失效信号源（issue #30）：base patch 行挂载 eventbus 时可用；
  // 缺席（老部署）→ 发布点静默降级为现状（一次性 fetch 客户端行为不变）。
  const eventsOf = (): TradingEventsService | undefined =>
    (ctx as unknown as { get?: (key: string) => unknown }).get?.('tradingEvents') as TradingEventsService | undefined

  // 注册 indicator_author / knowledge_ingest / knowledge_search 工具到全局 tools（若服务存在）
  ctx.inject(['tools'] as never, (toolCtx) => {
    const tools = (toolCtx as unknown as { tools?: { register(t: unknown): void; get(name: string): unknown } }).tools
    if (tools && typeof tools.register === 'function') {
      const authorTool = createAuthorIndicatorTool({
        store: customIndicatorsStore,
        // 发布点接线（issue #30）：指标入库 → 'indicators' 失效信号 → 已打开的图表实时出现。
        onWritten: () => eventsOf()?.emit('indicators'),
      })
      if (tools.get(authorTool.name) === undefined) {
        tools.register(authorTool)
      }

      const ingestTool = createKnowledgeIngestTool(knowledgeStore, {
        // 发布点接线（issue #30）：知识入库 → 'knowledge' 失效信号 → 知识库 tab 实时刷新。
        onWritten: () => eventsOf()?.emit('knowledge'),
      })
      if (tools.get(ingestTool.name) === undefined) {
        tools.register(ingestTool)
      }

      const searchTool = createKnowledgeSearchTool(knowledgeStore)
      if (tools.get(searchTool.name) === undefined) {
        tools.register(searchTool)
      }
    }
  })

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer') as unknown as WebServerLike | undefined
    const connection = webCtx.get('connection') as unknown as ConnectionLike | undefined
    if (webServer === undefined || connection === undefined) return
    // registry-first（2026-08-30 注册表模式）：每请求经注册表按路由当前值解析——
    // settings 切换交易所 GUI 即刻生效（热切换）；注册表缺席回退旧市场键直读。
    const host = createBridgeHost({
      registry: webCtx.get('tradingMarketDataRegistry') as MarketDataRegistryLike | undefined,
      router: webCtx.get('tradingMarketRouter') as { activeProvider(m: string): string | undefined } | undefined,
      legacy: market => webCtx.get(MARKET_SERVICE_KEYS[market]) as MarketDataService | undefined,
      customIndicatorsStore,
      knowledgeStore,
      strategyStore,
    })
    const bridge = new TradingBridge(host)
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
          const { status, payload } = await dispatchBridgeRequest(bridge, req.method ?? 'GET', sub, url.searchParams)
          // 发布点接线（issue #30）：自定义指标删除成功 → 'indicators' 失效信号。
          if (req.method === 'DELETE' && sub === '/indicators/custom' && status === 200
            && (payload as { ok?: unknown } | undefined)?.ok === true) {
            eventsOf()?.emit('indicators')
          }
          // 发布点接线（issue #31）：自定义策略删除成功 → 'strategies' 失效信号。
          if (req.method === 'DELETE' && sub === '/strategies/custom' && status === 200
            && (payload as { ok?: unknown } | undefined)?.ok === true) {
            eventsOf()?.emit('strategies')
          }
          sendJson(res, status, payload)
        } catch (error) {
          if (error instanceof BridgeProtocolError) {
            sendJson(res, error.status, { ok: false, code: 'TRADING_PROTOCOL', message: error.message })
            return
          }
          sendJson(res, 200, { ok: false, ...errorPayloadOf(error) })
        }
      },
    }
    ctx.effect(() => webServer.register(route), 'dsh-trading-client-ui-trading: /dshtrading/api route')
  })
}

function errorPayloadOf(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'TRADING_UNKNOWN'
    return { code, message: error.message }
  }
  return { code: 'TRADING_UNKNOWN', message: String(error) }
}
