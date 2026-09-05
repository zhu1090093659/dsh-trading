/**
 * dsh-trading auto-update, node half — /dshtrading/api/updater HTTP bridge.
 *
 * - 检测面：GET /state（快照）、GET /check?force=1（GitHub /releases/latest +
 *   release notes）、POST /apply（增量更新管线，立即返回运行中快照，UI 轮询）。
 * - 路由挂独立前缀 /dshtrading/api/updater（webserver 最长前缀匹配，天然盖过
 *   行情桥的 /dshtrading/api，互不改对方的 handler）；与官方 RPC 通道同款栅栏
 *   （connection.requestRejection：Host/Origin fence + browser auth cookie）。
 * - headless 宿主无 webServer/connection：ctx.inject 子插件挂起，服务定时器
 *   照常（supported=false 时 auto-check 自关闭），profile 零副作用。
 *
 * 浏览器半（exports["./client"]）注册设置面板一级菜单（软件更新）。
 */
import type { Context } from '@deepseek-ai/cordis'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { discoverEnvironment } from './environment.ts'
import { UpdaterError, UpdaterService } from './updater-service.ts'

/** 本插件不硬依赖任何服务（headless 宿主零要求）；web 面依赖在 apply 内声明。 */
export const inject: readonly string[] = []

/** Update channel: this repository's GitHub Releases. */
export const UPDATE_REPO = 'zhu1090093659/dsh-trading'

interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

interface ConnectionLike {
  requestRejection(req: IncomingMessage): number | undefined
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** Env override for the release channel (tests / mirrors); defaults to the repo. */
function repoSlug(): string {
  const configured = process.env.DSH_TRADING_UPDATE_REPO
  return configured !== undefined && configured.trim() !== '' ? configured.trim() : UPDATE_REPO
}

/**
 * Host plugin body: mount the updater service + routes (web host) or stay
 * quiescent (headless). The service runs even without routes so a headless
 * profile keeps its persisted check state consistent — auto-check self-gates
 * on environment support.
 * @param ctx - Host cordis context (bundle loader entry).
 */
export function apply(ctx: Context): void {
  // Environment discovery happens once per host run: the profile location and
  // the family version do not change while the process is up.
  const env = discoverEnvironment()
  const service = new UpdaterService({
    env,
    repo: repoSlug(),
    statePath: process.env.DSH_TRADING_UPDATER_STATE
      ?? path.join(os.homedir(), '.dsh', 'trading-updater', 'state.json'),
    ...(process.env.DSH_TRADING_UPDATE_API_BASE !== undefined && process.env.DSH_TRADING_UPDATE_API_BASE !== ''
      ? { github: { apiBase: process.env.DSH_TRADING_UPDATE_API_BASE } }
      : {}),
  })

  ctx.effect(() => {
    service.start()
    return () => { service.dispose() }
  }, 'dsh-trading-client-ui-updater: service')

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer') as unknown as WebServerLike | undefined
    const connection = webCtx.get('connection') as unknown as ConnectionLike | undefined
    if (webServer === undefined || connection === undefined) return
    const route = {
      kind: 'prefix' as const,
      path: '/dshtrading/api/updater',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        // 同官方 RPC 通道栅栏（行情桥同构）：未认证一律 401/403。
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.local')
        const mount = '/dshtrading/api/updater'
        const raw = url.pathname
        const sub = raw === mount || raw.startsWith(`${mount}/`) ? raw.slice(mount.length) || '/' : raw
        try {
          if (req.method === 'GET' && sub === '/state') {
            sendJson(res, 200, service.snapshot())
            return
          }
          if (req.method === 'GET' && sub === '/check') {
            const force = url.searchParams.get('force') === '1'
            sendJson(res, 200, await service.check(force))
            return
          }
          if (req.method === 'POST' && sub === '/apply') {
            sendJson(res, 200, await service.apply())
            return
          }
          sendJson(res, 404, { ok: false, code: 'UPDATER_ROUTE_NOT_FOUND', message: 'unknown updater route: ' + sub })
        } catch (error) {
          if (error instanceof UpdaterError) {
            const status = error.code === 'UPDATER_BUSY' ? 409 : 400
            sendJson(res, status, { ok: false, code: error.code, message: error.message })
            return
          }
          sendJson(res, 200, { ok: false, code: 'UPDATER_UNKNOWN', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }
    ctx.effect(() => webServer.register(route), 'dsh-trading-client-ui-updater: /dshtrading/api/updater route')
  })
}

/** Re-exports for tests and tooling. */
export { UpdaterError, UpdaterService } from './updater-service.ts'
export type { UpdaterSnapshot } from './updater-service.ts'
export { discoverEnvironment } from './environment.ts'
