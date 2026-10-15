/**
 * MCP 传输层（Streamable HTTP / JSON-RPC 2.0）。
 *
 * 标准流程（用户 2026-09-13 给定契约，本出口实测复核）：
 *   initialize → notifications/initialized → tools/list / resources/read → tools/call
 * 响应形态两种都要吃：`application/json` 直出 JSON，或 `text/event-stream` 里
 * `event: message` + 单行 `data: {…}`（金十本出口实测为后者）。若上游回
 * `mcp-session-id` 头则后续请求原样回带（本出口当前无会话头，属可选能力）。
 *
 * 结果读取：`result.structuredContent` 优先，`result.content[].text` 仅在
 * structuredContent 缺席时作可读文本兜底（用户契约 3/4）。
 *
 * 握手契约（官方 MCP revision 2025-11-25 / 2025-06-18，本仓 spike 原始证据
 * `spikes/impl-jin10-mcp/EVIDENCE/01-initialize.json`）：客户端必须校验 initialize
 * 结果里的 `protocolVersion` 与 `capabilities`；协商版本用于其后每个 HTTP 请求的
 * `MCP-Protocol-Version` 头；未声明 `tools` / `resources` 能力时对应方法族直接报
 * 结构化契约错误，不发业务请求（不重造宿主 MCP、不升级 SDK）。
 */
import { Jin10Error, Jin10McpContractError, TOKEN_HINT, codeForUpstreamMessage } from './errors.js'

export const DEFAULT_ENDPOINT = 'https://mcp.jin10.com/mcp'
export const DEFAULT_PROTOCOL_VERSION = '2025-11-25'
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * 本客户端能说的 Streamable HTTP 协议版本（官方 revision）：
 * - `2025-11-25`：金十本出口 spike 实测协商版本；
 * - `2025-06-18`：官方首个定义 `MCP-Protocol-Version` 头的 revision。
 * 上游协商出集合之外的版本时按官方「客户端 SHOULD disconnect」报结构化错误，
 * 不降级猜测协议语义。
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze(['2025-11-25', '2025-06-18'])

/** initialize 之后每个 HTTP 请求都必须携带的协商版本头（官方 Streamable HTTP）。 */
export const PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version'

/** 服务端能力 → 依赖它的 JSON-RPC 方法族（缺能力即拒发，不靠上游 4xx 兜底）。 */
const METHOD_CAPABILITY: Readonly<Partial<Record<string, 'tools' | 'resources'>>> = Object.freeze({
  'tools/list': 'tools',
  'tools/call': 'tools',
  'resources/read': 'resources',
  'resources/templates/list': 'resources',
})

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
}

/** 可读文本段（structuredContent 缺席时的兜底来源）。 */
export interface McpContentPart {
  type?: string
  text?: string
}

/** `tools/call` 的原始结果（structuredContent 优先，content 只作文本兜底）。 */
export interface McpToolResult {
  structuredContent?: unknown
  content?: readonly McpContentPart[]
  isError?: boolean
}

export interface Jin10McpOptions {
  endpoint?: string
  /** 惰性凭证源：每次请求解析（settings 热切换/异步加载晚于插件 apply 亦生效）。 */
  token: () => string | undefined
  /** 单次请求超时（ms），缺省 15s。 */
  timeoutMs?: number
  /** 依赖注入的 fetch（测试用 mock；缺省 globalThis.fetch）。 */
  fetchImpl?: typeof globalThis.fetch
  /** 可选会话级取消信号：与单次请求超时合并，取消报「request aborted」。 */
  signal?: AbortSignal
  /** 协议版本（缺省 2025-11-25）。 */
  protocolVersion?: string
  clientName?: string
  clientVersion?: string
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown; data?: unknown }
}

