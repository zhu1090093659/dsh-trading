/**
 * 会话竖条（2.9）：右缘常驻功能栏，参考同花顺式右侧竖排工具栏。
 *
 * - 永不隐藏：折叠只收会话列轨道（fold-store → shell-pad.css 规则 9），
 *   竖条始终占住右缘 44px（shell-pad.css 规则 8 预留的侧栏轨道），会话
 *   进行中也在——取代 2.8「右上浮动簇 + 会话头内联按钮」双入口。
 * - 结构自上而下：折叠/展开、新会话、分隔线、设置；后续功能页签在分隔线
 *   下方追加（页签面板向左展开，状态照 fold-store 模式加 store +
 *   body[data-dshtrading-*] 联动）。
 * - 设置仍是程序化 click 退役侧栏列内的官方触发器（见 index.ts openSettings）。
 * - 折叠态同步 body[data-dshtrading-chat-folded] 的 effect 从旧 WindowChrome
 *   移入本组件（竖条恒挂载，单一同步点）。
 */
import { useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FoldStore } from './fold-store.ts'
import { IconFoldPanel, IconNewSession, IconSettings } from './icons.tsx'
import css from './session-rail.module.css'

export interface SessionRailInjected {
  startNewSession(): void
  openSettings(): void
  toggleFold(): void
  hooks: { folded: FoldStore }
}

export type SessionRailProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<SessionRailInjected>

export function SessionRail({ t, useFolded, startNewSession, openSettings, toggleFold }: SessionRailProps) {
  const folded = useFolded(value => value)

  useEffect(() => {
    document.body.dataset.dshtradingChatFolded = folded ? 'on' : 'off'
    return () => { delete document.body.dataset.dshtradingChatFolded }
  }, [folded])

  return (
    <div className={css.rail} data-dshtrading-rail="" role="toolbar" aria-orientation="vertical">
      <button
        type="button"
        className={css.button}
        aria-pressed={folded}
        aria-label={folded ? t('chat.expand') : t('chat.fold')}
        title={folded ? t('chat.expand') : t('chat.fold')}
        onClick={toggleFold}
      >
        <IconFoldPanel size={16} />
      </button>
      <button
        type="button"
        className={css.button}
        aria-label={t('entry.new')}
        title={t('entry.new')}
        onClick={startNewSession}
      >
        <IconNewSession size={16} />
      </button>
      {/* 功能页签扩展位：后续新入口（画线工具/资讯/提醒等）加在这条分隔线
          下方，激活态面板向左展开；复用 .button 样式保持竖条节奏。 */}
      <div className={css.divider} aria-hidden="true" />
      <button
        type="button"
        className={css.button}
        aria-label={t('entry.settings')}
        title={t('entry.settings')}
        onClick={openSettings}
      >
        <IconSettings size={16} />
      </button>
    </div>
  )
}
