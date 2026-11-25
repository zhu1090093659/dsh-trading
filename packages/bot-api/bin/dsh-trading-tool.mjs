#!/usr/bin/env node
/**
 * 通用外部 Agent 工具 CLI 与 stdio MCP 桥（连接本机或远程 `dsh-trading` 工具网关）。
 *
 * 适用范围：任意外部 Agent、IDE（Claude Code/Desktop、Cursor、Windsurf、Codex、Antigravity）、
 * 工作流引擎与终端脚本，不绑定单一客户端、主机路径或服务管理器。
 *
 * 目标网关解析优先级（高 → 低）：
 *   1. CLI 标志：`--url` / `--token` / `--token-file` / `--descriptor` / `--profile` / `--dsh-home`
 *   2. 环境变量：`DSH_TRADING_GATEWAY_{URL,TOKEN,TOKEN_FILE,DESCRIPTOR,PROFILE,PRESET,TIMEOUT_MS}`、`DSH_HOME`
 *   3. 客户端配置：`--config` / `DSH_TRADING_TOOL_CONFIG` / `~/.config/dsh-trading-tool/config.json`
 *   4. 本机描述符：`<tradingHome>/tool-gateway.json`（仅在未显式指定远程 `--url` 时读取）
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const DESCRIPTOR_FILE = 'tool-gateway.json'
const TRADING_HOME_DIR_NAME = '.dsh-trading'
const TRADING_HOME_GUARD_MARKER = '-trading'
const DEFAULT_CLIENT_CONFIG_REL = join('.config', 'dsh-trading-tool', 'config.json')
const DEFAULT_HTTP_TIMEOUT_MS = 60_000
const CLIENT_TIMEOUT_MARGIN_MS = 5_000
const MCP_SUPPORTED_VERSIONS = ['2025-03-26', '2024-11-05']
const LOOPBACK_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1', '[::1]']
const PROXY_URL_ENV_NAMES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']

/**
 * Ensure loopback hosts (`localhost`, `127.0.0.1`, `::1`, `[::1]`) are listed in `NO_PROXY`/`no_proxy`
 * when proxy environment variables are present, preventing local gateway calls from hitting an upstream proxy.
 */
export function ensureLoopbackNoProxy(env = process.env) {
  const hasProxy = PROXY_URL_ENV_NAMES.some((name) => typeof env[name] === 'string' && env[name].trim() !== '')
  if (!hasProxy) return
  const raw = env.no_proxy ?? env.NO_PROXY ?? ''
  const entries = raw.split(/[,\s;]+/).map((entry) => entry.trim()).filter((entry) => entry !== '')
  if (entries.includes('*')) return
  const seen = new Set(entries.map((entry) => entry.toLowerCase()))
  const merged = [...entries]
  for (const loopback of LOOPBACK_NO_PROXY_ENTRIES) {
    if (!seen.has(loopback)) {
      seen.add(loopback)
      merged.push(loopback)
    }
  }
  const value = merged.join(',')
  env.no_proxy = value
  env.NO_PROXY = value
}

export const SETUP_TARGETS = [
  'mcp-stdio',
  'mcp-http',
  'claude-code',
  'codex',
  'curl',
  'server-config',
  'client-config',
  'agent-prompt',
]

export const USAGE_TEXT = [
  '用法: dsh-trading-tool <subcommand> [options]',
  '',
  '子命令:',
  '  status                                       检查目标工具网关健康状态与开放协议',
  '  index [--query <kw>] [--family <fam>]        列出可用工具索引与族路由',
  '  schema <toolName> | --family <fam> | --all   读取单个工具、整族或全部参数 schema',
  '  call <toolName> [jsonArgs] [options]         调用工具（实盘动作无 dryRun=true 会被 403 拒绝）',
  '  openapi                                      输出网关 OpenAPI 3.1.0 规范文档',
  '  mcp [--mode index|flat] [--family <f1,f2>]   以 stdio JSON-RPC 2.0 MCP Server 桥接任意 Agent/IDE',
  '  setup <target> [options]                     生成开箱即用配置（' + SETUP_TARGETS.join(' | ') + '）',
  '',
  'call 选项:',
  '  --args <json>        JSON 参数对象',
  '  --args-file <path>   从文件读取 JSON 参数对象',
  '  --stdin              从标准输入读取 JSON 参数对象',
  '  --out <file>         把结果写入文件并只向 stdout 打印紧凑回执',
  '  --raw                输出完整网关响应信封（含 content/callId）',
  '',
  'setup 选项:',
  '  --mode index|flat    生成 MCP 配置时使用的工具投影模式（默认 index）',
  '  --family <f1,f2>     生成 flat MCP 配置时限定工具族（可选）',
  '  --command <bin>      覆盖 stdio 命令名（默认 dsh-trading-tool）',
  '  --include-token      在输出片段中填入实时 Bearer token（默认脱敏占位）',
  '',
  '通用连接与配置选项:',
  '  --url <url>          显式指定网关 HTTP URL（本机或远程，免读 descriptor）',
  '  --token <secret>     显式指定 Bearer token',
  '  --token-file <path>  从文件读取 Bearer token',
  '  --descriptor <path>  显式指定 tool-gateway.json 路径',
  '  --profile <name>     选用客户端配置文件中的命名档案',
  '  --config <path>      客户端配置文件路径（默认 ~/.config/dsh-trading-tool/config.json）',
  '  --dsh-home <dir>     本机 trading home（默认 ~/.dsh-trading）',
  '  --preset <id>        目标预设作用域（默认随网关配置，通常 master）',
  '  --timeout <ms>       请求超时（毫秒，正整数）',
  '  -h, --help           显示本帮助',
].join('\n')

