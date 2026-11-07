import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as rootEntry from '../src/index.js'
import { apply, Config, createTokenProvider, inject, name } from '../src/plugin.js'

describe('包入口（loader 解析面）', () => {
  // 回归：patch 行按包名解析到 lib/index.js，loader 只从该入口读 name/inject/Config/apply。
  // 2026-09-13 桌面壳实测：入口漏 inject → 宿主整棵树加载失败（cannot get property "tools" without inject）。
  it('根入口重导出 name/inject/Config/apply', () => {
    expect(rootEntry.name).toBe('dsh-trading-connector-jin10')
    expect(rootEntry.inject).toEqual(['tools'])
    expect(rootEntry.Config).toBeDefined()
    expect(typeof rootEntry.apply).toBe('function')
    expect(inject).toEqual(['tools'])
  })
})

function fakeCtx(options: { credential?: Record<string, string> } = {}) {
  const registered = new Map<string, { name: string }>()
  const ctx = {
    tools: {
      register: (definition: { name: string }) => { registered.set(definition.name, definition) },
      get: (toolName: string) => registered.get(toolName),
    },
    reflect: { provide: () => {} },
    get: (key: string) => key === 'tradingMarketRouter'
      ? { getCredential: (provider: string) => (provider === 'jin10' ? options.credential : undefined) }
      : undefined,
  } as unknown as Context
  return { ctx, registered }
}

afterEach(() => { delete process.env.JIN10_MCP_TOKEN })

describe('connector-jin10 插件行', () => {
  it('插件名与 patch 行 id 一致', () => {
    expect(name).toBe('dsh-trading-connector-jin10')
  })

  it('apply 注册全部 10 个工具，重名不覆盖（先到先得）', () => {
    const { ctx, registered } = fakeCtx()
    registered.set('flash_list', { name: 'flash_list' })
    apply(ctx, { ...Config({}), enabled: true })
    expect(registered.size).toBe(10)
    expect([...registered.keys()].sort()).toEqual([
      'econ_calendar', 'flash_list', 'flash_search', 'global_instruments', 'global_klines',
      'global_quote', 'macro_rates', 'news_get', 'news_list', 'news_search',
    ])
  })

  it('enabled=false 时零注册（静默关闭语义）', () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx, { ...Config({}), enabled: false })
    expect(registered.size).toBe(0)
  })

  it('凭证解析：设置中心 credentials.jin10.token 优先，环境变量兜底，缺省 undefined', () => {
    process.env.JIN10_MCP_TOKEN = 'sk-env'
    const settings = fakeCtx({ credential: { token: 'sk-settings' } })
    expect(createTokenProvider(settings.ctx, 'JIN10_MCP_TOKEN')()).toBe('sk-settings')

    const envOnly = fakeCtx()
    expect(createTokenProvider(envOnly.ctx, 'JIN10_MCP_TOKEN')()).toBe('sk-env')

    delete process.env.JIN10_MCP_TOKEN
    expect(createTokenProvider(envOnly.ctx, 'JIN10_MCP_TOKEN')()).toBeUndefined()

    const customRef = fakeCtx()
    process.env.JIN10_CUSTOM = 'sk-custom'
    expect(createTokenProvider(customRef.ctx, 'JIN10_CUSTOM')()).toBe('sk-custom')
    delete process.env.JIN10_CUSTOM
  })

  it('接线后工具真正可用：apply → 工具 execute → 真实 MCP 链路（打桩 fetch + 设置中心凭证）', async () => {
    const requests: Array<Record<string, unknown>> = []
    const stub = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string } }
      requests.push(body as unknown as Record<string, unknown>)
      const sse = (payload: unknown) => new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      if (body.method === 'initialize') return sse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { logging: {}, resources: {}, tools: {} } } })
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return sse({
        jsonrpc: '2.0', id: 2,
        result: {
          structuredContent: {
            status: 200, message: '',
            data: { has_more: false, items: [{ content: '【接线冒烟】正文不下发', time: '2026-09-13T09:00:00+08:00', url: 'https://flash.jin10.com/detail/1' }] },
          },
        },
      })
    })
    vi.stubGlobal('fetch', stub)
    try {
      const { ctx, registered } = fakeCtx({ credential: { token: 'sk-settings' } })
      apply(ctx, { ...Config({}), enabled: true })
      const tool = registered.get('flash_list') as unknown as { execute(args: unknown): Promise<unknown> }
      const text = String(await tool.execute({ limit: 1 }))
      expect(text).toContain('接线冒烟')
      expect(text).not.toContain('正文不下发')
      expect(requests.map((request) => request.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
      const headers = stub.mock.calls[0]?.[1]?.headers as Record<string, string>
      expect(headers.authorization).toBe('Bearer sk-settings')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
