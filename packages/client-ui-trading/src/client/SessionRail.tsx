/**
 * 会话竖条（2.9）：右缘常驻功能栏，参考同花顺式右侧竖排工具栏。
 *
 * - 永不隐藏：折叠只收会话列轨道（fold-store → shell-pad.css 规则 9），
 *   竖条始终占住右缘 44px（shell-pad.css 规则 8 预留的侧栏轨道），会话
 *   进行中也在——取代 2.8「右上浮动簇 + 会话头内联按钮」双入口。
 * - 结构自上而下：折叠/展开、新会话、分隔线、功能页签（定时任务、资产）；
 *   设置入口 3.0 起迁往左侧自选面板底部（MarketDock），竖条不再承载。
 * - 功能页签 = 对话列容器的切换页签：激活时对话列内容被隐去（shell-pad.css
 *   规则 11/12），面板原位覆盖同一列——与对话非并排、同一容器二选一；
 *   状态走 body[data-dshtrading-*] 联动。定时任务（3.0）与资产面板
 *   （2026-09-05）互斥：同一条轨道同时只容一个覆盖面。
 * - 资产面板开关走 holdings-store 的 holdingsPanelStore（共享单例）：
 *   QuoteStage 下单成功后 setHoldingsPanelOpen(true) 跨树联动打开。
 * - 折叠态同步 body[data-dshtrading-chat-folded] 的 effect 从旧 WindowChrome
 *   移入本组件（竖条恒挂载，单一同步点）。
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FoldStore } from './fold-store.ts'
import { holdingsPanelStore, setHoldingsPanelOpen } from './holdings-store.ts'
import { IconClock, IconFoldPanel, IconNewSession, IconWallet } from './icons.tsx'
import { ScheduledTasksPanel } from './ScheduledTasksPanel.tsx'
import { HoldingsPanel } from './HoldingsPanel.tsx'
import type { FillComposerFn } from './fill-composer.ts'
import css from './session-rail.module.css'

export interface SessionRailInjected {
  startNewSession(): void
  toggleFold(): void
  /** 定时任务执行历史「打开会话」（官方 sessions 通路，index.ts 注入）。 */
  openSession(sessionId: string): void
  /** 会话输入框填入入口（资产面板「导入持仓」只填不发；index.ts 注入）。 */
  fillComposer?: FillComposerFn | undefined
  hooks: { folded: FoldStore }
}

export type SessionRailProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<SessionRailInjected>

export function SessionRail({ t, useFolded, startNewSession, toggleFold, openSession, fillComposer }: SessionRailProps) {
  const folded = useFolded(value => value)
  // 定时任务页签（功能页签 1 号）：会话级开关（无需持久化——每次进来默认收起）。
  const [tasksOpen, setTasksOpen] = useState(false)
  // 资产面板（功能页签 2 号）：开关在共享 store（QuoteStage 下单联动），
  // 本组件是渲染点与 rail 页签入口；与定时任务互斥（同一容器二选一）。
  const holdingsOpen = useSyncExternalStore(holdingsPanelStore.subscribe, holdingsPanelStore.getSnapshot)

  useEffect(() => {
    document.body.dataset.dshtradingChatFolded = folded ? 'on' : 'off'
    return () => { delete document.body.dataset.dshtradingChatFolded }
  }, [folded])

  useEffect(() => {
    document.body.dataset.dshtradingTasksOpen = tasksOpen ? 'on' : 'off'
    return () => { delete document.body.dataset.dshtradingTasksOpen }
  }, [tasksOpen])

  useEffect(() => {
    document.body.dataset.dshtradingHoldingsOpen = holdingsOpen ? 'on' : 'off'
    return () => { delete document.body.dataset.dshtradingHoldingsOpen }
  }, [holdingsOpen])

  // 互斥联动：资产面板打开 → 收定时任务；定时任务打开 → 收资产面板。
  useEffect(() => {
    if (holdingsOpen) setTasksOpen(false)
  }, [holdingsOpen])

  const toggleTasks = (next: boolean): void => {
    setTasksOpen(next)
    if (next) setHoldingsPanelOpen(false)
  }

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
        onClick={() => { toggleTasks(false); startNewSession() }}
      >
        <IconNewSession size={16} />
      </button>
      {/* 功能页签扩展位：分隔线下方（注释见 2.9 定稿）；激活时与对话列同容器
          切换（见文件头注），复用 .button 样式保持竖条节奏。 */}
      <div className={css.divider} aria-hidden="true" />
      <button
        type="button"
        className={css.button}
        aria-pressed={tasksOpen}
        aria-label={t('tasks.open')}
        title={t('tasks.open')}
        onClick={() => { toggleTasks(!tasksOpen) }}
      >
        <IconClock size={16} />
      </button>
      <button
        type="button"
        className={css.button}
        aria-pressed={holdingsOpen}
        aria-label={t('trade.holdings.panel.open')}
        title={t('trade.holdings.panel.open')}
        onClick={() => { setHoldingsPanelOpen(!holdingsOpen) }}
      >
        <IconWallet size={16} />
      </button>
      {tasksOpen && (
        <ScheduledTasksPanel
          t={t}
          openSession={(sessionId) => { toggleTasks(false); openSession(sessionId) }}
          close={() => { toggleTasks(false) }}
        />
      )}
      {holdingsOpen && (
        <HoldingsPanel
          t={t}
          fillComposer={fillComposer}
          onClose={() => { setHoldingsPanelOpen(false) }}
        />
      )}
    </div>
  )
}
