// @vitest-environment jsdom
/**
 * 插件分区（settings.section id 'dshtrading-plugins'）的行为守卫。
 *
 * 借壳控制器只做三件事：切官方整页、写矩形变量、写 body 标志。用例逐条钉住
 * 这三点，以及两条退化路径——layout 服务缺席、宿主没注册该面板——都必须落
 * 'unavailable' 而不是把分区留成空白（官方页不存在时用户要看见原因）。
 * jsdom 不做布局，getBoundingClientRect 恒为 0，故矩形断言取 '0px'。
 */
import { describe, expect, it } from 'vitest'
import { attachPluginHost, type PluginHostLayout } from '../src/client/plugins-host.js'
import { PluginsSection } from '../src/client/PluginsSection.js'
import { apply } from '../src/client/index.js'

/** body 标志（与 plugins-host.ts 的 HOST_FLAG 同值：分区状态唯一出口）。 */
const FLAG = 'dshtradingPluginHost'

/** 交易设置表单的最小替身：apply 只读它的快照面与 subscribe。 */
const SETTINGS_FORM = {
  getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: false }),
  subscribe: () => () => {},
  mutate: async () => true,
}

const HOST_VARS = [
  '--dshtrading-plugin-host-top',
  '--dshtrading-plugin-host-left',
  '--dshtrading-plugin-host-width',
  '--dshtrading-plugin-host-height',
] as const

/** 记录型 layout 替身：记下每次 selectPanel 的目标，可切到抛错形态。 */
function makeLayout(mode: 'ok' | 'throws' = 'ok') {
  const calls: (string | null)[] = []
  const layout: PluginHostLayout = {
    selectPanel(panelId) {
      calls.push(panelId)
      if (mode === 'throws') throw new Error('main key not registered')
    },
  }
  return { layout, calls }
}

function makeAnchor(): HTMLElement {
  const anchor = document.createElement('div')
  document.body.append(anchor)
  return anchor
}

/** jsdom 不做布局：矩形必须手工给（宿主真实 DOM 由浏览器算）。 */
function stubRect(target: HTMLElement, rect: Record<string, number>): void {
  Object.defineProperty(target, 'getBoundingClientRect', {
    value: () => ({
      top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
      toJSON: () => ({}),
      ...rect,
    }),
  })
}

/**
 * 设置壳替身：铺满视口的 overlay 里放一块全屏蒙层 + 一块 800x600 的弹层，
 * 分区容器挂在弹层里。遮罩与弹层的几何差异正是 findShellPanel 的判据。
 */
function makeShellPanel(anchor: HTMLElement): { panel: HTMLElement; overlay: HTMLElement } {
  const overlay = document.createElement('div')
  const mask = document.createElement('div')
  const panel = document.createElement('div')
  document.body.append(overlay)
  overlay.append(mask, panel)
  panel.append(anchor)
  const full = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, right: window.innerWidth, bottom: window.innerHeight }
  stubRect(overlay, full)
  stubRect(mask, full)
  stubRect(panel, { left: 400, top: 80, width: 800, height: 600, right: 1200, bottom: 680 })
  return { panel, overlay }
}

/** 记录型 client ctx：只实现本包 apply 触碰到的面。 */
function makeCtx() {
  const registrations: { name: string; options: Record<string, unknown>; component: unknown }[] = []
  const ctx = {
    locale: { bind: () => (key: string) => key, register: () => () => {} },
    effect: (fn: () => unknown) => { fn() },
    configForms: { get: () => SETTINGS_FORM },
    slots: {
      inject: (_name: string, factory: () => unknown) => factory(),
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ name: String(options.name), options, component })
        return () => {}
      },
    },
    get: () => undefined,
  }
  return { ctx, registrations }
}

