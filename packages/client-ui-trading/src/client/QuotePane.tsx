/**
 * 中栏行情面板（2.4 定稿：中栏恒为行情，对话常驻右侧栏）：
 * 几何 = [自选停靠右缘, 对话列左缘/右缘竖条左缘] 之间的整块区域，
 * 内容复用 MiddleStage（3.0 起中栏 = 视图注册表：行情 | 量化）。
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
import { MiddleStage } from './MiddleStage.tsx'
import type { Observable, SelectionState } from './store.ts'
import type { ChartState } from './chart-state.ts'
import css from './quote-pane.module.css'

export interface QuotePaneInjected {
  hooks: {
    selection: Observable<SelectionState>
    chart: Observable<ChartState>
  }
  toggleIndicator: (id: string) => void
  setIndicatorParams: (id: string, params: Record<string, number>) => void
  /** 删除自定义指标（issue #30）：桥 DELETE → 注销注册表 + 移除激活实例。 */
  deleteIndicator: (id: string) => Promise<boolean>
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

export function QuotePane({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, deleteIndicator, useSessions }: QuotePaneProps) {
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
      // 右缘：优先取对话列（children[1]）左缘——2.7 右栏退役后 children[0]
      // 是移出视口的退役侧栏（宽 272 但不在视口），不能再用；对话列退场时
      // 它 display:none（宽 0），回落到右缘竖条（2.9 常驻 44px）左缘，
      // 行情不延伸到竖条底下。
      const rightBox = frame.children[1]?.getBoundingClientRect()
      const railBox = document.querySelector('[data-dshtrading-rail]')?.getBoundingClientRect()
      const fallbackRight = railBox !== undefined && railBox.width > 0 ? railBox.left : frameBox.right
      const right = rightBox !== undefined && rightBox.width > 0 ? rightBox.left : fallbackRight
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
    // 竖条首帧晚于本组件挂载时，observe 的初始回调保证补一次重测量。
    const rail = document.querySelector('[data-dshtrading-rail]')
    if (rail !== null) observer.observe(rail)
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
      {/* MiddleStage 的 slot 运行时面（viewRequest 等）在面板场景不需要，
          只取 t/两个 store hook 与指标动作。 */}
      <MiddleStage {...({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, deleteIndicator } as never)} />
    </div>
  )
}
