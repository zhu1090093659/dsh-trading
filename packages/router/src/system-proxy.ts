/**
 * Cross-platform system proxy detection, URL validation/redaction, and NO_PROXY matching.
 *
 * Pure policy module with injectable OS command/file readers so unit tests run
 * deterministically across platforms without touching host settings or global state.
 *
 * @module @dshtrading/router/system-proxy
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ProxyMode = 'system' | 'custom' | 'direct'

export interface ProxyConfig {
  mode?: ProxyMode | undefined
  url?: string | undefined
  noProxy?: string | undefined
}

export type ProxySource =
  | 'env'
  | 'macos-scutil'
  | 'windows-registry'
  | 'linux-gsettings'
  | 'linux-kde'
  | 'desktop-system'
  | 'custom'
  | 'direct'
  | 'none'

export interface DetectedSystemProxy {
  source: ProxySource
  httpProxy?: string
  httpsProxy?: string
  noProxy?: string
  pacUrl?: string
}

export interface ResolvedProxyPolicy {
  mode: ProxyMode
  source: ProxySource
  httpProxy?: string
  httpsProxy?: string
  noProxy: string
  diagnostics: string[]
}

export interface LaunchProxyEnvSnapshot {
  userEnv: Record<string, string | undefined>
  desktopSystemHint?: DetectedSystemProxy
}

export const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]'] as const

export const PROXY_ENV_NAMES = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const

const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'])
const SOCKS4_PROTOCOLS = new Set(['socks4:', 'socks4a:'])
const SOCKS_PROTOCOLS = new Set(['socks:', 'socks5:', 'socks5h:'])
const PROXY_DETECT_TIMEOUT_MS = 1500

const ENV_INJECTED_MARKER = 'DSH_TRADING_INJECTED_SYSTEM_PROXY'
const ENV_DESKTOP_HTTP = 'DSH_TRADING_DESKTOP_SYSTEM_PROXY_HTTP'
const ENV_DESKTOP_HTTPS = 'DSH_TRADING_DESKTOP_SYSTEM_PROXY_HTTPS'
const ENV_DESKTOP_NO_PROXY = 'DSH_TRADING_DESKTOP_SYSTEM_PROXY_NO_PROXY'

/** Normalize arbitrary persisted mode values to a valid {@link ProxyMode}. */
export function normalizeProxyMode(value: unknown): ProxyMode {
  if (value === 'system' || value === 'custom' || value === 'direct') return value
  return 'system'
}

export type ProxyUrlValidation =
  | { ok: true; value: string }
  | { ok: false; kind: 'empty' | 'socks4' | 'unsupported' | 'invalid'; message: string }

/**
 * Validate a proxy URL without echoing any embedded credentials in error diagnostics.
 */
export function validateProxyUrl(raw: string): ProxyUrlValidation {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { ok: false, kind: 'empty', message: 'proxy URL is empty' }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, kind: 'invalid', message: 'proxy URL is not a valid URL' }
  }
  if (parsed.hostname === '') {
    return { ok: false, kind: 'invalid', message: 'proxy URL is missing a hostname' }
  }
  if (SOCKS4_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      kind: 'socks4',
      message: `unsupported proxy scheme ${parsed.protocol}// (use http://, https://, socks5://, or socks5h://)`,
    }
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      kind: 'unsupported',
      message: `unsupported proxy scheme ${parsed.protocol}// (use http://, https://, socks5://, or socks5h://)`,
    }
  }
  return { ok: true, value: trimmed }
}

/** Whether a proxy URL uses a SOCKS scheme (`socks:`, `socks5:`, or `socks5h:`). */
export function isSocksProxyUrl(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false
  try {
    return SOCKS_PROTOCOLS.has(new URL(raw.trim()).protocol)
  } catch {
    return false
  }
}

/**
 * Rewrite `socks5h://` to `socks5://` for undici's `Socks5ProxyAgent`, which
 * sends domain names directly through SOCKS5 ATYP=DOMAIN (matching socks5h semantics).
 */
export function normalizeProxyUrlForUndici(raw: string): string {
  const trimmed = raw.trim()
  if (/^socks5h:\/\//i.test(trimmed)) {
    return 'socks5://' + trimmed.slice('socks5h://'.length)
  }
  return trimmed
}

