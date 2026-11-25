/**
 * 外部工具调用网关配置解析与策略判定（零写死、声明式、fail-closed）。
 *
 * 配置优先级（低 → 高）：
 *   1. 内置默认值（仅本机 127.0.0.1:0、22 族交易/投研白名单、index MCP 模式、master 预设）；
 *   2. Cordis 行配置（`dsh-trading-bot-api` 行的 `config` / `config.toolGateway`）；
 *   3. JSON 配置文件（`DSH_TRADING_TOOL_GATEWAY_CONFIG` 或 `<dshHome>/tool-gateway.config.json`）；
 *   4. 环境变量（`DSH_TRADING_TOOL_GATEWAY_*`）；
 *   5. 编程调用覆盖（`overrides`）。
 *
 * 安全不变量：
 * - `INTERNAL_TOOL_DENY_PATTERNS`（如 `bash`、`read`、`write`、`*_subagent`）为硬隔离边界，
 *   即使配置 `exposeMode: 'open'` 也永不对外暴露；
 * - 配置显式错误（无效 JSON、不可读 `tokenFile`、非法端口/模式）直接抛错 fail-closed，
 *   绝不静默丢弃安全边界。
 *
 * @module @dshtrading/bot-api/tool-gateway-config
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const TOOL_GATEWAY_CONFIG_FILE = 'tool-gateway.config.json'
export const TOOL_GATEWAY_DESCRIPTOR_FILE = 'tool-gateway.json'
export const DEFAULT_GATEWAY_PRESET = 'master'
export const DEFAULT_CALL_TIMEOUT_MS = 60_000
export const MIN_CALL_TIMEOUT_MS = 1_000
export const MAX_CALL_TIMEOUT_MS = 300_000
export const MAX_ALLOWED_TIMEOUT_MS = 3_600_000
export const DEFAULT_MAX_GATEWAY_BODY_BYTES = 1024 * 1024

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '[::]'])

/** 对外部 Agent 暴露的默认交易与投研工具族白名单（前缀 = 首个下划线之前的部分）。 */
export const DEFAULT_EXPOSED_TOOL_FAMILIES: readonly string[] = [
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
]

/** 内部宿主壳与元编排工具黑名单：任意暴露模式下均硬拦截。 */
export const INTERNAL_TOOL_DENY_PATTERNS: readonly string[] = [
  'bash',
  'read',
  'write',
  'edit',
  'read_image',
  'skill',
  'job_*',
  '*_subagent',
  'trading_batch',
  'trading_tools_index',
  'load_workspace_dependencies',
  'cordis_*',
]

/** 实盘动作工具名模式（与 `@dshtrading/base` 同口径）：无 `dryRun: true` 时在网关入口 fail-closed 拒绝。 */
export const LIVE_ACTION_GATE_PATTERN =
  /^(?:(?:crypto|us|cn|hk|futures|global)_(?:place|cancel)_order|crypto_set_leverage)$/

/** 只读模式下需要拦截的写操作/变更动作工具名模式（screener_run / strategy_backtest 放行）。 */
export const MUTATING_TOOL_PATTERN =
  /(?:_(?:place_order|cancel_order|set_leverage|add|remove|delete|create|rename|update|stage|confirm|discard|author|activate|deactivate|ingest|import|export|reset|select|assign)|^tasks_run)$/

export interface GatewayToolSchema {
  readonly name: string
  readonly description?: string | undefined
  readonly parameters?: unknown
}

export interface GatewayFamilyMeta {
  readonly label: string
  readonly whenToUse: string
}

