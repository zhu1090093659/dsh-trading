import { describe, expect, it } from 'vitest'
import { compareVersions, isNewerVersion, parseVersion } from '../src/semver.js'

describe('parseVersion', () => {
  it('parses vX.Y.Z and X.Y.Z', () => {
    expect(parseVersion('v0.2.0')).toEqual({ major: 0, minor: 2, patch: 0 })
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
  })

  it('rejects non vX.Y.Z shapes', () => {
    expect(parseVersion('v1.2')).toBeUndefined()
    expect(parseVersion('release-1.2.3')).toBeUndefined()
    expect(parseVersion('v1.2.3-rc.1')).toBeUndefined()
    expect(parseVersion('')).toBeUndefined()
  })
})

describe('compareVersions', () => {
  it('orders numerically (major, minor, patch)', () => {
    expect(compareVersions({ major: 0, minor: 2, patch: 0 }, { major: 0, minor: 1, patch: 9 })).toBe(1)
    expect(compareVersions({ major: 0, minor: 1, patch: 10 }, { major: 0, minor: 1, patch: 9 })).toBe(1)
    expect(compareVersions({ major: 1, minor: 0, patch: 0 }, { major: 0, minor: 99, patch: 99 })).toBe(1)
    expect(compareVersions({ major: 0, minor: 1, patch: 1 }, { major: 0, minor: 1, patch: 1 })).toBe(0)
    expect(compareVersions({ major: 0, minor: 1, patch: 0 }, { major: 0, minor: 2, patch: 0 })).toBe(-1)
  })
})

describe('isNewerVersion', () => {
  it('true only for strictly newer parseable pairs', () => {
    expect(isNewerVersion('v0.2.0', '0.1.1')).toBe(true)
    expect(isNewerVersion('0.1.1', 'v0.1.1')).toBe(false)
    expect(isNewerVersion('v0.1.0', '0.1.1')).toBe(false)
  })

  it('fail-closed on unparseable input', () => {
    expect(isNewerVersion('not-a-version', '0.1.1')).toBe(false)
    expect(isNewerVersion('v0.2.0', 'unknown')).toBe(false)
  })
})
