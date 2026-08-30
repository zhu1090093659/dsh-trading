/**
 * 窗口角标（2.8）：右栏退役后的常驻入口。
 *
 * - 右上角：会话列折叠/展开 + 新会话。首页（hero 态）与折叠态下浮动渲染
 *   （此时窗口右上角无宿主内容，不遮挡）；会话进行中则改由官方
 *   conversation.session.header.utilities 槽内联渲染（HeaderCornerActions，
 *   排在 Session 日志之后＝窗口右上角），避免浮层盖住日志入口。
 * - 左下角：设置。浮动常驻（官方触发器在退役侧栏列内，程序化 click）。
 */
import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { FoldStore } from './fold-store.ts'
import { IconFoldPanel, IconNewSession, IconSettings } from './icons.tsx'
import css from './window-chrome.module.css'

export interface WindowChromeInjected {
  startNewSession(): void
  openSettings(): void
  toggleFold(): void
  hooks: { folded: FoldStore }
}

export type WindowChromeProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<WindowChromeInjected>

export function WindowChrome({ t, useSessions, useFolded, startNewSession, openSettings, toggleFold }: WindowChromeProps) {
  const sessions = useSessions((value: SessionListState) => value)
  const folded = useFolded(value => value)

  useEffect(() => {
    document.body.dataset.dshtradingChatFolded = folded ? 'on' : 'off'
    return () => { delete document.body.dataset.dshtradingChatFolded }
  }, [folded])

  // hero 态（无会话内容）或已折叠：右上角浮层接管入口；会话进行中由
  // 会话头内联按钮负责（见 HeaderCornerActions）。
  const blank = sessions.current !== undefined && sessions.byId[sessions.current]?.blank === true
  const floatActions = folded || blank

  return (
    <>
      {floatActions && (
        <div className={css.cluster} data-corner="top-right">
          <button
            type="button"
            className={css.button}
            aria-pressed={folded}
            aria-label={folded ? t('chat.expand') : t('chat.fold')}
            title={folded ? t('chat.expand') : t('chat.fold')}
            onClick={toggleFold}
          >
            <IconFoldPanel size={15} />
          </button>
          <button
            type="button"
            className={css.button}
            aria-label={t('entry.new')}
            title={t('entry.new')}
            onClick={startNewSession}
          >
            <IconNewSession size={15} />
          </button>
        </div>
      )}
      <div className={css.cluster} data-corner="bottom-left">
        <button
          type="button"
          className={css.button}
          aria-label={t('entry.settings')}
          title={t('entry.settings')}
          onClick={openSettings}
        >
          <IconSettings size={15} />
        </button>
      </div>
    </>
  )
}
