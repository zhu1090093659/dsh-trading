/**
 * 视图包内联矢量图标（shell icons.tsx 同款 outline 风格；只带本视图用到的）。
 */
import type { ReactElement } from 'react'

/** 放大镜搜索图标。 */
export function IconSearch({ size = 14 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6.5" cy="6.5" r="4.5" />
      <path d="M10 10l3.5 3.5" />
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