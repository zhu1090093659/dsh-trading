// @vitest-environment jsdom
/**
 * 官方弹层容器抬升的守卫。
 *
 * 官方把插件管理的弹层渲染在自己那块 `position: fixed` 的容器里（z 低于借壳写在主面板
 * 上的 1001），借壳后弹层被页面内容盖住——点「添加插件」看着没反应。用例钉住三点：
 * 认结构不认类名（body 直接子元素 + 内含 dialog + fixed + z 低于面板）、已经够高的
 * 容器不动、detach 还原。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { raisePluginDialogLayers } from '../src/client/plugins-host.js'

/** 造一块 body 直接子元素充当官方弹层容器。 */
function makeLayer(options: { position?: string; zIndex?: string; withDialog?: boolean } = {}): HTMLElement {
  const layer = document.createElement('div')
  layer.style.position = options.position ?? 'fixed'
  if (options.zIndex !== undefined) layer.style.zIndex = options.zIndex
  if (options.withDialog !== false) {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    layer.append(dialog)
  }
  document.body.append(layer)
  return layer
}

describe('抬升官方插件弹层容器', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('用户点添加插件时，弹层容器被抬到借壳面板之上', () => {
    // Given 一块 z 低于面板的官方弹层容器
    const layer = makeLayer({ zIndex: '1000' })

    // When 借壳开始、抬升器就位
    const detach = raisePluginDialogLayers()

    // Then 它被抬到 1200 并带标记
    expect(layer.style.zIndex).toBe('1200')
    expect(layer.hasAttribute('data-dshtrading-plugin-layer')).toBe(true)
    detach()
  })

  it('用户离开插件分区后容器的层叠值被还原', () => {
    // Given 一块已被抬升的容器
    const layer = makeLayer({ zIndex: '1000' })
    const detach = raisePluginDialogLayers()
    expect(layer.style.zIndex).toBe('1200')

    // When 借壳结束
    detach()

    // Then 内联值与标记都撤掉，官方自己的 z 回位
    expect(layer.style.zIndex).toBe('')
    expect(layer.hasAttribute('data-dshtrading-plugin-layer')).toBe(false)
  })

  it('用户看到的设置壳遮罩不会被抬：它含分区锚点，抬它会把借壳面板盖住', () => {
    // Given 一块含分区锚点的 fixed 容器（设置壳 overlay，z 低于借壳面板）
    const layer = makeLayer({ zIndex: '1000' })
    const anchor = document.createElement('div')
    anchor.setAttribute('data-dshtrading-plugin-anchor', '')
    layer.append(anchor)

    // When 抬升器就位
    const detach = raisePluginDialogLayers()

    // Then 它保持原层级，也不带抬升标记
    expect(layer.style.zIndex).toBe('1000')
    expect(layer.hasAttribute('data-dshtrading-plugin-layer')).toBe(false)
    detach()
  })

  it('用户看到的不是弹层容器时不动它：缺 dialog 或层叠已经够高的都不抬', () => {
    // Given 一块没有 dialog 的 fixed 容器和一块 z 已高于面板的弹层容器
    const plain = makeLayer({ zIndex: '900', withDialog: false })
    const high = makeLayer({ zIndex: '1200' })

    // When 抬升器就位
    const detach = raisePluginDialogLayers()

    // Then 两块都保持原样
    expect(plain.style.zIndex).toBe('900')
    expect(high.style.zIndex).toBe('1200')
    detach()
  })
})
