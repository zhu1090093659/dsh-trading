/**
 * 路由 handler 契约测试：browser-auth 栅栏、白名单子路由、参数校验、
 * 错误映射与 /status 不回显密码。零 mock：req/res 为最小契约 fake，
 * FinanceClient 以注入 fetch 的 fake 上游落地。
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { FinanceClient } from '../src/finance-client.ts'
import { MOUNT, ROUTES, createRouteHandler, type Config } from '../src/index.ts'

const BASE_CONFIG: Config = {
  baseUrl: 'https://finance.example.test',
  username: 'api',
  password: 'secret',
  usernameEnv: 'FINANCE_API_USER',
  passwordEnv: 'FINANCE_API_PASSWORD',
  timeoutMs: 5_000,
  snapshotCacheMs: 60_000,
  historyCacheMs: 300_000,
}

/** 最小契约 fake res：捕获状态行与 JSON 负载。 */
function fakeRes() {
  const state = { status: 0, body: '' }
  const res = {
    writeHead(status: number) { state.status = status; return res },
    end(chunk?: string) { state.body = chunk ?? ''; return res },
  } as unknown as ServerResponse
  return { res, state, json: () => JSON.parse(state.body) as Record<string, unknown> }
}

function fakeReq(method: string, sub: string): IncomingMessage {
  return { method, url: MOUNT + sub, headers: { host: '127.0.0.1' } } as unknown as IncomingMessage
}

