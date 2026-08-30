/**
 * 行情面板（行情模式的中栏浮层）：盖住中栏列的矩形区域，内容复用 QuoteStage。
 * 中栏可见性规则：仅「对话模式 + 当前会话有实际内容」时显示官方会话 UI；
 * 其余情况（行情模式 / 无会话 / 空白会话）一律行情面板——宿主 hero 与
 * 会话壳（header/tab 条/composer/状态栏）不再上屏（CSS 按 body attr 隐藏）。
 *
 * 安全闸门联动：出现 pending approval 时强制切回对话模式（审批卡在 composer
 * 链，被隐藏 = 用户看不到审批请求，绝不允许）。
 *
 * 几何：测量宿主会话壳根节点（[data-conversation-scroll] 的父元素）的矩形，
 * ResizeObserver + resize 跟随（侧栏折叠/右栏展开/窗口缩放都会重测量）。
 */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { QuoteStage } from './QuoteStage.tsx'
import type { Observable, ModeState, SelectionState, ShellMode } from './store.ts'
import css from './quote-pane.module.css'

export interface QuotePaneInjected {
  hooks: {
    selection: Observable<SelectionState>
    mode: Observable<ModeState>
  }
  /** 写路径：切换 quotes/chat（官方模式，审批联动唯一出口）。 */
  setShellMode(mode: ShellMode): void
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

export function QuotePane({ t, useSelection, useMode, useSessions, setShellMode, useSessionPendingInteraction }: QuotePaneProps) {
  const mode = useMode(value => value.mode)
  const [rect, setRect] = useState<Rect | null>(null)

  // 中栏可见性：对话模式 + 有当前会话 → 官方会话 UI（空白会话显示宿主原生 hero，
  // 属用户显式进入对话的语义）；行情模式或无会话 → 行情面板（默认状态，hero 不上屏）。
  const currentSession = useSessions(state => state.current)
  const hasCurrent = currentSession !== undefined
  const chatVisible = mode === 'chat' && hasCurrent

  // 用户在右侧会话区打开会话 → 切到对话模式（首帧恢复的 current 不触发）。
  const previousSession = useRef(currentSession)
  useEffect(() => {
    if (previousSession.current !== undefined
      && currentSession !== undefined
      && currentSession !== previousSession.current) {
      setShellMode('chat')
    }
    previousSession.current = currentSession
  }, [currentSession, setShellMode])

  // 审批等待 → 强制对话模式（审批卡在 composer 链，行情模式下不可见）。
  const pending = useSessionPendingInteraction(snapshot => {
    const map = snapshot as unknown as { size?: number } | undefined
    return (map?.size ?? 0) > 0
  })
  useEffect(() => {
    if (pending && !chatVisible) setShellMode('chat')
  }, [pending, chatVisible, setShellMode])

  useEffect(() => { document.body.dataset.dshtradingMode = chatVisible ? 'chat' : 'quotes' }, [chatVisible])

  useEffect(() => {
    if (chatVisible) return
    let raf = 0
    const measure = (): void => {
      const root = document.querySelector('[data-conversation-scroll]')?.parentElement
      if (root === null || root === undefined) return
      const box = root.getBoundingClientRect()
      setRect({ left: box.left, top: box.top, width: box.width, height: box.height })
    }
    measure()
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    })
    const target = document.querySelector('[data-conversation-scroll]')?.parentElement
    if (target !== null && target !== undefined) observer.observe(target)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      cancelAnimationFrame(raf)
    }
  }, [chatVisible])

  // pane = 会话列被隐藏时（行情模式/无会话/空白会话）的中栏替代内容；
  // chatVisible 时官方会话 UI 上屏，pane 退场。
  if (chatVisible || rect === null) return null

  return (
    <div
      className={css.pane}
      data-dshtrading-quote-pane=""
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      <div className={css.paneHeader}>
        <span className={css.paneTitle}>{t('view.quote')}</span>
        {hasCurrent && (
          <button
            type="button"
            className={css.paneChatButton}
            onClick={() => { setShellMode('chat') }}
          >
            {t('pane.chat')}
          </button>
        )}
      </div>
      <div className={css.paneBody}>
        {/* QuoteStage 的 slot 运行时面（viewRequest 等）在面板场景不需要，只取 t/useSelection。 */}
        <QuoteStage {...({ t, useSelection } as never)} />
      </div>
    </div>
  )
}
