/**
 * check-evidence-runner 自测（进 test:scripts）：验证这条门禁**真的会红**。
 *
 * 门禁自己错了永远不会被发现 —— 所以这里用两件事证明它不空转：
 *   ① 真脚本 ⇒ 绿；
 *   ② 把真脚本改回"旧假绿形态"（不删旧 bundle、build 失败不传播、取锁失败继续）⇒ 门禁必须红。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'apps/ios-native', 'docs', 'evidence', 'run-all-tests.sh')
const NL = String.fromCharCode(10)
const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 把真是脚本按给定替换改写成一份变体，返回变体路径（每次调用兑现一次写盘）。 */
function mutatedScript(replacements) {
  const original = readFileSync(SCRIPT, 'utf8')
  let text = original
  for (const [from, to] of replacements) {
    expect(text.includes(from)).toBe(true)
    text = text.split(from).join(to)
  }
  expect(text).not.toBe(original)
  const dir = mkdtempSync(join(tmpdir(), 'ios-evidence-mutant-'))
  dirs.push(dir)
  const target = join(dir, 'run-all-tests.sh')
  writeFileSync(target, text)
  return target
}

function runGate(scriptPath) {
  const args = ['scripts/ios-native/check-evidence-runner.mjs']
  if (scriptPath !== undefined) args.push('--script', scriptPath)
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' })
}

describe('证据脚本门禁自测', () => {
  it('管理员：真实脚本 ⇒ 门禁绿', () => {
    // Given 仓库里当前的 run-all-tests.sh
    // When 门禁自测它
    const result = runGate()
    // Then 七个场景全过
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('7 个场景全部符合预期')
  })

  it('管理员：把脚本改回旧假绿形态（不删旧 bundle + build 失败不传播）⇒ 门禁红', () => {
    // Given 旧形态：不先删旧产物、build 非 0 也往下跑、产物检查形同虚设
    const mutant = mutatedScript([
      ['  rm -rf "$product"' + NL, ''],
      ['if [ "$build_code" -ne 0 ]; then', 'if false; then'],
      ['if [ ! -f "$binary" ]; then', 'if false; then'],
      ['if [ "$product_mtime" -lt "$build_started" ]; then', 'if false; then'],
    ])
    // When 门禁自测它
    const result = runGate(mutant)
    // Then 红，且指出编译失败时脚本仍 exit 0（正是被修的假绿）
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('坏源')
    expect(result.stderr).toContain('编译失败时脚本仍 exit 0')
    expect(result.stderr).toContain('旧 bundle')
  })

  it('管理员：把取锁失败的 exit 75 改成继续 ⇒ 门禁红', () => {
    // Given 无锁也照跑的旧形态
    const mutant = mutatedScript([['  exit 75' + NL, '  : # exit 75（旧形态：无锁也跑）' + NL]])
    // When 门禁自测它
    const result = runGate(mutant)
    // Then 红，且指出取锁失败退出码不是 75
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('锁被占用')
    expect(result.stderr).toContain('不是 75')
  })

  it('管理员：删掉缺报告判红（只看 xctest 退出码）⇒ 门禁红', () => {
    // Given 只看 xctest 退出码、不看报告的旧形态
    const mutant = mutatedScript([
      ['if [ -z "$report" ]; then', 'if false; then'],
      ['if [ "$test_code" -ne 0 ] || [ "$report_failures" != "0" ]; then', 'if [ "$test_code" -ne 0 ]; then'],
    ])
    // When 门禁自测它
    const result = runGate(mutant)
    // Then 红，且指出没有报告仍判绿
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('缺报告')
    expect(result.stderr).toContain('没有报告仍判绿')
  })
})
