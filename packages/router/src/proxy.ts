/**
 * Runtime network proxy manager (`tradingNetworkProxy` Cordis service).
 *
 * Installs a dynamic `undici` global dispatcher so every `globalThis.fetch`
 * call across connectors, kits, holdings FX, updater, and the DSH host
 * respects the active proxy policy (default: OS system proxy) and supports
 * zero-restart hot updates from settings.
 *
 * @module @dshtrading/router/proxy
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  Agent,
  Pool,
  ProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici'
import {
  captureLaunchProxyEnv,
  detectSystemProxy,
  isSocksProxyUrl,
  mergeNoProxy,
  normalizeProxyMode,
  normalizeProxyUrlForUndici,
  proxyForUrl,
  redactProxyUrl,
  resolveEffectiveProxyPolicy,
  type DetectedSystemProxy,
  type LaunchProxyEnvSnapshot,
  type ProxyConfig,
  type ProxyMode,
  type ProxySource,
  type ResolvedProxyPolicy,
} from './system-proxy.ts'

export const TRADING_NETWORK_PROXY_KEY = 'tradingNetworkProxy'

/** Fixed SSRF-safe connectivity check endpoints (no arbitrary user URLs). */
export const PROXY_TEST_TARGETS = {
  okx: 'https://www.okx.com/api/v5/public/time',
  binance: 'https://api.binance.com/api/v3/ping',
  yahoo: 'https://query1.finance.yahoo.com/v1/test/getcrumb',
  github: 'https://api.github.com/zen',
} as const

export type ProxyTestTarget = keyof typeof PROXY_TEST_TARGETS

export function isProxyTestTarget(value: unknown): value is ProxyTestTarget {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROXY_TEST_TARGETS, value)
}

export interface NetworkProxyStatusSnapshot {
  mode: ProxyMode
  active: boolean
  source: ProxySource
  httpProxy?: string
  httpsProxy?: string
  noProxy: string
  detectedSystem: {
    source: ProxySource
    httpProxy?: string
    httpsProxy?: string
    noProxy?: string
    pacUrl?: string
  }
  diagnostics: readonly string[]
}

export interface ProxyConnectivityTestOptions {
  target?: ProxyTestTarget | undefined
  override?: ProxyConfig | undefined
  timeoutMs?: number | undefined
}

export interface ProxyConnectivityTestResult {
  ok: boolean
  target: ProxyTestTarget
  status?: number
  latencyMs: number
  proxied: boolean
  proxy?: string
  error?: string
}

export interface NetworkProxyServiceOptions {
  env?: Record<string, string | undefined>
  detectSystem?: () => DetectedSystemProxy
  getDispatcher?: () => Dispatcher
  setDispatcher?: (dispatcher: Dispatcher) => void
  fetchImpl?: typeof undiciFetch
  targetUrlResolver?: (target: ProxyTestTarget) => string
}

const MANAGED_ENV_NAMES = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
] as const

const DEFAULT_TEST_TIMEOUT_MS = 8000
const MIN_TEST_TIMEOUT_MS = 1000
const MAX_TEST_TIMEOUT_MS = 30000
const MAX_ERROR_CAUSE_DEPTH = 4

function setOrDeleteEnv(
  env: Record<string, string | undefined>,
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete env[name]
  } else {
    env[name] = value
  }
}

/**
 * Create an `undici` dispatcher enforcing `policy` per origin.
 * Strips `factory` from `passedOptions` so the outer `Agent.factory` is never forwarded into `ProxyAgent`.
 */
export function createProxyDispatcher(policy: ResolvedProxyPolicy): Dispatcher {
  if (policy.httpProxy === undefined && policy.httpsProxy === undefined) {
    return new Agent()
  }
  return new Agent({
    factory(origin, passedOptions) {
      const optionsObj = (passedOptions ?? {}) as Record<string, unknown>
      const { factory: _outerFactory, ...poolOptions } = optionsObj
      const url = new URL(origin.toString())
      const proxy = proxyForUrl(policy, url)
      if (proxy === undefined) {
        return new Pool(origin, poolOptions)
      }
      return new ProxyAgent({
        ...poolOptions,
        uri: normalizeProxyUrlForUndici(proxy),
      })
    },
  })
}

