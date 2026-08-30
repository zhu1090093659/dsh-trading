/**
 * 中栏行情面板（2.4 定稿：中栏恒为行情，对话常驻右侧栏）：
 * 几何 = [自选停靠右缘, 对话列/会话浏览器左缘] 之间的整块区域，
 * 内容复用 QuoteStage。
 *
 * 对话列显隐由「是否有当前会话」驱动（官方会话 UI 整列移到右侧，
 * 审批卡在 composer 链随列可见，无会话时不存在可审批请求）：
 * 本组件把该状态写到 body[data-dshtrading-chat]，shell-pad.css 据此
 * 展开/收起栅格第 2 轨道（对话列）。
 *
 * 几何测量：frame（div:has(> [data-shell-overlay])，rtl 后子元素顺序
 * [会话浏览器, 对话列, 工具详情, overlayLayer]）+ 自选停靠面板，
 * ResizeObserver + resize 跟随（对话列轨道经宿主 transition 动画，
 * RO 在动画期间连续重测量）。
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { QuoteStage } from './QuoteStage.tsx'
import type { Observable, SelectionState } from './store.ts'
import css from './quote-pane.module.css'

export interface QuotePaneInjected {
  hooks: {
    selection: Observable<SelectionState>
  }
}

export type QuotePaneProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<QuotePaneInjected>

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export function QuotePane({ t, useSelection, useSessions }: QuotePaneProps) {
  const [rect, setRect] = useState<Rect | null>(null)

  // 对话列在场判据：有当前会话（含首帧恢复），不要求会话已有内容——
  // 打开瞬间 byId 可能暂缺该行，要求非空会话抖动回行情（2.3 教训）。
  const chatOn = useSessions(state => state.current) !== undefined

  useEffect(() => { document.body.dataset.dshtradingChat = chatOn ? 'on' : 'off' }, [chatOn])

  useEffect(() => {
    let raf = 0
    const measure = (): void => {
      const frame = document.querySelector('div:has(> [data-shell-overlay])')
      if (frame === null) return
      const frameBox = frame.getBoundingClientRect()
      const dockBox = document.querySelector('[data-dshtrading-market-dock]')?.getBoundingClientRect()
      const left = dockBox !== undefined && dockBox.width > 0 ? dockBox.right : frameBox.left
      // 右缘：对话列在场取对话列（children[1]）左缘，否则取会话浏览器（children[0]）左缘。
      const rightBox = frame.children[chatOn ? 1 : 0]?.getBoundingClientRect()
      const right = rightBox !== undefined && rightBox.width > 0 ? rightBox.left : frameBox.right
      setRect({ left, top: frameBox.top, width: Math.max(0, right - left), height: frameBox.height })
    }
    measure()
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    })
    const frame = document.querySelector('div:has(> [data-shell-overlay])')
    for (const child of Array.from(frame?.children ?? [])) observer.observe(child)
    if (frame !== null) observer.observe(frame)
    const dock = document.querySelector('[data-dshtrading-market-dock]')
    if (dock !== null) observer.observe(dock)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      cancelAnimationFrame(raf)
    }
  }, [chatOn])

  if (rect === null) return null

  return (
    <div
      className={css.pane}
      data-dshtrading-quote-pane=""
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {/* QuoteStage 的 slot 运行时面（viewRequest 等）在面板场景不需要，只取 t/useSelection。 */}
      <QuoteStage {...({ t, useSelection } as never)} />
    </div>
  )
}
