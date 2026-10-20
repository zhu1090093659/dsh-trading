/** Research runs inside the trading host. No upstream server or proxy. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { dshHomeDir } from '@dshtrading/dsh-home'
import { createReadStream, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-trading-client-ui-research'
export const inject: readonly string[] = []
export const MOUNT = '/dshtrading/api/research'
export interface Config { dataDir: string; python: string; reminders: boolean }
export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default('').description('Research data directory; defaults to the trading home research/ directory'),
  python: Schema.string().default('').description('Python 3.11+ executable for research data and calculations'),
  reminders: Schema.boolean().default(true).description('Run enabled research reminders with the host lifecycle'),
})
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = join(packageRoot, 'lib', 'runtime')
const assetsRoot = join(packageRoot, 'lib', 'workbench')
type EngineContext = { repoRoot: string; dataRoot: string; python: string; node: string }
interface EngineModule {
  createApiHandler(context: EngineContext): RequestListener
  startScheduler(context: EngineContext): () => void
}
export type ResearchHandler = RequestListener & { dispose(): void }
function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
/** Exposed for real integration tests using isolated trading data. */
export function createResearchRouteHandler(config: Partial<Config> = {}): ResearchHandler {
  const dataRoot = resolve(config.dataDir || join(dshHomeDir(), 'research'))
  const venvPython = join(dataRoot, 'python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const python = config.python || process.env.DSH_RESEARCH_PYTHON || (existsSync(venvPython) ? venvPython : process.platform === 'win32' ? 'python' : 'python3')
  let engine: Promise<RequestListener> | undefined
  let disposed = false
  let stopScheduler: (() => void) | undefined
  const load = (): Promise<RequestListener> => {
    engine ??= (async () => {
      mkdirSync(dataRoot, { recursive: true })
      const module = await import(pathToFileURL(join(runtimeRoot, 'orchestrator/src/api.js')).href) as EngineModule
      const context = { repoRoot: runtimeRoot, dataRoot, python, node: process.execPath }
      if (config.reminders !== false && !disposed) stopScheduler = module.startScheduler(context)
      return module.createApiHandler(context)
    })().catch(error => { engine = undefined; throw error })
    return engine
  }
  const handler: RequestListener = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const sub = url.pathname.slice(MOUNT.length)
      if (sub === '/status') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' })
        await load()
        return json(res, 200, { ok: true, mode: 'native', sections: 8 })
      }
      if (sub.startsWith('/assets/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' })
        const asset = decodeURIComponent(sub.slice('/assets/'.length))
        const file = resolve(assetsRoot, asset)
        const rel = relative(assetsRoot, file)
        if (!asset || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel) || !existsSync(file)) return json(res, 404, { error: 'asset_not_found' })
        const actual = relative(realpathSync(assetsRoot), realpathSync(file))
        if (actual === '..' || actual.startsWith('..' + sep) || isAbsolute(actual) || !statSync(file).isFile()) return json(res, 404, { error: 'asset_not_found' })
        const mime: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
        res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' })
        if (req.method === 'HEAD') { res.end(); return }
        createReadStream(file).on('error', () => res.destroy()).pipe(res)
        return
      }
      if (sub === '/engine/update') return json(res, 200, { enabled: false, available: false })
      if (sub === '/engine' || sub.startsWith('/engine/')) {
        const handler = await load()
        const originalUrl = req.url
        req.url = (sub.slice('/engine'.length) || '/') + url.search
        try { await handler(req, res) } finally { req.url = originalUrl }
        return
      }
      json(res, 404, { error: 'research_route_not_found' })
    } catch (error) {
      console.error('[research] request failed:', error instanceof Error ? error.message : String(error))
      if (!res.headersSent) json(res, 503, { error: 'research_unavailable', message: 'Research could not load. Check the trading host log and retry.' })
      else res.destroy()
    }
  }
  return Object.assign(handler, { dispose() { disposed = true; stopScheduler?.() } })
}
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  ctx.inject(['webServer', 'connection'], scope => {
    const webServer = scope.get('webServer') as unknown as { register(route: { kind: 'prefix'; path: string; handler: RequestListener }): () => void }
    const connection = scope.get('connection') as unknown as { requestRejection(req: IncomingMessage): number | undefined }
    if (!webServer || !connection) return
    const handler = createResearchRouteHandler(config)
    ctx.effect(() => {
      const unregister = webServer.register({ kind: 'prefix', path: MOUNT, handler: (req, res) => {
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) return json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
        return handler(req, res)
      } })
      return () => { unregister(); handler.dispose() }
    }, 'dsh-trading-client-ui-research: native workspace')
  })
}
