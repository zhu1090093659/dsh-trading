/**
 * 回环工具调用网关（loopback tool gateway）——把宿主 `ctx.tools` 暴露给本机外部 Agent。
 *
 * 设计约束：
 * - 复用活宿主（`trading-web`）的单一实例 store、`tradingEvents` 广播、router 凭据、
 *   `tool-call-log` 与全部连接器服务，避免外部进程冷启动直读写造成写锁（writer lease）
 *   或双缓存互踩。
 * - 只绑 `127.0.0.1:0`（OS 分配端口），请求必须同时满足：Host 为回环字面量、Origin
 *   缺席或为回环源、Authorization Bearer token 与随机 256-bit 密钥常量时间相等。
 * - 工具暴露走**白名单族**（`EXPOSED_TOOL_FAMILIES`）：`bash`、`read`、`write`、`edit`、
 *   `*_subagent`、`trading_batch`、`trading_tools_index` 等宿主壳与元编排工具一律不暴露。
 * - 实盘安全闸门 fail-closed：命中 `LIVE_ACTION_GATE_PATTERN` 且 `dryRun !== true` 的
 *   调用在进管线前直接以 403 `TRADING_APPROVAL_REQUIRED` 拒绝，绝不绕过人工审批与
 *   `@dshtrading/authority`。
 * - 通过 `@deepseek-ai/dsh-tools/pipeline` 的 `ToolExecutionPipeline` 携带透明 `parent`
 *   令牌执行：`tools/pre-execute` 闸门、`tools/execute` 超时策略、schema 校验、`render`、
 *   `tools/post-execute` 调用日志照常运行，同时避开 `dsh-session-checkpoint-policy` 对
 *   `exec.agent.session` 的强假设（外部网关调用不归属聊天 Session，也不往侧边栏生成幽灵会话）。
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
import path from 'node:path'

export const TOOL_GATEWAY_DESCRIPTOR_FILE = 'tool-gateway.json'
export const DEFAULT_GATEWAY_PRESET = 'master'
export const DEFAULT_CALL_TIMEOUT_MS = 60_000
export const MIN_CALL_TIMEOUT_MS = 1_000
export const MAX_CALL_TIMEOUT_MS = 300_000
export const MAX_GATEWAY_BODY_BYTES = 1024 * 1024

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * 实盘动作工具名模式：与 `@dshtrading/base` 同口径。
 * 命中且未显式传 `dryRun: true` 时在网关入口直接 fail-closed 拒绝。
 */
export const LIVE_ACTION_GATE_PATTERN =
  /^(?:(?:crypto|us|cn|hk|futures|global)_(?:place|cancel)_order|crypto_set_leverage)$/

/** 对外部 Agent 暴露的交易工具族白名单（前缀 = 首个下划线之前的部分）。 */
export const EXPOSED_TOOL_FAMILIES: ReadonlySet<string> = new Set([
  'cn',
  'hk',
  'us',
  'crypto',
  'futures',
  'global',
  'instruments',
  'watchlist',
  'holdings',
  'indicator',
  'strategy',
  'screener',
  'knowledge',
  'tasks',
  'news',
  'flash',
  'econ',
  'macro',
  'prediction',
  'fx',
  'routing',
  'special',
])

interface FamilyMeta {
  readonly label: string
  readonly whenToUse: string
}

