/**
 * 设置页网络代理控制面与宿主 HTTP 桥（/dshtrading/api/proxy/*）单测。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { NetworkProxyService, TRADING_NETWORK_PROXY_KEY } from '@dshtrading/router'
import { apply, createProxyRouteHandler } from '../src/index.js'
import {
  projectSnapshot,
  redactClientProxyUrl,
  validateCustomProxyUrl,
  type TradingSettings,
} from '../src/client/trading-settings-controller.js'

interface FakeResponseResult {
  status: number
  headers: Record<string, string>
  body: string
}

function makeFakeReq(method: string, path: string, rawBody?: string): IncomingMessage {
  const req = Readable.from(rawBody !== undefined ? [Buffer.from(rawBody, 'utf8')] : [])
  return Object.assign(req, { method, url: path }) as unknown as IncomingMessage
}

function makeFakeRes(): { res: ServerResponse; done: Promise<FakeResponseResult> } {
  let status = 200
  let headers: Record<string, string> = {}
  const chunks: Buffer[] = []
  let resolveDone!: (value: FakeResponseResult) => void
  const done = new Promise<FakeResponseResult>((resolve) => { resolveDone = resolve })

  const res = {
    writableEnded: false,
    destroyed: false,
    writeHead(code: number, hdrs?: Record<string, string>) {
      status = code
      headers = { ...(hdrs ?? {}) }
      return res
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'))
      }
      res.writableEnded = true
      resolveDone({ status, headers, body: Buffer.concat(chunks).toString('utf8') })
      return res
    },
  } as unknown as ServerResponse

  return { res, done }
}

describe('settings controller 代理字段投影与客户端校验', () => {
  it('用户：默认缺少 proxy 字段时投射为 system 模式，user 覆盖后准确回显', () => {
    // Given: 默认配置与用户覆写 custom 配置
    const baseSnap = {
      status: 'ready',
      value: { markets: { crypto: { provider: 'binance' } } } as TradingSettings,
      base: { markets: { crypto: { provider: 'binance' } } },
      user: {},
      revision: 1,
      writable: true,
    }
    const customSnap = {
      status: 'ready',
      value: {
        markets: { crypto: { provider: 'binance' } },
        proxy: { mode: 'custom', url: 'socks5://127.0.0.1:1080', noProxy: '.internal' },
      } as TradingSettings,
      base: { markets: { crypto: { provider: 'binance' } } },
      user: { proxy: { mode: 'custom', url: 'socks5://127.0.0.1:1080', noProxy: '.internal' } },
      revision: 2,
      writable: true,
    }
    // When: 投射状态
    const defState = projectSnapshot(baseSnap as never)
    const ovrState = projectSnapshot(customSnap as never)
    // Then: 默认 mode=system 且 overridden=false；覆写后完整回显且 overridden=true
    expect(defState.proxyMode).toBe('system')
    expect(defState.proxyUrl).toBe('')
    expect(defState.proxyOverridden).toBe(false)
    expect(ovrState.proxyMode).toBe('custom')
    expect(ovrState.proxyUrl).toBe('socks5://127.0.0.1:1080')
    expect(ovrState.proxyNoProxy).toBe('.internal')
    expect(ovrState.proxyOverridden).toBe(true)
  })

  it('用户：validateCustomProxyUrl 与 redactClientProxyUrl 在浏览器端校验和脱敏代理地址', () => {
    // Given: 合法与非法 URL 字符串
    // When/Then: 校验各错误分支并脱敏密码
    expect(validateCustomProxyUrl('')).toBe('empty')
    expect(validateCustomProxyUrl('socks4://127.0.0.1:1080')).toBe('socks4')
    expect(validateCustomProxyUrl('ftp://127.0.0.1:21')).toBe('unsupported')
    expect(validateCustomProxyUrl('not-a-url')).toBe('invalid')
    expect(validateCustomProxyUrl('http://:7890')).toBe('invalid')
    expect(validateCustomProxyUrl('socks5h://u:p@127.0.0.1:7890')).toBeUndefined()
    expect(redactClientProxyUrl('http://alice:secret@127.0.0.1:7890')).toBe('http://***@127.0.0.1:7890')
    expect(redactClientProxyUrl('  ')).toBeUndefined()
  })
})

describe('/dshtrading/api/proxy 宿主路由', () => {
  it('用户：未认证请求被 connection 栅栏拒绝（401），服务缺席返回 503', async () => {
    // Given: 分别配置拒绝鉴权与缺服务的路由处理器
    const unauthHandler = createProxyRouteHandler({
      connection: { requestRejection: () => 401 },
      getProxyService: () => undefined,
    })
    const noServiceHandler = createProxyRouteHandler({
      connection: { requestRejection: () => undefined },
      getProxyService: () => undefined,
    })
    // When: 发送 GET /dshtrading/api/proxy/status
    const r1 = makeFakeRes()
    await unauthHandler(makeFakeReq('GET', '/dshtrading/api/proxy/status'), r1.res)
    const res1 = await r1.done

    const r2 = makeFakeRes()
    await noServiceHandler(makeFakeReq('GET', '/dshtrading/api/proxy/status'), r2.res)
    const res2 = await r2.done
    // Then: 分别返回 401 与 503
    expect(res1.status).toBe(401)
    expect(res2.status).toBe(503)
    expect(JSON.parse(res2.body)).toMatchObject({ ok: false, code: 'PROXY_UNAVAILABLE' })
  })

  it('用户：GET /status 与 ?refresh=1 返回脱敏代理状态，POST /test 探测白名单目标并拦非法 target', async () => {
    // Given: 挂载了真实 NetworkProxyService（注入可控系统探测与 fetch）的路由处理器
    let probeCalls = 0
    const service = new NetworkProxyService(new CordisContext() as never, {
      env: {},
      detectSystem: () => {
        probeCalls += 1
        return {
          source: 'macos-scutil',
          httpProxy: 'http://alice:s3cret@127.0.0.1:7890',
          httpsProxy: 'http://alice:s3cret@127.0.0.1:7890',
        }
      },
      getDispatcher: () => ({} as never),
      setDispatcher: () => {},
      fetchImpl: (async () => new Response('0', { status: 200 })) as never,
    })
    await service.applyConfig({ mode: 'system' })
    const handler = createProxyRouteHandler({
      connection: { requestRejection: () => undefined },
      getProxyService: () => service,
    })

    // When: 查询状态、刷新系统代理、测有效 target、测非法 target
    const s1 = makeFakeRes()
    await handler(makeFakeReq('GET', '/dshtrading/api/proxy/status'), s1.res)
    const statusRes = JSON.parse((await s1.done).body) as { ok: boolean; httpsProxy: string }

    const s2 = makeFakeRes()
    await handler(makeFakeReq('GET', '/dshtrading/api/proxy/status?refresh=1'), s2.res)
    await s2.done

    const tOk = makeFakeRes()
    await handler(
      makeFakeReq('POST', '/dshtrading/api/proxy/test', JSON.stringify({
        target: 'binance',
        override: { mode: 'custom', url: 'socks5://127.0.0.1:1080' },
      })),
      tOk.res,
    )
    const testOkRes = await tOk.done

    const tBad = makeFakeRes()
    await handler(
      makeFakeReq('POST', '/dshtrading/api/proxy/test', JSON.stringify({ target: 'http://169.254.169.254/latest' })),
      tBad.res,
    )
    const testBadRes = await tBad.done

    const tHuge = makeFakeRes()
    await handler(
      makeFakeReq('POST', '/dshtrading/api/proxy/test', JSON.stringify({ pad: 'x'.repeat(17 * 1024) })),
      tHuge.res,
    )
    const testHugeRes = await tHuge.done

    const notFound = makeFakeRes()
    await handler(makeFakeReq('GET', '/dshtrading/api/proxy/unknown'), notFound.res)
    const notFoundRes = await notFound.done

    // Then: 状态脱敏密码；refresh 重新触发探测；白名单探测 200，SSRF URL 400，超大包 413，未知路由 404
    expect(statusRes.ok).toBe(true)
    expect(statusRes.httpsProxy).toBe('http://***@127.0.0.1:7890')
    expect(probeCalls).toBe(2)
    expect(testOkRes.status).toBe(200)
    expect(JSON.parse(testOkRes.body)).toMatchObject({ ok: true, target: 'binance', proxied: true })
    expect(testBadRes.status).toBe(400)
    expect(JSON.parse(testBadRes.body)).toMatchObject({ ok: false, code: 'PROXY_TEST_INVALID_TARGET' })
    expect(testHugeRes.status).toBe(413)
    expect(notFoundRes.status).toBe(404)
    await service.dispose()
  })

  it('用户：apply() 向 webServer 注册 /dshtrading/api/proxy 前缀路由并支持清理', () => {
    // Given: 模拟 web 宿主 inject 环境
    const routes: Array<{ path: string; kind: string }> = []
    let cleaned = false
    const fakeService = { snapshot: () => ({}) }
    const ctx = {
      get: (key: string) => (key === TRADING_NETWORK_PROXY_KEY ? fakeService : undefined),
      inject: (_deps: readonly string[], cb: (webCtx: unknown) => void) => {
        cb({
          get: (key: string) => {
            if (key === 'webServer') return { register: (r: { path: string; kind: string }) => { routes.push(r); return () => { cleaned = true } } }
            if (key === 'connection') return { requestRejection: () => undefined }
            return undefined
          },
          effect: (fn: () => () => void) => {
            const dispose = fn()
            dispose()
          },
        })
      },
    }
    // When: 执行插件 apply
    apply(ctx as never)
    // Then: 注册了 /dshtrading/api/proxy 前缀路由且注销钩子正常执行
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: '/dshtrading/api/proxy' })
    expect(cleaned).toBe(true)
  })
})