/** 把响应体解析成 JSON-RPC 消息（直出 JSON 或 SSE 单行 data 均可）。 */
export function parseMcpBody(text: string): JsonRpcMessage | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.startsWith('{')) {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) ? (parsed as JsonRpcMessage) : undefined
  }
  const candidates: JsonRpcMessage[] = []
  const pending: string[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    const payload = pending.join('\n').trim()
    pending.length = 0
    if (payload.length === 0) return
    try {
      const parsed: unknown = JSON.parse(payload)
      if (isRecord(parsed)) candidates.push(parsed as JsonRpcMessage)
    } catch {
      // 非 JSON 的 data 行不是合法 MCP 消息，忽略；若整段无合法消息会在下面报错。
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith('data:')) pending.push(line.slice(5).replace(/^ /, ''))
    else if (line.trim().length === 0) flush()
  }
  flush()
  const message = candidates[candidates.length - 1]
  if (message === undefined) throw new Jin10Error('TRADING_EXCHANGE_ERROR', `jin10 mcp: response is neither JSON nor a JSON-RPC SSE message — ${trimmed.slice(0, 200)}`)
  return message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 传输层失败：超时与取消分别显式标注（前者带超时窗口，后者标明调用方取消），
 * 不混成一句 network failure，也不在这里重试（重试由调用方显式发起）。
 */
function networkError(method: string, cause: unknown, timeoutMs: number): Jin10Error {
  const reason = cause instanceof Error ? cause.message : String(cause)
  const name = cause instanceof Error ? cause.name : ''
  if (name === 'TimeoutError') return new Jin10Error('TRADING_NETWORK', `jin10 mcp ${method}: request timed out after ${timeoutMs}ms`, cause)
  if (name === 'AbortError') return new Jin10Error('TRADING_NETWORK', `jin10 mcp ${method}: request aborted before completion — ${reason}`, cause)
  return new Jin10Error('TRADING_NETWORK', `jin10 mcp ${method}: network failure — ${reason}`, cause)
}

export class Jin10McpClient {
  private readonly endpoint: string
  private readonly token: () => string | undefined
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly protocolVersion: string
  private readonly clientName: string
  private readonly clientVersion: string
  private readonly signal: AbortSignal | undefined
  private nextId = 1
  private sessionId: string | undefined
  private handshake: Promise<void> | undefined
  /** initialize 协商出的协议版本（其后每个请求的 MCP-Protocol-Version 头来源）。 */
  private negotiatedProtocolVersion: string | undefined
  /** initialize 声明的服务端能力表（方法族能力闸门的判据）。 */
  private serverCapabilities: Record<string, unknown> | undefined

