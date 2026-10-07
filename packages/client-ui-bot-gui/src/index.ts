/**
 * @dshtrading/client-ui-bot-gui, node half — /dshtrading/api/bot-gui 桥。
 *
 * 本地私有插件（private: true，永不发布）：
 * - 代理多台交易机器人 edge 服务（/v1/cards, /v1/commands）。
 * - 插件 config 为机器人列表 [{name, baseUrl, deviceId, secret}]。
 * - node 半按名称路由代理：/dshtrading/api/bot-gui/:bot/cards 以及 /dshtrading/api/bot-gui/:bot/commands。
 * - 路由挂在独立前缀 /dshtrading/api/bot-gui。
 * - 鉴权栅栏与官方 RPC 通道同款（connection.requestRejection）。
 * - 向上游 edge 发送请求时带上 Authorization: Bearer <deviceId>.<secret>。
 * - 命令面转发 POST /v1/commands 时带上 x-dsht-caps 全 12 动作（ALL_ACTION_CAPS）。
 * - 浏览器半（exports["./client"]）注册中栏「机器人」tab。
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'dsh-trading-client-ui-bot-gui'
export const inject: readonly string[] = []

export interface BotConfig {
  name: string
  baseUrl: string
  deviceId: string
  secret: string
}

export const BotConfig: Schema<BotConfig> = Schema.object({
  name: Schema.string().required().description('机器人名称（用于路由与切换）'),
  baseUrl: Schema.string().required().description('机器人 edge 基础 URL（如 http://127.0.0.1:3901）'),
  deviceId: Schema.string().default('').description('设备 ID（配对所得）'),
  secret: Schema.string().default('').description('设备密钥（配对所得）'),
})

export interface Config {
  bots: BotConfig[]
  timeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  bots: Schema.array(BotConfig).default([]).description('机器人列表'),
  timeoutMs: Schema.number().default(30_000).description('请求上游超时（毫秒）'),
})

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

export const MOUNT = '/dshtrading/api/bot-gui'

export const ALL_ACTION_KINDS = [
  'ack',
  'dismiss',
  'open-detail',
  'retry-sync',
  'approve',
  'reject',
  'pause',
  'resume',
  'kill',
  'flatten',
  'grant-control',
  'revoke-device',
] as const

export const ALL_ACTION_CAPS = ALL_ACTION_KINDS.map((k) => 'action:' + k).join(',')

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function readBody(req: IncomingMessage, maxBytes = 65536): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        req.destroy()
        reject(new Error('Payload too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

export function createRouteHandler(
  config: Config,
  connection?: ConnectionLike,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) {
  const botsMap = new Map<string, BotConfig>()
  for (const bot of config.bots) {
    if (bot.name) botsMap.set(bot.name, bot)
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. 安全栅栏：browser auth cookie + origin / host fence
    if (connection !== undefined) {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        sendJson(res, rejection, { code: 'UNAUTHORIZED', message: 'Host connection rejection' })
        return
      }
    }

    const host = req.headers.host ?? '127.0.0.1'
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://' + host)
    } catch {
      sendJson(res, 400, { code: 'INVALID_URL', message: 'Malformed URL' })
      return
    }

    const sub = url.pathname.slice(MOUNT.length)

    // GET /status -> 列出已配置的机器人
    if (sub === '' || sub === '/' || sub === '/status') {
      const botList = config.bots.map((b) => ({
        name: b.name,
        configured: Boolean(b.deviceId && b.secret),
      }))
      sendJson(res, 200, {
        bots: botList,
        activeBot: botList.length > 0 && botList[0] ? botList[0].name : undefined,
      })
      return
    }

    // 解析 /:bot/cards 或 /:bot/commands
    // 匹配: ^/([^/]+)/(cards|commands)$
    const match = sub.match(/^\/([^/]+)\/(cards|commands)$/)
    if (!match) {
      sendJson(res, 404, { code: 'BOT_ROUTE_NOT_FOUND', message: 'Route not supported: ' + sub })
      return
    }

    const botName = decodeURIComponent(match[1] ?? '')
    const endpoint = match[2] ?? ''
    const bot = botsMap.get(botName)

    if (!bot) {
      sendJson(res, 404, { code: 'BOT_NOT_FOUND', message: 'Bot not found: ' + botName })
      return
    }

    const upstreamUrl = bot.baseUrl.replace(/\/+$/, '') + '/v1/' + endpoint
    const headers: Record<string, string> = {
      'x-dsht-caps': ALL_ACTION_CAPS,
    }

    if (bot.deviceId && bot.secret) {
      headers['authorization'] = 'Bearer ' + bot.deviceId + '.' + bot.secret
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)

    try {
      if (endpoint === 'cards') {
        if (req.method !== 'GET') {
          clearTimeout(timer)
          sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'cards endpoint requires GET' })
          return
        }

        const upstreamRes = await fetchImpl(upstreamUrl, {
          method: 'GET',
          headers,
          signal: controller.signal,
        })
        clearTimeout(timer)

        const text = await upstreamRes.text()
        res.writeHead(upstreamRes.status, {
          'content-type': upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(text)
        return
      }

      if (endpoint === 'commands') {
        if (req.method !== 'POST') {
          clearTimeout(timer)
          sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'commands endpoint requires POST' })
          return
        }

        const body = await readBody(req)
        headers['content-type'] = 'application/json'

        const upstreamRes = await fetchImpl(upstreamUrl, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })
        clearTimeout(timer)

        const text = await upstreamRes.text()
        res.writeHead(upstreamRes.status, {
          'content-type': upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(text)
        return
      }
    } catch (err: unknown) {
      clearTimeout(timer)
      const isAbort = (err as Error)?.name === 'AbortError'
      sendJson(res, isAbort ? 504 : 502, {
        code: isAbort ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_GATEWAY_ERROR',
        message: String((err as Error)?.message || err),
      })
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer') as unknown as WebServerLike | undefined
    const connection = webCtx.get('connection') as unknown as ConnectionLike | undefined
    if (webServer === undefined) return
    const handler = createRouteHandler(config, connection)
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: MOUNT, handler }),
      'dsh-trading-client-ui-bot-gui: ' + MOUNT + ' route',
    )
  })
}
