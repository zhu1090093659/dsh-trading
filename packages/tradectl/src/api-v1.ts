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
import { createIdempotencyLedger, type BeginOutcome } from './idempotency.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import {
  ACTION_SCOPE,
  assertNoClientOrderId,
  CARD_LIMITS,
  negotiateVersion,
  parseCaps,
  renderableActions,
  toClientOrderView,
  validateCard,
  type ScopePlane,
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
  /** 请求体（写路径才有；一元写是 JSON）。 */
  readonly body?: string | undefined
}

/** 一次 /v1 处理的结果（由调用方写回 HTTP；测试直接断言这个对象）。 */
export interface V1Response {
  readonly status: number
  readonly headers: Record<string, string>
  /** 文本响应体（JSON / 未压缩静态资源）。 */
  readonly body: string
  /**
   * 二进制响应体（预压缩的 gzip 产物）。**有它时以它为准** —— gzip 字节塞不进 string。
   * 2026-10-01 实测：同一份 JS 未压缩 147752 字节、gzip 后 48234 字节（约 1/3），
   * 真实网络下这是纯服务端就能拿回的 3 倍收益。
   */
  readonly bodyBytes?: Uint8Array | undefined
}

export interface V1SurfaceOptions {
  /** 当前客户端的 major（来自 URL，如 /v1/...）。 */
  readonly serverMajor: number
  /** 本次响应要求的必填能力。 */
  readonly requiredCaps?: readonly string[]
  /** 服务端支持的可选能力。 */
  readonly serverCaps?: readonly string[]
  /**
   * 调用方持有的 scope 平面（由 edge 从设备令牌解析后传入）。
   * 为什么不在这层解析令牌：令牌校验只有一处归属（edge），这里只做**授权判定**——
   * 两处都解析会变成两个事实之家。
   */
  readonly scopes: readonly ScopePlane[]
  /** 本面要求的平面（缺省 read：这是只读面）。 */
  readonly requiredPlane?: ScopePlane | undefined
  /**
   * 执行一个命令（写路径）。**端口注入**：本层不碰执行核，只负责授权、幂等与回执。
   * 返回的结果会被 assertNoClientOrderId 检查——**回执里带 clientOrderId 直接判失败**，
   * 因为这正是"客户端拿它绕开核心去对 venue 讲话"的入口。
   */
  readonly execute?: ((action: string, params: Record<string, unknown>) => Promise<unknown>) | undefined
  /** 单次请求体上限（字节）。 */
  readonly maxBodyBytes?: number | undefined
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
  // scope 判定在协商之后、取数之前：没有读平面就拿不到任何数据（也不该先把数据读出来）
  const requiredPlane = options.requiredPlane ?? 'read'
  if (!options.scopes.includes(requiredPlane)) {
    return {
      status: 403,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ code: 'SCOPE_REQUIRED', required: requiredPlane, granted: options.scopes }),
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
    // 生产路径就是这里：/v1/assets/** 走本函数，accept-encoding 必须传下去，
    // 否则预压缩永远不会生效（2026-10-01 端到端验证正是这样抓到 drill 分支与生产分支不一致）。
    return serveStatic(versioned.rest.slice('assets/'.length), options.staticDir, request.headers['accept-encoding'])
  }
  return { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ code: 'NOT_FOUND', message: versioned.rest }) }
}

/**
 * 托管一个静态资源。三道闸：目录遍历、扩展名白名单、index 不缓存。
 * @param relativePath - /v1/assets/ 之后的相对路径。
 * @param staticDir - 根目录。
 */
export function serveStatic(relativePath: string, staticDir: string, acceptEncoding?: string | undefined): V1Response {
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
    const immutable = !target.endsWith('index.html')
    const cacheControl = immutable ? 'public, max-age=31536000, immutable' : 'no-store'
    const wantsGzip = (acceptEncoding ?? '').toLowerCase().split(',').some((part) => part.trim().split(';')[0] === 'gzip')
    if (wantsGzip) {
      // 预压缩优先：省掉每次请求的 CPU，且产物与源码同源可控
      try {
        const gzipped = readFileSync(target + '.gz')
        return {
          status: 200,
          headers: { 'content-type': type, 'cache-control': cacheControl, 'content-encoding': 'gzip', vary: 'accept-encoding' },
          body: '',
          bodyBytes: gzipped,
        }
      } catch {
        // 没有预压缩产物就照常发明文：**绝不为了省字节而假装压缩过**
      }
    }
    const body = readFileSync(target, 'utf8')
    return {
      status: 200,
      headers: { 'content-type': type, 'cache-control': cacheControl, ...(wantsGzip ? { vary: 'accept-encoding' } : {}) },
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
    // 预压缩产物是二进制，必须走字节路径（写成 string 会把 gzip 破坏掉）
    res.end(result.bodyBytes ?? result.body)
  })
}

/** 供调用方复用的视图投影（见契约包的 id 冻结面）。 */
export { toClientOrderView }

