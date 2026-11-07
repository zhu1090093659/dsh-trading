/**
 * client-ui-special-indicators, node half — /dshtrading/api/special-indicators 桥。
 *
 * 本地私有插件（private: true，永不发布）：代理自有 finance 服务
 *（https://finance.chatwithai.icu，docs/api.md 契约）的四组特殊指标——
 * IF/IM 期现基差、A 股恐慌指数、恒科前十大权重股卖空、板块融资余额。
 * 与行情指标（tradingIndicators，K 线副图/主图叠加）不同源、不同面，故独立成包。
 *
 * - 路由挂独立前缀（webserver 最长前缀匹配，与行情桥/updater 桥互不改 handler）；
 *   与官方 RPC 通道同款栅栏（connection.requestRejection：Host/Origin fence +
 *   browser auth cookie）——浏览器半同源 fetch 默认携带 cookie。
 * - 凭据不内置：设置中心 dshtrading.credentials.finance（router getCredential）
 *   → 行配置 password → 环境变量 FINANCE_API_PASSWORD 兜底，逐请求惰性解析。
 * - 固定子路由白名单（非通用代理），查询参数服务端校验；对上游只做 GET。
 * - headless 宿主无 webServer/connection：ctx.inject 子插件挂起，零副作用。
 * - agent 工具面同一实例：ctx.inject(['tools']) 注册五只只读工具，与桥**共用**本
 *   apply 里的 FinanceClient（同一 TTL/落盘缓存、同一白名单路径、同一凭据链），
 *   见 src/indicator-tools.ts。
 *
 * 浏览器半（exports["./client"]）注册中栏「特殊指标」tab。
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createFileCachePersistence, defaultCacheFilePath } from './cache-file.ts'
import { FinanceClient, FinanceError } from './finance-client.ts'
import { createSpecialIndicatorTools } from './indicator-tools.ts'
import { ROUTES, tierTtlMs } from './routes.ts'

/** Cordis 插件名 = patch 行 id（TEMPLATES §8）。 */
export const name = 'dsh-trading-client-ui-special-indicators'

/** 本插件不硬依赖任何服务（headless 宿主零要求）；web 面依赖在 apply 内 inject。 */
export const inject: readonly string[] = []

export interface Config {
  baseUrl: string
  sentimentMethodology: number
  username: string
  password: string
  usernameEnv: string
  passwordEnv: string
  timeoutMs: number
  snapshotCacheMs: number
  historyCacheMs: number
  cacheFile: string
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().default('https://finance.chatwithai.icu').description('自有 finance 服务地址（docs/api.md）'),
  sentimentMethodology: Schema.number().default(3).description('恐慌指数方法学版本（finance 支持 1/2/3）：v3 = v2 七槽 + 融资连增连减，八槽全有效才出分；越界值由上游 422 显式拒绝'),
  username: Schema.string().default('api').description('finance HTTP Basic 用户名'),
  password: Schema.string().default('').description('finance HTTP Basic 密码（只写本地 profile 行配置，勿提交仓库；空 = 走凭据链兜底）'),
  usernameEnv: Schema.string().default('FINANCE_API_USER').description('用户名环境变量名（凭据链末位兜底）'),
  passwordEnv: Schema.string().default('FINANCE_API_PASSWORD').description('密码环境变量名（凭据链末位兜底）'),
  timeoutMs: Schema.number().default(60_000).description('单次上游请求超时（ms）；冷缓存上游重算可能十几秒'),
  snapshotCacheMs: Schema.number().default(60_000).description('快照类路由内存缓存（ms）'),
  historyCacheMs: Schema.number().default(300_000).description('历史/明细类路由内存缓存（ms）'),
  cacheFile: Schema.string().default('').description('桥缓存落盘文件路径（空 = $DSH_HOME/special-indicators/cache.json）；跨宿主重启保留，避免每次启动冷拉上游'),
})

interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

interface ConnectionLike {
  requestRejection(req: IncomingMessage): number | undefined
}

interface RouterLike {
  getCredential?(provider: string): Record<string, string> | undefined
}

/** agent 工具注册面（@deepseek-ai/dsh-tools 的 tools 服务），只用到这三只方法。 */
interface ToolsLike {
  register(definition: unknown): () => void
  get(name: string): unknown
}

export const MOUNT = '/dshtrading/api/special-indicators'

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** 板块代码白名单、参数夹取与固定子路由白名单见 src/routes.ts（工具面同源白名单）。 */

/** 凭据链：设置中心 credentials.finance → 行配置 → 环境变量（逐请求惰性解析）。 */
export function createCredentialProviders(ctx: Context, config: Config): { username: () => string; password: () => string } {
  const readRouter = (): Record<string, string> | undefined => {
    const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as RouterLike | undefined
    return router?.getCredential?.('finance')
  }
  return {
    username: () => readRouter()?.username || config.username || process.env[config.usernameEnv] || 'api',
    password: () => readRouter()?.password || config.password || process.env[config.passwordEnv] || '',
  }
}

