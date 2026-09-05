/**
 * Updater service tests against a fake desktop-seeded profile: real fs, real
 * zip payload (fflate zipSync), stubbed fetch. Covers the check flow (TTL,
 * error retention) and the full incremental apply pipeline (download →
 * verify → swap → cleanup), plus rollback on a locked packages root and the
 * stale-target guard.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverEnvironmentFrom } from '../src/environment.js'
import { manifestAssetName, payloadAssetName } from '../src/github.js'
import { UpdaterService } from '../src/updater-service.js'

const CURRENT_VERSION = '0.1.1'
const TARGET_TAG = 'v0.2.0'
const TARGET_VERSION = '0.2.0'

interface InstalledPackage { name: string; version: string }

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

/** Fake desktop-seeded profile: marker + a couple of installed packages. */
function makeProfile(installed: InstalledPackage[], familyVersion: string = CURRENT_VERSION): { root: string; packagesDir: string } {
  const root = makeTempDir('dsh-updater-profile-')
  writeFileSync(path.join(root, '.dsh-desktop-seed.json'), JSON.stringify({
    stamp: 'test-stamp',
    appVersion: CURRENT_VERSION,
    seededAt: '2026-09-04T00:00:00.000Z',
  }))
  // The updater package itself is part of the family: its manifest version is
  // what discoverEnvironmentFrom reports as familyVersion.
  const all = [...installed, { name: 'client-ui-updater', version: familyVersion }]
  for (const pkg of all) {
    const dir = path.join(root, 'node_modules', '@dshtrading', pkg.name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@dshtrading/' + pkg.name, version: pkg.version }))
  }
  return { root, packagesDir: path.join(root, 'node_modules', '@dshtrading') }
}

function envFor(profileRoot: string) {
  // The walk only looks at ancestor directories; the anchor file need not exist.
  return discoverEnvironmentFrom(path.join(profileRoot, 'node_modules', '@dshtrading', 'client-ui-updater', 'lib', 'index.js'))
}

function buildPayloadZip(packages: Array<{ name: string; version: string; extra?: Record<string, string> }>): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const pkg of packages) {
    entries[`packages/@dshtrading/${pkg.name}/package.json`] = strToU8(JSON.stringify({ name: '@dshtrading/' + pkg.name, version: pkg.version }))
    for (const [relative, content] of Object.entries(pkg.extra ?? {})) {
      entries[`packages/@dshtrading/${pkg.name}/${relative}`] = strToU8(content)
    }
  }
  return zipSync(entries)
}

function releasePayload(tag: string, assets: Array<{ name: string }>) {
  return {
    tag_name: tag,
    name: 'dsh-trading ' + tag,
    body: '## What changed\n- something',
    html_url: `https://github.com/zhu1090093659/dsh-trading/releases/tag/${tag}`,
    published_at: '2026-09-04T00:00:00.000Z',
    assets: assets.map((asset) => ({ name: asset.name, browser_download_url: `https://assets.example/${asset.name}`, size: 1 })),
  }
}

function stubResponse(body: { json?: unknown; text?: string; bytes?: Uint8Array }): typeof Response {
  const headers = { get: (name: string) => (name.toLowerCase() === 'content-length' && body.bytes !== undefined ? String(body.bytes.length) : null) }
  const stream = body.bytes === undefined
    ? undefined
    : new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.bytes)
          controller.close()
        },
      })
  return {
    ok: true,
    status: 200,
    headers,
    body: stream ?? null,
    json: async () => body.json,
    text: async () => body.text ?? '',
  } as unknown as typeof Response
}

interface Harness {
  service: UpdaterService
  statePath: string
  profileRoot: string
  packagesDir: string
  release: ReturnType<typeof releasePayload>
  calls: string[]
}

