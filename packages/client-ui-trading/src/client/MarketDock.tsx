/**
 * 左侧自选停靠面板（shell.overlay 条目）：固定停靠在视口左缘，承载 MarketSidebar。
 *
 * 富途式双栏折叠：支持展开（272px 完整面板）与折叠（44px 超窄图标竖条）。
 * 工具详情列打开时测量其矩形自动右移避让。
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MarketSidebar } from './MarketSidebar.tsx'
import type { FoldStore } from './fold-store.ts'
import { IconFoldPanel, IconQuotes, IconWatchlist } from './icons.tsx'
import type { Observable, SelectionState, Watchlists } from './store.ts'
import type { Instrument, MarketId } from './types.ts'
import css from './market-dock.module.css'

export interface MarketDockInjected {
  hooks: {
    selection: Observable<SelectionState>
    watchlists: Observable<Watchlists>
    marketFolded: FoldStore
  }
  addInstrument(market: MarketId, instrument: Instrument): void
  removeInstrument(market: MarketId, symbol: string): void
  selectInstrument(instrument: Instrument): void
  toggleFold(): void
}

export type MarketDockProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'dshtrading.market'>
  & InjectFace<MarketDockInjected>

export function MarketDock(props: MarketDockProps) {
  const { t, useMarketFolded, toggleFold } = props
  const folded = useMarketFolded(value => value)
  const [left, setLeft] = useState(0)

  useEffect(() => {
    document.body.dataset.dshtradingMarketFolded = folded ? 'on' : 'off'
    return () => { delete document.body.dataset.dshtradingMarketFolded }
  }, [folded])

  // 工具详情列（rtl 后落在左侧轨道，frame 第 3 个子元素）打开时避让。
  useEffect(() => {
    let raf = 0
    const measure = (): void => {
      const frame = document.querySelector('div:has(> [data-shell-overlay])')
      const details = frame?.children[2]
      if (details !== undefined && details !== null) {
        const rect = details.getBoundingClientRect()
        setLeft(Math.max(0, rect.right))
      } else {
        setLeft(0)
      }
    }
    measure()
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    })
    const frame = document.querySelector('div:has(> [data-shell-overlay])')
    if (frame !== null) {
      for (const child of Array.from(frame.children)) observer.observe(child)
      observer.observe(frame)
    }
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div
      className={css.dock}
      data-dshtrading-market-dock=""
      data-folded={folded ? 'true' : undefined}
      style={{ left }}
    >
      {folded ? (
        <div className={css.rail} role="toolbar" aria-orientation="vertical">
          <button
            type="button"
            className={css.railButton}
            aria-label={t('sidebar.expand')}
            title={t('sidebar.expand')}
            onClick={toggleFold}
          >
            <IconFoldPanel size={16} />
          </button>
          <button
            type="button"
            className={css.railButton}
            aria-label={t('tab.watch')}
            title={t('tab.watch')}
            data-active="true"
            onClick={toggleFold}
          >
            <IconWatchlist size={16} />
          </button>
          <div className={css.railDivider} aria-hidden="true" />
          <button
            type="button"
            className={css.railButton}
            aria-label={t('stage.quote')}
            title={t('stage.quote')}
            onClick={toggleFold}
          >
            <IconQuotes size={16} />
          </button>
        </div>
      ) : (
        <MarketSidebar
          {...(props as unknown as import('./MarketSidebar.tsx').MarketSidebarProps)}
          onFold={toggleFold}
        />
      )}
    </div>
  )
}
