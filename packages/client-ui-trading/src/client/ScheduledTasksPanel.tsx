/**
 * 定时任务面板（右缘竖栏功能页签 1 号）：竖条时钟按钮向左展开的紧凑面板。
 *
 * Host 权威语义（对齐 dsh-web dsh-task-board）：本组件只是异步视图——所有
 * 变更走 /tasks/action 幂等动作，服务端确认快照即新状态；SSE 'tasks' 失效
 * 信号 + 15 秒兜底轮询驱动刷新，关浏览器不影响宿主调度。
 */
import { useCallback, useEffect, useState } from 'react'
import { isValidCron, nextRunAtMs } from './tasks-schedule.ts'
import {
  permissionPending,
  TASK_PERMISSIONS,
  type TaskPermission,
  type TaskRecord,
  type TasksAction,
  type TasksSnapshot,
} from './tasks-protocol.ts'
import { subscribeTradingEvents } from './api.ts'
import type { MarketLocaleKey } from './contract.ts'
import { fetchTasksMeta, fetchTasksSnapshot, postTaskAction, type TasksMeta } from './tasks-api.ts'
import css from './session-rail.module.css'

/** 本包 locale 词典的 t 面（SessionRail 注入转发）。 */
type Translate = (key: MarketLocaleKey) => string

export interface ScheduledTasksPanelProps {
  t: Translate
  /** 执行历史「打开会话」：官方 sessions 通路（SessionRail 注入）。 */
  openSession(sessionId: string): void
  /** 关闭面板（竖条按钮收起）。 */
  close(): void
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

function fmtTime(ts: number | undefined): string {
  return ts === undefined ? '—' : TIME_FORMAT.format(new Date(ts))
}

/** 定时任务面板。 */
export function ScheduledTasksPanel({ t, openSession, close }: ScheduledTasksPanelProps) {
  const [snapshot, setSnapshot] = useState<TasksSnapshot | null>(null)
  const [meta, setMeta] = useState<TasksMeta | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [editing, setEditing] = useState<'new' | TaskRecord | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [snap, m] = await Promise.all([fetchTasksSnapshot(), fetchTasksMeta()])
      setSnapshot(snap)
      setMeta(m)
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    void reload()
    const unsubscribe = subscribeTradingEvents({ tasks: () => { void reload() } })
    const timer = setInterval(() => { void reload() }, 15_000)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [reload])

