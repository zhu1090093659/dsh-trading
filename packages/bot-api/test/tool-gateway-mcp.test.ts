/**
 * 外部工具调用网关 MCP（Streamable HTTP）、OpenAPI 3.1 与高级安全策略 BDD 测试（零 mock、零 sleep）。
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  startToolGatewayServer,
  type GatewayAgentPresetsLike,
  type ToolGatewayConfigInput,
  type ToolGatewayHandle,
} from '../src/tool-gateway.ts'

async function loadCreateScope(): Promise<(ctx: Context, key: unknown) => { ctx: Context; dispose(): Promise<void> }> {
  const localRequire = createRequire(import.meta.url)
  const toolsPath = localRequire.resolve('@deepseek-ai/dsh-tools')
  const toolsRequire = createRequire(toolsPath)
  const scopePath = toolsRequire.resolve('@deepseek-ai/dsh-scope')
  const mod = await import(pathToFileURL(scopePath).href) as {
    createScope(ctx: Context, key: unknown): { ctx: Context; dispose(): Promise<void> }
  }
  return mod.createScope
}

const TEST_TOKEN = 'c'.repeat(64)

async function bootMcpHarness() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))

  let toolsCtx: Context = ctx
  ctx.inject(['tools'], (c) => {
    toolsCtx = c
  })
  await new Promise(resolve => setImmediate(resolve))

  toolsCtx.tools.register(defineTool({
    name: 'routing_get',
    description: 'Return active providers.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return JSON.stringify({ ok: true, cn: 'tencent' })
    },
  }))

  toolsCtx.tools.register(defineTool({
    name: 'holdings_add',
    description: 'Add a holding position.',
    parameters: { symbol: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      return JSON.stringify({ ok: true, added: (args as { symbol: string }).symbol })
    },
  }))

  toolsCtx.tools.register(defineTool({
    name: 'bash',
    description: 'Internal shell tool.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() { return 'hidden' },
  }))

  const scopeKey = { presetMarker: 'master' }
  const createScope = await loadCreateScope()
  const masterScope = createScope(ctx, scopeKey)
  let scopedToolsCtx: Context | undefined
  masterScope.ctx.plugin({
    inject: ['tools'],
    apply(scoped) { scopedToolsCtx = scoped },
  })
  await new Promise(resolve => setImmediate(resolve))
  if (scopedToolsCtx === undefined) throw new Error('scoped tools context failed to activate')

  scopedToolsCtx.tools.register(defineTool({
    name: 'cn_get_ticker',
    description: 'Fetch China A-share real-time quote.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Canonical A-share symbol.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          price: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      return { symbol: String((args as { symbol: string }).symbol), price: 1510 }
    },
  }))

  scopedToolsCtx.tools.register(defineTool({
    name: 'crypto_place_order',
    description: 'Place crypto order (dryRun required externally).',
    parameters: {
      symbol: { type: 'string', required: true },
      dryRun: { type: 'boolean' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      return JSON.stringify({ ok: true, dryRun: (args as { dryRun?: boolean }).dryRun === true })
    },
  }))

  const agentPresets: GatewayAgentPresetsLike = {
    async acquireScope(id = 'master') {
      if (id !== 'master' && id !== 'research') throw new Error(`unknown preset: ${id}`)
      return {
        key: scopeKey,
        async [Symbol.asyncDispose]() {},
      }
    },
  }

  return {
    ctx,
    agentPresets,
    async dispose() {
      await masterScope.dispose()
      await ctx.fiber.dispose()
    },
  }
}

describe('tool-gateway Streamable HTTP MCP, OpenAPI, and access policies', () => {
  let dir: string
  let harness: Awaited<ReturnType<typeof bootMcpHarness>> | undefined
  let gateway: ToolGatewayHandle | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dshtrading-gw-mcp-'))
  })

  afterEach(async () => {
    if (gateway !== undefined) {
      await gateway.dispose()
      gateway = undefined
    }
    if (harness !== undefined) {
      await harness.dispose()
      harness = undefined
    }
    rmSync(dir, { recursive: true, force: true })
  })

  async function startWith(overrides?: Partial<ToolGatewayConfigInput>): Promise<ToolGatewayHandle> {
    harness = await bootMcpHarness()
    gateway = await startToolGatewayServer({
      ctx: () => harness?.ctx,
      agentPresets: () => harness?.agentPresets,
      dshHome: dir,
      token: TEST_TOKEN,
      overrides,
    })
    return gateway
  }

  it('operator: serves OpenAPI 3.1 spec, /health protocols metadata, and GET /schema?all=1', async () => {
    // Given a running gateway with MCP enabled and custom publicUrl
    const gw = await startWith({ publicUrl: 'https://gw.example.com' })
    const headers = { authorization: `Bearer ${TEST_TOKEN}` }

    // When fetching /health, /openapi.json, and /schema?all=1
    const healthRes = await fetch(`${gw.url}/health`, { headers })
    const health = await healthRes.json() as { ok: boolean; protocols: string[]; mcpDefaultMode: string; publicUrl: string }
    const specRes = await fetch(`${gw.url}/openapi.json`, { headers })
    const spec = await specRes.json() as { openapi: string; servers: Array<{ url: string }>; paths: Record<string, unknown> }
    const schemaAllRes = await fetch(`${gw.url}/schema?all=1`, { headers })
    const schemaAll = await schemaAllRes.json() as { ok: boolean; tools: Array<{ name: string }> }

    // Then metadata, OpenAPI document, and filtered full schema list match active policy
    expect(healthRes.status).toBe(200)
    expect(health.protocols).toEqual(['http-json', 'openapi-3.1', 'mcp-streamable-http'])
    expect(health.mcpDefaultMode).toBe('index')
    expect(health.publicUrl).toBe('https://gw.example.com')

    expect(specRes.status).toBe(200)
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.servers[0]?.url).toBe('https://gw.example.com')
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(['/health', '/index', '/schema', '/call', '/openapi.json', '/mcp']))

    expect(schemaAllRes.status).toBe(200)
    expect(schemaAll.tools.map(t => t.name)).toContain('cn_get_ticker')
    expect(schemaAll.tools.map(t => t.name)).not.toContain('bash')
  })

  it('user: completes Streamable HTTP MCP handshake, ping, notifications, and index-mode meta-tools', async () => {
    // Given an active gateway in default index MCP mode
    const gw = await startWith()
    const headers = { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' }
    const postMcp = (body: unknown, query = '') =>
      fetch(`${gw.url}/mcp${query}`, { method: 'POST', headers, body: JSON.stringify(body) })

    // When performing initialize, notifications/initialized, ping, tools/list, and tools/call meta-tools
    const initRes = await postMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
    const initJson = await initRes.json() as { result: { protocolVersion: string; serverInfo: { name: string } } }

    const notifRes = await postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const pingRes = await postMcp({ jsonrpc: '2.0', id: 2, method: 'ping' })
    const listRes = await postMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    const listJson = await listRes.json() as { result: { tools: Array<{ name: string }> } }

    const idxRes = await postMcp({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'dsh_trading_index', arguments: { family: 'cn' } },
    })
    const idxJson = await idxRes.json() as { result: { content: Array<{ text: string }> } }

    const callRes = await postMcp({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'dsh_trading_call', arguments: { name: 'cn_get_ticker', arguments: { symbol: '600519.SH' } } },
    })
    const callJson = await callRes.json() as { result: { content: Array<{ text: string }>; isError?: boolean } }

    const unknownMethodRes = await postMcp({ jsonrpc: '2.0', id: 6, method: 'resources/list' })
    const unknownMethodJson = await unknownMethodRes.json() as { error: { code: number } }

    // Then MCP responses follow JSON-RPC 2.0 and Streamable HTTP semantics cleanly
    expect(initRes.status).toBe(200)
    expect(initJson.result.protocolVersion).toBe('2025-03-26')
    expect(initJson.result.serverInfo.name).toBe('dsh-trading-tool-gateway')
    expect(notifRes.status).toBe(202)
    expect(pingRes.status).toBe(200)
    expect(listJson.result.tools.map(t => t.name)).toEqual(['dsh_trading_index', 'dsh_trading_schema', 'dsh_trading_call'])
    expect(JSON.parse(idxJson.result.content[0]?.text ?? '{}')).toMatchObject({ ok: true, matched: 1 })
    expect(callJson.result.isError).toBeUndefined()
    expect(JSON.parse(callJson.result.content[0]?.text ?? '{}')).toEqual({ symbol: '600519.SH', price: 1510 })
    expect(unknownMethodJson.error.code).toBe(-32601)
  })

  it('user: supports flat-mode MCP with family scoping and enforces fail-closed live-trading gate', async () => {
    // Given a gateway serving flat MCP tools scoped by ?family=cn,crypto
    const gw = await startWith()
    const headers = { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' }
    const postFlat = (body: unknown) =>
      fetch(`${gw.url}/mcp?mode=flat&family=cn,crypto`, { method: 'POST', headers, body: JSON.stringify(body) })

    // When listing flat tools, calling an in-scope tool, calling an out-of-scope tool, and attempting a live order
    const listRes = await postFlat({ jsonrpc: '2.0', id: 10, method: 'tools/list' })
    const listJson = await listRes.json() as { result: { tools: Array<{ name: string; inputSchema: { type: string; required?: string[] } }> } }

    const directRes = await postFlat({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'cn_get_ticker', arguments: { symbol: '000001.SZ' } },
    })
    const directJson = await directRes.json() as { result: { content: Array<{ text: string }> } }

    const outOfScopeRes = await postFlat({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'routing_get', arguments: {} },
    })
    const outOfScopeJson = await outOfScopeRes.json() as { result: { isError: boolean; content: Array<{ text: string }> } }

    const blockedOrderRes = await postFlat({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'crypto_place_order', arguments: { symbol: 'BTCUSDT', dryRun: false } },
    })
    const blockedOrderJson = await blockedOrderRes.json() as { result: { isError: boolean; content: Array<{ text: string }> } }

    // Then flat schema omits bash/routing, out-of-scope calls fail cleanly, and live orders fail-closed
    const flatNames = listJson.result.tools.map(t => t.name)
    expect(flatNames).toEqual(['cn_get_ticker', 'crypto_place_order'])
    const cnSchema = listJson.result.tools.find(t => t.name === 'cn_get_ticker')?.inputSchema
    expect(cnSchema?.type).toBe('object')
    expect(cnSchema?.required).toEqual(['symbol'])
    expect(JSON.parse(directJson.result.content[0]?.text ?? '{}')).toEqual({ symbol: '000001.SZ', price: 1510 })
    expect(outOfScopeJson.result.isError).toBe(true)
    expect(JSON.parse(outOfScopeJson.result.content[0]?.text ?? '{}')).toMatchObject({ code: 'TOOL_OUT_OF_SCOPE' })
    expect(blockedOrderJson.result.isError).toBe(true)
    expect(JSON.parse(blockedOrderJson.result.content[0]?.text ?? '{}')).toMatchObject({ code: 'TRADING_APPROVAL_REQUIRED' })
  })

  it('operator: enforces CORS preflight, Origin allowlist, readOnly mode, and allowedPresets', async () => {
    // Given a gateway configured with allowedOrigins, readOnly=true, and allowedPresets=['master']
    const gw = await startWith({
      allowedOrigins: ['https://agent.example.com'],
      allowedPresets: ['master'],
      readOnly: true,
    })

    // When sending CORS preflight, disallowed Origin, GET/DELETE /mcp, mutating call, live order, and disallowed preset
    const preflightRes = await fetch(`${gw.url}/mcp`, {
      method: 'OPTIONS',
      headers: { origin: 'https://agent.example.com' },
    })
    const allowedOriginRes = await fetch(`${gw.url}/health`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}`, origin: 'https://agent.example.com' },
    })
    const blockedOriginRes = await fetch(`${gw.url}/health`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}`, origin: 'https://evil.example.com' },
    })
    const getMcpRes = await fetch(`${gw.url}/mcp`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    })
    const delMcpRes = await fetch(`${gw.url}/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    })
    const mutatingRes = await fetch(`${gw.url}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'holdings_add', arguments: { symbol: '600519.SH' } }),
    })
    const liveOrderRes = await fetch(`${gw.url}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'crypto_place_order', arguments: { symbol: 'BTCUSDT', dryRun: false } }),
    })
    const badPresetRes = await fetch(`${gw.url}/index?preset=research`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    })

    // Then CORS, readOnly, live-action priority, MCP HTTP verbs, and preset restrictions all enforce fail-closed
    expect(preflightRes.status).toBe(204)
    expect(preflightRes.headers.get('access-control-allow-origin')).toBe('https://agent.example.com')
    expect(allowedOriginRes.status).toBe(200)
    expect(allowedOriginRes.headers.get('access-control-allow-origin')).toBe('https://agent.example.com')
    expect(blockedOriginRes.status).toBe(403)
    expect(getMcpRes.status).toBe(405)
    expect(delMcpRes.status).toBe(204)
    expect(mutatingRes.status).toBe(403)
    expect(await mutatingRes.json()).toMatchObject({ code: 'TOOL_READ_ONLY_BLOCKED' })
    expect(liveOrderRes.status).toBe(403)
    expect(await liveOrderRes.json()).toMatchObject({ code: 'TRADING_APPROVAL_REQUIRED' })
    expect(badPresetRes.status).toBe(403)
    expect(await badPresetRes.json()).toMatchObject({ code: 'PRESET_NOT_ALLOWED' })
  })
})
