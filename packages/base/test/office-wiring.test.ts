import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isMap, isSeq, parseDocument } from 'yaml'

/**
 * Official Office and dependency wiring is carried by the base bundle patch
 * (market-agnostic shared rows, README iron rule #1). The rows keep the
 * OFFICIAL ids so a carrier or user profile re-mounting them performs a
 * whole-row override rather than a second provider registering the same skills.
 */
const patchText = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

type Row = Map<unknown, unknown>

function insertRows(): Map<string, Row> {
  const doc = parseDocument(patchText, { logLevel: 'silent' })
  const rows = new Map<string, Row>()
  if (!isSeq(doc.contents)) return rows
  for (const entry of doc.contents.items) {
    if (!isMap(entry)) continue
    const insert = entry.get('insert')
    if (!isSeq(insert)) continue
    for (const row of insert.items) {
      if (!isMap(row)) continue
      const id = row.get('id')
      if (typeof id === 'string') rows.set(id, row)
    }
  }
  return rows
}

const rows = insertRows()

/** The `!!js` expression source, read as the raw Scalar node rather than its value. */
function expressionOf(node: unknown): string {
  const value = (node as { value?: unknown } | undefined)?.value
  if (typeof value !== 'string') throw new Error('expected a !!js expression scalar')
  return value
}

/** Evaluate one expression against a synthetic process (no real env mutation). */
function evaluate(expression: string, env: Record<string, string | undefined>): unknown {
  const require = createRequire(import.meta.url)
  const processShim = { env, getBuiltinModule: (specifier: string) => require(specifier) }
  return new Function('process', 'return (' + expression + ')')(processShim)
}

/** 载荷根：POSIX 形态给绝对路径。Windows 上 `path.resolve('/opt/…')` 会按当前盘符补成
 * `D:\\opt\\…`，所以要按本平台算期望值，不能把 POSIX 结果写死成跨平台事实。 */
const PAYLOAD = '/opt/dsh-primary-runtime'
const withPayload = { DSH_PRIMARY_RUNTIME: PAYLOAD, DSH_BUNDLED_PRIMARY_RUNTIME: undefined }
const bare = { DSH_PRIMARY_RUNTIME: undefined, DSH_BUNDLED_PRIMARY_RUNTIME: undefined }

describe('official Office and workspace-dependency wiring', () => {
  it('operator mounts the official office provider row under its official id', () => {
    // Given the composed base bundle patch
    // When the office row is read by its official id
    const row = rows.get('skill-office')
    // Then it names the official provider: an override of the official row, not a parallel provider
    expect(row).toBeDefined()
    expect(row!.get('name')).toBe('@deepseek-ai/dsh-skill-office')
    // And it declares no assetRoot/node/cli, so both delivery shapes keep the official defaults.
    expect(row!.get('config')).toBeUndefined()
  })

  it('operator mounts the official workspace-dependencies row with the payload-derived source', () => {
    // Given the composed base bundle patch
    // When the dependency row is read by its official id
    const row = rows.get('workspace-dependencies')
    // Then it names the official tool
    expect(row).toBeDefined()
    expect(row!.get('name')).toBe('@deepseek-ai/dsh-tool-workspace-dependencies')
    const config = row!.get('config')
    expect(isMap(config)).toBe(true)
    // And its source is the same env-derived payload root the office row is gated on.
    expect(expressionOf((config as Row).get('source', true))).toContain('DSH_PRIMARY_RUNTIME')
  })

  it('operator sees Office and dependency capabilities explicitly absent without a primary runtime', () => {
    // Given neither env variable names a primary runtime
    // When each row's guard is evaluated
    // Then both rows are disabled (explicit absence), so nothing falls back to system Python or PATH.
    for (const id of ['skill-office', 'workspace-dependencies']) {
      expect(evaluate(expressionOf(rows.get(id)!.get('disabled', true)), bare)).toBe(true)
    }
    // And a carrier payload turns both rows on.
    for (const id of ['skill-office', 'workspace-dependencies']) {
      expect(evaluate(expressionOf(rows.get(id)!.get('disabled', true)), withPayload)).toBe(false)
    }
  })

  it('operator gets an absolute payload source path derived from the primary-runtime env', () => {
    // Given a carrier payload
    // When the dependency row's source expression is evaluated
    const config = rows.get('workspace-dependencies')!.get('config') as Row
    // Then it resolves to that absolute directory (the official tool validates the payload layout).
    // 期望值按本平台的目标算：Windows 无盘符的 POSIX 路径会被补成 `<盘>:\\…`。
    expect(evaluate(expressionOf(config.get('source', true)), withPayload)).toBe(resolve(PAYLOAD))
  })
})
