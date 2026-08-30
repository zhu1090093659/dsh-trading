/**
 * 会话头右上角内联入口（2.8）：会话进行中，折叠/展开 + 新会话经官方
 * conversation.session.header.utilities 槽渲染在 Session 日志之后（窗口
 * 右上角）。首页/折叠态由 WindowChrome 的浮动簇接管同一对入口。
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FoldStore } from './fold-store.ts'
import { IconFoldPanel, IconNewSession } from './icons.tsx'
import css from './header-corner.module.css'

export interface HeaderCornerInjected {
  startNewSession(): void
  toggleFold(): void
  hooks: { folded: FoldStore }
}

export type HeaderCornerActionsProps =
  & PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<HeaderCornerInjected>

export function HeaderCornerActions({ t, useFolded, startNewSession, toggleFold }: HeaderCornerActionsProps) {
  const folded = useFolded(value => value)
  return (
    <>
      <button
        type="button"
        className={css.action}
        aria-pressed={folded}
        aria-label={folded ? t('chat.expand') : t('chat.fold')}
        title={folded ? t('chat.expand') : t('chat.fold')}
        onClick={toggleFold}
      >
        <IconFoldPanel size={15} />
      </button>
      <button
        type="button"
        className={css.action}
        aria-label={t('entry.new')}
        title={t('entry.new')}
        onClick={startNewSession}
      >
        <IconNewSession size={15} />
      </button>
    </>
  )
}
