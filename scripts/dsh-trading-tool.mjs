#!/usr/bin/env node
/**
 * 外部 Agent 与终端调用 `dsh-trading` 工具的薄 CLI（走宿主回环工具网关）。
 *
 * 用法：
 *   dsh-trading-tool status
 *   dsh-trading-tool index [--query <kw>] [--family <fam>] [--preset <id>]
 *   dsh-trading-tool schema <toolName> [--preset <id>]
 *   dsh-trading-tool schema --family <fam> [--preset <id>]
 *   dsh-trading-tool call <toolName> [jsonArgs] [--args <json>] [--args-file <path>] [--stdin] [--timeout <ms>] [--out <file>] [--raw] [--preset <id>]
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESCRIPTOR_FILE = 'tool-gateway.json'
const TRADING_HOME_DIR_NAME = '.dsh-trading'
const TRADING_HOME_GUARD_MARKER = '-trading'

export const USAGE_TEXT = [
  '用法: dsh-trading-tool <subcommand> [options]',
  '',
  '子命令:',
  '  status                                       检查本机回环工具网关健康状态',
  '  index [--query <kw>] [--family <fam>]        列出可用工具索引与族路由',
  '  schema <toolName> | --family <fam>           读取单个工具或整族的参数/输出 schema',
  '  call <toolName> [jsonArgs] [options]         调用工具（实盘动作无 dryRun=true 会被 403 拒绝）',
  '',
  'call 选项:',
  '  --args <json>        JSON 参数对象',
  '  --args-file <path>   从文件读取 JSON 参数对象',
  '  --stdin              从标准输入读取 JSON 参数对象',
  '  --timeout <ms>       请求超时（毫秒，网关钳制在 1000..300000）',
  '  --out <file>         把结果写入文件并只向 stdout 打印紧凑回执',
  '  --raw                输出完整网关响应信封（含 content/callId）',
  '',
  '通用选项:',
  '  --preset <id>        目标预设作用域（默认 master）',
  '  --dsh-home <dir>     显式指定 trading home（默认 ~/.dsh-trading）',
  '  -h, --help           显示本帮助',
].join('\n')

function expandHome(rawPath, homeDir) {
  if (rawPath === '~') return homeDir
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return resolve(homeDir, rawPath.slice(2))
  }
  return rawPath
}

/**
 * 解析 trading home（带 `-trading` 守卫，绝不静默读宿主 `~/.dsh`）。
 */
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
  let dshHome
  let preset
  let help = false
  const rest = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '--dsh-home' || arg.startsWith('--dsh-home=')) {
      const taken = takeFlagValue(argv, i, '--dsh-home')
      dshHome = taken.value
      i = taken.nextIndex
      continue
    }
    if (arg === '--preset' || arg.startsWith('--preset=')) {
      const taken = takeFlagValue(argv, i, '--preset')
      preset = taken.value
      i = taken.nextIndex
      continue
    }
    rest.push(arg)
  }

  if (help || rest.length === 0) {
    return { command: 'help', dshHome, preset }
  }

  const command = rest[0]
  const args = rest.slice(1)

  if (command === 'status') {
    if (args.length > 0) throw new Error(`status 不接受额外参数: ${args.join(' ')}`)
    return { command: 'status', dshHome, preset }
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
    return { command: 'index', dshHome, preset, query, family }
  }

  if (command === 'schema') {
    let name
    let family
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
      } else if (arg.startsWith('-')) {
        throw new Error(`schema 遇到未知选项: ${arg}`)
      } else if (name === undefined) {
        name = arg
      } else {
        throw new Error(`schema 多余位置参数: ${arg}`)
      }
    }
    if (!name && !family) {
      throw new Error('schema 需要提供 <toolName> 或 --family <family>')
    }
    if (name && family) {
      throw new Error('schema 不能同时指定工具名和 --family')
    }
    return { command: 'schema', dshHome, preset, name, family }
  }

  if (command === 'call') {
    let name
    let positionalJson
    let argsJson
    let argsFile
    let useStdin = false
    let timeoutMs
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
      } else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
        const taken = takeFlagValue(args, i, '--timeout')
        const num = Number(taken.value)
        if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
          throw new Error(`--timeout 必须是正整数毫秒: ${taken.value}`)
        }
        timeoutMs = num
        i = taken.nextIndex
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
      dshHome,
      preset,
      name,
      positionalJson,
      argsJson,
      argsFile,
      useStdin,
      timeoutMs,
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

