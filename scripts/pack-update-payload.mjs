#!/usr/bin/env node
/**
 * Pack the incremental update payload attached to desktop releases.
 *
 * Input: the vendor tarballs pnpm packed during prepare-runtime
 * (desktop/runtime/profile-trading/vendor/*.tgz) — the exact bytes the
 * release pipeline ships inside the installers, so the payload can never
 * drift from the tagged family version.
 *
 * Output (into desktop/dist/, picked up by the desktop-release upload step):
 *   trading-update-<tag>.zip        packages/@dshtrading/<name>/... (extracted
 *                                   package content, NOT tarballs — the
 *                                   updater unzips with fflate and never
 *                                   parses tar on the host)
 *   updates-manifest-<tag>.json     trust anchor: payload sha256/bytes +
 *                                   per-package versions
 *
 * Usage (desktop-release workflow): UPDATE_TAG=v0.2.0 node scripts/pack-update-payload.mjs
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VENDOR_DIR = path.join(ROOT, 'desktop', 'runtime', 'profile-trading', 'vendor')
const DIST_DIR = path.join(ROOT, 'desktop', 'dist')
const SCOPE = '@dshtrading'
// fflate resolves inside the updater package (its runtime dependency), not at
// the repo root (pnpm strict layout).
const requireFromUpdater = createRequire(path.join(ROOT, 'packages', 'client-ui-updater', 'package.json'))
const { zipSync } = requireFromUpdater('fflate')

/** Windows resolves tar through System32; args are fixed constants — shell only on win32. */
const spawnOptions = { env: { ...process.env }, shell: process.platform === 'win32' }

function fail(message) {
  console.error('[pack-update-payload] ' + message)
  process.exit(1)
}

function tarballPackageJson(tgzPath) {
  const text = execFileSync('tar', ['-xOzf', tgzPath, 'package/package.json'], {
    ...spawnOptions,
    maxBuffer: 4 * 1024 * 1024,
  })
  return JSON.parse(String(text))
}

function readDirFiles(rootDir, base = rootDir, into = {}) {
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name)
    if (entry.isDirectory()) readDirFiles(full, base, into)
    else if (entry.isFile()) {
      const key = path.relative(base, full).split(path.sep).join('/')
      into[key] = new Uint8Array(fs.readFileSync(full))
    }
  }
  return into
}

function main() {
  const tag = (process.env.UPDATE_TAG ?? '').trim()
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`UPDATE_TAG must be vX.Y.Z, got: "${tag}"`)
  const version = tag.slice(1)

  if (!fs.existsSync(VENDOR_DIR)) fail(`vendor dir missing: ${VENDOR_DIR} (run desktop prepare-runtime first)`)
  const tarballs = fs.readdirSync(VENDOR_DIR).filter((name) => name.endsWith('.tgz')).sort()
  if (tarballs.length === 0) fail('no vendor tarballs found')

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'update-payload-'))
  const zipEntries = {}
  const packages = []
  try {
    for (const file of tarballs) {
      const tgzPath = path.join(VENDOR_DIR, file)
      const manifest = tarballPackageJson(tgzPath)
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith(SCOPE + '/')) {
        fail(`unexpected package name in ${file}: ${manifest.name}`)
      }
      if (manifest.version !== version) {
        fail(`version mismatch: ${manifest.name}@${manifest.version} != release ${version} (rerun the version bump)`)
      }
      const bare = manifest.name.slice(SCOPE.length + 1)
      const dest = path.join(staging, 'packages', SCOPE, bare)
      fs.mkdirSync(dest, { recursive: true })
      execFileSync('tar', ['-xzf', tgzPath, '-C', dest, '--strip-components=1'], { ...spawnOptions, maxBuffer: 16 * 1024 * 1024 })
      packages.push({ name: manifest.name, version: manifest.version })
    }

    // Deterministic zip: walk the staged tree, '/'-separated entry names.
    Object.assign(zipEntries, readDirFiles(staging))

    fs.mkdirSync(DIST_DIR, { recursive: true })
    const payloadName = `trading-update-${tag}.zip`
    const payloadPath = path.join(DIST_DIR, payloadName)
    const zipped = zipSync(zipEntries)
    fs.writeFileSync(payloadPath, zipped)
    const sha256 = createHash('sha256').update(zipped).digest('hex')

    const manifestName = `updates-manifest-${tag}.json`
    const manifest = {
      schema: 1,
      version,
      tag,
      generatedAt: new Date().toISOString(),
      payload: { file: payloadName, sha256, bytes: zipped.length },
      packages: packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    }
    fs.writeFileSync(path.join(DIST_DIR, manifestName), JSON.stringify(manifest, null, 2) + '\n')

    console.log(`[pack-update-payload] ${manifestName}: ${packages.length} packages, payload ${payloadName} ${zipped.length} bytes (sha256 ${sha256.slice(0, 12)}…)`)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

main()