/**
 * 处理一个写命令：POST /vN/commands，体为 { clientRequestId, action, params }。
 * 顺序：**scope（按动作）→ 幂等登记 → 执行 → 回执检查**。
 * 每一步失败都不执行——尤其"幂等键冲突"必须在执行之前判掉，否则就成了"先做了再说"。
 * @param request - 含 body 的请求。
 * @param rest - 版本后的路径。
 @param options - 面配置（含 execute 端口）。
 * @param caps - 已协商出的能力交集。
 */
async function handleCommand(request: V1Request, rest: string, options: V1SurfaceOptions, caps: readonly string[]): Promise<V1Response> {
  const json = (status: number, payload: unknown): V1Response => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) })
  if (rest !== 'commands') return json(404, { code: 'NOT_FOUND', message: rest })
  if (options.execute === undefined) return json(501, { code: 'WRITE_PATH_UNAVAILABLE', message: 'this surface has no command executor' })
  const raw = request.body ?? ''
  const maxBytes = options.maxBodyBytes ?? 8_192
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) return json(413, { code: 'BODY_TOO_LARGE', limit: maxBytes })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return json(400, { code: 'MALFORMED_BODY' })
  }
  if (parsed === null || typeof parsed !== 'object') return json(400, { code: 'MALFORMED_BODY' })
  const payload = parsed as { clientRequestId?: unknown; action?: unknown; params?: unknown }
  if (typeof payload.clientRequestId !== 'string' || payload.clientRequestId === '') return json(400, { code: 'CLIENT_REQUEST_ID_REQUIRED' })
  if (typeof payload.action !== 'string') return json(400, { code: 'ACTION_REQUIRED' })
  const scope = (ACTION_SCOPE as Record<string, ScopePlane | undefined>)[payload.action]
  if (scope === undefined) return json(400, { code: 'UNKNOWN_ACTION', action: payload.action })
  // 授权判定在执行之前
  if (!options.scopes.includes(scope)) return json(403, { code: 'SCOPE_REQUIRED', required: scope, granted: options.scopes })
  const params = (payload.params ?? {}) as Record<string, unknown>
  const ledger = ledgerFor(options)
  const outcome = ledger.begin(payload.clientRequestId, { action: payload.action, params })
  if (outcome.kind === 'conflict') return json(409, { code: 'IDEMPOTENCY_CONFLICT', message: outcome.message })
  if (outcome.kind === 'in-flight') return json(409, { code: 'REQUEST_IN_FLIGHT' })
  if (outcome.kind === 'replay') return json(200, { clientRequestId: payload.clientRequestId, replayed: true, result: outcome.result })
  try {
    const result = await options.execute(payload.action, params)
    // 回执检查：**带 clientOrderId 的结果直接判失败**（fail-closed，不下发、也不登记成成功）
    try {
      assertNoClientOrderId(result)
    } catch {
      ledger.fail(payload.clientRequestId)
      return json(500, { code: 'LEAKY_RESULT', message: 'the command result carried a clientOrderId and was withheld' })
    }
    ledger.complete(payload.clientRequestId, result)
    return json(200, { clientRequestId: payload.clientRequestId, replayed: false, caps, result })
  } catch (error) {
    ledger.fail(payload.clientRequestId)
    return json(502, { code: 'COMMAND_FAILED', message: error instanceof Error ? error.message : String(error) })
  }
}

/** 幂等账的最小面（本层只用这三件事）。 */
interface CommandLedger {
  begin(clientRequestId: string, payload: unknown): BeginOutcome<unknown>
  complete(clientRequestId: string, result: unknown): void
  fail(clientRequestId: string): void
}

/** 每个面实例一本幂等账（懒建，挂在 options 上以免污染调用方）。 */
const LEDGERS = new WeakMap<object, CommandLedger>()
function ledgerFor(options: V1SurfaceOptions): CommandLedger {
  const existing = LEDGERS.get(options)
  if (existing !== undefined) return existing
  const ledger: CommandLedger = createIdempotencyLedger<unknown>({ now: () => Date.now(), ttlMs: 10 * 60_000, maxEntries: 512 })
  LEDGERS.set(options, ledger)
  return ledger
}

/**
 * 异步入口：GET 交给同步 core，POST 走命令路径。
 * 为什么分两层而不是把 handleV1 变成 async：读面是纯计算（便于测试与复用），写面才需要等执行核；
 * 把两者混成一个 Promise 会让所有读路径的调用方都被迫 await。
 * @param request - 方法与路径、头与体。
 * @param options - 面配置。
 */
export async function handleV1Async(request: V1Request, options: V1SurfaceOptions): Promise<V1Response> {
  const versioned = parseVersionedPath(request.path)
  if (versioned === undefined || request.method !== 'POST') return handleV1(request, options)
  const verdict = negotiateVersion({
    clientMajor: versioned.major,
    serverMajor: options.serverMajor,
    clientCaps: capsOf(request),
    ...(options.requiredCaps === undefined ? {} : { requiredCaps: options.requiredCaps }),
    ...(options.serverCaps === undefined ? {} : { serverCaps: options.serverCaps }),
  })
  if (!verdict.ok) {
    return { status: verdict.status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ code: verdict.code, message: verdict.message }) }
  }
  return handleCommand(request, versioned.rest, options, verdict.caps)
}
