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
 *
 * 浏览器半（exports["./client"]）注册中栏「特殊指标」tab。
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { FinanceClient, FinanceError } from './finance-client.ts'

/** Cordis 插件名 = patch 行 id（TEMPLATES §8）。 */
export const name = 'dsh-trading-client-ui-special-indicators'

/** 本插件不硬依赖任何服务（headless 宿主零要求）；web 面依赖在 apply 内 inject。 */
export const inject: readonly string[] = []

export interface Config {
  baseUrl: string
  username: string
  password: string
  usernameEnv: string
  passwordEnv: string
  timeoutMs: number
  snapshotCacheMs: number
  historyCacheMs: number
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().default('https://finance.chatwithai.icu').description('自有 finance 服务地址（docs/api.md）'),
  username: Schema.string().default('api').description('finance HTTP Basic 用户名'),
  password: Schema.string().default('').description('finance HTTP Basic 密码（只写本地 profile 行配置，勿提交仓库；空 = 走凭据链兜底）'),
  usernameEnv: Schema.string().default('FINANCE_API_USER').description('用户名环境变量名（凭据链末位兜底）'),
  passwordEnv: Schema.string().default('FINANCE_API_PASSWORD').description('密码环境变量名（凭据链末位兜底）'),
  timeoutMs: Schema.number().default(60_000).description('单次上游请求超时（ms）；冷缓存上游重算可能十几秒'),
  snapshotCacheMs: Schema.number().default(60_000).description('快照类路由内存缓存（ms）'),
  historyCacheMs: Schema.number().default(300_000).description('历史/明细类路由内存缓存（ms）'),
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

export const MOUNT = '/dshtrading/api/special-indicators'

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** 板块代码白名单（数字/字母，防路径注入）。 */
const SECTOR_CODE_RE = /^[0-9A-Za-z]{1,12}$/

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

interface RouteDef {
  /** 子路径（MOUNT 之后），如 /basis/snapshot。 */
  sub: string
  /** 由已校验查询参数拼上游路径；返回 null = 参数非法（400）。 */
  upstream: (url: URL) => string | null
  /** 缓存档：snapshot 用 snapshotCacheMs，history 用 historyCacheMs。 */
  tier: 'snapshot' | 'history'
}

/** 固定子路由白名单（非通用代理；对上游只读 GET）。 */
export const ROUTES: readonly RouteDef[] = [
  { sub: '/basis/snapshot', upstream: () => '/api/snapshot', tier: 'snapshot' },
  {
    sub: '/basis/history',
    upstream: (url) => '/api/v2/basis/history?days=' + clampInt(url.searchParams.get('days'), 200, 10, 500),
    tier: 'history',
  },
  // 恐慌指数固定 market=cn + methodology=2（与页面默认方法一致；docs/api.md 要求调用方固定方法）。
  { sub: '/sentiment/snapshot', upstream: () => '/api/sentiment/snapshot?market=cn&methodology=2', tier: 'snapshot' },
  {
    sub: '/sentiment/history',
    upstream: (url) => '/api/sentiment/history?market=cn&methodology=2&days=' + clampInt(url.searchParams.get('days'), 750, 30, 800),
    tier: 'history',
  },
  { sub: '/hk-short/snapshot', upstream: () => '/api/hk-short/snapshot', tier: 'snapshot' },
  { sub: '/hk-short/chart', upstream: () => '/api/hk-short/chart', tier: 'history' },
  { sub: '/sectors/snapshot', upstream: () => '/api/sectors/snapshot', tier: 'snapshot' },
  {
    sub: '/sectors/ranking',
    upstream: (url) => '/api/sectors/ranking?window=' + clampInt(url.searchParams.get('window'), 20, 1, 120),
    tier: 'snapshot',
  },
  {
    sub: '/sectors/detail',
    upstream: (url) => {
      const code = url.searchParams.get('code') ?? ''
      if (!SECTOR_CODE_RE.test(code)) return null
      return '/api/v2/sectors/' + encodeURIComponent(code) + '?days=' + clampInt(url.searchParams.get('days'), 200, 10, 500)
    },
    tier: 'history',
  },
]

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
    const upstream = route.upstream(url)
    if (upstream === null) {
      sendJson(res, 400, { ok: false, code: 'SPECIAL_INDICATORS_BAD_PARAMS', message: 'invalid query params for ' + sub })
      return
    }
    try {
      const ttl = route.tier === 'snapshot' ? config.snapshotCacheMs : config.historyCacheMs
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
  const client = new FinanceClient({
    baseUrl: config.baseUrl,
    username: credentials.username,
    password: credentials.password,
    timeoutMs: config.timeoutMs,
  })

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer') as unknown as WebServerLike | undefined
    const connection = webCtx.get('connection') as unknown as ConnectionLike | undefined
    if (webServer === undefined || connection === undefined) return
    const handler = createRouteHandler(client, config, connection)
    ctx.effect(() => webServer.register({ kind: 'prefix', path: MOUNT, handler }), 'dsh-trading-client-ui-special-indicators: ' + MOUNT + ' route')
  })
}

/** Re-exports for tests and tooling. */
export { FinanceClient, FinanceError } from './finance-client.ts'
