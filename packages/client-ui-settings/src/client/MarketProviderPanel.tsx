import { useId, useMemo, useRef, useState, useEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from './contract/slots.ts'
import type {
  CredentialField,
  NewsSourceMeta,
  TradingSettingsState,
} from './trading-settings-controller.ts'
import { NEWS_SOURCE_CATALOG, PROVIDER_CREDENTIAL_SPECS, PROVIDER_LABELS } from './trading-settings-controller.ts'
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
  /** issue #96: set this market's enabled news/announcement source ids. */
  setNewsSources: (market: string, ids: readonly string[]) => Promise<void>
  /** issue #96: clear this market's enabled sources back to kit defaults. */
  resetNewsSources: (market: string) => Promise<void>
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

const EMPTY_RECORD: Record<string, string> = {}

/** provider id → 词典键（PROVIDER_LABELS 的稳定投影）。 */
const PROVIDER_KEY_BY_ID = new Map(PROVIDER_LABELS.map((entry) => [entry.id, entry.label] as const))

/** 把 provider id 解析为本地化显示名（未知 slug 回落原 id）。 */
function providerLabelOf(t: PanelT, id: string | undefined): string {
  if (id === undefined) return t('default')
  const key = PROVIDER_KEY_BY_ID.get(id)
  return key !== undefined ? t(key) : id
}

function ProviderCredentialCard(props: {
  providerId: string
  spec: readonly CredentialField[]
  currentValues?: Record<string, string> | undefined
  writable: boolean
  onSave: (fields: Record<string, string>) => Promise<void>
  onDelete: () => Promise<void>
  t: (key: string, params?: Record<string, unknown>) => string
}) {
  const { spec, writable, onSave, onDelete, t } = props
  const currentValues = props.currentValues ?? EMPTY_RECORD
  const drawerId = useId()
  const [open, setOpen] = useState(false)
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...currentValues }))
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const lastSyncedRef = useRef<Record<string, string>>(currentValues)

  useEffect(() => {
    const prev = lastSyncedRef.current
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(currentValues)])
    let isDifferent = false
    for (const k of allKeys) {
      if ((prev[k] ?? '') !== (currentValues[k] ?? '')) {
        isDifferent = true
        break
      }
    }
    if (isDifferent) {
      lastSyncedRef.current = currentValues
      setFields({ ...currentValues })
    }
  }, [currentValues])

  const isConfigured = Object.values(currentValues).some((v) => Boolean(v && v.trim()))
  const isDirty = spec.some((s) => (fields[s.key] ?? '') !== (currentValues[s.key] ?? ''))

  const handleSave = async (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation()
    setSaving(true)
    setMsg(null)
    try {
      await onSave(fields)
      lastSyncedRef.current = { ...fields }
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
      lastSyncedRef.current = EMPTY_RECORD
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
          <span className={css.statusDot} aria-hidden="true" />
          <span>{isConfigured ? t('credential.configured') : t('credential.notConfigured')}</span>
        </span>
        <button
          type="button"
          className={css.credentialToggleBtn}
          aria-expanded={open}
          aria-controls={drawerId}
          onClick={() => {
            setOpen(!open)
            setMsg(null)
          }}
        >
          {open ? t('credential.btnFold') : t('credential.btn')}
        </button>
      </div>

      <div className={css.credentialDrawer} data-open={open ? 'true' : undefined}>
        <div id={drawerId} className={css.credentialDrawerInner}>
          <div className={css.credentialFields}>
            {spec.map((field) => {
              const isPass = field.secret && !showSecret[field.key]
              const inputId = `${drawerId}-${field.key}`
              return (
                <div key={field.key} className={css.fieldRow}>
                  <label className={css.fieldLabel} htmlFor={inputId}>{t(field.label)}</label>
                  <div className={css.inputWrapper}>
                    <input
                      id={inputId}
                      type={isPass ? 'password' : 'text'}
                      className={css.credInput}
                      value={fields[field.key] ?? ''}
                      placeholder={field.placeholder !== undefined ? t(field.placeholder) : undefined}
                      disabled={!writable || saving || !open}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setFields({ ...fields, [field.key]: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && isDirty && !saving && writable) {
                          e.preventDefault()
                          void handleSave(e)
                        }
                      }}
                    />
                    {field.secret && (
                      <button
                        type="button"
                        className={css.eyeBtn}
                        disabled={!open}
                        onClick={() => setShowSecret((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                        title={showSecret[field.key] ? t('field.action.hide') : t('field.action.show')}
                        aria-label={showSecret[field.key] ? t('field.action.hide') : t('field.action.show')}
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
              disabled={!isDirty || saving || !writable || !open}
              onClick={handleSave}
            >
              {t('credential.save')}
            </button>
            {isConfigured && (
              <button
                type="button"
                className={css.credDeleteBtn}
                disabled={saving || !writable || !open}
                onClick={handleDelete}
              >
                {t('credential.delete')}
              </button>
            )}
            {msg && <span className={css.credMsg} role="status">{msg}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

/** issue #96：单市场新闻/公告源多选（受控：勾选集与脏标记由面板统一持有）。 */
function NewsSourceGrid(props: {
  market: string
  catalog: readonly NewsSourceMeta[]
  selected: readonly string[]
  disabled: boolean
  onToggle: (id: string) => void
  t: (key: string, params?: Record<string, unknown>) => string
}) {
  const { market, catalog, selected, disabled, onToggle, t } = props
  if (catalog.length === 0) return null
  return (
    <div className={css.newsGrid}>
      {catalog.map((source) => (
        <label key={`${market}-${source.id}`} className={css.newsSourceItem}>
          <input
            type="checkbox"
            checked={selected.includes(source.id)}
            disabled={disabled}
            onChange={() => onToggle(source.id)}
          />
          <span>{t(source.label)}</span>
        </label>
      ))}
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
  setNewsSources,
  resetNewsSources,
}: MarketProviderPanelProps) {
  // 0.1.7：dshtrading.settings 并入 LocaleNamespaceMap 后 PropsLocale 的 t 座位
  // 收敛为 TranslateNS（只收本 namespace 的字面量键）。组件内部把动态词典键
  // 交给本地 PanelT 面（string 键）消费，边界处单点断言。
  const t = tProp as unknown as PanelT
  const state = useController((value: TradingSettingsState) => value)
  const writable = state.writable
  const resolved = state.resolved[market]
  const overridden = state.overridden[market]

  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  const providerSelected = draft ?? resolved
  const providerDirty = useMemo(() => {
    const chosen = draft ?? resolved
    if (chosen === undefined) return overridden
    return chosen !== resolved
  }, [draft, resolved, overridden])

  // WS2c：CryptoPanic key（全局字段，仅 crypto 市场展示）。
  const [newsDraft, setNewsDraft] = useState<string | undefined>(undefined)
  const newsValue = newsDraft ?? state.newsKey ?? ''
  const newsDirty = newsDraft !== undefined && newsDraft.trim() !== (state.newsKey ?? '')

  // issue #96：新闻/公告源勾选集（未改动 = 展示解析值；未配置 = 全部默认源）。
  const catalog = NEWS_SOURCE_CATALOG[market] ?? []
  const resolvedSources = state.newsSources[market]
  const sourcesCurrent = useMemo(
    () => resolvedSources ?? catalog.map((s) => s.id),
    [resolvedSources, catalog],
  )
  const [sourcesDraft, setSourcesDraft] = useState<readonly string[] | undefined>(undefined)
  const sourcesSelected = sourcesDraft ?? sourcesCurrent
  const sourcesDirty = useMemo(() => {
    if (sourcesDraft === undefined) return false
    const a = [...sourcesDraft].sort().join(',')
    const b = [...sourcesCurrent].sort().join(',')
    return a !== b
  }, [sourcesDraft, sourcesCurrent])

  const newsKeyDirty = market === 'crypto' && newsDirty
  const anyDirty = providerDirty || newsKeyDirty || sourcesDirty

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

  const toggleSource = (id: string): void => {
    const base = sourcesDraft ?? sourcesCurrent
    setSourcesDraft(base.includes(id) ? base.filter((x) => x !== id) : [...base, id])
  }

  async function saveAll(): Promise<void> {
    setSaving(true)
    setMessage(undefined)
    try {
      if (providerDirty) {
        const chosen = draft ?? resolved
        if (chosen === undefined) {
          if (overridden) await resetProvider(market)
        } else {
          await setProvider(market, chosen)
        }
      }
      if (newsKeyDirty) {
        const next = (newsDraft ?? '').trim()
        const current = state.newsKey ?? ''
        if (next !== current) await setNewsKey(next)
        else if (state.newsOverridden) await resetNewsKey()
      }
      if (sourcesDirty && sourcesDraft !== undefined) {
        await setNewsSources(market, sourcesDraft)
      }
      setMessage(t('saved'))
    } catch (error) {
      setMessage(`${t('saveFailed')}: ${String((error as { message?: string })?.message ?? error)}`)
    } finally {
      setSaving(false)
    }
  }

  function discardAll(): void {
    setDraft(undefined)
    setNewsDraft(undefined)
    setSourcesDraft(undefined)
    setMessage(undefined)
  }

  async function resetSourcesNow(): Promise<void> {
    setSaving(true)
    setMessage(undefined)
    try {
      await resetNewsSources(market)
      setSourcesDraft(undefined)
      setMessage(t('newsSaved'))
    } catch (error) {
      setMessage(`${t('newsSaveFailed')}: ${String((error as { message?: string })?.message ?? error)}`)
    } finally {
      setSaving(false)
    }
  }

  const newsKeyId = useId()

  return (
    <div className={css.panel}>
      <section className={css.subSection}>
        <div className={css.subHead}>
          <div className={css.subHeadText}>
            <h4 className={css.subTitle}>{t('providerSectionTitle')}</h4>
            <p className={css.subHint}>{t('providerSectionHint')}</p>
          </div>
          <div className={css.currentBox}>
            <span className={css.currentText}>{t('current', { provider: providerLabelOf(t, resolved) })}</span>
            {resolved !== undefined && !overridden ? <span className={css.defaultTag}>{t('default')}</span> : null}
          </div>
        </div>

        <div className={css.grid}>
          {options.map((provider) => {
            const selected = providerSelected === provider.id
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
                    aria-label={t(provider.label)}
                  />
                  <span className={css.cardTitle}>{t(provider.label)}</span>
                  {provider.type && (
                    <span className={css.typeBadge}>{t(TYPE_LABEL[provider.type] ?? provider.type)}</span>
                  )}
                </div>

                {(provider.url || provider.env) && (
                  <div className={css.cardMeta}>
                    {provider.url && (
                      <a
                        href={provider.url}
                        target="_blank"
                        rel="noreferrer"
                        className={css.link}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {t('provider.docsLink')} ↗
                      </a>
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
      </section>

      {(market === 'crypto' || catalog.length > 0) && (
        <section className={css.subSection}>
          <div className={css.subHead}>
            <div className={css.subHeadText}>
              <h4 className={css.subTitle}>{t('newsSourcesTitle')}</h4>
              <p className={css.subHint}>{t('newsSourcesHint')}</p>
            </div>
            {state.newsSourcesOverridden[market] === true && (
              <button
                type="button"
                className={css.btnLink}
                disabled={saving || !writable}
                onClick={() => { void resetSourcesNow() }}
              >
                {t('newsSourcesReset')}
              </button>
            )}
          </div>

          {market === 'crypto' && (
            <div className={css.fieldRow}>
              <label className={css.fieldLabel} htmlFor={newsKeyId}>{t('newsKeyTitle')}</label>
              <input
                id={newsKeyId}
                type="password"
                className={css.newsInput}
                value={newsValue}
                disabled={!writable || saving}
                onChange={(event) => setNewsDraft(event.target.value)}
                placeholder={t('newsKeyPlaceholder')}
                autoComplete="off"
                spellCheck={false}
              />
              <p className={css.subHint}>{t('newsKeyLabel')}</p>
            </div>
          )}

          <NewsSourceGrid
            market={market}
            catalog={catalog}
            selected={sourcesSelected}
            disabled={!writable || saving}
            onToggle={toggleSource}
            t={t}
          />
        </section>
      )}

      <div className={css.actionBar}>
        <span className={css.actionStatus} data-dirty={anyDirty ? 'true' : undefined} role="status">
          {anyDirty ? t('unsavedChanges') : (message ?? '')}
        </span>
        <div className={css.actionButtons}>
          <button
            type="button"
            className={css.btnGhost}
            disabled={!anyDirty || saving || !writable}
            onClick={discardAll}
          >
            {t('discard')}
          </button>
          <button
            type="button"
            className={css.btnPrimary}
            disabled={!anyDirty || saving || !writable}
            onClick={() => { void saveAll() }}
          >
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}