/** 各暴露族的路由说明（对齐 `@dshtrading/base/tool-index` 并补全跨市场/特色指标族）。 */
export const GATEWAY_FAMILIES: Readonly<Record<string, FamilyMeta>> = {
  cn: { label: 'A 股行情与账户', whenToUse: '查 A 股报价/K 线/财务/新闻/公告/估值/资金流，或 A 股账户余额与下单（默认 dry-run）' },
  hk: { label: '港股行情与账户', whenToUse: '查港股报价/K 线/财务/新闻，或港股账户余额' },
  us: { label: '美股行情与账户', whenToUse: '查美股报价/K 线/财务/新闻/公司画像，或美股账户余额' },
  crypto: { label: '加密行情与账户', whenToUse: '查币种报价/K 线/资金费率/衍生品指标，或加密账户余额与下单（默认 dry-run）' },
  futures: { label: '期货行情与账户', whenToUse: '查期货报价/K 线，或期货账户余额' },
  global: { label: '全球品种（金十）', whenToUse: '现货贵金属/原油/外汇/全球指数的报价与分钟线，代码先用 instruments 解析' },
  instruments: { label: '标的检索', whenToUse: '跨市场按代码或名称模糊找标的，得到规范 symbol 后再调行情工具' },
  watchlist: { label: '自选股', whenToUse: '增删改查用户自选行与分组，或在 GUI 中栏切换当前标的' },
  holdings: { label: '统一资产台账', whenToUse: '任何涉及持仓、仓位、敞口、复盘的任务——先读台账再谈别的' },
  indicator: { label: '图表指标', whenToUse: '挂载/隐藏/自研图表指标，读取指标计算值或查看参数 schema' },
  strategy: { label: '策略与回测', whenToUse: '策略清单、自定义策略落地、纯函数引擎回测' },
  screener: { label: '选股器', whenToUse: '横截面筛选（全市场扫描某条件），非单标的研判' },
  knowledge: { label: '知识库', whenToUse: '检索/读取/沉淀知识卡片，或看主题图谱' },
  tasks: { label: '定时任务', whenToUse: '创建、列出、手动运行、修改或删除定时任务' },
  news: { label: '金十资讯', whenToUse: '金十文章列表与检索（较长的宏观/市场分析）' },
  flash: { label: '金十快讯', whenToUse: '金十快讯流与关键词搜索（事实核查首选）' },
  econ: { label: '经济日历', whenToUse: '当周经济数据发布日历与共识/实际值' },
  macro: { label: '宏观利率', whenToUse: '主要央行政策利率与宏观数据快照' },
  prediction: { label: '预测市场', whenToUse: 'Polymarket 美联储议息概率与宏观预测事件（只读）' },
  fx: { label: '汇率', whenToUse: 'USD/CNY/HKD 换算与跨币种市值折算' },
  routing: { label: '行情路由', whenToUse: '确认各市场当前生效的数据提供方' },
  special: { label: '特色情绪与板块指标', whenToUse: '读取市场情绪历史、行业排行/序列、港股沽空前十等综合快照' },
}

export interface GatewayToolSchema {
  readonly name: string
  readonly description?: string
  readonly parameters?: unknown
}

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
  readonly token: string
  readonly preset: string
  readonly startedAt: string
}

export interface ToolGatewayDependencies {
  /** 提供 `tools` 服务的 Cordis Context（用于 `ToolExecutionPipeline` 与事件派发）。 */
  readonly ctx: () => Context | undefined
  /** 惰性读取宿主 `tools` 服务（缺省从 `ctx()` 读取）。 */
  readonly tools?: (() => GatewayToolsServiceLike | undefined) | undefined
  /** 惰性读取 `agentPresets` 服务（用于获取 `master` 等预设作用域）。 */
  readonly agentPresets?: (() => GatewayAgentPresetsLike | undefined) | undefined
  /** Bearer 认证密钥（32 字节 hex）。 */
  readonly token: string
  /** 缺省预设 id，默认 `master`。 */
  readonly defaultPreset?: string | undefined
  /** 进程启动时间戳（ISO-8601）。 */
  readonly startedAt?: string | undefined
  /** 进程 pid。 */
  readonly pid?: number | undefined
}

export interface ToolGatewayStartOptions {
  readonly ctx: () => Context | undefined
  readonly tools?: (() => GatewayToolsServiceLike | undefined) | undefined
  readonly agentPresets?: (() => GatewayAgentPresetsLike | undefined) | undefined
  readonly descriptorPath?: string | undefined
  readonly token?: string | undefined
  readonly defaultPreset?: string | undefined
  readonly host?: string | undefined
}

