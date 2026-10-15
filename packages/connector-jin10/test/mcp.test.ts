import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { Jin10Error, Jin10McpContractError } from '../src/errors.js'
import { DEFAULT_PROTOCOL_VERSION, Jin10McpClient, parseMcpBody } from '../src/mcp.js'

function sse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** 金十本出口实测能力集（spikes/impl-jin10-mcp/EVIDENCE/01-initialize.json）。 */
const UPSTREAM_CAPABILITIES = { logging: {}, resources: {}, tools: {} }

interface HarnessOptions {
  token?: string | (() => string | undefined)
  respond?: (message: Record<string, unknown>, index: number) => Response
  signal?: AbortSignal
}

function harness(options: HarnessOptions = {}) {
  const requests: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = []
  const respond = options.respond ?? defaultRespond
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    // 真实 fetch 在 signal 已取消时立即以 AbortError 拒绝；这里对齐该契约而非伪造成功。
    if (init?.signal?.aborted === true) throw new DOMException('The operation was aborted', 'AbortError')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = String(value)
    requests.push({ body, headers })
    return respond(body, requests.length - 1)
  }) as typeof fetch
  const token = typeof options.token === 'function' ? options.token : () => options.token
  const client = new Jin10McpClient({
    endpoint: 'https://mcp.test/mcp',
    token,
    fetchImpl,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })
  return { client, requests }
}

