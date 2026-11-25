/**
 * 运行时网络代理集成测试（真实本地 HTTP 代理、真实本地 SOCKS5 代理、真实目标 HTTP 服务，零 mock）。
 *
 * 验证：
 * - `globalThis.fetch`（含模块初始化阶段已缓存的 `savedFetch`）通过 `undici` 全局 dispatcher 动态走代理；
 * - 支持 HTTP 代理、`socks5h://` 代理（远端域名解析 ATYP=0x03）、`127.0.0.1` 回环直连与 `direct` 热切换；
 * - SOCKS5 模式下环境变量同步写入 `ALL_PROXY`，绝不设置 `NODE_USE_ENV_PROXY=1`；
 * - `testConnectivity` 支持草稿 `override` 探测、异常脱敏与 `dispose()` 恢复。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import {
  DEFAULT_MARKETS,
  NetworkProxyService,
  TRADING_NETWORK_PROXY_KEY,
  apply,
  publishProxyEnv,
  type Config as ConfigType,
} from '../src/index.ts'

// 在任何代理安装前提前捕获 globalThis.fetch 引用，复刻连接器构造期缓存 fetchImpl 的真实行为。
const SAVED_GLOBAL_FETCH = globalThis.fetch

async function startTargetServer(): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = []
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`)
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ ok: true, path: req.url ?? '/' }))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address() as net.AddressInfo
  return {
    url: `http://127.0.0.1:${String(addr.port)}`,
    hits,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
    },
  }
}

async function startHttpProxyServer(targetPort: number): Promise<{
  url: string
  proxiedHosts: string[]
  close: () => Promise<void>
}> {
  const proxiedHosts: string[] = []
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? 'http://invalid/')
    proxiedHosts.push(reqUrl.host)
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: reqUrl.pathname + reqUrl.search,
        headers: { ...req.headers, host: `127.0.0.1:${String(targetPort)}`, connection: 'close' },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, { ...upRes.headers, connection: 'close' })
        upRes.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { connection: 'close' })
      res.end(err.message)
    })
    req.pipe(upstream)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address() as net.AddressInfo
  return {
    url: `http://127.0.0.1:${String(addr.port)}`,
    proxiedHosts,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
    },
  }
}

async function startSocks5ProxyServer(targetPort: number): Promise<{
  url: string
  destinations: string[]
  close: () => Promise<void>
}> {
  const destinations: string[] = []
  const activeSockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    activeSockets.add(client)
    client.on('close', () => { activeSockets.delete(client) })
    let stage: 'greeting' | 'request' | 'tunnel' = 'greeting'
    let buffer = Buffer.alloc(0)

    client.on('data', (chunk) => {
      if (stage === 'tunnel') return
      buffer = Buffer.concat([buffer, chunk])

      if (stage === 'greeting') {
        if (buffer.length < 2) return
        const nMethods = buffer[1] ?? 0
        if (buffer.length < 2 + nMethods) return
        buffer = buffer.subarray(2 + nMethods)
        stage = 'request'
        client.write(Buffer.from([0x05, 0x00]))
      }

      if (stage === 'request') {
        if (buffer.length < 4) return
        const atyp = buffer[3]
        let host = ''
        let portOffset = 0
        if (atyp === 0x01) {
          if (buffer.length < 10) return
          host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`
          portOffset = 8
        } else if (atyp === 0x03) {
          const len = buffer[4] ?? 0
          if (buffer.length < 5 + len + 2) return
          host = buffer.subarray(5, 5 + len).toString('utf8')
          portOffset = 5 + len
        } else {
          client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          return
        }
        const port = buffer.readUInt16BE(portOffset)
        const remainder = buffer.subarray(portOffset + 2)
        destinations.push(`${host}:${String(port)}`)
        stage = 'tunnel'

        const upstream = net.connect(targetPort, '127.0.0.1', () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
          if (remainder.length > 0) upstream.write(remainder)
          client.pipe(upstream)
          upstream.pipe(client)
        })
        activeSockets.add(upstream)
        upstream.on('close', () => { activeSockets.delete(upstream) })
        upstream.on('error', () => { client.destroy() })
        client.on('error', () => { upstream.destroy() })
      }
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address() as net.AddressInfo
  return {
    url: `socks5h://127.0.0.1:${String(addr.port)}`,
    destinations,
    close: async () => {
      for (const s of activeSockets) s.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
    },
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()
    if (fn) await fn()
  }
})

describe('NetworkProxyService 运行时代理与热切换', () => {
  it('用户：默认 system 模式下通过系统 HTTP 代理转发预缓存的 globalThis.fetch，回环 127.0.0.1 保持直连', async () => {
    // Given: 真实目标服务与真实本地 HTTP 代理；router 在 system 模式下检测到该系统代理
    const target = await startTargetServer()
    cleanups.push(target.close)
    const targetPort = Number(new URL(target.url).port)
    const proxy = await startHttpProxyServer(targetPort)
    cleanups.push(proxy.close)

    const envBox: Record<string, string | undefined> = {}
    const svc = new NetworkProxyService(new CordisContext() as never, {
      env: envBox,
      detectSystem: () => ({ source: 'macos-scutil', httpProxy: proxy.url, httpsProxy: proxy.url }),
    })
    cleanups.push(() => svc.dispose())

    // When: 安装默认 system 模式并先后请求非回环域名（由代理转回 target）与 127.0.0.1
    const snap = await svc.applyConfig({ mode: 'system' })
    const viaProxyRes = await SAVED_GLOBAL_FETCH('http://nonexistent.trading-proxy.test/ping', {
      headers: { connection: 'close' },
    })
    const viaProxyJson = await viaProxyRes.json() as { ok: boolean; path: string }
    const directRes = await SAVED_GLOBAL_FETCH(`${target.url}/local`, {
      headers: { connection: 'close' },
    })
    const directJson = await directRes.json() as { ok: boolean; path: string }

    // Then: 域名请求经过 HTTP 代理，127.0.0.1 直连不进代理，环境变量同步设置
    expect(snap.active).toBe(true)
    expect(snap.source).toBe('macos-scutil')
    expect(viaProxyJson).toEqual({ ok: true, path: '/ping' })
    expect(proxy.proxiedHosts).toEqual(['nonexistent.trading-proxy.test'])
    expect(directJson).toEqual({ ok: true, path: '/local' })
    expect(target.hits).toEqual(['GET /ping', 'GET /local'])
    expect(envBox.HTTP_PROXY).toBe(proxy.url)
    expect(envBox.NODE_USE_ENV_PROXY).toBe('1')
  })

  it('用户：自定义 socks5h:// 代理转发请求且热切换到 direct 后停止走代理并恢复 env', async () => {
    // Given: 真实目标服务与真实 SOCKS5 代理；初始配置为 custom socks5h://
    const target = await startTargetServer()
    cleanups.push(target.close)
    const targetPort = Number(new URL(target.url).port)
    const socks = await startSocks5ProxyServer(targetPort)
    cleanups.push(socks.close)

    const envBox: Record<string, string | undefined> = { HTTP_PROXY: 'http://127.0.0.1:9999' }
    const origDispatcher = getGlobalDispatcher()
    const svc = new NetworkProxyService(new CordisContext() as never, {
      env: envBox,
      detectSystem: () => ({ source: 'none' }),
    })
    cleanups.push(async () => {
      await svc.dispose()
      setGlobalDispatcher(origDispatcher)
    })

    // When: 先切到 socks5h:// 自定义代理发出请求，再热切换到 direct
    const customSnap = await svc.applyConfig({ mode: 'custom', url: socks.url })
    const res = await SAVED_GLOBAL_FETCH('http://socks-remote.trading.test/quote', {
      headers: { connection: 'close' },
    })
    const body = await res.json() as { ok: boolean; path: string }

    // Then: 请求经 SOCKS5 远端域名通道到达目标；SOCKS5 模式下绝不设 NODE_USE_ENV_PROXY=1
    expect(customSnap.active).toBe(true)
    expect(customSnap.source).toBe('custom')
    expect(body).toEqual({ ok: true, path: '/quote' })
    expect(socks.destinations).toEqual(['socks-remote.trading.test:80'])
    expect(envBox.ALL_PROXY).toBe(socks.url)
    expect(envBox.HTTP_PROXY).toBeUndefined()
    expect(envBox.NODE_USE_ENV_PROXY).toBeUndefined()

    // When: 热切换为 direct 并随后 dispose
    const directSnap = await svc.applyConfig({ mode: 'direct' })
    expect(directSnap.active).toBe(false)
    expect(directSnap.source).toBe('direct')
    expect(envBox.ALL_PROXY).toBeUndefined()
    expect(envBox.HTTP_PROXY).toBeUndefined()

    await svc.dispose()
    // Then: 原环境与原 dispatcher 完整恢复
    expect(envBox.HTTP_PROXY).toBe('http://127.0.0.1:9999')
    expect(getGlobalDispatcher()).toBe(origDispatcher)
  })

  it('用户：testConnectivity 支持草稿 override 探测、坏自定义 URL 速败与凭据脱敏', async () => {
    // Given: 真实目标与 HTTP 代理；targetUrlResolver 指向受控白名单别名
    const target = await startTargetServer()
    cleanups.push(target.close)
    const targetPort = Number(new URL(target.url).port)
    const proxy = await startHttpProxyServer(targetPort)
    cleanups.push(proxy.close)
    const authedProxyUrl = proxy.url.replace('http://', 'http://alice:s3cret@')

    const svc = new NetworkProxyService(new CordisContext() as never, {
      env: {},
      detectSystem: () => ({ source: 'none' }),
      getDispatcher: () => new Agent(),
      setDispatcher: () => {},
      targetUrlResolver: () => 'http://connectivity.trading.test/ping',
    })
    cleanups.push(() => svc.dispose())

    // When: 用带凭据的草稿 override 探测 okx，并测试空自定义地址
    const okRes = await svc.testConnectivity({
      target: 'okx',
      override: { mode: 'custom', url: authedProxyUrl },
    })
    const badRes = await svc.testConnectivity({
      target: 'binance',
      override: { mode: 'custom', url: '' },
    })

    // Then: 成功响应走代理且密码脱敏；空自定义地址直接失败不假装直连成功
    expect(okRes.ok).toBe(true)
    expect(okRes.status).toBe(200)
    expect(okRes.proxied).toBe(true)
    expect(okRes.proxy).toBe(proxy.url.replace('http://', 'http://***@'))
    expect(okRes.proxy).not.toContain('s3cret')
    expect(badRes.ok).toBe(false)
    expect(badRes.error).toContain('without a proxy URL')
  })

  it('用户：refreshSystemProxy 重新探测系统代理，publishProxyEnv 保持变量集合一致性', async () => {
    // Given: 初始无系统代理的服务，随后系统代理开启
    let detected = { source: 'none' as const } as { source: 'none' | 'linux-gsettings'; httpProxy?: string; httpsProxy?: string }
    const envBox: Record<string, string | undefined> = {}
    const svc = new NetworkProxyService(new CordisContext() as never, {
      env: envBox,
      detectSystem: () => detected,
      getDispatcher: () => new Agent(),
      setDispatcher: () => {},
    })
    cleanups.push(() => svc.dispose())

    await svc.applyConfig({ mode: 'system' })
    expect(svc.snapshot().active).toBe(false)

    // When: 系统代理切换并调用 refreshSystemProxy
    detected = { source: 'linux-gsettings', httpProxy: 'http://127.0.0.1:7890', httpsProxy: 'http://127.0.0.1:7890' }
    const refreshed = await svc.refreshSystemProxy()
    // Then: 状态立即更新且环境变量写入
    expect(refreshed.active).toBe(true)
    expect(refreshed.source).toBe('linux-gsettings')
    expect(envBox.https_proxy).toBe('http://127.0.0.1:7890')

    // When: 直接验证 publishProxyEnv 在 direct 模式清理全部变量
    publishProxyEnv({ mode: 'direct', source: 'direct', noProxy: 'localhost', diagnostics: [] }, envBox, {})
    expect(envBox.https_proxy).toBeUndefined()
    expect(envBox.NODE_USE_ENV_PROXY).toBeUndefined()
  })

  it('用户：router apply() 挂载 tradingNetworkProxy 服务并随 volatile-update 读取最新 proxyConfig', () => {
    // Given: Cordis Context + volatile 配置引用
    const ctx = new CordisContext()
    let current: ConfigType = { markets: { ...DEFAULT_MARKETS } }
    const ref = { get: () => current }
    let volatileUpdate: (() => void) | undefined
    ;(ctx as unknown as { on: (event: string, cb: () => void) => void }).on = (event, cb) => {
      if (event === 'loader/volatile-update') volatileUpdate = cb
    }
    // When: 挂载 router 插件后通过 volatile-update 变更 proxy
    apply(ctx as never, ref as never)
    const router = (ctx as unknown as { get: (k: string) => { proxyConfig(): unknown } | undefined }).get('tradingMarketRouter')
    const proxySvc = (ctx as unknown as { get: (k: string) => NetworkProxyService | undefined }).get(TRADING_NETWORK_PROXY_KEY)
    expect(router?.proxyConfig()).toEqual({ mode: 'system' })
    expect(proxySvc).toBeInstanceOf(NetworkProxyService)

    current = { markets: { ...DEFAULT_MARKETS }, proxy: { mode: 'custom', url: 'http://127.0.0.1:7890', noProxy: 'a.local' } }
    volatileUpdate?.()
    // Then: 路由服务实时读到更新后的 proxyConfig
    expect(router?.proxyConfig()).toEqual({ mode: 'custom', url: 'http://127.0.0.1:7890', noProxy: 'a.local' })
  })
})
