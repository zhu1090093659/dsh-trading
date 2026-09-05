/**
 * Minimal semver handling for GitHub release tags (vX.Y.Z) against the
 * @dshtrading/* family version (X.Y.Z). Deliberately dependency-free: the
 * family is version-locked by the changesets fixed group, so a plain numeric
 * triple comparison covers every shape the release pipeline can publish.
 * Prerelease-suffixed tags never reach here (GitHub /releases/latest excludes
 * prereleases) and unparseable tags compare as "not newer" (fail-closed).
 */

/** Parsed numeric version triple. */
export interface SemVer {
  major: number
  minor: number
  patch: number
}

/**
 * Parse "v1.2.3" / "1.2.3" (optional leading v, optional trailing junk like
 * build metadata is rejected — the release pipeline only ever tags vX.Y.Z).
 */
export function parseVersion(text: string): SemVer | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return undefined
  return { major, minor, patch }
}

/** -1 / 0 / 1 numeric triple comparison. */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return 0
}

/** True when candidate parses AND is strictly newer than current. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const candidateVersion = parseVersion(candidate)
  const currentVersion = parseVersion(current)
  if (candidateVersion === undefined || currentVersion === undefined) return false
  return compareVersions(candidateVersion, currentVersion) > 0
}
