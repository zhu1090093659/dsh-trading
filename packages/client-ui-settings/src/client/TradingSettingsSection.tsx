/**
 * Trading settings section (tab container): the '交易' 一级菜单 host. The
 * section chrome is a tab bar projected from the dshtrading.market.tab slot
 * ledger; each market contributes its own panel (id = market id) and the
 * section renders it through the child slot. New market = new tab registration,
 * no section changes (官方 settings.plugins.tab 模式).
 */
import { useEffect, useId, useRef, useState } from 'react'
import type {} from './contract/locale-keys.ts'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { TradingSettingsState } from './trading-settings-controller.ts'
import css from './trading-settings.module.css'

/** One tab projected from a dshtrading.market.tab contribution. */
export interface TradingMarketTabEntry {
  id: string
  order: number
  label: string
}

/** SnapshotStore face for subscribing to controller state. */
interface ControllerStore {
  getSnapshot: () => TradingSettingsState
  subscribe: (listener: () => void) => () => void
}

/** Registration-side business face for the section. */
export interface TradingSettingsSectionInjected {
  hooks: {
    /** Ordered, locale-aware projection of the market tab ledger. */
    tabs: HostObservable<readonly TradingMarketTabEntry[]>
    /** Shared dshtrading controller (for colorMode state). */
    controller: ControllerStore
  }
  /** Write action: set global color mode. */
  setColorMode: (mode: 'red-up' | 'green-up') => Promise<void>
}

/** Props the renderer binds for the section. */
export type TradingSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'dshtrading.settings'>
  & PropsRenderSlots<'dshtrading.market.tab'>
  & InjectFace<TradingSettingsSectionInjected>

/** Render the Trading page: color mode selector + market tab bar + active market provider panel. */
export function TradingSettingsSection({ t, renderSlot, useTabs, useController, setColorMode }: TradingSettingsSectionProps) {
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const rows = useTabs(value => value)
  const controllerState = useController((value: TradingSettingsState) => value)
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

  const currentColorMode = controllerState.colorMode ?? 'red-up'

  return (
    <div className={css.root}>
      <p className={css.lead}>{t('lead')}</p>

      {/* 涨跌配色选择 */}
      <fieldset className={css.colorModeFieldset}>
        <legend className={css.colorModeLabel}>{t('colorMode.label')}</legend>
        <div className={css.colorModeOptions}>
          <label className={css.colorModeOption} data-active={currentColorMode === 'red-up' ? 'true' : undefined}>
            <input
              type="radio"
              name="dshtrading-color-mode"
              value="red-up"
              checked={currentColorMode === 'red-up'}
              onChange={() => { void setColorMode('red-up') }}
              className={css.colorModeRadio}
            />
            <span className={css.colorModeSwatch} style={{ background: '#e64545' }} />
            <span className={css.colorModeSwatchDown} style={{ background: '#2ba471' }} />
            <span>{t('colorMode.redUp')}</span>
          </label>
          <label className={css.colorModeOption} data-active={currentColorMode === 'green-up' ? 'true' : undefined}>
            <input
              type="radio"
              name="dshtrading-color-mode"
              value="green-up"
              checked={currentColorMode === 'green-up'}
              onChange={() => { void setColorMode('green-up') }}
              className={css.colorModeRadio}
            />
            <span className={css.colorModeSwatch} style={{ background: '#2ba471' }} />
            <span className={css.colorModeSwatchDown} style={{ background: '#e64545' }} />
            <span>{t('colorMode.greenUp')}</span>
          </label>
        </div>
      </fieldset>

      {rows.length === 0 ? <p className={css.empty}>{t('empty')}</p> : (
        <>
          <div className={css.tabList} role="tablist" aria-label={t('tabs')}>
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
                  className={css.tab}
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
                  className={css.tabPanel}
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
