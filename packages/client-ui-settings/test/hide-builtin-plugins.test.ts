// @vitest-environment jsdom
/**
 * 官方「内置插件」分区入口的摘除守卫。
 *
 * 那条分区与本仓「插件」整页说的是同一件事（同一份插件列表两个入口），所以按导航项
 * 文案把它摘掉。用例钉住三点：文案命中才摘（不误伤别项）、设置弹层重开时新渲染的
 * 那条也摘、detach 后不再观察。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { hideBuiltinPluginsNav } from '../src/client/hide-builtin-plugins.js'

/** 造一块设置弹层：labels 按导航顺序排，返回按钮引用供断言。 */
function makeDialog(labels: readonly string[]): HTMLElement[] {
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const buttons = labels.map((label) => {
    const button = document.createElement('button')
    button.textContent = label
    dialog.append(button)
    return button
  })
  document.body.append(dialog)
  return buttons
}

describe('隐藏官方的内置插件分区入口', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('用户打开设置时只看见本仓的插件入口，官方那条被摘掉', () => {
    // Given 一块带官方与本仓两个插件入口的设置弹层
    const buttons = makeDialog(['账号与余额', '内置插件', '插件'])

    // When 分区挂载、摘除器开始工作
    const detach = hideBuiltinPluginsNav()

    // Then 官方那条不占位也不可读屏，本仓那条原样
    expect(buttons[1].style.display).toBe('none')
    expect(buttons[1].getAttribute('aria-hidden')).toBe('true')
    expect(buttons[2].style.display).toBe('')
    expect(buttons[2].getAttribute('aria-hidden')).toBeNull()
    detach()
  })

  it('用户重开设置弹层时新渲染的那条也被摘掉', async () => {
    // Given 摘除器先于设置弹层就位
    const detach = hideBuiltinPluginsNav()

    // When 弹层随后渲染出来
    const buttons = makeDialog(['内置插件', '插件'])
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })

    // Then 后插入的那条同样不占位
    expect(buttons[0].style.display).toBe('none')
    expect(buttons[1].style.display).toBe('')
    detach()
  })

  it('用户离开后摘除器停止观察，新入口不再被改写', async () => {
    // Given 一个已经停止的摘除器
    const detach = hideBuiltinPluginsNav()
    detach()

    // When 之后又渲染出官方那条
    const buttons = makeDialog(['内置插件'])

    // Then 没有被改写（detach 后不再观察）
    expect(buttons[0].style.display).toBe('')
  })
})
