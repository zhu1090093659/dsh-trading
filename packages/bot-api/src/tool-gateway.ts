/**
 * 外部工具调用网关（External Tool Gateway）——把宿主 `ctx.tools` 暴露给任意外部 Agent。
 *
 * 设计约束：
 * - 默认仅绑 `127.0.0.1:0`（零配置即本机安全可用），同时支持通过 `tool-gateway-config.ts`
 *   灵活配置监听地址/固定端口/对外 URL/静态或文件令牌/`Host` 与 `Origin` 白名单、
 *   预设范围、工具/族黑白名单、只读模式与超时上限；
 * - 统一提供 CLI/HTTP JSON（`/health`、`/index`、`/schema`、`/call`）、`/openapi.json`
 *   与 Streamable HTTP MCP（`/mcp`，支持 `index` 与 `flat` 两种工具投影模式）；
 * - `INTERNAL_TOOL_DENY_PATTERNS` 与实盘动作门禁 `TRADING_APPROVAL_REQUIRED`
 *   在任何暴露模式与协议下始终 fail-closed 强制执行；
 * - 通过 `@deepseek-ai/dsh-tools/pipeline` 的 `ToolExecutionPipeline` 携带透明 `parent`
 *   令牌执行，完整复用宿主超时/校验/结构化日志，且不污染侧边栏聊天会话。
 *
 * @module @dshtrading/bot-api/tool-gateway
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { dshHomeDir, writeJsonAtomic } from '@dshtrading/dsh-home'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_EXPOSED_TOOL_FAMILIES,
  DEFAULT_GATEWAY_FAMILIES,
  DEFAULT_GATEWAY_PRESET,
  DEFAULT_MAX_GATEWAY_BODY_BYTES,
  LIVE_ACTION_GATE_PATTERN,
  MIN_CALL_TIMEOUT_MS,
  familyOfToolName,
  isHostAllowedByConfig,
  isInternalDeniedTool,
  isMutatingToolName,
  isOriginAllowedByConfig,
  isToolAllowedByPolicy,
  resolveToolGatewayConfig,
  type GatewayFamilyMeta,
  type GatewayToolSchema,
  type McpToolMode,
  type ResolvedToolGatewayConfig,
  type ToolExposurePolicy,
  type ToolGatewayConfigInput,
} from './tool-gateway-config.ts'
import {
  buildGatewayOpenApiSpec,
  handleMcpJsonRpc,
  type GatewayCallOutcome,
  type McpGatewayOperations,
} from './tool-gateway-mcp.ts'

export * from './tool-gateway-config.ts'
export * from './tool-gateway-mcp.ts'

export const MAX_GATEWAY_BODY_BYTES = DEFAULT_MAX_GATEWAY_BODY_BYTES
export const EXPOSED_TOOL_FAMILIES: ReadonlySet<string> = new Set(DEFAULT_EXPOSED_TOOL_FAMILIES)
export const GATEWAY_FAMILIES: Readonly<Record<string, GatewayFamilyMeta>> = DEFAULT_GATEWAY_FAMILIES

export interface GatewayToolsServiceLike {
  schemas(scope?: unknown): readonly GatewayToolSchema[]
}

export interface GatewayPresetScopeLease {
  readonly key: unknown
  [Symbol.asyncDispose](): Promise<void>
}

export interface GatewayAgentPresetsLike {
  acquireScope(id?: string): Promise<GatewayPresetScopeLease>
}

export interface GatewayIndexEntry {
  readonly name: string
  readonly brief: string
}

export interface GatewayIndexFamily {
  readonly family: string
  readonly label: string
  readonly whenToUse: string
  readonly count: number
  readonly tools: readonly GatewayIndexEntry[]
}

export interface GatewayToolIndex {
  readonly query: string | null
  readonly total: number
  readonly matched: number
  readonly families: readonly GatewayIndexFamily[]
}

export interface ToolGatewayDescriptor {
  readonly version: 1
  readonly pid: number
  readonly host: string
  readonly port: number
  readonly url: string
  readonly publicUrl?: string | undefined
  readonly token: string
  readonly preset: string
  readonly protocols: readonly string[]
  readonly mcpDefaultMode: McpToolMode
  readonly readOnly: boolean
  readonly startedAt: string
}

export interface ToolGatewayDependencies {
  readonly ctx: () => Context | undefined
  readonly tools?: (() => GatewayToolsServiceLike | undefined) | undefined
  readonly agentPresets?: (() => GatewayAgentPresetsLike | undefined) | undefined
  readonly token: string
  readonly defaultPreset?: string | undefined
  readonly startedAt?: string | undefined
  readonly pid?: number | undefined
  readonly config?: ResolvedToolGatewayConfig | undefined
  readonly advertisedUrl?: string | undefined
}

export interface ToolGatewayStartOptions {
  readonly ctx: () => Context | undefined
  readonly tools?: (() => GatewayToolsServiceLike | undefined) | undefined
  readonly agentPresets?: (() => GatewayAgentPresetsLike | undefined) | undefined
  readonly descriptorPath?: string | null | undefined
  readonly token?: string | undefined
  readonly defaultPreset?: string | undefined
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly dshHome?: string | undefined
  readonly rowConfig?: unknown
  readonly env?: Record<string, string | undefined> | undefined
  readonly config?: ResolvedToolGatewayConfig | undefined
  readonly overrides?: Partial<ToolGatewayConfigInput> | undefined
}

export interface ToolGatewayHandle {
  readonly url: string
  readonly advertisedUrl: string
  readonly host: string
  readonly port: number
  readonly token: string
  readonly descriptorPath: string | null
  readonly config: ResolvedToolGatewayConfig
  dispose(): Promise<void>
}

/** 网关派发使用的透明父令牌，标记为非聊天 Session 的顶层传输子调用。 */
const GATEWAY_PARENT_TOKEN = Symbol('dsh.trading.tool-gateway') as unknown as ToolExecutionToken

