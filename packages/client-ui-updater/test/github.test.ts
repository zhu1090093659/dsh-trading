import { describe, expect, it } from 'vitest'
import { manifestAssetName, parseUpdateManifest, payloadAssetName } from '../src/github.js'

describe('asset naming', () => {
  it('derives manifest + payload asset names from the tag', () => {
    expect(manifestAssetName('v0.2.0')).toBe('updates-manifest-v0.2.0.json')
    expect(payloadAssetName('v0.2.0')).toBe('trading-update-v0.2.0.zip')
  })
})

describe('parseUpdateManifest', () => {
  const valid = {
    schema: 1,
    version: '0.2.0',
    tag: 'v0.2.0',
    generatedAt: '2026-09-04T00:00:00.000Z',
    payload: { file: 'trading-update-v0.2.0.zip', sha256: 'a'.repeat(64), bytes: 1024 },
    packages: [{ name: '@dshtrading/base', version: '0.2.0' }],
  }

  it('accepts a well-formed manifest', () => {
    const manifest = parseUpdateManifest(JSON.stringify(valid))
    expect(manifest.version).toBe('0.2.0')
    expect(manifest.packages).toHaveLength(1)
    expect(manifest.payload.sha256).toBe('a'.repeat(64))
  })

  it('rejects unknown schema / malformed blocks', () => {
    expect(() => parseUpdateManifest(JSON.stringify({ ...valid, schema: 2 }))).toThrow()
    expect(() => parseUpdateManifest(JSON.stringify({ ...valid, payload: {} }))).toThrow()
    expect(() => parseUpdateManifest(JSON.stringify({ ...valid, packages: 'nope' }))).toThrow()
    expect(() => parseUpdateManifest(JSON.stringify({ ...valid, packages: [{ name: '@dshtrading/base' }] }))).toThrow()
    expect(() => parseUpdateManifest('not json')).toThrow()
  })
})
