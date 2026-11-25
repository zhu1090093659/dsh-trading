/**
 * dsh-trading-tool CLI BDD 测试（真实回环 HTTP 服务器 + 真实临时文件描述器）。
 * 零 mock、零定时器、覆盖 DSH_HOME 守卫、参数校验、status/index/schema/call、--out 与错误码传播。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCliArgs, renderSetupSnippet, resolveGatewayTarget, resolveTradingHome, runCli, unwrapToolResponse } from './dsh-trading-tool.mjs'

async function startFakeGatewayServer(handlerOrOptions) {
  const options = typeof handlerOrOptions === 'function' ? { handler: handlerOrOptions } : (handlerOrOptions ?? {})
  const handler = options.handler
  const requests = []
  const token = options.token ?? 'b'.repeat(64)
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8').trim()
    const body = text ? JSON.parse(text) : undefined
    requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      auth: req.headers.authorization,
      body,
    })

    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, code: 'UNAUTHORIZED', message: 'bad token' }))
      return
    }

    if (handler !== undefined) {
      const custom = handler({ method: req.method ?? 'GET', url: req.url ?? '/', body })
      res.writeHead(custom.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(custom.payload))
      return
    }

    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (parsed.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, pid: 1234, preset: 'master', toolCount: 22 }))
      return
    }
    if (parsed.pathname === '/index') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        preset: parsed.searchParams.get('preset') ?? 'master',
        query: parsed.searchParams.get('query'),
        total: 1,
        matched: 1,
        families: [{ family: 'cn', label: 'A 股行情与账户', count: 1, tools: [{ name: 'cn_get_ticker', brief: 'quote' }] }],
      }))
      return
    }
    if (parsed.pathname === '/schema') {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (parsed.searchParams.get('all') === '1') {
        res.end(JSON.stringify({
          ok: true,
          preset: parsed.searchParams.get('preset') ?? 'master',
          tools: [
            { name: 'cn_get_ticker', parameters: { type: 'object' } },
            { name: 'routing_get', parameters: { type: 'object' } },
          ],
        }))
        return
      }
      res.end(JSON.stringify({
        ok: true,
        preset: parsed.searchParams.get('preset') ?? 'master',
        tool: { name: parsed.searchParams.get('name') ?? 'cn_get_ticker', parameters: { type: 'object' } },
      }))
      return
    }
    if (parsed.pathname === '/openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'dsh-trading External Tool Gateway', version: '1.0.0' },
        servers: [{ url: 'http://127.0.0.1' }],
        paths: { '/health': {}, '/index': {}, '/schema': {}, '/call': {}, '/mcp': {} },
      }))
      return
    }
    if (parsed.pathname === '/mcp') {
      const mode = parsed.searchParams.get('mode') ?? 'index'
      const rpcMethod = body?.method
      const rpcId = body?.id
      if (rpcMethod === 'tools/list') {
        const tools = mode === 'flat'
          ? [{ name: 'routing_get', description: 'routing', inputSchema: { type: 'object', properties: {} } }]
          : [{ name: 'dsh_trading_index', description: 'index', inputSchema: { type: 'object', properties: {} } }]
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: { tools } }))
        return
      }
      if (rpcMethod === 'tools/call') {
        const toolName = body?.params?.name
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, toolName, portTag: token.slice(0, 4) }) }] },
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpcId, error: { code: -32601, message: 'Method not found' } }))
      return
    }
    if (parsed.pathname === '/call') {
      const toolName = body?.name
      if (toolName === 'crypto_place_order' && body?.arguments?.dryRun !== true) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, code: 'TRADING_APPROVAL_REQUIRED', message: 'live order denied' }))
        return
      }
      if (toolName === 'routing_get') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          tool: 'routing_get',
          callId: 'gw-1',
          value: JSON.stringify({ cn: 'tencent', crypto: 'okx' }),
          text: '{"cn":"tencent","crypto":"okx"}',
          content: [{ type: 'text', text: '{"cn":"tencent","crypto":"okx"}' }],
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        tool: toolName,
        callId: 'gw-2',
        value: { symbol: '600519.SH', price: 1500 },
        text: '{"symbol":"600519.SH","price":1500}',
        content: [{ type: 'text', text: '{"symbol":"600519.SH","price":1500}' }],
      }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND' }))
  })

  await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const port = server.address().port
  const url = `http://127.0.0.1:${port}`
  return {
    url,
    token,
    requests,
    async dispose() {
      server.closeAllConnections?.()
      await new Promise((resolve) => { server.close(() => resolve()) })
    },
  }
}

describe('dsh-trading-tool helpers', () => {
  it('operator: enforces -trading DSH_HOME guard and rejects host ~/.dsh', () => {
    // Given an inherited host DSH_HOME without -trading, a valid -trading DSH_HOME, and an explicit ~/.dsh flag
    const warnings = []
    const homeRoot = '/tmp/fake-user-home'
    // When resolving trading home across all three inputs
    const fromInheritedHost = resolveTradingHome(undefined, { DSH_HOME: '/tmp/fake-user-home/.dsh' }, homeRoot, (m) => warnings.push(m))
    const fromTradingEnv = resolveTradingHome(undefined, { DSH_HOME: '/tmp/custom-trading-home' }, homeRoot, (m) => warnings.push(m))
    // Then inherited ~/.dsh falls back to ~/.dsh-trading with warning, -trading env is honored, and explicit ~/.dsh throws
    expect(fromInheritedHost).toBe('/tmp/fake-user-home/.dsh-trading')
    expect(warnings).toHaveLength(1)
    expect(fromTradingEnv).toBe('/tmp/custom-trading-home')
    expect(() => resolveTradingHome('/tmp/fake-user-home/.dsh', {}, homeRoot)).toThrow()
  })

  it('operator: unwraps stringified JSON tool outputs while preserving plain text', () => {
    // Given payloads with stringified JSON value, structured object value, and plain text
    // When unwrapping tool responses
    const jsonStringVal = unwrapToolResponse({ value: '{"cn":"tencent"}', text: '' })
    const objVal = unwrapToolResponse({ value: { ok: true }, text: '' })
    const plainText = unwrapToolResponse({ text: 'not json output' })
    // Then JSON strings parse into structured objects and plain text remains string
    expect(jsonStringVal).toEqual({ cn: 'tencent' })
    expect(objVal).toEqual({ ok: true })
    expect(plainText).toBe('not json output')
  })

  it('operator: parses CLI subcommands and rejects invalid combinations', () => {
    // Given valid and invalid CLI argv sequences
    // When parsing args
    const help = parseCliArgs([])
    const callParsed = parseCliArgs(['call', 'cn_get_ticker', '{"symbol":"600519.SH"}', '--timeout=5000', '--raw'])
    // Then valid arguments parse accurately and invalid combinations throw
    expect(help.command).toBe('help')
    expect(callParsed).toMatchObject({ command: 'call', name: 'cn_get_ticker', timeoutMs: 5000, raw: true })
    expect(() => parseCliArgs(['unknown-cmd'])).toThrow()
    expect(() => parseCliArgs(['schema'])).toThrow()
    expect(() => parseCliArgs(['call', 'cn_get_ticker', '{}', '--args', '{}'])).toThrow()
    expect(() => parseCliArgs(['call', 'cn_get_ticker', '--timeout', 'abc'])).toThrow()
  })
})

describe('dsh-trading-tool CLI execution', () => {
  let dir
  let tradingHome
  let serverHandle

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dshtrading-cli-test-'))
    tradingHome = join(dir, 'dsh-trading-home')
  })

  afterEach(async () => {
    if (serverHandle !== undefined) {
      await serverHandle.dispose()
      serverHandle = undefined
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function captureIo() {
    let out = ''
    let err = ''
    return {
      io: {
        env: { DSH_HOME: tradingHome },
        homeDir: dir,
        stdout: (text) => { out += text },
        stderr: (text) => { err += text },
      },
      stdoutText: () => out,
      stderrText: () => err,
    }
  }

  it('operator: runs status, index, schema, and call against live descriptor', async () => {
    // Given a live loopback gateway and a valid tool-gateway.json descriptor in tradingHome
    mkdirSync(tradingHome, { recursive: true })
    serverHandle = await startFakeGatewayServer()
    writeFileSync(join(tradingHome, 'tool-gateway.json'), JSON.stringify({
      version: 1,
      pid: process.pid,
      url: serverHandle.url,
      token: serverHandle.token,
      preset: 'master',
    }))

    // When invoking status, index, schema, and call subcommands
    const statusCap = captureIo()
    const statusCode = await runCli(['status'], statusCap.io)

    const indexCap = captureIo()
    const indexCode = await runCli(['index', '--query', '行情'], indexCap.io)

    const schemaCap = captureIo()
    const schemaCode = await runCli(['schema', 'cn_get_ticker'], schemaCap.io)

    const callCap = captureIo()
    const callCode = await runCli(['call', 'routing_get', '{}'], callCap.io)

    const rawCap = captureIo()
    const rawCode = await runCli(['call', 'cn_get_ticker', '{"symbol":"600519.SH"}', '--raw'], rawCap.io)

    // Then all exit 0 and return expected unwrapped or raw JSON
    expect(statusCode).toBe(0)
    expect(JSON.parse(statusCap.stdoutText())).toMatchObject({ ok: true, toolCount: 22 })
    expect(indexCode).toBe(0)
    expect(JSON.parse(indexCap.stdoutText())).toMatchObject({ ok: true, query: '行情' })
    expect(schemaCode).toBe(0)
    expect(JSON.parse(schemaCap.stdoutText())).toMatchObject({ ok: true, tool: { name: 'cn_get_ticker' } })
    expect(callCode).toBe(0)
    expect(JSON.parse(callCap.stdoutText())).toEqual({ cn: 'tencent', crypto: 'okx' })
    expect(rawCode).toBe(0)
    expect(JSON.parse(rawCap.stdoutText())).toMatchObject({ ok: true, tool: 'cn_get_ticker', callId: 'gw-2' })
  })

  it('operator: reads args from --args-file and writes --out file receipt', async () => {
    // Given a live gateway, an args JSON file, and an output path
    mkdirSync(tradingHome, { recursive: true })
    serverHandle = await startFakeGatewayServer()
    writeFileSync(join(tradingHome, 'tool-gateway.json'), JSON.stringify({
      version: 1,
      pid: process.pid,
      url: serverHandle.url,
      token: serverHandle.token,
    }))
    const argsFile = join(dir, 'args.json')
    const outFile = join(dir, 'nested', 'out.json')
    writeFileSync(argsFile, JSON.stringify({ symbol: '600519.SH' }), 'utf8')

    // When calling tool with --args-file and --out
    const cap = captureIo()
    const code = await runCli(['call', 'cn_get_ticker', '--args-file', argsFile, '--out', outFile], cap.io)

    // Then stdout prints compact receipt and target file holds tool result JSON
    expect(code).toBe(0)
    expect(JSON.parse(cap.stdoutText())).toMatchObject({ ok: true, tool: 'cn_get_ticker', writtenTo: outFile })
    expect(JSON.parse(readFileSync(outFile, 'utf8'))).toEqual({ symbol: '600519.SH', price: 1500 })
  })

  it('operator: returns non-zero exit codes for denied live order, missing descriptor, and bad JSON args', async () => {
    // Given a missing descriptor directory and then a live gateway enforcing dryRun
    const missingCap = captureIo()
    const missingCode = await runCli(['status'], missingCap.io)
    expect(missingCode).toBe(3)
    expect(JSON.parse(missingCap.stderrText())).toMatchObject({ ok: false, code: 'GATEWAY_UNAVAILABLE' })

    mkdirSync(tradingHome, { recursive: true })
    serverHandle = await startFakeGatewayServer()
    writeFileSync(join(tradingHome, 'tool-gateway.json'), JSON.stringify({
      version: 1,
      pid: process.pid,
      url: serverHandle.url,
      token: serverHandle.token,
    }))

    // When sending blocked live order and malformed JSON arguments
    const deniedCap = captureIo()
    const deniedCode = await runCli(['call', 'crypto_place_order', '{"symbol":"BTCUSDT","dryRun":false}'], deniedCap.io)
    const badJsonCap = captureIo()
    const badJsonCode = await runCli(['call', 'cn_get_ticker', '["not-an-object"]'], badJsonCap.io)
    const badFlagCap = captureIo()
    const badFlagCode = await runCli(['index', '--bogus'], badFlagCap.io)

    // Then denied call exits 1 and invalid arguments exit 2
    expect(deniedCode).toBe(1)
    expect(JSON.parse(deniedCap.stderrText())).toMatchObject({ status: 403, code: 'TRADING_APPROVAL_REQUIRED' })
    expect(badJsonCode).toBe(2)
    expect(badFlagCode).toBe(2)
  })

  it('operator: connects remotely via --url + --token-file, named client --profile, and --descriptor without local tradingHome', async () => {
    // Given a live gateway reached without local tool-gateway.json via URL+tokenFile, named profile config, and explicit descriptor
    serverHandle = await startFakeGatewayServer({ token: 'd'.repeat(64) })
    const tokenFile = join(dir, 'remote.token')
    writeFileSync(tokenFile, `${serverHandle.token}\n`, 'utf8')
    const clientCfgDir = join(dir, '.config', 'dsh-trading-tool')
    mkdirSync(clientCfgDir, { recursive: true })
    writeFileSync(join(clientCfgDir, 'config.json'), JSON.stringify({
      defaultProfile: 'prod',
      profiles: {
        prod: {
          url: serverHandle.url,
          tokenFile,
          preset: 'research',
          timeoutMs: 25000,
        },
      },
    }), 'utf8')
    const customDesc = join(dir, 'custom-gw.json')
    writeFileSync(customDesc, JSON.stringify({ url: serverHandle.url, token: serverHandle.token }), 'utf8')

    // When invoking schema --all via named profile, openapi via --url/--token-file, index via --descriptor, and URL without token
    const profileCap = captureIo()
    const profileCode = await runCli(['schema', '--all'], { ...profileCap.io, env: {} })

    const urlCap = captureIo()
    const urlCode = await runCli(['--url', serverHandle.url, '--token-file', tokenFile, 'openapi'], { ...urlCap.io, homeDir: join(dir, 'empty-home'), env: {} })

    const descCap = captureIo()
    const descCode = await runCli(['--descriptor', customDesc, 'index', '--family', 'cn'], { ...descCap.io, env: {} })

    const missingTokCap = captureIo()
    const missingTokCode = await runCli(['--url', serverHandle.url, 'status'], { ...missingTokCap.io, homeDir: join(dir, 'empty-home'), env: {} })

    // Then remote targets succeed, inherit profile preset, and fail closed when --url omits token
    expect(profileCode).toBe(0)
    expect(JSON.parse(profileCap.stdoutText())).toMatchObject({ ok: true, preset: 'research' })
    expect(urlCode).toBe(0)
    expect(JSON.parse(urlCap.stdoutText())).toMatchObject({ openapi: '3.1.0' })
    expect(descCode).toBe(0)
    expect(JSON.parse(descCap.stdoutText())).toMatchObject({ ok: true })
    expect(missingTokCode).toBe(2)
    expect(resolveGatewayTarget({ url: serverHandle.url, tokenFile }, {}, dir).preset).toBeUndefined()
  })

  it('operator: generates universal setup configs with token redaction by default and opt-in --include-token', async () => {
    // Given a live descriptor and setup targets for different external agents/IDEs
    mkdirSync(tradingHome, { recursive: true })
    serverHandle = await startFakeGatewayServer({ token: 'e'.repeat(64) })
    writeFileSync(join(tradingHome, 'tool-gateway.json'), JSON.stringify({
      url: serverHandle.url,
      token: serverHandle.token,
    }))

    // When running setup for mcp-stdio, mcp-http (redacted vs --include-token), claude-code, codex, curl, server-config, client-config
    const stdioCap = captureIo()
    const stdioCode = await runCli(['setup', 'mcp-stdio', '--mode', 'flat', '--family', 'cn,holdings'], stdioCap.io)

    const httpRedactedCap = captureIo()
    const httpRedactedCode = await runCli(['setup', 'mcp-http'], httpRedactedCap.io)

    const httpTokenCap = captureIo()
    const httpTokenCode = await runCli(['setup', 'mcp-http', '--include-token'], httpTokenCap.io)

    const codexCap = captureIo()
    const codexCode = await runCli(['setup', 'codex', '--url', 'https://gw.example.com'], codexCap.io)

    const remoteHttpCap = captureIo()
    const remoteHttpCode = await runCli(['setup', 'mcp-http', '--url', 'https://gw.example.com'], remoteHttpCap.io)

    const claudeQuotedCap = captureIo()
    const claudeQuotedCode = await runCli([
      'setup', 'claude-code',
      '--config', '/tmp/my dir/config.json',
      '--token-file', '/tmp/my dir/gw.token',
      '--timeout', '45000',
    ], claudeQuotedCap.io)

    const ambientLeakCap = captureIo()
    const ambientLeakCode = await runCli(
      ['--url', 'https://untrusted.example.com', 'status'],
      { ...ambientLeakCap.io, env: { DSH_TRADING_GATEWAY_DESCRIPTOR: join(tradingHome, 'tool-gateway.json') } },
    )

    const serverCfgText = renderSetupSnippet({ target: 'server-config' })

    // Then snippets are valid, redact live secret by default, preserve --url without --token, quote paths, and never leak ambient descriptor token to CLI --url
    expect(stdioCode).toBe(0)
    expect(JSON.parse(stdioCap.stdoutText()).mcpServers['dsh-trading']).toEqual({
      command: 'dsh-trading-tool',
      args: ['mcp', '--mode', 'flat', '--family', 'cn,holdings'],
    })
    expect(httpRedactedCode).toBe(0)
    expect(httpRedactedCap.stdoutText()).not.toContain(serverHandle.token)
    expect(httpRedactedCap.stdoutText()).toContain('<DSH_TRADING_GATEWAY_TOKEN>')
    expect(httpTokenCode).toBe(0)
    expect(httpTokenCap.stdoutText()).toContain(`Bearer ${serverHandle.token}`)
    expect(codexCode).toBe(0)
    expect(codexCap.stdoutText()).toContain('[mcp_servers.dsh-trading]')
    expect(codexCap.stdoutText()).toContain('DSH_TRADING_GATEWAY_URL = "https://gw.example.com"')
    expect(remoteHttpCode).toBe(0)
    expect(JSON.parse(remoteHttpCap.stdoutText()).mcpServers['dsh-trading'].url).toBe('https://gw.example.com/mcp?mode=index')
    expect(claudeQuotedCode).toBe(0)
    expect(claudeQuotedCap.stdoutText()).toContain("'/tmp/my dir/config.json'")
    expect(claudeQuotedCap.stdoutText()).toContain('--token-file')
    expect(claudeQuotedCap.stdoutText()).toContain('--timeout 45000')
    expect(ambientLeakCode).toBe(2)
    expect(JSON.parse(serverCfgText)).toMatchObject({ exposeMode: 'allowlist', mcpEnabled: true })
  })

  it('user: bridges stdio MCP JSON-RPC requests dynamically even across host port/token rotation', async () => {
    // Given a running gateway descriptor, a sequence of JSON-RPC messages including notification + handshake + port rotation mid-session
    mkdirSync(tradingHome, { recursive: true })
    serverHandle = await startFakeGatewayServer({ token: '1111'.repeat(16) })
    const descFile = join(tradingHome, 'tool-gateway.json')
    writeFileSync(descFile, JSON.stringify({ url: serverHandle.url, token: serverHandle.token }))

    let server2
    const lines = (async function* () {
      yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
      yield JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
      yield JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
      yield JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })

      // Simulate host restart rotating port and token while stdio MCP session stays alive
      await serverHandle.dispose()
      serverHandle = undefined
      server2 = await startFakeGatewayServer({ token: '2222'.repeat(16) })
      writeFileSync(descFile, JSON.stringify({ url: server2.url, token: server2.token }))

      yield JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'routing_get', arguments: {} },
      })
    })()

    const outLines = []
    let errText = ''
    try {
      // When executing stdio MCP bridge over those messages
      const exitCode = await runCli(['mcp', '--mode', 'flat', '--family', 'routing'], {
        env: { DSH_HOME: tradingHome },
        homeDir: dir,
        lines,
        stdout: (chunk) => {
          for (const item of chunk.split('\n')) {
            if (item.trim()) outLines.push(JSON.parse(item))
          }
        },
        stderr: (chunk) => { errText += chunk },
      })

      // Then initialize/ping/tools/list/tools/call all succeed in order, notification emits no stdout, and post-rotation call hits server2
      expect(exitCode).toBe(0)
      expect(errText).toBe('')
      expect(outLines).toHaveLength(4)
      expect(outLines[0]).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26' } })
      expect(outLines[1]).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
      expect(outLines[2].result.tools.map(t => t.name)).toEqual(['routing_get'])
      const callText = JSON.parse(outLines[3].result.content[0].text)
      expect(callText).toEqual({ ok: true, toolName: 'routing_get', portTag: '2222' })
    } finally {
      if (server2 !== undefined) await server2.dispose()
    }
  })
})
