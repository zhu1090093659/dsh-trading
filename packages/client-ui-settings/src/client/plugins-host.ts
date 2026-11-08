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

/** 官方整页在 layout 里的 DOM 锚点：选中全局面板时宿主写这个属性。 */
const PANEL_SELECTOR = '[data-global-panel]'

/**
 * 等官方页出现的默认上限。官方页是懒加载的，首帧要下载并解析它自己的 client
 * bundle；超过这个时间还没进 DOM，分区给用户一条可重试的说明，而不是无限转圈。
 */
export const PANEL_TIMEOUT_MS = 8000

/**
 * 官方页是否已经渲染出内容。
 *
 * 只看节点存在不够：面板先挂一个空壳，此时把说明文案撤掉，用户看到的就是一块空白
 * （2026-11-07 用户实机截图）。有文本才算就位——骨架屏也有文本，比空白好。
 */
export function pluginPanelReady(root: ParentNode = document): boolean {
  const panel = root.querySelector(PANEL_SELECTOR)
  if (panel === null) return false
  return (panel.textContent ?? '').trim().length > 0
}

/**
 * 官方页此刻是否真的占着布局盒。
 *
 * 有文本也不够：面板寄居在会话列的主面板里，交易壳折叠会话列（规则 9）或打开六个
 * 覆盖面页签（规则 11-16）时整块失去布局盒——textContent 照旧，矩形却是 0×0，
 * 分区于是空白且没有任何说明（2026-11-08 实机两种状态都复现）。借壳期例外规则在
 * shell-pad.css 17 号把布局盒还回来，这里只做判定：拿不到盒子就不算就位。
 */
export function pluginPanelShown(root: ParentNode = document): boolean {
  const panel = root.querySelector(PANEL_SELECTOR)
  if (panel === null) return false
  const rect = panel.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/** 被抬升的官方弹层容器标记（只在借壳期间存在）。 */
const RAISED_ATTR = 'data-dshtrading-plugin-layer'

/** 借壳面板写在 `[data-global-panel]` 上的层叠值（见 plugins-section.module.css）。
 *  必须高于设置壳自己的 overlay（1000）：低一个数量级就会被整块盖住，分区露出空白。 */
const PANEL_Z = 1100

/** 抬升后的层叠值：官方弹层必须盖在面板内容之上。 */
const RAISED_Z = 1200

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
      // 含分区锚点的容器是设置壳自己的 overlay：抬它就是把借壳面板整块盖住。
      if (layer.querySelector('[data-dshtrading-plugin-anchor]') !== null) continue
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

/** 等待的三种结论：就位、有内容但被布局遮住、始终没来。 */
export type PanelWaitState = 'on' | 'blocked' | 'timeout'

/**
 * 等官方整页就位：有内容且占着布局盒回 'on'；到点仍不见页面回 'timeout'，页面在
 * 而布局盒没了回 'blocked'——慢、坏、被遮三种情形用户都要看得懂，不能都是一块
 * 空白。此后迟到的页面或恢复的布局盒照样接管分区，用户不必自己重开。
 */
export function waitForPluginPanel(
  onState: (state: PanelWaitState) => void,
  options: { timeoutMs?: number; root?: ParentNode } = {},
): PanelWaitHandle {
  const root = options.root ?? document
  const timeoutMs = options.timeoutMs ?? PANEL_TIMEOUT_MS
  let last: PanelWaitState | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = (state: PanelWaitState): void => {
    if (state === last) return
    last = state
    onState(state)
  }
  // 只有"有内容且占着盒子"才撤说明文案：有内容没盒子留到超时点再判定，免得弹层
  // 开场动画的那几帧把分区误判成被遮。
  const evaluate = (): void => {
    if (!pluginPanelReady(root)) return
    if (!pluginPanelShown(root)) return
    publish('on')
  }
  // characterData：官方页可能先挂空壳、随后只改文本，不产生新的子树。
  const content = new MutationObserver(evaluate)
  content.observe(document.body, { childList: true, subtree: true, characterData: true })
  // 布局盒是被 body 状态属性（折叠会话列 / 六个覆盖面页签）拿走的：属性一变就重判。
  const layout = new MutationObserver(evaluate)
  layout.observe(document.body, { attributes: true })
  // 窗口尺寸变化同样会改布局盒（极小窗口、折叠后拖宽），一并重判。
  window.addEventListener('resize', evaluate)
  evaluate()
  timer = setTimeout(() => {
    timer = undefined
    // 观察者留着：官方页迟到的那一次仍然接管分区，用户不必自己重开。
    if (!pluginPanelReady(root)) publish('timeout')
    else if (!pluginPanelShown(root)) publish('blocked')
  }, timeoutMs)
  return {
    cancel() {
      content.disconnect()
      layout.disconnect()
      window.removeEventListener('resize', evaluate)
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
  // 矩形就是分区自己的矩形：插件分区与其它分区同宽（2026-11-07 用户口径），
  // 不再放宽设置壳面板，也不铺到面板右缘。
  const write = (): void => {
    const rect = anchor.getBoundingClientRect()
    style.setProperty(VARS.top, `${Math.round(rect.top)}px`)
    style.setProperty(VARS.left, `${Math.round(rect.left)}px`)
    style.setProperty(VARS.width, `${Math.round(rect.width)}px`)
    style.setProperty(VARS.height, `${Math.round(rect.height)}px`)
  }

  let observer: ResizeObserver | undefined
  let unraise: (() => void) | undefined
  const detach = (): void => {
    unraise?.()
    unraise = undefined
    observer?.disconnect()
    observer = undefined
    window.removeEventListener('resize', write)
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
