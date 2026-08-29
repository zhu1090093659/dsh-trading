/**
 * Trading settings section (tab container): the '交易' 一级菜单 host. The
 * section chrome is a tab bar projected from the dshtrading.market.tab slot
 * ledger; each market contributes its own panel (id = market id) and the
 * section renders it through the child slot. New market = new tab registration,
 * no section changes (官方 settings.plugins.tab 模式).
 */
import { useEffect, useId, useRef, useState } from 'react'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'

/** One tab projected from a dshtrading.market.tab contribution. */
export interface TradingMarketTabEntry {
  id: string
  order: number
  label: string
}

/** Registration-side business face for the section. */
export interface TradingSettingsSectionInjected {
  hooks: {
    /** Ordered, locale-aware projection of the market tab ledger. */
    tabs: HostObservable<readonly TradingMarketTabEntry[]>
  }
}

/** Props the renderer binds for the section. */
export type TradingSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'dshtrading.settings'>
  & PropsRenderSlots<'dshtrading.market.tab'>
  & InjectFace<TradingSettingsSectionInjected>


/** Render the Trading page: market tab bar + active market provider panel. */
export function TradingSettingsSection({ t, renderSlot, useTabs }: TradingSettingsSectionProps) {
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const rows = useTabs(value => value)
  const [activeId, setActiveId] = useState<string>()
  const [visitedIds, setVisitedIds] = useState<ReadonlySet<string>>(() => new Set())
  const active = rows.find(row => row.id === activeId)?.id ?? rows[0]?.id

  // 首次选中即挂载，切换后保持挂载（draft 存活）。
  useEffect(() => {
    if (active === undefined) return
    setVisitedIds((previous) => {
      if (previous.has(active)) return previous
      return new Set([...previous, active])
    })
  }, [active])

  return (
    <div>
      <p style={{ marginBottom: 12 }}>{t('lead')}</p>
      {rows.length === 0 ? <p>{t('empty')}</p> : (
        <>
          <div role="tablist" aria-label={t('tabs')} style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l2, #eee)' }}>
            {rows.map((row, index) => {
              const selected = row.id === active
              return (
                <button
                  key={row.id}
                  ref={(element) => { tabRefs.current[index] = element }}
                  id={`${tabsId}-tab-${row.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`${tabsId}-panel-${row.id}`}
                  data-active={selected ? 'true' : undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => { setActiveId(row.id) }}
                  onKeyDown={(event) => {
                    let nextIndex: number
                    switch (event.key) {
                      case 'ArrowRight': nextIndex = (index + 1) % rows.length; break
                      case 'ArrowLeft': nextIndex = (index - 1 + rows.length) % rows.length; break
                      case 'Home': nextIndex = 0; break
                      case 'End': nextIndex = rows.length - 1; break
                      default: return
                    }
                    event.preventDefault()
                    const nextRow = rows[nextIndex] as TradingMarketTabEntry
                    const nextTab = tabRefs.current[nextIndex] as HTMLButtonElement
                    setActiveId(nextRow.id)
                    nextTab.focus()
                  }}
                >
                  {row.label}
                </button>
              )
            })}
          </div>
          {rows
            .filter(row => row.id === active || visitedIds.has(row.id))
            .map((row) => {
              const selected = row.id === active
              return (
                <div
                  key={row.id}
                  id={`${tabsId}-panel-${row.id}`}
                  role="tabpanel"
                  aria-labelledby={`${tabsId}-tab-${row.id}`}
                  hidden={!selected}
                >
                  {renderSlot('dshtrading.market.tab', {}, { only: row.id })}
                </div>
              )
            })}
        </>
      )}
    </div>
  )
}

export type { TradingSettingsSectionProps as TradingSettingsSectionPropsType }
