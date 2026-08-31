/**
 * 内联矢量图标：与宿主 outline 风格及富途牛牛紧凑图标保持一致。
 */
import type { ReactElement } from 'react'

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
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
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