/** 内置工具族路由说明（对齐 `@dshtrading/base/tool-index` 并补全跨市场/特色指标族）。 */
export const DEFAULT_GATEWAY_FAMILIES: Readonly<Record<string, GatewayFamilyMeta>> = {
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

export type ToolExposureMode = 'allowlist' | 'open'
export type McpToolMode = 'index' | 'flat'

export interface ToolExposurePolicy {
  readonly exposeMode: ToolExposureMode
  readonly allowedFamilies: readonly string[]
  readonly extraFamilies: readonly string[]
  readonly deniedFamilies: readonly string[]
  readonly allowedTools?: readonly string[] | undefined
  readonly deniedTools: readonly string[]
  readonly readOnly: boolean
}

export interface ToolGatewayConfigInput {
  readonly enabled?: boolean | undefined
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly publicUrl?: string | undefined
  readonly token?: string | undefined
  readonly tokenFile?: string | undefined
  readonly descriptorPath?: string | null | false | undefined
  readonly allowedHosts?: readonly string[] | undefined
  readonly allowedOrigins?: readonly string[] | undefined
  readonly defaultPreset?: string | undefined
  readonly allowedPresets?: readonly string[] | undefined
  readonly defaultTimeoutMs?: number | undefined
  readonly maxTimeoutMs?: number | undefined
  readonly maxBodyBytes?: number | undefined
  readonly mcpEnabled?: boolean | undefined
  readonly mcpDefaultMode?: McpToolMode | undefined
  readonly exposeMode?: ToolExposureMode | undefined
  readonly allowedFamilies?: readonly string[] | undefined
  readonly extraFamilies?: readonly string[] | undefined
  readonly deniedFamilies?: readonly string[] | undefined
  readonly allowedTools?: readonly string[] | undefined
  readonly deniedTools?: readonly string[] | undefined
  readonly readOnly?: boolean | undefined
  readonly familyMeta?: Readonly<Record<string, Partial<GatewayFamilyMeta>>> | undefined
}

export interface ResolvedToolGatewayConfig {
  readonly enabled: boolean
  readonly host: string
  readonly port: number
  readonly publicUrl?: string | undefined
  readonly token?: string | undefined
  readonly tokenFile?: string | undefined
  readonly descriptorPath: string | null
  readonly allowedHosts?: readonly string[] | undefined
  readonly allowedOrigins?: readonly string[] | undefined
  readonly defaultPreset: string
  readonly allowedPresets?: readonly string[] | undefined
  readonly defaultTimeoutMs: number
  readonly maxTimeoutMs: number
  readonly maxBodyBytes: number
  readonly mcpEnabled: boolean
  readonly mcpDefaultMode: McpToolMode
  readonly policy: ToolExposurePolicy
  readonly familyMeta: Readonly<Record<string, GatewayFamilyMeta>>
}

const KNOWN_CONFIG_KEYS = new Set([
  'enabled', 'host', 'port', 'publicUrl', 'token', 'tokenFile', 'descriptorPath',
  'allowedHosts', 'allowedOrigins', 'defaultPreset', 'allowedPresets',
  'defaultTimeoutMs', 'maxTimeoutMs', 'maxBodyBytes', 'mcpEnabled', 'mcpDefaultMode',
  'exposeMode', 'allowedFamilies', 'extraFamilies', 'deniedFamilies',
  'allowedTools', 'deniedTools', 'readOnly', 'familyMeta',
])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expandHomePath(rawPath: string): string {
  const home = homedir()
  if (rawPath === '~') return home
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) return path.resolve(home, rawPath.slice(2))
  return rawPath
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

export function familyOfToolName(toolName: string): string {
  const idx = toolName.indexOf('_')
  return idx < 0 ? toolName : toolName.slice(0, idx)
}

/** 按大小写不敏感通配模式匹配工具名（支持 `*` 通配符）。 */
export function matchesToolPattern(name: string, pattern: string): boolean {
  const clean = pattern.trim()
  if (clean === '') return false
  return globToRegex(clean).test(name.trim())
}

export function isInternalDeniedTool(toolName: string): boolean {
  const trimmed = toolName.trim()
  if (trimmed === '') return true
  return INTERNAL_TOOL_DENY_PATTERNS.some(pattern => matchesToolPattern(trimmed, pattern))
}

export function isMutatingToolName(toolName: string): boolean {
  return MUTATING_TOOL_PATTERN.test(toolName.trim())
}

/** 根据暴露策略判定单个工具是否允许经外部网关发现或调用。 */
export function isToolAllowedByPolicy(toolName: string, policy: ToolExposurePolicy): boolean {
  const trimmed = toolName.trim()
  if (isInternalDeniedTool(trimmed)) return false
  if (policy.readOnly && isMutatingToolName(trimmed)) return false
  if (policy.deniedTools.some(pattern => matchesToolPattern(trimmed, pattern))) return false

  const family = familyOfToolName(trimmed).toLowerCase()
  if (policy.deniedFamilies.some(entry => entry.toLowerCase() === family)) return false

  if (policy.exposeMode === 'allowlist') {
    const allowedFamily = policy.allowedFamilies.some(entry => entry.toLowerCase() === family)
      || policy.extraFamilies.some(entry => entry.toLowerCase() === family)
    if (!allowedFamily) return false
  }

  if (policy.allowedTools !== undefined) {
    return policy.allowedTools.some(pattern => matchesToolPattern(trimmed, pattern))
  }
  return true
}

function normalizeHostIdentifier(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end >= 0 ? trimmed.slice(0, end + 1) : trimmed
  }
  return trimmed.includes(':') ? `[${trimmed}]` : trimmed
}

