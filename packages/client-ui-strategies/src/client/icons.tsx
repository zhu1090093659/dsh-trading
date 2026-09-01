/**
 * 视图包内联矢量图标（shell icons.tsx 同款 outline 风格；只带本视图用到的）。
 */
import type { ReactElement } from 'react'

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