/**
 * Synchronize proxy environment variables for child processes (`git`, `curl`, MCP servers, Node children).
 * Never sets `NODE_USE_ENV_PROXY=1` when any active slot uses SOCKS5 (Node exits at startup on SOCKS env URLs).
 */
export function publishProxyEnv(
  policy: ResolvedProxyPolicy,
  env: Record<string, string | undefined>,
  originalEnv: Record<string, string | undefined>,
): void {
  const active = policy.httpProxy !== undefined || policy.httpsProxy !== undefined
  if (!active || policy.mode === 'direct') {
    setOrDeleteEnv(env, 'http_proxy', undefined)
    setOrDeleteEnv(env, 'HTTP_PROXY', undefined)
    setOrDeleteEnv(env, 'https_proxy', undefined)
    setOrDeleteEnv(env, 'HTTPS_PROXY', undefined)
    setOrDeleteEnv(env, 'all_proxy', undefined)
    setOrDeleteEnv(env, 'ALL_PROXY', undefined)
    setOrDeleteEnv(env, 'NODE_USE_ENV_PROXY', undefined)
    if (policy.mode === 'direct') {
      setOrDeleteEnv(env, 'no_proxy', policy.noProxy)
      setOrDeleteEnv(env, 'NO_PROXY', policy.noProxy)
    } else {
      setOrDeleteEnv(env, 'no_proxy', originalEnv.no_proxy)
      setOrDeleteEnv(env, 'NO_PROXY', originalEnv.NO_PROXY)
    }
    return
  }

  const socksActive = isSocksProxyUrl(policy.httpProxy) || isSocksProxyUrl(policy.httpsProxy)
  if (socksActive) {
    const socksProxy = policy.httpsProxy ?? policy.httpProxy
    setOrDeleteEnv(env, 'http_proxy', undefined)
    setOrDeleteEnv(env, 'HTTP_PROXY', undefined)
    setOrDeleteEnv(env, 'https_proxy', undefined)
    setOrDeleteEnv(env, 'HTTPS_PROXY', undefined)
    setOrDeleteEnv(env, 'NODE_USE_ENV_PROXY', undefined)
    setOrDeleteEnv(env, 'all_proxy', socksProxy)
    setOrDeleteEnv(env, 'ALL_PROXY', socksProxy)
    setOrDeleteEnv(env, 'no_proxy', policy.noProxy)
    setOrDeleteEnv(env, 'NO_PROXY', policy.noProxy)
    return
  }

  setOrDeleteEnv(env, 'http_proxy', policy.httpProxy)
  setOrDeleteEnv(env, 'HTTP_PROXY', policy.httpProxy)
  setOrDeleteEnv(env, 'https_proxy', policy.httpsProxy)
  setOrDeleteEnv(env, 'HTTPS_PROXY', policy.httpsProxy)
  setOrDeleteEnv(env, 'all_proxy', undefined)
  setOrDeleteEnv(env, 'ALL_PROXY', undefined)
  setOrDeleteEnv(env, 'no_proxy', policy.noProxy)
  setOrDeleteEnv(env, 'NO_PROXY', policy.noProxy)
  setOrDeleteEnv(env, 'NODE_USE_ENV_PROXY', '1')
}

function formatProbeError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH && current instanceof Error; depth++) {
    const code = (current as { code?: unknown }).code
    const prefix = typeof code === 'string' && code !== '' ? `${code}: ` : ''
    const msg = `${prefix}${current.message}`
    if (!parts.includes(msg)) parts.push(msg)
    current = current.cause
  }
  const combined = parts.length > 0 ? parts.join(' -> ') : String(error)
  return combined.replace(/(https?|socks5h?|socks):\/\/[^/@\s]+@/gi, '$1://***@')
}

export class NetworkProxyService extends Service {
  private readonly env: Record<string, string | undefined>
  private readonly originalEnv: Record<string, string | undefined>
  private readonly launchSnapshot: LaunchProxyEnvSnapshot
  private readonly detectSystemFn: () => DetectedSystemProxy
  private readonly getDispatcherFn: () => Dispatcher
  private readonly setDispatcherFn: (dispatcher: Dispatcher) => void
  private readonly fetchImpl: typeof undiciFetch
  private readonly targetUrlResolver: (target: ProxyTestTarget) => string

