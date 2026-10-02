/**
 * check-contract-drift 自测（进 test:scripts）：用**真实契约源码的副本**做夹具，
 * 验证门禁在"Swift 侧被改动"时真的会红，并点名漂移的键；同时验证缺文件时 fail-closed。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const REAL_CONTRACT = join(ROOT, 'apps/ios-native/Sources/Contract')
const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 把仓内真契约源码复制成夹具，可选地对某一份做替换。 */
function fixtureContract(transform = (files) => files) {
  const dir = mkdtempSync(join(tmpdir(), 'contract-drift-'))
  dirs.push(dir)
  const files = {}
  for (const name of readdirSync(REAL_CONTRACT)) files[name] = readFileSync(join(REAL_CONTRACT, name), 'utf8')
  for (const [name, content] of Object.entries(transform(files))) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

function check(dir) {
  return spawnSync(process.execPath, ['scripts/ios-native/check-contract-drift.mjs', '--swift-dir', dir], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

describe('契约防漂移门禁', () => {
  it('管理员：真契约源码的副本 ⇒ 绿', () => {
    // Given 一份与仓内逐字节相同的契约副本
    const dir = fixtureContract()
    // When 检查
    const result = check(dir)
    // Then 通过
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('绿')
  })

  it('管理员：Swift 侧常量被改而 TS 未改 ⇒ 红且点名该键', () => {
    // Given 把 ApiContract.minor 从 0 改成 99（TS 权威仍是 0）
    const dir = fixtureContract((files) => ({
      ...files,
      'ContractVersion.swift': files['ContractVersion.swift'].replace('public static let minor = 0', 'public static let minor = 99'),
    }))
    // When 检查
    const result = check(dir)
    // Then 抓住漂移并指出是哪个键
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ApiContract.minor')
    expect(result.stderr).toContain('红')
  })

  it('管理员：契约文件缺失 ⇒ 红（fail-closed，不静默通过）', () => {
    // Given 少了一份契约源码
    const dir = fixtureContract((files) => {
      const copy = { ...files }
      delete copy['ContractPush.swift']
      return copy
    })
    // When 检查
    const result = check(dir)
    // Then 解析不出来即判红
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('红')
  })

  it('管理员：Card.revision 被改回 Int ⇒ 红且点名数值域漂移', () => {
    // Given 把 Card.revision 从 Double 改回 Int
    const dir = fixtureContract((files) => ({
      ...files,
      'ContractCards.swift': files['ContractCards.swift'].replace('public let revision: Double', 'public let revision: Int'),
    }))
    // When 检查
    const result = check(dir)
    // Then 拦下并点名
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Card.revision 类型漂移')
    expect(result.stderr).toContain('红')
  })

  it('管理员：字符串计量被改成 bare .count ⇒ 红且点名 UTF-16 计量漂移', () => {
    // Given 把 .utf16.count 改成 .count
    const dir = fixtureContract((files) => ({
      ...files,
      'ContractCards.swift': files['ContractCards.swift'].replace(
        'card.fallbackText.utf16.count > limits.maxFallbackChars',
        'card.fallbackText.count > limits.maxFallbackChars',
      ),
    }))
    // When 检查
    const result = check(dir)
    // Then 拦下并点名
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('validateCard 字符串计量漂移')
    expect(result.stderr).toContain('红')
  })
})
