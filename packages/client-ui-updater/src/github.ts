/**
 * GitHub Releases client for the update channel. Detection uses the public
 * REST API (repos/<owner>/<repo>/releases/latest) which already excludes
 * drafts and prereleases — the release pipeline only publishes stable tags.
 * No token: the repo is public and the cadence (startup + 6h) sits far below
 * the unauthenticated rate limit.
 */

/** Parsed GitHub release shape the updater consumes. */
export interface ReleaseInfo {
  /** e.g. "v0.2.0" */
  tagName: string
  /** e.g. "0.2.0" (parsed from the tag; undefined when the tag is not vX.Y.Z) */
  version: string | undefined
  /** Release title. */
  name: string
  /** Release body markdown (the notes the settings page renders). */
  notes: string
  /** Human-facing release page URL. */
  url: string
  /** ISO timestamp of publication. */
  publishedAt: string | undefined
  /** Assets: name + browser download URL + byte size. */
  assets: ReleaseAsset[]
}

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface FetchReleaseOptions {
  /** GitHub REST API base (overridable for tests). */
  apiBase?: string
  /** repo slug, e.g. "zhu1090093659/dsh-trading". */
  repo: string
  /** Timeout per request (default 15s). */
  timeoutMs?: number
  /** Fetch implementation (defaults to globalThis.fetch; injectable for tests). */
  fetchImpl?: typeof fetch
}

export const GITHUB_API_BASE = 'https://api.github.com'

/** Update payload manifest asset name for a tag, e.g. updates-manifest-v0.2.0.json. */
export function manifestAssetName(tagName: string): string {
  return `updates-manifest-${tagName}.json`
}

/** Update payload zip asset name for a tag, e.g. trading-update-v0.2.0.zip. */
export function payloadAssetName(tagName: string): string {
  return `trading-update-${tagName}.zip`
}

function parseAsset(raw: unknown): ReleaseAsset | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as { name?: unknown; browser_download_url?: unknown; size?: unknown }
  if (typeof record.name !== 'string' || typeof record.browser_download_url !== 'string') return undefined
  return {
    name: record.name,
    url: record.browser_download_url,
    size: typeof record.size === 'number' ? record.size : 0,
  }
}

/**
 * Fetch the latest published release. Returns undefined when the repo has no
 * full releases yet (GitHub answers 404 for /releases/latest then).
 */
export async function fetchLatestRelease(options: FetchReleaseOptions): Promise<ReleaseInfo | undefined> {
  const apiBase = options.apiBase ?? GITHUB_API_BASE
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetchImpl(`${apiBase}/repos/${options.repo}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        // GitHub API rejects requests without a User-Agent.
        'user-agent': 'dsh-trading-updater',
      },
      signal: controller.signal,
    })
    if (response.status === 404) return undefined
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status} for ${options.repo} releases/latest`)
    }
    const body = await response.json() as Record<string, unknown>
    const tagName = typeof body.tag_name === 'string' ? body.tag_name : ''
    const assets = Array.isArray(body.assets)
      ? body.assets.map(parseAsset).filter((asset): asset is ReleaseAsset => asset !== undefined)
      : []
    return {
      tagName,
      version: /^v/.test(tagName) ? tagName.slice(1) : tagName,
      name: typeof body.name === 'string' ? body.name : '',
      notes: typeof body.body === 'string' ? body.body : '',
      url: typeof body.html_url === 'string' ? body.html_url : `https://github.com/${options.repo}/releases`,
      publishedAt: typeof body.published_at === 'string' ? body.published_at : undefined,
      assets,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Machine-readable update manifest (the trust anchor for the payload zip). */
export interface UpdateManifest {
  schema: 1
  version: string
  tag: string
  generatedAt: string
  payload: { file: string; sha256: string; bytes: number }
  packages: Array<{ name: string; version: string }>
}

/** Parse + structurally validate a fetched manifest body. */
export function parseUpdateManifest(text: string): UpdateManifest {
  const raw = JSON.parse(text) as Record<string, unknown>
  if (raw.schema !== 1) throw new Error('unsupported updates-manifest schema')
  const payload = raw.payload as UpdateManifest['payload'] | undefined
  if (payload === undefined || typeof payload.file !== 'string'
    || typeof payload.sha256 !== 'string' || typeof payload.bytes !== 'number') {
    throw new Error('updates-manifest payload block malformed')
  }
  if (!Array.isArray(raw.packages)) throw new Error('updates-manifest packages missing')
  const packages = raw.packages.map((item) => {
    const entry = item as { name?: unknown; version?: unknown }
    if (typeof entry.name !== 'string' || typeof entry.version !== 'string') {
      throw new Error('updates-manifest package entry malformed')
    }
    return { name: entry.name as string, version: entry.version as string }
  })
  if (typeof raw.version !== 'string' || typeof raw.tag !== 'string') {
    throw new Error('updates-manifest version/tag missing')
  }
  return {
    schema: 1,
    version: raw.version,
    tag: raw.tag,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    payload,
    packages,
  }
}
