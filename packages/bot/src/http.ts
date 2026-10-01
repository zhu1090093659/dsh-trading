/**
 * bot 面自带的 HTTP 传输行 —— 不踩官方 web 栈（卡片 §2.2）。
 *
 * 提供的两个服务沿用官方**服务名**（webServer / connection），因为
 * @dshtrading/bot-api 的路由挂载与认证栅栏就是按这两个名字写的；但实现是本包自己的：
 * 只有 node:http + 一张路由表 + 一个 Host 白名单栅栏。这样 bot profile 不需要
 * 官方 webserver / connection / modules 三行（它们进全局必需集，任一失败就 dispose
 * 整个 app），行 id 也不叫 webserver（走 dsh-trading-* 命名空间）。
 *
 * 栅栏的语义与官方 browser-trust fence 同源：Host 不在回环字面量也不在可信名单里
 * 就拒（403）——防 DNS rebinding 的同一类问题；不用 cookie，所以没有 CSRF 面。
 *
 * @module @dshtrading/bot/http
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { BOT_STARTUP_SERVICE, type BotStartup } from './startup.ts'

/** 稳定 Cordis 插件名。 */
export const name = 'bot-http'

/** 等 bot 调用期取值就位再绑定。 */
export const inject: readonly string[] = [BOT_STARTUP_SERVICE]

/** 回环字面量：无论 trustedHosts 怎么配都算可信（本机永远是本机）。 */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '::1', 'localhost', '[::1]']

/** 注册到 bot 面上的路由（形状与官方 webServer.register 一致，便于 bot-api 直接复用）。 */
export interface BotRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 与官方 WebServerLike 同构的最小结构面。 */
export interface BotWebServer {
  register(route: BotRoute): () => void
}

/** 与官方 ConnectionLike 同构的最小结构面。 */
export interface BotConnectionFence {
  requestRejection(req: IncomingMessage): number | undefined
}

/** 一个已绑定的 bot HTTP 面。 */
export interface BotHttpHost {
  readonly url: string
  readonly port: number
  readonly webServer: BotWebServer
  readonly connection: BotConnectionFence
  close(): Promise<void>
}

/** 从 Host 头取出 hostname（去掉端口；IPv6 字面量保留方括号）。 */
export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined || hostHeader === '') return undefined
  const value = hostHeader.trim()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end < 0 ? undefined : value.slice(0, end + 1)
  }
  const colon = value.indexOf(':')
  return colon < 0 ? value : value.slice(0, colon)
}

/**
 * Host 白名单判定。缺 Host（HTTP/1.0）、非回环且不在可信名单 → 不可信。
 * trustedHosts 允许写 host 或 host:port（与官方 --trusted-host 同形）。
 * @param hostHeader - 请求的 Host 头。
 * @param trustedHosts - 部署声明的额外可信 authority。
 */
export function isTrustedHost(hostHeader: string | undefined, trustedHosts: readonly string[]): boolean {
  const hostname = hostnameOf(hostHeader)
  if (hostname === undefined) return false
  if (LOOPBACK_HOSTS.includes(hostname)) return true
  const authority = hostHeader === undefined ? '' : hostHeader.trim()
  return trustedHosts.some((entry) => entry === hostname || entry === authority)
}

/** 路径匹配：exact 全等；prefix 认自身与子路径（/a 匹配 /a 与 /a/b，不匹配 /ab）。 */
export function routeMatches(route: { kind: 'exact' | 'prefix'; path: string }, pathname: string): boolean {
  if (route.kind === 'exact') return pathname === route.path
  return pathname === route.path || pathname.startsWith(route.path + '/')
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * 绑定 bot HTTP 面并返回可注入的服务对。端口 0 让 OS 选空闲端口（测试用），
 * 绑定的真实端口从 url 读。绑定失败直接 reject —— fail-loud，不静默降级成「没有面」。
 * @param options - 绑定地址、端口与可信 authority。
 */
export async function createBotHttp(options: {
  host: string
  port: number
  trustedHosts: readonly string[]
}): Promise<BotHttpHost> {
  const routes: BotRoute[] = []
  const startedAt = Date.now()
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost')).pathname
    const rejection = fence.requestRejection(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { code: 'BOT_HOST_REJECTED', message: 'host ' + String(req.headers.host) + ' is not trusted by the bot surface' })
      return
    }
    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true, service: 'dsh-trading-bot', pid: process.pid, uptimeMs: Date.now() - startedAt, routes: routes.length })
      return
    }
    for (const route of routes) {
      if (!routeMatches(route, pathname)) continue
      void Promise.resolve().then(() => route.handler(req, res)).catch((error: unknown) => {
        if (!res.headersSent) sendJson(res, 500, { code: 'BOT_ROUTE_FAILED', message: error instanceof Error ? error.message : String(error) })
        else res.end()
      })
      return
    }
    sendJson(res, 404, { code: 'BOT_ROUTE_NOT_FOUND', message: 'no route for ' + pathname })
  })

  const fence: BotConnectionFence = {
    requestRejection(req) {
      return isTrustedHost(req.headers.host, options.trustedHosts) ? undefined : 403
    },
  }
  const webServer: BotWebServer = {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    url: 'http://' + options.host + ':' + String(address.port),
    port: address.port,
    webServer,
    connection: fence,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined || error === null ? resolve() : reject(error)))
    }),
  }
}

/**
 * Host 行体：绑定 bot 面，并把 webServer / connection 两个服务提供出去，
 * 让 @dshtrading/bot-api 的路由挂载与认证栅栏原样生效。停止时关服务器。
 * @param ctx - 携带 botStartup 的 Host 上下文。
 */
export function apply(ctx: Context): void {
  const startup = (ctx as unknown as { get(key: string): unknown }).get(BOT_STARTUP_SERVICE) as BotStartup | undefined
  if (startup === undefined) throw new Error('bot-http requires the ' + BOT_STARTUP_SERVICE + ' service')
  const pending = createBotHttp({
    host: startup.host,
    port: startup.port,
    trustedHosts: startup.trustedHosts,
  })
  ;(ctx as unknown as { effect(callback: () => () => void, label?: string): void }).effect(() => {
    let close: (() => Promise<void>) | undefined
    let disposed = false
    void pending.then((host) => {
      if (disposed) { void host.close(); return }
      close = host.close
      const provide = (ctx as unknown as { provide(key: string, value: unknown): void }).provide
      provide.call(ctx, 'webServer', host.webServer)
      provide.call(ctx, 'connection', host.connection)
      process.stdout.write('dsh-trading bot surface: ' + host.url + String.fromCharCode(10))
    })
    return () => {
      disposed = true
      if (close !== undefined) void close()
    }
  }, 'dsh-trading-bot: bind bot HTTP surface')
}
