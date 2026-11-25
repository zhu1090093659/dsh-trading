/**
 * Browser-side client wrappers for `/dshtrading/api/proxy/*`.
 */

export type ProxyMode = 'system' | 'custom' | 'direct'

export type ProxyTestTarget = 'okx' | 'binance' | 'yahoo' | 'github'

export interface ProxyStatusSnapshot {
  mode: ProxyMode
  active: boolean
  source: string
  httpProxy?: string
  httpsProxy?: string
  noProxy: string
  detectedSystem: {
    source: string
    httpProxy?: string
    httpsProxy?: string
    noProxy?: string
    pacUrl?: string
  }
  diagnostics: readonly string[]
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

export class ProxyBridgeError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
  }
}

async function parseJsonEnvelope<T>(response: Response, path: string): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { code?: string; message?: string } | undefined
    const detail = typeof body?.message === 'string' && body.message !== '' ? `: ${body.message}` : ''
    throw new ProxyBridgeError(response.status, `${path} failed (${String(response.status)})${detail}`, body?.code)
  }
  return await response.json() as T
}

/** Fetch the current redacted network proxy status (optionally refreshing OS proxy detection). */
export async function fetchProxyStatus(refresh = false): Promise<ProxyStatusSnapshot> {
  const path = refresh ? '/dshtrading/api/proxy/status?refresh=1' : '/dshtrading/api/proxy/status'
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  return parseJsonEnvelope<ProxyStatusSnapshot>(response, path)
}

/** Run a connectivity test against a whitelisted endpoint via the active or draft proxy config. */
export async function requestProxyTest(params: {
  target: ProxyTestTarget
  override?: { mode: ProxyMode; url?: string; noProxy?: string }
}): Promise<ProxyConnectivityTestResult> {
  const path = '/dshtrading/api/proxy/test'
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(params),
  })
  return parseJsonEnvelope<ProxyConnectivityTestResult>(response, path)
}
