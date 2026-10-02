#!/usr/bin/env node
// Given TS authority, When a Swift limit drifts, Then tests fail; restoration passes.
import { mkdirSync, readFileSync, writeFileSync, rmdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
mkdirSync('build', { recursive: true })
try { mkdirSync('build/.heavy.lock') } catch (error) {
  if (error.code !== 'EEXIST') throw error
  console.error('HEAVY_LOCK_BUSY: mutation did not modify source')
  process.exit(75)
}
const source = 'Sources/Contract/ContractPush.swift'
const original = readFileSync(source, 'utf8')
const marker = 'PushLimits(maxActions: 3, maxFallbackChars:'
const run = (command, args, log) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  if (log) writeFileSync(log, output)
  if (result.error) throw result.error
  return { status: result.status, output }
}
const compile = () => {
  const r = run('xcodebuild', ['-project', 'DshTradingNative.xcodeproj', '-scheme', 'DshTradingContractTests', '-destination', 'platform=macOS', '-derivedDataPath', 'build/DerivedData', 'build-for-testing'], 'build/ios1-mutation-compile.log')
  if (r.status !== 0) throw new Error('Contract compile failed: ' + r.status)
}
const test = log => run('xcrun', ['xctest', 'build/DerivedData/Build/Products/Debug/DshTradingContractTests.xctest'], log)
try {
  if (!original.includes(marker)) throw new Error('Mutation marker missing; do not guess')
  for (const [command, args] of [['node', ['scripts/gen-contract-snapshot.mjs']], ['/opt/homebrew/bin/xcodegen', ['generate']]]) {
    const r = run(command, args)
    if (r.status !== 0) throw new Error(command + ' failed: ' + r.status)
  }
  try {
    writeFileSync(source, original.replace(marker, 'PushLimits(maxActions: 4, maxFallbackChars:'))
    compile()
    const red = test('build/ios1-mutation-red.log')
    if (red.status === 0 || !red.output.includes('XCTAssertEqual failed')) throw new Error('Mutation did not trigger parity assertions')
    console.log('MUTATION_RED_EXIT=' + red.status)
    console.log(red.output.split('\n').filter(line => line.includes('error:')).join('\n'))
  } finally { writeFileSync(source, original) }
  compile()
  const green = test('build/ios1-mutation-restored.log')
  console.log('RESTORED_GREEN_EXIT=' + green.status)
  console.log(green.output.split('\n').filter(line => line.includes('Executed')).slice(-1).join('\n'))
  if (green.status !== 0) throw new Error('Restored contract failed')
} finally {
  rmdirSync('build/.heavy.lock')
}