function defaultRespond(message: Record<string, unknown>): Response {
  if (message.method === 'initialize') {
    return sse({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: DEFAULT_PROTOCOL_VERSION, capabilities: UPSTREAM_CAPABILITIES, serverInfo: { name: 'jin10-mcp' } } })
  }
  if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
  if (message.method === 'tools/list') return sse({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'list_flash', description: 'flash', inputSchema: { type: 'object' } }] } })
  if (message.method === 'resources/read') return sse({ jsonrpc: '2.0', id: message.id, result: { contents: [{ uri: 'quote://codes', mimeType: 'application/json', text: '{"data":[{"code":"XAUUSD","name":"现货黄金"}]}' }] } })
  if (message.method === 'tools/call') return sse({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { status: 200, message: '', data: { ok: true } }, content: [{ type: 'text', text: '{"status":200,"message":"","data":{"ok":true}}' }] } })
  return json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${String(message.method)}` } })
}

describe('parseMcpBody', () => {
  it('吃 SSE 单行 data 与直出 JSON 两种形态', () => {
    expect(parseMcpBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\n')).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: 1 } })
    expect(parseMcpBody('{"jsonrpc":"2.0","id":2,"result":{"ok":2}}')).toEqual({ jsonrpc: '2.0', id: 2, result: { ok: 2 } })
  })

  it('空 body 返回 undefined（notifications/initialized 的 202 空响应）', () => {
    expect(parseMcpBody('')).toBeUndefined()
    expect(parseMcpBody('   \n')).toBeUndefined()
  })

  it('多段 SSE 取最后一条合法消息，非 JSON 的 data 行不致命', () => {
    expect(parseMcpBody('event: ping\ndata: not-json\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":3}}\n\n')).toEqual({ jsonrpc: '2.0', id: 3, result: { ok: 3 } })
  })

  it('完全无合法 JSON-RPC 消息时抛协议错（不静默返回空）', () => {
    expect(() => parseMcpBody('event: message\ndata: oops\n\n')).toThrow(Jin10Error)
  })
})

describe('Jin10McpClient 握手与传输', () => {
  it('标准流程 initialize → notifications/initialized → tools/list，且只握手一次', async () => {
    const { client, requests } = harness({ token: 'sk-test' })
    const tools = await client.listTools()
    expect(tools).toEqual([{ name: 'list_flash', description: 'flash', inputSchema: { type: 'object' } }])
    expect(requests.map((request) => request.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect((requests[0]!.body.params as { protocolVersion: string }).protocolVersion).toBe('2025-11-25')
    expect(requests[0]!.headers.authorization).toBe('Bearer sk-test')
    expect(requests[0]!.headers.accept).toContain('text/event-stream')
    // 通知无 id；正常请求带 id
    expect(requests[1]!.body.id).toBeUndefined()
    expect(typeof requests[2]!.body.id).toBe('number')

    await client.listTools()
    expect(requests.map((request) => request.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list'])
  })

  it('上游回 mcp-session-id 时后续请求原样回带', async () => {
    const { client, requests } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'initialize'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: DEFAULT_PROTOCOL_VERSION, capabilities: UPSTREAM_CAPABILITIES } }, { 'mcp-session-id': 'sess-42' })
        : defaultRespond(message),
    })
    await client.listTools()
    expect(requests[0]!.headers['mcp-session-id']).toBeUndefined()
    expect(requests[2]!.headers['mcp-session-id']).toBe('sess-42')
  })

  it('缺 token 抛 TRADING_CREDENTIALS_MISSING 且不发请求；补上 token 后重新握手（失败不缓存）', async () => {
    let token: string | undefined
    const { client, requests } = harness({ token: () => token })
    await expect(client.listTools()).rejects.toMatchObject({ code: 'TRADING_CREDENTIALS_MISSING' })
    expect(requests).toHaveLength(0)
    token = 'sk-late'
    await expect(client.listTools()).resolves.toHaveLength(1)
    expect(requests.map((request) => request.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
  })

  it('HTTP 401 → TRADING_AUTH_FAILED；429 → TRADING_RATE_LIMITED；5xx → TRADING_EXCHANGE_ERROR', async () => {
    const auth = harness({ token: 'sk-bad', respond: () => new Response('unauthorized', { status: 401 }) })
    await expect(auth.client.listTools()).rejects.toMatchObject({ code: 'TRADING_AUTH_FAILED' })
    const limited = harness({ token: 'sk-test', respond: () => new Response('slow down', { status: 429 }) })
    await expect(limited.client.listTools()).rejects.toMatchObject({ code: 'TRADING_RATE_LIMITED' })
    const broken = harness({ token: 'sk-test', respond: () => new Response('boom', { status: 503 }) })
    await expect(broken.client.listTools()).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })

  it('网络失败/超时 → TRADING_NETWORK', async () => {
    const failing = harness({ token: 'sk-test', respond: () => { throw new Error('socket hang up') } })
    await expect(failing.client.listTools()).rejects.toMatchObject({ code: 'TRADING_NETWORK' })
  })

  it('JSON-RPC error → TRADING_EXCHANGE_ERROR（带 code 与 message）', async () => {
    const { client } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'initialize'
        ? defaultRespond(message)
        : json({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Invalid params' } }),
    })
    await expect(client.listTools()).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
    await expect(client.listTools()).rejects.toThrow(/-32602.*Invalid params/)
  })

  it('形状异常（tools/list 无 tools[]）抛错，不返回空数组', async () => {
    const { client } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'tools/list'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { nope: true } })
        : defaultRespond(message),
    })
    await expect(client.listTools()).rejects.toThrow(/expected result\.tools\[\]/)
  })

  it('readResource 拼接 text 段', async () => {
    const { client } = harness({ token: 'sk-test' })
    await expect(client.readResource('quote://codes')).resolves.toContain('XAUUSD')
  })
})

describe('Jin10McpClient 结果读取（structuredContent 优先）', () => {
  it('structuredContent 优先于 content 文本', async () => {
    const { client } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'tools/call'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { status: 200, message: '', data: { from: 'structured' } }, content: [{ type: 'text', text: '{"status":200,"message":"","data":{"from":"text"}}' }] } })
        : defaultRespond(message),
    })
    await expect(client.callToolData('list_flash')).resolves.toEqual({ from: 'structured' })
  })

  it('structuredContent 缺席时回退 content 文本里的 JSON 信封', async () => {
    const { client } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'tools/call'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '{"status":200,"message":"","data":{"from":"text"}}' }] } })
        : defaultRespond(message),
    })
    await expect(client.callToolData('list_flash')).resolves.toEqual({ from: 'text' })
  })

  it('isError=true → 按业务错误抛出', async () => {
    const { client } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'tools/call'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { isError: true, structuredContent: { status: 500, message: '参数缺失', data: null } } })
        : defaultRespond(message),
    })
    await expect(client.callToolData('list_flash')).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })

  it('「不支持该品种」识别为 TRADING_UNSUPPORTED_SYMBOL', async () => {
    const { client } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'tools/call'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { status: 400, message: '不支持该品种 "NOPE"，请通过 quote://codes 资源查询支持的品种列表', data: null } } })
        : defaultRespond(message),
    })
    await expect(client.callToolData('get_quote', { code: 'NOPE' })).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
  })

  it('限流文案识别为 TRADING_RATE_LIMITED', async () => {
    const { client } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'tools/call'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { status: 429, message: '今日该工具调用次数已达上限，请明日再试', data: null } } })
        : defaultRespond(message),
    })
    await expect(client.callToolData('list_flash')).rejects.toMatchObject({ code: 'TRADING_RATE_LIMITED' })
  })

  it('status≠200 与 data=null 都不冒充空数据', async () => {
    const badStatus = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'tools/call'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { status: 400, message: 'bad code', data: null } } })
        : defaultRespond(message),
    })
    await expect(badStatus.client.callToolData('get_quote', { code: 'NOPE' })).rejects.toThrow(/upstream status 400 — bad code/)
    const nullData = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'tools/call'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { status: 200, message: 'not found', data: null } } })
        : defaultRespond(message),
    })
    await expect(nullData.client.callToolData('get_news', { id: '1' })).rejects.toThrow(/upstream returned no data — not found/)
  })

  it('无 structuredContent 也无机器可读文本 → 抛错', async () => {
    const { client } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'tools/call'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '纯人话，无信封' }] } })
        : defaultRespond(message),
    })
    await expect(client.callToolData('list_flash')).rejects.toThrow(/no structuredContent/)
  })
})

describe('jin10 MCP initialize 契约协商', () => {
  it('user 复核冻结 fixture 的协商版本与能力声明逐值等于仓内 spike 原始证据', async () => {
    // Given: 仓内 spike 抓取的 initialize 原始响应与包内冻结 fixture 两份数据
    const fixture = JSON.parse(await readFile(new URL('./fixtures/initialize-result.json', import.meta.url), 'utf8')) as Record<string, any>
    const spike = JSON.parse(await readFile(new URL('../../../spikes/impl-jin10-mcp/EVIDENCE/01-initialize.json', import.meta.url), 'utf8')) as { result: Record<string, any> }
    // When: 把 fixture 投影成契约字段
    const projected = {
      protocolVersion: fixture.protocolVersion,
      capabilities: fixture.capabilities,
      serverInfo: {
        name: fixture.serverInfo.name,
        title: fixture.serverInfo.title,
        version: fixture.serverInfo.version,
        websiteUrl: fixture.serverInfo.websiteUrl,
      },
    }
    // Then: 与实测证据逐值一致（fixture 不是手写猜测，且未使用真实网络）
    expect(projected).toEqual({
      protocolVersion: spike.result.protocolVersion,
      capabilities: spike.result.capabilities,
      serverInfo: {
        name: spike.result.serverInfo.name,
        title: spike.result.serverInfo.title,
        version: spike.result.serverInfo.version,
        websiteUrl: spike.result.serverInfo.websiteUrl,
      },
    })
    expect(fixture.protocolVersion).toBe('2025-11-25')
  })

  it('user 首次调用工具时保存 initialize 协商出的协议版本，并只在其后的请求上带 MCP-Protocol-Version', async () => {
    // Given: 一个按官方契约回应 initialize（2025-11-25 + tools/resources 能力）的上游
    const { client, requests } = harness({ token: 'sk-test' })
    // When: 用户列出可用工具
    const tools = await client.listTools()
    // Then: initialize 自身不带版本头，其后的 initialized 通知与 tools/list 都带协商版本
    expect(tools).toHaveLength(1)
    expect(requests.map((request) => request.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(requests[0]!.headers['mcp-protocol-version']).toBeUndefined()
    expect(requests[1]!.headers['mcp-protocol-version']).toBe('2025-11-25')
    expect(requests[2]!.headers['mcp-protocol-version']).toBe('2025-11-25')
  })

  it('user 遇到上游协商出本客户端不支持的协议版本时收到结构化契约错误且不发任何业务请求', async () => {
    // Given: 上游把版本协商到本客户端不支持的 1999-01-01
    const { client, requests } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'initialize'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '1999-01-01', capabilities: UPSTREAM_CAPABILITIES } })
        : defaultRespond(message),
    })
    // When: 用户调用工具
    const error = await client.listTools().catch((caught: unknown) => caught)
    // Then: 结构化错误带 requested/negotiated 两个版本，且 initialize 之后没有发任何请求
    expect(error).toBeInstanceOf(Jin10McpContractError)
    expect((error as Jin10McpContractError).violation).toMatchObject({
      kind: 'unsupported_protocol_version',
      requestedVersion: '2025-11-25',
      negotiatedVersion: '1999-01-01',
    })
    expect(requests.map((request) => request.body.method)).toEqual(['initialize'])
  })

  it('user 在 initialize 结果缺少 capabilities 时收到结构化契约错误而不是继续调用', async () => {
    // Given: 上游的 initialize 结果只有 protocolVersion
    const { client, requests } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'initialize'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25' } })
        : defaultRespond(message),
    })
    // When: 用户调用工具
    const error = await client.listTools().catch((caught: unknown) => caught)
    // Then: 报 initialize_result_invalid 且未发业务请求
    expect(error).toBeInstanceOf(Jin10McpContractError)
    expect((error as Jin10McpContractError).violation).toMatchObject({ kind: 'initialize_result_invalid', method: 'initialize' })
    expect(requests.map((request) => request.body.method)).toEqual(['initialize'])
  })

  it('user 在上游未声明 tools 能力时不会发出工具调用请求', async () => {
    // Given: 上游只声明 resources 能力（无 tools）
    const { client, requests } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'initialize'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { resources: {} } } })
        : defaultRespond(message),
    })
    // When: 用户列出工具
    const error = await client.listTools().catch((caught: unknown) => caught)
    // Then: 结构化错误指向 tools 能力，握手完成后未再发请求
    expect(error).toBeInstanceOf(Jin10McpContractError)
    expect((error as Jin10McpContractError).violation).toMatchObject({ kind: 'missing_capability', capability: 'tools', method: 'tools/list' })
    expect(requests.map((request) => request.body.method)).toEqual(['initialize', 'notifications/initialized'])
  })

  it('user 在上游只声明 tools 能力时工具可用但资源读取被资源面能力闸门拒绝', async () => {
    // Given: 上游只声明 tools 能力（无 resources）
    const { client, requests } = harness({
      token: 'sk-test',
      respond: (message) => message.method === 'initialize'
        ? sse({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } })
        : defaultRespond(message),
    })
    // When: 用户先列出工具，再读取行情品种资源
    await expect(client.listTools()).resolves.toHaveLength(1)
    const before = requests.length
    const error = await client.readResource('quote://codes').catch((caught: unknown) => caught)
    // Then: 资源面单独判定，拒绝时不发资源请求
    expect(error).toBeInstanceOf(Jin10McpContractError)
    expect((error as Jin10McpContractError).violation).toMatchObject({ kind: 'missing_capability', capability: 'resources', method: 'resources/read' })
    expect(requests).toHaveLength(before)
  })

  it('user 在初始化中途失败后不会被缓存成半完成会话，重试会重新完整握手且不残留旧会话头', async () => {
    // Given: 第一次 initialize 成功后 initialized 通知返回 503，第二次全流程成功
    let attempt = 0
    const { client, requests } = harness({
      token: 'sk-test',
      respond: (message) => {
        if (message.method === 'initialize') {
          attempt += 1
          return sse(
            { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: UPSTREAM_CAPABILITIES } },
            { 'mcp-session-id': `sess-${attempt}` },
          )
        }
        if (message.method === 'notifications/initialized' && attempt === 1) return new Response('boom', { status: 503 })
        return defaultRespond(message)
      },
    })
    // When: 用户连续两次调用工具
    await expect(client.listTools()).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
    const firstAttempt = requests.map((request) => request.body.method)
    const tools = await client.listTools()
    // Then: 第一次止于 initialize+通知（无业务请求），第二次重新握手且 initialize 不带旧会话头
    expect(firstAttempt).toEqual(['initialize', 'notifications/initialized'])
    expect(tools).toHaveLength(1)
    const secondAttempt = requests.slice(2)
    expect(secondAttempt.map((request) => request.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(secondAttempt[0]!.headers['mcp-session-id']).toBeUndefined()
    expect(secondAttempt[2]!.headers['mcp-session-id']).toBe('sess-2')
  })

  it('user 在上游超过 15 秒超时窗口仍未响应时收到明确标注超时的网络错误', async () => {
    // Given: fetch 以 TimeoutError 拒绝（AbortSignal.timeout 的真实语义）
    const { client } = harness({
      token: 'sk-test',
      respond: () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) },
    })
    // When: 用户调用工具
    const error = await client.listTools().catch((caught: unknown) => caught)
    // Then: 错误码仍是 TRADING_NETWORK，但消息显式标注超时与超时窗口
    expect(error).toMatchObject({ code: 'TRADING_NETWORK' })
    expect((error as Error).message).toMatch(/timed out after 15000ms/)
  })

  it('user 在取消会话后收到明确标注取消的网络错误而不是超时或空数据', async () => {
    // Given: 调用方在发起请求前已取消该会话
    const controller = new AbortController()
    controller.abort()
    const { client, requests } = harness({ token: 'sk-test', signal: controller.signal })
    // When: 用户调用工具
    const error = await client.listTools().catch((caught: unknown) => caught)
    // Then: 明确标注 aborted，且未向上游发出任何请求
    expect(error).toMatchObject({ code: 'TRADING_NETWORK' })
    expect((error as Error).message).toMatch(/request aborted/)
    expect(requests).toHaveLength(0)
  })

  it('user 的一次工具调用失败后不会被自动重试，重试由调用方显式发起', async () => {
    // Given: 上游对 tools/call 始终返回 500
    let callCount = 0
    const { client, requests } = harness({
      token: 'sk-test',
      respond: (message) => {
        if (message.method === 'tools/call') {
          callCount += 1
          return new Response('boom', { status: 500 })
        }
        return defaultRespond(message)
      },
    })
    // When: 用户调用一次工具并把失败如实传出
    await expect(client.callToolData('list_flash')).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
    // Then: 恰好一次上游调用，不静默重发
    expect(callCount).toBe(1)
    expect(requests.filter((request) => request.body.method === 'tools/call')).toHaveLength(1)
  })
})