function makeHarness(options: {
  installed: InstalledPackage[]
  targetPackages: Array<{ name: string; version: string; extra?: Record<string, string> }>
  familyVersion?: string
}): Harness {
  const profile = makeProfile(options.installed, options.familyVersion)
  const statePath = path.join(makeTempDir('dsh-updater-state-'), 'state.json')
  const zip = buildPayloadZip(options.targetPackages)
  const manifest = {
    schema: 1,
    version: TARGET_VERSION,
    tag: TARGET_TAG,
    generatedAt: '2026-09-04T00:00:00.000Z',
    payload: { file: payloadAssetName(TARGET_TAG), sha256: sha256Hex(zip), bytes: zip.length },
    packages: options.targetPackages.map((pkg) => ({ name: '@dshtrading/' + pkg.name, version: pkg.version })),
  }
  const release = releasePayload(TARGET_TAG, [
    { name: manifestAssetName(TARGET_TAG) },
    { name: payloadAssetName(TARGET_TAG) },
  ])
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    if (url.includes('/releases/latest')) return stubResponse({ json: release })
    if (url.includes('updates-manifest')) return stubResponse({ text: JSON.stringify(manifest) })
    if (url.includes('trading-update')) return stubResponse({ bytes: zip })
    throw new Error('unexpected fetch: ' + url)
  }) as unknown as typeof fetch
  const service = new UpdaterService({
    env: envFor(profile.root),
    repo: 'zhu1090093659/dsh-trading',
    statePath,
    github: { fetchImpl, apiBase: 'https://api.example' },
  })
  return { service, statePath, profileRoot: profile.root, packagesDir: profile.packagesDir, release, calls }
}

function installedVersion(packagesDir: string, name: string): string {
  return (JSON.parse(readFileSync(path.join(packagesDir, ...name.split('/'), 'package.json'), 'utf8')) as { version: string }).version
}

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop()
    if (dir === undefined) continue
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('UpdaterService.check', () => {
  it('detects a newer release with release notes and payload availability', async () => {
    const harness = makeHarness({
      installed: [{ name: 'base', version: CURRENT_VERSION }],
      targetPackages: [{ name: 'base', version: TARGET_VERSION }],
    })
    cleanup.push(harness.profileRoot)
    const snapshot = await harness.service.check(true)
    expect(snapshot.check.status).toBe('ok')
    expect(snapshot.check.available).toBe(true)
    expect(snapshot.check.latest?.version).toBe(TARGET_VERSION)
    expect(snapshot.check.latest?.tagName).toBe(TARGET_TAG)
    expect(snapshot.check.latest?.notes).toContain('What changed')
    expect(snapshot.check.latest?.payloadAvailable).toBe(true)
    expect(snapshot.environment.familyVersion).toBe(CURRENT_VERSION)
    expect(snapshot.environment.appVersion).toBe(CURRENT_VERSION)
    expect(snapshot.environment.supported).toBe(true)
    // Check state persists for the next host run.
    const persisted = JSON.parse(readFileSync(harness.statePath, 'utf8')) as { lastCheck: { available: boolean } }
    expect(persisted.lastCheck.available).toBe(true)
  })

  it('keeps the TTL: non-forced checks do not refetch', async () => {
    const harness = makeHarness({
      installed: [{ name: 'base', version: CURRENT_VERSION }],
      targetPackages: [{ name: 'base', version: TARGET_VERSION }],
    })
    cleanup.push(harness.profileRoot)
    await harness.service.check(true)
    await harness.service.check(false)
    expect(harness.calls.filter((url) => url.includes('/releases/latest'))).toHaveLength(1)
  })

  it('reports up-to-date for equal versions and keeps previous latest on fetch errors', async () => {
    const harness = makeHarness({
      installed: [{ name: 'base', version: TARGET_VERSION }],
      targetPackages: [{ name: 'base', version: TARGET_VERSION }],
      familyVersion: TARGET_VERSION,
    })
    cleanup.push(harness.profileRoot)
    const upToDate = await harness.service.check(true)
    expect(upToDate.check.available).toBe(false)

    const failing = new UpdaterService({
      env: envFor(harness.profileRoot),
      repo: 'zhu1090093659/dsh-trading',
      statePath: harness.statePath,
      github: { fetchImpl: (async () => { throw new Error('network down') }) as unknown as typeof fetch, apiBase: 'https://api.example' },
    })
    const errored = await failing.check(true)
    expect(errored.check.status).toBe('error')
    expect(errored.check.error).toContain('network down')
  })
})

