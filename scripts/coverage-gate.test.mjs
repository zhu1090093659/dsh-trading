/**
 * coverage-gate 自测（进 CI 的 test:scripts）：
 * 覆盖率门禁最要命的一条性质 —— **包没产出报告时必须判失败**。
 *
 * 为什么值得单独立一条：旧版把"没报告"的包 push 进 failures 就 continue（等于从聚合里
 * 移出），判红时又只看 dropped，于是"某个包整体跑不起来"会以 exit 0 印成"通过"。
 * 这条用**真实的临时仓库根**构造该场景（--reuse-reports 读已有报告），不跑真覆盖率、
 * 不依赖机器负载、不等任何东西。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { judge } from './coverage-gate.mjs'

const GATE = fileURLToPath(new URL('./coverage-gate.mjs', import.meta.url))
const METRICS = ['branches', 'lines', 'functions', 'statements']

/** vitest json-summary 的 total 段：total/covered/pct 三个字段，聚合只读这三个。 */
function summaryWith(pct) {
  return {
    total: Object.fromEntries(METRICS.map((metric) => [metric, { total: 100, covered: pct, pct }])),
    ...Object.fromEntries(METRICS.map((metric) => [metric, { total: 100, covered: pct, pct, skipped: 0 }])),
  }
}

function baselineWith(pct) {
  return Object.fromEntries(METRICS.map((metric) => [metric, { pct }]))
}

const tempRoots = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 造一个临时仓库根：packages/<name> 各自是一个"可测包"（有 test 脚本）。 */
function fixture(packageNames) {
  const root = mkdtempSync(join(tmpdir(), 'coverage-gate-'))
  tempRoots.push(root)
  for (const name of packageNames) {
    mkdirSync(join(root, 'packages', name), { recursive: true })
    writeFileSync(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify({ name, scripts: { test: 'vitest run' } }) + '\n',
    )
  }
  return root
}

/** 放入一个包的覆盖率报告（--reuse-reports 就是聚合它）。 */
function writeReport(root, name, pct) {
  mkdirSync(join(root, '.coverage', name), { recursive: true })
  writeFileSync(join(root, '.coverage', name, 'coverage-summary.json'), JSON.stringify(summaryWith(pct)) + '\n')
}

function writeBaseline(root, pct) {
  writeFileSync(join(root, 'baseline.json'), JSON.stringify(baselineWith(pct), null, 2) + '\n')
}

function runGate(root, args) {
  return spawnSync(
    process.execPath,
    [
      GATE, ...args,
      `--packages-dir=${join(root, 'packages')}`,
      `--coverage-dir=${join(root, '.coverage')}`,
      `--baseline=${join(root, 'baseline.json')}`,
      '--reuse-reports',
    ],
    { encoding: 'utf8' },
  )
}

describe('coverage-gate 的判定', () => {
  it('管理员：只有"包没有报告"而指标没下降时也判失败，并点名那个包', () => {
    // Given 一份聚合结果：good 有报告、broken 没有（指标与基线持平）
    const result = {
      metrics: Object.fromEntries(METRICS.map((metric) => [metric, { total: 100, covered: 50, pct: 50 }])),
      perPackage: { good: { branches: 50 } },
      failures: [{ package: 'broken', reason: 'no coverage report' }],
    }
    // When 判定
    const verdict = judge(result, baselineWith(50))
    // Then 判失败，且失败原因是缺报告而不是指标下降
    expect(verdict.ok).toBe(false)
    expect(verdict.dropped).toEqual([])
    expect(verdict.missing).toEqual([{ package: 'broken', reason: 'no coverage report' }])
  })

  it('管理员：指标下降时照旧判失败（新判定没有削弱原棘轮）', () => {
    // Given 全部包都有报告，但分支覆盖率比基线低 5pp
    const result = {
      metrics: Object.fromEntries(METRICS.map((metric) => [metric, { total: 100, covered: metric === 'branches' ? 45 : 50, pct: metric === 'branches' ? 45 : 50 }])),
      perPackage: { good: { branches: 45 } },
      failures: [],
    }
    // When 判定
    const verdict = judge(result, baselineWith(50))
    // Then 只有 branches 判红，且带上前后数值
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual([])
    expect(verdict.dropped).toEqual([{ metric: 'branches', baseline: 50, now: 45 }])
  })
})

describe('coverage-gate 的真实运行（临时仓库根）', () => {
  it('管理员：某个包没有报告时 exit 1，并在输出里点名该包', () => {
    // Given good 有报告、broken 没有，基线等于 good 的指标（指标本身没有下降）
    const root = fixture(['good', 'broken'])
    writeReport(root, 'good', 50)
    writeBaseline(root, 50)
    // When 跑门禁
    const result = runGate(root, ['--check'])
    // Then 退出码 1，stdout 与 stderr 都点名 broken
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[无报告] broken')
    expect(result.stderr).toContain('覆盖率门禁：失败')
    expect(result.stderr).toContain('无报告  broken')
  })

  it('管理员：所有包都有报告且指标不下降时通过（不误伤正常仓库）', () => {
    // Given 两个包都有报告，指标与基线持平
    const root = fixture(['good', 'also-good'])
    writeReport(root, 'good', 50)
    writeReport(root, 'also-good', 50)
    writeBaseline(root, 50)
    // When 跑门禁
    const result = runGate(root, ['--check'])
    // Then 退出码 0，且不再报"无报告"
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('覆盖率门禁：通过')
    expect(result.stdout).not.toContain('[无报告]')
  })

  it('管理员：--update 拒绝把"没有报告"固化进基线，基线文件保持原样', () => {
    // Given good 有报告、broken 没有，基线已被种下
    const root = fixture(['good', 'broken'])
    writeReport(root, 'good', 50)
    writeBaseline(root, 50)
    const before = readFileSync(join(root, 'baseline.json'), 'utf8')
    // When 用 --update 刷新基线
    const result = runGate(root, ['--update'])
    // Then 退出码 1、点名 broken，且基线文件一个字节都没动
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('拒绝更新基线')
    expect(result.stderr).toContain('broken')
    expect(readFileSync(join(root, 'baseline.json'), 'utf8')).toBe(before)
  })

  it('管理员：经符号链接调用时门禁仍然真的跑（守卫不许静默空转）', () => {
    // Given good 有报告、broken 没有；门禁被一条符号链接指向（macOS 的 /tmp、/var 都是链接）
    const root = fixture(['good', 'broken'])
    writeReport(root, 'good', 50)
    writeBaseline(root, 50)
    const link = join(root, 'coverage-gate-link.mjs')
    symlinkSync(GATE, link)
    // When 通过符号链接调用
    const result = spawnSync(
      process.execPath,
      [link, '--check',
        `--packages-dir=${join(root, 'packages')}`,
        `--coverage-dir=${join(root, '.coverage')}`,
        `--baseline=${join(root, 'baseline.json')}`,
        '--reuse-reports'],
      { encoding: 'utf8' },
    )
    // Then 与直接调用同判（旧守卫会零输出 + exit 0）
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[无报告] broken')
    expect(result.stderr).toContain('覆盖率门禁：失败')
  })

  it('管理员：--only 子集模式只对选中的包判"必须有报告"', () => {
    // Given good 有报告、broken 没有
    const root = fixture(['good', 'broken'])
    writeReport(root, 'good', 50)
    writeBaseline(root, 50)
    // When 只核对 good 这一个包
    const result = runGate(root, ['--check', '--only=good'])
    // Then 子集通过（broken 不在本次核对范围），并明确标注是子集模式
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('覆盖率门禁：通过')
    expect(result.stdout).toContain('--only 子集模式')
  })
})
