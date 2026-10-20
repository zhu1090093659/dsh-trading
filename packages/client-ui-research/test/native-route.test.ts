import { createServer, type Server, type RequestListener } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, createResearchRouteHandler, MOUNT } from '../src/index.ts'

const openServers: Server[] = []
const tempDirs: string[] = []
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-research-native-'))
  tempDirs.push(dataDir)
  const handler = createResearchRouteHandler({ dataDir, reminders: false })
  const server = createServer(handler)
  openServers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable')
  const base = `http://127.0.0.1:${address.port}${MOUNT}`
  return { base, dataDir, handler }
}
afterEach(async () => {
  for (const server of openServers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const dir of tempDirs.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + '\\') && !resolve(dir).startsWith(resolve(tmpdir()) + '/')) throw new Error('unsafe fixture cleanup')
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('native research host integration', () => {
  it('user opens research without an upstream workbench service', async () => {
    // Given an isolated native plugin mounted on a real HTTP server
    const { base } = await fixture()
    // When the user requests its status and engine health
    const status = await fetch(`${base}/status`)
    const health = await fetch(`${base}/engine/health`)
    // Then the host executes the migrated engine in process
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ ok: true, mode: 'native', sections: 8 })
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true, version: '2.2.2' })
  })
  it('user can discover the migrated research data and calculation tools', async () => {
    // Given the native research workspace
    const { base } = await fixture()
    // When the real catalog and guided tool inventory are requested
    const response = await fetch(`${base}/engine/endpoints?all=1`)
    const catalog = await response.json() as Array<{ id: string }>
    // Then the complete data registry is exposed, including multiple markets
    expect(response.status).toBe(200)
    expect(catalog.length).toBeGreaterThanOrEqual(168)
    expect(catalog.some(endpoint => endpoint.id === 'tx_quote')).toBe(true)
    expect(catalog.some(endpoint => endpoint.id === 'fetch_quote')).toBe(true)
  })
  it('user reads research records from a separate data directory', async () => {
    // Given a new research data directory
    const { base, dataDir } = await fixture()
    // When the record and report catalogs are read
    const ledger = await fetch(`${base}/engine/ledger/note`)
    const reports = await fetch(`${base}/engine/reports`)
    // Then both catalogs are readable without a separate backend or token file
    expect(ledger.status).toBe(200)
    expect(await ledger.json()).toMatchObject({ note: [] })
    expect(reports.status).toBe(200)
    expect(existsSync(join(dataDir, 'api.token'))).toBe(false)
  })
  it('guest cannot bypass the trading browser authentication fence', async () => {
    // Given a host whose connection service rejects this browser
    const routes: Array<{ handler: RequestListener }> = []
    const services = new Map<string, unknown>([
      ['webServer', { register: (route: { handler: RequestListener }) => { routes.push(route); return () => {} } }],
      ['connection', { requestRejection: () => 401 }],
    ])
    const ctx = { inject: (_names: string[], cb: (scope: { get: (key: string) => unknown }) => void) => cb({ get: key => services.get(key) }), effect: (factory: () => unknown) => factory() }
    apply(ctx as never, { dataDir: join(tmpdir(), 'unused-rejected-research') })
    const server = createServer(routes[0]!.handler)
    openServers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    // When an unauthenticated browser requests an engine route
    const response = await fetch(`http://127.0.0.1:${address.port}${MOUNT}/engine/health`)
    // Then the host refuses it before running research code
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })
  it('guest cannot read files outside the built research assets', async () => {
    // Given a native plugin exposing its built browser modules
    const { base } = await fixture()
    // When an encoded path traversal attempts to read package source
    const response = await fetch(`${base}/assets/..%2f..%2fpackage.json`)
    // Then no package source is returned
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'asset_not_found' })
  })
  it('user receives explicit rejection for malformed research requests', async () => {
    // Given the native engine
    const { base } = await fixture()
    // When a mutation is sent as plain text and a query contains a bad symbol
    const post = await fetch(`${base}/engine/ledger`, { method: 'POST', body: '{}' })
    const invalid = await fetch(`${base}/engine/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'tx_quote', symbol: '../../private' }) })
    // Then the engine preserves its validation boundaries
    expect(post.status).toBe(415)
    expect(await post.json()).toEqual({ error: 'content_type_must_be_json' })
    expect(invalid.status).toBe(400)
  })
  it('user saves and reopens a complete research note in the native ledger', async () => {
    // Given a new local research ledger
    const { base, dataDir } = await fixture()
    const note = { title: 'Integration fixture', category: 'review', body: 'Evidence and open questions.' }
    // When the user saves and reads it back through the host
    const saved = await fetch(`${base}/engine/ledger/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(note) })
    const record = await saved.json()
    const reopened = await fetch(`${base}/engine/ledger/note`).then(response => response.json())
    // Then the full content survives in the trading-owned data directory
    expect(saved.status).toBe(200)
    expect(record).toMatchObject(note)
    expect(reopened.note).toEqual([record])
    expect(existsSync(join(dataDir, 'ledger', 'note.json'))).toBe(true)
  })
  it('operator ships the upstream license with the migrated runtime', () => {
    // Given the bundled migrated engine resources
    const license = readFileSync(new URL('../runtime/LICENSE', import.meta.url), 'utf8')
    // When the source attribution is inspected
    const attribution = JSON.parse(readFileSync(new URL('../runtime/UPSTREAM.json', import.meta.url), 'utf8'))
    // Then redistribution retains the upstream MIT notice and exact revision
    expect(license).toContain('Copyright (c) 2026 simonlin1212')
    expect(attribution.commit).toBe('94f61bf517393f80e88e974c224ac20b774ff990')
  })
  it('user imports and retrieves a research document through the native library', async () => {
    // Given a small user document and an isolated library
    const { base } = await fixture()
    const text = '# Research fixture\nEvidence: disclosed revenue; open question: margins.'
    // When it is uploaded, previewed and downloaded from the host
    const response = await fetch(`${base}/engine/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'research-fixture.md', content: Buffer.from(text).toString('base64') }) })
    const report = await response.json()
    const preview = await fetch(`${base}/engine/reports/${report.id}/preview`).then(response => response.json())
    const download = await fetch(`${base}/engine/reports/${report.id}/download`)
    // Then both the extracted research text and original file remain available
    expect(response.status).toBe(200)
    expect(preview.text).toContain('disclosed revenue')
    expect(download.status).toBe(200)
    expect(await download.text()).toBe(text)
  })
})