export interface ToolGatewayHandle {
  readonly url: string
  readonly port: number
  readonly token: string
  readonly descriptorPath: string
  dispose(): Promise<void>
}

/** 网关派发使用的透明父令牌，标记为非聊天 Session 的顶层传输子调用。 */
const GATEWAY_PARENT_TOKEN = Symbol('dsh.trading.tool-gateway') as unknown as ToolExecutionToken

export function familyOfTool(toolName: string): string {
  const index = toolName.indexOf('_')
  return index < 0 ? toolName : toolName.slice(0, index)
}

export function isExposedToolName(toolName: string): boolean {
  return EXPOSED_TOOL_FAMILIES.has(familyOfTool(toolName).toLowerCase())
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

/** 按暴露白名单过滤注册工具并生成按族聚合的索引表。 */
export function buildGatewayToolIndex(
  schemas: readonly GatewayToolSchema[],
  query?: string,
  family?: string,
): GatewayToolIndex {
  const q = query?.trim().toLowerCase() || undefined
  const fam = family?.trim().toLowerCase() || undefined
  const exposed = schemas.filter(schema => isExposedToolName(schema.name))

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
    const meta = GATEWAY_FAMILIES[key]
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
        const meta = GATEWAY_FAMILIES[item.family]
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

function hostnameOfHostHeader(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined || hostHeader.trim() === '') return undefined
  const value = hostHeader.trim()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end < 0 ? undefined : value.slice(0, end + 1).toLowerCase()
  }
  const colon = value.indexOf(':')
  return (colon < 0 ? value : value.slice(0, colon)).toLowerCase()
}

export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  const hostname = hostnameOfHostHeader(hostHeader)
  return hostname !== undefined && LOOPBACK_HOSTS.has(hostname)
}

export function isLoopbackOriginHeader(originHeader: string | undefined): boolean {
  if (originHeader === undefined || originHeader === '') return true
  try {
    const parsed = new URL(originHeader)
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buf.length
    if (total > MAX_GATEWAY_BODY_BYTES) {
      throw new GatewayHttpError(413, 'PAYLOAD_TOO_LARGE', 'request body exceeds 1MiB cap')
    }
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') {
    throw new GatewayHttpError(400, 'INVALID_REQUEST', 'request body must be a JSON object')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new GatewayHttpError(400, 'INVALID_JSON', 'request body must be valid JSON')
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampTimeoutMs(raw: unknown): number {
  if (raw === undefined) return DEFAULT_CALL_TIMEOUT_MS
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new GatewayHttpError(400, 'INVALID_REQUEST', 'timeoutMs must be a positive finite number')
  }
  return Math.min(MAX_CALL_TIMEOUT_MS, Math.max(MIN_CALL_TIMEOUT_MS, Math.trunc(raw)))
}

function parseCallPayload(raw: unknown): {
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly preset?: string
  readonly timeoutMs: number
} {
  if (!isPlainRecord(raw)) {
    throw new GatewayHttpError(400, 'INVALID_REQUEST', 'request body must be a JSON object')
  }
  const rawName = raw.name
  const name = typeof rawName === 'string' ? rawName.trim() : ''
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
    timeoutMs: clampTimeoutMs(raw.timeoutMs),
  }
}

function extractTextContent(content: ReadonlyArray<{ type?: string; text?: string }>): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