export function extractHostnameFromHostHeader(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined || hostHeader.trim() === '') return undefined
  const value = hostHeader.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end < 0 ? undefined : value.slice(0, end + 1)
  }
  const colon = value.indexOf(':')
  return colon < 0 ? value : value.slice(0, colon)
}

function normalizeHostPattern(pattern: string): string {
  const clean = pattern.trim().toLowerCase()
  if (clean.startsWith('[')) return normalizeHostIdentifier(clean)
  // 无方括号且含多个冒号时为裸 IPv6（如 fd00::1），不可按 host:port 截断首个冒号。
  if (clean.indexOf(':') !== clean.lastIndexOf(':')) return `[${clean}]`
  return extractHostnameFromHostHeader(clean) ?? clean
}

function matchHostPattern(hostname: string, pattern: string): boolean {
  const clean = pattern.trim().toLowerCase()
  if (clean === '') return false
  if (clean === '*') return true
  if (clean.startsWith('*.')) {
    const suffix = clean.slice(1) // '.example.com'
    return hostname.endsWith(suffix) && hostname.length > suffix.length
  }
  return normalizeHostIdentifier(hostname) === normalizeHostPattern(clean)
}

/** 校验 HTTP `Host` 请求头（回环永远放行；`0.0.0.0`/`::` 未配 `allowedHosts` 时仍拦截远程 Host）。 */
export function isHostAllowedByConfig(
  hostHeader: string | undefined,
  config: Pick<ResolvedToolGatewayConfig, 'host' | 'publicUrl' | 'allowedHosts'>,
): boolean {
  const hostname = extractHostnameFromHostHeader(hostHeader)
  if (hostname === undefined) return false
  if (LOOPBACK_HOSTS.has(hostname)) return true

  if (!WILDCARD_BIND_HOSTS.has(config.host.trim().toLowerCase())) {
    if (matchHostPattern(hostname, config.host)) return true
  }
  if (config.publicUrl !== undefined) {
    try {
      const publicHost = new URL(config.publicUrl).hostname.toLowerCase()
      if (matchHostPattern(hostname, publicHost)) return true
    } catch {
      // 无效 publicUrl 在配置解析阶段已拦截
    }
  }
  return (config.allowedHosts ?? []).some(pattern => matchHostPattern(hostname, pattern))
}

