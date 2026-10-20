/**
 * 预设工具面/呈现方式 单测。
 *
 * 这里不 import presets.ts——它依赖 `@deepseek-ai/dsh-agent-preset-registry`，
 * 而该包由宿主运行时提供、不在仓库依赖里（主检出原本就跑不通 presets.test.ts）。
 * 因此对源文件做结构化断言：契约是「四个预设各有一行 presentation，
 * mode 与 PRESENTATION 表一致」，以及「索引行、裁剪行、呈现行的相对顺序」
 * （surface 必须晚于工具行，否则展开时工具尚未注册）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dirname, '../src/presets.ts'), 'utf8')

describe('preset tool surface & presentation wiring', () => {
  it('四个角色都有 presentation 与 surface 行', () => {
    expect(source).toContain('dsh-trading-${id}-presentation')
    expect(source).toContain('dsh-trading-tool-surface')
    expect(source).toContain('dsh-trading-tool-index')
  })

  it('presentation mode 表与预期一致（只读 specialist 开 ptc）', () => {
    const block = /const PRESENTATION[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(block).toContain("trader: 'native'")
    expect(block).toContain("'instrument-researcher': 'ptc'")
    expect(block).toContain("'risk-reviewer': 'ptc'")
    expect(block).toContain("master: 'native'")
  })

  it('行顺序：index -> surface -> presentation -> shell', () => {
    const plugins = /plugins:\s*\[(.*?)\]\s*,\s*\}\s*\}\)/s.exec(source)?.[1] ?? ''
    const order = ['...indexRow', '...surfaceRow', '...presentationRow', '...shellRow']
      .filter(row => plugins.includes(row))
    expect(order).toEqual(['...indexRow', '...surfaceRow', '...presentationRow', '...shellRow'])
  })

  it('裁剪保持最小争议（未追加更激进的角色）', () => {
    const block = /const SURFACE[^{]*\{([\s\S]*?)\n    \}/.exec(source)?.[1] ?? ''
    expect(block).toContain("trader: { denyFamilies: ['tasks'] }")
    expect(block).toContain("master: { denyFamilies: [] }")
    // 不出现账户类 denyTools（用户 2026-10-20 明确「不用更激进」）
    expect(source).not.toContain('denyTools:')
  })
})