  constructor(options: Jin10McpOptions) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.signal = options.signal
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
    this.clientName = options.clientName ?? 'dsh-trading-connector-jin10'
    this.clientVersion = options.clientVersion ?? '0.2.1'
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = await this.rpc('tools/list', {})
    const tools = isRecord(result) ? result.tools : undefined
    if (!Array.isArray(tools)) throw new Jin10Error('TRADING_EXCHANGE_ERROR', 'jin10 mcp tools/list: unexpected payload (expected result.tools[])')
    return tools.filter(isRecord).map((tool) => ({
      name: String(tool.name ?? ''),
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    }))
  }

  /** 读资源正文（quote://codes 等；返回全部 text 段拼接）。 */
  async readResource(uri: string): Promise<string> {
    const result = await this.rpc('resources/read', { uri })
    const contents = isRecord(result) ? result.contents : undefined
    if (!Array.isArray(contents)) throw new Jin10Error('TRADING_EXCHANGE_ERROR', `jin10 mcp resources/read ${uri}: unexpected payload (expected result.contents[])`)
    return contents.filter(isRecord).map((entry) => (typeof entry.text === 'string' ? entry.text : '')).join('')
  }

  /** 原始 tools/call（不做业务解包；协议/HTTP 错误在此抛出）。 */
  async callTool(tool: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const result = await this.rpc('tools/call', { name: tool, arguments: args })
    if (!isRecord(result)) throw new Jin10Error('TRADING_EXCHANGE_ERROR', `jin10 mcp tools/call ${tool}: unexpected payload (expected result object)`)
    return {
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(Array.isArray(result.content) ? { content: result.content.filter(isRecord) as McpContentPart[] } : {}),
      ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}),
    }
  }

  /**
   * 业务取数：structuredContent 优先，text 兜底；`isError`/`status !== 200`/`data === null`
   * 都按上游业务错误抛出（含限流文案识别）。返回上游 `data` 字段。
   */
  async callToolData(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.callTool(tool, args)
    const envelope = result.structuredContent ?? textEnvelope(result)
    if (envelope === undefined) {
      throw new Jin10Error('TRADING_EXCHANGE_ERROR', `jin10 mcp tools/call ${tool}: no structuredContent and no machine-readable text payload`)
    }
    if (!isRecord(envelope)) throw new Jin10Error('TRADING_EXCHANGE_ERROR', `jin10 mcp tools/call ${tool}: unexpected payload (expected an object envelope)`)
    const message = typeof envelope.message === 'string' ? envelope.message : ''
    const status = typeof envelope.status === 'number' ? envelope.status : undefined
    if (result.isError === true) {
      throw new Jin10Error(codeForUpstreamMessage(message), `jin10 ${tool}: ${message || 'upstream reported isError=true'}${status !== undefined ? ` (status ${status})` : ''}`)
    }
    if (status !== undefined && status !== 200) {
      throw new Jin10Error(codeForUpstreamMessage(message), `jin10 ${tool}: upstream status ${status}${message ? ` — ${message}` : ''}`)
    }
    if (envelope.data === null || envelope.data === undefined) {
      throw new Jin10Error(codeForUpstreamMessage(message), `jin10 ${tool}: upstream returned no data${message ? ` — ${message}` : ''}`)
    }
    return envelope.data
  }

  private async ensureHandshake(): Promise<void> {
    if (this.handshake === undefined) {
      // 失败即清空：凭证后配/上游恢复后，下一次调用可重新完整握手（不做失败缓存）；
      // 半完成状态（协商版本/能力集/会话头）一并重置，避免拿坏会话发业务请求。
      this.handshake = this.performHandshake().catch((error: unknown) => {
        this.handshake = undefined
        this.resetHandshakeState()
        throw error
      })
    }
    return this.handshake
  }

  /** 丢弃一次未完成的握手留下的全部状态（initialize 之后、initialized 之前的任何失败）。 */
  private resetHandshakeState(): void {
    this.negotiatedProtocolVersion = undefined
    this.serverCapabilities = undefined
    this.sessionId = undefined
  }

  private async performHandshake(): Promise<void> {
    const result = await this.rpc('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    }, { skipHandshake: true })
    // 先校验并落协商版本，initialized 通知本身才带得上 MCP-Protocol-Version 头。
    this.serverCapabilities = this.acceptInitializeResult(result)
    await this.rpc('notifications/initialized', undefined, { notification: true, skipHandshake: true })
  }

  /**
   * 校验 initialize 结果并返回服务端能力表；违反官方 lifecycle 契约时抛结构化错误。
   * 依据：官方 revision 2025-11-25 lifecycle——服务端 MUST 回 protocolVersion 与
   * capabilities；客户端不支持的协商版本 SHOULD disconnect。
   */
  private acceptInitializeResult(result: unknown): Record<string, unknown> {
    if (!isRecord(result)) {
      throw new Jin10McpContractError(
        { kind: 'initialize_result_invalid', method: 'initialize', detail: 'result is not an object' },
        'jin10 mcp initialize: result is not an object',
      )
    }
    const negotiated = result.protocolVersion
    if (typeof negotiated !== 'string' || negotiated.trim().length === 0) {
      throw new Jin10McpContractError(
        { kind: 'initialize_result_invalid', method: 'initialize', detail: 'missing protocolVersion' },
        'jin10 mcp initialize: server did not return a protocolVersion',
      )
    }
    const supported = this.supportedVersions()
    if (!supported.includes(negotiated)) {
      throw new Jin10McpContractError(
        { kind: 'unsupported_protocol_version', method: 'initialize', requestedVersion: this.protocolVersion, negotiatedVersion: negotiated, supportedVersions: supported },
        `jin10 mcp initialize: server negotiated unsupported protocol version "${negotiated}" (client supports ${supported.join(', ')})`,
      )
    }
    const capabilities = result.capabilities
    if (!isRecord(capabilities)) {
      throw new Jin10McpContractError(
        { kind: 'initialize_result_invalid', method: 'initialize', detail: 'missing capabilities' },
        'jin10 mcp initialize: server did not return a capabilities object',
      )
    }
    this.negotiatedProtocolVersion = negotiated
    return capabilities
  }

  /** 客户端可接受的协商版本：声明的版本 + 官方可说的版本集合。 */
  private supportedVersions(): readonly string[] {
    return SUPPORTED_PROTOCOL_VERSIONS.includes(this.protocolVersion)
      ? SUPPORTED_PROTOCOL_VERSIONS
      : Object.freeze([this.protocolVersion, ...SUPPORTED_PROTOCOL_VERSIONS])
  }

  /** 方法族能力闸门：能力未声明时在发请求前抛结构化错误（缺能力 ≠ 上游 4xx）。 */
  private assertMethodCapability(method: string): void {
    const capability = METHOD_CAPABILITY[method]
    if (capability === undefined) return
    const declared = this.serverCapabilities
    if (declared !== undefined && isRecord(declared[capability])) return
    throw new Jin10McpContractError(
      { kind: 'missing_capability', method, capability },
      `jin10 mcp ${method}: server did not declare the "${capability}" capability during initialize; refusing to send the request`,
    )
  }

  /** 单次请求信号：调用方取消信号与超时窗口合并，任一触发都以 AbortError 结束。 */
  private requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    if (this.signal === undefined) return timeout
    return AbortSignal.any([this.signal, timeout])
  }

  private async rpc(
    method: string,
    params: unknown,
    options: { notification?: boolean; skipHandshake?: boolean } = {},
  ): Promise<unknown> {
    if (options.skipHandshake !== true) {
      await this.ensureHandshake()
      // 能力闸门在建连之后、发请求之前：缺 tools/resources 能力时直接报契约错误。
      this.assertMethodCapability(method)
    }
    const token = this.token()
    if (token === undefined || token.trim().length === 0) {
      throw new Jin10Error('TRADING_CREDENTIALS_MISSING', `jin10 mcp ${method}: missing MCP token. ${TOKEN_HINT}`)
    }
    const payload: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (options.notification !== true) payload.id = this.nextId++
    if (params !== undefined) payload.params = params
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token.trim()}`,
          // 官方 Streamable HTTP：initialize 之后的每个请求都要带协商版本头。
          ...(this.negotiatedProtocolVersion !== undefined ? { [PROTOCOL_VERSION_HEADER]: this.negotiatedProtocolVersion } : {}),
          ...(this.sessionId !== undefined ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify(payload),
        signal: this.requestSignal(),
      })
    } catch (error) {
      throw networkError(method, error, this.timeoutMs)
    }
    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId !== null && sessionId.length > 0) this.sessionId = sessionId
    if (response.status === 401 || response.status === 403) {
      const body = await response.text().catch(() => '')
      throw new Jin10Error('TRADING_AUTH_FAILED', `jin10 mcp ${method}: HTTP ${response.status} — invalid or expired MCP token. ${TOKEN_HINT}${body ? ` (${body.slice(0, 160)})` : ''}`)
    }
    if (response.status === 429) {
      const body = await response.text().catch(() => '')
      throw new Jin10Error('TRADING_RATE_LIMITED', `jin10 mcp ${method}: HTTP 429 — rate limited${body ? ` — ${body.slice(0, 160)}` : ''}`)
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Jin10Error('TRADING_EXCHANGE_ERROR', `jin10 mcp ${method}: HTTP ${response.status}${body ? ` — ${body.slice(0, 200)}` : ''}`)
    }
    const text = await response.text().catch((error: unknown) => { throw networkError(method, error, this.timeoutMs) })
    const message = parseMcpBody(text)
    if (message === undefined) return undefined
    if (isRecord(message.error)) {
      const code = codeOf(message.error.code)
      const detail = typeof message.error.message === 'string' ? message.error.message : 'JSON-RPC error'
      throw new Jin10Error('TRADING_EXCHANGE_ERROR', `jin10 mcp ${method}: JSON-RPC error ${code ?? ''} — ${detail}`.replace('  ', ' '), message.error)
    }
    return message.result
  }
}

function codeOf(value: unknown): number | string | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined
}

/** structuredContent 缺席时的可读文本兜底：content[].text 若能解析成 JSON 信封则采用。 */
function textEnvelope(result: McpToolResult): unknown {
  for (const part of result.content ?? []) {
    if (typeof part.text !== 'string') continue
    const text = part.text.trim()
    if (!text.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed) && ('data' in parsed || 'status' in parsed || 'message' in parsed)) return parsed
    } catch {
      continue
    }
  }
  return undefined
}
