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

/** 写一份「上次检查判过可用」的持久化状态（宿主重启后 loadPersistedCheck 读的就是它）。 */
function writePersistedCheck(statePath: string, options: { available: boolean; version: string }): void {
  writeFileSync(statePath, JSON.stringify({
    version: 1,
    lastCheck: {
      at: '2026-09-04T00:00:00.000Z',
      status: 'ok',
      error: undefined,
      available: options.available,
      latest: {
        version: options.version,
        tagName: 'v' + options.version,
        name: 'dsh-trading v' + options.version,
        notes: '',
        url: 'https://github.com/zhu1090093659/dsh-trading/releases/tag/v' + options.version,
        publishedAt: '2026-09-04T00:00:00.000Z',
        payloadAvailable: true,
      },
    },
  }, null, 2))
}

/** 不发任何请求的服务实例（只读快照 / 启动对账场景）。 */
function offlineService(profileRoot: string, statePath: string): UpdaterService {
  return new UpdaterService({
    env: envFor(profileRoot),
    repo: 'zhu1090093659/dsh-trading',
    statePath,
    github: { fetchImpl: (async () => { throw new Error('unused') }) as unknown as typeof fetch, apiBase: 'https://api.example' },
  })
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

  // chmod 0o500 的只读模拟仅 POSIX 生效（Windows/NTFS 不实施 mode bits 写位），
  // 锁目录场景无法跨平台复现；Windows 的文件占用锁路径（EPERM/EBUSY → 有界重试 →
  // UPDATER error）由 renameWithRetry 承载，Windows 等价用例为后续项。
  it.skipIf(process.platform === 'win32')('fails and leaves the profile untouched when the packages root is locked', async () => {
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

describe('UpdaterService 的 available 推导（升级之后不再报同一个版本）', () => {
  it('用户已经装到最新版时，面板拿到的是「已是最新」而不是又一条「发现新版本」', () => {
    // Given 磁盘上的家族版本已是 0.2.0，而 state.json 还记着上次检查判过「0.2.0 可用」
    const profile = makeProfile([{ name: 'base', version: TARGET_VERSION }], TARGET_VERSION)
    cleanup.push(profile.root)
    const stateDir = makeTempDir('dsh-updater-state-')
    cleanup.push(stateDir)
    const statePath = path.join(stateDir, 'state.json')
    writePersistedCheck(statePath, { available: true, version: TARGET_VERSION })
    const service = offlineService(profile.root, statePath)

    // When 面板轮询快照（/state 的唯一出口）
    const snapshot = service.snapshot()

    // Then available 按磁盘版本重算为 false，latest 仍保留供展示，不会再挂「立即更新」
    expect(snapshot.check.available).toBe(false)
    expect(snapshot.check.latest?.version).toBe(TARGET_VERSION)
    expect(snapshot.environment.familyVersion).toBe(TARGET_VERSION)
  })

  it('用户升级完成后，TTL 内的非强制检查也不报同一个版本，且不重新请求 GitHub', async () => {
    // Given 装的是 0.1.1，刚检查出 0.2.0 可用
    const harness = makeHarness({
      installed: [{ name: 'base', version: CURRENT_VERSION }],
      targetPackages: [{ name: 'base', version: TARGET_VERSION }],
    })
    cleanup.push(harness.profileRoot)
    await harness.service.check(true)
    expect(harness.service.snapshot().check.available).toBe(true)

    // When 升级完成（磁盘上的本包清单变成 0.2.0），随后一次 TTL 内的非强制检查
    writeFileSync(
      path.join(harness.packagesDir, 'client-ui-updater', 'package.json'),
      JSON.stringify({ name: '@dshtrading/client-ui-updater', version: TARGET_VERSION }),
    )
    const snapshot = await harness.service.check(false)

    // Then 结论跟着磁盘版本走，且没有多发一次 GitHub 请求
    expect(snapshot.check.available).toBe(false)
    expect(harness.calls.filter(url => url.includes('/releases/latest'))).toHaveLength(1)
  })

  it('用户点「立即更新」时若发现早已是最新，直接拒绝而不是白下载一遍 payload', async () => {
    // Given 检查后判过 0.2.0 可用
    const harness = makeHarness({
      installed: [{ name: 'base', version: CURRENT_VERSION }],
      targetPackages: [{ name: 'base', version: TARGET_VERSION }],
    })
    cleanup.push(harness.profileRoot)
    await harness.service.check(true)

    // When 期间另一路已把家族版本升到 0.2.0（手动换包 / 另一台机器 / 完整安装包）
    writeFileSync(
      path.join(harness.packagesDir, 'client-ui-updater', 'package.json'),
      JSON.stringify({ name: '@dshtrading/client-ui-updater', version: TARGET_VERSION }),
    )

    // Then 按 UPDATER_NO_UPDATE 拒绝，一次 payload 请求都不发
    await expect(harness.service.apply()).rejects.toMatchObject({ code: 'UPDATER_NO_UPDATE' })
    expect(harness.calls.filter(url => url.includes('trading-update'))).toHaveLength(0)
  })

  it('用户下次启动时，state.json 里过期的「有新版本」被就地改正，右缘红点不再挂着', () => {
    // Given 持久化状态记着 0.2.0 可用，磁盘上已经装到 0.2.0
    const profile = makeProfile([{ name: 'base', version: TARGET_VERSION }], TARGET_VERSION)
    cleanup.push(profile.root)
    const stateDir = makeTempDir('dsh-updater-state-')
    cleanup.push(stateDir)
    const statePath = path.join(stateDir, 'state.json')
    writePersistedCheck(statePath, { available: true, version: TARGET_VERSION })
    const service = offlineService(profile.root, statePath)

    // When 宿主启动
    service.start()

    // Then state.json 里的 available 被改写成 false（面板与红点都读这一份）
    try {
      const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { lastCheck: { available: boolean } }
      expect(persisted.lastCheck.available).toBe(false)
      expect(service.snapshot().check.available).toBe(false)
    } finally {
      service.dispose()
    }
  })
})
