/**
 * 路由 handler 契约测试：browser-auth 栅栏、多机器人代理、Bearer 鉴权注入、
 * x-dsht-caps 动作头注入、POST commands 转发。
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { MOUNT, ALL_ACTION_CAPS, createRouteHandler, type Config } from '../src/index.ts'

const TEST_CONFIG: Config = {
  bots: [
    { name: 'alpha', baseUrl: 'http://127.0.0.1:3901', deviceId: 'dev-1', secret: 'sec-1' },
    { name: 'beta', baseUrl: 'http://127.0.0.1:3902', deviceId: 'dev-2', secret: 'sec-2' },
  ],
  timeoutMs: 5_000,
}

function fakeRes() {
  const state = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      if (headers) Object.assign(state.headers, headers)
      return res
    },
    end(chunk?: string) {
      state.body = chunk ?? ''
      return res
    },
  } as unknown as ServerResponse
  return { res, state, json: () => JSON.parse(state.body) as Record<string, unknown> }
}

function fakeReq(method: string, sub: string, body?: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, {
    method,
    url: MOUNT + sub,
    headers: { host: '127.0.0.1' },
  })
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(body, 'utf8'))
      req.emit('end')
    })
  }
  return req
}

describe('机器人控制台 node 桥路由与鉴权', () => {
  it('访客未通过宿主 connection 栅栏时直接被拒且不触网', async () => {
    // Given: connection 判定 401
    const connection = { requestRejection: () => 401 }
    let fetched = false
    const fetchImpl = (async () => {
      fetched = true
      return new Response('{}')
    }) as typeof globalThis.fetch

    const handler = createRouteHandler(TEST_CONFIG, connection, fetchImpl)
    const { res, state } = fakeRes()

    // When: 请求 cards 路由
    await handler(fakeReq('GET', '/alpha/cards'), res)

    // Then: 401 拦截，上游未请求
    expect(state.status).toBe(401)
    expect(fetched).toBe(false)
  })

  it('用户请求 status 时返回机器人列表与配置状态', async () => {
    // Given: 已配置两台机器人
    const handler = createRouteHandler(TEST_CONFIG)
    const { res, state, json } = fakeRes()

    // When: 请求 /status
    await handler(fakeReq('GET', '/status'), res)

    // Then: 返回机器人摘要
    expect(state.status).toBe(200)
    const body = json()
    expect(body.bots).toEqual([
      { name: 'alpha', configured: true },
      { name: 'beta', configured: true },
    ])
    expect(body.activeBot).toBe('alpha')
  })

  it('用户访问未配置的机器人名称返回 404', async () => {
    // Given: 配置只有 alpha 和 beta
    const handler = createRouteHandler(TEST_CONFIG)
    const { res, state, json } = fakeRes()

    // When: 请求未登记的 gamma 机器人
    await handler(fakeReq('GET', '/gamma/cards'), res)

    // Then: 404 BOT_NOT_FOUND
    expect(state.status).toBe(404)
    expect(json().code).toBe('BOT_NOT_FOUND')
  })

  it('用户请求 alpha 的 cards 时携带 Bearer 令牌与 x-dsht-caps 头', async () => {
    // Given: fake 上游
    let capturedUrl = ''
    let capturedHeaders: HeadersInit | undefined
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedHeaders = init?.headers
      return new Response(JSON.stringify({ cards: [{ cardId: 'c1', cardType: 'desk-summary' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch

    const handler = createRouteHandler(TEST_CONFIG, undefined, fetchImpl)
    const { res, state, json } = fakeRes()

    // When: GET /alpha/cards
    await handler(fakeReq('GET', '/alpha/cards'), res)

    // Then: 正确转发到 http://127.0.0.1:3901/v1/cards，携带 Bearer 认证与全部 12 项 action caps
    expect(state.status).toBe(200)
    expect(capturedUrl).toBe('http://127.0.0.1:3901/v1/cards')
    const headers = capturedHeaders as Record<string, string>
    expect(headers['authorization']).toBe('Bearer dev-1.sec-1')
    expect(headers['x-dsht-caps']).toBe(ALL_ACTION_CAPS)
    expect(json().cards).toHaveLength(1)
  })

  it('用户向 beta 发送 commands 时通过 POST 转发 body 与 Bearer', async () => {
    // Given: fake 上游
    let capturedUrl = ''
    let capturedMethod = ''
    let capturedBody = ''
    let capturedHeaders: HeadersInit | undefined

    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedMethod = init?.method ?? ''
      capturedBody = String(init?.body ?? '')
      capturedHeaders = init?.headers
      return new Response(JSON.stringify({ ok: true, action: 'pause' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch

    const handler = createRouteHandler(TEST_CONFIG, undefined, fetchImpl)
    const { res, state, json } = fakeRes()
    const payload = JSON.stringify({ clientRequestId: 'req-1', action: 'pause', params: {} })

    // When: POST /beta/commands
    await handler(fakeReq('POST', '/beta/commands', payload), res)

    // Then: 正确转发到 http://127.0.0.1:3902/v1/commands
    expect(state.status).toBe(200)
    expect(capturedUrl).toBe('http://127.0.0.1:3902/v1/commands')
    expect(capturedMethod).toBe('POST')
    expect(capturedBody).toBe(payload)
    const headers = capturedHeaders as Record<string, string>
    expect(headers['authorization']).toBe('Bearer dev-2.sec-2')
    expect(headers['x-dsht-caps']).toBe(ALL_ACTION_CAPS)
    expect(json().ok).toBe(true)
  })

  it('用户向上游请求遇到故障或超时时收到 502 错误', async () => {
    // Given: fetch 抛出异常
    const fetchImpl = (async () => {
      throw new Error('Connection refused')
    }) as typeof globalThis.fetch

    const handler = createRouteHandler(TEST_CONFIG, undefined, fetchImpl)
    const { res, state, json } = fakeRes()

    // When: 请求 cards
    await handler(fakeReq('GET', '/alpha/cards'), res)

    // Then: 502 UPSTREAM_GATEWAY_ERROR
    expect(state.status).toBe(502)
    expect(json().code).toBe('UPSTREAM_GATEWAY_ERROR')
  })
})