/** 路由 handler（独立导出便于测试）：auth 栅栏 + 白名单子路由 + 错误映射。 */
export function createRouteHandler(client: FinanceClient, config: Config, connection: ConnectionLike) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 同官方 RPC 通道栅栏（updater/行情桥同构）：未认证一律 401/403。
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    const raw = url.pathname
    const sub = raw === MOUNT || raw.startsWith(MOUNT + '/') ? raw.slice(MOUNT.length) || '/' : raw

    if (req.method === 'GET' && sub === '/status') {
      sendJson(res, 200, { ok: true, configured: client.configured(), baseUrl: config.baseUrl, username: config.username })
      return
    }

    const route = ROUTES.find((candidate) => candidate.sub === sub)
    if (req.method !== 'GET' || route === undefined) {
      sendJson(res, 404, { ok: false, code: 'SPECIAL_INDICATORS_ROUTE_NOT_FOUND', message: 'unknown special-indicators route: ' + sub })
      return
    }
    const upstream = route.upstream(url, config)
    if (upstream === null) {
      sendJson(res, 400, { ok: false, code: 'SPECIAL_INDICATORS_BAD_PARAMS', message: 'invalid query params for ' + sub })
      return
    }
    try {
      const ttl = tierTtlMs(route.tier, config)
      const { payload, meta } = await client.getWithMeta(upstream, ttl)
      // 透传上游 JSON（自有服务自有数据；包装 ok 信封与 updater 桥一致）。
      // 陈旧回源立即服役时如实带 stale 标记（浏览器半渲染「数据滞后」徽标）。
      sendJson(res, 200, { ok: true, data: payload, stale: meta.stale === true || undefined })
    } catch (error) {
      if (error instanceof FinanceError) {
        const status = error.code === 'FINANCE_NOT_CONFIGURED' ? 200 : error.code === 'FINANCE_AUTH_FAILED' ? 502 : error.code === 'FINANCE_RATE_LIMITED' ? 503 : 502
        sendJson(res, status, { ok: false, code: error.code, message: error.message })
        return
      }
      sendJson(res, 200, { ok: false, code: 'SPECIAL_INDICATORS_UNKNOWN', message: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * Host plugin body: mount the bridge route (web host) or stay quiescent
 * (headless). The browser half registers the 中栏「特殊指标」tab.
 * @param ctx - Host cordis context (profile patch row entry).
 */
export function apply(ctx: Context, config: Config): void {
  const credentials = createCredentialProviders(ctx, config)
  // 缓存落盘：宿主进程退出后内存缓存清零，而浏览器侧缓存按 origin 隔离
  // （桌面壳每次启动换随机端口）——没有文件镜像时「重启一次 = 冷拉一次」。
  const cacheFilePath = config.cacheFile === '' ? defaultCacheFilePath() : config.cacheFile
  const client = new FinanceClient({
    baseUrl: config.baseUrl,
    username: credentials.username,
    password: credentials.password,
    timeoutMs: config.timeoutMs,
    persistence: createFileCachePersistence({ baseUrl: config.baseUrl, filePath: cacheFilePath }),
  })

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer') as unknown as WebServerLike | undefined
    const connection = webCtx.get('connection') as unknown as ConnectionLike | undefined
    if (webServer === undefined || connection === undefined) return
    const handler = createRouteHandler(client, config, connection)
    ctx.effect(() => webServer.register({ kind: 'prefix', path: MOUNT, handler }), 'dsh-trading-client-ui-special-indicators: ' + MOUNT + ' route')
  })

  // agent 工具面：与上面的桥共用同一个 client（同一缓存、同一凭据链、同一白名单）。
  // 嵌套 inject 而非 module 级 inject（本包 inject: []）——headless/无 tools 服务的
  // 宿主里桥照常工作，工具面自行挂起，不会因为缺一个服务整行不加载。
  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx.get('tools') as unknown as ToolsLike | undefined
    if (tools === undefined) return
    for (const tool of createSpecialIndicatorTools(client, config)) {
      // 同名先到先得，绝不重复注册（dsh-tools 对同名重复注册直接抛错）。
      if (tools.get(tool.name) === undefined) {
        ctx.effect(() => tools.register(tool), 'dsh-trading-client-ui-special-indicators: tool ' + tool.name)
      }
    }
  })
}

/** Re-exports for tests and tooling. */
export { FinanceClient, FinanceError } from './finance-client.ts'
export type { CachePersistence, PersistedCacheEntry } from './finance-client.ts'
export { createFileCachePersistence, defaultCacheFilePath } from './cache-file.ts'
export { ROUTES, SECTOR_CODE_RE, buildUpstreamPath, clampInt, tierOf, tierTtlMs } from './routes.ts'
export type { CacheTierConfig, RouteConfig, RouteDef, RouteTier } from './routes.ts'
export { createSpecialIndicatorTools, INDICATOR_TOOL_NAMES } from './indicator-tools.ts'
export type { IndicatorToolConfig } from './indicator-tools.ts'
