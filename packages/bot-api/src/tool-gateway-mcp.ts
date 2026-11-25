/**
 * 外部工具调用网关的 Streamable HTTP MCP 与 OpenAPI 3.1 协议适配层。
 *
 * 工程约束：
 * - 零外部 MCP SDK 依赖：直接实现标准 JSON-RPC 2.0 握手与 `tools/list`/`tools/call`，
 *   保持 `@dshtrading/bot-api` 运行时零额外依赖包；
 * - 支持两种工具投影模式：
 *   - `index`（默认）：只暴露 3 个轻量元工具（`dsh_trading_index`/`dsh_trading_schema`/`dsh_trading_call`），
 *     避免把 130+ 工具 schema 灌满外部 Agent 上下文；
 *   - `flat`（可按 `?family=cn,holdings` 过滤）：把策略允许的工具直接展开为平铺 MCP 工具，
 *     供偏好原生态工具列表的 Agent/IDE 开箱即用；
 * - 实盘安全闸门 `TRADING_APPROVAL_REQUIRED`、只读策略与预设白名单统一由网关操作回调强制执行，
 *   拒绝结果以标准 MCP `isError: true` 文本块返回，不断开传输通道。
 *
 * @module @dshtrading/bot-api/tool-gateway-mcp
 */
import type { GatewayToolSchema, McpToolMode } from './tool-gateway-config.ts'
import { familyOfToolName } from './tool-gateway-config.ts'

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'] as const

export interface GatewayCallOutcome {
  readonly ok: boolean
  readonly tool: string
  readonly callId?: string | undefined
  readonly value?: unknown
  readonly text?: string | undefined
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }> | undefined
  readonly isError?: boolean | undefined
  readonly code?: string | undefined
  readonly message?: string | undefined
}

export interface McpGatewayOperations {
  getIndex(preset: string, query?: string, family?: string, allowedFamilies?: readonly string[]): Promise<unknown>
  getSchema(preset: string, name?: string, family?: string): Promise<unknown>
  listSchemas(preset: string, families?: readonly string[]): Promise<readonly GatewayToolSchema[]>
  callTool(options: {
    readonly name: string
    readonly arguments: Record<string, unknown>
    readonly preset: string
    readonly timeoutMs?: number | undefined
  }): Promise<GatewayCallOutcome>
}

export interface McpHttpResult {
  readonly status: 200 | 202 | 400
  readonly payload?: unknown
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCodeMessage(error: unknown): { readonly code: string; readonly message: string } {
  if (isPlainRecord(error)) {
    const code = typeof error.code === 'string' && error.code ? error.code : 'GATEWAY_ERROR'
    const message = typeof error.message === 'string' && error.message ? error.message : 'gateway operation failed'
    return { code, message }
  }
  return {
    code: 'GATEWAY_ERROR',
    message: error instanceof Error ? error.message : String(error),
  }
}

function mcpTextResult(payload: unknown, isError = false): {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
  readonly isError?: boolean | undefined
} {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] }
}

/** 把工具原始 parameters 规范化为标准 JSON Schema `object` 以满足 MCP `inputSchema` 契约。 */
export function normalizeMcpInputSchema(parameters: unknown): Record<string, unknown> {
  if (!isPlainRecord(parameters)) {
    return { type: 'object', properties: {} }
  }
  if (parameters.type === 'object') {
    return isPlainRecord(parameters.properties)
      ? parameters
      : { ...parameters, properties: {} }
  }
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, def] of Object.entries(parameters)) {
    if (isPlainRecord(def)) {
      const { required: isReq, ...rest } = def
      properties[key] = rest
      if (isReq === true) required.push(key)
    } else {
      properties[key] = def
    }
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

const INDEX_META_TOOLS = [
  {
    name: 'dsh_trading_index',
    description:
      'Discover available dsh-trading tools grouped by family. Call this first when you need market quotes, '
      + 'klines, fundamentals, news/flash, holdings, watchlists, indicators, strategy backtests, screeners, '
      + 'knowledge cards, or dry-run orders.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional keyword filter across family labels, usage notes, and tool names.' },
        family: { type: 'string', description: 'Optional exact family prefix such as cn, us, hk, crypto, holdings, strategy.' },
        preset: { type: 'string', description: 'Optional target preset scope (defaults to gateway default preset).' },
      },
    },
  },
  {
    name: 'dsh_trading_schema',
    description: 'Inspect the parameter JSON schema of a specific dsh-trading tool or all tools in a family.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact tool name, e.g. cn_get_ticker or holdings_list.' },
        family: { type: 'string', description: 'Inspect all tools in one family instead of a single tool.' },
        preset: { type: 'string', description: 'Optional target preset scope.' },
      },
    },
  },
  {
    name: 'dsh_trading_call',
    description:
      'Invoke any allowed dsh-trading tool deterministically via the live host. Live order/leverage actions '
      + 'without dryRun=true are always blocked (TRADING_APPROVAL_REQUIRED).',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Exact registered tool name from dsh_trading_index.' },
        arguments: { type: 'object', description: 'Arguments object matching dsh_trading_schema.' },
        preset: { type: 'string', description: 'Optional target preset scope.' },
        timeoutMs: { type: 'integer', description: 'Optional call timeout in milliseconds.' },
      },
    },
  },
] as const

