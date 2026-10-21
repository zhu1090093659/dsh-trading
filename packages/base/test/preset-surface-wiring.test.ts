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
// 装配体从 map 回调改成 composeRole 后，plugins 行收在 `],\n    }\n  }` 之前。
const plugins = /plugins:\s*\[(.*?)\]\s*,\s*\}\s*\}/s.exec(source)?.[1] ?? ''

describe('预设工具面接线', () => {
  it('管理员：批量入口给全部角色', () => {
    // Given presets.ts 源文件与它的 plugins 行
    // When 检查批量入口插件 id 与批量行展开
    // Then 批量入口行存在且被展开给全部角色
    expect(source).toContain('dsh-trading-tool-batch')
    expect(plugins).toContain('...batchRow')
  })

  it('管理员：没有把预设改成 PTC 呈现模式', () => {
    // Given presets.ts 源文件
    // When 检查呈现模式相关声明
    // Then 没有 PTC 呈现插件、没有 code 呈现，promotedPresentation 是 native
    expect(source).not.toContain('dsh-agent-tool-presentation')
    expect(source).not.toContain("promotedPresentation: 'code'")
    expect(source).toContain("promotedPresentation: 'native'")
  })

  it('管理员：索引层与裁剪层都在', () => {
    // Given presets.ts 的 plugins 行
    // When 检查索引层与裁剪层的插件 id 与展开行
    // Then 索引层与裁剪层都挂上
    expect(source).toContain('dsh-trading-tool-index')
    expect(source).toContain('dsh-trading-tool-surface')
    expect(plugins).toContain('...indexRow')
    expect(plugins).toContain('...surfaceRow')
  })

  it('管理员：两阶段只给 researcher,phase1 是交易版最小集', () => {
    // Given presets.ts 的 BOOTSTRAP 常量块
    // When 读取该块的正文
    // Then 只有 researcher 拿到工具面，其余角色为 null、shell 为空
    const boot = /const BOOTSTRAP[\s\S]*?\n    \}/.exec(source)?.[0] ?? ''
    expect(boot).toContain("'instrument-researcher': {")
    expect(boot).toContain("commonTools: ['holdings_list', 'routing_get']")
    expect(boot).toContain("shellTools: ['bash']")
    expect(boot).toContain('trader: null')
    expect(boot).toContain('master: null')
  })

  it('管理员：两阶段声明的 shell 在同一预设里真实挂上', () => {
    // Given BOOTSTRAP 的 shellTools 声明与 shellRow 的角色判定
    // When 比对声明与挂载
    // Then 声明的 shell 名唯一、且声明方在 shellRow 里挂了 bash
    // 2026-10-21 事故：shellTools 曾是 []——vendored 插件 apply 阶段直接抛
    // "must be a non-empty array"，研究员与它的委派预设双双「加载失败」。
    const boot = /const BOOTSTRAP[\s\S]*?\n    \}/.exec(source)?.[0] ?? ''
    const shells = Array.from(boot.matchAll(/shellTools:\s*\[([^\]]*)\]/g)).map(match => (match[1] ?? '').trim())
    expect(shells).toEqual(["'bash'"])
    expect(source).toContain("id === 'master' || id === 'instrument-researcher'")
    expect(source).toContain("name: '@deepseek-ai/dsh-tool-bash'")
  })

  it('管理员 行顺序：batch -> index -> surface -> bootstrap -> shell', () => {
    // Given plugins 行里的五个展开行
    // When 按源码出现顺序过滤出仍在的行
    // Then 顺序与声明的装配顺序一致
    const order = ['...batchRow', '...indexRow', '...surfaceRow', '...bootstrapRow', '...shellRow']
      .filter(row => plugins.includes(row))
    expect(order).toEqual(['...batchRow', '...indexRow', '...surfaceRow', '...bootstrapRow', '...shellRow'])
  })

  it('管理员：裁剪保持最小争议（用户明确「不用更激进」）', () => {
    // Given presets.ts 的 SURFACE 常量块
    // When 读取该块正文并检查裁剪口径
    // Then trader 只拒 tasks 族、master 不拒任何族，且没有具体工具级裁剪
    const block = /const SURFACE[^{]*\{([\s\S]*?)\n    \}/.exec(source)?.[1] ?? ''
    expect(block).toContain("trader: { denyFamilies: ['tasks'] }")
    expect(block).toContain("master: { denyFamilies: [] }")
    expect(source).not.toContain('denyTools:')
  })
})
