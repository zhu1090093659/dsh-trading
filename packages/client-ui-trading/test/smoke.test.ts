/**
 * 冒烟测试：node half 可加载 + /dshtrading/api 路由注册走 webServer
 * 依赖（假件同步解析）。浏览器半不测（构建由
 * tsdown.client.config.mjs 负责，行为需真实宿主验证）。
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply } from '../src/index.ts'

interface Route {
  kind: string
  path: string
  handler: (req: Partial<IncomingMessage>, res: Partial<ServerResponse>) => Promise<void>
}

function makeCtx(options: { rejection?: number } = {}): {
  ctx: never
  registered: Route[]
} {
  const registered: Route[] = []
  const webServer = {
    register: (route: Route) => { registered.push(route) },
  }
  const connection = {
    requestRejection: () => options.rejection,
  }
  const webCtx = {
    get: (name: string) => {
      if (name === 'webServer') return webServer
      if (name === 'connection') return connection
      if (name === 'tradingCryptoMarketData') {
        return {
          getTicker: async (symbol: string) => ({ symbol, price: 42, timestamp: 1 }),
          getKlines: async () => [],
          subscribeTicker: () => ({ dispose() {} }),
        }
      }
      return undefined
    },
    effect: () => (() => {}),
    tools: {
      register: () => {},
      get: () => undefined,
    },
  }
  const ctx = {
    inject: (deps: readonly string[], cb: (scoped: typeof webCtx) => void) => {
      if (deps.includes('webServer')) {
        cb(webCtx)
      } else if (deps.includes('tools')) {
        cb(webCtx)
      }
    },
    effect: (fn: () => () => void) => { fn() },
  }
  return { ctx: ctx as never, registered }
}

describe('@dsh-trading/client-ui-trading node half', () => {
  it('apply 经 ctx.inject 注册 /dshtrading/api 前缀路由', () => {
    const { ctx, registered } = makeCtx()
    apply(ctx)
    expect(registered).toHaveLength(1)
    expect(registered[0]?.kind).toBe('prefix')
    expect(registered[0]?.path).toBe('/dshtrading/api')
  })

  it('/markets 返回已安装市场 JSON（no-store）', async () => {
    const { ctx, registered } = makeCtx()
    apply(ctx)
    const route = registered[0] as Route
    let head: number | undefined
    let headers: Record<string, string> = {}
    let body = ''
    const res = {
      writeHead: (status: number, h: Record<string, string>) => { head = status; headers = h },
      end: (text?: string) => { body = text ?? '' },
    }
    await route.handler({ url: '/dshtrading/api/markets', method: 'GET' } as IncomingMessage, res as unknown as ServerResponse)
    expect(head).toBe(200)
    expect(headers['cache-control']).toBe('no-store')
    expect(JSON.parse(body)).toEqual({ markets: [{ id: 'crypto' }] })
  })

  it('未认证请求被 connection 栅栏拒绝（401，不进桥）', async () => {
    const { ctx, registered } = makeCtx({ rejection: 401 })
    apply(ctx)
    const route = registered[0] as Route
    let head: number | undefined
    let body = ''
    const res = {
      writeHead: (status: number) => { head = status },
      end: (text?: string) => { body = text ?? '' },
    }
    await route.handler({ url: '/dshtrading/api/markets', method: 'GET' } as IncomingMessage, res as unknown as ServerResponse)
    expect(head).toBe(401)
    expect(body).toBe('unauthorized')
  })

  it('未知路径返回 404 BridgeProtocolError JSON', async () => {
    const { ctx, registered } = makeCtx()
    apply(ctx)
    const route = registered[0] as Route
    let head: number | undefined
    let body = ''
    const res = {
      writeHead: (status: number) => { head = status },
      end: (text?: string) => { body = text ?? '' },
    }
    await route.handler({ url: '/dshtrading/api/unknown-path', method: 'GET' } as IncomingMessage, res as unknown as ServerResponse)
    expect(head).toBe(404)
    expect(JSON.parse(body)).toMatchObject({ ok: false, code: 'TRADING_PROTOCOL' })
  })
})