/**
 * Strip username/password credentials from a proxy URL before logging or displaying.
 */
export function redactProxyUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  try {
    const parsed = new URL(trimmed)
    if (parsed.username !== '' || parsed.password !== '') {
      const authHost = parsed.port !== '' ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
      return `${parsed.protocol}//***@${authHost}${parsed.pathname === '/' ? '' : parsed.pathname}`
    }
    return trimmed
  } catch {
    return trimmed.replace(/\/\/[^/@]+@/, '//***@')
  }
}

function formatProxyAuthority(host: string, port: string | undefined, scheme = 'http'): string | undefined {
  const cleanHost = host.trim()
  if (cleanHost === '') return undefined
  const hostWithBrackets = cleanHost.includes(':') && !cleanHost.startsWith('[') ? `[${cleanHost}]` : cleanHost
  const cleanPort = port?.trim()
  if (cleanPort !== undefined && cleanPort !== '' && /^\d+$/.test(cleanPort) && Number(cleanPort) > 0) {
    return `${scheme}://${hostWithBrackets}:${cleanPort}`
  }
  return `${scheme}://${hostWithBrackets}`
}

function ensureScheme(raw: string, defaultScheme = 'http'): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed
  return `${defaultScheme}://${trimmed}`
}

const OCTET_NUM_MAX = 255

