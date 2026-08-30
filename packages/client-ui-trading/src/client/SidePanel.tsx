/**
 * 右侧可折叠停靠面板（shell.overlay 条目，fixed 右缘）：新建会话（工作区选择 +
 * connectWorkspace）+ 会话列表（标准 useSessions hook，点击打开）。
 *
 * 为什么走 overlay 而不是遮蔽 details：审批卡在 composer 链、工具详情在 details
 * 列——都属交易安全/排障面，遮蔽即降级；overlay 是官方许可的全帧浮层，条目自行
 * 开启 pointer-events。展开时标注 body[data-dshtrading-panel] 供样式联动。
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { readJson, writeJson } from './store.ts'
import css from './side-panel.module.css'

const PANEL_KEY = 'dshtrading.panel.open.v1'

/** Registration-side business face. */
export interface SidePanelInjected {
  /** 打开既有会话（当前工作区导航）。 */
  openSession(sessionId: string): void
  /** 在工作区新建（或复用空白）会话并打开。 */
  createSession(workspaceId: string): Promise<void>
}

export type SidePanelProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<SidePanelInjected>

interface WorkspaceRow {
  workspaceId: string
  title: string
}

export function SidePanel({ t, useSessions, useWorkspaces, openSession, createSession }: SidePanelProps) {
  const [open, setOpen] = useState(() => readJson<boolean>(PANEL_KEY, true))
  const [creating, setCreating] = useState(false)
  const [pickedWorkspace, setPickedWorkspace] = useState<string | undefined>(undefined)
  const sessions = useSessions((value: SessionListState) => value)
  const workspaces = useWorkspaces(value => value)

  useEffect(() => {
    writeJson(PANEL_KEY, open)
    document.body.dataset.dshtradingPanel = open ? 'open' : 'closed'
    return () => { delete document.body.dataset.dshtradingPanel }
  }, [open])

  const rows = sessions.ids
    .map(id => sessions.byId[id])
    .filter(row => row !== undefined && !row.blank && row.origin !== 'subagent')
    .sort((left, right) => right.updatedAt - left.updatedAt)

  const workspaceRows: WorkspaceRow[] = workspaces.items.map(item => ({
    workspaceId: String(item.workspaceId),
    title: String(item.title ?? item.workspaceId),
  }))
  const effectiveWorkspace = pickedWorkspace ?? workspaceRows[0]?.workspaceId

  if (!open) {
    return (
      <div className={css.rail} data-dshtrading-side-rail="">
        <button
          type="button"
          className={css.railButton}
          aria-label={t('panel.expand')}
          title={t('panel.expand')}
          onClick={() => { setOpen(true) }}
        >
          ❮
        </button>
      </div>
    )
  }

  return (
    <aside className={css.panel} data-dshtrading-side-panel="open">
      <div className={css.head}>
        <span className={css.title}>{t('panel.title')}</span>
        <span className={css.headSpacer} />
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('panel.collapse')}
          title={t('panel.collapse')}
          onClick={() => { setOpen(false) }}
        >
          ❯
        </button>
      </div>
      <div className={css.body}>
        <div className={css.newCard}>
          <span className={css.sectionLabel}>{t('panel.new')}</span>
          <select
            className={css.select}
            value={effectiveWorkspace ?? ''}
            onChange={event => { setPickedWorkspace(event.target.value) }}
          >
            {workspaceRows.length === 0 && <option value="">—</option>}
            {workspaceRows.map(row => (
              <option key={row.workspaceId} value={row.workspaceId}>{row.title}</option>
            ))}
          </select>
          <button
            type="button"
            className={css.newButton}
            disabled={creating || effectiveWorkspace === undefined}
            onClick={() => {
              if (effectiveWorkspace === undefined) return
              setCreating(true)
              createSession(effectiveWorkspace)
                .catch(() => { /* 会话创建失败提示走宿主通道；面板保持 */ })
                .finally(() => { setCreating(false) })
            }}
          >
            {t('panel.new')}
          </button>
        </div>

        <span className={css.sectionLabel}>{t('panel.title')}</span>
        {rows.length === 0
          ? <div className={css.empty}>{t('panel.sessionsEmpty')}</div>
          : (
              <div className={css.sessionList}>
                {rows.map(row => (
                  <button
                    key={row.id}
                    type="button"
                    className={css.sessionRow}
                    data-current={row.id === sessions.current ? 'true' : undefined}
                    onClick={() => { openSession(row.id) }}
                  >
                    <span className={css.dot} data-running={row.running ? 'true' : undefined} />
                    <span className={css.sessionTitle}>{row.displayTitle}</span>
                  </button>
                ))}
              </div>
            )}
      </div>
    </aside>
  )
}
