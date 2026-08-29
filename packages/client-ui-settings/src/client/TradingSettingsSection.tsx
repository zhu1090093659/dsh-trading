/**
 * Trading settings page: one 'settings.section' entry ('交易' 一级菜单) —
 * a card per market (crypto/us/cn/hk) with the provider selection that routes
 * the dsh-trading connector set. The state arrives as a SnapshotStore through
 * the hooks compartment (useController(selector)); writes go through the
 * plain inject fields (setProvider/resetProvider), revision-fenced by the
 * scope the Host settings service resolves.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  TradingSettingsState,
} from './trading-settings-controller.ts'
import {
  MARKET_LABELS, PROVIDER_LABELS,
} from './trading-settings-controller.ts'

/** Bound selector-hook type for the controller store (SnapshotStore). */
export type TradingSettingsStateStore = {
  getSnapshot: () => TradingSettingsState
  subscribe: (listener: () => void) => () => void
}

export interface TradingSettingsInjected {
  hooks: {
    /** Projects the dshtrading namespace view (SnapshotStore). */
    controller: TradingSettingsStateStore
  }
  /** Write path: store a market provider selection. */
  setProvider: (market: string, provider: string) => Promise<void>
  /** Write path: clear a market provider (re-inherit base/schema default). */
  resetProvider: (market: string) => Promise<void>
}

export type TradingSettingsProps =
  ComposedProps<'settings.section', 'trading', never, never, TradingSettingsInjected, never, 'dshtrading.settings'>

/**
 * Render the Trading section: one row per market, provider radio, save/reset.
 * A staged draft holds while the user picks; commit writes on save.
 */
export function TradingSettingsSection({ t, useController, setProvider, resetProvider }: TradingSettingsProps) {
  const state = useController((value: TradingSettingsState) => value)
  const [draft, setDraft] = useState<Record<string, string | undefined>>({})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  // 首帧 draft 初始化为当前已解析值（状态 ready 后；effect 而非 render 中 setState）。
  const ready = state.status === 'ready'
  const resolvedNow = useMemo(() => state.resolved, [state.resolved, state.status])
  useEffect(() => {
    if (ready && Object.keys(draft).length === 0) {
      setDraft({ ...resolvedNow })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, resolvedNow])

  const dirty = MARKET_LABELS.some((m) => {
    const current = state.resolved[m.id]
    const chosen = draft[m.id]
    const override = state.overridden[m.id]
    if (chosen === undefined) return override
    return chosen !== current
  })

  async function save() {
    setSaving(true)
    setMessage(undefined)
    try {
      for (const market of MARKET_LABELS) {
        const chosen = draft[market.id]
        const current = state.resolved[market.id]
        const override = state.overridden[market.id]
        if (chosen === undefined) {
          if (override) await resetProvider(market.id)
        } else if (chosen !== current || !override) {
          await setProvider(market.id, chosen)
        }
      }
      setMessage(t('saved'))
    } catch (error) {
      setMessage(`${t('saveFailed')}: ${String(error?.message ?? error)}`)
    } finally {
      setSaving(false)
    }
  }

  const writable = state.writable

  return (
    <div>
      <p style={{ marginBottom: 12 }}>{t('lead')}</p>
      {MARKET_LABELS.map((market) => {
        const chosen = draft[market.id] ?? state.resolved[market.id]
        const current = state.resolved[market.id]
        return (
          <fieldset key={market.id} style={{ padding: '12px 0', borderTop: '1px solid var(--dsw-alias-border-l2, #eee)' }}>
            <legend>{market.label}</legend>
            <p style={{ margin: '4px 0' }}>
              {t('current', { provider: current ?? t('default') })}
            </p>
            {PROVIDER_LABELS.map((provider) => (
              <label key={`${market.id}-${provider.id}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 14 }}>
                <input
                  type="radio"
                  name={`provider-${market.id}`}
                  checked={chosen === provider.id}
                  disabled={!writable || saving}
                  onChange={() => setDraft((prev) => ({ ...prev, [market.id]: provider.id }))}
                />
                <span>{provider.label}</span>
              </label>
            ))}
          </fieldset>
        )
      })}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button type="button" disabled={!dirty || saving || !writable} onClick={() => void save()}>
          {t('save')}
        </button>
        <button
          type="button"
          disabled={saving || !dirty}
          onClick={() => {
            setDraft({ ...state.resolved })
            setMessage(undefined)
          }}
        >
          {t('discard')}
        </button>
        {message !== undefined ? <span>{message}</span> : null}
      </div>
    </div>
  )
}

export type { TradingSettingsProps as TradingSettingsSectionProps }
