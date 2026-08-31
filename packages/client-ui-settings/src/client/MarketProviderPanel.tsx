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
  TradingSettingsActions,
  TradingSettingsState,
} from './trading-settings-controller.ts'
import { PROVIDER_LABELS } from './trading-settings-controller.ts'

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

/** Render one market's provider radio group with save/reset (+ WS2c news key, crypto only). */
export function MarketProviderPanel({ t, useController, market, setProvider, resetProvider, setNewsKey, resetNewsKey }: MarketProviderPanelProps) {
  const state = useController((value: TradingSettingsState) => value)
  const resolved = state.resolved[market]
  const overridden = state.overridden[market]
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  // 首次进入（draft 未定）以当前解析值初始化——effect 而非 render setState。
  useEffect(() => {
    if (draft === undefined && state.status === 'ready') {
      setDraft(resolved)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, resolved])

  const dirty = useMemo(() => {
    const chosen = draft ?? resolved
    if (chosen === undefined) return overridden
    return chosen !== resolved
  }, [draft, resolved, overridden])

  const writable = state.writable

  // WS2c：CryptoPanic key（仅 crypto 市场展示）。qwerty draft 当前解析值初始化。
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
        await setNewsKey(next) // 空串 = 清除 → 公共源
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

  // 开放词汇（2026-08-30 整改 #4）：schema 不拒未知 slug——若存储值不在内置
  // 候选里（第三方连接器），追加一个「自定义」选项让用户看到并能改回已知项，
  // 而不是让当前值在 UI 上消失。
  const options = useMemo(() => {
    const known = new Set(PROVIDER_LABELS.map((p) => p.id))
    const extras: { id: string; label: string }[] = []
    for (const slug of [resolved, draft]) {
      if (slug !== undefined && !known.has(slug) && !extras.some((e) => e.id === slug)) {
        extras.push({ id: slug, label: t('custom', { provider: slug }) })
      }
    }
    return [...PROVIDER_LABELS, ...extras]
  }, [resolved, draft, t])

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
      setMessage(`${t('saveFailed')}: ${String(error?.message ?? error)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <p style={{ margin: '4px 0' }}>
        {t('current', { provider: resolved ?? t('default') })}
      </p>
      {options.map((provider) => (
        <label key={`${market}-${provider.id}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 14 }}>
          <input
            type="radio"
            name={`provider-${market}`}
            checked={draft === undefined ? resolved === provider.id : draft === provider.id}
            disabled={!writable || saving}
            onChange={() => setDraft(provider.id)}
          />
          <span>{provider.label}</span>
        </label>
      ))}
      {(() => {
        const activeId = draft ?? resolved
        const meta = PROVIDER_LABELS.find((p) => p.id === activeId)
        if (!meta) return null
        return (
          <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--dsw-alias-bg-hover, rgba(0,0,0,0.03))', borderRadius: 6, fontSize: '0.85em' }}>
            <div>
              {meta.url && (
                <span>
                  指引与文档: <a href={meta.url} target="_blank" rel="noreferrer" style={{ color: 'var(--dsw-alias-primary, #1890ff)', textDecoration: 'underline' }}>{meta.url}</a>
                </span>
              )}
            </div>
            {meta.env && (
              <div style={{ marginTop: 4, color: 'var(--dsw-alias-text-secondary, #666)' }}>
                环境变量 / 密钥配置: <code>{meta.env}</code> {meta.type === 'commercial' ? '(BYOK 自行填入)' : meta.type === 'gateway' ? '(本地网关地址/账号)' : ''}
              </div>
            )}
          </div>
        )
      })()}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button type="button" disabled={!dirty || saving || !writable} onClick={() => void save()}>
          {t('save')}
        </button>
        <button
          type="button"
          disabled={saving || !dirty}
          onClick={() => { setDraft(undefined); setMessage(undefined) }}
        >
          {t('discard')}
        </button>
        {message !== undefined ? <span>{message}</span> : null}
      </div>
      {market === 'crypto' && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--dsw-alias-border-l2, #eee)', paddingTop: 12 }}>
          <p style={{ margin: '4px 0' }}>{t('newsKeyLabel')}</p>
          <input
            type="password"
            value={newsDraft ?? ''}
            disabled={!writable || newsSaving}
            onChange={(event) => setNewsDraft(event.target.value)}
            placeholder={t('newsKeyPlaceholder')}
            style={{ width: '100%', maxWidth: 360 }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button type="button" disabled={!newsDirty || newsSaving || !writable} onClick={() => void saveNews()}>
              {t('save')}
            </button>
            <button
              type="button"
              disabled={newsSaving || !newsDirty}
              onClick={() => { setNewsDraft(undefined); setNewsMessage(undefined) }}
            >
              {t('discard')}
            </button>
            {newsMessage !== undefined ? <span>{newsMessage}</span> : null}
          </div>
        </div>
      )}
    </div>
  )
}
