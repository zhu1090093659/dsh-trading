/**
 * 内联矢量图标：与宿主 outline 风格及富途牛牛紧凑图标保持一致。
 */
import type { ReactElement } from 'react'

/** 定时任务入口（时钟）。 */
export function IconClock({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75V8l2.4 1.6" />
    </svg>
  )
}

export function IconNewSession({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 5.4v5.2M5.4 8h5.2" />
    </svg>
  )
}

export function IconSettings({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.15 1.33h-0.29a1.33 1.33 0 0 0-1.33 1.33v0.12a1.33 1.33 0 0 1-0.67 1.15l-0.29 0.17a1.33 1.33 0 0 1-1.33 0l-0.1-0.05a1.33 1.33 0 0 0-1.82 0.49l-0.15 0.25a1.33 1.33 0 0 0 0.49 1.82l0.1 0.07a1.33 1.33 0 0 1 0.67 1.15v0.34a1.33 1.33 0 0 1-0.67 1.16l-0.1 0.06a1.33 1.33 0 0 0-0.49 1.82l0.15 0.25a1.33 1.33 0 0 0 1.82 0.49l0.1-0.05a1.33 1.33 0 0 1 1.33 0l0.29 0.17a1.33 1.33 0 0 1 0.67 1.15V13.33a1.33 1.33 0 0 0 1.33 1.33h0.29a1.33 1.33 0 0 0 1.33-1.33v-0.12a1.33 1.33 0 0 1 0.67-1.15l0.29-0.17a1.33 1.33 0 0 1 1.33 0l0.1 0.05a1.33 1.33 0 0 0 1.82-0.49l0.15-0.26a1.33 1.33 0 0 0-0.49-1.82l-0.1-0.05a1.33 1.33 0 0 1-0.67-1.16v-0.33a1.33 1.33 0 0 1 0.67-1.16l0.1-0.06a1.33 1.33 0 0 0 0.49-1.82l-0.15-0.25a1.33 1.33 0 0 0-1.82-0.49l-0.1 0.05a1.33 1.33 0 0 1-1.33 0l-0.29-0.17a1.33 1.33 0 0 1-0.67-1.15V2.67a1.33 1.33 0 0 0-1.33-1.33z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  )
}

/** 面板折叠/展开（左栏 panel 图标）。 */
export function IconFoldPanel({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2.75" width="12" height="10.5" rx="2" />
      <path d="M6.25 2.75v10.5" />
      <path d="M10.75 6.25 9 8l1.75 1.75" />
    </svg>
  )
}

/** 技术指标入口（坐标轴 + 折线）。 */
export function IconIndicators({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.75 2.75v10.5h10.5" />
      <path d="M5.25 9.5 7.5 6.75l2.25 1.75 2.75-3.5" />
    </svg>
  )
}

/** 发给 Agent（纸飞机）。 */
export function IconSend({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.75 2.25 7 9M13.75 2.25 9.5 13.75 7 9 2.25 6.5z" />
    </svg>
  )
}

/** 自选列表图标（富途左栏图标）。 */
export function IconWatchlist({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4h10M3 8h10M3 12h10" />
      <circle cx="1.5" cy="4" r="0.75" fill="currentColor" />
      <circle cx="1.5" cy="8" r="0.75" fill="currentColor" />
      <circle cx="1.5" cy="12" r="0.75" fill="currentColor" />
    </svg>
  )
}

/** 行情柱/图表图标。 */
export function IconQuotes({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 13V7M7 13V3M11 13V9M15 13V5" />
    </svg>
  )
}

/** 放大镜搜索图标。 */
export function IconSearch({ size = 14 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6.5" cy="6.5" r="4.5" />
      <path d="M10 10l3.5 3.5" />
    </svg>
  )
}

/** 下拉小箭头图标。 */
export function IconChevronDown({ size = 12 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}

/** 策略回测图表/仪表盘图标。 */
export function IconStrategy({ size = 32 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M7 16l3.5-4.5 3 3L17 9" />
      <circle cx="17" cy="9" r="1.2" fill="currentColor" />
    </svg>
  )
}

/** 行尾「更多操作」按钮（三个点）。 */
export function IconMore({ size = 14 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  )
}

/** 重命名（铅笔）。 */
export function IconRename({ size = 14 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 2.8a1.6 1.6 0 0 1 2.26 2.26l-8.3 8.3-3.1.84.84-3.1z" />
      <path d="M10.3 4.2l2.1 2.1" />
    </svg>
  )
}

/** 分叉会话（分支）。 */
export function IconFork({ size = 14 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      <circle cx="12" cy="5.5" r="1.75" />
      <path d="M4 5.25v5.5" />
      <path d="M12 7.25c0 2.5-3 2.5-5.5 3.9" />
    </svg>
  )
}

/** 归档会话（盒子+下移箭头）。 */
export function IconArchive({ size = 14 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="2.75" width="11" height="3" rx="0.75" />
      <path d="M3.5 5.75v6a1.25 1.25 0 0 0 1.25 1.25h6.5a1.25 1.25 0 0 0 1.25-1.25v-6" />
      <path d="M6.75 8.5h2.5" />
    </svg>
  )
}

/** 知识图谱网络图标。 */
export function IconKnowledge({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="5" r="2" />
      <circle cx="12" cy="5" r="2" />
      <circle cx="8" cy="12" r="2" />
      <path d="M5.5 6l4.5 4.5M10.5 6l-4.5 4.5M6 5h4" />
    </svg>
  )
}

/** 资产面板入口（钱包）。 */
export function IconWallet({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="12" height="9" rx="1.75" />
      <path d="M2 6.5h12" />
      <path d="M10.5 10.25h1.75" />
    </svg>
  )
}