function readDescriptor(tradingHome) {
  const descriptorPath = join(tradingHome, DESCRIPTOR_FILE)
  if (!existsSync(descriptorPath)) {
    return { error: `找不到工具网关描述文件: ${descriptorPath}。请确认 trading-web 实例正在运行（systemctl --user status dsh-trading-web.service 或 dsh-trading --profile trading-web）。`, descriptorPath }
  }
  try {
    const parsed = JSON.parse(readFileSync(descriptorPath, 'utf8'))
    if (!parsed || typeof parsed.url !== 'string' || typeof parsed.token !== 'string') {
      return { error: `工具网关描述文件格式无效: ${descriptorPath}`, descriptorPath }
    }
    return { descriptor: parsed, descriptorPath }
  } catch (error) {
    return { error: `读取工具网关描述文件失败 (${descriptorPath}): ${error instanceof Error ? error.message : String(error)}`, descriptorPath }
  }
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

/**
 * 执行 CLI 并返回退出码：0=成功, 1=工具/业务错误或拒绝, 2=参数/输入错误, 3=网关不可达。
 */
export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => { process.stdout.write(text) })
  const stderr = io.stderr ?? ((text) => { process.stderr.write(text) })
  const env = io.env ?? process.env
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

  let tradingHome
  try {
    tradingHome = resolveTradingHome(parsed.dshHome, env, homeDir, (msg) => { stderr(msg + '\n') })
  } catch (error) {
    stderr(`[dsh-trading-tool] ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  const desc = readDescriptor(tradingHome)
  if (desc.error !== undefined) {
    stderr(JSON.stringify({ ok: false, code: 'GATEWAY_UNAVAILABLE', message: desc.error, descriptorPath: desc.descriptorPath }, null, 2) + '\n')
    return 3
  }

  const { descriptor, descriptorPath } = desc
  const headers = {
    authorization: `Bearer ${descriptor.token}`,
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

  const requestJson = async (pathname, init = {}) => {
    let response
    try {
      response = await fetchImpl(`${descriptor.url}${pathname}`, {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
      })
    } catch (error) {
      stderr(JSON.stringify({
        ok: false,
        code: 'GATEWAY_UNREACHABLE',
        message: `无法连接回环工具网关 (${descriptor.url})，请确认 dsh-trading-web.service 或 dsh-trading --profile trading-web 处于运行状态: ${error instanceof Error ? error.message : String(error)}`,
        descriptorPath,
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
    stdout(JSON.stringify({ ...res.body, url: descriptor.url, descriptorPath }, null, 2) + '\n')
    return 0
  }

  if (parsed.command === 'index') {
    const qs = new URLSearchParams()
    if (parsed.query !== undefined) qs.set('query', parsed.query)
    if (parsed.family !== undefined) qs.set('family', parsed.family)
    if (parsed.preset !== undefined) qs.set('preset', parsed.preset)
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
    if (parsed.name !== undefined) qs.set('name', parsed.name)
    if (parsed.family !== undefined) qs.set('family', parsed.family)
    if (parsed.preset !== undefined) qs.set('preset', parsed.preset)
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
      ...(parsed.preset !== undefined ? { preset: parsed.preset } : {}),
      ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
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

function isEntryScript() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isEntryScript()) {
  runCli(process.argv.slice(2)).then(
    (code) => { process.exit(code) },
    (error) => {
      process.stderr.write(`[dsh-trading-tool] 未捕获异常: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exit(3)
    },
  )
}
