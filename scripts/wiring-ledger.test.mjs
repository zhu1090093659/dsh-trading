/**
 * wiring-ledger 自测（进 test:scripts）：台账脚本必须能跑、必须给出分段计数、必须点名缺口，
 * 且**引用分类要准** —— 测试文件与台账脚本自身的命中不算生产引用（F4 点名的两个口径杂质）。
 * 只断言**格式与自洽性**，不断言具体数字（接线推进会合法地改变数字）。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { classifyReference, countReferences, listFactoryNames } from './wiring-ledger.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'wiring-ledger.mjs')
const NL = String.fromCharCode(10)

/**
 * "真跑一次台账"的用例的超时上界（毫秒）。
 *
 * 为什么需要它：台账要遍历 packages + scripts 的整棵树（实测 1.9~5.7s），而 vitest 默认
 * 5000ms ⇒ 余量偏窄：机器空闲时绿、并发负载下必假红。同一模式已在 gates-all.test.mjs 上
 * 实测到 7667ms 翻红（那是门禁在测机器负载，不是在测代码）。60s 是**上界不是期望耗时**：
 * 真卡死照样超时变红，只是不再把负载抖动算成被测代码的缺陷。
 */
const WIRING_RUN_TIMEOUT_MS = 60_000

function run() {
  return spawnSync(process.execPath, ['scripts/wiring-ledger.mjs'], { cwd: ROOT, encoding: 'utf8' })
}

/** 明细行：表头也以 [wiring] 开头且含 |，必须排除（第一版就是这么多数了一行）。 */
function detailLines(stdout) {
  return stdout.split(NL).filter((line) => line.startsWith('[wiring] ') && line.includes(' | ') && line.includes('('))
}

/** 明细行拆列：[标签] 名称 (文件) | 生产 | 演练 | 测试 | 判定 */
function parseRow(line) {
  const parts = line.split(' | ')
  return { name: parts[0].replace('[wiring] ', '').replace(/ \(.*\)$/, ''), counts: parts.slice(1, 4).map(Number), verdict: parts[4] }
}

