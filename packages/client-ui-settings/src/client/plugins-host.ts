/**
 * 官方插件管理页的借壳控制器：不改官方那张页的任何代码，只把它换到一个
 * 我们给的矩形里显示。
 *
 * 官方整页注册在 layout 的 `main` keyed 槽（key = 'plugins'），选中全局面板
 * 时宿主给主面板写 `[data-global-panel]`（client-ui-layout：
 * "data-global-panel": panelId !== null || void 0）。定位规则全部在
 * plugins-host.module.css，本模块只写 body 标志与四个 CSS 变量——官方页的
 * DOM、状态与交互原样不动。
 *
 * 打开失败（宿主没注册该面板、或访问门控关掉了整页）记
 * body[data-dshtrading-plugin-host='unavailable']，分区退化为说明文案。
 */

/** layout 服务在本模块用到的最小面（ctx.layout，见 client-ui-layout service.d.ts）。 */
export interface PluginHostLayout {
  /** 选中全局中央面板；null 回到当前会话。未注册的 key 会抛错。 */
  selectPanel(panelId: string | null): void
}

/** 官方插件管理整页的 main 槽 key（client-ui-plugin-manager 的 PANEL_ID）。 */
export const PLUGIN_PANEL_ID = 'plugins'

/** body 上的状态标志：on 表示官方页已钉进分区矩形。 */
const HOST_FLAG = 'dshtradingPluginHost'

/** 借壳矩形变量（plugins-host.module.css 消费）。 */
const VARS = {
  top: '--dshtrading-plugin-host-top',
  left: '--dshtrading-plugin-host-left',
  width: '--dshtrading-plugin-host-width',
  height: '--dshtrading-plugin-host-height',
} as const

/** 钉住期间的句柄：detach 幂等，卸载时务必调用。 */
export interface PluginHostHandle {
  detach(): void
}

/** 设置壳面板标记：借壳态放宽它的宽度（plugins-section.module.css 消费）。 */
const PANEL_ATTR = 'data-dshtrading-plugin-host-panel'

/** 设置壳面板的最小宽度：低于它的祖先不是那块 panel（内容区与导航都更窄）。 */
const PANEL_MIN_WIDTH = 600

/** 借壳矩形与面板边缘的间距（与设置壳自身的内容留白同款）。 */
const PANEL_INSET = 24

/**
 * 找设置壳的弹层元素（overlay 里那块真的面板，不是 overlay、也不是蒙层）。
 *
 * 借壳矩形只是它的内容区，而官方插件页是列表 + 对话框形态，窄容器里工具栏会
 * 收缩成图标。两层判据分开，是因为改错对象会立刻露馅：改 overlay 的宽度会让
 * 弹层在自己的容器里重新居中而整体偏左，改一个 static 中间层会让弹层宽过视口
 * 而溢出（两种都实测过）。所以先锁铺满视口的 overlay，再取它里面最宽的、
 * 且自身没铺满视口的子元素——蒙层的宽高都等于 overlay，按这条被排除。
 * 找不到就当没有，分区按原矩形显示。
 */
function findShellPanel(anchor: HTMLElement): HTMLElement | undefined {
  let node = anchor.parentElement
  let overlay: HTMLElement | undefined
  for (let depth = 0; node !== null && depth < 8; depth += 1) {
    const rect = node.getBoundingClientRect()
    if (rect.width >= window.innerWidth - 1 && rect.height >= window.innerHeight - 1) {
      overlay = node
      break
    }
    node = node.parentElement
  }
  if (overlay === undefined) return undefined

  const overlayRect = overlay.getBoundingClientRect()
  let panel: HTMLElement | undefined
  let widest = 0
  for (const child of Array.from(overlay.children)) {
    if (!(child instanceof HTMLElement)) continue
    const rect = child.getBoundingClientRect()
    if (rect.width >= overlayRect.width - 1 && rect.height >= overlayRect.height - 1) continue
    if (rect.width < PANEL_MIN_WIDTH || rect.width <= widest) continue
    panel = child
    widest = rect.width
  }
  return panel
}

/** 官方整页在 layout 里的 DOM 锚点：选中全局面板时宿主写这个属性。 */
const PANEL_SELECTOR = '[data-global-panel]'

/**
 * 等官方页出现的默认上限。官方页是懒加载的，首帧要下载并解析它自己的 client
 * bundle；超过这个时间还没进 DOM，分区给用户一条可重试的说明，而不是无限转圈。
 */
export const PANEL_TIMEOUT_MS = 8000

/** 官方页是否已经在 DOM 里（借壳定位 CSS 依赖这个节点）。 */
export function pluginPanelPresent(root: ParentNode = document): boolean {
  return root.querySelector(PANEL_SELECTOR) !== null
}

/** 被抬升的官方弹层容器标记（只在借壳期间存在）。 */
const RAISED_ATTR = 'data-dshtrading-plugin-layer'

/** 借壳面板写在 `[data-global-panel]` 上的层叠值（见 plugins-section.module.css）。 */
const PANEL_Z = 1001

/** 抬升后的层叠值：官方弹层必须盖在面板内容之上。 */
const RAISED_Z = 1002

/**
 * 把官方插件管理器的弹层容器抬到借壳面板之上。
 *
 * 官方把弹层渲染在自己那块 `position: fixed` 的容器里（z 低于借壳写在主面板上的
 * 1001），借壳后弹层被插件页内容整块盖住——点「添加插件」看着没反应，其实弹层已经
 * 开了。借壳期间按「body 直接子元素里出现 dialog 且自身是 fixed 且 z 低于面板」抬到
 * 1002，detach 时还原。判据不认类名（官方 CSS 哈希会变），只认结构。
 */