function makeHandler(overrides: {
  rejection?: number
  password?: string
  upstreamBody?: unknown
  upstreamStatus?: number
  upstreamBodies?: unknown[]
  now?: () => number
}) {
  const calls: string[] = []
  let call = 0
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input))
    const bodies = overrides.upstreamBodies
    const body = bodies === undefined ? overrides.upstreamBody ?? { ready: true } : bodies[Math.min(call, bodies.length - 1)]
    call += 1
    return new Response(JSON.stringify(body), {
      status: overrides.upstreamStatus ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  const client = new FinanceClient({
    baseUrl: BASE_CONFIG.baseUrl,
    username: () => 'api',
    password: () => overrides.password ?? 'secret',
    fetchImpl,
    now: overrides.now,
  })
  const connection = { requestRejection: () => overrides.rejection }
  const handler = createRouteHandler(client, BASE_CONFIG, connection)
  return { handler, calls }
}

describe('特殊指标桥路由栅栏', () => {
  it('访客未过浏览器认证时被栅栏拒绝且零上游调用', async () => {
    // Given: connection 判定 401
    const { handler, calls } = makeHandler({ rejection: 401 })
    const { res, state } = fakeRes()
    // When: 访客请求数据路由
    await handler(fakeReq('GET', '/basis/snapshot'), res)
    // Then: 401 直出，不触网（未认证流量绝不穿透到自有服务）
    expect(state.status).toBe(401)
    expect(calls.length).toBe(0)
  })

  it('用户访问白名单外路径得到 404 业务码', async () => {
    // Given: 已通过栅栏
    const { handler } = makeHandler({ rejection: undefined })
    const { res, state, json } = fakeRes()
    // When: 用户请求未登记子路径
    await handler(fakeReq('GET', '/admin/dump'), res)
    // Then: 404 + ROUTE_NOT_FOUND（固定白名单，非通用代理）
    expect(state.status).toBe(404)
    expect(json().code).toBe('SPECIAL_INDICATORS_ROUTE_NOT_FOUND')
  })

  it('用户查询 status 时回显配置面但不回显密码', async () => {
    // Given: 已配置凭据
    const { handler } = makeHandler({})
    const { res, state, json } = fakeRes()
    // When: 用户查询 /status
    await handler(fakeReq('GET', '/status'), res)
    // Then: configured=true、baseUrl 可见，负载任何字段都不含密码值
    expect(state.status).toBe(200)
    expect(json().configured).toBe(true)
    expect(JSON.stringify(json())).not.toContain('secret')
  })
})

describe('特殊指标桥子路由映射', () => {
  it('用户请求恐慌指数快照时上游固定 market=cn 与 methodology=2', async () => {
    // Given: 已通过栅栏
    const { handler, calls } = makeHandler({})
    const { res, state } = fakeRes()
    // When: 用户请求情绪快照
    await handler(fakeReq('GET', '/sentiment/snapshot'), res)
    // Then: 上游路径固定方法学参数（docs/api.md：调用方应固定方法，避免历史拼接混用）
    expect(state.status).toBe(200)
    expect(calls[0]).toBe('https://finance.example.test/api/sentiment/snapshot?market=cn&methodology=2')
  })

  it('用户请求基差历史时 days 被夹取到 10–500 的服务端边界', async () => {
    // Given: 已通过栅栏
    const { handler, calls } = makeHandler({})
    const { res } = fakeRes()
    // When: 用户请求 days=9999 的历史
    await handler(fakeReq('GET', '/basis/history?days=9999'), res)
    // Then: 上游 days=500（夹取上限，下游无法放大抓取面）
    expect(calls[0]).toBe('https://finance.example.test/api/v2/basis/history?days=500')
  })

  it('用户传入非法板块代码时得到 400 且不触网', async () => {
    // Given: 已通过栅栏
    const { handler, calls } = makeHandler({})
    const { res, state, json } = fakeRes()
    // When: 用户请求带路径注入意图的板块代码
    await handler(fakeReq('GET', '/sectors/detail?code=../../etc'), res)
    // Then: 400 + BAD_PARAMS，零上游调用
    expect(state.status).toBe(400)
    expect(json().code).toBe('SPECIAL_INDICATORS_BAD_PARAMS')
    expect(calls.length).toBe(0)
  })

  it('用户未配置凭据时数据路由回 NOT_CONFIGURED 业务码', async () => {
    // Given: 凭据链为空
    const { handler } = makeHandler({ password: '' })
    const { res, json } = fakeRes()
    // When: 用户请求数据
    await handler(fakeReq('GET', '/basis/snapshot'), res)
    // Then: 业务码 NOT_CONFIGURED（前端据此渲染设置引导，而非裸错误）
    expect(json().code).toBe('FINANCE_NOT_CONFIGURED')
  })

  it('用户遭遇上游 401 时桥回 502 + FINANCE_AUTH_FAILED', async () => {
    // Given: 上游一律 401
    const { handler } = makeHandler({ upstreamStatus: 401, upstreamBody: 'unauthorized' })
    const { res, state, json } = fakeRes()
    // When: 用户请求数据
    await handler(fakeReq('GET', '/basis/snapshot'), res)
    // Then: 502（上游侧失败）+ 认证失败业务码
    expect(state.status).toBe(502)
    expect(json().code).toBe('FINANCE_AUTH_FAILED')
  })
})

describe('特殊指标桥陈旧回源', () => {
  it('用户在缓存窗口内请求时桥直回缓存且不附加 stale 标记', async () => {
    // Given: 可控时钟 + 首拉已落地
    let clock = 1_000_000
    const { handler } = makeHandler({ now: () => clock })
    const first = fakeRes()
    await handler(fakeReq('GET', '/basis/snapshot'), first.res)
    // When: 用户在窗口内再次请求
    clock += 30_000
    const { res, state, json } = fakeRes()
    await handler(fakeReq('GET', '/basis/snapshot'), res)
    // Then: 信封恰好为 ok+data，无 stale 标记（fresh 缓存不误报滞后）
    expect(state.status).toBe(200)
    expect(json()).toEqual({ ok: true, data: { ready: true } })
    expect(first.json().stale).toBeUndefined()
  })

  it('用户在缓存窗口外请求时桥立即回陈旧缓存并带 stale 标记', async () => {
    // Given: 可控时钟 + 上游两拍负载（第二拍供后台再验证）
    let clock = 1_000_000
    const { handler, calls } = makeHandler({
      now: () => clock,
      upstreamBodies: [{ ready: true }, { ready: 'refreshed' }],
    })
    await handler(fakeReq('GET', '/basis/snapshot'), fakeRes().res)
    // When: 用户推进时钟出窗后再请求
    clock += 61_000
    const { res, state, json } = fakeRes()
    await handler(fakeReq('GET', '/basis/snapshot'), res)
    // Then: 立即 200 陈旧负载 + stale 标记；后台再验证已同步并发发起
    expect(state.status).toBe(200)
    expect(json()).toEqual({ ok: true, data: { ready: true }, stale: true })
    expect(calls.length).toBe(2)
  })
})

describe('子路由白名单完整性', () => {
  it('运营核对四组指标各至少一条路由且全部只读 GET 语义', () => {
    // Given: 路由表
    const subs = ROUTES.map((r) => r.sub)
    // When: 按指标域分组
    const groups = ['basis', 'sentiment', 'hk-short', 'sectors'].map((g) => subs.filter((s) => s.startsWith('/' + g)))
    // Then: 四组全覆盖，且所有 upstream 生成器产出 /api/ 前缀只读路径
    for (const g of groups) expect(g.length).toBeGreaterThan(0)
    for (const route of ROUTES) {
      const upstream = route.upstream(new URL('http://dsh.local' + MOUNT + route.sub + '?days=30&window=5&code=801738'))
      expect(upstream === null || upstream.startsWith('/api/')).toBe(true)
    }
  })
})