export function createToolGatewayHandler(deps: ToolGatewayDependencies) {
  const defaultPreset = deps.defaultPreset ?? DEFAULT_GATEWAY_PRESET
  const startedAt = deps.startedAt ?? new Date().toISOString()
  const pid = deps.pid ?? process.pid
  let callCounter = 0

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

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isLoopbackHostHeader(req.headers.host)) {
        throw new GatewayHttpError(403, 'FORBIDDEN_HOST', 'non-loopback Host header is rejected')
      }
      if (!isLoopbackOriginHeader(typeof req.headers.origin === 'string' ? req.headers.origin : undefined)) {
        throw new GatewayHttpError(403, 'FORBIDDEN_ORIGIN', 'non-loopback Origin header is rejected')
      }
      if (!isAuthorizedBearer(req.headers.authorization, deps.token)) {
        throw new GatewayHttpError(401, 'UNAUTHORIZED', 'missing or invalid bearer token')
      }

      const method = req.method ?? 'GET'
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname

      if (pathname === '/health') {
        if (method !== 'GET') throw new GatewayHttpError(405, 'METHOD_NOT_ALLOWED', 'GET required for /health')
        const toolCount = await withPresetScope(defaultPreset, async (tools, scope) =>
          tools.schemas(scope).filter(schema => isExposedToolName(schema.name)).length,
        )
        sendJson(res, 200, { ok: true, pid, preset: defaultPreset, toolCount, startedAt })
        return
      }

      if (pathname === '/index') {
        if (method !== 'GET') throw new GatewayHttpError(405, 'METHOD_NOT_ALLOWED', 'GET required for /index')
        const preset = url.searchParams.get('preset')?.trim() || defaultPreset
        const query = url.searchParams.get('query') ?? undefined
        const family = url.searchParams.get('family') ?? undefined
        const index = await withPresetScope(preset, async (tools, scope) =>
          buildGatewayToolIndex(tools.schemas(scope), query, family),
        )
        sendJson(res, 200, { ok: true, preset, ...index })
        return
      }

      if (pathname === '/schema') {
        if (method !== 'GET') throw new GatewayHttpError(405, 'METHOD_NOT_ALLOWED', 'GET required for /schema')
        const preset = url.searchParams.get('preset')?.trim() || defaultPreset
        const name = url.searchParams.get('name')?.trim()
        const family = url.searchParams.get('family')?.trim()
        if (name) {
          if (!isExposedToolName(name)) {
            throw new GatewayHttpError(403, 'TOOL_NOT_EXPOSED', `tool "${name}" is not exposed by the external gateway`)
          }
          const tool = await withPresetScope(preset, async (tools, scope) =>
            tools.schemas(scope).find(schema => schema.name === name),
          )
          if (tool === undefined) {
            throw new GatewayHttpError(404, 'TOOL_NOT_FOUND', `tool "${name}" is not registered in preset "${preset}"`)
          }
          sendJson(res, 200, { ok: true, preset, tool })
          return
        }
        if (family) {
          const normalized = family.toLowerCase()
          if (!EXPOSED_TOOL_FAMILIES.has(normalized)) {
            throw new GatewayHttpError(403, 'TOOL_NOT_EXPOSED', `tool family "${family}" is not exposed by the external gateway`)
          }
          const matched = await withPresetScope(preset, async (tools, scope) =>
            tools
              .schemas(scope)
              .filter(schema => familyOfTool(schema.name).toLowerCase() === normalized)
              .sort((a, b) => a.name.localeCompare(b.name)),
          )
          sendJson(res, 200, { ok: true, preset, family: normalized, tools: matched })
          return
        }
        throw new GatewayHttpError(400, 'INVALID_REQUEST', 'name or family query parameter is required')
      }

      if (pathname === '/call') {
        if (method !== 'POST') throw new GatewayHttpError(405, 'METHOD_NOT_ALLOWED', 'POST required for /call')
        const rawBody = await readJsonBody(req)
        const parsed = parseCallPayload(rawBody)
        const preset = parsed.preset ?? defaultPreset

        if (!isExposedToolName(parsed.name)) {
          throw new GatewayHttpError(403, 'TOOL_NOT_EXPOSED', `tool "${parsed.name}" is not exposed by the external gateway`)
        }
        if (isLiveActionBlocked(parsed.name, parsed.arguments)) {
          throw new GatewayHttpError(
            403,
            'TRADING_APPROVAL_REQUIRED',
            `live trading action "${parsed.name}" is blocked on the external gateway unless dryRun=true; live orders must be approved inside the interactive terminal`,
          )
        }

        const disconnect = new AbortController()
        const hasSocketEvents = typeof res.on === 'function' && typeof res.off === 'function'
        const onClose = (): void => {
          if (!res.writableEnded) disconnect.abort(new Error('gateway client disconnected'))
        }
        if (hasSocketEvents) res.on('close', onClose)
        const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(parsed.timeoutMs)])

        try {
          const outcome = await withPresetScope(preset, async (tools, scope, pipelineCtx) => {
            const visible = tools.schemas(scope).some(schema => schema.name === parsed.name)
            if (!visible) {
              throw new GatewayHttpError(404, 'TOOL_NOT_FOUND', `tool "${parsed.name}" is not registered in preset "${preset}"`)
            }
            if (pipelineCtx === undefined) {
              throw new GatewayHttpError(503, 'TOOLS_UNAVAILABLE', 'host pipeline context is unavailable')
            }
            const callId = `gw-${++callCounter}`
            const pipeline = new ToolExecutionPipeline(pipelineCtx)
            const prepared = await pipeline.prepare({
              callId: callId as ToolCallId,
              name: parsed.name,
              arguments: parsed.arguments,
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
            sendJson(res, 200, {
              ok: false,
              tool: parsed.name,
              callId: outcome.callId,
              isError: true,
              code: outcome.result.error.info?.code ?? 'TOOL_EXECUTION_ERROR',
              message: outcome.result.error.message || text || 'tool execution failed',
              text,
              content: outcome.result.content,
            })
            return
          }

          sendJson(res, 200, {
            ok: true,
            tool: parsed.name,
            callId: outcome.callId,
            ...(outcome.result.value !== undefined ? { value: outcome.result.value } : {}),
            text,
            content: outcome.result.content,
          })
          return
        } finally {
          if (hasSocketEvents) res.off('close', onClose)
        }
      }

      throw new GatewayHttpError(404, 'NOT_FOUND', `no such gateway endpoint: ${pathname}`)
    } catch (error) {
      if (error instanceof GatewayHttpError) {
        sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { ok: false, code: 'INTERNAL_ERROR', message })
    }
  }
}

