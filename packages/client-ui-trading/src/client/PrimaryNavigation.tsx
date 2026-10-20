import { useEffect, useState, useSyncExternalStore } from 'react'
import { stageViews, STAGE_VIEW_NAVIGATE_EVENT } from './stage-views.ts'
import type { MarketLocaleKey } from './contract.ts'
import css from './market-dock.module.css'

/** The optional market strip replaces this built-in first-level navigation. */
export function PrimaryNavigation({ t }: { t: (key: MarketLocaleKey) => string }) {
  useSyncExternalStore(stageViews.subscribe, stageViews.getVersion)
  const [external, setExternal] = useState(false)
  const [research, setResearch] = useState(false)
  useEffect(() => {
    const sync = (): void => {
      setExternal(document.querySelector('[data-dshtrading-multi-chart-nav]') !== null)
      setResearch(document.body.dataset.dshtradingStageView === 'research')
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-dshtrading-stage-view'] })
    return () => observer.disconnect()
  }, [])
  if (external || !stageViews.get('research')) return null
  const go = (view: string): void => { window.dispatchEvent(new CustomEvent(STAGE_VIEW_NAVIGATE_EVENT, { detail: { view } })) }
  return <nav className={css.primaryNav} aria-label={t('nav.primary')} data-dshtrading-primary-nav="">
    <button type="button" aria-current={!research ? 'page' : undefined} onClick={() => go('quote')}>{t('stage.quote')}</button>
    <button type="button" aria-current={research ? 'page' : undefined} onClick={() => go('research')}>{t('stage.research')}</button>
  </nav>
}