/** 校验浏览器 `Origin` 请求头（缺省与回环永远放行，其它源按 `allowedOrigins` 白名单匹配）。 */
export function isOriginAllowedByConfig(
  originHeader: string | undefined,
  config: Pick<ResolvedToolGatewayConfig, 'allowedOrigins'>,
): boolean {
  if (originHeader === undefined || originHeader === '') return true
  const allowList = config.allowedOrigins ?? []
  if (allowList.some(entry => entry.trim() === '*')) return true

  let parsed: URL
  try {
    parsed = new URL(originHeader)
  } catch {
    return false
  }
  const hostname = parsed.hostname.toLowerCase()
  if (LOOPBACK_HOSTS.has(hostname)) return true

  for (const rawEntry of allowList) {
    const entry = rawEntry.trim()
    if (entry === '') continue
    if (entry.includes('://')) {
      try {
        if (new URL(entry).origin === parsed.origin) return true
      } catch {
        continue
      }
    } else if (matchHostPattern(hostname, entry)) {
      return true
    }
  }
  return false
}

function parseBoolEnv(raw: string, key: string): boolean {
  const v = raw.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  throw new Error(`[dsh-trading/tool-gateway] invalid boolean env ${key}: "${raw}"`)
}

function parseIntEnv(raw: string, key: string): number {
  const trimmed = raw.trim()
  const num = Number(trimmed)
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new Error(`[dsh-trading/tool-gateway] invalid integer env ${key}: "${raw}"`)
  }
  return num
}

function parseCsvEnv(raw: string): string[] {
  return raw.split(',').map(item => item.trim()).filter(Boolean)
}

function normalizeStringList(value: unknown, label: string, lowercase = false): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`[dsh-trading/tool-gateway] config "${label}" must be an array of strings`)
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`[dsh-trading/tool-gateway] config "${label}" entries must be strings`)
    }
    const clean = lowercase ? item.trim().toLowerCase() : item.trim()
    if (clean !== '') out.push(clean)
  }
  return out
}

function extractRowGatewayLayer(rowConfig: unknown): Record<string, unknown> {
  if (!isPlainRecord(rowConfig)) return {}
  const nested = isPlainRecord(rowConfig.toolGateway) ? rowConfig.toolGateway : {}
  const top: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rowConfig)) {
    if (KNOWN_CONFIG_KEYS.has(key)) top[key] = value
  }
  return { ...top, ...nested }
}

