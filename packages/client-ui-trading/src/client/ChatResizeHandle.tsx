/**
 * 会话列拖拽调宽手柄：贴对话列左缘的常驻竖条（宿主自带的拖拽手柄在 rtl
 * 翻转下物理坐标错位被 shell-pad.css 规则 4 隐藏，列宽因此不可调——本组件
 * 是替代面）。
 *
 * - 位置纯 CSS：right = 44px 竖条宽 + var(--dshtrading-chat-w)。手柄挂在
 *   shell.overlay（栅格 frame 的 overlayLayer 子树内），继承 frame 上定义的
 *   --dshtrading-chat-w，无需测量。
 * - 拖拽直写 body 内联 --dshtrading-chat-user-w（shell-pad.css 规则 3 引用），
 *   不进 React 状态——指针移动只驱栅格重排，不触发重渲染；松手才落 store
 *   持久化。宽度起点取 store 快照、位移取 clientX 差值，不硬编码竖条宽。
 * - 拖拽期间 body[data-dshtrading-chat-resizing] 关掉宿主轨道 transition
 *   （滑入动画会毁掉跟手性）并全局 col-resize + 禁选中。
 * - 双击复位默认宽度；焦点态 ←/→ 微调（role=separator 惯例，← 加宽）。
 * - 无当前会话或会话列折叠时退场（对话列不在场，手柄无锚点）。
 */
import { useEffect, useRef } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CHAT_WIDTH_DEFAULT, chatWidthStore, clampChatWidth } from './chat-width-store.ts'
import type { FoldStore } from './fold-store.ts'
import css from './chat-resize-handle.module.css'

export interface ChatResizeHandleInjected {
  hooks: { folded: FoldStore }
}

export type ChatResizeHandleProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<ChatResizeHandleInjected>

/** 把宽度写到 body 变量（布局实时消费）；persist 时夹紧落 store。 */
function applyWidth(width: number, persist: boolean): void {
  const clamped = clampChatWidth(width)
  document.body.style.setProperty('--dshtrading-chat-user-w', `${clamped}px`)
  if (persist) chatWidthStore().set(clamped)
}

export function ChatResizeHandle({ t, useFolded, useSessions }: ChatResizeHandleProps) {
  const folded = useFolded(value => value)
  const chatOn = useSessions(state => state.current) !== undefined
  const ref = useRef<HTMLDivElement | null>(null)

  // 挂载即把持久化宽度同步到 body 变量（会话列展开动画的目标值）；卸载还原，
  // 折叠/无会话的退场不残留内联变量。
  useEffect(() => {
    document.body.style.setProperty('--dshtrading-chat-user-w', `${chatWidthStore().getSnapshot()}px`)
    return () => { document.body.style.removeProperty('--dshtrading-chat-user-w') }
  }, [])

  if (!chatOn || folded) return null

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = ref.current
    if (handle === null) return
    const startX = event.clientX
    const startWidth = chatWidthStore().getSnapshot()
    handle.setPointerCapture(event.pointerId)
    document.body.dataset.dshtradingChatResizing = 'on'
    const onMove = (move: PointerEvent): void => {
      applyWidth(startWidth + (startX - move.clientX), false)
    }
    const onUp = (up: PointerEvent): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onCancel)
      delete document.body.dataset.dshtradingChatResizing
      applyWidth(startWidth + (startX - up.clientX), true)
    }
    const onCancel = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onCancel)
      delete document.body.dataset.dshtradingChatResizing
      applyWidth(startWidth, true)
    }
    // setPointerCapture 后 move/up/cancel 都派发到手柄上，随元素监听最省。
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onCancel)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 60 : 20
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      applyWidth(chatWidthStore().getSnapshot() + step, true)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      applyWidth(chatWidthStore().getSnapshot() - step, true)
    }
  }

  return (
    <div
      ref={ref}
      className={css.handle}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('chat.resize')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => { applyWidth(CHAT_WIDTH_DEFAULT, true) }}
      onKeyDown={onKeyDown}
    />
  )
}
