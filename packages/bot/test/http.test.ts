/**
 * bot 面自带 HTTP 传输行的行为测试：真起服务器、真发请求（不 mock、不 sleep）。
 * 覆盖三件事——A0 健康面、路由注册/注销语义、Host 栅栏（内网不等于可信）。
 */
import { request, type IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createBotHttp, hostnameOf, isTrustedHost, routeMatches, type BotHttpHost } from '../src/http.ts'

const hosts: BotHttpHost[] = []
async function startBotHttp(trustedHosts: readonly string[] = []): Promise<BotHttpHost> {
  const host = await createBotHttp({ host: '127.0.0.1', port: 0, trustedHosts })
  hosts.push(host)
  return host
}
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

/** 发一个请求并把 Host 头替换成调用方给的值（fetch 不允许改 Host）。 */
function call(port: number, path: string, hostHeader: string | undefined): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: hostHeader as string }, setHost: hostHeader !== undefined }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('bot HTTP 面 /healthz', () => {
  it('管理员：健康检查返回 200 与面身份，并报告已挂路由数', async () => {
    // Given 一个刚绑定的 bot HTTP 面
    const host = await startBotHttp()
    // When 请求 /healthz
    const res = await call(host.port, '/healthz', '127.0.0.1:' + String(host.port))
    // Then 200 且身份/路由数如实
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, service: 'dsh-trading-bot', routes: 0 })
  })
})

describe('bot HTTP 面路由表', () => {
  it('管理员：未注册路径 404；注册后命中；注销后回到 404', async () => {
    // Given 一个绑定的面与一条 exact 路由
    const host = await startBotHttp()
    const port = host.port
    const before = await call(port, '/dshtrading/api/ping', '127.0.0.1:' + String(port))
    // When 注册路由、请求、再注销后请求
    const dispose = host.webServer.register({
      kind: 'exact',
      path: '/dshtrading/api/ping',
      handler: (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"pong":true}') },
    })
    const after = await call(port, '/dshtrading/api/ping', '127.0.0.1:' + String(port))
    dispose()
    const removed = await call(port, '/dshtrading/api/ping', '127.0.0.1:' + String(port))
    // Then 三态依次为 404 / 200 / 404
    expect([before.status, after.status, removed.status]).toEqual([404, 200, 404])
    expect(after.body).toBe('{"pong":true}')
  })

  it('管理员：prefix 路由认子路径但不误配同前缀兄弟路径', async () => {
    // Given 一条 /dshtrading/api 的 prefix 路由
    const host = await startBotHttp()
    const port = host.port
    host.webServer.register({ kind: 'prefix', path: '/dshtrading/api', handler: (_req, res) => { res.writeHead(204); res.end() } })
    // When 请求自身、子路径与同前缀兄弟
    const [self, child, sibling] = await Promise.all([
      call(port, '/dshtrading/api', '127.0.0.1:' + String(port)),
      call(port, '/dshtrading/api/quotes', '127.0.0.1:' + String(port)),
      call(port, '/dshtrading/apix', '127.0.0.1:' + String(port)),
    ])
    // Then 前两者命中（204），兄弟不命中（404）
    expect([self.status, child.status, sibling.status]).toEqual([204, 204, 404])
  })

  it('管理员：路由处理器抛错时回 500 而且服务器不崩', async () => {
    // Given 一条会抛错的路由
    const host = await startBotHttp()
    const port = host.port
    host.webServer.register({ kind: 'exact', path: '/boom', handler: () => { throw new Error('handler exploded') } })
    // When 请求它，再请求健康检查
    const boom = await call(port, '/boom', '127.0.0.1:' + String(port))
    const alive = await call(port, '/healthz', '127.0.0.1:' + String(port))
    // Then 500 带原因，且面仍然可用
    expect(boom.status).toBe(500)
    expect(boom.body).toContain('handler exploded')
    expect(alive.status).toBe(200)
  })
})

describe('bot HTTP 面栅栏（内网不等于可信）', () => {
  it('管理员：非回环 Host 未登记时 403，登记进可信名单后放行', async () => {
    // Given 一个只信任默认回环的面
    const host = await startBotHttp()
    const port = host.port
    const rejected = await call(port, '/healthz', 'evil.example:' + String(port))
    // When 换一个把该 host 记进 trustedHosts 的面（只记 host 时任意端口都算可信）
    const trusting = await startBotHttp(['evil.example'])
    // Then 前者 403，后者放行
    expect(rejected.status).toBe(403)
    const accepted = await call(trusting.port, '/healthz', 'evil.example:' + String(trusting.port))
    expect(accepted.status).toBe(200)
  })

  it('管理员：栅栏面对没有 Host 头的请求直接回 403', async () => {
    // Given 一个绑定的面（栅栏是独立契约面，可直接喂请求形状）
    const host = await startBotHttp()
    // When 用一份没有 host 头的请求形状问栅栏
    const rejection = host.connection.requestRejection({ headers: {} } as IncomingMessage)
    // Then 403（HTTP/1.1 解析层会另行先行拒掉这种请求，两层都不放行）
    expect(rejection).toBe(403)
  })
})

describe('bot HTTP 面判定函数', () => {
  it('管理员：hostnameOf 去掉端口、保留 IPv6 方括号', () => {
    // Given 四种 Host 形态
    // When 取 hostname
    // Then 逐条符合官方 --trusted-host 的 authority 语义
    expect(hostnameOf('127.0.0.1:8899')).toBe('127.0.0.1')
    expect(hostnameOf('[::1]:8899')).toBe('[::1]')
    expect(hostnameOf('localhost')).toBe('localhost')
    expect(hostnameOf(undefined)).toBeUndefined()
  })

  it('管理员：isTrustedHost 认回环字面量与登记 authority，其余拒绝', () => {
    // Given 一份可信名单
    const trusted = ['bot.internal:8899']
    // When 逐个判定
    // Then 回环恒可信、登记项按 host 或 host:port 命中、其它拒绝
    expect(isTrustedHost('127.0.0.1:1', trusted)).toBe(true)
    expect(isTrustedHost('bot.internal:8899', trusted)).toBe(true)
    // 登记项带端口时只匹配该 authority；要放开整个主机就登记不带端口的 host
    expect(isTrustedHost('bot.internal', trusted)).toBe(false)
    expect(isTrustedHost('bot.internal', ['bot.internal'])).toBe(true)
    expect(isTrustedHost('bot.internal:1234', trusted)).toBe(false)
    expect(isTrustedHost(undefined, trusted)).toBe(false)
  })

  it('管理员：routeMatches 区分 exact 与 prefix 边界', () => {
    // Given 两种路由
    // When 对边界路径匹配
    // Then exact 全等、prefix 认自身与子路径
    expect(routeMatches({ kind: 'exact', path: '/a' }, '/a')).toBe(true)
    expect(routeMatches({ kind: 'exact', path: '/a' }, '/a/b')).toBe(false)
    expect(routeMatches({ kind: 'prefix', path: '/a' }, '/a/b')).toBe(true)
    expect(routeMatches({ kind: 'prefix', path: '/a' }, '/ab')).toBe(false)
  })
})