describe('attachPluginHost（官方插件整页借壳到分区矩形）', () => {
  it('用户打开插件分区时看到官方整页被选中，矩形变量与 on 标志同时落位', () => {
    // Given 一个可用的 layout 服务与一块分区容器
    const { layout, calls } = makeLayout()
    const anchor = makeAnchor()

    // When 分区挂载，借壳打开
    const handle = attachPluginHost(anchor, () => layout)

    // Then 官方整页被选中，四个矩形变量写入，身体标志为 on
    expect(calls).toEqual(['plugins'])
    expect(document.body.dataset[FLAG]).toBe('on')
    for (const name of HOST_VARS) {
      expect(document.body.style.getPropertyValue(name)).toBe('0px')
    }
    handle.detach()
  })

  it('用户离开插件分区后主面板回到会话，标志与矩形变量全部清掉', () => {
    // Given 一个已经打开的借壳分区
    const { layout, calls } = makeLayout()
    const anchor = makeAnchor()
    const handle = attachPluginHost(anchor, () => layout)

    // When 用户切走（分区卸载）
    handle.detach()

    // Then 主面板回到会话，标志与变量不留下残影
    expect(calls).toEqual(['plugins', null])
    expect(document.body.dataset[FLAG]).toBeUndefined()
    for (const name of HOST_VARS) {
      expect(document.body.style.getPropertyValue(name)).toBe('')
    }
  })

  it('用户在宿主没有 layout 服务时看到分区落成不可用态而不是空白', () => {
    // Given 一个取不到 layout 服务的宿主
    const anchor = makeAnchor()

    // When 分区挂载
    const handle = attachPluginHost(anchor, () => undefined)

    // Then 身体标志为 unavailable，矩形变量一个都不写
    expect(document.body.dataset[FLAG]).toBe('unavailable')
    expect(document.body.style.getPropertyValue('--dshtrading-plugin-host-top')).toBe('')
    handle.detach()
  })

  it('用户在宿主没注册该插件面板时看到分区落成不可用态', () => {
    // Given 一个选中即抛错的 layout（main key 未注册）
    const { layout } = makeLayout('throws')
    const anchor = makeAnchor()

    // When 分区挂载
    const handle = attachPluginHost(anchor, () => layout)

    // Then 身体标志为 unavailable，分区不进入借壳态
    expect(document.body.dataset[FLAG]).toBe('unavailable')
    expect(document.body.style.getPropertyValue('--dshtrading-plugin-host-width')).toBe('')
    handle.detach()
  })
})

describe('设置壳面板放宽（借壳矩形之外，官方页还需要一个够宽的容器）', () => {
  it('用户在设置里打开插件分区时宿主面板被放宽，离开后标记撤掉', () => {
    // Given 分区块挂在设置壳的弹层里（外层 overlay 铺满视口，里面还有一块蒙层）
    const { layout } = makeLayout()
    const anchor = makeAnchor()
    const { panel, overlay } = makeShellPanel(anchor)

    // When 分区挂载
    const handle = attachPluginHost(anchor, () => layout)

    // Then 放宽标记落在弹层上，而不是 overlay 或蒙层
    expect(panel.hasAttribute('data-dshtrading-plugin-host-panel')).toBe(true)
    expect(overlay.hasAttribute('data-dshtrading-plugin-host-panel')).toBe(false)

    // And 借壳矩形铺到弹层右缘而不是只覆盖内容列（1200 / 680 减 24 留白）
    expect(document.body.style.getPropertyValue('--dshtrading-plugin-host-width')).toBe('1176px')
    expect(document.body.style.getPropertyValue('--dshtrading-plugin-host-height')).toBe('656px')

    // And 用户离开后标记撤掉，面板回到官方宽度
    handle.detach()
    expect(panel.hasAttribute('data-dshtrading-plugin-host-panel')).toBe(false)
  })

  it('用户在普通容器里打开插件分区时不放宽任何祖先（找不到设置壳面板就按原矩形显示）', () => {
    // Given 一块没有设置壳面板祖先的分区容器
    const { layout } = makeLayout()
    const anchor = makeAnchor()

    // When 分区挂载
    const handle = attachPluginHost(anchor, () => layout)

    // Then 没有任何元素被标记为放宽，借壳照常生效
    expect(document.querySelectorAll('[data-dshtrading-plugin-host-panel]').length).toBe(0)
    expect(document.body.dataset[FLAG]).toBe('on')
    handle.detach()
  })
})

describe('插件分区注册面（settings.section）', () => {
  it('用户能在设置里看到独立的插件分区，order 15 且标签取自插件词典', () => {
    // Given 一个记录型 client ctx
    const { ctx, registrations } = makeCtx()

    // When 执行本包 client apply
    apply(ctx as never)

    // Then 注册了独立 id 的 settings.section，组件是 PluginsSection
    const section = registrations.find(
      (entry) => entry.name === 'settings.section' && entry.options.id === 'dshtrading-plugins',
    )
    expect(section).toBeDefined()
    expect(section?.options.order).toBe(15)
    expect(typeof section?.options.label).toBe('function')
    expect(section?.component).toBe(PluginsSection)
  })

  it('用户看到的插件分区 id 与官方 settings-plugins 的 plugins 不撞名（同优先级重复注册会抛错）', () => {
    // Given 一个记录型 client ctx
    const { ctx, registrations } = makeCtx()

    // When 执行本包 client apply
    apply(ctx as never)

    // Then 分区 id 是 dshtrading-plugins，没有占用官方的 plugins
    const ids = registrations
      .filter((entry) => entry.name === 'settings.section')
      .map((entry) => entry.options.id)
    expect(ids).toContain('dshtrading-plugins')
    expect(ids).not.toContain('plugins')
  })
})
