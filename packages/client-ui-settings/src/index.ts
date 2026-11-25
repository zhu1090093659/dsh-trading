/**
 * Trading settings surface, node half + host proxy diagnostic/test HTTP bridge.
 *
 * - /dshtrading/api/proxy/status (GET, ?refresh=1): returns redacted effective proxy state.
 * - /dshtrading/api/proxy/test (POST): probes a whitelisted target through active or draft proxy.
 * - Headless host compatibility: injects webServer/connection lazily and degrades quietly when absent.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  TRADING_NETWORK_PROXY_KEY,
  isProxyTestTarget,
  normalizeProxyMode,
  type NetworkProxyService,
  type ProxyConfig,
} from '@dshtrading/router'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** No hard host service dependencies so headless profiles start cleanly. */
export const inject: readonly string[] = []

const PROXY_API_MOUNT = '/dshtrading/api/proxy'
const MAX_PROXY_BODY_BYTES = 16 * 1024

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface ConnectionLike {
  requestRejection(req: IncomingMessage): number | undefined
}

class ProxyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buf.length
    if (total > MAX_PROXY_BODY_BYTES) {
      throw new ProxyHttpError(413, 'PROXY_BODY_TOO_LARGE', 'request body exceeds 16KiB limit')
    }
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ProxyHttpError(400, 'PROXY_INVALID_JSON', 'request body must be valid JSON')
  }
}

function parseOverrideConfig(raw: unknown): ProxyConfig | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProxyHttpError(400, 'PROXY_INVALID_OVERRIDE', 'override must be an object')
  }
  const obj = raw as Record<string, unknown>
  const url = typeof obj.url === 'string' ? obj.url.trim() : undefined
  const noProxy = typeof obj.noProxy === 'string' ? obj.noProxy.trim() : undefined
  return {
    mode: normalizeProxyMode(obj.mode),
    ...(url !== undefined && url !== '' ? { url } : {}),
    ...(noProxy !== undefined && noProxy !== '' ? { noProxy } : {}),
  }
}

/**
 * Create the HTTP handler for `/dshtrading/api/proxy/*`, gated by the host connection fence.
 */
export function createProxyRouteHandler(options: {
  connection: ConnectionLike
  getProxyService: () => NetworkProxyService | undefined
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const rejection = options.connection.requestRejection(req)
    if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    const service = options.getProxyService()
    if (service === undefined) {
      sendJson(res, 503, {
        ok: false,
        code: 'PROXY_UNAVAILABLE',
        message: 'network proxy service is unavailable',
      })
      return
    }

    const url = new URL(req.url ?? '/', 'http://dsh.local')
    const raw = url.pathname
    const sub = raw === PROXY_API_MOUNT || raw.startsWith(`${PROXY_API_MOUNT}/`)
      ? (raw.slice(PROXY_API_MOUNT.length) || '/')
      : raw

    try {
      if (req.method === 'GET' && sub === '/status') {
        const refresh = url.searchParams.get('refresh') === '1'
        const snap = refresh ? await service.refreshSystemProxy() : service.snapshot()
        sendJson(res, 200, { ok: true, ...snap })
        return
      }
      if (req.method === 'POST' && sub === '/test') {
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          throw new ProxyHttpError(400, 'PROXY_INVALID_BODY', 'request body must be a JSON object')
        }
        const record = body as Record<string, unknown>
        const rawTarget = record.target ?? 'okx'
        if (!isProxyTestTarget(rawTarget)) {
          throw new ProxyHttpError(
            400,
            'PROXY_TEST_INVALID_TARGET',
            'target must be one of okx, binance, yahoo, github',
          )
        }
        const override = parseOverrideConfig(record.override)
        const result = await service.testConnectivity({
          target: rawTarget,
          ...(override === undefined ? {} : { override }),
        })
        sendJson(res, 200, result)
        return
      }
      sendJson(res, 404, {
        ok: false,
        code: 'PROXY_ROUTE_NOT_FOUND',
        message: `unknown proxy route: ${sub}`,
      })
    } catch (error) {
      if (error instanceof ProxyHttpError) {
        sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
        return
      }
      sendJson(res, 500, {
        ok: false,
        code: 'PROXY_INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** Host plugin body: mount `/dshtrading/api/proxy` on web hosts while keeping minimal test stubs working. */
export function apply(ctx: Context): void {
  const ctxLike = ctx as unknown as {
    inject?: (deps: readonly string[], cb: (webCtx: Context) => void) => void
    get?: (name: string, strict?: boolean) => unknown
    effect?: (cb: () => () => void, label?: string) => void
  }
  if (typeof ctxLike?.inject !== 'function') return

  ctxLike.inject(['webServer', 'connection'], (webCtx) => {
    const webCtxLike = webCtx as unknown as { get?: (name: string, strict?: boolean) => unknown }
    const webServer = webCtxLike.get?.('webServer', false) as WebServerLike | undefined
    const connection = webCtxLike.get?.('connection', false) as ConnectionLike | undefined
    if (webServer === undefined || connection === undefined) return

    const getProxyService = (): NetworkProxyService | undefined =>
      (webCtxLike.get?.(TRADING_NETWORK_PROXY_KEY, false)
        ?? ctxLike.get?.(TRADING_NETWORK_PROXY_KEY, false)) as NetworkProxyService | undefined

    const route = {
      kind: 'prefix' as const,
      path: PROXY_API_MOUNT,
      handler: createProxyRouteHandler({ connection, getProxyService }),
    }
    const registerEffect = (webCtx as unknown as { effect?: typeof ctxLike.effect }).effect ?? ctxLike.effect
    if (typeof registerEffect === 'function') {
      registerEffect.call(webCtx, () => webServer.register(route), 'dsh-trading-client-ui-settings: /dshtrading/api/proxy route')
    } else {
      webServer.register(route)
    }
  })
}
