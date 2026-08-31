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
import { createFileCustomIndicatorStore, createAuthorIndicatorTool } from '@dsh-trading/indicators/tool'
import { createFileKnowledgeCardStore, createKnowledgeIngestTool, createKnowledgeSearchTool } from '@dsh-trading/knowledge/tool'
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

/** webServer 的最小结构面（避免对本仓未安装的宿主包产生类型依赖）。 */
interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): void
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

  // 注册 indicator_author / knowledge_ingest / knowledge_search 工具到全局 tools（若服务存在）
  ctx.inject(['tools'] as never, (toolCtx) => {
    const tools = (toolCtx as unknown as { tools?: { register(t: unknown): void; get(name: string): unknown } }).tools
    if (tools && typeof tools.register === 'function') {
      const authorTool = createAuthorIndicatorTool({ store: customIndicatorsStore })
      if (tools.get(authorTool.name) === undefined) {
        tools.register(authorTool)
      }

      const ingestTool = createKnowledgeIngestTool(knowledgeStore)
      if (tools.get(ingestTool.name) === undefined) {
        tools.register(ingestTool)
      }

      const searchTool = createKnowledgeSearchTool(knowledgeStore)
      if (tools.get(searchTool.name) === undefined) {
        tools.register(searchTool)
      }
    }
  })

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer') as unknown as WebServerLike | undefined
    if (webServer === undefined) return
    // registry-first（2026-08-30 注册表模式）：每请求经注册表按路由当前值解析——
    // settings 切换交易所 GUI 即刻生效（热切换）；注册表缺席回退旧市场键直读。
    const host = createBridgeHost({
      registry: webCtx.get('tradingMarketDataRegistry') as MarketDataRegistryLike | undefined,
      router: webCtx.get('tradingMarketRouter') as { activeProvider(m: string): string | undefined } | undefined,
      legacy: market => webCtx.get(MARKET_SERVICE_KEYS[market]) as MarketDataService | undefined,
      customIndicatorsStore,
      knowledgeStore,
    })
    const bridge = new TradingBridge(host)
    const route = {
      kind: 'prefix' as const,
      path: '/dshtrading/api',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.local')
          // 路由是前缀挂载：剥掉挂载点后按子路径分发。
          const mount = '/dshtrading/api'
          const raw = url.pathname
          const sub = raw === mount || raw.startsWith(`${mount}/`) ? raw.slice(mount.length) || '/' : raw
          const { status, payload } = await dispatchBridgeRequest(bridge, req.method ?? 'GET', sub, url.searchParams)
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
