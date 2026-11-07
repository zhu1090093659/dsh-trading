// @vitest-environment jsdom
/**
 * 插件分区（settings.section id 'dshtrading-plugins'）的行为守卫。
 *
 * 借壳控制器只做三件事：切官方整页、写矩形变量、写 body 标志。用例逐条钉住
 * 这三点，以及两条退化路径——layout 服务缺席、宿主没注册该面板——都必须落
 * 'unavailable' 而不是把分区留成空白（官方页不存在时用户要看见原因）。
 * jsdom 不做布局，getBoundingClientRect 恒为 0，故矩形断言取 '0px'。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachPluginHost, waitForPluginPanel, type PluginHostLayout } from '../src/client/plugins-host.js'
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
 * 分区容器挂在弹层里；借壳矩形取分区自身几何，不再依赖弹层/蒙层的几何差异。
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

describe('借壳矩形（与其它设置分区同宽）', () => {
  it('用户在设置里打开插件分区时矩形就是分区自身，不放宽任何祖先', () => {
    // Given 分区块挂在设置壳的弹层里（外层 overlay 铺满视口，里面还有一块蒙层），分区有真实尺寸
    const { layout } = makeLayout()
    const anchor = makeAnchor()
    makeShellPanel(anchor)
    stubRect(anchor, { left: 300, top: 100, width: 800, height: 600, right: 1100, bottom: 700 })

    // When 分区挂载
    const handle = attachPluginHost(anchor, () => layout)

    // Then 矩形取分区自己的几何，没有被撑到弹层右缘
    expect(document.body.style.getPropertyValue('--dshtrading-plugin-host-left')).toBe('300px')
    expect(document.body.style.getPropertyValue('--dshtrading-plugin-host-top')).toBe('100px')
    expect(document.body.style.getPropertyValue('--dshtrading-plugin-host-width')).toBe('800px')
    expect(document.body.style.getPropertyValue('--dshtrading-plugin-host-height')).toBe('600px')

    // And 设置壳面板不被加任何放宽标记
    expect(document.querySelectorAll('[data-dshtrading-plugin-host-panel]').length).toBe(0)
    handle.detach()
  })
})

describe('等待官方页（慢与坏要分得开）', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const node of document.querySelectorAll('[data-global-panel]')) node.remove()
  })

  /** 造一个官方整页的锚点节点（layout 选中全局面板时宿主写的就是这个属性）；带文本才算就位。 */
  function insertPanel(text = '插件管理'): void {
    const panel = document.createElement('div')
    panel.setAttribute('data-global-panel', '')
    panel.textContent = text
    document.body.append(panel)
  }

  it('用户打开分区时官方页已经在 DOM 里，等待立即结束', () => {
    // Given 官方页已经进 DOM
    insertPanel()
    const seen: string[] = []

    // When 分区开始等它
    const handle = waitForPluginPanel((state) => seen.push(state))

    // Then 立刻报就位，不再等超时
    expect(seen).toEqual(['on'])
    handle.cancel()
  })

  it('用户等到官方页加载完成时等待结束，到点不再报超时', async () => {
    // Given 一个在等的分区（上限 1s）
    vi.useFakeTimers()
    const seen: string[] = []
    const handle = waitForPluginPanel((state) => seen.push(state), { timeoutMs: 1000 })
    expect(seen).toEqual([])

    // When 官方页在超时前出现
    insertPanel()
    await vi.advanceTimersByTimeAsync(0)

    // Then 报就位，且到点不再报超时
    expect(seen).toEqual(['on'])
    await vi.advanceTimersByTimeAsync(2000)
    expect(seen).toEqual(['on'])
    handle.cancel()
  })

  it('用户等满超时仍未见到官方页时看到可重试的说明，页面迟到仍接管分区', async () => {
    // Given 一个在等的分区（上限 1s）
    vi.useFakeTimers()
    const seen: string[] = []
    const handle = waitForPluginPanel((state) => seen.push(state), { timeoutMs: 1000 })

    // When 到点官方页还没来
    await vi.advanceTimersByTimeAsync(1000)

    // Then 分区拿到超时状态（用户可重试）
    expect(seen).toEqual(['timeout'])

    // And 官方页迟到时仍接管分区，用户不必重开
    insertPanel()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual(['timeout', 'on'])
    handle.cancel()
  })

  it('用户离开分区后等待句柄不再回报任何状态', async () => {
    // Given 一个在等的分区
    vi.useFakeTimers()
    const seen: string[] = []
    const handle = waitForPluginPanel((state) => seen.push(state), { timeoutMs: 1000 })

    // When 分区卸载
    handle.cancel()
    await vi.advanceTimersByTimeAsync(2000)

    // Then 既不报超时也不报就位
    expect(seen).toEqual([])
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