export function raisePluginDialogLayers(): () => void {
  const sweep = (): void => {
    for (const layer of Array.from(document.body.children)) {
      if (!(layer instanceof HTMLElement)) continue
      if (layer.hasAttribute(RAISED_ATTR)) continue
      if (layer.querySelector('[role="dialog"]') === null) continue
      const style = getComputedStyle(layer)
      if (style.position !== 'fixed') continue
      const z = Number.parseInt(style.zIndex, 10)
      if (!Number.isFinite(z) || z >= PANEL_Z) continue
      layer.style.zIndex = String(RAISED_Z)
      layer.setAttribute(RAISED_ATTR, '')
    }
  }
  const observer = new MutationObserver(sweep)
  observer.observe(document.body, { childList: true, subtree: true })
  sweep()
  return () => {
    observer.disconnect()
    for (const layer of Array.from(document.querySelectorAll(`[${RAISED_ATTR}]`))) {
      if (!(layer instanceof HTMLElement)) continue
      layer.style.removeProperty('z-index')
      layer.removeAttribute(RAISED_ATTR)
    }
  }
}

/** 等待句柄：cancel 之后不再回报任何状态。 */
export interface PanelWaitHandle {
  cancel(): void
}

/**
 * 等官方整页进 DOM：出现即回 'on'；到点仍未出现回 'timeout'，之后迟到再回 'on'
 * —— 迟到的页面照样接管分区，用户不必自己重开。
 */
export function waitForPluginPanel(
  onState: (state: 'on' | 'timeout') => void,
  options: { timeoutMs?: number; root?: ParentNode } = {},
): PanelWaitHandle {
  const root = options.root ?? document
  const timeoutMs = options.timeoutMs ?? PANEL_TIMEOUT_MS
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const report = (state: 'on' | 'timeout'): void => {
    if (settled) return
    if (state === 'on') settled = true
    onState(state)
  }
  if (pluginPanelPresent(root)) {
    report('on')
    return { cancel() { settled = true } }
  }
  const observer = new MutationObserver(() => {
    if (!pluginPanelPresent(root)) return
    observer.disconnect()
    if (timer !== undefined) clearTimeout(timer)
    report('on')
  })
  observer.observe(document.body, { childList: true, subtree: true })
  timer = setTimeout(() => {
    timer = undefined
    // 观察者留着：官方页迟到的那一次仍然接管分区，用户不必自己重开。
    report('timeout')
  }, timeoutMs)
  return {
    cancel() {
      settled = true
      observer.disconnect()
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/**
 * 把官方插件管理页钉进 `anchor` 的矩形。
 *
 * @param anchor - 分区里承载它的容器（测量源，不参与官方页的 DOM 结构）
 * @param getLayout - 惰性解析 layout 服务（apply 时序不保证，与 uiWorkspace 同款纪律）
 * @returns 解除句柄；打开失败时句柄只负责清标志
 */
export function attachPluginHost(
  anchor: HTMLElement,
  getLayout: () => PluginHostLayout | undefined,
): PluginHostHandle {
  const style = document.body.style
  // 设置壳的内容列有固定宽度（实测 1600 视口下面板放到 1200、内容列仍只有 564），
  // 官方插件页要铺到面板右缘：矩形以分区容器的左上角为起点、以面板边界为右下界。
  const panel = findShellPanel(anchor)
  const write = (): void => {
    const rect = anchor.getBoundingClientRect()
    const bounds = panel?.getBoundingClientRect()
    const right = bounds === undefined ? rect.right : bounds.right - PANEL_INSET
    const bottom = bounds === undefined ? rect.bottom : bounds.bottom - PANEL_INSET
    style.setProperty(VARS.top, `${Math.round(rect.top)}px`)
    style.setProperty(VARS.left, `${Math.round(rect.left)}px`)
    style.setProperty(VARS.width, `${Math.round(right - rect.left)}px`)
    style.setProperty(VARS.height, `${Math.round(bottom - rect.top)}px`)
  }

  let observer: ResizeObserver | undefined
  let unraise: (() => void) | undefined
  const detach = (): void => {
    unraise?.()
    unraise = undefined
    observer?.disconnect()
    observer = undefined
    window.removeEventListener('resize', write)
    document.querySelectorAll(`[${PANEL_ATTR}]`).forEach((panel) => panel.removeAttribute(PANEL_ATTR))
    delete document.body.dataset[HOST_FLAG]
    for (const name of Object.values(VARS)) style.removeProperty(name)
    try {
      getLayout()?.selectPanel(null)
    } catch { /* 宿主已卸载该面板：回到会话的兜底由主面板自身状态决定 */ }
  }

  const layout = getLayout()
  if (layout === undefined) {
    document.body.dataset[HOST_FLAG] = 'unavailable'
    return { detach }
  }
  try {
    layout.selectPanel(PLUGIN_PANEL_ID)
  } catch {
    document.body.dataset[HOST_FLAG] = 'unavailable'
    return { detach }
  }

  // 先放宽面板再测量：宽度一变矩形跟着变，测量必须落在它之后。
  panel?.setAttribute(PANEL_ATTR, '')
  write()
  document.body.dataset[HOST_FLAG] = 'on'
  unraise = raisePluginDialogLayers()
  // 无 ResizeObserver 的环境（SSR 探针、jsdom）只靠首帧与 resize 事件跟随。
  observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(write)
  observer?.observe(anchor)
  window.addEventListener('resize', write)
  // 设置壳开合/滚动会改矩形，锚点自身尺寸不变，故再跟一帧。
  requestAnimationFrame(write)
  return { detach }
}
