/**
 * One market's provider-routing panel: the Trading section hosts one of these
 * per market tab. Edits the shared dshtrading scope through the injected
 * store/actions; staged draft writes on save, fenced by the revision the
 * form read. Never touched when a new market is added (contributors register
 * a new tab).
 */
import { useEffect, useMemo, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  TradingSettingsState,
} from './trading-settings-controller.ts'
import { PROVIDER_LABELS } from './trading-settings-controller.ts'
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
  /** WS2c: write/clear the CryptoPanic news API key (empty = clear → public sources). */
  setNewsKey: (value: string) => Promise<void>
  /** WS2c: clear the CryptoPanic news API key back to base (public sources). */
  resetNewsKey: () => Promise<void>
}

export type MarketProviderPanelProps =
  PropsRuntime<'dshtrading.market.tab'>
  & PropsLocale<'dshtrading.settings'>
  & InjectFace<MarketProviderPanelInjected>

const TYPE_LABEL: Record<string, string> = {
  public: '免密公共源',
  gateway: '本地网关',
  commercial: '商业 API',
}

/** Render one market's provider radio group with save/reset (+ WS2c news key, crypto only). */
export function MarketProviderPanel({ t, useController, market, setProvider, resetProvider, setNewsKey, resetNewsKey }: MarketProviderPanelProps) {
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
                <span className={css.cardTitle}>{provider.label}</span>
                {provider.type && (
                  <span className={css.typeBadge}>{TYPE_LABEL[provider.type] ?? provider.type}</span>
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
                        官方指引与文档 ↗
                      </a>
                    </div>
                  )}
                  {provider.env && (
                    <div className={css.envBox}>
                      环境变量：<code>{provider.env}</code>
                    </div>
                  )}
                </div>
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