describe('接线台账脚本', () => {
  it('管理员：能跑通并给出分段计数（生产已接线 / 仅演练 / 无调用点）', () => {
    // Given 仓库现状
    // When 跑台账
    const result = run()
    // Then 退出码 0，且汇总行含各种分类，明细表头含新增的测试引用列
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('合计')
    expect(result.stdout).toContain('生产已接线')
    expect(result.stdout).toContain('仅演练')
    expect(result.stdout).toContain('无调用点')
    expect(result.stdout).toContain('工厂函数 | 生产引用 | 演练引用 | 测试引用 | 判定')
  }, WIRING_RUN_TIMEOUT_MS)

  it('管理员：汇总行的分段数字与逐行判定自洽', () => {
    // Given 台账输出
    const result = run()
    const lines = detailLines(result.stdout)
    // When 逐行统计判定与四列数字
    const rows = lines.map(parseRow)
    const wired = rows.filter((row) => row.verdict === '生产已接线').length
    const drillOnly = rows.filter((row) => row.verdict === '仅演练在用').length
    const zero = rows.filter((row) => row.verdict === '无调用点').length
    // Then 每行四列齐全、数字可解析，且行数与汇总一致（防止汇总与明细各说各话）
    for (const row of rows) expect(row.counts.every((n) => Number.isInteger(n) && n >= 0)).toBe(true)
    const summary = result.stdout.match(/合计 (\d+) 个工厂：生产已接线 (\d+)、仅演练 (\d+)、\*\*无调用点 (\d+)\*\*/)
    expect(summary).not.toBeNull()
    expect(Number(summary[1])).toBe(lines.length)
    expect(Number(summary[2])).toBe(wired)
    expect(Number(summary[3])).toBe(drillOnly)
    expect(Number(summary[4])).toBe(zero)
    // Then 判定与列自洽：生产>0 才算接线，演练>0 才有"仅演练在用"
    for (const row of rows) {
      if (row.verdict === '生产已接线') expect(row.counts[0]).toBeGreaterThan(0)
      if (row.verdict === '仅演练在用') expect(row.counts[0]).toBe(0)
      if (row.verdict === '无调用点') expect(row.counts[0] + row.counts[1]).toBe(0)
    }
  }, WIRING_RUN_TIMEOUT_MS)

  it('管理员：存在零调用点时列出清单（有缺口必须点名，不能只给数字）', () => {
    // Given 台账输出
    const result = run()
    const zero = detailLines(result.stdout).map(parseRow).filter((row) => row.verdict === '无调用点')
    // When 看清单行
    const hasList = result.stdout.includes('无调用点清单：')
    // Then 有零调用点就必须有清单；没有就不该有（自洽）
    expect(hasList).toBe(zero.length > 0)
  }, WIRING_RUN_TIMEOUT_MS)

  it('管理员：经符号链接调用时台账仍然真的跑（守卫不许静默空转）', () => {
    // Given 台账被一条符号链接指向（macOS 的 /tmp、/var 都是链接，argv[1] 与 import.meta.url 文字形态不同）
    const dir = mkdtempSync(join(tmpdir(), 'wiring-ledger-link-'))
    const link = join(dir, 'wiring-ledger-link.mjs')
    symlinkSync(SCRIPT, link)
    try {
      // When 通过符号链接调用
      const result = spawnSync(process.execPath, [link], { cwd: ROOT, encoding: 'utf8' })
      // Then 与直接调用同判（旧守卫 realpath 前就比较，会零输出 + exit 0）
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('合计')
      expect(result.stdout).toContain('无调用点')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, WIRING_RUN_TIMEOUT_MS)
})

describe('引用分类（测试与自引用不计生产）', () => {
  it('管理员：入口与源码算生产，test 目录/spec 命名算测试，drill 目录算演练，台账自身算自引用', () => {
    // Given 五类真实仓库路径 + 一条 Windows 分隔符路径
    const cases = [
      [join(ROOT, 'packages', 'tradectl', 'bin', 'core.mjs'), 'production'],
      [join(ROOT, 'packages', 'tradectl', 'src', 'desk-process.ts'), 'production'],
      [join(ROOT, 'packages', 'contract', 'test', 'contract.test.ts'), 'test'],
      [join(ROOT, 'scripts', 'gates-all.test.mjs'), 'test'],
      [join(ROOT, 'packages', 'client-ui-masters-quotes', 'test', 'apply.spec.ts'), 'test'],
      [join(ROOT, 'packages', 'tradectl', 'drill', 'shadow-run.ts'), 'drill'],
      [join(ROOT, 'scripts', 'wiring-ledger.mjs'), 'self'],
      ['packages\\tradectl\\drill\\shadow-run.ts', 'drill'],
    ]
    // When 逐个分类
    // Then 每条都落在正确的桶里（旧版把测试与自引用都算成生产）
    expect(cases.map(([path]) => classifyReference(path))).toEqual(cases.map(([, kind]) => kind))
  })

  it('管理员：计数时测试引用不进生产、自引用被忽略、工厂定义文件不算调用点', () => {
    // Given 一棵合成树：同一工厂被入口、测试、演练各引用一次，另在台账脚本注释里被提一句
    const origin = join(ROOT, 'packages', 'tradectl', 'src', 'alpha.ts')
    const sources = [
      { path: join(ROOT, 'packages', 'tradectl', 'bin', 'core.mjs'), text: 'createAlpha()' },
      { path: join(ROOT, 'packages', 'cockpit', 'test', 'probe.test.ts'), text: 'createAlpha(); createAlpha()' },
      { path: join(ROOT, 'packages', 'tradectl', 'drill', 'probe.ts'), text: 'createAlpha()' },
      { path: join(ROOT, 'scripts', 'wiring-ledger.mjs'), text: '// 注释里提一句 createAlpha' },
    ]
    const factories = [
      { name: 'createAlpha', file: 'alpha.ts', origin },
      { name: 'createBeta', file: 'beta.ts', origin: join(ROOT, 'packages', 'tradectl', 'drill', 'probe.ts') },
    ]
    // When 计数
    const rows = countReferences(factories, sources)
    // Then 生产只数入口那 1 次；测试 2 次单列；自引用 0；定义文件自己不算调用点
    expect(rows).toEqual([
      { name: 'createAlpha', file: 'alpha.ts', production: 1, drill: 1, test: 2 },
      { name: 'createBeta', file: 'beta.ts', production: 0, drill: 0, test: 0 },
    ])
  })
})

describe('工厂枚举口径（async 与同步同等对待）', () => {
  it('管理员：枚举同时看得见 export function 与 export async function（V2 验收发现 2 的回归钉）', () => {
    // Given 一段含同步工厂、async 工厂、open 前缀工厂的源码
    const source = [
      'export function createAlpha(): void {}',
      'export async function createBeta(): Promise<void> {}',
      'export function openGamma(): void {}',
      'export async function openDelta(): Promise<void> {}',
    ].join(NL)
    // When 按台账口径枚举
    const names = listFactoryNames(source)
    // Then 四个都点名（第一版正则漏掉全部 async 工厂，台账因此系统性低估未接线面）
    expect(names).toEqual(['createAlpha', 'createBeta', 'openGamma', 'openDelta'])
  })

  it('管理员：不把非工厂导出当成工厂（口径只收 create…/open… 函数声明）', () => {
    // Given 一段只有非工厂导出的源码（async 函数、箭头函数、常量、类型）
    const source = [
      'export async function safeBoot(): Promise<void> {}',
      'export const createArrow = () => undefined',
      'export function helper(): void {}',
      'export type createType = string',
      'const createShadowed = 1',
    ].join(NL)
    // When 按台账口径枚举
    const names = listFactoryNames(source)
    // Then 一个都不收（否则台账会把 helper 之类的东西算成"已接线"，把未接线面稀释掉）
    expect(names).toEqual([])
  })

  it('管理员：同一段文本反复枚举结果一致（带 g 的正则不得因 lastIndex 漏匹配）', () => {
    // Given 一段含 async 工厂的源码
    const source = 'export async function createBeta(): Promise<void> {}' + NL + 'export function createAlpha(): void {}'
    // When 连枚举两次
    const first = listFactoryNames(source)
    const second = listFactoryNames(source)
    // Then 两次一致且都看得见 async 工厂（复用同一个带 g 的正则对象会第二次漏掉）
    expect(first).toEqual(['createBeta', 'createAlpha'])
    expect(second).toEqual(first)
  })
})
