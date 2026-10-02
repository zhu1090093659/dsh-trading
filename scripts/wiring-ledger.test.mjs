/**
 * wiring-ledger 自测（进 test:scripts）：台账脚本必须能跑、必须给出三段计数、且在有零调用点时列出清单。
 * 只断言**格式与自洽性**，不断言具体数字（接线推进会合法地改变数字）。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listFactoryNames } from './wiring-ledger.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function run() {
  return spawnSync(process.execPath, ['scripts/wiring-ledger.mjs'], { cwd: ROOT, encoding: 'utf8' })
}

describe('接线台账脚本', () => {
  it('管理员：能跑通并给出三段计数（生产已接线 / 仅演练 / 无调用点）', () => {
    // Given 仓库现状
    // When 跑台账
    const result = run()
    // Then 退出码 0，且汇总行含三种分类
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('合计')
    expect(result.stdout).toContain('生产已接线')
    expect(result.stdout).toContain('仅演练')
    expect(result.stdout).toContain('无调用点')
  })

  it('管理员：汇总行的三段数字与逐行判定自洽', () => {
    // Given 台账输出
    const result = run()
    // 只数**明细行**：表头也以 [wiring] 开头且含 |，必须排除（第一版就是这么多数了一行）
    const lines = result.stdout
      .split(String.fromCharCode(10))
      .filter((line) => line.startsWith('[wiring] ') && line.includes(' | ') && line.includes('('))
    // When 逐行统计判定
    const wired = lines.filter((line) => line.endsWith('生产已接线')).length
    const drillOnly = lines.filter((line) => line.endsWith('仅演练在用')).length
    const zero = lines.filter((line) => line.endsWith('无调用点')).length
    // Then 行数与汇总一致（防止汇总与明细各说各话）
    const summary = result.stdout.match(/合计 (\d+) 个工厂：生产已接线 (\d+)、仅演练 (\d+)、\*\*无调用点 (\d+)\*\*/)
    expect(summary).not.toBeNull()
    expect(Number(summary[1])).toBe(lines.length)
    expect(Number(summary[2])).toBe(wired)
    expect(Number(summary[3])).toBe(drillOnly)
    expect(Number(summary[4])).toBe(zero)
  })

  it('管理员：存在零调用点时列出清单（有缺口必须点名，不能只给数字）', () => {
    // Given 台账输出
    const result = run()
    const zero = result.stdout.split(String.fromCharCode(10)).filter((line) => line.endsWith('无调用点')).length
    // When 看清单行
    const hasList = result.stdout.includes('无调用点清单：')
    // Then 有零调用点就必须有清单；没有就不该有（自洽）
    expect(hasList).toBe(zero > 0)
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
    ].join(String.fromCharCode(10))
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
    ].join(String.fromCharCode(10))
    // When 按台账口径枚举
    const names = listFactoryNames(source)
    // Then 一个都不收（否则台账会把 helper 之类的东西算成"已接线"，把未接线面稀释掉）
    expect(names).toEqual([])
  })

  it('管理员：同一段文本反复枚举结果一致（带 g 的正则不得因 lastIndex 漏匹配）', () => {
    // Given 一段含 async 工厂的源码
    const source = 'export async function createBeta(): Promise<void> {}' + String.fromCharCode(10) + 'export function createAlpha(): void {}'
    // When 连枚举两次
    const first = listFactoryNames(source)
    const second = listFactoryNames(source)
    // Then 两次一致且都看得见 async 工厂（复用同一个带 g 的正则对象会第二次漏掉）
    expect(first).toEqual(['createBeta', 'createAlpha'])
    expect(second).toEqual(first)
  })
})