function parseIpv4Int(host: string): number | undefined {
  const parts = host.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet < 0 || octet > OCTET_NUM_MAX) return undefined
    value = ((value << 8) | octet) >>> 0
  }
  return value
}

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const LOOPBACK_IPV4 = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`)

/**
 * Whether `hostname` targets this machine (localhost, *.localhost, 127.0.0.0/8, ::1, ::, 0.0.0.0, ::ffff:127/8).
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  const mappedHigh = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host)?.[1]
  if (mappedHigh !== undefined) return Number.parseInt(mappedHigh, 16) >>> 8 === 127
  return LOOPBACK_IPV4.test(host.startsWith('::ffff:') ? host.slice(7) : host)
}

/**
 * Merge multiple bypass lists (`NO_PROXY`, OS exception lists, user rules) and always keep loopback entries.
 */
export function mergeNoProxy(...lists: Array<string | undefined>): string {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    if (list === undefined || list.trim() === '') continue
    for (const raw of list.split(/[,\s;]+/)) {
      const entry = raw.trim()
      if (entry === '') continue
      if (entry === '*') return '*'
      const key = entry.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(entry)
      }
    }
  }
  for (const loopback of LOOPBACK_NO_PROXY) {
    if (!seen.has(loopback)) {
      seen.add(loopback)
      merged.push(loopback)
    }
  }
  return merged.join(',')
}

function splitHostPort(entry: string): { host: string; port?: string } {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    if (close !== -1) {
      const rest = entry.slice(close + 1)
      const host = entry.slice(1, close)
      return rest.startsWith(':') ? { host, port: rest.slice(1) } : { host }
    }
  }
  const colon = entry.indexOf(':')
  if (colon !== -1 && entry.indexOf(':', colon + 1) === -1) {
    return { host: entry.slice(0, colon), port: entry.slice(colon + 1) }
  }
  return { host: entry }
}

function matchesIpv4Cidr(hostInt: number, entry: string): boolean {
  const slash = entry.indexOf('/')
  if (slash === -1) return false
  const network = entry.slice(0, slash)
  const prefixText = entry.slice(slash + 1)
  if (!/^\d{1,2}$/.test(prefixText)) return false
  const prefix = Number(prefixText)
  if (prefix < 0 || prefix > 32) return false
  const netInt = parseIpv4Int(network)
  if (netInt === undefined) return false
  if (prefix === 0) return true
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return (hostInt & mask) === (netInt & mask)
}

function matchesIpv4Wildcard(host: string, pattern: string): boolean {
  if (!pattern.includes('*')) return false
  const hostParts = host.split('.')
  const patParts = pattern.split('.')
  if (hostParts.length !== 4 || patParts.length < 2 || patParts.length > 4) return false
  for (let i = 0; i < patParts.length; i++) {
    const pat = patParts[i]
    if (pat === '*') {
      if (i === patParts.length - 1) return true
      continue
    }
    if (pat !== hostParts[i]) return false
  }
  return patParts.length === 4
}

/**
 * Evaluate whether `url` bypasses the proxy under `noProxy`.
 * Supports loopback, `*`, `<local>`, IPv4 CIDR, IPv4 prefix wildcards (`192.168.*`), domain suffixes, and `:port`.
 */
export function bypassesProxy(noProxy: string, url: URL): boolean {
  if (isLoopbackHost(url.hostname)) return true
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
  const hostIpv4 = parseIpv4Int(host)
  const isIpv6 = host.includes(':')

  for (const raw of noProxy.split(/[,\s;]+/)) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    if (entry === '<local>') {
      if (!isIpv6 && hostIpv4 === undefined && !host.includes('.')) return true
      continue
    }
    if (hostIpv4 !== undefined && matchesIpv4Cidr(hostIpv4, entry)) {
      return true
    }
    const split = splitHostPort(entry)
    if (split.port !== undefined && split.port !== port) continue
    if (hostIpv4 !== undefined && matchesIpv4Wildcard(host, split.host)) {
      return true
    }
    const candidate = split.host.replace(/^\*?\./, '').replace(/\.$/, '')
    if (candidate === '') continue
    if (host === candidate || host.endsWith(`.${candidate}`)) return true
  }
  return false
}

/**
 * Resolve the proxy URL to route `url` through under `policy`, or `undefined` for direct.
 */
export function proxyForUrl(policy: ResolvedProxyPolicy, url: URL): string | undefined {
  const proxy =
    url.protocol === 'https:'
      ? (policy.httpsProxy ?? policy.httpProxy)
      : url.protocol === 'http:'
        ? policy.httpProxy
        : undefined
  if (proxy === undefined) return undefined
  return bypassesProxy(policy.noProxy, url) ? undefined : proxy
}

/** Parse macOS `scutil --proxy` output into a {@link DetectedSystemProxy}. */
export function parseMacScutilProxy(output: string): DetectedSystemProxy {
  const scalars = new Map<string, string>()
  const exceptions: string[] = []
  let inExceptions = false

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (inExceptions) {
      if (line === '}') {
        inExceptions = false
        continue
      }
      const itemMatch = /^\d+\s*:\s*(.+)$/.exec(line)
      if (itemMatch?.[1] !== undefined) {
        exceptions.push(itemMatch[1].trim())
      }
      continue
    }
    if (/^ExceptionsList\s*:\s*<array>\s*\{$/i.test(line)) {
      inExceptions = true
      continue
    }
    const kv = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(line)
    if (kv?.[1] !== undefined && kv[2] !== undefined) {
      scalars.set(kv[1], kv[2].trim())
    }
  }

  const httpEnabled = scalars.get('HTTPEnable') === '1'
  const httpsEnabled = scalars.get('HTTPSEnable') === '1'
  const socksEnabled = scalars.get('SOCKSEnable') === '1'
  const pacEnabled = scalars.get('ProxyAutoConfigEnable') === '1'
  const excludeSimple = scalars.get('ExcludeSimpleHostnames') === '1'

  const httpUrl = httpEnabled
    ? formatProxyAuthority(scalars.get('HTTPProxy') ?? '', scalars.get('HTTPPort'), 'http')
    : undefined
  // macOS HTTPSProxy names an HTTP CONNECT proxy for HTTPS traffic; keep scheme http:// unless explicit.
  const httpsRawHost = scalars.get('HTTPSProxy') ?? ''
  const httpsUrl = httpsEnabled
    ? (httpsRawHost.includes('://')
        ? httpsRawHost
        : formatProxyAuthority(httpsRawHost, scalars.get('HTTPSPort'), 'http'))
    : undefined
  const socksUrl = socksEnabled
    ? formatProxyAuthority(scalars.get('SOCKSProxy') ?? '', scalars.get('SOCKSPort'), 'socks5')
    : undefined

  const bypassItems = [...exceptions]
  if (excludeSimple && !bypassItems.some((item) => item.toLowerCase() === '<local>')) {
    bypassItems.push('<local>')
  }

  const pacUrl = pacEnabled ? scalars.get('ProxyAutoConfigURLString') : undefined
  const httpProxy = httpUrl ?? (httpsUrl === undefined ? socksUrl : undefined)
  const httpsProxy = httpsUrl ?? httpUrl ?? socksUrl

  return {
    source: httpProxy !== undefined || httpsProxy !== undefined ? 'macos-scutil' : 'none',
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(bypassItems.length === 0 ? {} : { noProxy: bypassItems.join(',') }),
    ...(pacUrl === undefined || pacUrl === '' ? {} : { pacUrl }),
  }
}

/** Parse Windows `reg query "HKCU\...\Internet Settings"` output. */
export function parseWindowsRegProxy(output: string): DetectedSystemProxy {
  const values = new Map<string, string>()
  for (const rawLine of output.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s+REG_[A-Z0-9_]+\s+(.+)$/.exec(rawLine)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      values.set(match[1], match[2].trim())
    }
  }

  const enableRaw = values.get('ProxyEnable')?.toLowerCase()
  const enabled = enableRaw === '0x1' || enableRaw === '1'
  const pacRaw = values.get('AutoConfigURL')
  const pacUrl = pacRaw !== undefined && pacRaw !== '' ? pacRaw : undefined

  if (!enabled) {
    return pacUrl === undefined ? { source: 'none' } : { source: 'none', pacUrl }
  }

  const serverRaw = values.get('ProxyServer')?.trim() ?? ''
  let httpProxy: string | undefined
  let httpsProxy: string | undefined
  let socksProxy: string | undefined

  if (serverRaw !== '') {
    if (serverRaw.includes('=')) {
      for (const segment of serverRaw.split(';')) {
        const eq = segment.indexOf('=')
        if (eq === -1) continue
        const key = segment.slice(0, eq).trim().toLowerCase()
        const target = segment.slice(eq + 1).trim()
        if (target === '') continue
        if (key === 'http') httpProxy = ensureScheme(target, 'http')
        else if (key === 'https') httpsProxy = ensureScheme(target, 'http')
        else if (key === 'socks' || key === 'socks5') socksProxy = ensureScheme(target, 'socks5')
      }
    } else {
      const normalized = ensureScheme(serverRaw, 'http')
      httpProxy = normalized
      httpsProxy = normalized
    }
  }

  const effectiveHttp = httpProxy ?? (httpsProxy === undefined ? socksProxy : undefined)
  const effectiveHttps = httpsProxy ?? httpProxy ?? socksProxy

  const overrideRaw = values.get('ProxyOverride')?.trim()
  const noProxy =
    overrideRaw !== undefined && overrideRaw !== ''
      ? overrideRaw
          .split(';')
          .map((item) => item.trim())
          .filter((item) => item !== '')
          .join(',')
      : undefined

  return {
    source: effectiveHttp !== undefined || effectiveHttps !== undefined ? 'windows-registry' : 'none',
    ...(effectiveHttp === undefined ? {} : { httpProxy: effectiveHttp }),
    ...(effectiveHttps === undefined ? {} : { httpsProxy: effectiveHttps }),
    ...(noProxy === undefined ? {} : { noProxy }),
    ...(pacUrl === undefined ? {} : { pacUrl }),
  }
}

export interface GsettingsProxyValues {
  mode?: string | undefined
  httpHost?: string | undefined
  httpPort?: string | undefined
  httpAuth?: string | undefined
  httpUser?: string | undefined
  httpPass?: string | undefined
  httpsHost?: string | undefined
  httpsPort?: string | undefined
  socksHost?: string | undefined
  socksPort?: string | undefined
  ignoreHosts?: string | undefined
  autoconfigUrl?: string | undefined
}

function unquoteGsetting(raw: string | undefined): string {
  if (raw === undefined) return ''
  const trimmed = raw.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseGsettingsIgnoreHosts(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const matches = [...raw.matchAll(/'([^']+)'|"([^"]+)"/g)]
  const items = matches.map((m) => (m[1] ?? m[2] ?? '').trim()).filter((v) => v !== '')
  return items.length === 0 ? undefined : items.join(',')
}

function formatGsettingsHttpUrl(
  host: string,
  port: string | undefined,
  authEnabled: boolean,
  user: string,
  pass: string,
): string | undefined {
  const cleanHost = unquoteGsetting(host)
  if (cleanHost === '') return undefined
  const hostPart = cleanHost.includes(':') && !cleanHost.startsWith('[') ? `[${cleanHost}]` : cleanHost
  const portNum = Number(port?.trim() ?? '0')
  const portPart = Number.isInteger(portNum) && portNum > 0 ? `:${portNum}` : ''
  let authPart = ''
  if (authEnabled && user !== '') {
    authPart = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
  }
  return `http://${authPart}${hostPart}${portPart}`
}