const INDEX_META_TOOL_NAMES: ReadonlySet<string> = new Set([
  'dsh_trading_index',
  'dsh_trading_schema',
  'dsh_trading_call',
])

function filterByFamilies(
  schemas: readonly GatewayToolSchema[],
  families: readonly string[] | undefined,
): readonly GatewayToolSchema[] {
  if (families === undefined || families.length === 0) return schemas
  const allowed = new Set(families.map(f => f.trim().toLowerCase()).filter(Boolean))
  if (allowed.size === 0) return schemas
  return schemas.filter(schema => allowed.has(familyOfToolName(schema.name).toLowerCase()))
}

/** 处理单条 MCP JSON-RPC 2.0 请求或通知。 */
export async function handleMcpJsonRpc(
  rawPayload: unknown,
  ops: McpGatewayOperations,
  requestOptions: {
    readonly mode: McpToolMode
    readonly preset: string
    readonly families?: readonly string[] | undefined
  },
): Promise<McpHttpResult> {
  if (!isPlainRecord(rawPayload) || rawPayload.jsonrpc !== '2.0' || typeof rawPayload.method !== 'string') {
    return {
      status: 400,
      payload: {
        jsonrpc: '2.0',
        id: isPlainRecord(rawPayload) && 'id' in rawPayload ? (rawPayload.id ?? null) : null,
        error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
      },
    }
  }

  const hasId = 'id' in rawPayload && rawPayload.id !== undefined
  const id = rawPayload.id as string | number | null | undefined
  const method = rawPayload.method
  const params = rawPayload.params

  // JSON-RPC 通知（无 id）：按 Streamable HTTP 规范返回 202 无响应体。
  if (!hasId) {
    return { status: 202 }
  }

  const rpcOk = (result: unknown): McpHttpResult => ({
    status: 200,
    payload: { jsonrpc: '2.0', id: id ?? null, result },
  })
  const rpcErr = (code: number, message: string): McpHttpResult => ({
    status: 200,
    payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
  })

  if (method === 'initialize') {
    const requested = isPlainRecord(params) && typeof params.protocolVersion === 'string'
      ? params.protocolVersion
      : undefined
    const protocolVersion = requested && (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : SUPPORTED_MCP_PROTOCOL_VERSIONS[0]
    return rpcOk({
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: 'dsh-trading-tool-gateway',
        version: '1.0.0',
      },
      instructions:
        'Connected to the live dsh-trading host gateway. In index mode, call dsh_trading_index -> '
        + 'dsh_trading_schema -> dsh_trading_call. Live order actions require dryRun=true.',
    })
  }

  if (method === 'ping') {
    return rpcOk({})
  }

  if (method === 'tools/list') {
    if (requestOptions.mode === 'index') {
      return rpcOk({ tools: INDEX_META_TOOLS })
    }
    try {
      const schemas = await ops.listSchemas(requestOptions.preset, requestOptions.families)
      const tools = schemas
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(schema => ({
          name: schema.name,
          description: schema.description ?? '',
          inputSchema: normalizeMcpInputSchema(schema.parameters),
        }))
      return rpcOk({ tools })
    } catch (error) {
      const { code, message } = errorCodeMessage(error)
      return rpcErr(-32603, `${code}: ${message}`)
    }
  }

  if (method === 'tools/call') {
    if (!isPlainRecord(params) || typeof params.name !== 'string' || params.name.trim() === '') {
      return rpcErr(-32602, 'tools/call params.name must be a non-empty string')
    }
    if (params.arguments !== undefined && !isPlainRecord(params.arguments)) {
      return rpcErr(-32602, 'tools/call params.arguments must be a plain object')
    }
    const callName = params.name.trim()
    const callArgs = isPlainRecord(params.arguments) ? params.arguments : {}
    const familyScope = requestOptions.families && requestOptions.families.length > 0
      ? new Set(requestOptions.families.map(f => f.trim().toLowerCase()).filter(Boolean))
      : undefined

    try {
      if (requestOptions.mode === 'flat' && INDEX_META_TOOL_NAMES.has(callName)) {
        return rpcOk(mcpTextResult({
          ok: false,
          code: 'TOOL_OUT_OF_SCOPE',
          message: `meta tool "${callName}" is unavailable in flat MCP mode`,
        }, true))
      }

      if (callName === 'dsh_trading_index') {
        const preset = typeof callArgs.preset === 'string' && callArgs.preset.trim()
          ? callArgs.preset.trim()
          : requestOptions.preset
        const query = typeof callArgs.query === 'string' ? callArgs.query : undefined
        const family = typeof callArgs.family === 'string' && callArgs.family.trim()
          ? callArgs.family.trim()
          : undefined
        if (familyScope !== undefined && family !== undefined && !familyScope.has(family.toLowerCase())) {
          return rpcOk(mcpTextResult({
            ok: false,
            code: 'TOOL_OUT_OF_SCOPE',
            message: `tool family "${family}" is outside this MCP endpoint's family filter`,
          }, true))
        }
        const index = await ops.getIndex(preset, query, family, familyScope ? [...familyScope] : undefined)
        return rpcOk(mcpTextResult(index))
      }

      if (callName === 'dsh_trading_schema') {
        const preset = typeof callArgs.preset === 'string' && callArgs.preset.trim()
          ? callArgs.preset.trim()
          : requestOptions.preset
        const name = typeof callArgs.name === 'string' && callArgs.name.trim() ? callArgs.name.trim() : undefined
        const family = typeof callArgs.family === 'string' && callArgs.family.trim() ? callArgs.family.trim() : undefined
        if (!name && !family) {
          return rpcOk(mcpTextResult({ ok: false, code: 'INVALID_REQUEST', message: 'name or family is required' }, true))
        }
        if (name && family) {
          return rpcOk(mcpTextResult({ ok: false, code: 'INVALID_REQUEST', message: 'specify either name or family, not both' }, true))
        }
        if (familyScope !== undefined) {
          const targetFamily = name ? familyOfToolName(name).toLowerCase() : family!.toLowerCase()
          if (!familyScope.has(targetFamily)) {
            return rpcOk(mcpTextResult({
              ok: false,
              code: 'TOOL_OUT_OF_SCOPE',
              message: `schema request for "${name ?? family}" is outside this MCP endpoint's family filter`,
            }, true))
          }
        }
        const schema = await ops.getSchema(preset, name, family)
        return rpcOk(mcpTextResult(schema))
      }

      let targetName = callName
      let targetArgs = callArgs
      let targetPreset = requestOptions.preset
      let targetTimeoutMs: number | undefined

      if (callName === 'dsh_trading_call') {
        if (typeof callArgs.name !== 'string' || callArgs.name.trim() === '') {
          return rpcOk(mcpTextResult({ ok: false, code: 'INVALID_REQUEST', message: 'dsh_trading_call requires string "name"' }, true))
        }
        if (callArgs.arguments !== undefined && !isPlainRecord(callArgs.arguments)) {
          return rpcOk(mcpTextResult({ ok: false, code: 'INVALID_REQUEST', message: 'dsh_trading_call "arguments" must be an object' }, true))
        }
        targetName = callArgs.name.trim()
        targetArgs = isPlainRecord(callArgs.arguments) ? callArgs.arguments : {}
        if (typeof callArgs.preset === 'string' && callArgs.preset.trim()) {
          targetPreset = callArgs.preset.trim()
        }
        if (typeof callArgs.timeoutMs === 'number' && Number.isFinite(callArgs.timeoutMs)) {
          targetTimeoutMs = callArgs.timeoutMs
        }
      }

      if (requestOptions.families !== undefined && requestOptions.families.length > 0) {
        const matched = filterByFamilies([{ name: targetName }], requestOptions.families)
        if (matched.length === 0) {
          return rpcOk(mcpTextResult({
            ok: false,
            code: 'TOOL_OUT_OF_SCOPE',
            message: `tool "${targetName}" is outside this MCP endpoint's family filter`,
          }, true))
        }
      }

      const outcome = await ops.callTool({
        name: targetName,
        arguments: targetArgs,
        preset: targetPreset,
        ...(targetTimeoutMs === undefined ? {} : { timeoutMs: targetTimeoutMs }),
      })

      if (!outcome.ok) {
        return rpcOk(mcpTextResult({
          ok: false,
          tool: outcome.tool,
          code: outcome.code ?? 'TOOL_EXECUTION_ERROR',
          message: outcome.message ?? outcome.text ?? 'tool execution failed',
        }, true))
      }

      if (outcome.content !== undefined && outcome.content.length > 0) {
        return rpcOk({ content: outcome.content })
      }
      return rpcOk(mcpTextResult(outcome.value ?? outcome.text ?? { ok: true }))
    } catch (error) {
      const { code, message } = errorCodeMessage(error)
      return rpcOk(mcpTextResult({ ok: false, code, message }, true))
    }
  }

  return rpcErr(-32601, `Method not found: ${method}`)
}