function loadConfigFileLayer(dshHome: string, env: Record<string, string | undefined>): Record<string, unknown> {
  const explicitPath = env.DSH_TRADING_TOOL_GATEWAY_CONFIG?.trim()
  const configPath = explicitPath && explicitPath !== ''
    ? path.resolve(expandHomePath(explicitPath))
    : path.join(dshHome, TOOL_GATEWAY_CONFIG_FILE)
  if (!existsSync(configPath)) {
    if (explicitPath) {
      throw new Error(`[dsh-trading/tool-gateway] config file not found: ${configPath}`)
    }
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `[dsh-trading/tool-gateway] failed to parse config file ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isPlainRecord(parsed)) {
    throw new Error(`[dsh-trading/tool-gateway] config file ${configPath} must export a JSON object`)
  }
  return parsed
}

function envToConfigLayer(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const take = (key: string): string | undefined => {
    const val = env[key]
    return val !== undefined && val.trim() !== '' ? val.trim() : undefined
  }

  const enabled = take('DSH_TRADING_TOOL_GATEWAY')
  if (enabled !== undefined) out.enabled = parseBoolEnv(enabled, 'DSH_TRADING_TOOL_GATEWAY')
  const host = take('DSH_TRADING_TOOL_GATEWAY_HOST')
  if (host !== undefined) out.host = host
  const port = take('DSH_TRADING_TOOL_GATEWAY_PORT')
  if (port !== undefined) out.port = parseIntEnv(port, 'DSH_TRADING_TOOL_GATEWAY_PORT')
  const publicUrl = take('DSH_TRADING_TOOL_GATEWAY_PUBLIC_URL')
  if (publicUrl !== undefined) out.publicUrl = publicUrl
  const token = take('DSH_TRADING_TOOL_GATEWAY_TOKEN')
  if (token !== undefined) out.token = token
  const tokenFile = take('DSH_TRADING_TOOL_GATEWAY_TOKEN_FILE')
  if (tokenFile !== undefined) out.tokenFile = tokenFile

  const descriptor = env.DSH_TRADING_TOOL_GATEWAY_DESCRIPTOR
  if (descriptor !== undefined && descriptor.trim() !== '') {
    out.descriptorPath = descriptor.trim().toLowerCase() === 'none' ? null : descriptor.trim()
  }

  const allowedHosts = take('DSH_TRADING_TOOL_GATEWAY_ALLOWED_HOSTS')
  if (allowedHosts !== undefined) out.allowedHosts = parseCsvEnv(allowedHosts)
  const allowedOrigins = take('DSH_TRADING_TOOL_GATEWAY_ALLOWED_ORIGINS')
  if (allowedOrigins !== undefined) out.allowedOrigins = parseCsvEnv(allowedOrigins)

  const preset = take('DSH_TRADING_TOOL_GATEWAY_PRESET')
  if (preset !== undefined) out.defaultPreset = preset
  const allowedPresets = take('DSH_TRADING_TOOL_GATEWAY_ALLOWED_PRESETS')
  if (allowedPresets !== undefined) out.allowedPresets = parseCsvEnv(allowedPresets)

  const exposeMode = take('DSH_TRADING_TOOL_GATEWAY_EXPOSE_MODE')
  if (exposeMode !== undefined) out.exposeMode = exposeMode.toLowerCase()
  const allowedFamilies = take('DSH_TRADING_TOOL_GATEWAY_ALLOWED_FAMILIES')
  if (allowedFamilies !== undefined) out.allowedFamilies = parseCsvEnv(allowedFamilies)
  const extraFamilies = take('DSH_TRADING_TOOL_GATEWAY_EXTRA_FAMILIES')
  if (extraFamilies !== undefined) out.extraFamilies = parseCsvEnv(extraFamilies)
  const deniedFamilies = take('DSH_TRADING_TOOL_GATEWAY_DENIED_FAMILIES')
  if (deniedFamilies !== undefined) out.deniedFamilies = parseCsvEnv(deniedFamilies)
  const allowedTools = take('DSH_TRADING_TOOL_GATEWAY_ALLOWED_TOOLS')
  if (allowedTools !== undefined) out.allowedTools = parseCsvEnv(allowedTools)
  const deniedTools = take('DSH_TRADING_TOOL_GATEWAY_DENIED_TOOLS')
  if (deniedTools !== undefined) out.deniedTools = parseCsvEnv(deniedTools)

  const readOnly = take('DSH_TRADING_TOOL_GATEWAY_READ_ONLY')
  if (readOnly !== undefined) out.readOnly = parseBoolEnv(readOnly, 'DSH_TRADING_TOOL_GATEWAY_READ_ONLY')

  const defaultTimeoutMs = take('DSH_TRADING_TOOL_GATEWAY_DEFAULT_TIMEOUT_MS')
  if (defaultTimeoutMs !== undefined) out.defaultTimeoutMs = parseIntEnv(defaultTimeoutMs, 'DSH_TRADING_TOOL_GATEWAY_DEFAULT_TIMEOUT_MS')
  const maxTimeoutMs = take('DSH_TRADING_TOOL_GATEWAY_MAX_TIMEOUT_MS')
  if (maxTimeoutMs !== undefined) out.maxTimeoutMs = parseIntEnv(maxTimeoutMs, 'DSH_TRADING_TOOL_GATEWAY_MAX_TIMEOUT_MS')
  const maxBodyBytes = take('DSH_TRADING_TOOL_GATEWAY_MAX_BODY_BYTES')
  if (maxBodyBytes !== undefined) out.maxBodyBytes = parseIntEnv(maxBodyBytes, 'DSH_TRADING_TOOL_GATEWAY_MAX_BODY_BYTES')

  const mcpEnabled = take('DSH_TRADING_TOOL_GATEWAY_MCP')
  if (mcpEnabled !== undefined) out.mcpEnabled = parseBoolEnv(mcpEnabled, 'DSH_TRADING_TOOL_GATEWAY_MCP')
  const mcpDefaultMode = take('DSH_TRADING_TOOL_GATEWAY_MCP_MODE')
  if (mcpDefaultMode !== undefined) out.mcpDefaultMode = mcpDefaultMode.toLowerCase()

  return out
}

function mergeLayers(layers: readonly Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const layer of layers) {
    let layerHasToken = false
    let layerHasTokenFile = false
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue
      if (key === 'token') layerHasToken = true
      if (key === 'tokenFile') layerHasTokenFile = true
      merged[key] = value
    }
    // 同一优先级层显式指定 token 时清空下层的 tokenFile（反之亦然），避免跨层混用。
    if (layerHasToken && !layerHasTokenFile) delete merged.tokenFile
    if (layerHasTokenFile && !layerHasToken) delete merged.token
  }
  return merged
}

function resolveDescriptorPath(raw: unknown, dshHome: string): string | null {
  if (raw === undefined) return path.join(dshHome, TOOL_GATEWAY_DESCRIPTOR_FILE)
  if (raw === null || raw === false) return null
  if (typeof raw !== 'string') {
    throw new Error('[dsh-trading/tool-gateway] config "descriptorPath" must be a path string, null, or false')
  }
  const clean = raw.trim()
  if (clean === '' || clean.toLowerCase() === 'none') return null
  return path.resolve(dshHome, expandHomePath(clean))
}

function resolveToken(merged: Record<string, unknown>, dshHome: string): { token?: string; tokenFile?: string } {
  if (merged.token !== undefined) {
    if (typeof merged.token !== 'string' || merged.token.trim() === '') {
      throw new Error('[dsh-trading/tool-gateway] config "token" must be a non-empty string')
    }
    return { token: merged.token.trim() }
  }
  if (merged.tokenFile !== undefined) {
    if (typeof merged.tokenFile !== 'string' || merged.tokenFile.trim() === '') {
      throw new Error('[dsh-trading/tool-gateway] config "tokenFile" must be a non-empty file path')
    }
    const resolvedFile = path.resolve(dshHome, expandHomePath(merged.tokenFile.trim()))
    let content: string
    try {
      content = readFileSync(resolvedFile, 'utf8').trim()
    } catch (error) {
      throw new Error(
        `[dsh-trading/tool-gateway] failed to read tokenFile ${resolvedFile}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (content === '') {
      throw new Error(`[dsh-trading/tool-gateway] tokenFile ${resolvedFile} is empty`)
    }
    return { token: content, tokenFile: resolvedFile }
  }
  return {}
}

