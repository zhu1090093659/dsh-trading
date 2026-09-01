/**
 * SSE 失效信号端点集成测试（issue #30 / P1，离线）：走真实 apply 路由注册面，
 * 验证——认证栅栏先于流式响应、tradingEvents 缺席 503 降级、事件帧形状
 * （event: store.changed + data JSON）、帧内容随 emit 实时到达。
 */
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply } from '../src/index.ts'
import { TradingEventsService } from '@dsh-trading/eventbus'

interface Route {
  kind: string
  path: string
  handler: (req: Partial<IncomingMessage>, res: Partial<ServerResponse>) => Promise<void>
}

interface FakeRes extends EventEmitter {
  writeHead: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  headers: Record<string, unknown>
  writes: string[]
}

function fakeRes(): FakeRes {
  const res = new EventEmitter() as FakeRes
  res.headers = {}
  res.writes = []
  res.writeHead = vi.fn((_status: number, head: Record<string, unknown>) => { Object.assign(res.headers, head) })
  res.write = vi.fn((chunk: string) => { res.writes.push(chunk) })
  res.end = vi.fn((body?: string) => { if (body !== undefined) res.writes.push(body) })
  return res
}

function makeCtx(options: { rejection?: number; events?: TradingEventsService } = {}): { ctx: never; registered: Route[] } {
  const registered: Route[] = []
  const webCtx = {
    get: (name: string) => (name === 'webServer'
      ? { register: (route: Route) => { registered.push(route) } }
      : name === 'connection'
        ? { requestRejection: () => options.rejection }
        : undefined),
    effect: () => (() => {}),
    tools: { register: () => {}, get: () => undefined },
  }
  const ctx = {
    get: (name: string) => (name === 'tradingEvents' ? options.events : undefined),
    inject: (deps: readonly string[], cb: (scoped: typeof webCtx) => void) => {
      if (deps.includes('webServer') || deps.includes('tools')) cb(webCtx)
    },
    effect: (fn: () => () => void) => { fn() },
  }
  return { ctx: ctx as never, registered }
}

function eventsOf(ctx: never): TradingEventsService {
  return (ctx as unknown as { get: (name: string) => unknown }).get('tradingEvents') as TradingEventsService
}

describe('GET /dshtrading/api/events（SSE 失效信号）', () => {
  it('认证栅栏先于流式响应：未认证 401，不写 event-stream 头', async () => {
    const { ctx, registered } = makeCtx({ rejection: 401 })
    apply(ctx)
    const route = registered[0]
    const res = fakeRes()
    await route.handler({ method: 'GET', url: '/dshtrading/api/events' }, res as never)
    expect(res.headers).toEqual({})
    expect(res.writeHead).toHaveBeenCalledWith(401)
    expect(res.writes.join('')).toBe('unauthorized')
  })

  it('tradingEvents 缺席（老部署）→ 503 JSON，客户端降级一次性 fetch', async () => {
    const { ctx, registered } = makeCtx({})
    apply(ctx)
    const route = registered[0]
    const res = fakeRes()
    await route.handler({ method: 'GET', url: '/dshtrading/api/events' }, res as never)
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.objectContaining({ 'cache-control': 'no-store' }))
    expect(JSON.parse(res.writes.join(''))).toMatchObject({ ok: false, code: 'TRADING_EVENTS_UNAVAILABLE' })
  })

  it('已认证 → event-stream 头 + 连接帧；emit → store.changed 帧实时到达', async () => {
    const events = new TradingEventsService(new CordisContext() as never)
    const { ctx, registered } = makeCtx({ events })
    apply(ctx)
    const route = registered[0]
    expect(route.path).toBe('/dshtrading/api')
    const res = fakeRes()
    await route.handler({ method: 'GET', url: '/dshtrading/api/events' }, res as never)
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(res.writes[0]).toBe(': connected\n\n')
    events.emit('indicators')
    events.emit('knowledge')
    expect(res.writes[1]).toBe('event: store.changed\ndata: {"store":"indicators","revision":1}\n\n')
    expect(res.writes[2]).toBe('event: store.changed\ndata: {"store":"knowledge","revision":1}\n\n')
    // 客户端断开 → 服务端清理（退订 + 停心跳），后续 emit 不再写帧。
    res.emit('close')
    events.emit('strategies')
    expect(res.writes).toHaveLength(3)
  })
})