function expandHome(rawPath, homeDir) {
  if (rawPath === '~') return homeDir
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return resolve(homeDir, rawPath.slice(2))
  }
  return rawPath
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析 trading home（带 `-trading` 守卫，绝不静默读宿主 `~/.dsh`）。 */
export function resolveTradingHome(
  explicitHome,
  env = process.env,
  homeDir = homedir(),
  warn = (message) => { process.stderr.write(message + '\n') },
) {
  const fallback = resolve(homeDir, TRADING_HOME_DIR_NAME)
  if (explicitHome !== undefined && explicitHome.trim() !== '') {
    const resolved = resolve(expandHome(explicitHome.trim(), homeDir))
    if (resolved === resolve(homeDir, '.dsh')) {
      throw new Error(`拒绝使用宿主 home (${resolved})，请指定 trading home（如 ${fallback}）`)
    }
    return resolved
  }
  const fromEnv = env.DSH_HOME
  if (fromEnv === undefined || fromEnv.trim() === '') return fallback
  if (!fromEnv.includes(TRADING_HOME_GUARD_MARKER)) {
    warn(`dsh-trading-tool: 忽略继承的 DSH_HOME=${fromEnv}（不是 trading home），改用 ${fallback}`)
    return fallback
  }
  return resolve(expandHome(fromEnv.trim(), homeDir))
}

