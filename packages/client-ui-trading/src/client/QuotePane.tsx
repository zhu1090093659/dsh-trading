/**
 * 中栏行情面板（2.4 定稿：中栏恒为行情，对话常驻右侧栏）：
 * 几何 = [自选停靠右缘, 对话列左缘/右缘竖条左缘] 之间的整块区域，
 * 内容复用 MiddleStage（3.0 起中栏 = 视图注册表：行情 | 量化）。
 *
 * 对话列显隐由折叠开关驱动（官方会话 UI 整列移到右侧，审批卡在
 * composer 链随列可见）；轨道宽度 = 用户拖拽值，由 ChatResizeHandle
 * 写 body 内联 --dshtrading-chat-user-w、shell-pad.css 规则 3 消费，
 * 本组件不参与宽度链路（d0dc77e 前曾写 body[data-dshtrading-chat]，已废）。
 *
 * 几何测量：frame（div:has(> [data-shell-overlay])，rtl 后子元素顺序
 * [会话浏览器, 对话列, 工具详情, overlayLayer]）+ 自选停靠面板，
 * ResizeObserver + resize 跟随（对话列轨道经宿主 transition 动画，
 * RO 在动画期间连续重测量）。
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MiddleStage } from './MiddleStage.tsx'
import type { FillComposerFn } from './fill-composer.ts'
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
  /** 行情上下文 → 会话输入框（只填入不发送；shell 注入）。 */
  fillComposer?: FillComposerFn
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

export function QuotePane({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, deleteIndicator, fillComposer }: QuotePaneProps) {
  const [rect, setRect] = useState<Rect | null>(null)

  useEffect(() => {
    let raf = 0
    const measure = (): void => {
      const frame = document.querySelector<HTMLElement>('div:has(> [data-shell-overlay])')
      if (frame === null) return
      if (frame.scrollLeft !== 0) frame.scrollLeft = 0
      const frameBox = frame.getBoundingClientRect()
      const dockBox = document.querySelector('[data-dshtrading-market-dock]')?.getBoundingClientRect()
      const left = dockBox !== undefined && dockBox.width > 0 ? dockBox.right : frameBox.left

      const chatFolded = document.body.dataset.dshtradingChatFolded === 'on'
      const rightBox = frame.children[1]?.getBoundingClientRect()
      const railBox = document.querySelector('[data-dshtrading-rail]')?.getBoundingClientRect()
      // 定时任务页签激活时面板原位覆盖对话列（轨宽不变，rightBox 测量不受
      // 影响）；仅「折叠 + 任务」组合下面板浮在市场区右缘——此时取面板左缘
      // 为中栏右界。纯轨道位移不触发 ResizeObserver，开合兜底靠下方两个监听。
      const tasksBox = document.querySelector('[data-dshtrading-tasks-panel]')?.getBoundingClientRect()
      const fallbackRight = tasksBox !== undefined && tasksBox.width > 0
        ? tasksBox.left
        : (railBox !== undefined && railBox.width > 0 ? railBox.left : frameBox.right)

      let right = fallbackRight
      if (!chatFolded) {
        if (rightBox !== undefined && rightBox.width > 0) {
          right = rightBox.left
        } else {
          // 瞬态保护：未折叠时预留对话列空间（380px），避免瞬态铺满覆盖
          right = Math.max(left, fallbackRight - 380)
        }
      }

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

    // 监听主题切换及折叠/任务面板开合状态变化，立即触发重新测量
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    })
    if (typeof document !== 'undefined') {
      mo.observe(document.body, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme', 'data-theme', 'data-dshtrading-chat-folded', 'data-dshtrading-tasks-open'],
      })
    }

    // 轨道开合走宿主 grid-template-columns transition（纯位移不触发上面的
    // ResizeObserver，body 属性突变时动画尚未推进）——过渡结束补一次重测，
    // 中栏矩形贴合滑动终态（transitionend 冒泡到 frame，统一在此收口）。
    // frame 是 Element：transitionend 不在其事件映射里，按 Event 收再断言。
    const onFrameTransition = (event: Event): void => {
      if ((event as TransitionEvent).propertyName === 'grid-template-columns') {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(measure)
      }
    }
    frame?.addEventListener('transitionend', onFrameTransition)

    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      mo.disconnect()
      frame?.removeEventListener('transitionend', onFrameTransition)
      window.removeEventListener('resize', measure)
      cancelAnimationFrame(raf)
    }
  }, [])

  if (rect === null) return null

  return (
    <div
      className={css.pane}
      data-dshtrading-quote-pane=""
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {/* MiddleStage 的 slot 运行时面（viewRequest 等）在面板场景不需要，
          只取 t/两个 store hook 与指标动作。 */}
      <MiddleStage {...({ t, useSelection, useChart, toggleIndicator, setIndicatorParams, deleteIndicator, fillComposer } as never)} />
    </div>
  )
}
