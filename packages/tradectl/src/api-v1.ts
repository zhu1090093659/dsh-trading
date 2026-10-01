/**
 * /v1 面与静态资源托管（P4 步骤 3 的服务端一半）。
 *
 * 三件事：
 *   1. **版本与能力协商**落在每个请求上（X-Dsht-Caps + 426），而不是只在握手时做一次；
 *   2. **卡片下发**走契约包：校验 → 未知枚举的卡片以"不可操作"形态下发（不是丢弃，
 *      丢弃会让用户以为没这条数据）→ 按 caps 过滤动作 → 分页受 maxCardsPerPage 约束；
 *   3. **静态资源**由 edge 自己托管（**不引** dsh 的 webserver 行）：目录遍历被拒、
 *      index.html 不缓存、其余带长缓存。SPA 本体由前端构建产出，服务端只负责"把文件
 *      按正确的方式发出去"。
 *
 * @module @dshtrading/tractl/api-v1
 */
import { readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import {
  CARD_LIMITS,
  negotiateVersion,
  parseCaps,
  renderableActions,
  toClientOrderView,
  validateCard,
  type Card,
} from '@dshtrading/contract'

/** 允许的静态资源扩展名与 content-type（白名单，不做 MIME 嗅探）。 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** 协商所需的最小请求信息。 */
export interface V1Request {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string | undefined>
}

/** 一次 /v1 处理的结果（由调用方写回 HTTP；测试直接断言这个对象）。 */
export interface V1Response {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

export interface V1SurfaceOptions {
  /** 当前客户端的 major（来自 URL，如 /v1/...）。 */
  readonly serverMajor: number
  /** 本次响应要求的必填能力。 */
  readonly requiredCaps?: readonly string[]
  /** 服务端支持的可选能力。 */
  readonly serverCaps?: readonly string[]
  /** 取当前卡片（服务端驱动，客户端只渲染）。 */
  readonly cards: () => readonly Card[]
  /** 静态资源根目录（SPA 构建产物）；不给则不托管静态资源。 */
  readonly staticDir?: string | undefined
}

/** 从路径里解析 major（/v1/cards → { major: 1, rest: 'cards' }）。 */
export function parseVersionedPath(path: string): { major: number; rest: string } | undefined {
  const match = /^\/v(\d+)\/(.*)$/.exec(path)
  if (match === null) return undefined
  // noUncheckedIndexedAccess：正则第二组在类型上仍是 string | undefined，这里显式兜底
  return { major: Number(match[1]), rest: match[2] ?? '' }
}

/** 把客户端 caps 头解析成集合（大小写不敏感的头名）。 */
function capsOf(request: V1Request): string[] {
  const raw = request.headers['x-dsht-caps'] ?? request.headers['X-Dsht-Caps']
  return parseCaps(raw)
}

/**
 * 处理一个 /v1 请求。
 * 顺序有意如此：**先协商，再取数**——能力不够时不该先把数据读出来再丢掉。
 * @param request - 方法与路径与头。
 * @param options - 面配置。
 */
export function handleV1(request: V1Request, options: V1SurfaceOptions): V1Response {
  const versioned = parseVersionedPath(request.path)
  if (versioned === undefined) {
    return { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ code: 'NOT_VERSIONED', message: 'path must start with /v<major>/' }) }
  }
  const verdict = negotiateVersion({
    clientMajor: versioned.major,
    serverMajor: options.serverMajor,
    clientCaps: capsOf(request),
    ...(options.requiredCaps === undefined ? {} : { requiredCaps: options.requiredCaps }),
    ...(options.serverCaps === undefined ? {} : { serverCaps: options.serverCaps }),
  })
  if (!verdict.ok) {
    return {
      status: verdict.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ code: verdict.code, message: verdict.message }),
    }
  }
  if (request.method !== 'GET') {
    return { status: 405, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ code: 'METHOD_NOT_ALLOWED', message: 'only GET is served by this surface' }) }
  }
  if (versioned.rest === 'cards') {
    const all = options.cards()
    const page = all.slice(0, CARD_LIMITS.maxCardsPerPage)
    const payload = {
      cards: page.map((card) => {
        const cardVerdict = validateCard(card)
        return {
          ...card,
          // 未知枚举 ⇒ 以"不可操作"形态下发（**不是丢弃**）：用户仍能看到内容与兜底文本。
          actions: renderableActions(card, verdict.caps, CARD_LIMITS),
          operable: cardVerdict.operable,
          ...(cardVerdict.valid ? {} : { problems: cardVerdict.problems }),
        }
      }),
      truncated: all.length > page.length,
      caps: verdict.caps,
      downgraded: verdict.downgraded,
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-dsht-caps': verdict.caps.join(',') },
      body: JSON.stringify(payload),
    }
  }
  if (versioned.rest.startsWith('assets/') && options.staticDir !== undefined) {
    return serveStatic(versioned.rest.slice('assets/'.length), options.staticDir)
  }
  return { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ code: 'NOT_FOUND', message: versioned.rest }) }
}

/**
 * 托管一个静态资源。三道闸：目录遍历、扩展名白名单、index 不缓存。
 * @param relativePath - /v1/assets/ 之后的相对路径。
 * @param staticDir - 根目录。
 */
export function serveStatic(relativePath: string, staticDir: string): V1Response {
  const root = resolve(staticDir)
  const target = resolve(join(root, normalize(relativePath)))
  // 目录遍历：解析后的绝对路径必须仍在根目录之内。
  if (target !== root && !target.startsWith(root + sep)) {
    return { status: 403, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ code: 'PATH_ESCAPE', message: 'asset path escapes the static root' }) }
  }
  const type = CONTENT_TYPES[extname(target).toLowerCase()]
  if (type === undefined) {
    return { status: 415, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ code: 'UNSUPPORTED_MEDIA', message: 'extension is not in the whitelist' }) }
  }
  try {
    if (!statSync(target).isFile()) throw new Error('not a file')
    const body = readFileSync(target, 'utf8')
    const immutable = !target.endsWith('index.html')
    return {
      status: 200,
      headers: { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store' },
      body,
    }
  } catch {
    return { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ code: 'ASSET_NOT_FOUND', message: relativePath }) }
  }
}

/**
 * 把 /v1 面挂到一个与 edge 的 register 同形的端口上（复用 P2 的 edge 网关）。
 * @param register - edge 提供的路由注册口。
 * @param options - 面配置。
 */
export function attachV1Surface(register: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void, options: V1SurfaceOptions): void {
  register('/v1', (req, res) => {
    const headers: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(req.headers)) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value
    const result = handleV1({ method: req.method ?? 'GET', path: new URL(req.url ?? '/', 'http://edge').pathname, headers }, options)
    res.writeHead(result.status, result.headers)
    res.end(result.body)
  })
}

/** 供调用方复用的视图投影（见契约包的 id 冻结面）。 */
export { toClientOrderView }
