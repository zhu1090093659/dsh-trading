/**
 * 回环工具调用网关 BDD 集成测试（真实 Cordis Context + 真实 ToolRuntime + 真实 NativeToolExecutor + 真实 HTTP 回环）。
 *
 * 零 mock、零 sleep、全链路验证：
 * - 白名单族过滤（仅暴露交易/投研/资产/知识工具，隐藏 bash/read/trading_batch/subagent）
 * - 作用域隔离 + `dsh-session-checkpoint-policy` 兼容性（透明 parent 令牌 + 无 `.session` 的 ScopeKey）
 * - 实盘安全闸门 fail-closed（`dryRun !== true` 在入管线前 403 拒单；`dryRun: true` 正常模拟执行）
 * - 回环 Host/Origin/Bearer 鉴权与输入校验（401/403/400/404/405/413/503）
 * - `startToolGatewayServer` 的 `0600` 描述文件落盘与 PID 归属清理
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GATEWAY_PRESET,
  EXPOSED_TOOL_FAMILIES,
  buildGatewayToolIndex,
  createToolGatewayHandler,
  familyOfTool,
  isExposedToolName,
  isLiveActionBlocked,
  startToolGatewayServer,
  type GatewayAgentPresetsLike,
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

const TEST_TOKEN = 'a'.repeat(64)

interface GatewayCallTracker {
  liveOrderCalls: number
  dryRunOrderCalls: number
  cnTickerCalls: number
  holdingsCalls: number
  postExecuteLogs: string[]
  presetDisposeCount: number
}

interface TestHarness {
  readonly ctx: Context
  readonly tracker: GatewayCallTracker
  readonly agentPresets: GatewayAgentPresetsLike
  readonly scopeKey: unknown
  dispose(): Promise<void>
}

async function bootGatewayHarness(): Promise<TestHarness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))

  const tracker: GatewayCallTracker = {
    liveOrderCalls: 0,
    dryRunOrderCalls: 0,
    cnTickerCalls: 0,
    holdingsCalls: 0,
    postExecuteLogs: [],
    presetDisposeCount: 0,
  }

  // 模拟宿主 `dsh-session-checkpoint-policy`：`exec.agent` 存在且无 `parent` 时强依赖 `exec.agent.session`。
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent !== undefined && exec.parent === undefined) {
      throw new Error('session-checkpoint-policy requires exec.agent.session when parent is absent')
    }
    return next()
  })

  // 模拟 `@dshtrading/base` 的 `tools/pre-execute` 实盘闸门与 `tools/post-execute` 审计日志。
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (/^(?:crypto|cn)_place_order$/.test(exec.name) && (exec.arguments as { dryRun?: unknown } | undefined)?.dryRun !== true) {
      return { kind: 'ask', reason: 'live order requires approval' }
    }
    return next()
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    tracker.postExecuteLogs.push(`${exec.name}:${String(result.isError)}`)
    return next()
  })

  let toolsCtx: Context = ctx
  ctx.inject(['tools'], (c) => {
    toolsCtx = c
  })
  await new Promise(resolve => setImmediate(resolve))

  // Global host-plane tools: trading + non-trading infrastructure.
  toolsCtx.tools.register(defineTool({
    name: 'holdings_list',
    description: 'List confirmed and staged holdings in the unified ledger.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          items: { type: 'array', items: { type: 'json' }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      tracker.holdingsCalls += 1
      return { ok: true, items: [{ symbol: '600519.SH', shares: 100 }] }
    },
  }))

  toolsCtx.tools.register(defineTool({
    name: 'routing_get',
    description: 'Return active market data providers.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return JSON.stringify({ ok: true, cn: 'tencent', crypto: 'okx' })
    },
  }))

  toolsCtx.tools.register(defineTool({
    name: 'slow_cn_probe',
    description: 'Read-only test probe for abort or failure paths.',
    parameters: {
      mode: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      if ((args as { mode?: string }).mode === 'fail') {
        throw new Error('TRADING_UPSTREAM_ERROR: test failure')
      }
      return JSON.stringify({ ok: true })
    },
  }))

  for (const hiddenName of ['bash', 'read', 'trading_batch', 'trading_tools_index']) {
    toolsCtx.tools.register(defineTool({
      name: hiddenName,
      description: `Internal tool ${hiddenName} that must stay hidden from the external gateway.`,
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute() {
        return 'internal'
      },
    }))
  }

  // Preset-scoped (`master`) tools: an opaque `{}` ScopeKey with NO `.session`.
  const scopeKey = { presetMarker: 'master' }
  const createScope = await loadCreateScope()
  const masterScope = createScope(ctx, scopeKey)
  let scopedToolsCtx: Context | undefined
  masterScope.ctx.plugin({
    inject: ['tools'],
    apply(scoped) {
      scopedToolsCtx = scoped
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  if (scopedToolsCtx === undefined) throw new Error('scoped tools context did not activate')

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
      tracker.cnTickerCalls += 1
      return { symbol: String((args as { symbol: string }).symbol), price: 1520.5 }
    },
  }))

  scopedToolsCtx.tools.register(defineTool({
    name: 'crypto_place_order',
    description: 'Place a crypto order (dryRun=true by default).',
    parameters: {
      symbol: { type: 'string', required: true },
      side: { type: 'string', required: true },
      quantity: { type: 'number', required: true },
      dryRun: { type: 'boolean' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          simulated: { type: 'boolean', required: true },
          symbol: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const typed = args as { symbol: string; dryRun?: boolean }
      if (typed.dryRun === true) {
        tracker.dryRunOrderCalls += 1
        return { simulated: true, symbol: typed.symbol }
      }
      tracker.liveOrderCalls += 1
      return { simulated: false, symbol: typed.symbol }
    },
  }))

  scopedToolsCtx.tools.register(defineTool({
    name: 'researcher_subagent',
    description: 'Delegate preset subagent.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      return 'delegated'
    },
  }))

  const agentPresets: GatewayAgentPresetsLike = {
    async acquireScope(id = DEFAULT_GATEWAY_PRESET) {
      if (id !== 'master') {
        throw new Error(`Unknown agent preset: ${id}`)
      }
      return {
        key: scopeKey,
        async [Symbol.asyncDispose]() {
          tracker.presetDisposeCount += 1
        },
      }
    },
  }

  return {
    ctx: toolsCtx,
    tracker,
    agentPresets,
    scopeKey,
    async dispose() {
      await masterScope.dispose()
      await ctx.fiber.dispose()
    },
  }
}

function sendRawHttp(options: {
  readonly port: number
  readonly method: string
  readonly path: string
  readonly headers?: Record<string, string>
  readonly body?: string
}): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) as Record<string, unknown> })
      })
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

describe('tool-gateway pure helpers', () => {
  it('operator: classifies exposed families and live-action gates accurately', () => {
    // Given exposed trading tool names, internal tool names, and live/dryRun order inputs
    // When checking family extraction, allowlist membership, and live-action gate
    // Then exposed families pass, internal tools are blocked, and dryRun!==true is blocked
    expect(familyOfTool('cn_get_ticker')).toBe('cn')
    expect(familyOfTool('bash')).toBe('bash')
    expect(EXPOSED_TOOL_FAMILIES.has('cn')).toBe(true)
    expect(isExposedToolName('cn_get_ticker')).toBe(true)
    expect(isExposedToolName('trading_batch')).toBe(false)
    expect(isExposedToolName('bash')).toBe(false)
    expect(isLiveActionBlocked('crypto_place_order', {})).toBe(true)
    expect(isLiveActionBlocked('crypto_place_order', { dryRun: false })).toBe(true)
    expect(isLiveActionBlocked('crypto_place_order', { dryRun: true })).toBe(false)
    expect(isLiveActionBlocked('cn_cancel_order', undefined)).toBe(true)
    expect(isLiveActionBlocked('crypto_set_leverage', { dryRun: false })).toBe(true)
    expect(isLiveActionBlocked('cn_get_ticker', {})).toBe(false)
  })

  it('operator: builds tool index excluding internal tools and ranking keyword matches', () => {
    // Given mixed schemas with trading tools, non-exposed tools, and a long description
    const schemas = [
      { name: 'cn_get_ticker', description: 'Fetch A-share real-time ticker. Includes bid and ask.' },
      { name: 'holdings_list', description: 'List holdings in ledger; ' + 'x'.repeat(130) },
      { name: 'unknownprefix_ping', description: 'Custom exposed check?' },
      { name: 'bash', description: 'Run shell command.' },
      { name: 'trading_batch', description: 'Batch call tools.' },
    ]
    // When building full index and filtering by query and family
    const full = buildGatewayToolIndex(schemas)
    const byQuery = buildGatewayToolIndex(schemas, '台账')
    const byFamily = buildGatewayToolIndex(schemas, undefined, 'cn')
    // Then internal tools are excluded, long descriptions truncate cleanly, and filters narrow matched counts
    expect(full.total).toBe(2)
    expect(full.matched).toBe(2)
    expect(full.families.map(f => f.family).sort()).toEqual(['cn', 'holdings'])
    expect(byQuery.families.map(f => f.family)).toEqual(['holdings'])
    expect(byFamily.families.map(f => f.family)).toEqual(['cn'])
    expect(full.families.find(f => f.family === 'holdings')?.tools[0]?.brief.endsWith('…')).toBe(false)
  })
})

describe('tool-gateway HTTP server and lifecycle', () => {
  let dir: string
  let harness: TestHarness | undefined
  let gateway: ToolGatewayHandle | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dshtrading-tool-gw-'))
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

  it('operator: starts loopback server, writes 0600 descriptor, serves health/index/schema, and cleans up on dispose', async () => {
    // Given a live Cordis harness and temp descriptor path
    harness = await bootGatewayHarness()
    const descriptorPath = join(dir, 'tool-gateway.json')
    gateway = await startToolGatewayServer({
      ctx: () => harness?.ctx,
      agentPresets: () => harness?.agentPresets,
      descriptorPath,
      token: TEST_TOKEN,
    })

    // When reading descriptor permissions and requesting /health, /index, and /schema
    const mode = statSync(descriptorPath).mode & 0o777
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as { pid: number; port: number; token: string }
    const authHeaders = { authorization: `Bearer ${gateway.token}` }

    const healthRes = await fetch(`${gateway.url}/health`, { headers: authHeaders })
    const healthJson = await healthRes.json() as { ok: boolean; pid: number; preset: string; toolCount: number }

    const indexRes = await fetch(`${gateway.url}/index`, { headers: authHeaders })
    const indexJson = await indexRes.json() as { ok: boolean; total: number; families: Array<{ family: string }> }

    const schemaOneRes = await fetch(`${gateway.url}/schema?name=cn_get_ticker`, { headers: authHeaders })
    const schemaOneJson = await schemaOneRes.json() as { ok: boolean; tool: { name: string } }

    const schemaFamilyRes = await fetch(`${gateway.url}/schema?family=cn`, { headers: authHeaders })
    const schemaFamilyJson = await schemaFamilyRes.json() as { ok: boolean; family: string; tools: Array<{ name: string }> }

    // Then descriptor is 0600, trading tools across host+preset are visible, and internal tools are excluded
    expect(mode).toBe(0o600)
    expect(descriptor.pid).toBe(process.pid)
    expect(descriptor.port).toBe(gateway.port)
    expect(healthRes.status).toBe(200)
    expect(healthJson).toMatchObject({ ok: true, pid: process.pid, preset: 'master', toolCount: 4 })
    expect(indexRes.status).toBe(200)
    expect(indexJson.total).toBe(4)
    expect(indexJson.families.map(f => f.family).sort()).toEqual(['cn', 'crypto', 'holdings', 'routing'])
    expect(schemaOneRes.status).toBe(200)
    expect(schemaOneJson.tool.name).toBe('cn_get_ticker')
    expect(schemaFamilyRes.status).toBe(200)
    expect(schemaFamilyJson.tools.map(t => t.name)).toEqual(['cn_get_ticker'])

    // When disposing the gateway
    await gateway.dispose()
    await gateway.dispose()
    gateway = undefined

    // Then descriptor written by this pid is removed and preset leases were disposed
    expect(() => readFileSync(descriptorPath, 'utf8')).toThrow()
    expect(harness.tracker.presetDisposeCount).toBe(4)
  })

  it('operator: executes host and preset-scoped read tools through ToolExecutionPipeline despite session-checkpoint-policy', async () => {
    // Given a running gateway wired to a real ToolRuntime with a session-checkpoint-policy listener
    harness = await bootGatewayHarness()
    gateway = await startToolGatewayServer({
      ctx: () => harness?.ctx,
      agentPresets: () => harness?.agentPresets,
      descriptorPath: join(dir, 'tool-gateway.json'),
      token: TEST_TOKEN,
    })

    // When invoking a host tool (holdings_list) and a preset-scoped tool (cn_get_ticker) via POST /call
    const headers = {
      authorization: `Bearer ${gateway.token}`,
      'content-type': 'application/json',
    }
    const holdingsRes = await fetch(`${gateway.url}/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'holdings_list', arguments: {} }),
    })
    const holdingsJson = await holdingsRes.json() as { ok: boolean; value: { items: Array<{ symbol: string }> }; text: string }

    const tickerRes = await fetch(`${gateway.url}/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'cn_get_ticker', arguments: { symbol: '600519.SH' } }),
    })
    const tickerJson = await tickerRes.json() as { ok: boolean; value: { symbol: string; price: number }; text: string }

    // Then both succeed with canonical values and post-execute logging, without needing exec.agent.session
    expect(holdingsRes.status).toBe(200)
    expect(holdingsJson.ok).toBe(true)
    expect(holdingsJson.value.items[0]?.symbol).toBe('600519.SH')
    expect(tickerRes.status).toBe(200)
    expect(tickerJson.ok).toBe(true)
    expect(tickerJson.value).toEqual({ symbol: '600519.SH', price: 1520.5 })
    expect(harness.tracker.cnTickerCalls).toBe(1)
    expect(harness.tracker.holdingsCalls).toBe(1)
    expect(harness.tracker.postExecuteLogs).toEqual(['holdings_list:false', 'cn_get_ticker:false'])
  })

  it('operator: fails closed on live orders without dryRun=true and permits explicit dryRun=true orders', async () => {
    // Given a running gateway with crypto_place_order mounted in master scope
    harness = await bootGatewayHarness()
    gateway = await startToolGatewayServer({
      ctx: () => harness?.ctx,
      agentPresets: () => harness?.agentPresets,
      descriptorPath: join(dir, 'tool-gateway.json'),
      token: TEST_TOKEN,
    })
    const headers = {
      authorization: `Bearer ${gateway.token}`,
      'content-type': 'application/json',
    }

    // When calling crypto_place_order with omitted dryRun, dryRun=false, and explicit dryRun=true
    const omittedRes = await fetch(`${gateway.url}/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'crypto_place_order', arguments: { symbol: 'BTCUSDT', side: 'buy', quantity: 0.01 } }),
    })
    const omittedJson = await omittedRes.json() as { ok: boolean; code: string }

    const falseRes = await fetch(`${gateway.url}/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'crypto_place_order', arguments: { symbol: 'BTCUSDT', side: 'buy', quantity: 0.01, dryRun: false } }),
    })
    const falseJson = await falseRes.json() as { ok: boolean; code: string }

    const dryRes = await fetch(`${gateway.url}/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'crypto_place_order', arguments: { symbol: 'BTCUSDT', side: 'buy', quantity: 0.01, dryRun: true } }),
    })
    const dryJson = await dryRes.json() as { ok: boolean; value: { simulated: boolean; symbol: string } }

    // Then live intents fail closed with 403 TRADING_APPROVAL_REQUIRED without hitting tool body, and dryRun=true executes
    expect(omittedRes.status).toBe(403)
    expect(omittedJson.code).toBe('TRADING_APPROVAL_REQUIRED')
    expect(falseRes.status).toBe(403)
    expect(falseJson.code).toBe('TRADING_APPROVAL_REQUIRED')
    expect(harness.tracker.liveOrderCalls).toBe(0)
    expect(dryRes.status).toBe(200)
    expect(dryJson.ok).toBe(true)
    expect(dryJson.value).toEqual({ simulated: true, symbol: 'BTCUSDT' })
    expect(harness.tracker.dryRunOrderCalls).toBe(1)
  })

  it('guest: rejects missing/invalid bearer token, non-loopback Host, and non-loopback Origin', async () => {
    // Given a running gateway protected by loopback + bearer checks
    harness = await bootGatewayHarness()
    gateway = await startToolGatewayServer({
      ctx: () => harness?.ctx,
      agentPresets: () => harness?.agentPresets,
      descriptorPath: join(dir, 'tool-gateway.json'),
      token: TEST_TOKEN,
    })

    // When sending unauthenticated, wrong-token, non-loopback Host, and non-loopback Origin requests
    const noAuth = await sendRawHttp({ port: gateway.port, method: 'GET', path: '/health' })
    const badAuth = await sendRawHttp({
      port: gateway.port,
      method: 'GET',
      path: '/health',
      headers: { authorization: 'Bearer wrong' },
    })
    const badHost = await sendRawHttp({
      port: gateway.port,
      method: 'GET',
      path: '/health',
      headers: { host: 'evil.example.com:8888', authorization: `Bearer ${gateway.token}` },
    })
    const badOrigin = await sendRawHttp({
      port: gateway.port,
      method: 'GET',
      path: '/health',
      headers: { origin: 'https://evil.example.com', authorization: `Bearer ${gateway.token}` },
    })

    // Then auth failures return 401 and host/origin spoofs return 403
    expect(noAuth.status).toBe(401)
    expect(noAuth.json.code).toBe('UNAUTHORIZED')
    expect(badAuth.status).toBe(401)
    expect(badHost.status).toBe(403)
    expect(badHost.json.code).toBe('FORBIDDEN_HOST')
    expect(badOrigin.status).toBe(403)
    expect(badOrigin.json.code).toBe('FORBIDDEN_ORIGIN')
  })

  it('operator: returns accurate protocol, visibility, preset, and execution errors', async () => {
    // Given a running gateway and a mixed set of valid and invalid queries/calls
    harness = await bootGatewayHarness()
    gateway = await startToolGatewayServer({
      ctx: () => harness?.ctx,
      agentPresets: () => harness?.agentPresets,
      descriptorPath: join(dir, 'tool-gateway.json'),
      token: TEST_TOKEN,
    })
    const headers = {
      authorization: `Bearer ${gateway.token}`,
      'content-type': 'application/json',
    }

    // When testing hidden tools, missing tools, invalid methods/JSON/args, oversize body, missing preset, and failing tool body
    const hiddenSchema = await fetch(`${gateway.url}/schema?name=bash`, { headers })
    const hiddenFamily = await fetch(`${gateway.url}/schema?family=bash`, { headers })
    const missingSchema = await fetch(`${gateway.url}/schema?name=cn_does_not_exist`, { headers })
    const emptySchema = await fetch(`${gateway.url}/schema`, { headers })
    const badMethod = await fetch(`${gateway.url}/call`, { method: 'GET', headers })
    const hiddenCall = await fetch(`${gateway.url}/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'trading_batch', arguments: {} }),
    })
    const missingCall = await fetch(`${gateway.url}/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'cn_does_not_exist', arguments: {} }),
    })
    const badJson = await fetch(`${gateway.url}/call`, { method: 'POST', headers, body: '{bad' })
    const badArgs = await fetch(`${gateway.url}/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'holdings_list', arguments: [] }),
    })
    const oversize = await fetch(`${gateway.url}/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'holdings_list', arguments: { pad: 'x'.repeat(1024 * 1024 + 32) } }),
    })
    const badPreset = await fetch(`${gateway.url}/index?preset=unknown`, { headers })
    const missingRoute = await fetch(`${gateway.url}/unknown`, { headers })
    const failingTool = await fetch(`${gateway.url}/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'cn_get_ticker', arguments: {} }),
    })
    const failingJson = await failingTool.json() as { ok: boolean; isError: boolean; code: string }

    // Then every failure mode surfaces its deterministic HTTP status and error code
    expect(hiddenSchema.status).toBe(403)
    expect(hiddenFamily.status).toBe(403)
    expect(missingSchema.status).toBe(404)
    expect(emptySchema.status).toBe(400)
    expect(badMethod.status).toBe(405)
    expect(hiddenCall.status).toBe(403)
    expect(missingCall.status).toBe(404)
    expect(badJson.status).toBe(400)
    expect(badArgs.status).toBe(400)
    expect(oversize.status).toBe(413)
    expect(badPreset.status).toBe(404)
    expect(missingRoute.status).toBe(404)
    expect(failingTool.status).toBe(200)
    expect(failingJson.ok).toBe(false)
    expect(failingJson.isError).toBe(true)
    expect(failingJson.code).toBe('INVALID_ARGS')
  })

  it('operator: returns 503 when tools service is unavailable and preserves foreign-pid descriptor on dispose', async () => {
    // Given a gateway handler whose tools service is missing, plus a server whose descriptor was overwritten by another pid
    const handler = createToolGatewayHandler({
      ctx: () => undefined,
      tools: () => undefined,
      token: TEST_TOKEN,
    })
    const foreignDescriptorPath = join(dir, 'foreign.json')
    harness = await bootGatewayHarness()
    const serverHandle = await startToolGatewayServer({
      ctx: () => harness?.ctx,
      descriptorPath: foreignDescriptorPath,
      token: TEST_TOKEN,
    })

    // When probing /health without tools and overwriting descriptor pid before dispose
    const resState: { status: number; body: string } = { status: 0, body: '' }
    const fakeReq = {
      method: 'GET',
      url: '/health',
      headers: { host: '127.0.0.1:1', authorization: `Bearer ${TEST_TOKEN}` },
    }
    const fakeRes = {
      writableEnded: false,
      destroyed: false,
      writeHead: (s: number) => { resState.status = s },
      end: (b?: string) => { resState.body = b ?? '' },
    }
    await handler(fakeReq as never, fakeRes as never)

    writeFileSync(foreignDescriptorPath, JSON.stringify({ pid: process.pid + 99999 }), 'utf8')
    chmodSync(foreignDescriptorPath, 0o600)
    await serverHandle.dispose()

    // Then handler responds 503 TOOLS_UNAVAILABLE and foreign pid descriptor stays intact
    expect(resState.status).toBe(503)
    expect(JSON.parse(resState.body)).toMatchObject({ ok: false, code: 'TOOLS_UNAVAILABLE' })
    expect(JSON.parse(readFileSync(foreignDescriptorPath, 'utf8'))).toEqual({ pid: process.pid + 99999 })
  })
})