/** Parse GNOME `gsettings` proxy settings values. */
export function parseGsettingsProxy(values: GsettingsProxyValues): DetectedSystemProxy {
  const mode = unquoteGsetting(values.mode)
  const autoconfigUrl = unquoteGsetting(values.autoconfigUrl)
  if (mode === 'auto') {
    return autoconfigUrl === '' ? { source: 'none' } : { source: 'none', pacUrl: autoconfigUrl }
  }
  if (mode !== 'manual') {
    return { source: 'none' }
  }

  const authEnabled = values.httpAuth?.trim() === 'true'
  const user = unquoteGsetting(values.httpUser)
  const pass = unquoteGsetting(values.httpPass)

  const httpUrl = formatGsettingsHttpUrl(values.httpHost ?? '', values.httpPort, authEnabled, user, pass)
  const httpsHost = unquoteGsetting(values.httpsHost)
  const httpsPort = Number(values.httpsPort?.trim() ?? '0')
  const httpsUrl =
    httpsHost !== ''
      ? formatProxyAuthority(httpsHost, Number.isInteger(httpsPort) && httpsPort > 0 ? String(httpsPort) : undefined, 'http')
      : undefined
  const socksHost = unquoteGsetting(values.socksHost)
  const socksPort = Number(values.socksPort?.trim() ?? '0')
  const socksUrl =
    socksHost !== ''
      ? formatProxyAuthority(socksHost, Number.isInteger(socksPort) && socksPort > 0 ? String(socksPort) : undefined, 'socks5')
      : undefined

  const httpProxy = httpUrl ?? (httpsUrl === undefined ? socksUrl : undefined)
  const httpsProxy = httpsUrl ?? httpUrl ?? socksUrl
  const noProxy = parseGsettingsIgnoreHosts(values.ignoreHosts)

  return {
    source: httpProxy !== undefined || httpsProxy !== undefined ? 'linux-gsettings' : 'none',
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(noProxy === undefined ? {} : { noProxy }),
  }
}