/** 按优先级合并并校验外部工具网关全部配置（所有无效安全配置均 fail-closed 抛错）。 */
export function resolveToolGatewayConfig(options: {
  readonly dshHome: string
  readonly rowConfig?: unknown
  readonly env?: Record<string, string | undefined> | undefined
  readonly overrides?: Partial<ToolGatewayConfigInput> | undefined
}): ResolvedToolGatewayConfig {
  const env = options.env ?? process.env
  const rowLayer = extractRowGatewayLayer(options.rowConfig)
  const fileLayer = loadConfigFileLayer(options.dshHome, env)
  const envLayer = envToConfigLayer(env)
  const overrideLayer = isPlainRecord(options.overrides) ? options.overrides : {}

  const merged = mergeLayers([rowLayer, fileLayer, envLayer, overrideLayer])

  const enabled = merged.enabled === undefined ? true : Boolean(merged.enabled)
  if (merged.enabled !== undefined && typeof merged.enabled !== 'boolean') {
    throw new Error('[dsh-trading/tool-gateway] config "enabled" must be a boolean')
  }

  const host = merged.host === undefined ? '127.0.0.1' : String(merged.host).trim()
  if (host === '') {
    throw new Error('[dsh-trading/tool-gateway] config "host" must be a non-empty hostname or IP')
  }

  let port = 0
  if (merged.port !== undefined) {
    if (typeof merged.port !== 'number' || !Number.isInteger(merged.port) || merged.port < 0 || merged.port > 65535) {
      throw new Error(`[dsh-trading/tool-gateway] config "port" must be an integer between 0 and 65535`)
    }
    port = merged.port
  }

  let publicUrl: string | undefined
  if (merged.publicUrl !== undefined) {
    if (typeof merged.publicUrl !== 'string' || merged.publicUrl.trim() === '') {
      throw new Error('[dsh-trading/tool-gateway] config "publicUrl" must be a non-empty URL string')
    }
    let parsedUrl: URL
    try {
      parsedUrl = new URL(merged.publicUrl.trim())
    } catch {
      throw new Error(`[dsh-trading/tool-gateway] invalid "publicUrl": ${merged.publicUrl}`)
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`[dsh-trading/tool-gateway] "publicUrl" must use http: or https: protocol`)
    }
    publicUrl = parsedUrl.toString().replace(/\/+$/, '')
  }

  const descriptorPath = resolveDescriptorPath(merged.descriptorPath, options.dshHome)
  const tokenResolved = resolveToken(merged, options.dshHome)

  const defaultPreset = merged.defaultPreset === undefined ? DEFAULT_GATEWAY_PRESET : String(merged.defaultPreset).trim()
  if (defaultPreset === '') {
    throw new Error('[dsh-trading/tool-gateway] config "defaultPreset" must be non-empty')
  }

  const allowedHosts = merged.allowedHosts === undefined
    ? undefined
    : normalizeStringList(merged.allowedHosts, 'allowedHosts')
  const allowedOrigins = merged.allowedOrigins === undefined
    ? undefined
    : normalizeStringList(merged.allowedOrigins, 'allowedOrigins')
  const allowedPresets = merged.allowedPresets === undefined
    ? undefined
    : normalizeStringList(merged.allowedPresets, 'allowedPresets')

  const exposeModeRaw = merged.exposeMode === undefined ? 'allowlist' : String(merged.exposeMode).trim().toLowerCase()
  if (exposeModeRaw !== 'allowlist' && exposeModeRaw !== 'open') {
    throw new Error(`[dsh-trading/tool-gateway] config "exposeMode" must be "allowlist" or "open"`)
  }

  const mcpEnabled = merged.mcpEnabled === undefined ? true : Boolean(merged.mcpEnabled)
  if (merged.mcpEnabled !== undefined && typeof merged.mcpEnabled !== 'boolean') {
    throw new Error('[dsh-trading/tool-gateway] config "mcpEnabled" must be a boolean')
  }

  const mcpModeRaw = merged.mcpDefaultMode === undefined ? 'index' : String(merged.mcpDefaultMode).trim().toLowerCase()
  if (mcpModeRaw !== 'index' && mcpModeRaw !== 'flat') {
    throw new Error(`[dsh-trading/tool-gateway] config "mcpDefaultMode" must be "index" or "flat"`)
  }

  const readOnly = merged.readOnly === undefined ? false : Boolean(merged.readOnly)
  if (merged.readOnly !== undefined && typeof merged.readOnly !== 'boolean') {
    throw new Error('[dsh-trading/tool-gateway] config "readOnly" must be a boolean')
  }

  const maxTimeoutMs = merged.maxTimeoutMs === undefined ? MAX_CALL_TIMEOUT_MS : Number(merged.maxTimeoutMs)
  if (!Number.isInteger(maxTimeoutMs) || maxTimeoutMs < MIN_CALL_TIMEOUT_MS || maxTimeoutMs > MAX_ALLOWED_TIMEOUT_MS) {
    throw new Error(`[dsh-trading/tool-gateway] config "maxTimeoutMs" must be an integer between ${MIN_CALL_TIMEOUT_MS} and ${MAX_ALLOWED_TIMEOUT_MS}`)
  }

  const defaultTimeoutMs = merged.defaultTimeoutMs === undefined ? DEFAULT_CALL_TIMEOUT_MS : Number(merged.defaultTimeoutMs)
  if (!Number.isInteger(defaultTimeoutMs) || defaultTimeoutMs < MIN_CALL_TIMEOUT_MS || defaultTimeoutMs > maxTimeoutMs) {
    throw new Error(`[dsh-trading/tool-gateway] config "defaultTimeoutMs" must be an integer between ${MIN_CALL_TIMEOUT_MS} and maxTimeoutMs (${maxTimeoutMs})`)
  }

  const maxBodyBytes = merged.maxBodyBytes === undefined ? DEFAULT_MAX_GATEWAY_BODY_BYTES : Number(merged.maxBodyBytes)
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 32 * 1024 * 1024) {
    throw new Error('[dsh-trading/tool-gateway] config "maxBodyBytes" must be an integer between 1024 and 33554432')
  }

  const allowedFamilies = merged.allowedFamilies === undefined
    ? [...DEFAULT_EXPOSED_TOOL_FAMILIES]
    : normalizeStringList(merged.allowedFamilies, 'allowedFamilies', true)
  const extraFamilies = merged.extraFamilies === undefined
    ? []
    : normalizeStringList(merged.extraFamilies, 'extraFamilies', true)
  const deniedFamilies = merged.deniedFamilies === undefined
    ? []
    : normalizeStringList(merged.deniedFamilies, 'deniedFamilies', true)
  const allowedTools = merged.allowedTools === undefined
    ? undefined
    : normalizeStringList(merged.allowedTools, 'allowedTools')
  const deniedTools = merged.deniedTools === undefined
    ? []
    : normalizeStringList(merged.deniedTools, 'deniedTools')

  const familyMeta: Record<string, GatewayFamilyMeta> = { ...DEFAULT_GATEWAY_FAMILIES }
  if (merged.familyMeta !== undefined) {
    if (!isPlainRecord(merged.familyMeta)) {
      throw new Error('[dsh-trading/tool-gateway] config "familyMeta" must be an object map')
    }
    for (const [key, entry] of Object.entries(merged.familyMeta)) {
      const normalizedKey = key.trim().toLowerCase()
      if (!normalizedKey || !isPlainRecord(entry)) continue
      const existing = familyMeta[normalizedKey]
      familyMeta[normalizedKey] = {
        label: typeof entry.label === 'string' && entry.label.trim() !== ''
          ? entry.label.trim()
          : (existing?.label ?? normalizedKey),
        whenToUse: typeof entry.whenToUse === 'string'
          ? entry.whenToUse.trim()
          : (existing?.whenToUse ?? ''),
      }
    }
  }

  return {
    enabled,
    host,
    port,
    ...(publicUrl === undefined ? {} : { publicUrl }),
    ...(tokenResolved.token === undefined ? {} : { token: tokenResolved.token }),
    ...(tokenResolved.tokenFile === undefined ? {} : { tokenFile: tokenResolved.tokenFile }),
    descriptorPath,
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    defaultPreset,
    ...(allowedPresets === undefined ? {} : { allowedPresets }),
    defaultTimeoutMs,
    maxTimeoutMs,
    maxBodyBytes,
    mcpEnabled,
    mcpDefaultMode: mcpModeRaw,
    policy: {
      exposeMode: exposeModeRaw,
      allowedFamilies,
      extraFamilies,
      deniedFamilies,
      ...(allowedTools === undefined ? {} : { allowedTools }),
      deniedTools,
      readOnly,
    },
    familyMeta,
  }
}
