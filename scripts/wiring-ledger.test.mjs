/**
 * wiring-ledger 自测（进 test:scripts）：台账脚本必须能跑、必须给出三段计数、且在有零调用点时列出清单。
 * 只断言**格式与自洽性**，不断言具体数字（接线推进会合法地改变数字）。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
