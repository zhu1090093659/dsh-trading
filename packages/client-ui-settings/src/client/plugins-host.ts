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
  const write = (): void => {
    const rect = anchor.getBoundingClientRect()
    style.setProperty(VARS.top, `${Math.round(rect.top)}px`)
    style.setProperty(VARS.left, `${Math.round(rect.left)}px`)
    style.setProperty(VARS.width, `${Math.round(rect.width)}px`)
    style.setProperty(VARS.height, `${Math.round(rect.height)}px`)
  }

  let observer: ResizeObserver | undefined
  const detach = (): void => {
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
  // 无 ResizeObserver 的环境（SSR 探针、jsdom）只靠首帧与 resize 事件跟随。
  observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(write)
  observer?.observe(anchor)
  window.addEventListener('resize', write)
  // 设置壳开合/滚动会改矩形，锚点自身尺寸不变，故再跟一帧。
  requestAnimationFrame(write)
  return { detach }
}
