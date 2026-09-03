import { useEffect, useMemo, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from './contract/slots.ts'
import type {
  CredentialField,
  TradingSettingsState,
} from './trading-settings-controller.ts'
import { PROVIDER_CREDENTIAL_SPECS, PROVIDER_LABELS } from './trading-settings-controller.ts'
import type {} from './contract/locale-keys.ts'
import css from './market-provider-panel.module.css'

/** SnapshotStore 面（hooks 注入）。 */
export interface MarketPanelStateStore {
  getSnapshot: () => TradingSettingsState
  subscribe: (listener: () => void) => () => void
}

export interface MarketProviderPanelInjected {
  hooks: {
    /** Shared dshtrading view (all markets); the panel reads its own market only. */
    controller: MarketPanelStateStore
  }
  /** This panel's market id (crypto/us/cn/hk/...). */
  market: string
  /** Write path: store this market's provider selection. */
  setProvider: (market: string, provider: string) => Promise<void>
  /** Write path: clear this market's provider (re-inherit base default). */
  resetProvider: (market: string) => Promise<void>
  /** Write path: set credentials for a provider. */
  setCredential: (provider: string, fields: Record<string, string>) => Promise<void>
  /** Write path: delete/clear credentials for a provider. */
  deleteCredential: (provider: string) => Promise<void>
  /** WS2c: write/clear the CryptoPanic news API key (empty = clear → public sources). */
  setNewsKey: (value: string) => Promise<void>
  /** WS2c: clear the CryptoPanic news API key back to base (public sources). */
  resetNewsKey: () => Promise<void>
}

export type MarketProviderPanelProps =
  PropsRuntime<'dshtrading.market.tab'>
  & PropsLocale<'dshtrading.settings'>
  & InjectFace<MarketProviderPanelInjected>

/** PropsLocale 在无宿主 merge 的独立编译里不落 t 座位（既有债），本地兜底。 */
type PanelT = (key: string, params?: Record<string, unknown>) => string

const TYPE_LABEL: Record<string, string> = {
  public: 'type.public',
  gateway: 'type.gateway',
  commercial: 'type.commercial',
}

function ProviderCredentialCard(props: {
  providerId: string
  spec: readonly CredentialField[]
  currentValues?: Record<string, string>
  writable: boolean
  onSave: (fields: Record<string, string>) => Promise<void>
  onDelete: () => Promise<void>
  t: (key: string, params?: Record<string, unknown>) => string
}) {
  const { providerId, spec, currentValues = {}, writable, onSave, onDelete, t } = props
  const [open, setOpen] = useState(false)
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...currentValues }))
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    setFields({ ...currentValues })
  }, [currentValues])

  const isConfigured = Object.values(currentValues).some((v) => Boolean(v && v.trim()))
  const isDirty = spec.some((s) => (fields[s.key] ?? '') !== (currentValues[s.key] ?? ''))

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setSaving(true)
    setMsg(null)
    try {
      await onSave(fields)
      setMsg(t('credential.saved'))
    } catch (err) {
      setMsg(`${t('credential.saveFailed')}: ${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setSaving(true)
    setMsg(null)
    try {
      await onDelete()
      setFields({})
      setMsg(t('credential.deleted'))
    } catch (err) {
      setMsg(`${t('credential.deleteFailed')}: ${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={css.credentialBlock} onClick={(e) => e.stopPropagation()}>
      <div className={css.credentialHeader}>
        <span className={css.credentialStatus} data-configured={isConfigured ? 'true' : 'false'}>
          <span>{isConfigured ? '●' : '○'}</span>
          <span>{isConfigured ? t('credential.configured') : t('credential.notConfigured')}</span>
        </span>
        <button
          type="button"
          className={css.credentialToggleBtn}
          onClick={() => {
            setOpen(!open)
            setMsg(null)
          }}
        >
          {open ? t('credential.btnFold') : t('credential.btn')}
        </button>
      </div>

      {open && (
        <div className={css.credentialDrawer}>
          <div className={css.credentialFields}>
            {spec.map((field) => {
              const isPass = field.secret && !showSecret[field.key]
              return (
                <div key={field.key} className={css.fieldRow}>
                  <label className={css.fieldLabel}>{t(field.label)}</label>
                  <div className={css.inputWrapper}>
                    <input
                      type={isPass ? 'password' : 'text'}
                      className={css.credInput}
                      value={fields[field.key] ?? ''}
                      placeholder={field.placeholder !== undefined ? t(field.placeholder) : undefined}
                      disabled={!writable || saving}
                      onChange={(e) => setFields({ ...fields, [field.key]: e.target.value })}
                    />
                    {field.secret && (
                      <button
                        type="button"
                        className={css.eyeBtn}
                        onClick={() => setShowSecret((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                        title={showSecret[field.key] ? t('field.action.hide') : t('field.action.show')}
                      >
                        {showSecret[field.key] ? '🙈' : '👁️'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <div className={css.credActions}>
            <button
              type="button"
              className={css.credSaveBtn}
              disabled={!isDirty || saving || !writable}
              onClick={handleSave}
            >
              {t('credential.save')}
            </button>
            {isConfigured && (
              <button
                type="button"
                className={css.credDeleteBtn}
                disabled={saving || !writable}
                onClick={handleDelete}
              >
                {t('credential.delete')}
              </button>
            )}
            {msg && <span className={css.credMsg}>{msg}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

/** Render one market's provider radio group with save/reset (+ WS2c news key, crypto only). */
export function MarketProviderPanel({
  t: tProp,
  useController,
  market,
  setProvider,
  resetProvider,
  setCredential,
  deleteCredential,
  setNewsKey,
  resetNewsKey,
}: MarketProviderPanelProps) {
  // PropsLocale 的 t 座位在无宿主 merge 的独立编译下解析为 never（既有债 20 处
  // TS2349 的根因）。本地遮蔽：运行时框架注入 t，签名与 SDK Translate 对齐。
  const t = tProp as unknown as PanelT
  const state = useController((value: TradingSettingsState) => value)
  const resolved = state.resolved[market]
  const overridden = state.overridden[market]
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  // 首次进入或切换市场时，以当前市场的解析值初始化
  useEffect(() => {
    setDraft(resolved)
    setMessage(undefined)
  }, [market, resolved])

  const dirty = useMemo(() => {
    const chosen = draft ?? resolved
    if (chosen === undefined) return overridden
    return chosen !== resolved
  }, [draft, resolved, overridden])

  const writable = state.writable

  // WS2c：CryptoPanic key
  const [newsDraft, setNewsDraft] = useState<string | undefined>(undefined)
  const [newsSaving, setNewsSaving] = useState(false)
  const [newsMessage, setNewsMessage] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (newsDraft === undefined && state.status === 'ready') {
      setNewsDraft(state.newsKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.newsKey])

  async function saveNews() {
    setNewsSaving(true)
    setNewsMessage(undefined)
    try {
      const next = (newsDraft ?? '').trim()
      const current = state.newsKey ?? ''
      if (next !== current) {
        await setNewsKey(next)
      } else if (state.newsOverridden) {
        await resetNewsKey()
      }
      setNewsMessage(t('newsSaved'))
    } catch (error) {
      setNewsMessage(`${t('newsSaveFailed')}: ${String((error as { message?: string })?.message ?? error)}`)
    } finally {
      setNewsSaving(false)
    }
  }

  const newsDirty = (newsDraft === undefined ? state.newsKey ?? '' : newsDraft.trim()) !== (state.newsKey ?? '')

  const options = useMemo(() => {
    const matched = PROVIDER_LABELS.filter((p) => p.markets.includes(market))
    const known = new Set(matched.map((p) => p.id))
    const extras: { id: string; label: string; url?: string; env?: string; type?: string }[] = []
    for (const slug of [resolved, draft]) {
      if (slug !== undefined && !known.has(slug) && !extras.some((e) => e.id === slug)) {
        extras.push({ id: slug, label: t('custom', { provider: slug }) })
      }
    }
    return [...matched, ...extras]
  }, [market, resolved, draft, t])

  async function save() {
    setSaving(true)
    setMessage(undefined)
    try {
      const chosen = draft ?? resolved
      if (chosen === undefined) {
        if (overridden) await resetProvider(market)
      } else if (chosen !== resolved || !overridden) {
        await setProvider(market, chosen)
      }
      setMessage(t('saved'))
    } catch (error) {
      setMessage(`${t('saveFailed')}: ${String((error as { message?: string })?.message ?? error)}`)
    } finally {
      setSaving(false)
    }
  }

  const activeProvider = draft ?? resolved

  return (
    <div className={css.panel}>
      <div className={css.currentHeader}>
        <span>{t('current', { provider: '' })}</span>
        <span className={css.currentBadge}>{resolved ?? t('default')}</span>
      </div>

      <div className={css.grid}>
        {options.map((provider) => {
          const selected = (draft === undefined ? resolved === provider.id : draft === provider.id)
          const credSpec = PROVIDER_CREDENTIAL_SPECS[provider.id]
          const currentCreds = state.credentials?.[provider.id]
          return (
            <div
              key={`${market}-${provider.id}`}
              className={css.card}
              data-selected={selected ? 'true' : undefined}
              onClick={() => { if (writable && !saving) setDraft(provider.id) }}
            >
              <div className={css.cardHeader}>
                <input
                  type="radio"
                  name={`provider-${market}`}
                  checked={selected}
                  disabled={!writable || saving}
                  onChange={() => setDraft(provider.id)}
                />
                <span className={css.cardTitle}>{t(provider.label)}</span>
                {provider.type && (
                  <span className={css.typeBadge}>{t(TYPE_LABEL[provider.type] ?? provider.type)}</span>
                )}
              </div>

              {(provider.url || provider.env) && (
                <div className={css.cardMeta}>
                  {provider.url && (
                    <div>
                      <a
                        href={provider.url}
                        target="_blank"
                        rel="noreferrer"
                        className={css.link}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {t('provider.docsLink')} ↗
                      </a>
                    </div>
                  )}
                  {provider.env && (
                    <div className={css.envBox}>
                      {t('provider.envPrefix')}<code>{provider.env}</code>
                    </div>
                  )}
                </div>
              )}

              {credSpec && credSpec.length > 0 && (
                <ProviderCredentialCard
                  providerId={provider.id}
                  spec={credSpec}
                  currentValues={currentCreds}
                  writable={writable}
                  onSave={(fields) => setCredential(provider.id, fields)}
                  onDelete={() => deleteCredential(provider.id)}
                  t={t as (k: string) => string}
                />
              )}
            </div>
          )
        })}
      </div>

      <div className={css.actions}>
        <button
          type="button"
          className={css.saveBtn}
          disabled={!dirty || saving || !writable}
          onClick={() => void save()}
        >
          {t('save')}
        </button>
        <button
          type="button"
          className={css.discardBtn}
          disabled={saving || !dirty}
          onClick={() => { setDraft(undefined); setMessage(undefined) }}
        >
          {t('discard')}
        </button>
        {message !== undefined ? <span className={css.message}>{message}</span> : null}
      </div>

      {market === 'crypto' && (
        <div className={css.newsSection}>
          <label className={css.newsLabel}>{t('newsKeyLabel')}</label>
          <input
            type="password"
            className={css.newsInput}
            value={newsDraft ?? ''}
            disabled={!writable || newsSaving}
            onChange={(event) => setNewsDraft(event.target.value)}
            placeholder={t('newsKeyPlaceholder')}
          />
          <div className={css.actions}>
            <button
              type="button"
              className={css.saveBtn}
              disabled={!newsDirty || newsSaving || !writable}
              onClick={() => void saveNews()}
            >
              {t('save')}
            </button>
            <button
              type="button"
              className={css.discardBtn}
              disabled={newsSaving || !newsDirty}
              onClick={() => { setNewsDraft(undefined); setNewsMessage(undefined) }}
            >
              {t('discard')}
            </button>
            {newsMessage !== undefined ? <span className={css.message}>{newsMessage}</span> : null}
          </div>
        </div>
      )}
    </div>
  )
}