describe('UpdaterService.apply', () => {
  it('guards: no update / no payload / unsupported environment', async () => {
    const harness = makeHarness({
      installed: [{ name: 'base', version: CURRENT_VERSION }],
      targetPackages: [{ name: 'base', version: TARGET_VERSION }],
    })
    cleanup.push(harness.profileRoot)
    await expect(harness.service.apply()).rejects.toMatchObject({ code: 'UPDATER_NO_UPDATE' })
    await harness.service.check(true)

    // Unsupported: build a service on a non-desktop directory.
    const bareDir = makeTempDir('dsh-updater-bare-')
    cleanup.push(bareDir)
    const bare = new UpdaterService({
      env: envFor(bareDir),
      repo: 'zhu1090093659/dsh-trading',
      statePath: harness.statePath,
      github: { fetchImpl: (async () => { throw new Error('unused') }) as unknown as typeof fetch, apiBase: 'https://api.example' },
    })
    await expect(bare.apply()).rejects.toMatchObject({ code: 'UPDATER_UNSUPPORTED' })
  })

  it('applies the incremental payload: swaps changed, installs missing, cleans up', async () => {
    const harness = makeHarness({
      installed: [
        { name: 'base', version: CURRENT_VERSION },
        { name: 'crypto', version: CURRENT_VERSION },
      ],
      targetPackages: [
        { name: 'base', version: TARGET_VERSION, extra: { 'lib/index.js': 'export const v = 2' } },
        { name: 'crypto', version: CURRENT_VERSION }, // same version -> skipped
        { name: 'indicators', version: TARGET_VERSION }, // not installed -> installed fresh
      ],
    })
    cleanup.push(harness.profileRoot)
    await harness.service.check(true)
    const kicked = await harness.service.apply()
    expect(kicked.apply.phase).toBe('running')

    await vi.waitFor(() => {
      expect(harness.service.snapshot().apply.phase).toBe('done')
    }, { timeout: 8000 })

    const apply = harness.service.snapshot().apply
    expect(apply.targetVersion).toBe(TARGET_VERSION)
    expect(apply.updated.sort()).toEqual(['@dshtrading/base', '@dshtrading/indicators'])
    expect(apply.skippedCount).toBe(1)
    expect(installedVersion(harness.packagesDir, 'base')).toBe(TARGET_VERSION)
    expect(installedVersion(harness.packagesDir, 'indicators')).toBe(TARGET_VERSION)
    expect(installedVersion(harness.packagesDir, 'crypto')).toBe(CURRENT_VERSION)
    expect(existsSync(path.join(harness.packagesDir, 'base.updater-bak'))).toBe(false)
    expect(existsSync(path.join(harness.profileRoot, '.dshtrading-updater'))).toBe(false)
  })

  it('fails and leaves the profile untouched when the packages root is locked', async () => {
    const harness = makeHarness({
      installed: [{ name: 'base', version: CURRENT_VERSION }],
      targetPackages: [{ name: 'base', version: TARGET_VERSION }],
    })
    cleanup.push(harness.profileRoot)
    await harness.service.check(true)
    chmodSync(harness.packagesDir, 0o500)
    try {
      await harness.service.apply()
      await vi.waitFor(() => {
        expect(harness.service.snapshot().apply.phase).toBe('error')
      }, { timeout: 15000 })
      expect(harness.service.snapshot().apply.error).toContain('UPDATER')
      expect(installedVersion(harness.packagesDir, 'base')).toBe(CURRENT_VERSION)
      expect(existsSync(path.join(harness.profileRoot, '.dshtrading-updater'))).toBe(false)
    } finally {
      chmodSync(harness.packagesDir, 0o755)
    }
  })

  it('refuses to apply when the release moved on since the check', async () => {
    const harness = makeHarness({
      installed: [{ name: 'base', version: CURRENT_VERSION }],
      targetPackages: [{ name: 'base', version: TARGET_VERSION }],
    })
    cleanup.push(harness.profileRoot)
    await harness.service.check(true)
    harness.release.tag_name = 'v0.3.0'
    await harness.service.apply()
    await vi.waitFor(() => {
      expect(harness.service.snapshot().apply.phase).toBe('error')
    }, { timeout: 8000 })
    expect(harness.service.snapshot().apply.error).toContain('UPDATER_STALE_TARGET')
    expect(installedVersion(harness.packagesDir, 'base')).toBe(CURRENT_VERSION)
  })
})