/** 生成外部 REST / Agent 平台（n8n、Dify、Coze、OpenAPI Client 等）可直接消费的 OpenAPI 3.1.0 规范。 */
export function buildGatewayOpenApiSpec(options: {
  readonly serverUrl: string
  readonly defaultPreset: string
  readonly mcpEnabled: boolean
  readonly mcpDefaultMode: McpToolMode
}): Record<string, unknown> {
  const paths: Record<string, unknown> = {
    '/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Gateway health, supported protocols, active preset, and exposed tool count',
        responses: {
          '200': { description: 'Healthy gateway status' },
        },
      },
    },
    '/index': {
      get: {
        operationId: 'listToolIndex',
        summary: 'List exposed trading tool families and compact tool descriptions',
        parameters: [
          { name: 'query', in: 'query', schema: { type: 'string' }, description: 'Keyword filter' },
          { name: 'family', in: 'query', schema: { type: 'string' }, description: 'Exact tool family filter' },
          { name: 'preset', in: 'query', schema: { type: 'string', default: options.defaultPreset } },
        ],
        responses: {
          '200': { description: 'Grouped tool index' },
        },
      },
    },
    '/schema': {
      get: {
        operationId: 'getToolSchema',
        summary: 'Inspect parameter JSON schemas for one tool, a family, or all exposed tools',
        parameters: [
          { name: 'name', in: 'query', schema: { type: 'string' } },
          { name: 'family', in: 'query', schema: { type: 'string' } },
          { name: 'all', in: 'query', schema: { type: 'string', enum: ['1', 'true'] } },
          { name: 'preset', in: 'query', schema: { type: 'string', default: options.defaultPreset } },
        ],
        responses: {
          '200': { description: 'Tool schema definition(s)' },
        },
      },
    },
    '/call': {
      post: {
        operationId: 'callTool',
        summary: 'Invoke a trading or research tool deterministically on the live host',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', description: 'Exact tool name, e.g. cn_get_ticker' },
                  arguments: { type: 'object', additionalProperties: true, default: {} },
                  preset: { type: 'string', default: options.defaultPreset },
                  timeoutMs: { type: 'integer', minimum: 1000 },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Tool invocation result (ok=true or ok=false tool error)' },
          '403': { description: 'Blocked by tool policy or live-trading approval invariant (TRADING_APPROVAL_REQUIRED)' },
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'getOpenApiSpec',
        summary: 'OpenAPI 3.1.0 specification for this gateway',
        responses: {
          '200': { description: 'OpenAPI specification document' },
        },
      },
    },
  }

  if (options.mcpEnabled) {
    paths['/mcp'] = {
      post: {
        operationId: 'handleMcpRequest',
        summary: `Streamable HTTP MCP JSON-RPC 2.0 endpoint (default mode: ${options.mcpDefaultMode})`,
        parameters: [
          { name: 'mode', in: 'query', schema: { type: 'string', enum: ['index', 'flat'], default: options.mcpDefaultMode } },
          { name: 'family', in: 'query', schema: { type: 'string' }, description: 'Comma-separated families to project in flat mode' },
          { name: 'preset', in: 'query', schema: { type: 'string', default: options.defaultPreset } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jsonrpc', 'method'],
                properties: {
                  jsonrpc: { type: 'string', enum: ['2.0'] },
                  id: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
                  method: { type: 'string' },
                  params: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'JSON-RPC 2.0 response' },
          '202': { description: 'JSON-RPC 2.0 notification accepted' },
        },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'dsh-trading External Tool Gateway',
      version: '1.0.0',
      description:
        'Authenticated HTTP, OpenAPI, and Streamable HTTP MCP gateway exposing live dsh-trading tools. '
        + 'Live order and leverage mutations without dryRun=true are always blocked (TRADING_APPROVAL_REQUIRED).',
    },
    servers: [{ url: options.serverUrl }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
  }
}