function readTokenFromFile(filePath, homeDir) {
  const resolvedPath = resolve(expandHome(filePath.trim(), homeDir))
  let content
  try {
    content = readFileSync(resolvedPath, 'utf8').trim()
  } catch (error) {
    throw new Error(`读取 token 文件失败 (${resolvedPath}): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!content) {
    throw new Error(`token 文件为空: ${resolvedPath}`)
  }
  return content
}

function readDescriptorFile(descriptorPath) {
  if (!existsSync(descriptorPath)) {
    return {
      error: `找不到工具网关描述文件: ${descriptorPath}。请确认 dsh-trading 实例正在运行，或通过 --url/--token 或 --profile 连接远程网关。`,
      descriptorPath,
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(descriptorPath, 'utf8'))
    if (!parsed || typeof parsed.url !== 'string' || typeof parsed.token !== 'string') {
      return { error: `工具网关描述文件格式无效: ${descriptorPath}`, descriptorPath }
    }
    return { descriptor: parsed, descriptorPath }
  } catch (error) {
    return {
      error: `读取工具网关描述文件失败 (${descriptorPath}): ${error instanceof Error ? error.message : String(error)}`,
      descriptorPath,
    }
  }
}

/** 读取并校验外部客户端配置文件（~/.config/dsh-trading-tool/config.json）。 */
export function resolveClientConfig(explicitConfigPath, env = process.env, homeDir = homedir()) {
  const envConfigPath = env.DSH_TRADING_TOOL_CONFIG?.trim()
  const rawPath = explicitConfigPath?.trim() || (envConfigPath ? envConfigPath : undefined)
  const configPath = rawPath
    ? resolve(expandHome(rawPath, homeDir))
    : resolve(homeDir, DEFAULT_CLIENT_CONFIG_REL)
  const explicit = Boolean(rawPath)

  if (!existsSync(configPath)) {
    if (explicit) {
      throw new Error(`找不到客户端配置文件: ${configPath}`)
    }
    return { configPath, defaultProfile: undefined, profiles: {} }
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`解析客户端配置文件失败 (${configPath}): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isPlainRecord(parsed)) {
    throw new Error(`客户端配置文件必须是 JSON 对象: ${configPath}`)
  }
  const profiles = isPlainRecord(parsed.profiles) ? parsed.profiles : {}
  const defaultProfile = typeof parsed.defaultProfile === 'string' && parsed.defaultProfile.trim()
    ? parsed.defaultProfile.trim()
    : undefined
  return { configPath, defaultProfile, profiles }
}

/**
 * 解析目标网关 URL、Bearer token、默认 preset 与超时设置。
 * 安全约束：显式指定远程 `--url` 时绝不静默复用本机 `~/.dsh-trading/tool-gateway.json` 密钥。
 */
export function resolveGatewayTarget(options = {}, env = process.env, homeDir = homedir(), warn) {
  const clientCfg = resolveClientConfig(options.configPath, env, homeDir)
  const explicitTargetOverride = Boolean(
    options.url?.trim()
    || options.descriptorPath?.trim()
    || options.dshHome?.trim()
    || env.DSH_TRADING_GATEWAY_URL?.trim()
    || env.DSH_TRADING_GATEWAY_DESCRIPTOR?.trim(),
  )
  const explicitProfile = options.profile?.trim() || env.DSH_TRADING_GATEWAY_PROFILE?.trim()
  const requestedProfile = explicitProfile || (explicitTargetOverride ? undefined : clientCfg.defaultProfile)

  let profile = {}
  if (requestedProfile) {
    const found = clientCfg.profiles[requestedProfile]
    if (!isPlainRecord(found)) {
      throw new Error(`客户端配置中找不到档案 "${requestedProfile}" (${clientCfg.configPath})`)
    }
    profile = found
  }

  const normalizeUrl = (raw) => raw.trim().replace(/\/+$/, '')

  const explicitCliUrl = options.url?.trim() || undefined
  const explicitUrl = explicitCliUrl
    || env.DSH_TRADING_GATEWAY_URL?.trim()
    || (typeof profile.url === 'string' && profile.url.trim() ? profile.url.trim() : undefined)

  // 显式传 CLI `--url` 且未同时传 CLI `--descriptor` 时，不读取环境中的 `DSH_TRADING_GATEWAY_DESCRIPTOR`，
  // 防止把本机描述符里的 Bearer 密钥误发往外部远程 URL。
  const explicitCliDescriptor = options.descriptorPath?.trim() || undefined
  const explicitDescriptorPath = explicitCliDescriptor
    || (explicitCliUrl ? undefined : env.DSH_TRADING_GATEWAY_DESCRIPTOR?.trim())
    || (typeof profile.descriptorPath === 'string' && profile.descriptorPath.trim() ? profile.descriptorPath.trim() : undefined)

  let token
  if (options.token?.trim()) token = options.token.trim()
  else if (options.tokenFile?.trim()) token = readTokenFromFile(options.tokenFile, homeDir)
  else if (env.DSH_TRADING_GATEWAY_TOKEN?.trim()) token = env.DSH_TRADING_GATEWAY_TOKEN.trim()
  else if (env.DSH_TRADING_GATEWAY_TOKEN_FILE?.trim()) token = readTokenFromFile(env.DSH_TRADING_GATEWAY_TOKEN_FILE, homeDir)
  else if (typeof profile.token === 'string' && profile.token.trim()) token = profile.token.trim()
  else if (typeof profile.tokenFile === 'string' && profile.tokenFile.trim()) token = readTokenFromFile(profile.tokenFile, homeDir)

  let descriptorResult
  let url
  let publicUrl
  if (explicitDescriptorPath !== undefined) {
    const resolvedDesc = resolve(expandHome(explicitDescriptorPath, homeDir))
    descriptorResult = readDescriptorFile(resolvedDesc)
    if (descriptorResult.error !== undefined && explicitUrl === undefined) {
      return {
        error: descriptorResult.error,
        code: 'GATEWAY_UNAVAILABLE',
        descriptorPath: resolvedDesc,
      }
    }
  }

  if (explicitUrl !== undefined) {
    let parsedUrl
    try {
      parsedUrl = new URL(normalizeUrl(explicitUrl))
    } catch {
      throw new Error(`无效网关 URL: ${explicitUrl}`)
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`网关 URL 仅支持 http/https: ${explicitUrl}`)
    }
    url = parsedUrl.toString().replace(/\/+$/, '')
    if (!token && descriptorResult?.descriptor) {
      token = descriptorResult.descriptor.token
    }
    if (!token && options.requireToken !== false) {
      throw new Error(`已指定网关 URL (${url})，但缺少 Bearer token（请提供 --token / --token-file 或配置档案凭证）`)
    }
  } else {
    const effectiveHomeHint = options.dshHome
      ?? (typeof profile.dshHome === 'string' && profile.dshHome.trim() ? profile.dshHome : undefined)
    const tradingHome = resolveTradingHome(effectiveHomeHint, env, homeDir, warn)
    const descriptorPath = explicitDescriptorPath
      ? resolve(expandHome(explicitDescriptorPath, homeDir))
      : join(tradingHome, DESCRIPTOR_FILE)
    descriptorResult = descriptorResult ?? readDescriptorFile(descriptorPath)
    if (descriptorResult.error !== undefined) {
      return {
        error: descriptorResult.error,
        code: 'GATEWAY_UNAVAILABLE',
        descriptorPath,
      }
    }
    url = normalizeUrl(descriptorResult.descriptor.url)
    if (typeof descriptorResult.descriptor.publicUrl === 'string' && descriptorResult.descriptor.publicUrl.trim()) {
      publicUrl = normalizeUrl(descriptorResult.descriptor.publicUrl)
    }
    token = token ?? descriptorResult.descriptor.token
  }

  const preset = options.preset?.trim()
    || env.DSH_TRADING_GATEWAY_PRESET?.trim()
    || (typeof profile.preset === 'string' && profile.preset.trim() ? profile.preset.trim() : undefined)

  let timeoutMs = options.timeoutMs
  if (timeoutMs === undefined && env.DSH_TRADING_GATEWAY_TIMEOUT_MS?.trim()) {
    const parsedEnvTimeout = Number(env.DSH_TRADING_GATEWAY_TIMEOUT_MS.trim())
    if (!Number.isInteger(parsedEnvTimeout) || parsedEnvTimeout <= 0) {
      throw new Error(`环境变量 DSH_TRADING_GATEWAY_TIMEOUT_MS 必须是正整数毫秒`)
    }
    timeoutMs = parsedEnvTimeout
  }
  if (timeoutMs === undefined && typeof profile.timeoutMs === 'number' && Number.isInteger(profile.timeoutMs) && profile.timeoutMs > 0) {
    timeoutMs = profile.timeoutMs
  }

  return {
    url,
    ...(publicUrl === undefined ? {} : { publicUrl }),
    ...(token === undefined ? {} : { token }),
    ...(preset === undefined ? {} : { preset }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(descriptorResult?.descriptorPath === undefined ? {} : { descriptorPath: descriptorResult.descriptorPath }),
    ...(requestedProfile === undefined ? {} : { profile: requestedProfile }),
  }
}

function takeFlagValue(argv, index, flagName) {
  const arg = argv[index]
  const eq = arg.indexOf('=')
  if (eq >= 0) {
    const val = arg.slice(eq + 1)
    if (val === '') throw new Error(`${flagName} 需要非空参数值`)
    return { value: val, nextIndex: index }
  }
  const next = argv[index + 1]
  if (next === undefined || next.startsWith('-')) {
    throw new Error(`${flagName} 缺少参数值`)
  }
  return { value: next, nextIndex: index + 1 }
}

/** 解析 CLI 参数，未知参数一律抛出供调用方返回 exit 2。 */
export function parseCliArgs(argv) {
  const globals = {
    url: undefined,
    token: undefined,
    tokenFile: undefined,
    descriptorPath: undefined,
    profile: undefined,
    configPath: undefined,
    dshHome: undefined,
    preset: undefined,
    timeoutMs: undefined,
  }
  let help = false
  const rest = []

  const globalFlagSpecs = [
    ['--url', 'url'],
    ['--token', 'token'],
    ['--token-file', 'tokenFile'],
    ['--descriptor', 'descriptorPath'],
    ['--profile', 'profile'],
    ['--config', 'configPath'],
    ['--dsh-home', 'dshHome'],
    ['--preset', 'preset'],
  ]

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const taken = takeFlagValue(argv, i, '--timeout')
      const num = Number(taken.value)
      if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
        throw new Error(`--timeout 必须是正整数毫秒: ${taken.value}`)
      }
      globals.timeoutMs = num
      i = taken.nextIndex
      continue
    }
    let matchedGlobal = false
    for (const [flag, key] of globalFlagSpecs) {
      if (arg === flag || arg.startsWith(`${flag}=`)) {
        const taken = takeFlagValue(argv, i, flag)
        globals[key] = taken.value
        i = taken.nextIndex
        matchedGlobal = true
        break
      }
    }
    if (matchedGlobal) continue
    rest.push(arg)
  }

  if (help || rest.length === 0) {
    return { command: 'help', ...globals }
  }

  const command = rest[0]
  const args = rest.slice(1)

  if (command === 'status') {
    if (args.length > 0) throw new Error(`status 不接受额外参数: ${args.join(' ')}`)
    return { command: 'status', ...globals }
  }

  if (command === 'openapi') {
    if (args.length > 0) throw new Error(`openapi 不接受额外参数: ${args.join(' ')}`)
    return { command: 'openapi', ...globals }
  }

  if (command === 'index') {
    let query
    let family
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '--query' || arg.startsWith('--query=')) {
        const taken = takeFlagValue(args, i, '--query')
        query = taken.value
        i = taken.nextIndex
      } else if (arg === '--family' || arg.startsWith('--family=')) {
        const taken = takeFlagValue(args, i, '--family')
        family = taken.value
        i = taken.nextIndex
      } else {
        throw new Error(`index 遇到未知参数: ${arg}`)
      }
    }
    return { command: 'index', ...globals, query, family }
  }

  if (command === 'schema') {
    let name
    let family
    let all = false
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '--family' || arg.startsWith('--family=')) {
        const taken = takeFlagValue(args, i, '--family')
        family = taken.value
        i = taken.nextIndex
      } else if (arg === '--name' || arg.startsWith('--name=')) {
        const taken = takeFlagValue(args, i, '--name')
        name = taken.value
        i = taken.nextIndex
      } else if (arg === '--all') {
        all = true
      } else if (arg.startsWith('-')) {
        throw new Error(`schema 遇到未知选项: ${arg}`)
      } else if (name === undefined) {
        name = arg
      } else {
        throw new Error(`schema 多余位置参数: ${arg}`)
      }
    }
    const modeCount = [Boolean(name), Boolean(family), all].filter(Boolean).length
    if (modeCount === 0) throw new Error('schema 需要提供 <toolName>、--family <family> 或 --all')
    if (modeCount > 1) throw new Error('schema 参数 <toolName> / --family / --all 只能选其一')
    return { command: 'schema', ...globals, name, family, all }
  }

  if (command === 'mcp') {
    let mode = 'index'
    let family
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '--mode' || arg.startsWith('--mode=')) {
        const taken = takeFlagValue(args, i, '--mode')
        const m = taken.value.trim().toLowerCase()
        if (m !== 'index' && m !== 'flat') throw new Error(`mcp --mode 必须是 index 或 flat: ${taken.value}`)
        mode = m
        i = taken.nextIndex
      } else if (arg === '--family' || arg.startsWith('--family=')) {
        const taken = takeFlagValue(args, i, '--family')
        family = taken.value
        i = taken.nextIndex
      } else {
        throw new Error(`mcp 遇到未知参数: ${arg}`)
      }
    }
    return { command: 'mcp', ...globals, mode, family }
  }

  if (command === 'setup') {
    let target
    let mode = 'index'
    let family
    let binCommand = 'dsh-trading-tool'
    let includeToken = false
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '--mode' || arg.startsWith('--mode=')) {
        const taken = takeFlagValue(args, i, '--mode')
        const m = taken.value.trim().toLowerCase()
        if (m !== 'index' && m !== 'flat') throw new Error(`setup --mode 必须是 index 或 flat: ${taken.value}`)
        mode = m
        i = taken.nextIndex
      } else if (arg === '--family' || arg.startsWith('--family=')) {
        const taken = takeFlagValue(args, i, '--family')
        family = taken.value
        i = taken.nextIndex
      } else if (arg === '--command' || arg.startsWith('--command=')) {
        const taken = takeFlagValue(args, i, '--command')
        binCommand = taken.value
        i = taken.nextIndex
      } else if (arg === '--include-token') {
        includeToken = true
      } else if (arg.startsWith('-')) {
        throw new Error(`setup 遇到未知选项: ${arg}`)
      } else if (target === undefined) {
        target = arg.trim().toLowerCase()
      } else {
        throw new Error(`setup 多余位置参数: ${arg}`)
      }
    }
    if (!target || !SETUP_TARGETS.includes(target)) {
      throw new Error(`setup 需要目标名 (${SETUP_TARGETS.join(' | ')})`)
    }
    return { command: 'setup', ...globals, target, mode, family, binCommand, includeToken }
  }

  if (command === 'call') {
    let name
    let positionalJson
    let argsJson
    let argsFile
    let useStdin = false
    let outFile
    let raw = false

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '--args' || arg.startsWith('--args=')) {
        const taken = takeFlagValue(args, i, '--args')
        argsJson = taken.value
        i = taken.nextIndex
      } else if (arg === '--args-file' || arg.startsWith('--args-file=')) {
        const taken = takeFlagValue(args, i, '--args-file')
        argsFile = taken.value
        i = taken.nextIndex
      } else if (arg === '--stdin') {
        useStdin = true
      } else if (arg === '--out' || arg.startsWith('--out=')) {
        const taken = takeFlagValue(args, i, '--out')
        outFile = taken.value
        i = taken.nextIndex
      } else if (arg === '--raw') {
        raw = true
      } else if (arg.startsWith('-')) {
        throw new Error(`call 遇到未知选项: ${arg}`)
      } else if (name === undefined) {
        name = arg
      } else if (positionalJson === undefined) {
        positionalJson = arg
      } else {
        throw new Error(`call 多余位置参数: ${arg}`)
      }
    }

    if (!name) throw new Error('call 需要提供 <toolName>')
    const sources = [positionalJson !== undefined, argsJson !== undefined, argsFile !== undefined, useStdin].filter(Boolean).length
    if (sources > 1) {
      throw new Error('call 参数来源只能选其一（位置 JSON / --args / --args-file / --stdin）')
    }

    return {
      command: 'call',
      ...globals,
      name,
      positionalJson,
      argsJson,
      argsFile,
      useStdin,
      outFile,
      raw,
    }
  }

  throw new Error(`未知子命令: ${command}`)
}

