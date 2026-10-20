/**
 * 预设工具面接线单测。
 *
 * 不 import presets.ts——它依赖 @deepseek-ai/dsh-agent-preset-registry，该包由
 * 宿主运行时提供、不在仓库依赖里（主检出原本就跑不通 presets.test.ts）。因此对
 * 源文件做结构化断言。
 *
 * 当前契约（2026-10-20，用户两次纠正后）：
 * - 不把自定义预设改成 PTC 呈现模式：没有 presentation 行，bootstrap 的
 *   promotedPresentation 必须是 'native'。
 * - 要的是「一个工具批量调子工具」：batchRow 必须给全部角色挂上。
 * - 首轮收窄只给 researcher，且 phase 1 是交易版最小集。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dirname, '../src/presets.ts'), 'utf8')
const plugins = /plugins:\s*\[(.*?)\]\s*,\s*\}\s*\}\)/s.exec(source)?.[1] ?? ''

describe('预设工具面接线', () => {
  it('批量入口给全部角色', () => {
    expect(source).toContain('dsh-trading-tool-batch')
    expect(plugins).toContain('...batchRow')
  })

  it('没有把预设改成 PTC 呈现模式', () => {
    expect(source).not.toContain('dsh-agent-tool-presentation')
    expect(source).not.toContain("promotedPresentation: 'code'")
    expect(source).toContain("promotedPresentation: 'native'")
  })

  it('索引层与裁剪层都在', () => {
    expect(source).toContain('dsh-trading-tool-index')
    expect(source).toContain('dsh-trading-tool-surface')
    expect(plugins).toContain('...indexRow')
    expect(plugins).toContain('...surfaceRow')
  })

  it('两阶段只给 researcher,phase1 是交易版最小集', () => {
    const boot = /const BOOTSTRAP[\s\S]*?\n    \}/.exec(source)?.[0] ?? ''
    expect(boot).toContain("'instrument-researcher': {")
    expect(boot).toContain("commonTools: ['holdings_list', 'routing_get']")
    expect(boot).toContain('shellTools: []')
    expect(boot).toContain('trader: null')
    expect(boot).toContain('master: null')
  })

  it('行顺序：batch -> index -> surface -> bootstrap -> shell', () => {
    const order = ['...batchRow', '...indexRow', '...surfaceRow', '...bootstrapRow', '...shellRow']
      .filter(row => plugins.includes(row))
    expect(order).toEqual(['...batchRow', '...indexRow', '...surfaceRow', '...bootstrapRow', '...shellRow'])
  })

  it('裁剪保持最小争议（用户明确「不用更激进」）', () => {
    const block = /const SURFACE[^{]*\{([\s\S]*?)\n    \}/.exec(source)?.[1] ?? ''
    expect(block).toContain("trader: { denyFamilies: ['tasks'] }")
    expect(block).toContain("master: { denyFamilies: [] }")
    expect(source).not.toContain('denyTools:')
  })
})
