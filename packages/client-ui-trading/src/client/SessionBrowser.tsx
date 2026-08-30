/**
 * 右侧边栏的会话区（遮蔽 sidebar.workspaces —— 会话浏览器已随宿主侧栏列移到右缘）：
 *
 * 只承载历史会话（默认展开）。列表作用域跟随当前会话所在工作区；无当前
 * 会话时取活动最近的工作区（宿主 watchNavigation 的 recentWorkspace 同款
 * 策略）——左侧官方 composer 换工作区文件夹即换这里的列表。
 *
 * 2.5 入口归一：新对话只走官方首页 composer（工作区文件夹 + PTC + 模型
 * 选择集中在那一处），本面板此前的自绘「工作区选择 + 输入框」入口卡退役。
 */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import css from './session-browser.module.css'

export interface SessionBrowserInjected {
  /** 打开既有会话。 */
  openSession(sessionId: string): void
}

export type SessionBrowserProps =
  PropsRuntime<'sidebar.workspaces'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<SessionBrowserInjected>

interface WorkspaceRow {
  workspaceId: string
  title: string
  sessionIds: string[]
}

export function SessionBrowser({
  t, wide, useSessions, useWorkspaces,
  openSession,
}: SessionBrowserProps) {
  const sessions = useSessions((value: SessionListState) => value)
  const workspaces = useWorkspaces(value => value)
  const [historyOpen, setHistoryOpen] = useState(true)

  const workspaceRows: WorkspaceRow[] = workspaces.items.map(item => ({
    workspaceId: String(item.workspaceId),
    title: String(item.title ?? item.workspaceId),
    sessionIds: (Array.isArray(item.sessionIds) ? item.sessionIds : []).map(String),
  }))
  const scopeWorkspace = (sessions.current !== undefined
    ? workspaceRows.find(row => row.sessionIds.includes(sessions.current as string))?.workspaceId
    : undefined)
    ?? mostRecentlyActive(workspaceRows, sessions.byId)
    ?? workspaceRows[0]?.workspaceId
  const scopeTitle = workspaceRows.find(row => row.workspaceId === scopeWorkspace)?.title

  const historyRows = (workspaceRows.find(row => row.workspaceId === scopeWorkspace)?.sessionIds ?? [])
    .map(id => sessions.byId[id])
    .filter(row => row !== undefined && !row.blank && row.origin !== 'subagent')
    .sort((left, right) => right.updatedAt - left.updatedAt)

  if (!wide) return null

  return (
    <div className={css.root} data-dshtrading-session-browser="">
      {/* 历史会话：默认展开，可折叠 */}
      <button
        type="button"
        className={css.historyToggle}
        aria-expanded={historyOpen}
        aria-controls="dshtrading-session-history"
        onClick={() => { setHistoryOpen(open => !open) }}
      >
        <svg className={css.historyChevron} viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
          <path d="M2 1l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t('browser.history')}
        {scopeTitle !== undefined && (
          <span className={css.historyScope} title={scopeTitle}>{scopeTitle}</span>
        )}
        <span className={css.historyCount}>{historyRows.length}</span>
      </button>
      {historyOpen && (
        <div id="dshtrading-session-history" className={css.historyList}>
          {historyRows.length === 0
            ? <div className={css.historyEmpty}>{t('browser.historyEmpty')}</div>
            : historyRows.map(row => (
              <button
                key={row.id}
                type="button"
                className={css.historyRow}
                data-current={row.id === sessions.current ? 'true' : undefined}
                title={row.displayTitle}
                onClick={() => { openSession(row.id) }}
              >
                <span className={css.dot} data-running={row.running ? 'true' : undefined} />
                <span className={css.historyTitle}>{row.displayTitle}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

/** 会话活动最近的工作区 id（全部无会话活动时返回 undefined，由调用方兜底）。 */
function mostRecentlyActive(rows: WorkspaceRow[], byId: SessionListState['byId']): string | undefined {
  let picked: string | undefined
  let pickedTime = Number.NEGATIVE_INFINITY
  for (const row of rows) {
    let latest = Number.NEGATIVE_INFINITY
    for (const id of row.sessionIds) {
      latest = Math.max(latest, byId[id]?.updatedAt ?? Number.NEGATIVE_INFINITY)
    }
    if (latest > pickedTime) {
      picked = row.workspaceId
      pickedTime = latest
    }
  }
  return picked
}
