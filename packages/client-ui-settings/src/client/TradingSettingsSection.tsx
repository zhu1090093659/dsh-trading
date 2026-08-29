/**
 * Trading settings page: one 'settings.section' entry ('交易' 一级菜单) —
 * a card per market (crypto/us/cn/hk) with the provider selection that routes
 * the dsh-trading connector set. Reads/writes the dshtrading namespace
 * (owned by @dsh-trading/router on the Host) through its controller; staged
 * edits write on save only, fenced by the revision the form read.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ComposedProps, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { TradingSettingsController } from './trading-settings-controller.ts'
import {
  MARKET_LABELS, PROVIDER_LABELS, isOverridden, resolvedProvider,
} from './trading-settings-controller.ts'

export interface TradingSettingsInjected {
  hooks: {
    /** Controller snapshot observable (the section subscribes through it). */
    controller: HostObservable<TradingSettingsController>
  }
}

export type TradingSettingsProps =
  ComposedProps<'settings.section', 'trading', never, never, TradingSettingsInjected, never, 'dshtrading.settings'>

/**
 * Render the Trading section: one row per market, provider radio, save/reset.
 * A staged draft holds while the user picks; commit writes on save.
 */
export function TradingSettingsSection({ t, useController }: TradingSettingsProps) {
  const controller = useController()
  const [draft, setDraft] = useState<Record<string, string | undefined>>({})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)

  // On mount (and namespace settle), initialize the draft from the resolved value.
  useEffect(() => {
    const snap = controller.snapshot()
    if (snap.status === 'ready') {
      const next: Record<string, string | undefined> = {}
      for (const market of MARKET_LABELS) {
        const provider = resolvedProvider(snap, market.id)
        next[market.id] = provider ?? draftStore.current[market.id]
      }
      setDraft((prev) => ({ ...prev, ...next }))
    }
  }, [controller, controller.snapshot().status])

  const dirty = useMemo(() => {
    const snap = controller.snapshot()
    return MARKET_LABELS.some((m) => {
      const current = resolvedProvider(snap, m.id)
      const chosen = draft[m.id]
      const override = isOverridden(snap, m.id)
      if (chosen === undefined) return override
      return chosen !== current
    })
  }, [draft, controller.snapshot()])

  async function save() {
    setSaving(true)
    setMessage(undefined)
    try {
      for (const market of MARKET_LABELS) {
        const chosen = draft[market.id]
        const snap = controller.snapshot()
        const current = resolvedProvider(snap, market.id)
        const override = isOverridden(snap, market.id)
        if (chosen === undefined) {
          if (override) await controller.resetProvider(market.id)
        } else if (chosen !== current || !override) {
          await controller.setProvider(market.id, chosen)
        }
      }
      setMessage(t('saved'))
    } catch (error) {
      setMessage(`${t('saveFailed')}: ${String(error?.message ?? error)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dsh-trading-settings">
      <p className="dsh-trading-settings__lead">{t('lead')}</p>
      {MARKET_LABELS.map((market) => {
        const chosen = draft[market.id]
        const snap = controller.snapshot()
        const current = resolvedProvider(snap, market.id)
        return (
          <fieldset key={market.id} className="dsh-trading-settings__market">
            <legend>{market.label}</legend>
            <p className="dsh-trading-settings__hint">
              {t('current', { provider: current ?? t('default') })}
            </p>
            {PROVIDER_LABELS.map((provider) => (
              <label key={`${market.id}-${provider.id}`} className="dsh-trading-settings__choice">
                <input
                  type="radio"
                  name={`provider-${market.id}`}
                  checked={chosen === provider.id}
                  onChange={() => setDraft((prev) => ({ ...prev, [market.id]: provider.id }))}
                />
                <span>{provider.label}</span>
              </label>
            ))}
          </fieldset>
        )
      })}
      <div className="dsh-trading-settings__actions">
        <button type="button" disabled={!dirty || saving} onClick={() => void save()}>
          {t('save')}
        </button>
        <button
          type="button"
          disabled={saving || !dirty}
          onClick={() => {
            const snap = controller.snapshot()
            const next: Record<string, string | undefined> = {}
            for (const market of MARKET_LABELS) next[market.id] = resolvedProvider(snap, market.id)
            setDraft(next)
            setMessage(undefined)
          }}
        >
          {t('discard')}
        </button>
        {message !== undefined ? <span className="dsh-trading-settings__message">{message}</span> : null}
      </div>
    </div>
  )
}

/** Module-local draft mirror for the mount effect (avoids a render-time ref dance). */
const draftStore: { current: Record<string, string | undefined> } = { current: {} }

export type { TradingSettingsProps as TradingSettingsSectionProps }