function normalizeKdeProxyEntry(raw: string | undefined, defaultScheme: string): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  // KDE sometimes stores "http://127.0.0.1 7890" with a space before the port.
  const spacePort = /^(.+?)\s+(\d{1,5})$/.exec(trimmed)
  const joined = spacePort?.[1] !== undefined && spacePort[2] !== undefined ? `${spacePort[1]}:${spacePort[2]}` : trimmed
  return ensureScheme(joined, defaultScheme)
}

/** Parse KDE `~/.config/kioslaverc` `[Proxy Settings]` section. */
export function parseKdeKioslavercProxy(content: string): DetectedSystemProxy {
  let inProxySection = false
  const entries = new Map<string, string>()

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      inProxySection = /^\[Proxy Settings\]$/i.test(line)
      continue
    }
    if (!inProxySection) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    entries.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }

  const proxyType = entries.get('ProxyType')
  if (proxyType === '2') {
    const pacUrl = entries.get('Proxy Config Script')
    return pacUrl !== undefined && pacUrl !== '' ? { source: 'none', pacUrl } : { source: 'none' }
  }
  if (proxyType !== '1') {
    return { source: 'none' }
  }

  const httpUrl = normalizeKdeProxyEntry(entries.get('httpProxy'), 'http')
  const httpsUrl = normalizeKdeProxyEntry(entries.get('httpsProxy'), 'http')
  const socksUrl = normalizeKdeProxyEntry(entries.get('socksProxy'), 'socks5')
  const httpProxy = httpUrl ?? (httpsUrl === undefined ? socksUrl : undefined)
  const httpsProxy = httpsUrl ?? httpUrl ?? socksUrl
  const noProxyRaw = entries.get('NoProxyFor')
  const noProxy = noProxyRaw !== undefined && noProxyRaw !== '' ? noProxyRaw : undefined

  return {
    source: httpProxy !== undefined || httpsProxy !== undefined ? 'linux-kde' : 'none',
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(noProxy === undefined ? {} : { noProxy }),
  }
}

