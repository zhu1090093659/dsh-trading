/**
 * 右侧边栏的会话区（遮蔽 sidebar.workspaces —— 会话浏览器已随宿主侧栏列移到右缘）：
 *
 * - 上方：历史会话（默认折叠，展开后按所选工作区过滤）
 * - 下方：新对话入口（工作区选择 + 紧凑输入框 + 发送）——经由官方
 *   uiWorkspace.connectWorkspace（建/复用空白会话）+ IConversation.send
 *   （首条消息入队）。
 *
 * 2.4 布局：官方对话列常驻右侧（会话浏览器左邻），打开会话/新发消息后
 * 对话列自动展开（QuotePane 按 current 会话驱动），无需模式切换。
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { readJson, writeJson } from './store.ts'
import css from './session-browser.module.css'

const WS_KEY = 'dshtrading.browser.workspace.v1'

export interface SessionBrowserInjected {
  /** 打开既有会话。 */
  openSession(sessionId: string): void
  /** 在指定工作区建/复用空白会话并打开，随即发送首条消息（官方 connectWorkspace + IConversation.send）。 */
  startConversation(workspaceId: string, text: string): Promise<void>
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
  openSession, startConversation,
}: SessionBrowserProps) {
  const sessions = useSessions((value: SessionListState) => value)
  const workspaces = useWorkspaces(value => value)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [pickedWorkspace, setPickedWorkspace] = useState<string | undefined>(() => readJson<string | undefined>(WS_KEY, undefined))

  // 持久化只存用户显式选择；默认跟随当前会话所在工作区。
  useEffect(() => {
    if (pickedWorkspace !== undefined) writeJson(WS_KEY, pickedWorkspace)
  }, [pickedWorkspace])

  const workspaceRows: WorkspaceRow[] = workspaces.items.map(item => ({
    workspaceId: String(item.workspaceId),
    title: String(item.title ?? item.workspaceId),
    sessionIds: (Array.isArray(item.sessionIds) ? item.sessionIds : []).map(String),
  }))
  const currentSessionWorkspace = sessions.current !== undefined
    ? workspaceRows.find(row => row.sessionIds.includes(sessions.current as string))?.workspaceId
    : undefined
  const effectiveWorkspace = pickedWorkspace ?? currentSessionWorkspace ?? workspaceRows[0]?.workspaceId
  const activeWorkspace = workspaceRows.find(row => row.workspaceId === effectiveWorkspace)

  const historyRows = (activeWorkspace?.sessionIds ?? [])
    .map(id => sessions.byId[id])
    .filter(row => row !== undefined && !row.blank && row.origin !== 'subagent')
    .sort((left, right) => right.updatedAt - left.updatedAt)

  if (!wide) return null

  const startNew = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || effectiveWorkspace === undefined || sending) return
    setSending(true)
    try {
      await startConversation(effectiveWorkspace, text)
      setDraft('')
    } catch {
      // 失败提示走宿主 promptError 通道；输入保留。
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={css.root} data-dshtrading-session-browser="">
      {/* 历史会话：默认折叠 */}
      <button
        type="button"
        className={css.historyToggle}
        onClick={() => { setHistoryOpen(open => !open) }}
      >
        <span className={css.historyChevron} data-open={historyOpen ? 'true' : undefined}>▸</span>
        {t('browser.history')}
        <span className={css.historyCount}>{historyRows.length}</span>
      </button>
      {historyOpen && (
        <div className={css.historyList}>
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

      <div className={css.spacer} />

      {/* 新对话入口：底部 */}
      <div className={css.entry}>
        <select
          className={css.workspaceSelect}
          value={effectiveWorkspace ?? ''}
          aria-label={t('browser.workspace')}
          onChange={event => { setPickedWorkspace(event.target.value) }}
        >
          {workspaceRows.length === 0 && <option value="">—</option>}
          {workspaceRows.map(row => (
            <option key={row.workspaceId} value={row.workspaceId}>{row.title}</option>
          ))}
        </select>
        <div className={css.entryRow}>
          <input
            className={css.entryInput}
            value={draft}
            placeholder={t('browser.newPlaceholder')}
            onChange={event => { setDraft(event.target.value) }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void startNew()
            }}
          />
          <button
            type="button"
            className={css.sendButton}
            disabled={sending || draft.trim() === '' || effectiveWorkspace === undefined}
            aria-label={t('browser.send')}
            onClick={() => { void startNew() }}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
