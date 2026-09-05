/**
 * Updater state machine: check → apply → done, plus the wire snapshot the
 * /dshtrading/api/updater routes and the settings page both consume.
 *
 * 增量更新设计（Agent Note: 2026-09-04-auto-update-plugin）：
 * - 检测：GitHub /releases/latest（自动排除 draft/prerelease），tag vX.Y.Z 与
 *   @dshtrading/* 家族版本（changesets fixed 组，本包自身版本即家族版本）比较。
 * - 增量通道：发布资产两件——trust anchor 清单 updates-manifest-v<tag>.json
 *   （记录 payload zip 的 sha256/bytes）+ payload zip（packages/@dshtrading/<pkg>/
 *   展开目录，非 tarball——宿主侧零 tar 解析，只走 fflate unzip）。
 * - 应用：下载 zip → sha256 校验 → 解压进 profile 内 staging → 逐包版本比对 →
 *   backup rename → swap → 版本回读验证；Windows 文件占用按 EPERM/EBUSY 重试；
 *   任一包失败整体回滚（备份移回）。新代码在宿主重启后生效（桌面壳重启宿主）。
 * - 边界：只覆盖 @dshtrading/* 插件家族（profile 内 node_modules）；Electron/Node/
 *   dsh 宿主闭包属于完整安装包通道，reseed 语义天然覆盖（新版本安装包 stamp 变更
 *   → 下次启动 reseed 回捆绑 payload）。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'
import type { UpdaterEnvironment } from './environment.ts'
import {
  fetchLatestRelease,
  manifestAssetName,
  parseUpdateManifest,
  payloadAssetName,
  type FetchReleaseOptions,
  type ReleaseInfo,
  type UpdateManifest,
} from './github.ts'
import { isNewerVersion } from './semver.ts'

/** Business error with a stable code (routes map it onto HTTP payloads). */
export class UpdaterError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Apply pipeline phase. */
export type UpdaterApplyPhase = 'idle' | 'running' | 'done' | 'error'

/** Fine-grained step inside a running apply. */
export type UpdaterApplyStep = 'prepare' | 'download' | 'verify' | 'install'

/** Latest-release view persisted into state and rendered by the UI. */
export interface UpdaterLatest {
  version: string
  tagName: string
  name: string
  notes: string
  url: string
  publishedAt: string | undefined
  /** Both manifest + payload assets present for this release (incremental lane). */
  payloadAvailable: boolean
}

/** Check result state (status ok keeps latest; error keeps the last good latest). */
export interface UpdaterCheckState {
  at: string | undefined
  status: 'idle' | 'ok' | 'error'
  error: string | undefined
  available: boolean
  latest: UpdaterLatest | undefined
}

/** Apply pipeline state. */
export interface UpdaterApplyState {
  phase: UpdaterApplyPhase
  step: UpdaterApplyStep | undefined
  startedAt: string | undefined
  finishedAt: string | undefined
  targetVersion: string | undefined
  updated: string[]
  skippedCount: number
  error: string | undefined
}

/** Live download/verify progress (undefined when idle or indeterminate). */
export interface UpdaterProgress {
  step: UpdaterApplyStep
  bytes: number | undefined
  total: number | undefined
  percent: number | undefined
}

/** Full wire snapshot (JSON for GET /state). */
export interface UpdaterSnapshot {
  environment: {
    familyVersion: string
    appVersion: string | undefined
    profileRoot: string | undefined
    supported: boolean
  }
  check: UpdaterCheckState
  apply: UpdaterApplyState
  progress: UpdaterProgress | undefined
}

/** Persisted mirror (state.json) — apply runtime state never survives restarts. */
interface PersistedState {
  version: 1
  lastCheck: UpdaterCheckState
}

export interface UpdaterServiceOptions {
  env: UpdaterEnvironment
  /** GitHub repo slug, e.g. "zhu1090093659/dsh-trading". */
  repo: string
  /** Absolute path of the persisted state file. */
  statePath: string
  /** Release channel options forwarded to fetchLatestRelease. */
  github?: Pick<FetchReleaseOptions, 'apiBase' | 'fetchImpl' | 'timeoutMs'>
  /** Injectable clock (tests). */
  now?: () => number
  /** Periodic auto-check cadence (default 6h). */
  autoCheckMs?: number
  /** Delay before the first auto check after start (default 15s). */
  initialDelayMs?: number
  /** Freshness window for non-forced checks (default 30min). */
  checkTtlMs?: number
  logger?: (line: string) => void
}

