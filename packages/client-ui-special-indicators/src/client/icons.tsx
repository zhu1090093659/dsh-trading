/**
 * 内联矢量图标：与宿主 outline 风格一致（16 格网格、currentColor 描边）。
 * 只用于表头排序指示——排序方向是状态而不是按钮文案，用图形比文字更省宽度。
 */
import type { ReactElement } from 'react'

/** 升序（由小到大）。 */
export function IconArrowUp({ size = 10 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 13V3.4" />
      <path d="M4.2 7.2 8 3.4l3.8 3.8" />
    </svg>
  )
}

/** 降序（由大到小）。 */
export function IconArrowDown({ size = 10 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v9.6" />
      <path d="M4.2 8.8 8 12.6l3.8-3.8" />
    </svg>
  )
}
