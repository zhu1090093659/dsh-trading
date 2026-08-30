/**
 * 内联矢量图标（2.7）：与宿主 @deepseek-ai/dsh-client-ui-primitives 的
 * outline 风格保持一致（16px 线宽 stroke、currentColor）。不直接 import
 * primitives——插件包解析不到其类型，内联同样的路径更纯粹。
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

/** 面板折叠/展开（左栏在左的 panel 图标方向，与宿主 IconPanelLeft 同语义）。 */
export function IconFoldPanel({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2.75" width="12" height="10.5" rx="2" />
      <path d="M6.25 2.75v10.5" />
      <path d="M10.75 6.25 9 8l1.75 1.75" />
    </svg>
  )
}

/** 技术指标入口（OKX 式 chart-line 图标语义：坐标轴 + 折线）。 */
export function IconIndicators({ size = 16 }: { size?: number }): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.75 2.75v10.5h10.5" />
      <path d="M5.25 9.5 7.5 6.75l2.25 1.75 2.75-3.5" />
    </svg>
  )
}