  /** 统一动作通道：服务端确认快照即新状态（失败抛错由调用方提示）。 */
  const act = useCallback(async (action: TasksAction): Promise<boolean> => {
    setBusy(true)
    try {
      setSnapshot(await postTaskAction(action))
      setLoadError(false)
      return true
    } catch {
      setLoadError(true)
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const tasks = [...(snapshot?.tasks ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  const defaultPermission = snapshot?.sessionDefaultPermission ?? 'read-only'

  return (
    <div className={css.tasksPanel} data-dshtrading-tasks-panel="" role="panel" aria-label={t('tasks.open')}>
      <header className={css.tasksHead}>
        <strong className={css.tasksTitle}>{t('tasks.open')}</strong>
        <span className={css.tasksSpacer} />
        <button type="button" className={css.tasksNewBtn} onClick={() => { setEditing('new') }} disabled={busy}>{t('tasks.new')}</button>
        <button type="button" className={css.tasksCloseBtn} aria-label={t('tasks.close')} title={t('tasks.close')} onClick={close}>×</button>
      </header>
      <div className={css.tasksBody}>
        {loadError && <p className={css.tasksError}>{t('tasks.loadFailed')}</p>}
        {editing !== null ? (
          <TaskEditor
            t={t}
            meta={meta}
            task={editing === 'new' ? undefined : editing}
            onDone={() => { setEditing(null); void reload() }}
            onCancel={() => { setEditing(null) }}
          />
        ) : tasks.length === 0 ? (
          <div className={css.tasksEmpty}>
            <p>{t('tasks.empty')}</p>
            <p className={css.tasksEmptyHint}>{t('tasks.emptyHint')}</p>
          </div>
        ) : (
          <ul className={css.taskList}>
            {tasks.map(task => (
              <li key={task.id} className={css.taskItem}>
                <div className={css.taskRowTop}>
                  <span className={css.taskTitle} title={task.prompt}>{task.title}</span>
                  {task.schedule === undefined
                    ? undefined
                    : (
                      <button
                        type="button"
                        className={css.taskToggle}
                        data-on={task.schedule.enabled ? 'true' : undefined}
                        disabled={busy}
                        onClick={() => { void act({ kind: 'set-schedule', taskId: task.id, patch: { enabled: !task.schedule?.enabled } }) }}
                      >{task.schedule.enabled ? t('tasks.action.disable') : t('tasks.action.enable')}</button>
                    )}
                </div>
                <div className={css.taskMeta}>
                  {task.schedule === undefined ? (
                    <span>{t('tasks.schedule.manualOnly')}</span>
                  ) : (
                    <>
                      <span className={css.taskChip}>{task.schedule.cron}</span>
                      {task.schedule.enabled && task.schedule.nextRunAt !== undefined
                        ? <span>{t('tasks.schedule.nextRun')} {fmtTime(task.schedule.nextRunAt)}</span>
                        : undefined}
                    </>
                  )}
                  {permissionPending(task, defaultPermission) && <span className={css.badgePending}>{t('tasks.permission.pending')}</span>}
                  {task.executions.some(execution => execution.endedAt === undefined) && <span className={css.badgeRunning}>{t('tasks.action.running')}</span>}
                </div>
                {permissionPending(task, defaultPermission) && (
                  <button
                    type="button"
                    className={css.confirmBtn}
                    disabled={busy}
                    onClick={() => { void act({ kind: 'confirm-permission', taskId: task.id }) }}
                  >{t('tasks.permission.confirm')}</button>
                )}
                <div className={css.taskActions}>
                  <button
                    type="button"
                    className={css.miniBtn}
                    disabled={busy || permissionPending(task, defaultPermission) || task.executions.some(execution => execution.endedAt === undefined)}
                    onClick={() => { void act({ kind: 'run', taskId: task.id }) }}
                  >{t('tasks.action.run')}</button>
                  <button type="button" className={css.miniBtn} disabled={busy} onClick={() => { setEditing(task) }}>{t('tasks.action.edit')}</button>
                  <button type="button" className={css.miniBtn} onClick={() => { setExpanded(expanded === task.id ? null : task.id) }}>{t('tasks.action.history')}</button>
                  <button
                    type="button"
                    className={css.miniBtnDanger}
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(t('tasks.action.deleteConfirm'))) void act({ kind: 'delete', taskId: task.id })
                    }}
                  >{t('tasks.action.delete')}</button>
                </div>
                {expanded === task.id && (
                  <ul className={css.execList}>
                    {task.executions.length === 0
                      ? <li className={css.execRow}>—</li>
                      : [...task.executions].slice(-5).reverse().map(execution => (
                        <li key={execution.id} className={css.execRow}>
                          <span>{fmtTime(execution.startedAt)}</span>
                          <span>{execution.trigger === 'cron' ? t('tasks.exec.trigger.cron') : t('tasks.exec.trigger.manual')}</span>
                          <span
                            className={
                              execution.endedAt === undefined
                                ? css.badgeRunning
                                : execution.result === 'succeeded'
                                  ? css.badgeOk
                                  : css.badgeFail
                            }
                          >
                            {execution.endedAt === undefined
                              ? t('tasks.exec.running')
                              : execution.result === 'succeeded'
                                ? t('tasks.exec.succeeded')
                                : execution.result === 'failed'
                                  ? t('tasks.exec.failed')
                                  : t('tasks.exec.cancelled')}
                          </span>
                          {execution.error !== undefined && <span className={css.execError} title={execution.error}>{execution.error}</span>}
                          {execution.sessionId !== undefined && execution.endedAt !== undefined && (
                            <button type="button" className={css.miniBtn} onClick={() => { openSession(execution.sessionId ?? '') }}>
                              {t('tasks.exec.openSession')}
                            </button>
                          )}
                        </li>
                      ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

interface TaskEditorProps {
  t: Translate
  meta: TasksMeta | null
  /** undefined = 新建；否则编辑既有任务。 */
  task: TaskRecord | undefined
  onDone(): void
  onCancel(): void
}

/** 内联编辑器：新建与编辑共用（保存走 create/update 幂等动作）。 */
function TaskEditor({ t, meta, task, onDone, onCancel }: TaskEditorProps) {
  const [title, setTitle] = useState(task?.title ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')
  const [scheduleEnabled, setScheduleEnabled] = useState(task?.schedule?.enabled ?? true)
  const [cron, setCron] = useState(task?.schedule?.cron ?? '0 9 * * *')
  const [workspaceId, setWorkspaceId] = useState(task?.workspaceId ?? '')
  const [agentPreset, setAgentPreset] = useState(task?.agentPreset ?? '')
  const [permission, setPermission] = useState<string>(task?.permission ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const cronValid = isValidCron(cron)
  const nextRun = scheduleEnabled && cronValid ? nextRunAtMs(cron, Date.now()) : undefined
  const titleValid = title.trim() !== ''

  const save = async (): Promise<void> => {
    if (!titleValid || !cronValid || busy) return
    setBusy(true)
    setError(undefined)
    const schedule = { enabled: scheduleEnabled, cron }
    try {
      if (task === undefined) {
        const input: import('./tasks-protocol.ts').NewTaskInput = {
          title: title.trim(),
          prompt,
          schedule,
          ...(workspaceId === '' ? {} : { workspaceId }),
          ...(agentPreset === '' ? {} : { agentPreset }),
          ...(permission === '' ? {} : { permission: permission as TaskPermission }),
        }
        await postTaskAction({ kind: 'create', id: crypto.randomUUID(), input })
      } else {
        await postTaskAction({
          kind: 'update',
          taskId: task.id,
          patch: {
            title: title.trim(),
            prompt,
            schedule,
            workspaceId: workspaceId === '' ? null : workspaceId,
            agentPreset: agentPreset === '' ? null : agentPreset,
            permission: permission === '' ? null : permission as TaskPermission,
          },
        })
      }
      onDone()
    } catch {
      setError(t('tasks.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.taskForm}>
      <label className={css.formLabel}>
        {t('tasks.field.title')}
        <input
          type="text"
          className={css.formInput}
          value={title}
          placeholder={t('tasks.field.titlePlaceholder')}
          onChange={event => { setTitle(event.target.value) }}
        />
      </label>
      <label className={css.formLabel}>
        {t('tasks.field.prompt')}
        <textarea
          className={css.formTextarea}
          value={prompt}
          placeholder={t('tasks.field.promptPlaceholder')}
          rows={5}
          onChange={event => { setPrompt(event.target.value) }}
        />
      </label>
      <label className={css.formCheck}>
        <input
          type="checkbox"
          checked={scheduleEnabled}
          onChange={event => { setScheduleEnabled(event.target.checked) }}
        />
        <span>{t('tasks.schedule.enable')}</span>
      </label>
      {scheduleEnabled && (
        <>
          <label className={css.formLabel}>
            {t('tasks.schedule.cron')}
            <input
              type="text"
              className={css.formInput + (cronValid ? '' : ' ' + css.formInputInvalid)}
              value={cron}
              onChange={event => { setCron(event.target.value) }}
            />
          </label>
          {!cronValid && <p className={css.formError}>{t('tasks.schedule.cronInvalid')}</p>}
          <label className={css.formLabel}>
            {t('tasks.schedule.presets')}
            <select
              className={css.formSelect}
              value=""
              onChange={event => {
                if (event.target.value !== '') setCron(event.target.value)
              }}
            >
              <option value="">{t('tasks.schedule.presets')}…</option>
              <option value="0 9 * * *">{t('tasks.preset.daily9')}</option>
              <option value="0 * * * *">{t('tasks.preset.hourly')}</option>
              <option value="*/10 * * * *">{t('tasks.preset.tenMin')}</option>
              <option value="0 9 * * 1">{t('tasks.preset.weeklyMon9')}</option>
            </select>
          </label>
          <p className={css.formHint}>
            {t('tasks.schedule.nextRun')}
            {' '}
            {nextRun === undefined ? '—' : fmtTime(nextRun)}
          </p>
        </>
      )}
      <label className={css.formLabel}>
        {t('tasks.field.workspace')}
        <select className={css.formSelect} value={workspaceId} onChange={event => { setWorkspaceId(event.target.value) }}>
          <option value="">{t('tasks.workspace.default')}</option>
          {(meta?.workspaces ?? []).map(workspace => (
            <option key={workspace.id} value={workspace.id}>{workspace.name ?? workspace.id}</option>
          ))}
        </select>
      </label>
      <label className={css.formLabel}>
        {t('tasks.field.agentPreset')}
        <select className={css.formSelect} value={agentPreset} onChange={event => { setAgentPreset(event.target.value) }}>
          <option value="">{t('tasks.preset.default')}</option>
          {(meta?.agentPresets ?? []).map(preset => (
            <option key={preset.id} value={preset.id}>{preset.id}</option>
          ))}
        </select>
      </label>
      <label className={css.formLabel}>
        {t('tasks.field.permission')}
        <select className={css.formSelect} value={permission} onChange={event => { setPermission(event.target.value) }}>
          <option value="">{meta === null ? 'read-only' : meta.sessionDefaultPermission}</option>
          {TASK_PERMISSIONS.map(item => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      </label>
      {error !== undefined && <p className={css.formError}>{error}</p>}
      <div className={css.formActions}>
        <button type="button" className={css.primaryBtn} disabled={busy || !titleValid || !cronValid} onClick={() => { void save() }}>
          {t('tasks.action.save')}
        </button>
        <button type="button" className={css.miniBtn} disabled={busy} onClick={onCancel}>{t('tasks.action.cancel')}</button>
      </div>
    </div>
  )
}
