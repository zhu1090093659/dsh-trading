/**
 * Runtime environment discovery for the updater.
 *
 * The incremental lane only exists inside a desktop-seeded profile: the DSH
 * Trading desktop app seeds $DSH_HOME/profiles/trading-web from its bundled
 * payload and drops a .dsh-desktop-seed.json marker into the live profile
 * root (desktop/src/runtime.cjs). Walking up from this package's installed
 * location (node_modules/@dshtrading/client-ui-updater/lib/index.js) reaches
 * that profile root; a dev checkout never finds the marker and the updater
 * degrades to an information-only surface (release page links).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Marker file the desktop seeder writes into the live profile root. */
export const DESKTOP_SEED_MARKER = '.dsh-desktop-seed.json'

/** This package's own name (anchors the family-version lookup). */
const OWN_PACKAGE_NAME = '@dshtrading/client-ui-updater'

/** Parsed .dsh-desktop-seed.json content we care about. */
export interface DesktopSeedMarker {
  /** Bundled runtime stamp string the profile was seeded from. */
  stamp?: string
  /** Electron app version of the seeding desktop app. */
  appVersion?: string
  seededAt?: string
}

/** Everything the updater needs to know about where it runs. */
export interface UpdaterEnvironment {
  /** @dshtrading/* family version = this package's own manifest version. */
  familyVersion: string
  /** Live profile root when running inside a desktop-seeded profile. */
  profileRoot: string | undefined
  /** Seed marker content when profileRoot is desktop-owned. */
  desktopMarker: DesktopSeedMarker | undefined
  /** profileRoot/node_modules/@dshtrading — the swap target root. */
  packagesRoot: string | undefined
  /** Incremental lane available: desktop-seeded AND packages root writable. */
  supported: boolean
}

export interface DiscoverOptions {
  /** Start file for the upward walk (defaults to this module's build output). */
  fromFile?: string
}

function readOwnPackageVersion(startFile: string): string {
  let dir = path.dirname(startFile)
  for (let depth = 0; depth < 12; depth += 1) {
    const manifestPath = path.join(dir, 'package.json')
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: string; version?: string }
      if (manifest.name === OWN_PACKAGE_NAME && typeof manifest.version === 'string') return manifest.version
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'unknown'
}

function readSeedMarker(profileRoot: string): DesktopSeedMarker | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(profileRoot, DESKTOP_SEED_MARKER), 'utf8')) as DesktopSeedMarker
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function isWritable(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Walk up from startFile looking for the desktop seed marker. Stops at the
 * filesystem root; returns undefined outside a desktop profile (dev checkouts,
 * headless profiles installed by hand).
 */
function findDesktopProfileRoot(startFile: string): string | undefined {
  let dir = path.dirname(startFile)
  for (let depth = 0; depth < 16; depth += 1) {
    if (fs.existsSync(path.join(dir, DESKTOP_SEED_MARKER))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** Discover the updater environment from a module file location. */
export function discoverEnvironmentFrom(startFile: string): UpdaterEnvironment {
  const familyVersion = readOwnPackageVersion(startFile)
  const profileRoot = findDesktopProfileRoot(startFile)
  const desktopMarker = profileRoot === undefined ? undefined : readSeedMarker(profileRoot)
  const packagesRoot = profileRoot === undefined ? undefined : path.join(profileRoot, 'node_modules', '@dshtrading')
  const supported = profileRoot !== undefined
    && packagesRoot !== undefined
    && fs.existsSync(packagesRoot)
    && isWritable(packagesRoot)
  return { familyVersion, profileRoot, desktopMarker, packagesRoot, supported }
}

/** Discover from this package's own build output location. */
export function discoverEnvironment(options: DiscoverOptions = {}): UpdaterEnvironment {
  const fromFile = options.fromFile ?? fileURLToPath(import.meta.url)
  return discoverEnvironmentFrom(fromFile)
}