/**
 * Snapshot launch-time proxy environment variables before this service mutates `process.env`.
 * When `DSH_TRADING_INJECTED_SYSTEM_PROXY=1` is present (set by Electron desktop shell),
 * those injected variables are treated as system-mode bootstrap rather than sticky user exports.
 */
export function captureLaunchProxyEnv(
  env: Record<string, string | undefined> = process.env,
): LaunchProxyEnvSnapshot {
  const isDesktopInjected = env[ENV_INJECTED_MARKER] === '1'
  const userEnv: Record<string, string | undefined> = {}

  if (!isDesktopInjected) {
    for (const name of PROXY_ENV_NAMES) {
      const value = env[name]
      if (value !== undefined && value.trim() !== '') {
        userEnv[name] = value.trim()
      }
    }
  } else if (env.NO_PROXY !== undefined || env.no_proxy !== undefined) {
    if (env.no_proxy !== undefined && env.no_proxy.trim() !== '') userEnv.no_proxy = env.no_proxy.trim()
    if (env.NO_PROXY !== undefined && env.NO_PROXY.trim() !== '') userEnv.NO_PROXY = env.NO_PROXY.trim()
  }

  const hintHttp = env[ENV_DESKTOP_HTTP]?.trim()
  const hintHttps = env[ENV_DESKTOP_HTTPS]?.trim()
  const hintNoProxy = env[ENV_DESKTOP_NO_PROXY]?.trim()
  const desktopSystemHint: DetectedSystemProxy | undefined =
    (hintHttp !== undefined && hintHttp !== '') || (hintHttps !== undefined && hintHttps !== '')
      ? {
          source: 'desktop-system',
          ...(hintHttp !== undefined && hintHttp !== '' ? { httpProxy: hintHttp } : {}),
          ...(hintHttps !== undefined && hintHttps !== '' ? { httpsProxy: hintHttps } : {}),
          ...(hintNoProxy !== undefined && hintNoProxy !== '' ? { noProxy: hintNoProxy } : {}),
        }
      : undefined

  return {
    userEnv,
    ...(desktopSystemHint === undefined ? {} : { desktopSystemHint }),
  }
}

export interface DetectSystemProxyOptions {
  platform?: NodeJS.Platform | undefined
  execFile?: ((file: string, args: readonly string[]) => string) | undefined
  readFile?: ((filePath: string) => string | undefined) | undefined
  homeDir?: string | undefined
  desktopHint?: DetectedSystemProxy | undefined
}

