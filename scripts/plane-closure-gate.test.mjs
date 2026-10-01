/**
 * plane-closure-gate 纯函数自测。
 *
 * 三条规则都要证明"真的会红"：PC1/PC2 是 bot 平面的安装闭包判据（P1 步骤 4），
 * 门禁若坏成恒真，UI 依赖就会在下一次提交里悄悄回到 headless 服务器上。
 */
import { describe, expect, it } from 'vitest'
import { checkBotPlane, checkGuiPlane, closureOf, loadWorkspace } from './plane-closure-gate.mjs'

function manifestsOf(spec) {
  const map = new Map()
  for (const [name, dependencies] of Object.entries(spec)) map.set(name, { dir: name.replace('@dshtrading/', ''), dependencies })
  return map
}

describe('closureOf', () => {
  it('管理员：闭包沿 workspace 依赖递归，外部依赖单独收集', () => {
    // Given 一条 a → b → 外部 react 的链
    const manifests = manifestsOf({ '@dshtrading/a': { '@dshtrading/b': 'workspace:^' }, '@dshtrading/b': { react: '^18.0.0' } })
    // When 求 a 的闭包
    const closure = closureOf(manifests, ['@dshtrading/a'])
    // Then 内部含 a/b，外部含 react
    expect([...closure.internal].sort()).toEqual(['@dshtrading/a', '@dshtrading/b'])
    expect([...closure.external]).toEqual(['react'])
  })

  it('管理员：循环依赖不会死循环', () => {
    // Given a ↔ b 互相依赖
    const manifests = manifestsOf({ '@dshtrading/a': { '@dshtrading/b': 'workspace:^' }, '@dshtrading/b': { '@dshtrading/a': 'workspace:^' } })
    // When 求闭包
    const closure = closureOf(manifests, ['@dshtrading/a'])
    // Then 恰好两个包
    expect(closure.internal.size).toBe(2)
  })
})

describe('checkBotPlane（PC1 / PC2）', () => {
  it('管理员：闭包里出现 client-ui 包时报 PC1', () => {
    // Given 一个被 UI 包污染的闭包
    const closure = { internal: new Set(['@dshtrading/base', '@dshtrading/client-ui-trading']), external: new Set() }
    // When 检查 bot 平面
    const problems = checkBotPlane(closure)
    // Then 报 PC1
    expect(problems).toHaveLength(1)
    expect(problems[0].rule).toBe('PC1')
  })

  it('管理员：闭包里出现 UI 重依赖时报 PC2', () => {
    // Given 一个拖了渲染栈的闭包
    const closure = { internal: new Set(['@dshtrading/base']), external: new Set(['react', 'lightweight-charts']) }
    // When 检查 bot 平面
    const problems = checkBotPlane(closure)
    // Then 两条 PC2
    expect(problems).toHaveLength(2)
    expect(problems.every((p) => p.rule === 'PC2')).toBe(true)
  })

  it('管理员：干净闭包不报红', () => {
    // Given 只有 host 平面包的闭包
    const closure = { internal: new Set(['@dshtrading/base', '@dshtrading/api']), external: new Set(['yaml', '@deepseek-ai/cordis']) }
    // When 检查
    // Then 零问题
    expect(checkBotPlane(closure)).toEqual([])
  })
})

describe('checkGuiPlane（PC3）', () => {
  it('管理员：gui 闭包缺一个 UI 包时报 PC3', () => {
    // Given 少拆了一个包的 gui 闭包
    const closure = { internal: new Set(['@dshtrading/gui', '@dshtrading/client-ui-settings']), external: new Set() }
    // When 检查
    const problems = checkGuiPlane(closure)
    // Then 报 PC3 并列出缺失项
    expect(problems).toHaveLength(1)
    expect(problems[0].rule).toBe('PC3')
    expect(problems[0].detail).toContain('@dshtrading/dsh-i18n')
  })
})

describe('真实仓库（门禁不空转）', () => {
  it('管理员：真实仓库的 bot 平面闭包零 UI 包，gui 平面覆盖全部 UI 包', () => {
    // Given 真实 workspace 的依赖图
    const manifests = loadWorkspace()
    // When 求两个平面的闭包并检查
    const bot = closureOf(manifests, ['@dshtrading/base'])
    const gui = closureOf(manifests, ['@dshtrading/gui'])
    // Then 双向都干净，且规模成量级（防「解析器坏掉 → 空集合恒绿」）
    expect(checkBotPlane(bot)).toEqual([])
    expect(checkGuiPlane(gui)).toEqual([])
    expect(bot.internal.size).toBeGreaterThan(5)
    expect(gui.internal.size).toBeGreaterThan(bot.internal.size)
  })
})