const AUTO_CHECK_MS_DEFAULT = 6 * 60 * 60 * 1000
const INITIAL_DELAY_MS_DEFAULT = 15_000
const CHECK_TTL_MS_DEFAULT = 30 * 60 * 1000
/** Windows rename retries for files/dirs briefly held open (AV scans etc.). */
const SWAP_RETRY_ATTEMPTS = 4
const SWAP_RETRY_DELAY_MS = 300

const applyIdle = (): UpdaterApplyState => ({
  phase: 'idle',
  step: undefined,
  startedAt: undefined,
  finishedAt: undefined,
  targetVersion: undefined,
  updated: [],
  skippedCount: 0,
  error: undefined,
})

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms) })
}

/** rename with bounded retries (Windows briefly holds loaded plugin files). */
async function renameWithRetry(from: string, to: string, log: (line: string) => void): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= SWAP_RETRY_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EACCES'
      if (!transient || attempt === SWAP_RETRY_ATTEMPTS) break
      log(`rename ${path.basename(from)} -> ${path.basename(to)} retry ${attempt}/${SWAP_RETRY_ATTEMPTS - 1} (${code})`)
      await sleep(SWAP_RETRY_DELAY_MS * attempt)
    }
  }
  throw lastError
}

function rmRf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true })
}

/** Zip entry path safety: no absolute paths, no .. segments (zip-slip guard). */
function safeZipEntryName(name: string): string | undefined {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.includes('../') || normalized === '..' || normalized.includes('/..')) {
    return undefined
  }
  return normalized
}

interface StagedPackage {
  name: string
  version: string
  /** Absolute staging dir holding the extracted package content. */
  dir: string
}

export class UpdaterService {
  private readonly options: UpdaterServiceOptions
  private readonly env: UpdaterEnvironment
  private readonly now: () => number
  private readonly autoCheckMs: number
  private readonly initialDelayMs: number
  private readonly checkTtlMs: number
  private readonly log: (line: string) => void

  private checkState: UpdaterCheckState
  private applyState: UpdaterApplyState = applyIdle()
  private progress: UpdaterProgress | undefined = undefined
  private timers: Array<ReturnType<typeof setTimeout>> = []
  private checkInFlight = false
  private applyInFlight = false
  private disposed = false