function defaultExecFile(file: string, args: readonly string[]): string {
  return execFileSync(file, [...args], {
    encoding: 'utf8',
    timeout: PROXY_DETECT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function defaultReadFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined
  return readFileSync(filePath, 'utf8')
}

function detectMacSystemProxy(exec: (file: string, args: readonly string[]) => string): DetectedSystemProxy {
  try {
    return parseMacScutilProxy(exec('scutil', ['--proxy']))
  } catch {
    return { source: 'none' }
  }
}

function detectWindowsSystemProxy(exec: (file: string, args: readonly string[]) => string): DetectedSystemProxy {
  try {
    const out = exec('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'])
    return parseWindowsRegProxy(out)
  } catch {
    return { source: 'none' }
  }
}

function safeGsetting(exec: (file: string, args: readonly string[]) => string, schema: string, key: string): string | undefined {
  try {
    return exec('gsettings', ['get', schema, key])
  } catch {
    return undefined
  }
}

function detectLinuxSystemProxy(
  exec: (file: string, args: readonly string[]) => string,
  read: (filePath: string) => string | undefined,
  home: string,
): DetectedSystemProxy {
  const mode = safeGsetting(exec, 'org.gnome.system.proxy', 'mode')
  if (mode !== undefined) {
    const parsed = parseGsettingsProxy({
      mode,
      httpHost: safeGsetting(exec, 'org.gnome.system.proxy.http', 'host'),
      httpPort: safeGsetting(exec, 'org.gnome.system.proxy.http', 'port'),
      httpAuth: safeGsetting(exec, 'org.gnome.system.proxy.http', 'use-authentication'),
      httpUser: safeGsetting(exec, 'org.gnome.system.proxy.http', 'authentication-user'),
      httpPass: safeGsetting(exec, 'org.gnome.system.proxy.http', 'authentication-password'),
      httpsHost: safeGsetting(exec, 'org.gnome.system.proxy.https', 'host'),
      httpsPort: safeGsetting(exec, 'org.gnome.system.proxy.https', 'port'),
      socksHost: safeGsetting(exec, 'org.gnome.system.proxy.socks', 'host'),
      socksPort: safeGsetting(exec, 'org.gnome.system.proxy.socks', 'port'),
      ignoreHosts: safeGsetting(exec, 'org.gnome.system.proxy', 'ignore-hosts'),
      autoconfigUrl: safeGsetting(exec, 'org.gnome.system.proxy', 'autoconfig-url'),
    })
    if (parsed.source !== 'none' || parsed.pacUrl !== undefined) {
      return parsed
    }
  }

  for (const rel of ['.config/kioslaverc', '.kde/share/config/kioslaverc']) {
    try {
      const content = read(join(home, rel))
      if (content !== undefined) {
        const kde = parseKdeKioslavercProxy(content)
        if (kde.source !== 'none' || kde.pacUrl !== undefined) return kde
      }
    } catch {
      // Ignore unreadable KDE config file.
    }
  }
  return { source: 'none' }
}

/**
 * Detect OS-level proxy settings, falling back to an Electron `session.resolveProxy` hint when present.
 * Never throws: probe errors degrade softly to `{ source: 'none' }`.
 */
export function detectSystemProxy(options: DetectSystemProxyOptions = {}): DetectedSystemProxy {
  const platform = options.platform ?? process.platform
  const exec = options.execFile ?? defaultExecFile
  const read = options.readFile ?? defaultReadFile
  const home = options.homeDir ?? homedir()

  let detected: DetectedSystemProxy = { source: 'none' }
  if (platform === 'darwin') detected = detectMacSystemProxy(exec)
  else if (platform === 'win32') detected = detectWindowsSystemProxy(exec)
  else if (platform === 'linux') detected = detectLinuxSystemProxy(exec, read, home)

  if (detected.source !== 'none') return detected
  if (options.desktopHint !== undefined && options.desktopHint.source !== 'none') {
    return {
      ...options.desktopHint,
      ...(detected.noProxy !== undefined && options.desktopHint.noProxy === undefined
        ? { noProxy: detected.noProxy }
        : {}),
      ...(detected.pacUrl !== undefined && options.desktopHint.pacUrl === undefined
        ? { pacUrl: detected.pacUrl }
        : {}),
    }
  }
  return detected
}

function readEnvPair(
  env: Record<string, string | undefined>,
  lower: string,
): { name: string; value: string } | undefined {
  for (const name of [lower, lower.toUpperCase()]) {
    const val = env[name]?.trim()
    if (val !== undefined && val !== '') return { name, value: val }
  }
  return undefined
}

function acceptEnvProxy(
  candidate: { name: string; value: string } | undefined,
  diagnostics: string[],
): { kind: 'absent' } | { kind: 'rejected' } | { kind: 'accepted'; value: string } {
  if (candidate === undefined) return { kind: 'absent' }
  const validation = validateProxyUrl(candidate.value)
  if (!validation.ok) {
    diagnostics.push(`${candidate.name}: ${validation.message}`)
    return { kind: 'rejected' }
  }
  return { kind: 'accepted', value: validation.value }
}

function resolveEnvProxyPolicy(
  userEnv: Record<string, string | undefined>,
  extraNoProxy: string | undefined,
  diagnostics: string[],
): ResolvedProxyPolicy | undefined {
  const all = acceptEnvProxy(readEnvPair(userEnv, 'all_proxy'), diagnostics)
  const allVal = all.kind === 'accepted' ? all.value : undefined
  const httpSlot = acceptEnvProxy(readEnvPair(userEnv, 'http_proxy'), diagnostics)
  const httpsSlot = acceptEnvProxy(readEnvPair(userEnv, 'https_proxy'), diagnostics)

  const httpProxy =
    httpSlot.kind === 'accepted'
      ? httpSlot.value
      : httpSlot.kind === 'rejected'
        ? undefined
        : allVal

  const httpsProxy =
    httpsSlot.kind === 'accepted'
      ? httpsSlot.value
      : httpsSlot.kind === 'rejected'
        ? undefined
        : (allVal ?? httpProxy)

  if (httpProxy === undefined && httpsProxy === undefined) return undefined
  const envNoProxy = readEnvPair(userEnv, 'no_proxy')?.value
  return {
    mode: 'system',
    source: 'env',
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    noProxy: mergeNoProxy(envNoProxy, extraNoProxy),
    diagnostics,
  }
}

/**
 * Resolve the effective proxy policy from persisted config, launch env snapshot, and detected OS proxy.
 */
export function resolveEffectiveProxyPolicy(
  config: ProxyConfig,
  launchSnapshot: LaunchProxyEnvSnapshot,
  detectedSystem: DetectedSystemProxy,
): ResolvedProxyPolicy {
  const mode = normalizeProxyMode(config.mode)
  const diagnostics: string[] = []
  const userNoProxy = config.noProxy?.trim()

  if (mode === 'direct') {
    return {
      mode: 'direct',
      source: 'direct',
      noProxy: mergeNoProxy(userNoProxy),
      diagnostics,
    }
  }

  if (mode === 'custom') {
    const rawUrl = config.url ?? ''
    const check = validateProxyUrl(rawUrl)
    if (!check.ok) {
      diagnostics.push(
        check.kind === 'empty'
          ? 'custom proxy mode selected without a proxy URL; connecting directly'
          : `custom proxy URL rejected (${check.message}); connecting directly`,
      )
      return {
        mode: 'custom',
        source: 'none',
        noProxy: mergeNoProxy(userNoProxy),
        diagnostics,
      }
    }
    return {
      mode: 'custom',
      source: 'custom',
      httpProxy: check.value,
      httpsProxy: check.value,
      noProxy: mergeNoProxy(userNoProxy),
      diagnostics,
    }
  }

  // mode === 'system': explicit launch environment variables win over OS system proxy.
  const fromEnv = resolveEnvProxyPolicy(launchSnapshot.userEnv, userNoProxy, diagnostics)
  if (fromEnv !== undefined) return fromEnv

  if (detectedSystem.source !== 'none') {
    const httpCheck = detectedSystem.httpProxy !== undefined ? validateProxyUrl(detectedSystem.httpProxy) : undefined
    const httpsCheck = detectedSystem.httpsProxy !== undefined ? validateProxyUrl(detectedSystem.httpsProxy) : undefined
    const httpProxy = httpCheck?.ok ? httpCheck.value : undefined
    const httpsProxy = httpsCheck?.ok ? httpsCheck.value : undefined
    if (httpCheck !== undefined && !httpCheck.ok) diagnostics.push(`system http proxy rejected: ${httpCheck.message}`)
    if (httpsCheck !== undefined && !httpsCheck.ok) diagnostics.push(`system https proxy rejected: ${httpsCheck.message}`)
    if (httpProxy !== undefined || httpsProxy !== undefined) {
      return {
        mode: 'system',
        source: detectedSystem.source,
        ...(httpProxy === undefined ? {} : { httpProxy }),
        ...(httpsProxy === undefined ? {} : { httpsProxy }),
        noProxy: mergeNoProxy(detectedSystem.noProxy, launchSnapshot.userEnv.NO_PROXY, launchSnapshot.userEnv.no_proxy, userNoProxy),
        diagnostics,
      }
    }
  }

  if (detectedSystem.pacUrl !== undefined) {
    diagnostics.push(`system proxy uses PAC (${detectedSystem.pacUrl}); configure HTTP/SOCKS5 proxy URL if auto-config is not resolved`)
  }
  return {
    mode: 'system',
    source: 'none',
    noProxy: mergeNoProxy(launchSnapshot.userEnv.NO_PROXY, launchSnapshot.userEnv.no_proxy, userNoProxy),
    diagnostics,
  }
}
