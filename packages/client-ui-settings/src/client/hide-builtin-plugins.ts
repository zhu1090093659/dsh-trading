/**
 * 摘掉设置壳里官方的「内置插件」分区入口。
 *
 * 那条分区（官方 settings.section id `plugins`，只读清单）与本仓「插件」分区
 * （官方插件管理整页的借壳）说的是同一件事：用户在同一份插件列表前有两个入口，
 * 分不清该点哪个。宿主没有提供"卸载某个 section"的面，所以在 DOM 层按导航项文案
 * 摘掉它。
 *
 * 判据用文案而不是结构或顺序：官方调整分区顺序、增删分区都不会误伤别的入口；
 * 最坏情况是文案改名导致没摘掉（多一个入口），而不是隐藏错项。作用域限定在设置
 * 弹层里的按钮，不碰页面其它位置；新开一次设置弹层会被 MutationObserver 继续摘。
 */
const LEGACY_LABELS: ReadonlySet<string> = new Set(['内置插件', 'Built-in plugins']) // i18n-allow: 宿主导航项的文案，用来识别那条分区，不是本包展示的字符串
const NAV_SELECTOR = '[role="dialog"] button'

/** 开始摘；返回 detach（停止观察，已摘掉的项不回滚——分区重开时会重新摘）。 */
export function hideBuiltinPluginsNav(): () => void {
  const sweep = (): void => {
    for (const node of Array.from(document.querySelectorAll<HTMLElement>(NAV_SELECTOR))) {
      if (!LEGACY_LABELS.has(node.textContent?.trim() ?? '')) continue
      node.style.display = 'none'
      node.setAttribute('aria-hidden', 'true')
    }
  }
  const observer = new MutationObserver(sweep)
  observer.observe(document.body, { childList: true, subtree: true })
  sweep()
  return () => observer.disconnect()
}