export async function startToolGatewayServer(options: ToolGatewayStartOptions): Promise<ToolGatewayHandle> {
  const host = options.host ?? '127.0.0.1'
  const token = options.token ?? randomBytes(32).toString('hex')
  const defaultPreset = options.defaultPreset ?? DEFAULT_GATEWAY_PRESET
  const startedAt = new Date().toISOString()
  const descriptorPath = options.descriptorPath ?? path.join(dshHomeDir(), TOOL_GATEWAY_DESCRIPTOR_FILE)

  const handler = createToolGatewayHandler({
    ctx: options.ctx,
    tools: options.tools,
    agentPresets: options.agentPresets,
    token,
    defaultPreset,
    startedAt,
    pid: process.pid,
  })

  const server = createServer((req, res) => {
    void handler(req, res)
  })

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
    server.listen(0, host)
  })

  const addr = server.address() as AddressInfo | null
  if (addr === null || typeof addr === 'string') {
    server.close()
    throw new Error('tool gateway failed to resolve bound loopback port')
  }
  const port = addr.port
  const url = `http://${host}:${port}`
  const descriptor: ToolGatewayDescriptor = {
    version: 1,
    pid: process.pid,
    host,
    port,
    url,
    token,
    preset: defaultPreset,
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

  let disposed = false
  return {
    url,
    port,
    token,
    descriptorPath,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      server.closeAllConnections?.()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
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