/** 拆开网关返回的工具载荷：把字符串化的 JSON 对象/数组还原为结构化 JSON。 */
export function unwrapToolResponse(payload) {
  if (payload && payload.value !== undefined) {
    if (typeof payload.value === 'string') {
      const trimmed = payload.value.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed)
          if (typeof parsed === 'object' && parsed !== null) return parsed
        } catch {
          return payload.value
        }
      }
    }
    return payload.value
  }
  const text = typeof payload?.text === 'string' ? payload.text : ''
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      return text
    }
  }
  return text
}

function formatPrintable(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function parseArgumentsObject(parsedArgs, readStdin) {
  let rawText
  if (parsedArgs.positionalJson !== undefined) rawText = parsedArgs.positionalJson
  else if (parsedArgs.argsJson !== undefined) rawText = parsedArgs.argsJson
  else if (parsedArgs.argsFile !== undefined) rawText = readFileSync(parsedArgs.argsFile, 'utf8')
  else if (parsedArgs.useStdin) rawText = readStdin()
  else return {}

  const trimmed = rawText.trim()
  if (trimmed === '') return {}
  let decoded
  try {
    decoded = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`参数不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('参数必须是 JSON 对象（如 "{}" 或 "{\\"symbol\\":\\"600519.SH\\"}"）')
  }
  return decoded
}

function shellQuote(arg) {
  if (/^[a-zA-Z0-9_./:@=,+%-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, "'\\''")}'`
}

function buildStdioArgs(parsed) {
  const args = ['mcp']
  if (parsed.mode && parsed.mode !== 'index') args.push('--mode', parsed.mode)
  if (parsed.family) args.push('--family', parsed.family)
  if (parsed.preset) args.push('--preset', parsed.preset)
  if (parsed.profile) args.push('--profile', parsed.profile)
  if (parsed.configPath) args.push('--config', parsed.configPath)
  if (parsed.descriptorPath) args.push('--descriptor', parsed.descriptorPath)
  if (parsed.url) args.push('--url', parsed.url)
  if (parsed.tokenFile) args.push('--token-file', parsed.tokenFile)
  if (parsed.dshHome) args.push('--dsh-home', parsed.dshHome)
  if (parsed.timeoutMs !== undefined) args.push('--timeout', String(parsed.timeoutMs))
  return args
}

function buildMcpHttpEndpointUrl(baseUrl, parsed) {
  const qs = new URLSearchParams()
  qs.set('mode', parsed.mode ?? 'index')
  if (parsed.family) qs.set('family', parsed.family)
  if (parsed.preset) qs.set('preset', parsed.preset)
  return `${baseUrl}/mcp?${qs.toString()}`
}

/** 生成给任意外部 Agent/IDE/平台复制使用的接入配置片段（默认脱敏不回显实时 token）。 */
export function renderSetupSnippet(parsed, resolvedTarget) {
  const fallbackUrl = parsed.url?.trim() ? parsed.url.trim().replace(/\/+$/, '') : undefined
  const baseUrl = resolvedTarget?.publicUrl ?? resolvedTarget?.url ?? fallbackUrl ?? 'http://127.0.0.1:<PORT>'
  const tokenValue = parsed.includeToken && resolvedTarget?.token
    ? resolvedTarget.token
    : '<DSH_TRADING_GATEWAY_TOKEN>'
  const mcpUrl = buildMcpHttpEndpointUrl(baseUrl, parsed)
  const cmd = parsed.binCommand || 'dsh-trading-tool'
  const stdioArgs = buildStdioArgs(parsed)
  const needsRemoteEnv = Boolean(parsed.url && !parsed.tokenFile)

  if (parsed.target === 'mcp-stdio') {
    return JSON.stringify({
      mcpServers: {
        'dsh-trading': {
          command: cmd,
          args: stdioArgs,
          ...(needsRemoteEnv
            ? {
                env: {
                  DSH_TRADING_GATEWAY_URL: baseUrl,
                  DSH_TRADING_GATEWAY_TOKEN: tokenValue,
                },
              }
            : {}),
        },
      },
    }, null, 2)
  }

  if (parsed.target === 'mcp-http') {
    return JSON.stringify({
      mcpServers: {
        'dsh-trading': {
          type: 'http',
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${tokenValue}`,
          },
        },
      },
    }, null, 2)
  }

  if (parsed.target === 'claude-code') {
    const quotedStdio = [cmd, ...stdioArgs].map(shellQuote).join(' ')
    return [
      '# 1. 本机 / 同机进程接入（推荐，自动随宿主机端口轮转）：',
      `claude mcp add dsh-trading -- ${quotedStdio}`,
      '',
      '# 2. 远程或直接 Streamable HTTP 接入：',
      `claude mcp add --transport http dsh-trading "${mcpUrl}" --header "Authorization: Bearer ${tokenValue}"`,
    ].join('\n')
  }

  if (parsed.target === 'codex') {
    const argsList = stdioArgs.map(a => JSON.stringify(a)).join(', ')
    return [
      '[mcp_servers.dsh-trading]',
      `command = ${JSON.stringify(cmd)}`,
      `args = [${argsList}]`,
      ...(needsRemoteEnv
        ? [
            '[mcp_servers.dsh-trading.env]',
            `DSH_TRADING_GATEWAY_URL = ${JSON.stringify(baseUrl)}`,
            `DSH_TRADING_GATEWAY_TOKEN = ${JSON.stringify(tokenValue)}`,
          ]
        : []),
    ].join('\n')
  }

  if (parsed.target === 'curl') {
    return [
      `GATEWAY_URL=${JSON.stringify(baseUrl)}`,
      `GATEWAY_TOKEN=${JSON.stringify(tokenValue)}`,
      '',
      'curl -sS -H "Authorization: Bearer $GATEWAY_TOKEN" "$GATEWAY_URL/health"',
      'curl -sS -H "Authorization: Bearer $GATEWAY_TOKEN" "$GATEWAY_URL/index?family=cn"',
      'curl -sS -H "Authorization: Bearer $GATEWAY_TOKEN" "$GATEWAY_URL/openapi.json" | head -n 40',
      'curl -sS -X POST -H "Authorization: Bearer $GATEWAY_TOKEN" -H "Content-Type: application/json" \\',
      '  -d \'{"name":"cn_get_ticker","arguments":{"symbol":"600519.SH"}}\' \\',
      '  "$GATEWAY_URL/call"',
    ].join('\n')
  }

  if (parsed.target === 'server-config') {
    return JSON.stringify({
      enabled: true,
      host: '127.0.0.1',
      port: 8899,
      publicUrl: 'https://trading-gateway.example.com',
      tokenFile: '~/.dsh-trading/tool-gateway.token',
      allowedHosts: ['trading-gateway.example.com'],
      allowedOrigins: ['https://agent.example.com'],
      defaultPreset: 'master',
      allowedPresets: ['master'],
      exposeMode: 'allowlist',
      extraFamilies: [],
      deniedFamilies: [],
      deniedTools: [],
      readOnly: false,
      mcpEnabled: true,
      mcpDefaultMode: 'index',
      defaultTimeoutMs: 60000,
      maxTimeoutMs: 300000,
    }, null, 2)
  }

  if (parsed.target === 'client-config') {
    return JSON.stringify({
      defaultProfile: 'local',
      profiles: {
        local: {
          dshHome: '~/.dsh-trading',
          preset: 'master',
        },
        remote: {
          url: baseUrl,
          tokenFile: '~/.config/dsh-trading-tool/remote.token',
          preset: 'master',
          timeoutMs: 60000,
        },
      },
    }, null, 2)
  }

  return [
    'Use dsh-trading tools via either MCP (`dsh_trading_index` / `dsh_trading_schema` / `dsh_trading_call`) or CLI:',
    `  ${cmd} status`,
    `  ${cmd} index [--query <kw>] [--family <fam>]`,
    `  ${cmd} schema <toolName> | --family <fam>`,
    `  ${cmd} call <toolName> '<jsonArgs>' [--out /path/to/result.json]`,
    'Safety boundary: live order / leverage actions without dryRun=true are rejected fail-closed (TRADING_APPROVAL_REQUIRED).',
  ].join('\n')
}

async function readLineChunks(linesIterable, onLine) {
  for await (const rawLine of linesIterable) {
    const line = String(rawLine).trim()
    if (!line) continue
    await onLine(line)
  }
}

/**
 * 运行 stdio JSON-RPC 2.0 MCP Server，把标准输入请求透明转发到活网关 `/mcp` 端点。
 * `initialize`、`notifications/*` 与 `ping` 在本地响应，业务调用每次按最新目标配置（含动态描述符）解析。
 */
export async function runMcpBridge(options, io = {}) {
  const stdout = io.stdout ?? ((text) => { process.stdout.write(text) })
  const stderr = io.stderr ?? ((text) => { process.stderr.write(text) })
  const env = io.env ?? process.env
  ensureLoopbackNoProxy(env)
  const fetchImpl = io.fetch ?? globalThis.fetch
  const resolveTarget = io.resolveTarget ?? (() => resolveGatewayTarget(options, env, io.homeDir ?? homedir(), (m) => stderr(m + '\n')))
  const lines = io.lines ?? createInterface({ input: io.stdin ?? process.stdin, crlfDelay: Infinity })

  const writeRpc = (payload) => {
    stdout(JSON.stringify(payload) + '\n')
  }

  const handleSingleMessage = async (msg) => {
    if (!isPlainRecord(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      const errId = isPlainRecord(msg) && 'id' in msg ? (msg.id ?? null) : null
      writeRpc({ jsonrpc: '2.0', id: errId, error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' } })
      return
    }

    const hasId = 'id' in msg && msg.id !== undefined
    if (!hasId) {
      // JSON-RPC notifications produce no stdout response per MCP stdio specification.
      return
    }
    const id = msg.id

    if (msg.method === 'initialize') {
      const requested = isPlainRecord(msg.params) && typeof msg.params.protocolVersion === 'string'
        ? msg.params.protocolVersion
        : undefined
      const protocolVersion = requested && MCP_SUPPORTED_VERSIONS.includes(requested)
        ? requested
        : MCP_SUPPORTED_VERSIONS[0]
      writeRpc({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dsh-trading-tool-mcp-bridge', version: '1.0.0' },
          instructions:
            'Connected via dsh-trading-tool stdio MCP bridge. Use index -> schema -> call (index mode) or direct tools (flat mode).',
        },
      })
      return
    }

    if (msg.method === 'ping') {
      writeRpc({ jsonrpc: '2.0', id, result: {} })
      return
    }

    let target
    try {
      target = resolveTarget()
    } catch (error) {
      writeRpc({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      })
      return
    }

    if (target.error !== undefined) {
      writeRpc({
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: target.error },
      })
      return
    }

    const qs = new URLSearchParams()
    qs.set('mode', options.mode ?? 'index')
    if (options.family) qs.set('family', options.family)
    const effectivePreset = options.preset ?? target.preset
    if (effectivePreset) qs.set('preset', effectivePreset)
    const baseTimeoutMs = options.timeoutMs ?? target.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
    const requestedCallTimeout = msg.method === 'tools/call'
      && isPlainRecord(msg.params)
      && msg.params.name === 'dsh_trading_call'
      && isPlainRecord(msg.params.arguments)
      && typeof msg.params.arguments.timeoutMs === 'number'
      && Number.isFinite(msg.params.arguments.timeoutMs)
      && msg.params.arguments.timeoutMs > 0
      ? Math.trunc(msg.params.arguments.timeoutMs)
      : baseTimeoutMs
    const httpTimeoutMs = Math.max(baseTimeoutMs, requestedCallTimeout) + CLIENT_TIMEOUT_MARGIN_MS

    let response
    try {
      response = await fetchImpl(`${target.url}/mcp?${qs.toString()}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(httpTimeoutMs),
      })
    } catch (error) {
      writeRpc({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32002,
          message: `网关不可达 (${target.url}): ${error instanceof Error ? error.message : String(error)}`,
        },
      })
      return
    }

    let body
    try {
      body = await response.json()
    } catch {
      writeRpc({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `网关返回非 JSON 响应 (HTTP ${response.status})` },
      })
      return
    }

    if (isPlainRecord(body) && body.jsonrpc === '2.0' && ('result' in body || 'error' in body)) {
      writeRpc({ ...body, id })
      return
    }

    writeRpc({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: isPlainRecord(body) && typeof body.message === 'string'
          ? body.message
          : `网关 HTTP ${response.status}`,
      },
    })
  }

  await readLineChunks(lines, async (line) => {
    let parsedMsg
    try {
      parsedMsg = JSON.parse(line)
    } catch (error) {
      writeRpc({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `JSON parse error: ${error instanceof Error ? error.message : String(error)}` },
      })
      return
    }
    await handleSingleMessage(parsedMsg)
  })
  return 0
}

/**
 * 执行 CLI 并返回退出码：0=成功, 1=工具/业务错误或拒绝, 2=参数/输入错误, 3=网关不可达。
 */
export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => { process.stdout.write(text) })
  const stderr = io.stderr ?? ((text) => { process.stderr.write(text) })
  const env = io.env ?? process.env
  ensureLoopbackNoProxy(env)
  const homeDir = io.homeDir ?? homedir()
  const fetchImpl = io.fetch ?? globalThis.fetch
  const readStdin = io.readStdin ?? (() => readFileSync(0, 'utf8'))

  let parsed
  try {
    parsed = parseCliArgs(argv)
  } catch (error) {
    stderr(`[dsh-trading-tool] ${error instanceof Error ? error.message : String(error)}\n${USAGE_TEXT}\n`)
    return 2
  }

  if (parsed.command === 'help') {
    stdout(USAGE_TEXT + '\n')
    return 0
  }

  const resolveCurrentTarget = () => resolveGatewayTarget(parsed, env, homeDir, (msg) => { stderr(msg + '\n') })

  if (parsed.command === 'setup') {
    let targetForSnippet
    try {
      const candidate = resolveGatewayTarget(
        { ...parsed, requireToken: false },
        env,
        homeDir,
        (msg) => { stderr(msg + '\n') },
      )
      if (candidate.error === undefined) targetForSnippet = candidate
    } catch {
      targetForSnippet = undefined
    }
    stdout(renderSetupSnippet(parsed, targetForSnippet) + '\n')
    return 0
  }

  if (parsed.command === 'mcp') {
    return runMcpBridge(parsed, {
      ...io,
      stdout,
      stderr,
      env,
      homeDir,
      fetch: fetchImpl,
      resolveTarget: resolveCurrentTarget,
    })
  }

  let target
  try {
    target = resolveCurrentTarget()
  } catch (error) {
    stderr(`[dsh-trading-tool] ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  if (target.error !== undefined) {
    stderr(JSON.stringify({
      ok: false,
      code: target.code ?? 'GATEWAY_UNAVAILABLE',
      message: target.error,
      ...(target.descriptorPath ? { descriptorPath: target.descriptorPath } : {}),
    }, null, 2) + '\n')
    return 3
  }

  const headers = {
    authorization: `Bearer ${target.token}`,
    'content-type': 'application/json',
  }

  let callArguments
  if (parsed.command === 'call') {
    try {
      callArguments = parseArgumentsObject(parsed, readStdin)
    } catch (error) {
      stderr(`[dsh-trading-tool] ${error instanceof Error ? error.message : String(error)}\n`)
      return 2
    }
  }

  const effectiveTimeoutMs = parsed.timeoutMs ?? target.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const requestJson = async (pathname, init = {}) => {
    let response
    try {
      response = await fetchImpl(`${target.url}${pathname}`, {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(effectiveTimeoutMs + CLIENT_TIMEOUT_MARGIN_MS),
      })
    } catch (error) {
      stderr(JSON.stringify({
        ok: false,
        code: 'GATEWAY_UNREACHABLE',
        message: `无法连接工具网关 (${target.url})，请确认 dsh-trading 实例运行中或检查网络/--url 配置: ${error instanceof Error ? error.message : String(error)}`,
        ...(target.descriptorPath ? { descriptorPath: target.descriptorPath } : {}),
      }, null, 2) + '\n')
      return { exitCode: 3 }
    }
    let body
    try {
      body = await response.json()
    } catch {
      stderr(JSON.stringify({ ok: false, code: 'INVALID_GATEWAY_RESPONSE', status: response.status, message: '网关返回非 JSON 响应' }, null, 2) + '\n')
      return { exitCode: 3 }
    }
    return { status: response.status, body }
  }

  if (parsed.command === 'status') {
    const res = await requestJson('/health')
    if (res.exitCode !== undefined) return res.exitCode
    if (res.status !== 200 || res.body?.ok !== true) {
      stderr(JSON.stringify({ status: res.status, ...res.body }, null, 2) + '\n')
      return res.status === 401 ? 3 : 1
    }
    stdout(JSON.stringify({
      ...res.body,
      url: target.url,
      ...(target.descriptorPath ? { descriptorPath: target.descriptorPath } : {}),
      ...(target.profile ? { profile: target.profile } : {}),
    }, null, 2) + '\n')
    return 0
  }

  if (parsed.command === 'openapi') {
    const res = await requestJson('/openapi.json')
    if (res.exitCode !== undefined) return res.exitCode
    if (res.status !== 200 || typeof res.body?.openapi !== 'string') {
      stderr(JSON.stringify({ status: res.status, ...res.body }, null, 2) + '\n')
      return 1
    }
    stdout(JSON.stringify(res.body, null, 2) + '\n')
    return 0
  }

  const effectivePreset = parsed.preset ?? target.preset

  if (parsed.command === 'index') {
    const qs = new URLSearchParams()
    if (parsed.query !== undefined) qs.set('query', parsed.query)
    if (parsed.family !== undefined) qs.set('family', parsed.family)
    if (effectivePreset !== undefined) qs.set('preset', effectivePreset)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    const res = await requestJson(`/index${suffix}`)
    if (res.exitCode !== undefined) return res.exitCode
    if (res.status !== 200 || res.body?.ok !== true) {
      stderr(JSON.stringify({ status: res.status, ...res.body }, null, 2) + '\n')
      return 1
    }
    stdout(JSON.stringify(res.body, null, 2) + '\n')
    return 0
  }

  if (parsed.command === 'schema') {
    const qs = new URLSearchParams()
    if (parsed.all) qs.set('all', '1')
    else if (parsed.name !== undefined) qs.set('name', parsed.name)
    else if (parsed.family !== undefined) qs.set('family', parsed.family)
    if (effectivePreset !== undefined) qs.set('preset', effectivePreset)
    const res = await requestJson(`/schema?${qs.toString()}`)
    if (res.exitCode !== undefined) return res.exitCode
    if (res.status !== 200 || res.body?.ok !== true) {
      stderr(JSON.stringify({ status: res.status, ...res.body }, null, 2) + '\n')
      return 1
    }
    stdout(JSON.stringify(res.body, null, 2) + '\n')
    return 0
  }

  const res = await requestJson('/call', {
    method: 'POST',
    body: JSON.stringify({
      name: parsed.name,
      arguments: callArguments,
      ...(effectivePreset !== undefined ? { preset: effectivePreset } : {}),
      ...(parsed.timeoutMs !== undefined
        ? { timeoutMs: parsed.timeoutMs }
        : (target.timeoutMs !== undefined ? { timeoutMs: target.timeoutMs } : {})),
    }),
  })
  if (res.exitCode !== undefined) return res.exitCode

  if (res.status !== 200 || res.body?.ok !== true) {
    stderr(JSON.stringify({ status: res.status, ...res.body }, null, 2) + '\n')
    return 1
  }

  const output = parsed.raw ? res.body : unwrapToolResponse(res.body)
  const formatted = formatPrintable(output)

  if (parsed.outFile !== undefined) {
    const targetPath = resolve(parsed.outFile)
    mkdirSync(dirname(targetPath), { recursive: true })
    const filePayload = formatted.endsWith('\n') ? formatted : formatted + '\n'
    writeFileSync(targetPath, filePayload, 'utf8')
    stdout(JSON.stringify({
      ok: true,
      tool: parsed.name,
      writtenTo: targetPath,
      bytes: Buffer.byteLength(filePayload, 'utf8'),
    }, null, 2) + '\n')
    return 0
  }

  stdout(formatted.endsWith('\n') ? formatted : formatted + '\n')
  return 0
}

export function isEntryScript(metaUrl = import.meta.url) {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isEntryScript()) {
  ensureLoopbackNoProxy(process.env)
  runCli(process.argv.slice(2)).then(
    (code) => { process.exit(code) },
    (error) => {
      process.stderr.write(`[dsh-trading-tool] 未捕获异常: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exit(3)
    },
  )
}