  private currentConfig: ProxyConfig = { mode: 'system' }
  private detectedSystem: DetectedSystemProxy = { source: 'none' }
  private systemDetectedOnce = false
  private currentPolicy: ResolvedProxyPolicy = {
    mode: 'system',
    source: 'none',
    noProxy: mergeNoProxy(),
    diagnostics: [],
  }
  private originalDispatcher: Dispatcher | undefined
  private ownedDispatcher: Dispatcher | undefined
  private hasApplied = false
  private disposed = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, options: NetworkProxyServiceOptions = {}) {
    super(ctx, TRADING_NETWORK_PROXY_KEY)
    this.env = options.env ?? (process.env as Record<string, string | undefined>)
    this.originalEnv = Object.fromEntries(MANAGED_ENV_NAMES.map((name) => [name, this.env[name]]))
    this.launchSnapshot = captureLaunchProxyEnv(this.env)
    this.detectSystemFn =
      options.detectSystem ?? (() => detectSystemProxy({ desktopHint: this.launchSnapshot.desktopSystemHint }))
    this.getDispatcherFn = options.getDispatcher ?? getGlobalDispatcher
    this.setDispatcherFn = options.setDispatcher ?? setGlobalDispatcher
    this.fetchImpl = options.fetchImpl ?? undiciFetch
    this.targetUrlResolver = options.targetUrlResolver ?? ((target) => PROXY_TEST_TARGETS[target])
  }

  /** Current redacted status snapshot for UI/diagnostics. */
  snapshot(): NetworkProxyStatusSnapshot {
    const httpProxy = redactProxyUrl(this.currentPolicy.httpProxy)
    const httpsProxy = redactProxyUrl(this.currentPolicy.httpsProxy)
    const detectedHttp = redactProxyUrl(this.detectedSystem.httpProxy)
    const detectedHttps = redactProxyUrl(this.detectedSystem.httpsProxy)

    return {
      mode: this.currentPolicy.mode,
      active: this.currentPolicy.httpProxy !== undefined || this.currentPolicy.httpsProxy !== undefined,
      source: this.currentPolicy.source,
      ...(httpProxy === undefined ? {} : { httpProxy }),
      ...(httpsProxy === undefined ? {} : { httpsProxy }),
      noProxy: this.currentPolicy.noProxy,
      detectedSystem: {
        source: this.detectedSystem.source,
        ...(detectedHttp === undefined ? {} : { httpProxy: detectedHttp }),
        ...(detectedHttps === undefined ? {} : { httpsProxy: detectedHttps }),
        ...(this.detectedSystem.noProxy === undefined ? {} : { noProxy: this.detectedSystem.noProxy }),
        ...(this.detectedSystem.pacUrl === undefined ? {} : { pacUrl: this.detectedSystem.pacUrl }),
      },
      diagnostics: [...this.currentPolicy.diagnostics],
    }
  }

  /** Apply a new proxy configuration and swap the global undici dispatcher atomically. */
  applyConfig(
    config: ProxyConfig,
    options: { refreshSystem?: boolean } = {},
  ): Promise<NetworkProxyStatusSnapshot> {
    const task = this.queue.then(() => this.applyConfigLocked(config, options))
    this.queue = task.catch(() => undefined)
    return task
  }

  private async applyConfigLocked(
    config: ProxyConfig,
    options: { refreshSystem?: boolean },
  ): Promise<NetworkProxyStatusSnapshot> {
    if (this.disposed) return this.snapshot()
    this.currentConfig = { ...config }

    if (options.refreshSystem === true || !this.systemDetectedOnce) {
      this.detectedSystem = this.detectSystemFn()
      this.systemDetectedOnce = true
    }

    const policy = resolveEffectiveProxyPolicy(this.currentConfig, this.launchSnapshot, this.detectedSystem)
    const nextDispatcher = createProxyDispatcher(policy)
    if (this.originalDispatcher === undefined) {
      this.originalDispatcher = this.getDispatcherFn()
    }
    const previousOwned = this.ownedDispatcher
    this.setDispatcherFn(nextDispatcher)
    this.ownedDispatcher = nextDispatcher
    this.hasApplied = true
    this.currentPolicy = policy
    publishProxyEnv(policy, this.env, this.originalEnv)

    if (previousOwned !== undefined) {
      await previousOwned.close().catch(() => undefined)
    }
    return this.snapshot()
  }

  /** Re-probe the OS system proxy and re-apply if the active mode is `system`. */
  refreshSystemProxy(): Promise<NetworkProxyStatusSnapshot> {
    const task = this.queue.then(() => this.refreshSystemProxyLocked())
    this.queue = task.catch(() => undefined)
    return task
  }

  private async refreshSystemProxyLocked(): Promise<NetworkProxyStatusSnapshot> {
    if (this.disposed) return this.snapshot()
    this.detectedSystem = this.detectSystemFn()
    this.systemDetectedOnce = true
    if (normalizeProxyMode(this.currentConfig.mode) === 'system' || !this.hasApplied) {
      return await this.applyConfigLocked(this.currentConfig, { refreshSystem: false })
    }
    return this.snapshot()
  }

  /** Probe connectivity through the active policy or an unsaved draft `override`. */
  async testConnectivity(options: ProxyConnectivityTestOptions = {}): Promise<ProxyConnectivityTestResult> {
    const target: ProxyTestTarget = options.target ?? 'okx'
    const timeoutMs = Math.min(
      MAX_TEST_TIMEOUT_MS,
      Math.max(MIN_TEST_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS),
    )

    let policy: ResolvedProxyPolicy
    if (options.override !== undefined) {
      if (!this.systemDetectedOnce) {
        this.detectedSystem = this.detectSystemFn()
        this.systemDetectedOnce = true
      }
      policy = resolveEffectiveProxyPolicy(options.override, this.launchSnapshot, this.detectedSystem)
      if (
        normalizeProxyMode(options.override.mode) === 'custom'
        && policy.httpProxy === undefined
        && policy.httpsProxy === undefined
      ) {
        return {
          ok: false,
          target,
          latencyMs: 0,
          proxied: false,
          error: policy.diagnostics[0] ?? 'Custom proxy URL is empty or invalid',
        }
      }
    } else if (this.hasApplied) {
      policy = this.currentPolicy
    } else {
      if (!this.systemDetectedOnce) {
        this.detectedSystem = this.detectSystemFn()
        this.systemDetectedOnce = true
      }
      policy = resolveEffectiveProxyPolicy(this.currentConfig, this.launchSnapshot, this.detectedSystem)
    }

    const url = this.targetUrlResolver(target)
    const matchedProxy = proxyForUrl(policy, new URL(url))
    const redactedProxy = redactProxyUrl(matchedProxy)
    const dispatcher = createProxyDispatcher(policy)
    const started = Date.now()
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
      })
      await response.body?.cancel().catch(() => undefined)
      const latencyMs = Date.now() - started
      const ok = response.status >= 200 && response.status < 500 && response.status !== 407
      return {
        ok,
        target,
        status: response.status,
        latencyMs,
        proxied: matchedProxy !== undefined,
        ...(redactedProxy === undefined ? {} : { proxy: redactedProxy }),
        ...(ok ? {} : { error: `HTTP ${String(response.status)}` }),
      }
    } catch (error) {
      return {
        ok: false,
        target,
        latencyMs: Date.now() - started,
        proxied: matchedProxy !== undefined,
        ...(redactedProxy === undefined ? {} : { proxy: redactedProxy }),
        error: formatProbeError(error),
      }
    } finally {
      await dispatcher.close().catch(() => undefined)
    }
  }

  /** Restore the original global dispatcher and process environment variables. */
  dispose(): Promise<void> {
    this.disposed = true
    const task = this.queue.then(async () => {
      if (this.originalDispatcher !== undefined) {
        this.setDispatcherFn(this.originalDispatcher)
      }
      for (const name of MANAGED_ENV_NAMES) {
        setOrDeleteEnv(this.env, name, this.originalEnv[name])
      }
      const owned = this.ownedDispatcher
      this.ownedDispatcher = undefined
      if (owned !== undefined) {
        await owned.close().catch(() => undefined)
      }
    })
    this.queue = task.catch(() => undefined)
    return task
  }
}