  constructor(options: UpdaterServiceOptions) {
    this.options = options
    this.env = options.env
    this.now = options.now ?? (() => Date.now())
    this.autoCheckMs = options.autoCheckMs ?? AUTO_CHECK_MS_DEFAULT
    this.initialDelayMs = options.initialDelayMs ?? INITIAL_DELAY_MS_DEFAULT
    this.checkTtlMs = options.checkTtlMs ?? CHECK_TTL_MS_DEFAULT
    this.log = options.logger ?? ((line) => { console.log('[dshtrading-updater]', line) })
    this.checkState = this.loadPersistedCheck()
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Load persisted check state + schedule auto checks. Idempotent. */
  start(): void {
    if (this.disposed || this.timers.length > 0) return
    if (this.env.supported) {
      const initialTimer = setTimeout(() => { void this.check(false).catch(() => undefined) }, this.initialDelayMs)
      const intervalTimer = setInterval(() => { void this.check(false).catch(() => undefined) }, this.autoCheckMs)
      initialTimer.unref?.()
      intervalTimer.unref?.()
      this.timers.push(initialTimer, intervalTimer)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.splice(0)) {
      clearTimeout(timer)
      clearInterval(timer)
    }
  }

  // ── check ───────────────────────────────────────────────────────────────

  /**
   * Check GitHub for a newer stable release. Non-forced calls honor the TTL
   * and double as the periodic tick; force=true bypasses the cache (UI button).
   */
  async check(force: boolean): Promise<UpdaterSnapshot> {
    if (!force && this.checkFresh()) return this.snapshot()
    if (this.checkInFlight) return this.snapshot()
    this.checkInFlight = true
    try {
      const release = await fetchLatestRelease({
        repo: this.options.repo,
        ...(this.options.github?.apiBase === undefined ? {} : { apiBase: this.options.github.apiBase }),
        ...(this.options.github?.fetchImpl === undefined ? {} : { fetchImpl: this.options.github.fetchImpl }),
        ...(this.options.github?.timeoutMs === undefined ? {} : { timeoutMs: this.options.github.timeoutMs }),
      })
      const latest = release === undefined ? undefined : this.latestOf(release)
      const available = latest?.version !== undefined && isNewerVersion(latest.version, this.env.familyVersion)
      this.checkState = {
        at: new Date(this.now()).toISOString(),
        status: 'ok',
        error: undefined,
        available,
        latest,
      }
      this.persistCheck()
    } catch (error) {
      // Transient failure: keep the last good latest visible (badge stability),
      // surface the error alongside.
      this.checkState = {
        at: new Date(this.now()).toISOString(),
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        available: this.checkState.available,
        latest: this.checkState.latest,
      }
      this.persistCheck()
      this.log('check failed: ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      this.checkInFlight = false
    }
    return this.snapshot()
  }

  private checkFresh(): boolean {
    if (this.checkState.status !== 'ok' || this.checkState.at === undefined) return false
    const at = Date.parse(this.checkState.at)
    if (!Number.isFinite(at)) return false
    return this.now() - at < this.checkTtlMs
  }

  private latestOf(release: ReleaseInfo): UpdaterLatest {
    const hasManifest = release.assets.some((asset) => asset.name === manifestAssetName(release.tagName))
    const hasPayload = release.assets.some((asset) => asset.name === payloadAssetName(release.tagName))
    return {
      version: release.version ?? '',
      tagName: release.tagName,
      name: release.name,
      notes: release.notes,
      url: release.url,
      publishedAt: release.publishedAt,
      payloadAvailable: hasManifest && hasPayload,
    }
  }

  // ── apply ───────────────────────────────────────────────────────────────

  /**
   * Kick off the incremental apply pipeline. Returns immediately with the
   * running snapshot; the UI polls state. Single-flight: a second call while
   * running throws UPDATER_BUSY.
   */
  async apply(): Promise<UpdaterSnapshot> {
    if (this.applyInFlight || this.applyState.phase === 'running') {
      throw new UpdaterError('UPDATER_BUSY', 'an update is already in progress')
    }
    if (!this.env.supported || this.env.profileRoot === undefined || this.env.packagesRoot === undefined) {
      throw new UpdaterError('UPDATER_UNSUPPORTED', 'incremental update requires a desktop-seeded profile')
    }
    if (this.checkState.status !== 'ok' || this.checkState.available !== true || this.checkState.latest === undefined) {
      throw new UpdaterError('UPDATER_NO_UPDATE', 'no newer release is available')
    }
    if (this.checkState.latest.payloadAvailable !== true) {
      throw new UpdaterError('UPDATER_PAYLOAD_UNAVAILABLE', 'this release does not carry the incremental payload')
    }
    this.applyInFlight = true
    const target = this.checkState.latest
    this.applyState = {
      phase: 'running',
      step: 'prepare',
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: undefined,
      targetVersion: target.version,
      updated: [],
      skippedCount: 0,
      error: undefined,
    }
    this.progress = undefined
    // Fire-and-forget: the route answers immediately, the UI polls state.
    void this.runApply(target)
      .catch((error) => {
        const message = error instanceof UpdaterError
          ? `${error.code}: ${error.message}`
          : (error instanceof Error ? error.message : String(error))
        this.log('apply failed: ' + message)
        this.applyState = { ...this.applyState, phase: 'error', step: undefined, finishedAt: new Date(this.now()).toISOString(), error: message }
      })
      .finally(() => {
        this.applyInFlight = false
        this.progress = undefined
      })
    return this.snapshot()
  }

  /** The full pipeline; only called via apply() (single-flight owner). */
  private async runApply(target: UpdaterLatest): Promise<void> {
    const profileRoot = this.env.profileRoot
    const packagesRoot = this.env.packagesRoot
    if (profileRoot === undefined || packagesRoot === undefined) {
      throw new UpdaterError('UPDATER_UNSUPPORTED', 'incremental update requires a desktop-seeded profile')
    }

    // 1. Fresh release lookup: assets are never persisted, and this doubles as
    //    a "still the latest" guard before bytes move.
    this.applyState = { ...this.applyState, step: 'prepare' }
    const release = await fetchLatestRelease({
      repo: this.options.repo,
      ...(this.options.github?.apiBase === undefined ? {} : { apiBase: this.options.github.apiBase }),
      ...(this.options.github?.fetchImpl === undefined ? {} : { fetchImpl: this.options.github.fetchImpl }),
      ...(this.options.github?.timeoutMs === undefined ? {} : { timeoutMs: this.options.github.timeoutMs }),
    })
    if (release === undefined || release.tagName !== target.tagName) {
      throw new UpdaterError('UPDATER_STALE_TARGET', 'the target release changed; check again')
    }

    // 2. Manifest (trust anchor) → payload zip.
    const manifestAsset = release.assets.find((asset) => asset.name === manifestAssetName(release.tagName))
    if (manifestAsset === undefined) throw new UpdaterError('UPDATER_PAYLOAD_UNAVAILABLE', 'update manifest asset missing')
    const fetchImpl = this.options.github?.fetchImpl ?? fetch
    const manifest = parseUpdateManifest(await this.downloadText(fetchImpl, manifestAsset.url))
    if (manifest.version !== target.version || manifest.tag !== target.tagName) {
      throw new UpdaterError('UPDATER_MANIFEST_MISMATCH', 'manifest does not match the target release')
    }
    const payloadAsset = release.assets.find((asset) => asset.name === manifest.payload.file)
    if (payloadAsset === undefined) throw new UpdaterError('UPDATER_PAYLOAD_UNAVAILABLE', 'payload zip asset missing')

    // 3. Download with progress + integrity verification.
    this.applyState = { ...this.applyState, step: 'download' }
    const zipBytes = await this.downloadPayload(fetchImpl, payloadAsset, manifest)
    this.log(`payload downloaded: ${zipBytes.length} bytes, sha256 ok`)

    // 4. Unzip + structural validation (zip-slip guard, package/version cross-check).
    this.applyState = { ...this.applyState, step: 'verify' }
    this.progress = { step: 'verify', bytes: undefined, total: undefined, percent: undefined }
    const staged = this.stagePackages(zipBytes, manifest, profileRoot)

    // 5. Swap packages whose installed version differs.
    this.applyState = { ...this.applyState, step: 'install' }
    const updated: string[] = []
    let skippedCount = 0
    const swapped: Array<{ backup: string; target: string }> = []
    try {
      for (const pkg of staged) {
        // packagesRoot already ends with the @dshtrading scope: join the bare
        // package name only ("@dshtrading/base" -> node_modules/@dshtrading/base).
        const bareName = pkg.name.startsWith('@dshtrading/') ? pkg.name.slice('@dshtrading/'.length) : pkg.name
        const targetDir = path.join(packagesRoot, bareName)
        const installedVersion = this.installedVersionOf(targetDir)
        if (installedVersion === pkg.version) {
          skippedCount += 1
          continue
        }
        const backupDir = targetDir + '.updater-bak'
        rmRf(backupDir)
        if (fs.existsSync(targetDir)) {
          await renameWithRetry(targetDir, backupDir, this.log)
        }
        try {
          await renameWithRetry(pkg.dir, targetDir, this.log)
        } catch (error) {
          // Swap-in failed: put the backup back before giving up.
          if (fs.existsSync(backupDir) && !fs.existsSync(targetDir)) {
            await renameWithRetry(backupDir, targetDir, this.log).catch(() => undefined)
          }
          throw error
        }
        swapped.push({ backup: backupDir, target: targetDir })
        const appliedVersion = this.installedVersionOf(targetDir)
        if (appliedVersion !== pkg.version) {
          throw new UpdaterError('UPDATER_VERIFY_FAILED', `post-swap version mismatch for ${pkg.name}`)
        }
        updated.push(pkg.name)
        this.log(`updated ${pkg.name}: ${installedVersion} -> ${pkg.version}`)
      }
    } catch (error) {
      // Roll back every completed swap (backups are still on disk).
      for (const swap of swapped.reverse()) {
        rmRf(swap.target)
        await renameWithRetry(swap.backup, swap.target, this.log).catch(() => undefined)
      }
      if (error instanceof UpdaterError) throw error
      throw new UpdaterError('UPDATER_INSTALL_FAILED', error instanceof Error ? error.message : String(error))
    } finally {
      // Staging leftovers (skipped packages, failed run) are always garbage.
      rmRf(path.join(profileRoot, '.dshtrading-updater'))
    }

    // 6. Clean up backups of the successful swaps, finalize.
    for (const swap of swapped) rmRf(swap.backup)
    this.applyState = {
      phase: 'done',
      step: undefined,
      startedAt: this.applyState.startedAt,
      finishedAt: new Date(this.now()).toISOString(),
      targetVersion: target.version,
      updated,
      skippedCount,
      error: undefined,
    }
    this.log(`update applied: ${updated.length} package(s) -> ${target.version} (restart to activate)`)
  }

  private installedVersionOf(packageDir: string): string {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { version?: unknown }
      return typeof manifest.version === 'string' ? manifest.version : 'unknown'
    } catch {
      return 'missing'
    }
  }

  /** Unzip into a staging dir under the profile and cross-check the manifest. */
  private stagePackages(zipBytes: Uint8Array, manifest: UpdateManifest, profileRoot: string): StagedPackage[] {
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(zipBytes)
    } catch (error) {
      throw new UpdaterError('UPDATER_PAYLOAD_CORRUPT', 'payload zip unreadable: ' + (error instanceof Error ? error.message : String(error)))
    }
    const byPackage = new Map<string, Map<string, Uint8Array>>()
    for (const [rawName, data] of Object.entries(entries)) {
      if (rawName.endsWith('/')) continue
      const name = safeZipEntryName(rawName)
      if (name === undefined) throw new UpdaterError('UPDATER_PAYLOAD_CORRUPT', `unsafe zip entry: ${rawName}`)
      const segments = name.split('/')
      // Expected layout: packages/@dshtrading/<name>/...
      if (segments[0] !== 'packages' || segments[1] !== '@dshtrading' || segments.length < 4) {
        throw new UpdaterError('UPDATER_PAYLOAD_CORRUPT', `unexpected zip entry: ${name}`)
      }
      const pkgName = `@dshtrading/${segments[2]}`
      const relativePath = segments.slice(3).join('/')
      let files = byPackage.get(pkgName)
      if (files === undefined) {
        files = new Map()
        byPackage.set(pkgName, files)
      }
      files.set(relativePath, data)
    }
    for (const entry of manifest.packages) {
      if (!byPackage.has(entry.name)) {
        throw new UpdaterError('UPDATER_PAYLOAD_CORRUPT', `manifest package missing from payload: ${entry.name}`)
      }
    }
    const stagingRoot = path.join(profileRoot, '.dshtrading-updater', `staging-${process.pid}-${this.now()}`)
    const staged: StagedPackage[] = []
    for (const [pkgName, files] of byPackage) {
      const manifestEntry = manifest.packages.find((item) => item.name === pkgName)
      if (manifestEntry === undefined) {
        throw new UpdaterError('UPDATER_PAYLOAD_CORRUPT', `payload package missing from manifest: ${pkgName}`)
      }
      const packageJson = files.get('package.json')
      if (packageJson === undefined) {
        throw new UpdaterError('UPDATER_PAYLOAD_CORRUPT', `payload package has no package.json: ${pkgName}`)
      }
      let declaredVersion: string
      try {
        declaredVersion = (JSON.parse(new TextDecoder().decode(packageJson)) as { version?: unknown }).version as string
      } catch {
        throw new UpdaterError('UPDATER_PAYLOAD_CORRUPT', `payload package.json unreadable: ${pkgName}`)
      }
      if (declaredVersion !== manifestEntry.version) {
        throw new UpdaterError('UPDATER_PAYLOAD_CORRUPT', `payload version mismatch for ${pkgName}`)
      }
      const dir = path.join(stagingRoot, ...pkgName.split('/'))
      for (const [relativePath, data] of files) {
        const file = path.join(dir, ...relativePath.split('/'))
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, data)
      }
      staged.push({ name: pkgName, version: manifestEntry.version, dir })
    }
    // Deterministic apply order (stable rollback bookkeeping).
    staged.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return staged
  }

  /** Stream the payload zip with progress; verify sha256 + byte length. */
  private async downloadPayload(
    fetchImpl: typeof fetch,
    asset: { name: string; url: string; size: number },
    manifest: UpdateManifest,
  ): Promise<Uint8Array> {
    this.progress = { step: 'download', bytes: 0, total: asset.size > 0 ? asset.size : undefined, percent: 0 }
    const chunks = await this.downloadChunks(fetchImpl, asset.url, (bytes, total) => {
      const knownTotal = total ?? (asset.size > 0 ? asset.size : undefined)
      this.progress = {
        step: 'download',
        bytes,
        total: knownTotal,
        percent: knownTotal !== undefined && knownTotal > 0 ? Math.min(99, Math.round((bytes / knownTotal) * 100)) : undefined,
      }
    })
    const payload = Buffer.concat(chunks)
    if (manifest.payload.bytes > 0 && payload.length !== manifest.payload.bytes) {
      throw new UpdaterError('UPDATER_SIZE_MISMATCH', `payload size ${payload.length} != manifest ${manifest.payload.bytes}`)
    }
    const digest = sha256Hex(payload)
    if (digest !== manifest.payload.sha256.toLowerCase()) {
      throw new UpdaterError('UPDATER_HASH_MISMATCH', 'payload sha256 mismatch')
    }
    return payload
  }

  private async downloadText(fetchImpl: typeof fetch, url: string): Promise<string> {
    const response = await fetchImpl(url, { headers: { accept: 'application/octet-stream', 'user-agent': 'dsh-trading-updater' } })
    if (!response.ok) throw new UpdaterError('UPDATER_DOWNLOAD_FAILED', `${url} -> ${response.status}`)
    return response.text()
  }

  private async downloadChunks(
    fetchImpl: typeof fetch,
    url: string,
    onProgress: (bytes: number, total: number | undefined) => void,
  ): Promise<Buffer[]> {
    const response = await fetchImpl(url, { headers: { accept: 'application/octet-stream', 'user-agent': 'dsh-trading-updater' } })
    if (!response.ok || response.body === null) {
      throw new UpdaterError('UPDATER_DOWNLOAD_FAILED', `${url} -> ${response.status}`)
    }
    const headerTotal = Number(response.headers.get('content-length') ?? '')
    const total = Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : undefined
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) {
        chunks.push(Buffer.from(value))
        received += value.byteLength
        onProgress(received, total)
      }
    }
    return chunks
  }

  // ── state I/O ───────────────────────────────────────────────────────────

  snapshot(): UpdaterSnapshot {
    return {
      environment: {
        familyVersion: this.env.familyVersion,
        appVersion: this.env.desktopMarker?.appVersion,
        profileRoot: this.env.profileRoot,
        supported: this.env.supported,
      },
      check: this.checkState,
      apply: this.applyState,
      progress: this.applyState.phase === 'running' ? this.progress : undefined,
    }
  }

  private stateFile(): { dir: string; file: string } {
    const file = this.options.statePath
    return { dir: path.dirname(file), file }
  }

  private loadPersistedCheck(): UpdaterCheckState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile().file, 'utf8')) as { lastCheck?: UpdaterCheckState }
      const lastCheck = raw.lastCheck
      if (lastCheck !== undefined && typeof lastCheck === 'object' && 'status' in lastCheck) {
        return {
          at: lastCheck.at,
          status: lastCheck.status,
          error: lastCheck.error,
          available: lastCheck.available === true,
          latest: lastCheck.latest,
        }
      }
    } catch {
      // First run or unreadable state — idle.
    }
    return { at: undefined, status: 'idle', error: undefined, available: false, latest: undefined }
  }

  private persistCheck(): void {
    const { dir, file } = this.stateFile()
    try {
      fs.mkdirSync(dir, { recursive: true })
      const state: PersistedState = { version: 1, lastCheck: this.checkState }
      // Atomic-ish write: temp file + rename (partial writes never win).
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
      fs.renameSync(tmp, file)
    } catch (error) {
      this.log('state persist failed: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
}