export function familyOfTool(toolName: string): string {
  return familyOfToolName(toolName)
}

export function isExposedToolName(toolName: string): boolean {
  return !isInternalDeniedTool(toolName) && EXPOSED_TOOL_FAMILIES.has(familyOfTool(toolName).toLowerCase())
}

export function isLiveActionBlocked(toolName: string, args: unknown): boolean {
  if (!LIVE_ACTION_GATE_PATTERN.test(toolName)) return false
  const dryRun = (args as { dryRun?: unknown } | null | undefined)?.dryRun
  return dryRun !== true
}

function briefDescription(description: string | undefined, max = 110): string {
  if (!description) return ''
  const flat = description.replace(/\s+/g, ' ').trim()
  const cut = flat.search(/[.。;；]/)
  const first = cut > 0 ? flat.slice(0, cut + 1) : flat
  return first.length > max ? `${first.slice(0, max - 1)}…` : first
}

/** 按策略过滤注册工具并生成按族聚合的索引表。 */
export function buildGatewayToolIndex(
  schemas: readonly GatewayToolSchema[],
  query?: string,
  family?: string,
  options?: {
    readonly policy?: ToolExposurePolicy | undefined
    readonly familyMeta?: Readonly<Record<string, GatewayFamilyMeta>> | undefined
  },
): GatewayToolIndex {
  const q = query?.trim().toLowerCase() || undefined
  const fam = family?.trim().toLowerCase() || undefined
  const policy = options?.policy
  const familyMeta = options?.familyMeta ?? DEFAULT_GATEWAY_FAMILIES
  const exposed = schemas.filter(schema =>
    policy === undefined ? isExposedToolName(schema.name) : isToolAllowedByPolicy(schema.name, policy),
  )

  const grouped = new Map<string, GatewayToolSchema[]>()
  for (const schema of exposed) {
    const prefix = familyOfTool(schema.name).toLowerCase()
    const bucket = grouped.get(prefix)
    if (bucket !== undefined) bucket.push(schema)
    else grouped.set(prefix, [schema])
  }

  const families: GatewayIndexFamily[] = []
  for (const [key, tools] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    if (fam !== undefined && key !== fam) continue
    const meta = familyMeta[key]
    const nameHit = q !== undefined && (key.includes(q) || (meta?.label ?? '').toLowerCase().includes(q))
    const noteHit = q !== undefined && (meta?.whenToUse ?? '').toLowerCase().includes(q)
    const familyHit = q === undefined || nameHit || noteHit
    const hitTools = tools.filter(tool => q === undefined
      || tool.name.toLowerCase().includes(q)
      || (tool.description ?? '').toLowerCase().includes(q))
    if (!familyHit && hitTools.length === 0) continue
    const listed = familyHit ? tools : hitTools
    families.push({
      family: key,
      label: meta?.label ?? key,
      whenToUse: meta?.whenToUse ?? '',
      count: listed.length,
      tools: listed
        .map(tool => ({ name: tool.name, brief: briefDescription(tool.description) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })
  }

  if (q !== undefined) {
    families.sort((a, b) => {
      const rank = (item: GatewayIndexFamily) => {
        const meta = familyMeta[item.family]
        return item.family.includes(q) || (meta?.label ?? '').toLowerCase().includes(q) ? 0 : 1
      }
      return rank(a) - rank(b)
    })
  }

  return {
    query: q ?? null,
    total: exposed.length,
    matched: families.reduce((sum, item) => sum + item.count, 0),
    families,
  }
}

export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  return isHostAllowedByConfig(hostHeader, { host: '127.0.0.1' })
}

export function isLoopbackOriginHeader(originHeader: string | undefined): boolean {
  return isOriginAllowedByConfig(originHeader, {})
}

function isAuthorizedBearer(authHeader: string | undefined, expectedToken: string): boolean {
  if (authHeader === undefined) return false
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim())
  if (match === null) return false
  const supplied = match[1]
  if (supplied === undefined) return false
  const actualBuf = Buffer.from(supplied, 'utf8')
  const expectedBuf = Buffer.from(expectedToken, 'utf8')
  if (actualBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(actualBuf, expectedBuf)
}

class GatewayHttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function buildCorsHeaders(
  originHeader: string | undefined,
  allowedOrigins: readonly string[] | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  if (originHeader === undefined || originHeader === '') return extra
  const wildcard = (allowedOrigins ?? []).some(entry => entry.trim() === '*')
  return {
    'access-control-allow-origin': wildcard ? '*' : originHeader,
    vary: 'Origin',
    ...extra,
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(JSON.stringify(payload))
}

function sendEmpty(
  res: ServerResponse,
  status: number,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, {
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end()
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
  jsonRpcParseError = false,
): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buf.length
    if (total > maxBytes) {
      throw new GatewayHttpError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${maxBytes} bytes cap`)
    }
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') {
    throw new GatewayHttpError(400, jsonRpcParseError ? 'JSON_RPC_PARSE_ERROR' : 'INVALID_REQUEST', 'request body must be a JSON object')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new GatewayHttpError(400, jsonRpcParseError ? 'JSON_RPC_PARSE_ERROR' : 'INVALID_JSON', 'request body must be valid JSON')
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampTimeoutMs(raw: unknown, defaultMs: number, maxMs: number): number {
  if (raw === undefined) return defaultMs
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new GatewayHttpError(400, 'INVALID_REQUEST', 'timeoutMs must be a positive finite number')
  }
  return Math.min(maxMs, Math.max(MIN_CALL_TIMEOUT_MS, Math.trunc(raw)))
}

function parseCallPayload(
  raw: unknown,
  defaultTimeoutMs: number,
  maxTimeoutMs: number,
): {
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly preset?: string
  readonly timeoutMs: number
} {
  if (!isPlainRecord(raw)) {
    throw new GatewayHttpError(400, 'INVALID_REQUEST', 'request body must be a JSON object')
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name === '') {
    throw new GatewayHttpError(400, 'INVALID_REQUEST', 'name must be a non-empty string')
  }
  let toolArgs: Record<string, unknown> = {}
  if (raw.arguments !== undefined) {
    if (!isPlainRecord(raw.arguments)) {
      throw new GatewayHttpError(400, 'INVALID_REQUEST', 'arguments must be a plain JSON object')
    }
    toolArgs = raw.arguments
  }
  let preset: string | undefined
  if (raw.preset !== undefined) {
    if (typeof raw.preset !== 'string' || raw.preset.trim() === '') {
      throw new GatewayHttpError(400, 'INVALID_REQUEST', 'preset must be a non-empty string when provided')
    }
    preset = raw.preset.trim()
  }
  return {
    name,
    arguments: toolArgs,
    ...(preset === undefined ? {} : { preset }),
    timeoutMs: clampTimeoutMs(raw.timeoutMs, defaultTimeoutMs, maxTimeoutMs),
  }
}

function extractTextContent(content: ReadonlyArray<{ type?: string; text?: string }>): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function defaultGatewayConfig(deps: ToolGatewayDependencies): ResolvedToolGatewayConfig {
  if (deps.config !== undefined) return deps.config
  return {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    descriptorPath: null,
    defaultPreset: deps.defaultPreset ?? DEFAULT_GATEWAY_PRESET,
    defaultTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    maxTimeoutMs: 300_000,
    maxBodyBytes: DEFAULT_MAX_GATEWAY_BODY_BYTES,
    mcpEnabled: true,
    mcpDefaultMode: 'index',
    policy: {
      exposeMode: 'allowlist',
      allowedFamilies: [...DEFAULT_EXPOSED_TOOL_FAMILIES],
      extraFamilies: [],
      deniedFamilies: [],
      deniedTools: [],
      readOnly: false,
    },
    familyMeta: DEFAULT_GATEWAY_FAMILIES,
  }
}

function formatBoundHost(host: string): string {
  const trimmed = host.trim()
  if (trimmed.includes(':') && !trimmed.startsWith('[')) return `[${trimmed}]`
  return trimmed
}

function defaultDescriptorUrls(host: string, port: number, publicUrl: string | undefined): {
  readonly boundUrl: string
  readonly advertisedUrl: string
} {
  const boundUrl = `http://${formatBoundHost(host)}:${port}`
  return { boundUrl, advertisedUrl: publicUrl ?? boundUrl }
}

function protocolsForConfig(config: Pick<ResolvedToolGatewayConfig, 'mcpEnabled'>): readonly string[] {
  return config.mcpEnabled
    ? ['http-json', 'openapi-3.1', 'mcp-streamable-http']
    : ['http-json', 'openapi-3.1']
}

function isFamilyAllowedForListing(family: string, policy: ToolExposurePolicy): boolean {
  const lower = family.trim().toLowerCase()
  if (policy.deniedFamilies.some(entry => entry.toLowerCase() === lower)) return false
  if (policy.exposeMode === 'open') return true
  return policy.allowedFamilies.some(entry => entry.toLowerCase() === lower)
    || policy.extraFamilies.some(entry => entry.toLowerCase() === lower)
}

export function createToolGatewayHandler(deps: ToolGatewayDependencies) {
  const config = defaultGatewayConfig(deps)
  const defaultPreset = deps.defaultPreset ?? config.defaultPreset
  const startedAt = deps.startedAt ?? new Date().toISOString()
  const pid = deps.pid ?? process.pid
  let callCounter = 0

  const ensurePresetAllowed = (preset: string): void => {
    if (config.allowedPresets !== undefined && !config.allowedPresets.includes(preset)) {
      throw new GatewayHttpError(403, 'PRESET_NOT_ALLOWED', `preset "${preset}" is not in allowedPresets`)
    }
  }

  const ensureToolAllowedForCall = (toolName: string, args: unknown): void => {
    const policyWithoutReadOnly: ToolExposurePolicy = { ...config.policy, readOnly: false }
    if (!isToolAllowedByPolicy(toolName, policyWithoutReadOnly)) {
      throw new GatewayHttpError(403, 'TOOL_NOT_EXPOSED', `tool "${toolName}" is not exposed by the external gateway`)
    }
    if (isLiveActionBlocked(toolName, args)) {
      throw new GatewayHttpError(
        403,
        'TRADING_APPROVAL_REQUIRED',
        `live trading action "${toolName}" is blocked on the external gateway unless dryRun=true; live orders must be approved inside the interactive terminal`,
      )
    }
    if (config.policy.readOnly && isMutatingToolName(toolName)) {
      throw new GatewayHttpError(403, 'TOOL_READ_ONLY_BLOCKED', `mutating tool "${toolName}" is blocked when gateway readOnly=true`)
    }
  }

  const resolveTools = (): GatewayToolsServiceLike | undefined => {
    if (deps.tools !== undefined) return deps.tools()
    const ctx = deps.ctx()
    return (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown } | undefined)?.get?.('tools', false) as
      | GatewayToolsServiceLike
      | undefined
  }

  const withPresetScope = async <T>(
    presetId: string,
    fn: (tools: GatewayToolsServiceLike, scope: unknown, pipelineCtx: Context | undefined) => Promise<T>,
  ): Promise<T> => {
    ensurePresetAllowed(presetId)
    const pipelineCtx = deps.ctx()
    const tools = resolveTools()
    if (tools === undefined) {
      throw new GatewayHttpError(503, 'TOOLS_UNAVAILABLE', 'host tools service is not mounted')
    }
    const presets = deps.agentPresets?.()
    if (presets === undefined) {
      return fn(tools, undefined, pipelineCtx)
    }
    let lease: GatewayPresetScopeLease
    try {
      lease = await presets.acquireScope(presetId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new GatewayHttpError(404, 'PRESET_UNAVAILABLE', message)
    }
    try {
      return await fn(tools, lease.key, pipelineCtx)
    } finally {
      await lease[Symbol.asyncDispose]()
    }
  }

  const getSchemaPayload = async (preset: string, name?: string, family?: string, all = false) => {
    if (name) {
      if (!isToolAllowedByPolicy(name, config.policy)) {
        throw new GatewayHttpError(403, 'TOOL_NOT_EXPOSED', `tool "${name}" is not exposed by the external gateway`)
      }
      const tool = await withPresetScope(preset, async (tools, scope) =>
        tools.schemas(scope).find(schema => schema.name === name),
      )
      if (tool === undefined) {
        throw new GatewayHttpError(404, 'TOOL_NOT_FOUND', `tool "${name}" is not registered in preset "${preset}"`)
      }
      return { ok: true, preset, tool }
    }
    if (family) {
      const normalized = family.trim().toLowerCase()
      if (!isFamilyAllowedForListing(normalized, config.policy)) {
        throw new GatewayHttpError(403, 'TOOL_NOT_EXPOSED', `tool family "${family}" is not exposed by the external gateway`)
      }
      const matched = await withPresetScope(preset, async (tools, scope) =>
        tools
          .schemas(scope)
          .filter(schema => familyOfTool(schema.name).toLowerCase() === normalized && isToolAllowedByPolicy(schema.name, config.policy))
          .sort((a, b) => a.name.localeCompare(b.name)),
      )
      return { ok: true, preset, family: normalized, tools: matched }
    }
    if (all) {
      const matched = await withPresetScope(preset, async (tools, scope) =>
        tools
          .schemas(scope)
          .filter(schema => isToolAllowedByPolicy(schema.name, config.policy))
          .sort((a, b) => a.name.localeCompare(b.name)),
      )
      return { ok: true, preset, tools: matched }
    }
    throw new GatewayHttpError(400, 'INVALID_REQUEST', 'name, family, or all=1 query parameter is required')
  }

  const executeGatewayCall = async (options: {
    readonly name: string
    readonly arguments: Record<string, unknown>
    readonly preset: string
    readonly timeoutMs: number
    readonly signal?: AbortSignal | undefined
  }): Promise<GatewayCallOutcome> => {
    ensurePresetAllowed(options.preset)
    ensureToolAllowedForCall(options.name, options.arguments)

    const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
    const signal = options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal])

    const outcome = await withPresetScope(options.preset, async (tools, scope, pipelineCtx) => {
      const visible = tools.schemas(scope).some(schema => schema.name === options.name)
      if (!visible) {
        throw new GatewayHttpError(404, 'TOOL_NOT_FOUND', `tool "${options.name}" is not registered in preset "${options.preset}"`)
      }
      if (pipelineCtx === undefined) {
        throw new GatewayHttpError(503, 'TOOLS_UNAVAILABLE', 'host pipeline context is unavailable')
      }
      const callId = `gw-${++callCounter}`
      const pipeline = new ToolExecutionPipeline(pipelineCtx)
      const prepared = await pipeline.prepare({
        callId: callId as ToolCallId,
        name: options.name,
        arguments: options.arguments,
        ...(scope === undefined ? {} : { agent: scope as never }),
        parent: GATEWAY_PARENT_TOKEN,
        signal,
      })
      const dispatched = prepared.kind === 'dispatch'
        ? await pipeline.dispatch(prepared.exec)
        : prepared
      const result = await pipeline.complete(prepared.exec, dispatched)
      return { callId, result }
    })

    const text = extractTextContent(outcome.result.content)
    if (outcome.result.isError) {
      return {
        ok: false,
        tool: options.name,
        callId: outcome.callId,
        isError: true,
        code: outcome.result.error.info?.code ?? 'TOOL_EXECUTION_ERROR',
        message: outcome.result.error.message || text || 'tool execution failed',
        text,
        content: outcome.result.content,
      }
    }

    return {
      ok: true,
      tool: options.name,
      callId: outcome.callId,
      ...(outcome.result.value !== undefined ? { value: outcome.result.value } : {}),
      text,
      content: outcome.result.content,
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    let corsHeaders: Record<string, string> = {}

    try {
      if (!isHostAllowedByConfig(req.headers.host, config)) {
        throw new GatewayHttpError(403, 'FORBIDDEN_HOST', 'non-allowed Host header is rejected')
      }
      if (!isOriginAllowedByConfig(originHeader, config)) {
        throw new GatewayHttpError(403, 'FORBIDDEN_ORIGIN', 'non-allowed Origin header is rejected')
      }
      corsHeaders = buildCorsHeaders(originHeader, config.allowedOrigins)

      const method = req.method ?? 'GET'
      if (method === 'OPTIONS') {
        sendEmpty(
          res,
          204,
          buildCorsHeaders(originHeader, config.allowedOrigins, {
            'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
            'access-control-allow-headers': 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version',
            'access-control-max-age': '600',
          }),
        )
        return
      }

      if (!isAuthorizedBearer(req.headers.authorization, deps.token)) {
        throw new GatewayHttpError(401, 'UNAUTHORIZED', 'missing or invalid bearer token')
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname

      if (pathname === '/health') {
        if (method !== 'GET') throw new GatewayHttpError(405, 'METHOD_NOT_ALLOWED', 'GET required for /health')
        const toolCount = await withPresetScope(defaultPreset, async (tools, scope) =>
          tools.schemas(scope).filter(schema => isToolAllowedByPolicy(schema.name, config.policy)).length,
        )
        sendJson(res, 200, {
          ok: true,
          pid,
          preset: defaultPreset,
          toolCount,
          startedAt,
          protocols: protocolsForConfig(config),
          mcpDefaultMode: config.mcpDefaultMode,
          exposeMode: config.policy.exposeMode,
          readOnly: config.policy.readOnly,
          ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
        }, corsHeaders)
        return
      }

      if (pathname === '/openapi.json') {
        if (method !== 'GET') throw new GatewayHttpError(405, 'METHOD_NOT_ALLOWED', 'GET required for /openapi.json')
        const hostFallback = req.headers.host ? `http://${req.headers.host}` : 'http://127.0.0.1'
        const serverUrl = deps.advertisedUrl ?? config.publicUrl ?? hostFallback
        sendJson(
          res,
          200,
          buildGatewayOpenApiSpec({
            serverUrl,
            defaultPreset,
            mcpEnabled: config.mcpEnabled,
            mcpDefaultMode: config.mcpDefaultMode,
          }),
          corsHeaders,
        )
        return
      }

      if (pathname === '/index') {
        if (method !== 'GET') throw new GatewayHttpError(405, 'METHOD_NOT_ALLOWED', 'GET required for /index')
        const preset = url.searchParams.get('preset')?.trim() || defaultPreset
        const query = url.searchParams.get('query') ?? undefined
        const family = url.searchParams.get('family') ?? undefined
        const index = await withPresetScope(preset, async (tools, scope) =>
          buildGatewayToolIndex(tools.schemas(scope), query, family, {
            policy: config.policy,
            familyMeta: config.familyMeta,
          }),
        )
        sendJson(res, 200, { ok: true, preset, ...index }, corsHeaders)
        return
      }

      if (pathname === '/schema') {
        if (method !== 'GET') throw new GatewayHttpError(405, 'METHOD_NOT_ALLOWED', 'GET required for /schema')
        const preset = url.searchParams.get('preset')?.trim() || defaultPreset
        const name = url.searchParams.get('name')?.trim()
        const family = url.searchParams.get('family')?.trim()
        const allRaw = url.searchParams.get('all')?.trim().toLowerCase()
        const all = allRaw === '1' || allRaw === 'true'
        const payload = await getSchemaPayload(preset, name, family, all)
        sendJson(res, 200, payload, corsHeaders)
        return
      }

      if (pathname === '/call') {
        if (method !== 'POST') throw new GatewayHttpError(405, 'METHOD_NOT_ALLOWED', 'POST required for /call')
        const rawBody = await readJsonBody(req, config.maxBodyBytes)
        const parsed = parseCallPayload(rawBody, config.defaultTimeoutMs, config.maxTimeoutMs)
        const preset = parsed.preset ?? defaultPreset

        const disconnect = new AbortController()
        const hasSocketEvents = typeof res.on === 'function' && typeof res.off === 'function'
        const onClose = (): void => {
          if (!res.writableEnded) disconnect.abort(new Error('gateway client disconnected'))
        }
        if (hasSocketEvents) res.on('close', onClose)
        try {
          const outcome = await executeGatewayCall({
            name: parsed.name,
            arguments: parsed.arguments,
            preset,
            timeoutMs: parsed.timeoutMs,
            signal: disconnect.signal,
          })
          sendJson(res, 200, outcome, corsHeaders)
          return
        } finally {
          if (hasSocketEvents) res.off('close', onClose)
        }
      }

      if (pathname === '/mcp') {
        if (!config.mcpEnabled) {
          throw new GatewayHttpError(404, 'NOT_FOUND', 'MCP endpoint is disabled on this gateway')
        }
        if (method === 'GET') {
          sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'POST required for /mcp' }, {
            ...corsHeaders,
            allow: 'POST, DELETE, OPTIONS',
          })
          return
        }
        if (method === 'DELETE') {
          sendEmpty(res, 204, corsHeaders)
          return
        }
        if (method !== 'POST') {
          throw new GatewayHttpError(405, 'METHOD_NOT_ALLOWED', 'POST required for /mcp')
        }

        const modeParam = url.searchParams.get('mode')?.trim().toLowerCase()
        const mode: McpToolMode = modeParam === undefined || modeParam === ''
          ? config.mcpDefaultMode
          : (modeParam === 'index' || modeParam === 'flat'
              ? modeParam
              : (() => { throw new GatewayHttpError(400, 'INVALID_REQUEST', 'mode query parameter must be "index" or "flat"') })())
        const preset = url.searchParams.get('preset')?.trim() || defaultPreset
        ensurePresetAllowed(preset)
        const familyParam = url.searchParams.get('family')?.trim()
        const families = familyParam ? familyParam.split(',').map(f => f.trim().toLowerCase()).filter(Boolean) : undefined

        let rawBody: unknown
        try {
          rawBody = await readJsonBody(req, config.maxBodyBytes, true)
        } catch (error) {
          if (error instanceof GatewayHttpError && error.code === 'JSON_RPC_PARSE_ERROR') {
            sendJson(res, 400, {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: error.message },
            }, corsHeaders)
            return
          }
          throw error
        }

        const disconnect = new AbortController()
        const hasSocketEvents = typeof res.on === 'function' && typeof res.off === 'function'
        const onClose = (): void => {
          if (!res.writableEnded) disconnect.abort(new Error('gateway client disconnected'))
        }
        if (hasSocketEvents) res.on('close', onClose)
        try {
          const ops: McpGatewayOperations = {
            getIndex: async (targetPreset, query, family) => {
              const index = await withPresetScope(targetPreset, async (tools, scope) =>
                buildGatewayToolIndex(tools.schemas(scope), query, family, {
                  policy: config.policy,
                  familyMeta: config.familyMeta,
                }),
              )
              return { ok: true, preset: targetPreset, ...index }
            },
            getSchema: async (targetPreset, name, family) =>
              getSchemaPayload(targetPreset, name, family, false),
            listSchemas: async (targetPreset, filterFamilies) =>
              withPresetScope(targetPreset, async (tools, scope) => {
                const familySet = filterFamilies && filterFamilies.length > 0 ? new Set(filterFamilies) : undefined
                return tools.schemas(scope).filter(schema =>
                  isToolAllowedByPolicy(schema.name, config.policy)
                  && (familySet === undefined || familySet.has(familyOfTool(schema.name).toLowerCase())),
                )
              }),
            callTool: async (callReq) => {
              const timeoutMs = clampTimeoutMs(callReq.timeoutMs, config.defaultTimeoutMs, config.maxTimeoutMs)
              return executeGatewayCall({
                name: callReq.name,
                arguments: callReq.arguments,
                preset: callReq.preset,
                timeoutMs,
                signal: disconnect.signal,
              })
            },
          }

          const rpcRes = await handleMcpJsonRpc(rawBody, ops, { mode, preset, families })
          if (rpcRes.status === 202) {
            sendEmpty(res, 202, corsHeaders)
            return
          }
          sendJson(res, rpcRes.status, rpcRes.payload, corsHeaders)
          return
        } finally {
          if (hasSocketEvents) res.off('close', onClose)
        }
      }

      throw new GatewayHttpError(404, 'NOT_FOUND', `no such gateway endpoint: ${pathname}`)
    } catch (error) {
      if (error instanceof GatewayHttpError) {
        sendJson(res, error.status, { ok: false, code: error.code, message: error.message }, corsHeaders)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { ok: false, code: 'INTERNAL_ERROR', message }, corsHeaders)
    }
  }
}

export async function startToolGatewayServer(options: ToolGatewayStartOptions): Promise<ToolGatewayHandle> {
  const explicitOverrides: Record<string, unknown> = {
    ...(options.overrides ?? {}),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.defaultPreset === undefined ? {} : { defaultPreset: options.defaultPreset }),
    ...(options.descriptorPath === undefined ? {} : { descriptorPath: options.descriptorPath }),
  }

  const resolvedConfig = options.config ?? resolveToolGatewayConfig({
    dshHome: options.dshHome ?? dshHomeDir(),
    rowConfig: options.rowConfig,
    env: options.env,
    overrides: explicitOverrides as Partial<ToolGatewayConfigInput>,
  })

  const token = resolvedConfig.token ?? randomBytes(32).toString('hex')
  const startedAt = new Date().toISOString()

  const server = createServer()

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(resolvedConfig.port, resolvedConfig.host)
  })

  const addr = server.address() as AddressInfo | null
  if (addr === null || typeof addr === 'string') {
    server.close()
    throw new Error('tool gateway failed to resolve bound port')
  }
  const port = addr.port
  const { boundUrl, advertisedUrl } = defaultDescriptorUrls(resolvedConfig.host, port, resolvedConfig.publicUrl)

  const handler = createToolGatewayHandler({
    ctx: options.ctx,
    tools: options.tools,
    agentPresets: options.agentPresets,
    token,
    defaultPreset: resolvedConfig.defaultPreset,
    startedAt,
    pid: process.pid,
    config: resolvedConfig,
    advertisedUrl,
  })
  server.on('request', (req, res) => {
    void handler(req, res)
  })

  const descriptorPath = resolvedConfig.descriptorPath
  if (descriptorPath !== null) {
    const descriptor: ToolGatewayDescriptor = {
      version: 1,
      pid: process.pid,
      host: resolvedConfig.host,
      port,
      url: boundUrl,
      ...(resolvedConfig.publicUrl === undefined ? {} : { publicUrl: resolvedConfig.publicUrl }),
      token,
      preset: resolvedConfig.defaultPreset,
      protocols: protocolsForConfig(resolvedConfig),
      mcpDefaultMode: resolvedConfig.mcpDefaultMode,
      readOnly: resolvedConfig.policy.readOnly,
      startedAt,
    }
    try {
      await writeJsonAtomic(descriptorPath, descriptor, '[dsh-trading/tool-gateway] failed to write descriptor to')
      await chmod(descriptorPath, 0o600)
    } catch (error) {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
      throw error
    }
  }

  let disposed = false
  return {
    url: boundUrl,
    advertisedUrl,
    host: resolvedConfig.host,
    port,
    token,
    descriptorPath,
    config: resolvedConfig,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      server.closeAllConnections?.()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
      if (descriptorPath === null) return
      try {
        const raw = readFileSync(descriptorPath, 'utf8')
        const current = JSON.parse(raw) as { pid?: unknown }
        if (current?.pid === process.pid) {
          rmSync(descriptorPath, { force: true })
        }
      } catch {
        // 已被外部删掉或不可读时静默跳过，绝不误删别的活宿主写的新描述文件。
      }
    },
  }
}
