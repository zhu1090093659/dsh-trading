/**
 * e2e-smoke 常设冒烟包自测（进 test:scripts，纯 JS）。
 *
 * 钉的是**冒烟自己声明的清单**（`node scripts/e2e-smoke.mjs --list`），而不是在测试里再抄一份：
 * 抄一份的话，演练被挪出默认模式（改成 network: true）时测试照样绿 —— 那正是 2026-10-01
 * 客户端链路演练"只在单测里被钉值、没进常设冒烟"的复现路径。
 *
 * 清单里写着 expect: [...] 只说明"冒烟打算断言这些片段"，不说明它们真的会出现；
 * 第二条用例用演练的**真实输出**复核这组片段（未验证 ≠ 通过）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SMOKE = 'scripts/e2e-smoke.mjs'
const DRILL = 'packages/tradectl/drill/v1-client-flow.ts'
const NL = String.fromCharCode(10)

/** 真起进程：spawnSync 一直等到子进程退出，不是 sleep。 */
function run(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 })
}

/** 冒烟声明的检查清单（--list 只列不跑，所以不需要构建产物）。 */
function listChecks() {
  const result = run(SMOKE, ['--list'])
  expect(result.status, '--list 退出码非 0：' + String(result.stderr)).toBe(0)
  return JSON.parse(result.stdout)
}

function drillEntry() {
  const entry = listChecks().find((check) => check.script === DRILL)
  expect(entry, DRILL + ' 不在常设冒烟清单里（默认模式丢了这个演练）').toBeDefined()
  return entry
}

describe('常设冒烟包（e2e-smoke）', () => {
  it('管理员：默认模式必须包含 v1-client-flow 演练，且不标成需要网络或 Electron', () => {
    // Given 冒烟声明的检查清单
    const checks = listChecks()
    // When 找客户端链路那一条
    const entry = checks.find((check) => check.script === DRILL)
    // Then 它在默认模式里、脚本真实存在、有超时、且断言的是输出特征而非空断言
    expect(entry, DRILL + ' 不在常设冒烟清单里').toBeDefined()
    expect(existsSync(join(ROOT, DRILL))).toBe(true)
    expect(entry.network).toBe(false)
    expect(entry.electron).toBe(false)
    expect(entry.timeoutMs).toBeGreaterThan(0)
    expect(entry.expect.length).toBeGreaterThan(0)
    expect(entry.expect.join(' ')).toContain('v1-client-flow')
  })

  it('管理员：冒烟声明的断言片段必须真的出现在演练输出里（防两边放宽）', () => {
    // Given 冒烟对 v1-client-flow 声明的断言片段
    const entry = drillEntry()
    // When 真跑这个演练
    const result = run(DRILL)
    const output = (result.stdout ?? '') + (result.stderr ?? '')
    // Then 退出码 0，且每一个声明的片段都命中真实输出
    expect(result.status, output.split(NL).slice(-6).join(' | ')).toBe(0)
    for (const needle of entry.expect) expect(output, '缺少片段：' + needle).toContain(needle)
  })

  it('管理员：演练只绑回环地址（这是它进默认模式、不进 --with-network 的理由）', () => {
    // Given 真跑一次演练
    const result = run(DRILL)
    // When 读它打印的摘要行
    const prefix = '[v1-client-flow] 摘要 '
    const summaryLine = (result.stdout ?? '').split(NL).find((line) => line.startsWith(prefix))
    expect(summaryLine, '摘要行缺失：' + String(result.stdout).slice(0, 200)).toBeDefined()
    const summary = JSON.parse(summaryLine.slice(prefix.length))
    // Then 网关只绑 127.0.0.1 的临时端口 —— 默认模式没有外部网络依赖
    expect(summary.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })
})
