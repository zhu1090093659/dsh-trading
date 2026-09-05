/**
 * Software-update settings page (the first-level section registered by this
 * plugin). Pure view over /dshtrading/api/updater: renders the current
 * versions, the latest GitHub release with its notes, and drives the
 * incremental apply + restart flow. Polls the host snapshot while mounted
 * (faster while an apply is running); no SSE dependency.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdaterSnapshot } from '../updater-service.ts'
import { desktopBridge, fetchUpdaterState, requestUpdaterApply, requestUpdaterCheck } from './api.ts'
import { UPDATE_AVAILABLE_EVENT } from './contract.ts'
import css from './updater-section.module.css'

export type UpdaterSectionProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'dshtrading.updater'>

/** Poll cadences: lazy when idle, tight while an apply pipeline is running. */
const POLL_IDLE_MS = 30_000
const POLL_RUNNING_MS = 1_200

/** ISO date (yyyy-mm-dd) for the published line; empty when unknown. */
function formatDay(iso: string | undefined): string {
  if (iso === undefined) return ''
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toISOString().slice(0, 10)
}

export function UpdaterSection({ t }: UpdaterSectionProps) {
  const [state, setState] = useState<UpdaterSnapshot | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [checkBusy, setCheckBusy] = useState(false)
  const applyBusyRef = useRef(false)

  const running = state?.apply.phase === 'running'

  const refresh = useCallback(async () => {
    try {
      setState(await fetchUpdaterState())
    } catch {
      // Bridge absent (headless profile / old deployment): keep the page quiet.
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const interval = setInterval(() => { void refresh() }, running ? POLL_RUNNING_MS : POLL_IDLE_MS)
    return () => { clearInterval(interval) }
  }, [refresh, running])

  // Rail badge sync: mirror availability onto the window event the trading
  // shell rail listens to (see UPDATE_AVAILABLE_EVENT in contract.ts).
  useEffect(() => {
    if (state === undefined) return
    const available = state.check.available === true && state.apply.phase !== 'done'
    window.dispatchEvent(new CustomEvent(UPDATE_AVAILABLE_EVENT, {
      detail: { available, version: state.check.latest?.version },
    }))
  }, [state])

  const handleCheck = async (): Promise<void> => {
    setCheckBusy(true)
    setActionError(undefined)
    try {
      setState(await requestUpdaterCheck(true))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setCheckBusy(false)
    }
  }

  const handleApply = async (): Promise<void> => {
    if (applyBusyRef.current) return
    applyBusyRef.current = true
    setActionError(undefined)
    try {
      setState(await requestUpdaterApply())
      // Pipeline started: tighten polling immediately instead of waiting a tick.
      void refresh()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      applyBusyRef.current = false
    }
  }

  const handleRestart = (): void => {
    desktopBridge()?.relaunch?.()
  }

  const environment = state?.environment
  const check = state?.check
  const apply = state?.apply
  const progress = state?.progress
  const latest = check?.latest
  const releasesUrl = latest?.url ?? 'https://github.com/zhu1090093659/dsh-trading/releases'
  const publishedDay = formatDay(latest?.publishedAt)
  const hasUpdate = check?.available === true && apply?.phase !== 'done'
  const applyable = hasUpdate && latest?.payloadAvailable === true

  return (
    <div className={css.root}>
      <p className={css.lead}>{t('lead')}</p>

      <div className={css.versions}>
        <div className={css.versionItem}>
          <span className={css.versionLabel}>{t('currentVersion')}</span>
          <span className={css.versionValue}>{environment?.familyVersion ?? '—'}</span>
        </div>
        {environment?.appVersion !== undefined && (
          <div className={css.versionItem}>
            <span className={css.versionLabel}>{t('desktopApp')}</span>
            <span className={css.versionValue}>{environment.appVersion}</span>
          </div>
        )}
      </div>

      {environment !== undefined && !environment.supported && (
        <p className={css.statusText}>{t('unsupported')}</p>
      )}

      {environment?.supported === true && (
        <>
          <div className={css.statusRow}>
            {check?.status === 'error' && (
              <span className={`${css.statusText} ${css.statusTextError}`}>
                {t('checkError', { message: check.error ?? '' })}
              </span>
            )}
            {check?.status === 'ok' && !hasUpdate && apply?.phase !== 'done' && (
              <span className={`${css.statusText} ${css.statusTextOk}`}>{t('upToDate')}</span>
            )}
            {check?.at !== undefined && (
              <span className={css.statusText}>
                {t('lastCheck')}
                :
                {' '}
                {check.at.slice(0, 19).replace('T', ' ')}
              </span>
            )}
            {check?.at === undefined && check?.status !== 'ok' && (
              <span className={css.statusText}>{t('never')}</span>
            )}
            <button
              type="button"
              className={css.secondaryButton}
              disabled={checkBusy || running}
              onClick={() => { void handleCheck() }}
            >
              {checkBusy ? t('checking') : t('checkNow')}
            </button>
            {actionError !== undefined && (
              <button type="button" className={css.secondaryButton} onClick={() => { void handleCheck() }}>
                {t('retry')}
              </button>
            )}
          </div>

          {running && (
            <div className={css.progressWrap}>
              <span className={css.progressLabel}>
                <span>
                  {progress?.step === 'download'
                    ? t('phase.download')
                    : progress?.step === 'verify'
                      ? t('phase.verify')
                      : progress?.step === 'install'
                        ? t('phase.install')
                        : t('phase.prepare')}
                </span>
                {progress?.percent !== undefined && (
                  <span>{t('progress', { percent: progress.percent })}</span>
                )}
              </span>
              <div
                className={css.progressTrack}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress?.percent ?? undefined}
              >
                <div
                  className={`${css.progressFill} ${progress?.percent === undefined ? css.progressIndeterminate : ''}`}
                  style={progress?.percent === undefined ? undefined : { width: `${progress.percent}%` }}
                />
              </div>
            </div>
          )}

          {hasUpdate && latest !== undefined && !running && (
            <div className={css.availableCard}>
              <p className={css.availableTitle}>{t('available', { version: latest.version })}</p>
              {publishedDay !== '' && (
                <p className={css.availableMeta}>{t('publishedAt', { date: publishedDay })}</p>
              )}
              {latest.notes.trim() !== '' && (
                <>
                  <span className={css.notesTitle}>{t('notesTitle')}</span>
                  <pre className={css.notes}>{latest.notes}</pre>
                </>
              )}
              <div className={css.actions}>
                {latest.payloadAvailable && (
                  <button
                    type="button"
                    className={css.primaryButton}
                    onClick={() => { void handleApply() }}
                  >
                    {t('applyNow')}
                  </button>
                )}
                <a className={css.link} href={releasesUrl} target="_blank" rel="noreferrer">
                  {t('viewReleases')}
                </a>
              </div>
              {!latest.payloadAvailable && (
                <p className={css.doneMeta}>{t('payloadMissing')}</p>
              )}
            </div>
          )}

          {apply?.phase === 'done' && apply.targetVersion !== undefined && (
            <div className={css.doneCard}>
              <p className={css.doneTitle}>{t('done', { version: apply.targetVersion })}</p>
              <p className={css.doneMeta}>{t('restartHint')}</p>
              <div className={css.actions}>
                {desktopBridge()?.relaunch !== undefined && (
                  <button type="button" className={css.primaryButton} onClick={handleRestart}>
                    {t('restartNow')}
                  </button>
                )}
                {desktopBridge()?.relaunch === undefined && (
                  <span className={css.doneMeta}>{t('restartManual')}</span>
                )}
                <a className={css.link} href={releasesUrl} target="_blank" rel="noreferrer">
                  {t('viewReleases')}
                </a>
              </div>
            </div>
          )}

          {apply?.phase === 'error' && apply.error !== undefined && (
            <p className={css.errorText}>{apply.error}</p>
          )}
        </>
      )}

      {environment === undefined || !environment.supported ? (
        <a className={css.link} href={releasesUrl} target="_blank" rel="noreferrer">
          {t('viewReleases')}
        </a>
      ) : null}
    </div>
  )
}
